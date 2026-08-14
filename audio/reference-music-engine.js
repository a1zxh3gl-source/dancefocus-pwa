/* 参考音乐对齐与替换引擎：FFmpeg 统一音频格式，Worker 做内容匹配，Web Audio 做实时预览。 */
(function initReferenceMusicEngine(global) {
  "use strict";

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const sleep = (ms) => new Promise((resolve) => global.setTimeout(resolve, ms));

  function extensionFor(file, fallback) {
    const match = String(file?.name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/);
    return match ? match[1] : fallback;
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function canonicalizePcm(samples) {
    const output = new Float32Array(samples?.length || 0);
    for (let index = 0; index < output.length; index += 1) {
      const value = clamp(safeNumber(samples[index]), -1, 1);
      // 匹配特征统一建立在 16-bit PCM 上。这样即使手机和电脑内部的
      // 浮点实现略有差别，也不会因极小的解码尾数差异选到不同候选位置。
      const integer = value <= -1 ? -32768 : value >= 1 ? 32767 : Math.round(value * 32767);
      output[index] = integer / 32768;
    }
    return output;
  }

  function pcmSignature(samples) {
    // 仅用于诊断两台设备是否实际分析了同一份标准化音频，不参与匹配结果。
    let hash = 2166136261;
    const stride = Math.max(1, Math.floor((samples?.length || 0) / 120000));
    for (let index = 0; index < (samples?.length || 0); index += stride) {
      const integer = Math.round(clamp(safeNumber(samples[index]), -1, 1) * 32768);
      hash ^= integer & 0xffff;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function canonicalPcmResult(wav, backend) {
    const mono = canonicalizePcm(wav.mono);
    return {
      ...wav,
      channels: [mono],
      mono,
      backend,
      pcm_signature: pcmSignature(mono),
    };
  }

  function parseWav(bytes) {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const view = new DataView(buffer);
    const text = (offset, length) => String.fromCharCode(...new Uint8Array(buffer, offset, length));
    if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") throw new Error("FFmpeg 输出了无效 WAV");
    let cursor = 12;
    let format = null;
    let dataOffset = -1;
    let dataLength = 0;
    while (cursor + 8 <= view.byteLength) {
      const id = text(cursor, 4);
      const length = view.getUint32(cursor + 4, true);
      const payload = cursor + 8;
      if (id === "fmt ") {
        const rawCode = view.getUint16(payload, true);
        // WAVE_FORMAT_EXTENSIBLE(0xfffe) 会把真正的 PCM/Float 类型放在
        // SubFormat GUID 的前两字节。如果把 32-bit float 当成 int32 读，
        // 就会出现整段“磁磁啦啦”的失真。
        const code = rawCode === 0xfffe && length >= 40
          ? view.getUint16(payload + 24, true)
          : rawCode;
        format = {
          code,
          rawCode,
          channels: view.getUint16(payload + 2, true),
          sampleRate: view.getUint32(payload + 4, true),
          bits: view.getUint16(payload + 14, true),
        };
      } else if (id === "data") {
        dataOffset = payload;
        dataLength = Math.min(length, view.byteLength - payload);
        break;
      }
      cursor = payload + length + (length % 2);
    }
    if (!format || dataOffset < 0) throw new Error("WAV 缺少音频数据");
    const bytesPerSample = format.bits / 8;
    const frameCount = Math.floor(dataLength / Math.max(1, bytesPerSample * format.channels));
    const channels = Array.from({ length: format.channels }, () => new Float32Array(frameCount));
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < format.channels; channel += 1) {
        const offset = dataOffset + (frame * format.channels + channel) * bytesPerSample;
        let value = 0;
        if (format.code === 3 && format.bits === 32) value = view.getFloat32(offset, true);
        else if (format.bits === 16) value = view.getInt16(offset, true) / 32768;
        else if (format.bits === 24) {
          let integer = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
          if (integer & 0x800000) integer |= 0xff000000;
          value = integer / 8388608;
        } else if (format.bits === 32) value = view.getInt32(offset, true) / 2147483648;
        else if (format.bits === 8) value = (view.getUint8(offset) - 128) / 128;
        // 个别手机解码器会在损坏包或非标准 WAV 块附近产生 NaN/Infinity。
        // Web Audio 遇到非有限样本时可能输出刺耳爆音，因此写入前必须清洗。
        channels[channel][frame] = Number.isFinite(value) ? clamp(value, -1, 1) : 0;
      }
    }
    const mono = channels.length === 1 ? channels[0] : new Float32Array(frameCount);
    if (channels.length > 1) {
      for (let frame = 0; frame < frameCount; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels.length; channel += 1) sum += channels[channel][frame];
        mono[frame] = sum / channels.length;
      }
    }
    return { sampleRate: format.sampleRate, channels, mono, duration: frameCount / format.sampleRate };
  }

  class ReferenceMusicEngine {
    constructor(options = {}) {
      // FFmpeg 内部还会再启动一层 Worker。如果传相对路径，手机会从
      // /vendor/ffmpeg/ Worker 目录再拼一次 vendor/ffmpeg，导致核心文件 404。
      const pageBase = global.document?.baseURI || global.location?.href || "./";
      const absolute = (value) => new URL(value, pageBase).href;
      this.coreURL = absolute(options.coreURL || "./vendor/ffmpeg/ffmpeg-core.js");
      this.wasmURL = absolute(options.wasmURL || "./vendor/ffmpeg/ffmpeg-core.wasm");
      this.classWorkerURL = absolute(options.classWorkerURL || "./vendor/ffmpeg/814.ffmpeg.js");
      this.workerURL = absolute(options.workerURL || "./workers/audio-analysis.worker.js");
      this.sampleRate = options.sampleRate || 22050;
      this.onProgress = options.onProgress || (() => {});
      this.ffmpeg = null;
      this.ffmpegPromise = null;
      this.ffmpegTaskProgress = null;
      this.referenceFile = null;
      this.referenceInputName = "";
      this.result = null;
      this.confirmed = false;
      this.mode = "replace";
      this.originalVolume = 0;
      this.musicVolume = 1;
      this.alignedPreviewBuffer = null;
      this.audioContext = null;
      this.previewSource = null;
      this.previewGain = null;
      this.previewStartedAt = 0;
      this.previewVideoTime = 0;
      this.previewMusicTime = 0;
      this.previewPlaybackRate = 1;
      this.previewUsesRawReference = false;
      this.previewBoundaryTimer = null;
      this.previewLastSyncAt = 0;
      this.previewRequestId = 0;
      this.previewResyncThreshold = clamp(safeNumber(options.previewResyncThreshold, .35), .18, 1);
      this.previewResyncCooldownMs = Math.max(300, safeNumber(options.previewResyncCooldownMs, 900));
      this.referenceDecodedBuffer = null;
      this.referencePreviewPcm = null;
      this.referencePreviewSampleRate = this.sampleRate;
      this.previewQuality = "analysis";
      this.processing = false;
    }

    ensureAudioContext() {
      const AudioContextClass = global.AudioContext || global.webkitAudioContext;
      if (!AudioContextClass) throw new Error("当前浏览器无法解码音轨");
      if (!this.audioContext) this.audioContext = new AudioContextClass();
      return this.audioContext;
    }

    audioBufferFromWav(wav) {
      const context = this.ensureAudioContext();
      const channels = wav.channels?.length ? wav.channels : [wav.mono];
      const length = channels[0]?.length || 0;
      if (!length) throw new Error("预览音轨中没有有效音频");
      const buffer = context.createBuffer(channels.length, length, wav.sampleRate);
      channels.forEach((samples, index) => {
        if (typeof buffer.copyToChannel === "function") buffer.copyToChannel(samples, index);
        else buffer.getChannelData(index).set(samples);
      });
      return buffer;
    }

    emit(stage, progress, message) {
      this.onProgress({ stage, progress: clamp(safeNumber(progress), 0, 1), message });
    }

    async loadFFmpeg() {
      if (this.ffmpeg) return this.ffmpeg;
      if (this.ffmpegPromise) return this.ffmpegPromise;
      this.ffmpegPromise = (async () => {
        if (!global.FFmpegWASM?.FFmpeg) throw new Error("FFmpeg 引擎未加载");
        this.emit("ffmpeg", .03, "正在启动本地音频引擎…");
        const instance = new global.FFmpegWASM.FFmpeg();
        instance.on("progress", ({ progress }) => {
          const normalized = clamp(progress || 0, 0, 1);
          if (this.ffmpegTaskProgress) {
            this.ffmpegTaskProgress(normalized);
            return;
          }
          // 只有自动对齐期间才更新配音面板。后续预览缓存或最终导出
          // 有各自的状态 UI，不能把已完成状态重新改回 20%。
          if (this.processing) this.emit("ffmpeg", .04 + normalized * .16, "FFmpeg 正在本地处理音频…");
        });
        instance.on("log", ({ message }) => {
          if (/error|invalid|failed/i.test(message || "")) console.warn("FFmpeg:", message);
        });
        // 当前发布包使用 @ffmpeg/ffmpeg 的 UMD 版本。不要把 UMD 的
        // 814.ffmpeg.js 显式作为 classWorkerURL 传入：这会让包装器把它
        // 创建成 module worker，而 iOS Safari 的 module worker 中没有
        // importScripts，最终导致 FFmpeg 失败。Chrome 能用 Web Audio
        // 直接解码 MP4，所以以前电脑上会被降级逻辑掩盖。
        // 省略 classWorkerURL 后，UMD 包会按 ffmpeg.js 所在目录
        // 自动创建正确的 classic worker，GitHub Pages 子路径也能正确解析。
        await instance.load({
          coreURL: this.coreURL,
          wasmURL: this.wasmURL,
        });
        this.ffmpeg = instance;
        return instance;
      })();
      try {
        return await this.ffmpegPromise;
      } catch (error) {
        this.ffmpegPromise = null;
        throw error;
      }
    }

    async removeFile(name) {
      if (!name || !this.ffmpeg) return;
      try { await this.ffmpeg.deleteFile(name); } catch (_) { /* 文件可能已清理 */ }
    }

    async writeReferenceFile(file) {
      const ffmpeg = await this.loadFFmpeg();
      const nextName = `reference.${extensionFor(file, "mp3")}`;
      if (this.referenceInputName && this.referenceInputName !== nextName) await this.removeFile(this.referenceInputName);
      await this.removeFile(nextName);
      await ffmpeg.writeFile(nextName, new Uint8Array(await file.arrayBuffer()));
      this.referenceInputName = nextName;
      this.referenceFile = file;
      return nextName;
    }

    async extractNormalizedPcm(file, kind, trimStart = 0, duration = null) {
      const ffmpeg = await this.loadFFmpeg();
      const inputName = `${kind}-input.${extensionFor(file, kind === "classroom" ? "mp4" : "mp3")}`;
      const outputName = `${kind}-normalized.wav`;
      await this.removeFile(inputName);
      await this.removeFile(outputName);
      this.emit(kind, kind === "classroom" ? .2 : .34, kind === "classroom" ? "正在提取课堂录音…" : "正在标准化干净音乐…");
      await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
      const args = ["-hide_banner", "-loglevel", "error"];
      if (kind === "classroom" && trimStart > 0) args.push("-ss", trimStart.toFixed(3));
      args.push("-i", inputName);
      if (kind === "classroom" && duration != null) args.push("-t", Math.max(.1, duration).toFixed(3));
      // 所有设备都让同一套 FFmpeg WASM 输出单声道 16-bit PCM，禁止电脑与
      // 手机分别使用不同浮点解码路径后再直接比较特征。
      args.push("-vn", "-map", "0:a:0", "-ac", "1", "-ar", String(this.sampleRate), "-c:a", "pcm_s16le", outputName);
      const exitCode = await ffmpeg.exec(args);
      if (exitCode !== 0) {
        await this.removeFile(inputName);
        throw new Error(kind === "classroom" ? "课堂视频没有可读取的音轨" : "无法读取这个音频文件");
      }
      const wav = parseWav(await ffmpeg.readFile(outputName));
      await this.removeFile(inputName);
      await this.removeFile(outputName);
      return canonicalPcmResult(wav, "ffmpeg-s16");
    }

    async decodeNormalizedPcm(file, kind, trimStart = 0, duration = null) {
      this.ensureAudioContext();
      this.emit(kind, kind === "classroom" ? .2 : .34, kind === "classroom" ? "正在用手机解码课堂录音…" : "正在用手机解码干净音乐…");
      const decoded = await this.audioContext.decodeAudioData((await file.arrayBuffer()).slice(0));
      if (kind === "reference") this.referenceDecodedBuffer = decoded;
      const start = kind === "classroom" ? Math.max(0, trimStart) : 0;
      const available = Math.max(0, decoded.duration - start);
      const outputDuration = duration == null ? available : Math.min(available, Math.max(.1, duration));
      if (outputDuration <= 0) throw new Error(kind === "classroom" ? "课堂视频没有可读取的音轨" : "音乐文件中没有有效音频");
      const length = Math.max(1, Math.round(outputDuration * this.sampleRate));
      const mono = new Float32Array(length);
      const sourceRate = decoded.sampleRate;
      for (let index = 0; index < length; index += 1) {
        const sourcePosition = (start + index / this.sampleRate) * sourceRate;
        const left = Math.min(decoded.length - 1, Math.max(0, Math.floor(sourcePosition)));
        const right = Math.min(decoded.length - 1, left + 1);
        const mix = sourcePosition - left;
        let value = 0;
        for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
          const samples = decoded.getChannelData(channel);
          value += samples[left] + (samples[right] - samples[left]) * mix;
        }
        mono[index] = value / Math.max(1, decoded.numberOfChannels);
      }
      return canonicalPcmResult({ sampleRate: this.sampleRate, channels: [mono], mono, duration: outputDuration }, "web-audio-fallback");
    }

    async prepareHighQualityReferencePreview() {
      if (this.referenceDecodedBuffer) {
        this.alignedPreviewBuffer = this.referenceDecodedBuffer;
        this.previewUsesRawReference = true;
        this.previewQuality = this.referenceDecodedBuffer.sampleRate >= 32000 ? "source" : "analysis";
        return this.alignedPreviewBuffer;
      }
      this.ensureAudioContext();
      // 预览音质不能使用用于特征匹配的 22.05kHz 单声道 PCM。
      // 先让 Safari 以源采样率/源声道直接解码，避免高频丢失和立体声变单声道。
      if (this.referenceFile) {
        try {
          const decoded = await this.audioContext.decodeAudioData((await this.referenceFile.arrayBuffer()).slice(0));
          if (decoded?.length && decoded.duration > 0) {
            this.referenceDecodedBuffer = decoded;
            this.alignedPreviewBuffer = decoded;
            this.previewUsesRawReference = true;
            this.previewQuality = "source";
            return decoded;
          }
        } catch (error) {
          console.warn("Safari 无法直接解码参考视频，将使用 FFmpeg 高保真预览", error);
        }
      }
      // 最后才使用分析 PCM 兼容预览；它只是降级路径，不再作为手机默认音质。
      if (this.referencePreviewPcm?.length) {
        const decoded = this.audioContext.createBuffer(1, this.referencePreviewPcm.length, this.referencePreviewSampleRate || this.sampleRate);
        if (typeof decoded.copyToChannel === "function") decoded.copyToChannel(this.referencePreviewPcm, 0);
        else decoded.getChannelData(0).set(this.referencePreviewPcm);
        this.referenceDecodedBuffer = decoded;
        this.alignedPreviewBuffer = decoded;
        this.previewUsesRawReference = true;
        this.previewQuality = "analysis";
        return decoded;
      }
      throw new Error("参考音乐预览准备失败");
    }

    async extractWithFallback(file, kind, trimStart = 0, duration = null) {
      try {
        return await this.extractNormalizedPcm(file, kind, trimStart, duration);
      } catch (ffmpegError) {
        console.warn(`FFmpeg ${kind} 提取失败，改用浏览器音频解码`, ffmpegError);
        this.emit(kind, kind === "classroom" ? .2 : .34, "FFmpeg 未能读取，正在尝试手机兼容解码…");
        try {
          return await this.decodeNormalizedPcm(file, kind, trimStart, duration);
        } catch (decodeError) {
          const message = kind === "classroom"
            ? "课堂视频音轨无法读取，请将视频另存为兼容 MP4 后重试"
            : "这个视频中没有可提取的音轨，请换一个视频";
          const error = new Error(message);
          error.cause = decodeError || ffmpegError;
          throw error;
        }
      }
    }

    async alignInWorker(classroom, reference, options = {}) {
      try {
        return await new Promise((resolve, reject) => {
        const worker = new Worker(this.workerURL);
        const finish = () => worker.terminate();
        worker.onerror = (event) => {
          finish();
          reject(new Error(event.message || "音频对齐 Worker 失败"));
        };
        worker.onmessage = ({ data }) => {
          finish();
          if (data.type === "error") reject(new Error(data.message || "音频对齐失败"));
          else resolve(data.result);
        };
        const classroomCopy = classroom.slice();
        const referenceCopy = reference.slice();
        worker.postMessage({
          type: "align",
          classroom: classroomCopy.buffer,
          reference: referenceCopy.buffer,
          sampleRate: this.sampleRate,
          options,
        }, [classroomCopy.buffer, referenceCopy.buffer]);
        });
      } catch (workerError) {
        // 部分 iOS WebView 会因内存压力中止 Worker。数据还在主线程中，
        // 可直接降级为分批计算，不让用户重新导入两个大文件。
        console.warn("音频分析 Worker 不可用，改用主线程分析", workerError);
        if (!global.AudioAlignmentCore?.alignAudio) throw workerError;
        this.emit("analysis", .56, "手机已切换兼容分析，请稍候…");
        await sleep(30);
        return global.AudioAlignmentCore.alignAudio(classroom, reference, this.sampleRate, options);
      }
    }

    async analyze(videoFile, referenceFile, options = {}) {
      if (this.processing) throw new Error("已在分析音乐");
      this.processing = true;
      if (this.referenceInputName) await this.removeFile(this.referenceInputName);
      this.referenceInputName = "";
      this.referenceFile = null;
      this.referenceDecodedBuffer = null;
      this.referencePreviewPcm = null;
      this.referencePreviewSampleRate = this.sampleRate;
      this.previewQuality = "analysis";
      this.confirmed = false;
      this.result = null;
      this.alignedPreviewBuffer = null;
      this.stopPreview();
      const trimStart = Math.max(0, safeNumber(options.trimStart));
      const duration = Math.max(.1, safeNumber(options.duration, 30));
      try {
        this.emit("start", .01, "准备音频内容匹配…");
        const classroom = await this.extractWithFallback(videoFile, "classroom", trimStart, duration);
        const reference = await this.extractWithFallback(referenceFile, "reference", 0, null);
        this.referenceFile = referenceFile;
        // 保留 FFmpeg 已解码的完整提取音轨。手机不能直接用 Web Audio 解码 MP4 时，
        // 仍可用这份 PCM 实时试听拖动后的位置。
        this.referencePreviewPcm = reference.mono;
        this.referencePreviewSampleRate = reference.sampleRate || this.sampleRate;
        // FFmpeg 已加载时预写入参考音频；如果手机上只有 Web Audio 兼容解码，
        // 不在此处再强制启动 FFmpeg，避免已算出的匹配结果被覆盖为失败。
        if (this.ffmpeg) await this.writeReferenceFile(referenceFile);
        this.emit("analysis", .52, "正在比对旋律、和弦、节拍与指纹…");
        const result = await this.alignInWorker(classroom.mono, reference.mono, {
          frameSize: 2048,
          hopSize: 1024,
          speeds: [.98, .9875, .995, 1, 1.005, 1.0125, 1.02],
        });
        result.reference_audio_path = referenceFile.name || "reference-audio";
        result.reference_duration_ms = Math.round(reference.duration * 1000);
        result.video_duration_ms = Math.round(duration * 1000);
        result.original_volume = this.originalVolume;
        result.music_volume = this.musicVolume;
        result.mode = this.mode;
        result.trim_start_ms = Math.round(trimStart * 1000);
        result.classroom_extraction_backend = classroom.backend;
        result.reference_extraction_backend = reference.backend;
        result.classroom_pcm_signature = classroom.pcm_signature;
        result.reference_pcm_signature = reference.pcm_signature;
        result.cross_device_stable = classroom.backend === "ffmpeg-s16" && reference.backend === "ffmpeg-s16";
        // 浏览器兼容解码仍可救回少数特殊文件，但不再把它伪装成跨设备
        // 完全一致的自动结果；界面会提醒用户试听确认。
        result.requires_manual_confirmation = !result.cross_device_stable || result.status !== "matched";
        this.result = result;
        this.referenceFile = referenceFile;
        this.emit("preview", .84, "正在将提取音轨绑定到视频时间线…");
        if (result.start_offset_ms != null) {
          // FFmpeg 将“音轨起点+保持音调的变速”直接渲染到和视频等长的
          // 48kHz 立体声时间线。手机与电脑因此使用同一时间基准，不再用
          // 22.05kHz 分析 PCM 做最终试听。
          await this.prepareTimelinePreview(duration);
        }
        this.emit("done", 1, "音乐对齐完成");
        return result;
      } finally {
        this.processing = false;
      }
    }

    async ensureReferenceInFs() {
      if (!this.referenceFile) throw new Error("请先选择干净音乐");
      if (!this.referenceInputName) await this.writeReferenceFile(this.referenceFile);
      return this.referenceInputName;
    }

    musicFilter(duration, outputLabel = "music", inputLabel = "0:a", options = {}) {
      if (!this.result) throw new Error("尚未完成音乐对齐");
      const speed = clamp(safeNumber(this.result.speed_ratio, 1), .5, 2);
      // MediaRecorder 必须等手机真正呈现首帧后才开始。因此导出画面的
      // 第 0 秒可能对应裁剪区内几毫秒之后，音乐也必须推进同样的时间。
      const timelineShift = Math.max(0, safeNumber(options.timelineShiftSeconds));
      const offset = safeNumber(this.result.start_offset_ms) / 1000 + timelineShift * speed;
      const safeDuration = Math.max(.1, duration);
      const fadeOutStart = Math.max(0, safeDuration - .08);
      const renderedVolume = options.includeVolume === false ? 1 : this.musicVolume;
      const mappings = (options.forceGlobal ? [] : (this.result.segment_mapping || [])).filter((item) => (
        safeNumber(item.video_end_ms) > safeNumber(item.video_start_ms)
        && safeNumber(item.music_start_ms) >= 0
      ));
      if (mappings.length <= 1 || this.result.manual_adjusted || offset < 0) {
        const placement = offset >= 0
          ? `atrim=start=${offset.toFixed(4)},asetpts=PTS-STARTPTS,atempo=${speed.toFixed(6)}`
          : `asetpts=PTS-STARTPTS,atempo=${speed.toFixed(6)},adelay=${Math.round(-offset / speed * 1000)}:all=1`;
        return `[${inputLabel}]${placement},volume=${renderedVolume.toFixed(3)},apad,atrim=duration=${safeDuration.toFixed(3)},afade=t=in:st=0:d=0.03,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.08[${outputLabel}]`;
      }
      // 暂停、剪切、重复播放或跳段时，根据全局锚点分段裁取并重新拼接，不强行使用一个全局偏移。
      const filters = [`[${inputLabel}]asplit=${mappings.length}${mappings.map((_, index) => `[source${index}]`).join("")}`];
      const labels = [];
      mappings.forEach((mapping, index) => {
        const musicStart = Math.max(0, safeNumber(mapping.music_start_ms) / 1000);
        const videoDuration = Math.max(.03, (safeNumber(mapping.video_end_ms) - safeNumber(mapping.video_start_ms)) / 1000);
        const mappingSpeed = clamp(safeNumber(mapping.speed_ratio, speed), .5, 2);
        // atempo 会保持音调，分段时也不使用会改变音高的 playbackRate。
        filters.push(`[source${index}]atrim=start=${musicStart.toFixed(4)},asetpts=PTS-STARTPTS,atempo=${mappingSpeed.toFixed(6)},atrim=duration=${videoDuration.toFixed(3)}[part${index}]`);
        labels.push(`[part${index}]`);
      });
      filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[joined]`);
      filters.push(`[joined]volume=${renderedVolume.toFixed(3)},apad,atrim=duration=${safeDuration.toFixed(3)},afade=t=in:st=0:d=0.03,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.08[${outputLabel}]`);
      return filters.join(";");
    }

    async renderAlignedPreview(duration) {
      const ffmpeg = await this.loadFFmpeg();
      const referenceName = await this.ensureReferenceInFs();
      const outputName = "aligned-preview.wav";
      await this.removeFile(outputName);
      const context = this.ensureAudioContext();
      const previewSampleRate = context.sampleRate >= 44100 ? Math.min(48000, context.sampleRate) : 48000;
      const exitCode = await ffmpeg.exec([
        "-hide_banner", "-loglevel", "error", "-i", referenceName,
        // 实时预览保持之前经验证的全局偏移逻辑；不连续分段只在最终导出使用，
        // 避免低置信局部锚点在手机试听中造成突然跳段。
        "-filter_complex", this.musicFilter(duration, "music", "0:a", { includeVolume: false, forceGlobal: true }),
        "-map", "[music]", "-ar", String(previewSampleRate), "-ac", "2", "-c:a", "pcm_s16le", outputName,
      ]);
      if (exitCode !== 0) throw new Error("对齐音轨预览生成失败");
      const data = await ffmpeg.readFile(outputName);
      await this.removeFile(outputName);
      // 不再把 WAV 交给 iOS decodeAudioData 二次解码，避免不同 Safari
      // 版本对 WAVE_FORMAT_EXTENSIBLE/采样率的差异。我们按头部精确创建 AudioBuffer。
      this.alignedPreviewBuffer = this.audioBufferFromWav(parseWav(data));
      this.previewUsesRawReference = false;
      this.previewQuality = "timeline-hq";
      return this.alignedPreviewBuffer;
    }

    async prepareTimelinePreview(duration) {
      if (this.ffmpeg) {
        try {
          return await this.renderAlignedPreview(duration);
        } catch (error) {
          console.warn("高保真时间线预览生成失败，改用源音轨预览", error);
        }
      }
      return this.prepareHighQualityReferencePreview();
    }

    async prepareRawReferencePreview() {
      return this.prepareHighQualityReferencePreview();
    }

    setCandidate(candidate, manual = false) {
      if (!this.result || !candidate) return;
      this.result.start_offset_ms = Math.round(safeNumber(candidate.start_offset_ms));
      this.result.speed_ratio = clamp(safeNumber(candidate.speed_ratio, this.result.speed_ratio || 1), .96, 1.04);
      this.result.manual_adjusted = Boolean(manual);
      if (manual) {
        const durationMs = Math.max(100, safeNumber(this.result.best_interval?.video_end_ms, 1000));
        this.result.segment_mapping = [{
          video_start_ms: 0,
          video_end_ms: durationMs,
          music_start_ms: this.result.start_offset_ms,
          music_end_ms: Math.round(this.result.start_offset_ms + durationMs * this.result.speed_ratio),
          speed_ratio: this.result.speed_ratio,
        }];
      }
      this.confirmed = false;
      this.alignedPreviewBuffer = null;
      this.previewUsesRawReference = false;
      this.stopPreview();
    }

    timelineStartMs() {
      if (!this.result) return 0;
      const speed = clamp(safeNumber(this.result.speed_ratio, 1), .5, 2);
      return -safeNumber(this.result.start_offset_ms) / speed;
    }

    async setTimelineStart(trackStartMs) {
      if (!this.result) return;
      const speed = clamp(safeNumber(this.result.speed_ratio, 1), .96, 1.04);
      this.setCandidate({ start_offset_ms: -safeNumber(trackStartMs) * speed, speed_ratio: speed }, true);
      const intervalDurationMs = safeNumber(this.result.best_interval?.video_end_ms, 0)
        - safeNumber(this.result.best_interval?.video_start_ms, 0);
      const duration = Math.max(.1, safeNumber(this.result.video_duration_ms, intervalDurationMs) / 1000);
      await this.prepareTimelinePreview(duration);
      this.confirm();
    }

    confirm() {
      if (!this.result || this.result.start_offset_ms == null) throw new Error("请先完成匹配或手动选择起点");
      this.confirmed = true;
      this.result.confirmed = true;
      this.result.original_volume = this.originalVolume;
      this.result.music_volume = this.musicVolume;
      this.result.mode = this.mode;
    }

    setMix({ mode, originalVolume, musicVolume } = {}) {
      if (mode) this.mode = mode;
      if (originalVolume != null) this.originalVolume = clamp(safeNumber(originalVolume), 0, 1);
      if (musicVolume != null) this.musicVolume = clamp(safeNumber(musicVolume), 0, 1.5);
      if (this.previewGain) this.previewGain.gain.value = this.musicVolume;
      if (this.result) {
        this.result.mode = this.mode;
        this.result.original_volume = this.originalVolume;
        this.result.music_volume = this.musicVolume;
      }
    }

    audioCoverageSeconds(timelineShiftSeconds = 0) {
      if (!this.result) return null;
      const speed = clamp(safeNumber(this.result.speed_ratio, 1), .5, 2);
      const start = this.timelineStartMs() / 1000 - Math.max(0, safeNumber(timelineShiftSeconds));
      const duration = Math.max(0, safeNumber(this.result.reference_duration_ms) / 1000 / speed);
      return { start, end: start + duration };
    }

    applyVideoVolume(video, trimStart = 0) {
      if (!video) return;
      if (!this.result) {
        video.muted = false;
        video.volume = 1;
        return;
      }
      const coverage = this.audioCoverageSeconds();
      const relativeTime = Math.max(0, safeNumber(video.currentTime) - Math.max(0, safeNumber(trimStart)));
      const hasExtractedMusic = coverage && relativeTime >= coverage.start && relativeTime < coverage.end;
      if (!hasExtractedMusic) {
        // 提取音轨尚未开始或已结束：使用视频原声，不留静音空白。
        video.muted = false;
        video.volume = 1;
        return;
      }
      // 提取音轨覆盖区间：默认只播放提取音乐；用户调高原声时则按滑块比例混合。
      video.muted = this.originalVolume <= 0;
      video.volume = clamp(this.originalVolume, 0, 1);
    }

    async startPreview(video, trimStart) {
      if (!this.alignedPreviewBuffer || !this.audioContext) {
        this.applyVideoVolume(video, trimStart);
        return;
      }
      const requestId = ++this.previewRequestId;
      this.stopPreview(false);
      await this.audioContext.resume();
      // seeked、play 与手动拖动在 iPhone 上可能同时触发。旧的异步启动
      // 不得覆盖最新的视频位置，否则会听到错位或双音轨。
      if (requestId !== this.previewRequestId || video.paused || video.seeking) return;
      const relativeTime = Math.max(0, video.currentTime - trimStart);
      const speed = safeNumber(this.result?.speed_ratio, 1);
      // 音轨是固定在视频时间线上的片段：
      // musicTime = (videoTime - trackStart) * speed。
      // 例如 trackStart=3.509：从 1s 播放会等 2.509s；从 15s 播放会立即从音乐 11.491s 播放。
      const trackStart = this.timelineStartMs() / 1000;
      const musicTime = this.previewUsesRawReference
        ? (relativeTime - trackStart) * speed
        : relativeTime;
      if (musicTime >= this.alignedPreviewBuffer.duration) {
        this.previewStartedAt = this.audioContext.currentTime;
        this.previewVideoTime = relativeTime;
        this.applyVideoVolume(video, trimStart);
        return;
      }
      const source = this.audioContext.createBufferSource();
      const gain = this.audioContext.createGain();
      source.buffer = this.alignedPreviewBuffer;
      // Web Audio 兼容预览只在 FFmpeg 无法运行时启用；极小的漂移在这里用 playbackRate 跟随，
      // 正式导出仍由 FFmpeg atempo 保持音调。
      source.playbackRate.value = this.previewUsesRawReference ? speed : 1;
      source.connect(gain);
      gain.connect(this.audioContext.destination);
      const sourceOffset = Math.max(0, musicTime);
      const delay = this.previewUsesRawReference && relativeTime < trackStart ? trackStart - relativeTime : 0;
      const startAt = this.audioContext.currentTime + delay;
      // iOS 上直接在非零波形位置启动/重定位 AudioBufferSourceNode
      // 会产生连续“咔哒”声。每次启动用 25ms 短淡入消除波形跳变。
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(this.musicVolume, startAt + .025);
      // AudioBufferSourceNode.start 的第一个参数是 AudioContext 的“绝对时间”，不是延迟秒数。
      // 之前直接传 3.509，当 AudioContext.currentTime 已超过 3.509 时会被当成“立即播放”。
      // 现在从当前音频时钟往后排程，所以视频 0–3.509 秒保持无提取音乐。
      source.start(startAt, sourceOffset);
      this.previewSource = source;
      this.previewGain = gain;
      this.previewStartedAt = this.audioContext.currentTime;
      this.previewVideoTime = relativeTime;
      this.previewMusicTime = musicTime;
      this.previewPlaybackRate = source.playbackRate.value;
      this.previewLastSyncAt = global.performance?.now?.() || Date.now();
      this.applyVideoVolume(video, trimStart);
      const coverage = this.audioCoverageSeconds();
      if (coverage) {
        const nextBoundary = relativeTime < coverage.start ? coverage.start : coverage.end;
        const boundaryDelay = nextBoundary - relativeTime;
        if (boundaryDelay > 0) {
          this.previewBoundaryTimer = global.setTimeout(() => {
            this.previewBoundaryTimer = null;
            this.applyVideoVolume(video, trimStart);
          }, boundaryDelay * 1000);
        }
      }
      source.onended = () => {
        if (this.previewSource !== source) return;
        this.previewSource = null;
        this.previewGain = null;
        if (this.previewBoundaryTimer) global.clearTimeout(this.previewBoundaryTimer);
        this.previewBoundaryTimer = null;
        this.applyVideoVolume(video, trimStart);
      };
    }

    stopPreview(invalidatePending = true) {
      if (invalidatePending) this.previewRequestId += 1;
      if (this.previewBoundaryTimer) global.clearTimeout(this.previewBoundaryTimer);
      this.previewBoundaryTimer = null;
      if (this.previewSource) {
        const source = this.previewSource;
        const gain = this.previewGain;
        const context = this.audioContext;
        if (gain && context?.state === "running") {
          // 还在播放时用 20ms 淡出，避免拖动进度条或自动校时时爆音。
          const now = context.currentTime;
          const currentGain = clamp(safeNumber(gain.gain.value, this.musicVolume), 0, 1.5);
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(currentGain, now);
          gain.gain.linearRampToValueAtTime(0, now + .018);
          try { source.stop(now + .022); } catch (_) { /* 已停止 */ }
          global.setTimeout(() => {
            try { source.disconnect(); } catch (_) { /* 已断开 */ }
            try { gain.disconnect(); } catch (_) { /* 已断开 */ }
          }, 40);
        } else {
          try { source.stop(); } catch (_) { /* 已停止 */ }
          try { source.disconnect(); } catch (_) { /* 已断开 */ }
          try { gain?.disconnect(); } catch (_) { /* 已断开 */ }
        }
      }
      this.previewSource = null;
      this.previewGain = null;
    }

    async syncPreview(video, trimStart, force = false) {
      if (!this.alignedPreviewBuffer || video.paused || video.seeking) return;
      const expected = video.currentTime - trimStart;
      const actual = this.previewVideoTime + (this.audioContext.currentTime - this.previewStartedAt);
      const now = global.performance?.now?.() || Date.now();
      const drift = Math.abs(expected - actual);
      // iOS timeupdate 时间粒度较粗，旧的 120ms 阈值会在正常播放时反复
      // stop/start 音源，听起来像音轨损坏。改为容差+冷却，真正拖动仍可强制校时。
      if (force && now - this.previewLastSyncAt < 80) return;
      if (force || (drift > this.previewResyncThreshold && now - this.previewLastSyncAt >= this.previewResyncCooldownMs)) {
        this.previewLastSyncAt = now;
        await this.startPreview(video, trimStart);
      }
    }

    exportParameters() {
      if (!this.result) return null;
      const trackStartInTrimMs = Math.round(this.timelineStartMs());
      const trimStartMs = Math.round(safeNumber(this.result.trim_start_ms));
      return {
        reference_audio_path: this.referenceFile?.name || this.result.reference_audio_path || "",
        start_offset_ms: Math.round(safeNumber(this.result.start_offset_ms)),
        // track_start_ms 保留旧字段语义（成片/裁剪区内相对时间）；
        // 新字段明确保存原视频绝对时间，避免电脑和手机裁剪起点不同时被误认为对齐结果不同。
        track_start_ms: trackStartInTrimMs,
        track_start_in_trim_ms: trackStartInTrimMs,
        track_start_in_source_ms: trimStartMs + trackStartInTrimMs,
        trim_start_ms: trimStartMs,
        speed_ratio: safeNumber(this.result.speed_ratio, 1),
        segment_mapping: this.result.segment_mapping || [],
        confidence: safeNumber(this.result.confidence),
        original_volume: this.originalVolume,
        music_volume: this.musicVolume,
        mode: this.mode,
      };
    }

    async muxProcessedVideo(processedBlob, duration, onProgress = () => {}, options = {}) {
      if (!this.confirmed) throw new Error("低置信度音乐必须先手动确认对齐位置");
      if (!options.originalFile) throw new Error("缺少课堂视频原音轨");
      const ffmpeg = await this.loadFFmpeg();
      const referenceName = await this.ensureReferenceInFs();
      const inputName = (processedBlob.type || "").includes("mp4") ? "processed-video.mp4" : "processed-video.webm";
      const originalName = `source-original.${extensionFor(options.originalFile, "mp4")}`;
      const outputName = "dancefocus-music.mp4";
      await this.removeFile(inputName);
      await this.removeFile(originalName);
      await this.removeFile(outputName);
      await ffmpeg.writeFile(inputName, new Uint8Array(await processedBlob.arrayBuffer()));
      await ffmpeg.writeFile(originalName, new Uint8Array(await options.originalFile.arrayBuffer()));
      onProgress(.08, "正在组装对齐后的新音轨…");
      // 最终文件必须和用户已经试听确认的预览使用同一条全局时间线。
      // 局部锚点只用于诊断不连续片段，不能在导出时造成音乐回跳。
      const timelineShift = Math.max(0, safeNumber(options.timelineShiftSeconds));
      const originalStart = Math.max(0, safeNumber(options.originalStartSeconds));
      const music = this.musicFilter(duration, "music", "1:a", { forceGlobal: true, timelineShiftSeconds: timelineShift });
      const coverage = this.audioCoverageSeconds(timelineShift) || { start: 0, end: 0 };
      const coverageStart = clamp(coverage.start, 0, duration);
      const coverageEnd = clamp(coverage.end, 0, duration);
      // 导出与预览保持一致：粉色音轨之外保留 100% 视频原声，
      // 音轨覆盖区间再将原声调成用户设置的音量（0% 即完全替换）。
      let filter = music;
      const insideGain = this.originalVolume.toFixed(3);
      // volume 滤镜的基础音量为 100%，只在提取音轨覆盖期间切换为用户设置值。
      filter += `;[2:a]atrim=start=${originalStart.toFixed(4)}:duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume='if(between(t,${coverageStart.toFixed(4)},${coverageEnd.toFixed(4)}),${insideGain},1)':eval=frame[original]`;
      filter += ";[original][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]";
      const audioMap = "[aout]";
      const args = [
        "-hide_banner", "-loglevel", "error", "-i", inputName, "-i", referenceName, "-i", originalName,
        "-filter_complex", filter, "-map", "0:v:0", "-map", audioMap,
        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart",
        "-t", Math.max(.1, duration).toFixed(3), outputName,
      ];
      const previousProgress = this.ffmpegTaskProgress;
      this.ffmpegTaskProgress = (progress) => onProgress(.08 + progress * .84, "正在合成与预览一致的音轨…");
      let exitCode;
      try {
        exitCode = await ffmpeg.exec(args);
        if (exitCode !== 0) {
          // 某些 Chrome 只能产生 VP8/VP9 WebM，无法直接 copy 进 MP4；此时才回退到一次兼容编码。
          await this.removeFile(outputName);
          const fallbackArgs = [...args];
          const videoCodecIndex = fallbackArgs.indexOf("copy");
          fallbackArgs.splice(videoCodecIndex, 1, "libx264", "-preset", "veryfast", "-crf", "16");
          exitCode = await ffmpeg.exec(fallbackArgs);
        }
      } finally {
        this.ffmpegTaskProgress = previousProgress;
      }
      if (exitCode !== 0) {
        await this.removeFile(inputName);
        await this.removeFile(originalName);
        throw new Error("新音轨合成失败，请换新版 Safari / Chrome 重试");
      }
      onProgress(.94, "正在完成音画同步…");
      const data = await ffmpeg.readFile(outputName);
      const blob = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)], { type: "video/mp4" });
      await this.removeFile(inputName);
      await this.removeFile(originalName);
      await this.removeFile(outputName);
      onProgress(1, "导出文件已生成");
      return blob;
    }

    async muxOriginalAudio(processedBlob, originalFile, originalStartSeconds, duration, onProgress = () => {}) {
      if (!originalFile) throw new Error("缺少课堂视频原音轨");
      const ffmpeg = await this.loadFFmpeg();
      const inputName = (processedBlob.type || "").includes("mp4") ? "processed-original.mp4" : "processed-original.webm";
      const originalName = `source-only.${extensionFor(originalFile, "mp4")}`;
      const outputName = "dancefocus-original.mp4";
      for (const name of [inputName, originalName, outputName]) await this.removeFile(name);
      await ffmpeg.writeFile(inputName, new Uint8Array(await processedBlob.arrayBuffer()));
      await ffmpeg.writeFile(originalName, new Uint8Array(await originalFile.arrayBuffer()));
      const safeDuration = Math.max(.1, safeNumber(duration));
      const safeStart = Math.max(0, safeNumber(originalStartSeconds));
      const filter = `[1:a]atrim=start=${safeStart.toFixed(4)}:duration=${safeDuration.toFixed(3)},asetpts=PTS-STARTPTS[aout]`;
      const args = [
        "-hide_banner", "-loglevel", "error", "-i", inputName, "-i", originalName,
        "-filter_complex", filter, "-map", "0:v:0", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart",
        "-t", safeDuration.toFixed(3), outputName,
      ];
      const previousProgress = this.ffmpegTaskProgress;
      this.ffmpegTaskProgress = (progress) => onProgress(.08 + progress * .84, "正在按实际首帧同步原声…");
      let exitCode;
      try {
        exitCode = await ffmpeg.exec(args);
        if (exitCode !== 0) {
          await this.removeFile(outputName);
          const fallbackArgs = [...args];
          const videoCodecIndex = fallbackArgs.indexOf("copy");
          fallbackArgs.splice(videoCodecIndex, 1, "libx264", "-preset", "veryfast", "-crf", "16");
          exitCode = await ffmpeg.exec(fallbackArgs);
        }
      } finally {
        this.ffmpegTaskProgress = previousProgress;
      }
      if (exitCode !== 0) {
        for (const name of [inputName, originalName, outputName]) await this.removeFile(name);
        throw new Error("原视频音轨合成失败");
      }
      const data = await ffmpeg.readFile(outputName);
      const blob = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)], { type: "video/mp4" });
      for (const name of [inputName, originalName, outputName]) await this.removeFile(name);
      onProgress(1, "导出文件已生成");
      return blob;
    }

    reset() {
      this.stopPreview();
      this.referenceFile = null;
      this.referenceInputName = "";
      this.result = null;
      this.confirmed = false;
      this.alignedPreviewBuffer = null;
      this.referenceDecodedBuffer = null;
      this.referencePreviewPcm = null;
      this.referencePreviewSampleRate = this.sampleRate;
      this.previewQuality = "analysis";
      this.previewUsesRawReference = false;
      this.mode = "replace";
      this.originalVolume = 0;
      this.musicVolume = 1;
    }

    async dispose() {
      this.stopPreview();
      if (this.audioContext) await this.audioContext.close().catch(() => {});
      if (this.ffmpeg) this.ffmpeg.terminate();
      this.audioContext = null;
      this.ffmpeg = null;
      this.ffmpegPromise = null;
    }
  }

  global.ReferenceMusicEngine = ReferenceMusicEngine;
})(window);

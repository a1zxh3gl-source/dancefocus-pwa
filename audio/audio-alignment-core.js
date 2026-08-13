/* 音乐内容对齐核心：Chroma + MFCC + onset + 轻量音频指纹 + 局部相关 + 漂移锚点。 */
(function initAudioAlignmentCore(global) {
  "use strict";

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const l2normalize = (values) => {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) sum += values[i] * values[i];
    const scale = 1 / (Math.sqrt(sum) || 1);
    for (let i = 0; i < values.length; i += 1) values[i] *= scale;
    return values;
  };
  const cosineFlat = (a, aOffset, b, bOffset, length) => {
    let dot = 0; let aa = 0; let bb = 0;
    for (let i = 0; i < length; i += 1) {
      const av = a[aOffset + i]; const bv = b[bOffset + i];
      dot += av * bv; aa += av * av; bb += bv * bv;
    }
    return dot / (Math.sqrt(aa * bb) || 1);
  };

  function fft(real, imag) {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }
    for (let length = 2; length <= n; length <<= 1) {
      const angle = -2 * Math.PI / length;
      const wLenR = Math.cos(angle); const wLenI = Math.sin(angle);
      for (let start = 0; start < n; start += length) {
        let wr = 1; let wi = 0;
        for (let j = 0; j < length / 2; j += 1) {
          const even = start + j; const odd = even + length / 2;
          const vr = real[odd] * wr - imag[odd] * wi;
          const vi = real[odd] * wi + imag[odd] * wr;
          real[odd] = real[even] - vr; imag[odd] = imag[even] - vi;
          real[even] += vr; imag[even] += vi;
          const nextWr = wr * wLenR - wi * wLenI;
          wi = wr * wLenI + wi * wLenR; wr = nextWr;
        }
      }
    }
  }

  const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const melToHz = (mel) => 700 * (10 ** (mel / 2595) - 1);

  function createMelFilters(sampleRate, frameSize, bandCount = 20) {
    const nyquist = sampleRate / 2;
    const minMel = hzToMel(50); const maxMel = hzToMel(Math.min(8000, nyquist));
    const points = Array.from({ length: bandCount + 2 }, (_, index) => (
      Math.floor((frameSize + 1) * melToHz(minMel + (maxMel - minMel) * index / (bandCount + 1)) / sampleRate)
    ));
    return Array.from({ length: bandCount }, (_, band) => ({
      left: points[band], center: Math.max(points[band] + 1, points[band + 1]), right: Math.max(points[band + 1] + 1, points[band + 2]),
    }));
  }

  function extractFeatures(samples, sampleRate, options = {}) {
    const frameSize = options.frameSize || 2048;
    const hopSize = options.hopSize || 1024;
    const mfccCount = options.mfccCount || 8;
    const count = Math.max(0, Math.floor((samples.length - frameSize) / hopSize) + 1);
    const chroma = new Float32Array(count * 12);
    const mfcc = new Float32Array(count * mfccCount);
    const onset = new Float32Array(count);
    const rms = new Float32Array(count);
    const real = new Float64Array(frameSize); const imag = new Float64Array(frameSize);
    const previousMagnitude = new Float64Array(frameSize / 2);
    const filters = createMelFilters(sampleRate, frameSize, 20);
    const melLog = new Float64Array(filters.length);
    const magnitude = new Float64Array(frameSize / 2);
    for (let frame = 0; frame < count; frame += 1) {
      let energy = 0;
      const start = frame * hopSize;
      for (let i = 0; i < frameSize; i += 1) {
        const value = samples[start + i] || 0;
        const windowed = value * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frameSize - 1)));
        real[i] = windowed; imag[i] = 0; energy += value * value;
      }
      rms[frame] = Math.sqrt(energy / frameSize);
      fft(real, imag);
      let flux = 0;
      for (let bin = 1; bin < frameSize / 2; bin += 1) {
        const mag = Math.sqrt(real[bin] ** 2 + imag[bin] ** 2);
        magnitude[bin] = mag;
        flux += Math.max(0, mag - previousMagnitude[bin]);
        previousMagnitude[bin] = mag;
        const frequency = bin * sampleRate / frameSize;
        if (frequency < 55 || frequency > 5000) continue;
        const midi = 69 + 12 * Math.log2(frequency / 440);
        const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
        chroma[frame * 12 + pitchClass] += Math.sqrt(mag);
      }
      onset[frame] = flux / (frameSize / 2);
      l2normalize(chroma.subarray(frame * 12, frame * 12 + 12));
      filters.forEach((filter, band) => {
        let value = 0;
        for (let bin = filter.left; bin < filter.center; bin += 1) value += magnitude[bin] * (bin - filter.left) / Math.max(1, filter.center - filter.left);
        for (let bin = filter.center; bin < filter.right; bin += 1) value += magnitude[bin] * (filter.right - bin) / Math.max(1, filter.right - filter.center);
        melLog[band] = Math.log1p(value);
      });
      for (let coefficient = 0; coefficient < mfccCount; coefficient += 1) {
        let value = 0;
        for (let band = 0; band < filters.length; band += 1) value += melLog[band] * Math.cos(Math.PI * coefficient * (band + .5) / filters.length);
        mfcc[frame * mfccCount + coefficient] = value;
      }
      l2normalize(mfcc.subarray(frame * mfccCount, frame * mfccCount + mfccCount));
    }
    let onsetMean = 0; let onsetSquare = 0;
    for (const value of onset) { onsetMean += value; onsetSquare += value * value; }
    onsetMean /= Math.max(1, onset.length);
    const onsetDeviation = Math.sqrt(Math.max(1e-9, onsetSquare / Math.max(1, onset.length) - onsetMean ** 2));
    for (let i = 0; i < onset.length; i += 1) onset[i] = clamp((onset[i] - onsetMean) / (onsetDeviation * 3) + .35, 0, 1);
    return { sampleRate, frameSize, hopSize, frameDuration: hopSize / sampleRate, count, mfccCount, chroma, mfcc, onset, rms };
  }

  function frameScore(query, qi, reference, ri) {
    const chromaScore = Math.max(0, cosineFlat(query.chroma, qi * 12, reference.chroma, ri * 12, 12));
    const mfccScore = Math.max(0, cosineFlat(query.mfcc, qi * query.mfccCount, reference.mfcc, ri * reference.mfccCount, query.mfccCount));
    const onsetScore = 1 - Math.min(1, Math.abs(query.onset[qi] - reference.onset[ri]));
    return chromaScore * .72 + mfccScore * .12 + onsetScore * .16;
  }

  function strongestPitchPair(features, frame) {
    let first = 0; let second = 1;
    for (let pitch = 0; pitch < 12; pitch += 1) {
      const value = features.chroma[frame * 12 + pitch];
      if (value > features.chroma[frame * 12 + first]) { second = first; first = pitch; }
      else if (pitch !== first && value > features.chroma[frame * 12 + second]) second = pitch;
    }
    return first < second ? first * 12 + second : second * 12 + first;
  }

  function fingerprintOffsetVotes(query, reference) {
    const referenceMap = new Map();
    for (let frame = 0; frame < reference.count; frame += 2) {
      if (reference.onset[frame] < .58) continue;
      const hash = strongestPitchPair(reference, frame);
      if (!referenceMap.has(hash)) referenceMap.set(hash, []);
      referenceMap.get(hash).push(frame);
    }
    const votes = new Map();
    for (let frame = 0; frame < query.count; frame += 2) {
      if (query.onset[frame] < .58) continue;
      const positions = referenceMap.get(strongestPitchPair(query, frame)) || [];
      positions.forEach((position) => {
        const offset = Math.round((position - frame) / 4) * 4;
        votes.set(offset, (votes.get(offset) || 0) + 1);
      });
    }
    return [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([frame, votesCount]) => ({ frame, votes: votesCount }));
  }

  function scoreOffset(query, reference, offset, speedRatio, startFrame = 0, endFrame = query.count) {
    let score = 0; let weightSum = 0; let compared = 0;
    const stride = 3;
    for (let qi = startFrame; qi < endFrame; qi += stride) {
      const ri = Math.round(offset + qi * speedRatio);
      if (ri < 0 || ri >= reference.count) continue;
      const activity = query.rms[qi] > 0.001 ? .55 + .45 * Math.min(1, query.rms[qi] * 25) : .12;
      score += frameScore(query, qi, reference, ri) * activity;
      weightSum += activity;
      compared += 1;
    }
    if (!weightSum) return 0;
    // 允许参考视频只覆盖课堂视频的一部分，但不让只有极少量重叠帧的偶然相似获得高分。
    const expected = Math.max(1, Math.ceil((endFrame - startFrame) / stride));
    const coverage = compared / expected;
    return score / weightSum * (.4 + .6 * Math.sqrt(coverage));
  }

  function coarseCandidates(query, reference, options = {}) {
    const speeds = options.speeds || [.985, .9925, 1, 1.0075, 1.015];
    const fingerprint = fingerprintOffsetVotes(query, reference);
    const fingerprintOffsets = new Map(fingerprint.map((item) => [item.frame, item.votes]));
    const scored = [];
    speeds.forEach((speedRatio) => {
      // offset 定义为“课堂视频 0 秒对应参考音频的位置”。
      // 参考视频若从课堂视频中途才开始，offset 必须可以为负数。
      const shorter = Math.min(query.count, reference.count);
      const fourSeconds = Math.round(4 / reference.frameDuration);
      const minOverlap = Math.min(shorter, Math.max(8, Math.min(fourSeconds, Math.round(shorter * .45))));
      const minOffset = Math.floor(minOverlap - query.count * speedRatio);
      const maxOffset = Math.ceil(reference.count - minOverlap);
      const step = 2;
      for (let offset = minOffset; offset <= maxOffset; offset += step) {
        let score = scoreOffset(query, reference, offset, speedRatio);
        let nearestVote = 0;
        fingerprintOffsets.forEach((votes, fingerprintOffset) => {
          if (Math.abs(fingerprintOffset - offset) <= 4) nearestVote = Math.max(nearestVote, votes);
        });
        score += Math.min(.04, nearestVote * .0025);
        scored.push({ offsetFrame: offset, speedRatio, score });
      }
    });
    scored.sort((a, b) => b.score - a.score);
    const separationFrames = Math.max(8, Math.round(4 / reference.frameDuration));
    const candidates = [];
    for (const item of scored) {
      if (candidates.some((candidate) => Math.abs(candidate.offsetFrame - item.offsetFrame) < separationFrames)) continue;
      candidates.push(item);
      if (candidates.length >= 5) break;
    }
    return candidates;
  }

  function transientEnvelope(samples, sampleRate, durationSeconds) {
    const hop = Math.max(1, Math.round(sampleRate * .01));
    const limit = Math.min(samples.length, Math.round(durationSeconds * sampleRate));
    const count = Math.floor(limit / hop);
    const output = new Float32Array(count);
    let previous = 0;
    for (let frame = 0; frame < count; frame += 1) {
      let energy = 0;
      for (let i = frame * hop; i < Math.min(limit, (frame + 1) * hop); i += 1) {
        const current = samples[i];
        const highpass = current - previous * .97;
        previous = current;
        energy += highpass * highpass;
      }
      output[frame] = Math.sqrt(energy / hop);
    }
    let mean = 0;
    for (const value of output) mean += value;
    mean /= Math.max(1, output.length);
    for (let i = output.length - 1; i > 0; i -= 1) output[i] = Math.max(0, output[i] - output[i - 1] - mean * .04);
    return { values: output, hopSeconds: hop / sampleRate };
  }

  function normalizedCorrelation(a, b, bStart) {
    let sumA = 0; let sumB = 0; let count = 0;
    for (let i = 0; i < a.length; i += 1) {
      const bi = bStart + i;
      if (bi < 0 || bi >= b.length) continue;
      sumA += a[i]; sumB += b[bi]; count += 1;
    }
    if (count < 20) return -1;
    const meanA = sumA / count; const meanB = sumB / count;
    let dot = 0; let aa = 0; let bb = 0;
    for (let i = 0; i < a.length; i += 1) {
      const bi = bStart + i;
      if (bi < 0 || bi >= b.length) continue;
      const av = a[i] - meanA; const bv = b[bi] - meanB;
      dot += av * bv; aa += av * av; bb += bv * bv;
    }
    return dot / (Math.sqrt(aa * bb) || 1);
  }

  function fineOffset(querySamples, referenceSamples, sampleRate, coarseSeconds) {
    // 负 offset 时，课堂视频开头还没有进入参考音频。从两者真正重叠处做毫秒级精匹配，
    // 避免拿课堂视频的第 0 秒强行去匹配参考音频第 0 秒。
    const queryStartSeconds = Math.max(0, -coarseSeconds);
    const referenceStartSeconds = Math.max(0, coarseSeconds);
    const overlapDuration = Math.max(.2, Math.min(
      18,
      querySamples.length / sampleRate - queryStartSeconds,
      referenceSamples.length / sampleRate - referenceStartSeconds,
    ));
    const queryStartSample = Math.max(0, Math.round(queryStartSeconds * sampleRate));
    const queryEnvelope = transientEnvelope(querySamples.subarray(queryStartSample), sampleRate, overlapDuration);
    const referenceEnvelope = transientEnvelope(referenceSamples, sampleRate, referenceSamples.length / sampleRate);
    const coarseFrame = Math.round((coarseSeconds + queryStartSeconds) / referenceEnvelope.hopSeconds);
    const radius = Math.round(.9 / referenceEnvelope.hopSeconds);
    let bestFrame = coarseFrame; let bestScore = -Infinity;
    const correlations = [];
    for (let frame = coarseFrame - radius; frame <= coarseFrame + radius; frame += 1) {
      const score = normalizedCorrelation(queryEnvelope.values, referenceEnvelope.values, frame);
      correlations.push({ frame, score });
      if (score > bestScore) { bestScore = score; bestFrame = frame; }
    }
    const index = correlations.findIndex((item) => item.frame === bestFrame);
    let subFrame = 0;
    if (index > 0 && index < correlations.length - 1) {
      const left = correlations[index - 1].score; const middle = correlations[index].score; const right = correlations[index + 1].score;
      const denominator = left - 2 * middle + right;
      if (Math.abs(denominator) > 1e-6) subFrame = clamp(.5 * (left - right) / denominator, -.5, .5);
    }
    return { offsetSeconds: (bestFrame + subFrame) * referenceEnvelope.hopSeconds - queryStartSeconds, correlation: bestScore };
  }

  function localAnchors(query, reference, offsetFrame, speedRatio) {
    // 较短窗可在暂停、剪切或跳段后尽快生成新锚点，而不把不连续音频强行拉成一条直线。
    const windowFrames = Math.max(12, Math.round(3 / query.frameDuration));
    const searchRadius = Math.round(2.5 / reference.frameDuration);
    const anchors = [];
    for (let start = 0; start + windowFrames <= query.count; start += windowFrames) {
      const predicted = Math.round(offsetFrame + start * speedRatio);
      let bestOffset = predicted; let bestScore = -Infinity;
      for (let candidate = predicted - searchRadius; candidate <= predicted + searchRadius; candidate += 2) {
        const score = scoreOffset(query, reference, candidate - start * speedRatio, speedRatio, start, start + windowFrames);
        if (score > bestScore) { bestScore = score; bestOffset = candidate; }
      }
      // 再做一次稀疏全曲搜索：只有得分明显更高才跳到新区间，用于识别中途暂停、剪切或跳段。
      let globalOffset = bestOffset; let globalScore = bestScore;
      const maxStart = Math.max(0, reference.count - windowFrames);
      for (let candidate = 0; candidate <= maxStart; candidate += 4) {
        const score = scoreOffset(query, reference, candidate - start * speedRatio, speedRatio, start, start + windowFrames);
        if (score > globalScore) { globalScore = score; globalOffset = candidate; }
      }
      if (globalScore > bestScore + .035) { bestScore = globalScore; bestOffset = globalOffset; }
      anchors.push({ videoTime: start * query.frameDuration, musicTime: bestOffset * reference.frameDuration, score: bestScore });
    }
    return anchors;
  }

  function regressionFromAnchors(anchors, fallbackOffset, fallbackSpeed) {
    const reliable = anchors.filter((anchor) => anchor.score >= .48);
    if (reliable.length < 2) return { offsetSeconds: fallbackOffset, speedRatio: fallbackSpeed, residual: Infinity };
    let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
    reliable.forEach(({ videoTime: x, musicTime: y }) => { sx += x; sy += y; sxx += x * x; sxy += x * y; });
    const count = reliable.length;
    const denominator = count * sxx - sx * sx;
    const speedRatio = denominator ? (count * sxy - sx * sy) / denominator : fallbackSpeed;
    const offsetSeconds = (sy - speedRatio * sx) / count;
    let residual = 0;
    reliable.forEach(({ videoTime, musicTime }) => { residual += Math.abs(musicTime - (offsetSeconds + speedRatio * videoTime)); });
    return { offsetSeconds, speedRatio, residual: residual / count };
  }

  function buildSegmentMapping(anchors, duration, offsetSeconds, speedRatio) {
    if (!anchors.length) return [{ video_start_ms: 0, video_end_ms: Math.round(duration * 1000), music_start_ms: Math.round(offsetSeconds * 1000), music_end_ms: Math.round((offsetSeconds + duration * speedRatio) * 1000), speed_ratio: speedRatio }];
    const segments = []; let segmentStart = 0; let segmentMusicStart = offsetSeconds; let previous = anchors[0];
    for (let index = 1; index < anchors.length; index += 1) {
      const current = anchors[index];
      const expectedMusic = previous.musicTime + (current.videoTime - previous.videoTime) * speedRatio;
      if (Math.abs(current.musicTime - expectedMusic) > .85) {
        segments.push({ video_start_ms: Math.round(segmentStart * 1000), video_end_ms: Math.round(current.videoTime * 1000), music_start_ms: Math.round(segmentMusicStart * 1000), music_end_ms: Math.round(expectedMusic * 1000), speed_ratio: speedRatio });
        segmentStart = current.videoTime;
        segmentMusicStart = current.musicTime;
      }
      previous = current;
    }
    segments.push({ video_start_ms: Math.round(segmentStart * 1000), video_end_ms: Math.round(duration * 1000), music_start_ms: Math.round(segmentMusicStart * 1000), music_end_ms: Math.round((segmentMusicStart + (duration - segmentStart) * speedRatio) * 1000), speed_ratio: speedRatio });
    return segments;
  }

  function waveform(samples, points = 240) {
    const values = new Float32Array(points);
    const block = Math.max(1, Math.floor(samples.length / points));
    for (let point = 0; point < points; point += 1) {
      let peak = 0;
      for (let index = point * block; index < Math.min(samples.length, (point + 1) * block); index += 1) peak = Math.max(peak, Math.abs(samples[index]));
      values[point] = peak;
    }
    const max = Math.max(.0001, ...values);
    for (let index = 0; index < values.length; index += 1) values[index] /= max;
    return values;
  }

  function alignAudio(querySamples, referenceSamples, sampleRate, options = {}) {
    const startedAt = Date.now();
    const queryRms = Math.sqrt(querySamples.reduce((sum, value) => sum + value * value, 0) / Math.max(1, querySamples.length));
    if (queryRms < .0007) return { status: "no-effective-audio", confidence: 0, candidates: [], processing_ms: Date.now() - startedAt };
    let peak = 0;
    for (const value of querySamples) peak = Math.max(peak, Math.abs(value));
    const crestFactor = peak / Math.max(1e-6, queryRms);
    const query = extractFeatures(querySamples, sampleRate, options);
    const reference = extractFeatures(referenceSamples, sampleRate, options);
    if (query.count < 10 || reference.count < 10) return { status: "audio-too-short", confidence: 0, candidates: [], processing_ms: Date.now() - startedAt };
    const coarse = coarseCandidates(query, reference, options);
    if (!coarse.length) return { status: "no-match", confidence: 0, candidates: [], processing_ms: Date.now() - startedAt };
    const refined = coarse.map((candidate) => {
      const coarseSeconds = candidate.offsetFrame * reference.frameDuration;
      const fine = fineOffset(querySamples, referenceSamples, sampleRate, coarseSeconds);
      return { ...candidate, start_offset_ms: Math.round(fine.offsetSeconds * 1000), fine_correlation: fine.correlation };
    });
    refined.sort((a, b) => (b.score + Math.max(0, b.fine_correlation) * .08) - (a.score + Math.max(0, a.fine_correlation) * .08));
    const best = refined[0]; const second = refined[1];
    const margin = second ? best.score - second.score : .2;
    const scoreConfidence = clamp((best.score - .42) / .34, 0, 1);
    const marginConfidence = clamp(margin / .10, 0, 1);
    const fineConfidence = clamp((best.fine_correlation + .05) / .55, 0, 1);
    const rawConfidence = clamp(scoreConfidence * .64 + marginConfidence * .22 + fineConfidence * .14, 0, 1);
    const anchors = localAnchors(query, reference, best.offsetFrame, best.speedRatio);
    const regression = regressionFromAnchors(anchors, best.start_offset_ms / 1000, best.speedRatio);
    // 只在多个可靠锚点确实显示漂移时才变速；否则保持 1.0，避免错误的 0.98× 越播越偏。
    const safeSpeed = Number.isFinite(regression.residual)
      && regression.residual <= .24
      && regression.speedRatio >= .96
      && regression.speedRatio <= 1.04
      ? regression.speedRatio
      : 1;
    const duration = querySamples.length / sampleRate;
    const segmentMapping = buildSegmentMapping(anchors, duration, best.start_offset_ms / 1000, safeSpeed);
    const ambiguous = Boolean(second && margin < .035);
    // 不同歌曲在很长参考音乐中也可能出现偶然的粗匹配；精相关过低时必须降权，不允许静默作为高置信结果。
    const fineQuality = clamp((best.fine_correlation + .05) / .7, 0, 1);
    const confidence = clamp(rawConfidence * (.58 + .42 * fineQuality), 0, 1);
    const likelyNoiseDominated = crestFactor > 4.8 && best.fine_correlation < .26;
    const status = best.score < .48 || best.fine_correlation < .08
      ? "not-same-song"
      : confidence < .55 || likelyNoiseDominated
        ? "low-confidence"
        : ambiguous ? "ambiguous" : "matched";
    return {
      status,
      start_offset_ms: best.start_offset_ms,
      speed_ratio: safeSpeed,
      confidence,
      ambiguous,
      match_score: best.score,
      best_interval: { video_start_ms: 0, video_end_ms: Math.round(duration * 1000), music_start_ms: best.start_offset_ms, music_end_ms: Math.round(best.start_offset_ms + duration * 1000 * safeSpeed) },
      candidates: refined.slice(0, 3).map((candidate) => ({ start_offset_ms: candidate.start_offset_ms, speed_ratio: candidate.speedRatio, confidence: clamp((candidate.score - .40) / .38, 0, 1), score: candidate.score, fine_correlation: candidate.fine_correlation })),
      anchors,
      segment_mapping: segmentMapping,
      drift_residual_ms: Number.isFinite(regression.residual) ? Math.round(regression.residual * 1000) : null,
      classroom_waveform: waveform(querySamples),
      reference_waveform: waveform(referenceSamples),
      processing_ms: Date.now() - startedAt,
    };
  }

  const api = { extractFeatures, coarseCandidates, fineOffset, alignAudio, waveform, scoreOffset, buildSegmentMapping };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.AudioAlignmentCore = api;
})(typeof self !== "undefined" ? self : globalThis);

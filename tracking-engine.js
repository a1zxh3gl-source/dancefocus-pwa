/*
 * 身份感知型多人物跟踪内核。
 * 检测只回答“哪里有人”；Track ID 由运动/外观关联维护；目标身份再由
 * 固定身份库、深度特征和时空证据确认。任何单一证据都不能改写身份。
 */
(function initIdentityTrackingEngine(global) {
  "use strict";

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const center = (box) => ({ x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 });
  const cosine = (a, b) => {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0; let aa = 0; let bb = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2;
    }
    return dot / (Math.sqrt(aa * bb) || 1);
  };
  const iou = (a, b) => {
    const x1 = Math.max(a[0], b[0]); const y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[0] + a[2], b[0] + b[2]); const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a[2] * a[3] + b[2] * b[3] - intersection;
    return union > 0 ? intersection / union : 0;
  };
  const normalized = (values) => {
    const length = Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0)) || 1;
    return Float32Array.from(values, (value) => value / length);
  };

  // Hungarian 最小代价匹配。通过方阵补齐，可同时处理检测框和轨迹数量不同的情况。
  function hungarian(costs, padCost = 1.25) {
    const rows = costs.length;
    const cols = costs.reduce((max, row) => Math.max(max, row.length), 0);
    const size = Math.max(rows, cols);
    if (!size) return [];
    const matrix = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => (
      row < rows && col < (costs[row]?.length || 0) ? costs[row][col] : padCost
    )));
    const u = new Array(size + 1).fill(0); const v = new Array(size + 1).fill(0);
    const p = new Array(size + 1).fill(0); const way = new Array(size + 1).fill(0);
    for (let row = 1; row <= size; row += 1) {
      p[0] = row;
      let col0 = 0;
      const minv = new Array(size + 1).fill(Infinity);
      const used = new Array(size + 1).fill(false);
      do {
        used[col0] = true;
        const row0 = p[col0];
        let delta = Infinity; let col1 = 0;
        for (let col = 1; col <= size; col += 1) {
          if (used[col]) continue;
          const current = matrix[row0 - 1][col - 1] - u[row0] - v[col];
          if (current < minv[col]) { minv[col] = current; way[col] = col0; }
          if (minv[col] < delta) { delta = minv[col]; col1 = col; }
        }
        for (let col = 0; col <= size; col += 1) {
          if (used[col]) { u[p[col]] += delta; v[col] -= delta; } else minv[col] -= delta;
        }
        col0 = col1;
      } while (p[col0] !== 0);
      do {
        const col1 = way[col0]; p[col0] = p[col1]; col0 = col1;
      } while (col0 !== 0);
    }
    const result = [];
    for (let col = 1; col <= size; col += 1) {
      const row = p[col] - 1;
      if (row >= 0 && row < rows && col - 1 < cols) result.push([row, col - 1]);
    }
    return result;
  }

  class IdentityTrackingEngine {
    constructor(options = {}) {
      this.tf = options.tf || global.tf;
      this.reidModelUrl = options.reidModelUrl || "./reid-model/model.json";
      this.maskModelUrl = options.maskModelUrl || "./bodypix-model/model.json";
      this.maskConfig = options.maskConfig || global.DANCE_MASK_CONFIG || {};
      this.tracks = new Map();
      this.tracklets = [];
      this.nextTrackId = 1;
      this.targetTrackId = null;
      this.targetGallery = { deep: [], appearance: [], head: [], face: [], pose: [] };
      this.reidModel = null;
      this.reidPromise = null;
      this.segmenter = null;
      this.segmenterPromise = null;
      this.bodyPixApi = null;
      this.bodyPixScriptPromise = null;
      this.cropCanvas = document.createElement("canvas");
      this.cropCanvas.width = 224; this.cropCanvas.height = 224;
      this.cropContext = this.cropCanvas.getContext("2d", { willReadFrequently: true });
      this.frameCanvas = document.createElement("canvas");
      this.frameCanvas.width = 24; this.frameCanvas.height = 14;
      this.frameContext = this.frameCanvas.getContext("2d", { willReadFrequently: true });
      this.lastFrameSignature = null;
      this.lastShotTime = -Infinity;
      this.maskHistory = new Map();
      this.targetMaskHistory = null;
      this.maskGeneration = 0;
      this.modelStatus = { detector: "ready", mot: "ready", reid: "loading", face: "adapter", pose: "adapter", mask: "loading" };
    }

    reset() {
      this.tracks.clear(); this.tracklets = []; this.nextTrackId = 1; this.targetTrackId = null;
      this.targetGallery = { deep: [], appearance: [], head: [], face: [], pose: [] };
      this.lastFrameSignature = null; this.lastShotTime = -Infinity;
      this.maskHistory.clear(); this.targetMaskHistory = null;
      this.maskGeneration += 1;
    }

    resetMaskPropagation() {
      this.maskHistory.clear();
      this.targetMaskHistory = null;
      this.maskGeneration += 1;
    }

    async loadReid() {
      if (this.reidModel) return this.reidModel;
      if (this.reidPromise) return this.reidPromise;
      if (!this.tf) throw new Error("TensorFlow.js 未加载");
      this.reidPromise = (async () => {
        await this.tf.ready();
        const classifier = await this.tf.loadLayersModel(this.reidModelUrl);
        const embeddingLayer = classifier.getLayer("global_average_pooling2d_1");
        this.reidModel = this.tf.model({ inputs: classifier.inputs, outputs: embeddingLayer.output });
        this.modelStatus.reid = "ready";
        return this.reidModel;
      })().catch((error) => {
        this.modelStatus.reid = "error"; this.reidPromise = null; throw error;
      });
      return this.reidPromise;
    }

    async loadSegmenter() {
      if (this.segmenter) return this.segmenter;
      if (this.segmenterPromise) return this.segmenterPromise;
      const bodyPixApi = await this.loadBodyPixApi();
      this.segmenterPromise = bodyPixApi.load({
        architecture: "MobileNetV1", outputStride: 16, multiplier: 0.5, quantBytes: 2,
        modelUrl: this.maskModelUrl,
      }).then((model) => {
        this.segmenter = model; this.modelStatus.mask = "ready"; return model;
      }).catch((error) => {
        this.modelStatus.mask = "error"; this.segmenterPromise = null; throw error;
      });
      return this.segmenterPromise;
    }

    async loadBodyPixApi() {
      if (this.bodyPixApi) return this.bodyPixApi;
      const existing = global.bodyPix || global["body-pix"];
      if (existing) { this.bodyPixApi = existing; return existing; }
      if (!this.bodyPixScriptPromise) {
        this.bodyPixScriptPromise = new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "./vendor/body-pix.min.js?v=20260813-2";
          script.onload = () => {
            const api = global.bodyPix || global["body-pix"];
            if (!api) reject(new Error("BodyPix 脚本已加载但没有导出 API"));
            else { this.bodyPixApi = api; resolve(api); }
          };
          script.onerror = () => reject(new Error("BodyPix 脚本加载失败"));
          document.head.append(script);
        }).catch((error) => { this.bodyPixScriptPromise = null; throw error; });
      }
      return this.bodyPixScriptPromise;
    }

    drawPersonCrop(video, bbox, region = "body") {
      const [bx, by, bw, bh] = bbox;
      let y = by; let h = bh;
      if (region === "head") h = bh * 0.34;
      const padding = region === "head" ? 0.12 : 0.08;
      const x = clamp(bx - bw * padding, 0, video.videoWidth);
      y = clamp(y - h * padding, 0, video.videoHeight);
      const w = clamp(bw * (1 + padding * 2), 1, video.videoWidth - x);
      h = clamp(h * (1 + padding * 2), 1, video.videoHeight - y);
      const context = this.cropContext;
      context.fillStyle = "rgb(117,117,117)"; context.fillRect(0, 0, 224, 224);
      const scale = Math.min(214 / w, 214 / h);
      const dw = w * scale; const dh = h * scale;
      context.drawImage(video, x, y, w, h, (224 - dw) / 2, (224 - dh) / 2, dw, dh);
      return this.cropCanvas;
    }

    async deepEmbedding(video, bbox, region = "body") {
      const model = await this.loadReid();
      const canvas = this.drawPersonCrop(video, bbox, region);
      const tensor = this.tf.tidy(() => {
        const pixels = this.tf.browser.fromPixels(canvas).toFloat();
        const input = pixels.div(127.5).sub(1).expandDims(0);
        return model.predict(input).squeeze();
      });
      const values = await tensor.data();
      tensor.dispose();
      return normalized(values);
    }

    async evidence(video, detection) {
      const result = {
        appearance: detection.feature ? Float32Array.from(detection.feature) : null,
        deep: null,
        head: null,
        face: detection.faceEmbedding || null,
        pose: detection.poseEmbedding || null,
      };
      try {
        result.deep = await this.deepEmbedding(video, detection.bbox, "body");
        result.head = await this.deepEmbedding(video, detection.bbox, "head");
      } catch (error) {
        console.warn("Re-ID 特征不可用，保留其他证据并在不确定时停止", error);
      }
      return result;
    }

    addEvidence(evidence, trusted = false) {
      const limits = trusted ? 10 : 6;
      ["deep", "appearance", "head", "face", "pose"].forEach((key) => {
        if (!evidence?.[key]) return;
        const gallery = this.targetGallery[key];
        const tooClose = gallery.some((item) => cosine(item, evidence[key]) > 0.997);
        if (!tooClose) gallery.push(evidence[key]);
        while (gallery.length > limits) gallery.splice(1, 1);
      });
    }

    similarityToGallery(feature, key) {
      const gallery = this.targetGallery[key];
      if (!feature || !gallery.length) return 0;
      const values = gallery.map((item) => cosine(item, feature)).sort((a, b) => b - a);
      return values[0] * 0.74 + (values[1] ?? values[0]) * 0.26;
    }

    frameSignature(video) {
      this.frameContext.drawImage(video, 0, 0, this.frameCanvas.width, this.frameCanvas.height);
      const data = this.frameContext.getImageData(0, 0, this.frameCanvas.width, this.frameCanvas.height).data;
      const signature = new Float32Array(this.frameCanvas.width * this.frameCanvas.height);
      let mean = 0;
      for (let i = 0; i < signature.length; i += 1) {
        const offset = i * 4;
        signature[i] = (data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114) / 255;
        mean += signature[i];
      }
      mean /= signature.length;
      for (let i = 0; i < signature.length; i += 1) signature[i] -= mean;
      return signature;
    }

    detectShotBoundary(video, time) {
      const next = this.frameSignature(video);
      if (!this.lastFrameSignature) { this.lastFrameSignature = next; return false; }
      let difference = 0;
      for (let i = 0; i < next.length; i += 1) difference += Math.abs(next[i] - this.lastFrameSignature[i]);
      difference /= next.length;
      this.lastFrameSignature = next;
      const changed = difference > 0.31 && time - this.lastShotTime > 0.6;
      if (changed) this.lastShotTime = time;
      return changed;
    }

    newTrack(detection, time) {
      const id = this.nextTrackId++;
      const c = center(detection.bbox);
      const track = {
        id, bbox: [...detection.bbox], feature: detection.feature ? Float32Array.from(detection.feature) : null,
        center: c, velocity: { x: 0, y: 0 }, firstSeen: time, lastSeen: time, missed: 0,
        state: "tentative", hits: 1, history: [{ time, bbox: [...detection.bbox] }],
      };
      this.tracks.set(id, track); detection.trackId = id; return track;
    }

    predictTrack(track, time) {
      const delta = clamp(time - track.lastSeen, 0, 1.5);
      return { x: track.center.x + track.velocity.x * delta, y: track.center.y + track.velocity.y * delta };
    }

    associationScore(track, detection, time) {
      const predicted = this.predictTrack(track, time); const detectedCenter = center(detection.bbox);
      const distance = Math.hypot(predicted.x - detectedCenter.x, predicted.y - detectedCenter.y);
      const scale = Math.max(track.bbox[2], track.bbox[3], detection.bbox[2], detection.bbox[3], 24);
      const motion = Math.exp(-distance / (scale * 1.35));
      const overlap = iou(track.bbox, detection.bbox);
      const appearance = cosine(track.feature, detection.feature);
      const size = Math.min(track.bbox[2] * track.bbox[3], detection.bbox[2] * detection.bbox[3])
        / Math.max(track.bbox[2] * track.bbox[3], detection.bbox[2] * detection.bbox[3]);
      return motion * 0.38 + overlap * 0.29 + Math.max(0, appearance) * 0.27 + size * 0.06;
    }

    updateTracks(detections, time, shotChanged = false) {
      if (shotChanged) {
        this.tracks.forEach((track) => this.finishTracklet(track, "shot-boundary"));
        this.tracks.clear(); this.targetTrackId = null;
        // 镜头切换后不能继续传播上一镜的人物轮廓，但目标身份特征库仍保留用于 Re-ID。
        this.maskHistory.clear(); this.targetMaskHistory = null;
        this.maskGeneration += 1;
      }
      const tracks = [...this.tracks.values()].filter((track) => time - track.lastSeen <= 2.4);
      const costs = tracks.map((track) => detections.map((detection) => 1 - this.associationScore(track, detection, time)));
      const matchedTracks = new Set(); const matchedDetections = new Set();
      hungarian(costs).forEach(([trackIndex, detectionIndex]) => {
        const track = tracks[trackIndex]; const detection = detections[detectionIndex];
        const score = 1 - costs[trackIndex][detectionIndex];
        if (!track || !detection || score < 0.34) return;
        const nextCenter = center(detection.bbox); const delta = Math.max(0.04, time - track.lastSeen);
        const measured = { x: (nextCenter.x - track.center.x) / delta, y: (nextCenter.y - track.center.y) / delta };
        track.velocity.x = track.velocity.x * 0.68 + measured.x * 0.32;
        track.velocity.y = track.velocity.y * 0.68 + measured.y * 0.32;
        track.center = nextCenter; track.bbox = [...detection.bbox]; track.lastSeen = time;
        track.feature = track.feature && detection.feature
          ? normalized(track.feature.map((value, i) => value * 0.84 + detection.feature[i] * 0.16))
          : detection.feature;
        track.missed = 0; track.hits += 1; track.state = track.hits >= 3 ? "confirmed" : track.state;
        track.history.push({ time, bbox: [...detection.bbox] });
        detection.trackId = track.id; detection.trackScore = score;
        matchedTracks.add(track.id); matchedDetections.add(detectionIndex);
      });
      tracks.forEach((track) => {
        if (matchedTracks.has(track.id)) return;
        track.missed += 1;
        if (time - track.lastSeen > 2.4 || track.missed > 12) {
          this.finishTracklet(track, "lost"); this.tracks.delete(track.id);
        }
      });
      detections.forEach((detection, index) => { if (!matchedDetections.has(index)) this.newTrack(detection, time); });
      return detections;
    }

    finishTracklet(track, reason) {
      if (!track?.history?.length) return;
      this.tracklets.push({
        id: track.id, start: track.firstSeen, end: track.lastSeen, reason,
        feature: track.feature, boxes: track.history.slice(), target: track.id === this.targetTrackId,
      });
    }

    async initializeTarget(video, detections, selected, time) {
      this.reset();
      this.updateTracks(detections, time, false);
      const evidence = await this.evidence(video, selected);
      this.targetTrackId = selected.trackId;
      this.addEvidence(evidence, true);
      return { trackId: this.targetTrackId, evidence };
    }

    async adoptTarget(video, detections, selected, time) {
      this.updateTracks(detections, time, false);
      const evidence = await this.evidence(video, selected);
      this.targetTrackId = selected.trackId;
      this.addEvidence(evidence, true);
      return { trackId: this.targetTrackId, evidence };
    }

    async resolveTarget(video, detections, time) {
      const shotChanged = this.detectShotBoundary(video, time);
      this.updateTracks(detections, time, shotChanged);
      if (!detections.length) return { confident: false, reason: "no-detection", shotChanged };
      const targetTrack = this.targetTrackId == null ? null : this.tracks.get(this.targetTrackId);
      const targetPrediction = targetTrack ? this.predictTrack(targetTrack, time) : null;
      const candidates = detections.map((person) => {
        const c = center(person.bbox);
        const distance = targetPrediction ? Math.hypot(c.x - targetPrediction.x, c.y - targetPrediction.y) : Infinity;
        const scale = targetTrack ? Math.max(targetTrack.bbox[2], targetTrack.bbox[3], 24) : 100;
        const temporal = person.trackId === this.targetTrackId ? 1 : Math.exp(-distance / (scale * 1.5));
        const appearance = this.similarityToGallery(person.feature, "appearance");
        return { person, temporal, appearance, preScore: temporal * 0.58 + Math.max(0, appearance) * 0.42 };
      }).sort((a, b) => b.preScore - a.preScore);

      // 交叉/遮挡时对最可能的多个人都做深度身份比较，不能只验证当前位置最近的人。
      const shortlist = candidates.slice(0, Math.min(4, candidates.length));
      for (const candidate of shortlist) {
        candidate.evidence = await this.evidence(video, candidate.person);
        candidate.deep = this.similarityToGallery(candidate.evidence.deep, "deep");
        candidate.head = this.similarityToGallery(candidate.evidence.head, "head");
        candidate.face = this.similarityToGallery(candidate.evidence.face, "face");
        candidate.pose = this.similarityToGallery(candidate.evidence.pose, "pose");
        const hasFace = this.targetGallery.face.length && candidate.evidence.face;
        const hasPose = this.targetGallery.pose.length && candidate.evidence.pose;
        const weights = hasFace
          ? { deep: .39, head: .16, appearance: .08, temporal: .14, face: .19, pose: .04 }
          : hasPose
            ? { deep: .48, head: .18, appearance: .09, temporal: .15, face: 0, pose: .10 }
            : { deep: .56, head: .20, appearance: .09, temporal: .15, face: 0, pose: 0 };
        candidate.identityScore = candidate.deep * weights.deep + candidate.head * weights.head
          + candidate.appearance * weights.appearance + candidate.temporal * weights.temporal
          + candidate.face * weights.face + candidate.pose * weights.pose;
      }
      shortlist.sort((a, b) => b.identityScore - a.identityScore);
      const best = shortlist[0]; const second = shortlist[1];
      const margin = best && second ? best.identityScore - second.identityScore : 1;
      const sameTrack = best?.person.trackId === this.targetTrackId;
      const reidStrong = best && best.deep >= 0.68 && best.head >= 0.60;
      const clearWinner = margin >= 0.028 || (sameTrack && best.temporal >= 0.82 && margin >= 0.012);
      const confident = Boolean(best && reidStrong && best.identityScore >= (sameTrack ? 0.67 : 0.72) && clearWinner);
      if (!confident) {
        return { confident: false, reason: shotChanged ? "shot-change-unresolved" : "identity-ambiguous", shotChanged, ranked: shortlist };
      }
      if (!sameTrack) this.targetTrackId = best.person.trackId;
      if (best.identityScore > 0.79 && margin > 0.045) this.addEvidence(best.evidence, false);
      best.person.identityScore = best.identityScore;
      return { confident: true, target: best.person, evidence: best.evidence, score: best.identityScore, margin, shotChanged, ranked: shortlist };
    }

    async instanceMasks(video, trackedPeople = [], targetTrackId = null, targetBox = null, options = {}) {
      const segmenter = await this.loadSegmenter();
      const people = await segmenter.segmentMultiPerson(video, {
        flipHorizontal: false,
        // 预览改为播放前离线扫描，可以使用 medium 输入；不再在播放主线程中反复推理。
        // 这对画面边缘、小人物和靠得较近的舞者比 low 模式稳定很多。
        internalResolution: options.exportQuality ? "high" : "medium",
        segmentationThreshold: options.segmentationThreshold ?? (options.previewQuality ? 0.45 : 0.56),
        maxDetections: 30, scoreThreshold: options.previewQuality ? 0.04 : 0.10, nmsRadius: 14,
      });
      const time = Number.isFinite(options.time) ? options.time : Number(video.currentTime || 0);
      const records = (people || []).map((person) => ({
        person,
        bbox: this.maskBounds(person, video.videoWidth, video.videoHeight),
        trackId: null,
        matchIou: 0,
      })).filter((item) => item.bbox);

      // 把每个像素轮廓与当前帧 MOT Track ID 做一对一匹配，避免仅按“最近矩形”反复换人。
      if (trackedPeople.length) {
        const costs = records.map((record) => trackedPeople.map((tracked) => 1 - iou(record.bbox, tracked.bbox)));
        hungarian(costs).forEach(([maskIndex, personIndex]) => {
          const overlap = iou(records[maskIndex].bbox, trackedPeople[personIndex].bbox);
          // 交叉时低 IoU 对应不可以继承 Track ID，否则会把旁人的实例 Mask
          // 绑定给目标身份。未能可靠匹配的 Mask 保持无 ID，但仍默认打码。
          if (overlap >= 0.18) {
            records[maskIndex].trackId = trackedPeople[personIndex].trackId ?? null;
            records[maskIndex].matchIou = overlap;
          }
        });
      }

      let targetIndex = targetTrackId == null ? -1 : records.findIndex((record) => record.trackId === targetTrackId);
      let targetBindingScore = targetIndex >= 0 ? records[targetIndex].matchIou : 0;
      // Track ID 命中仍要与当前目标轨迹框交叉验证。这可以拦截“检测框 Track ID 已串人，
      // 分割 Mask 又正确贴合了那个错误框”的二次错误绑定。
      if (targetIndex >= 0 && targetBox) {
        const trajectoryOverlap = iou(records[targetIndex].bbox, targetBox);
        if (trajectoryOverlap < .28) targetIndex = -1;
        else targetBindingScore = Math.min(targetBindingScore || trajectoryOverlap, trajectoryOverlap);
      }
      if (targetIndex < 0 && targetBox && options.allowTargetBoxMatch !== false) {
        let bestOverlap = 0; let secondOverlap = 0;
        records.forEach((record, index) => {
          const overlap = iou(targetBox, record.bbox);
          if (overlap > bestOverlap) {
            secondOverlap = bestOverlap; bestOverlap = overlap; targetIndex = index;
          } else if (overlap > secondOverlap) secondOverlap = overlap;
        });
        // Track ID 没对上时只接受明显重合且与第二候选有间隔的轮廓；
        // 两人交叉/拥抱时宁可进入 uncertain，也不静默换一个人作为保护目标。
        if (bestOverlap < 0.34 || bestOverlap - secondOverlap < 0.11) targetIndex = -1;
        else targetBindingScore = bestOverlap;
      }
      const compactWidth = options.exportQuality ? 256 : options.previewQuality ? 160 : 192;
      const outputMasks = records.map((record, index) => {
        const currentMask = this.compactMask(record.person, video.videoWidth, video.videoHeight, compactWidth);
        const stableMask = record.trackId == null
          ? currentMask
          : this.stabilizeTrackedMask(record.trackId, currentMask, record.bbox, time, this.maskGeneration);
        if (index === targetIndex) {
          this.targetMaskHistory = {
            mask: stableMask, bbox: [...record.bbox], time,
            trackId: targetTrackId, generation: this.maskGeneration,
          };
        }
        return {
          bbox: record.bbox,
          trackId: record.trackId,
          isTarget: index === targetIndex,
          propagated: false,
          mask: stableMask,
        };
      });

      // 人物短暂漏分割时，在有效时限内将该 Track ID 的历史轮廓按新框传播，
      // 不使用矩形作为模糊区域，也不让轮廓在单帧漏检时立刻闪烁消失。
      const representedTrackIds = new Set(outputMasks.map((item) => item.trackId).filter((id) => id != null));
      trackedPeople.forEach((tracked) => {
        if (tracked.trackId == null || tracked.trackId === targetTrackId || representedTrackIds.has(tracked.trackId)) return;
        const history = this.maskHistory.get(tracked.trackId);
        if (!history || history.generation !== this.maskGeneration
          || history.mask.width !== compactWidth || time - history.time > .48) return;
        outputMasks.push({
          bbox: [...tracked.bbox], trackId: tracked.trackId, isTarget: false, propagated: true,
          mask: this.warpCompactMask(history.mask, history.bbox, tracked.bbox),
        });
      });

      let protectionMask = targetIndex >= 0 ? outputMasks[targetIndex]?.mask : null;
      let protectionIsHistorical = false;
      if (!protectionMask && targetBox && this.targetMaskHistory
        && this.targetMaskHistory.trackId === targetTrackId
        && this.targetMaskHistory.generation === this.maskGeneration
        && this.targetMaskHistory.mask.width === compactWidth && time - this.targetMaskHistory.time <= .60) {
        protectionMask = this.warpCompactMask(this.targetMaskHistory.mask, this.targetMaskHistory.bbox, targetBox);
        protectionIsHistorical = true;
      }
      const targetMaskBounds = protectionMask
        ? this.maskBounds(protectionMask, video.videoWidth, video.videoHeight)
        : null;
      let targetMaskIncomplete = false;
      let targetMaskMerged = false;
      if (targetMaskBounds && targetBox) {
        const targetBottom = targetBox[1] + targetBox[3];
        const maskBottom = targetMaskBounds[1] + targetMaskBounds[3];
        const verticalStart = Math.max(targetMaskBounds[1], targetBox[1]);
        const verticalEnd = Math.min(maskBottom, targetBottom);
        const verticalCoverage = Math.max(0, verticalEnd - verticalStart) / Math.max(1, targetBox[3]);
        const widthRatio = targetMaskBounds[2] / Math.max(1, targetBox[2]);
        const areaRatio = targetMaskBounds[2] * targetMaskBounds[3] / Math.max(1, targetBox[2] * targetBox[3]);
        // 保护轮廓只有上半身时不允许继续打码；宁可该帧不模糊旁人，也不能覆盖目标躯干和腿。
        targetMaskIncomplete = verticalCoverage < .68 || maskBottom < targetBottom - targetBox[3] * .18;
        // 轮廓明显大于目标框时记录为可能的实例合并，交叉帧优先保护目标可见像素。
        targetMaskMerged = widthRatio > 1.85 || areaRatio > 2.45;
      } else if (targetBox) targetMaskIncomplete = true;
      // 当前帧整体漏分割时，仅在有效窗口内传播已知轨迹的像素轮廓。
      // 新人不会被假定成目标，下一次分割会自动将其加入模糊对象。
      if (!records.length) {
        trackedPeople.forEach((tracked) => {
          if (tracked.trackId == null || outputMasks.some((item) => item.trackId === tracked.trackId)) return;
          const history = this.maskHistory.get(tracked.trackId);
          if (!history || history.generation !== this.maskGeneration
            || history.mask.width !== compactWidth || time - history.time > .48) return;
          outputMasks.push({
            bbox: [...tracked.bbox], trackId: tracked.trackId,
            isTarget: tracked.trackId === targetTrackId, propagated: true,
            mask: this.warpCompactMask(history.mask, history.bbox, tracked.bbox),
          });
        });
      }
      // 目标轮廓无法确认时返回 uncertain；合成层将保护用户本人，不会静默改换保护对象。
      return {
        frameWidth: video.videoWidth,
        frameHeight: video.videoHeight,
        targetTrackId,
        targetResolved: targetIndex >= 0,
        identityState: targetIndex >= 0 && !targetMaskIncomplete ? "confirmed" : protectionMask ? "propagated" : "uncertain",
        targetBindingScore,
        targetMaskIncomplete,
        targetMaskMerged,
        occlusionUncertain: targetIndex < 0 || targetMaskIncomplete || targetMaskMerged
          || targetBindingScore < Number(this.maskConfig.occlusion_confidence_threshold ?? .62),
        protectionIsHistorical,
        safeToApply: Boolean(protectionMask) && !targetMaskIncomplete,
        protectionMask,
        protectionBox: targetIndex >= 0 ? records[targetIndex]?.bbox : targetBox,
        masks: outputMasks,
      };
    }

    async targetMask(video, targetBox) {
      const result = await this.instanceMasks(video, [], null, targetBox);
      return result?.masks.find((item) => item.isTarget)?.mask || null;
    }

    maskBounds(mask, videoWidth, videoHeight) {
      const { data, width, height } = mask;
      if (!data || !width || !height) return null;
      let minX = width; let minY = height; let maxX = -1; let maxY = -1;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          if (!data[y * width + x]) continue;
          minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
      }
      return maxX < minX ? null : [
        minX / width * videoWidth, minY / height * videoHeight,
        (maxX - minX + 1) / width * videoWidth, (maxY - minY + 1) / height * videoHeight,
      ];
    }

    compactMask(mask, videoWidth, videoHeight, outputWidth = 192) {
      const width = outputWidth; const height = Math.max(72, Math.round(width * videoHeight / videoWidth));
      const data = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1) {
        const sourceY = Math.min(mask.height - 1, Math.floor(y / height * mask.height));
        for (let x = 0; x < width; x += 1) {
          const sourceX = Math.min(mask.width - 1, Math.floor(x / width * mask.width));
          data[y * width + x] = mask.data[sourceY * mask.width + sourceX] ? 255 : 0;
        }
      }
      return { width, height, frameWidth: videoWidth, frameHeight: videoHeight, data };
    }

    stabilizeTrackedMask(trackId, currentMask, bbox, time, generation = this.maskGeneration) {
      const history = this.maskHistory.get(trackId);
      if (!history || history.mask.width !== currentMask.width || history.mask.height !== currentMask.height
        || history.generation !== generation || time < history.time
        || time - history.time > Number(this.maskConfig.mask_temporal_smoothing ?? .42)) {
        this.maskHistory.set(trackId, { mask: currentMask, bbox: [...bbox], time, generation });
        return currentMask;
      }
      const previous = this.warpCompactMask(history.mask, history.bbox, bbox);
      const data = new Uint8Array(currentMask.data.length);
      for (let index = 0; index < data.length; index += 1) {
        const current = currentMask.data[index];
        const historical = previous.data[index];
        // 当前轮廓优先，历史轮廓只对快速动作中的小腿、手臂、头发等短暂漏分割做有限补全。
        data[index] = current || historical > 200 ? 255 : 0;
      }
      const stable = { ...currentMask, data };
      this.maskHistory.set(trackId, { mask: stable, bbox: [...bbox], time, generation });
      return stable;
    }

    warpCompactMask(mask, fromBox, toBox) {
      if (!mask || !fromBox || !toBox) return mask;
      const { width, height } = mask;
      const data = new Uint8Array(width * height);
      const frameWidth = mask.frameWidth || width;
      const frameHeight = mask.frameHeight || height;
      const from = [fromBox[0] / frameWidth * width, fromBox[1] / frameHeight * height, fromBox[2] / frameWidth * width, fromBox[3] / frameHeight * height];
      const to = [toBox[0] / frameWidth * width, toBox[1] / frameHeight * height, toBox[2] / frameWidth * width, toBox[3] / frameHeight * height];
      const minX = clamp(Math.floor(to[0] - 2), 0, width - 1); const maxX = clamp(Math.ceil(to[0] + to[2] + 2), 0, width);
      const minY = clamp(Math.floor(to[1] - 2), 0, height - 1); const maxY = clamp(Math.ceil(to[1] + to[3] + 2), 0, height);
      for (let y = minY; y < maxY; y += 1) {
        const normalizedY = (y - to[1]) / Math.max(1, to[3]);
        const sourceY = Math.round(from[1] + normalizedY * from[3]);
        if (sourceY < 0 || sourceY >= height) continue;
        for (let x = minX; x < maxX; x += 1) {
          const normalizedX = (x - to[0]) / Math.max(1, to[2]);
          const sourceX = Math.round(from[0] + normalizedX * from[2]);
          if (sourceX < 0 || sourceX >= width) continue;
          data[y * width + x] = mask.data[sourceY * width + sourceX];
        }
      }
      return { ...mask, data };
    }
  }

  global.IdentityTrackingEngine = IdentityTrackingEngine;
  global.TrackingMath = { cosine, iou, hungarian };
})(window);

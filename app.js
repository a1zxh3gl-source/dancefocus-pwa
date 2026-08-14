const FRAME_STEP = 1 / 30;
const TRACK_STEP = 0.24;
const PERSON_SCORE = 0.16;

const state = {
  page: 1,
  history: [],
  objectUrl: null,
  sourceFile: null,
  fileName: "",
  sourceBytes: 0,
  sourceBitrate: 0,
  duration: 0,
  trimStart: 0,
  trimEnd: 0,
  currentTime: 0,
  model: null,
  modelPromise: null,
  trackingEngine: null,
  identityReady: false,
  selectedPrediction: null,
  targetFeature: null,
  targetAnchorFeature: null,
  currentPredictions: [],
  segments: [],
  samples: [],
  interruptAt: null,
  processedUntil: 0,
  analysisAbort: false,
  complete: false,
  projectMode: "undecided",
  ratio: "9:16",
  ratioClass: "ratio-9-16",
  zoom: 180,
  blurOthers: false,
  blurEffect: "mosaic",
  blurStrength: 18,
  maskDilation: Number(window.DANCE_MASK_CONFIG?.others_mask_dilation ?? 5),
  maskFeather: Number(window.DANCE_MASK_CONFIG?.mask_feather_radius ?? 3),
  maskDebugFrames: [],
  exporting: false,
  lastPreviewCenter: null,
  maskRequested: false,
  maskBusy: false,
  maskPromise: null,
  maskLastTime: -Infinity,
  previewMaskFrame: null,
  previewMaskCache: [],
  derivedPreviewMaskFrame: null,
  derivedMaskKey: "",
  lastPreviewPaintAt: 0,
  maskPreparationId: 0,
  maskPreparationPromise: null,
  previewMasksReady: false,
  previewHasOtherPeopleMasks: false,
  previewMaskProgress: 0,
  maskUncertainTimes: [],
  exportMaskCache: [],
  musicEngine: null,
  audioAlignment: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const secs = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
}

function showToast(message, duration = 2400) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), duration);
}

function getMusicEngine() {
  if (!state.musicEngine) {
    if (!window.ReferenceMusicEngine) throw new Error("参考音乐引擎未加载");
    state.musicEngine = new window.ReferenceMusicEngine({
      onProgress: ({ progress, message }) => {
        const percent = Math.round(progress * 100);
        $("#audioAnalysisStatus").hidden = false;
        $("#audioAnalysisText").textContent = message || "正在处理音频…";
        $("#audioAnalysisPercent").textContent = `${percent}%`;
        $("#audioAnalysisProgress").style.width = `${percent}%`;
      },
    });
  }
  return state.musicEngine;
}

function showPage(page, push = true) {
  const next = Number(page);
  if (!Number.isInteger(next) || next < 1 || next > 6) return;
  if (push && next !== state.page) state.history.push(state.page);
  state.page = next;
  $$(".screen").forEach((screen) => screen.classList.toggle("active", Number(screen.dataset.page) === next));
  window.scrollTo({ top: 0, behavior: "instant" });
  $$("video").forEach((video) => {
    if (!video.closest(".active")) video.pause();
  });
  if (next === 5) prepareEditPage();
}

$$('[data-back]').forEach((button) => button.addEventListener("click", () => {
  state.analysisAbort = true;
  const previous = state.history.pop() ?? Math.max(1, state.page - 1);
  showPage(previous, false);
}));

window.addEventListener("beforeunload", () => {
  state.analysisAbort = true;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.musicEngine?.dispose();
});

$("#privacyButton").addEventListener("click", () => showToast("视频只通过浏览器临时地址读取，刷新页面后即清空。", 3600));
$("#importButton").addEventListener("click", () => $("#videoPicker").click());
$("#videoPicker").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  $("#importButton b").textContent = "正在打开视频…";
  $("#importButton").disabled = true;
  await openLocalVideo(file);
  $("#importButton b").textContent = "选择课堂视频";
  $("#importButton").disabled = false;
  // 允许 iPhone 连续选择同一个视频也能再次触发 change。
  event.target.value = "";
});

async function openLocalVideo(file) {
  if (file.type && !file.type.startsWith("video/")) {
    showToast("请选择 MP4、MOV 等视频文件");
    return;
  }
  state.analysisAbort = true;
  const previousUrl = state.objectUrl;
  const nextUrl = URL.createObjectURL(file);
  state.objectUrl = nextUrl;
  state.fileName = file.name || "手机视频";
  // iOS 同时给多个 video 元素设置同一个大 Blob，会建立多个解码器并很容易失败。
  // 先进入已挂载的裁剪页面，只让一个 video 读取；其他页面使用时再懒加载。
  showPage(2);
  $("#videoOpening").classList.remove("hidden");
  const primaryVideo = $("#trimVideo");
  $$('[data-source-video]').forEach((video) => clearVideoSource(video));
  attachVideoSource(primaryVideo);
  try {
    await waitForVideoMetadata(primaryVideo, 45000);
  } catch (error) {
    console.error(error);
    URL.revokeObjectURL(nextUrl);
    state.objectUrl = previousUrl;
    $("#videoOpening").classList.add("hidden");
    showPage(1, false);
    const code = primaryVideo.error?.code ? `（解码错误 ${primaryVideo.error.code}）` : "";
    showToast(`这个视频的编码无法在当前手机浏览器解码${code}，可在“照片”中另存为兼容视频后重选`, 6200);
    return;
  }
  state.duration = Number.isFinite(primaryVideo.duration) ? primaryVideo.duration : 0;
  if (!state.duration) {
    showToast("无法读取视频时长");
    showPage(1, false);
    return;
  }
  if (previousUrl) URL.revokeObjectURL(previousUrl);
  state.sourceBytes = Number(file.size) || 0;
  state.sourceBitrate = state.duration > 0 ? state.sourceBytes * 8 / state.duration : 0;
  state.sourceFile = file;
  resetProjectState();
  updateDurationUI();
  $("#videoOpening").classList.add("hidden");
  showToast(`已在本地打开 ${file.name}`);
  loadModel().catch(() => {});
  getTrackingEngine().loadReid().catch((error) => console.warn("Re-ID 模型稍后重试", error));
}

function clearVideoSource(video) {
  video.pause();
  video.removeAttribute("src");
  video.dataset.objectUrl = "";
  video.load();
}

function attachVideoSource(video) {
  if (!state.objectUrl) throw new Error("尚未选择视频");
  if (video.dataset.objectUrl === state.objectUrl && video.src) return;
  video.pause();
  video.muted = false;
  video.volume = 1;
  video.src = state.objectUrl;
  video.dataset.objectUrl = state.objectUrl;
  video.load();
}

async function ensureVideoSource(video) {
  attachVideoSource(video);
  await waitForVideoMetadata(video, 45000);
}

function getTrackingEngine() {
  if (!state.trackingEngine) {
    if (!window.IdentityTrackingEngine) throw new Error("身份跟踪引擎未加载");
    state.trackingEngine = new window.IdentityTrackingEngine({
      tf: window.tf,
      reidModelUrl: "./reid-model/model.json",
      maskModelUrl: "./bodypix-model/model.json",
      maskConfig: window.DANCE_MASK_CONFIG,
    });
  }
  return state.trackingEngine;
}

function resetProjectState() {
  state.trimStart = 0;
  state.trimEnd = state.duration;
  state.currentTime = 0;
  state.selectedPrediction = null;
  state.targetFeature = null;
  state.targetAnchorFeature = null;
  state.currentPredictions = [];
  state.segments = [];
  state.samples = [];
  state.interruptAt = null;
  state.processedUntil = 0;
  state.analysisAbort = false;
  state.complete = false;
  state.projectMode = "undecided";
  state.zoom = 180;
  state.blurOthers = false;
  state.blurEffect = "mosaic";
  state.blurStrength = 18;
  state.maskDilation = Number(window.DANCE_MASK_CONFIG?.others_mask_dilation ?? 5);
  state.maskFeather = Number(window.DANCE_MASK_CONFIG?.mask_feather_radius ?? 3);
  state.maskDebugFrames = [];
  state.exporting = false;
  state.lastPreviewCenter = null;
  state.maskRequested = false;
  state.maskBusy = false;
  state.maskPromise = null;
  state.maskLastTime = -Infinity;
  state.previewMaskFrame = null;
  state.previewMaskCache = [];
  state.derivedPreviewMaskFrame = null;
  state.derivedMaskKey = "";
  state.lastPreviewPaintAt = 0;
  state.maskPreparationId += 1;
  state.maskPreparationPromise = null;
  state.previewMasksReady = false;
  state.previewHasOtherPeopleMasks = false;
  state.previewMaskProgress = 0;
  state.maskUncertainTimes = [];
  state.exportMaskCache = [];
  state.identityReady = false;
  state.audioAlignment = null;
  if (state.musicEngine) state.musicEngine.reset();
  resetAudioUI();
  getTrackingEngine().reset();
}

function clearTrackingState() {
  state.analysisAbort = true;
  state.selectedPrediction = null;
  state.targetFeature = null;
  state.targetAnchorFeature = null;
  state.currentPredictions = [];
  state.segments = [];
  state.samples = [];
  state.interruptAt = null;
  state.processedUntil = 0;
  state.complete = false;
  state.projectMode = "undecided";
  state.identityReady = false;
  state.lastPreviewCenter = null;
  state.previewMaskFrame = null;
  state.previewMaskCache = [];
  state.derivedPreviewMaskFrame = null;
  state.derivedMaskKey = "";
  state.maskPreparationId += 1;
  state.maskPreparationPromise = null;
  state.previewMasksReady = false;
  state.previewHasOtherPeopleMasks = false;
  state.previewMaskProgress = 0;
  state.maskPromise = null;
  state.maskLastTime = -Infinity;
  state.maskUncertainTimes = [];
  state.exportMaskCache = [];
  getTrackingEngine().reset();
  renderTrackSegments();
}

function waitForVideoMetadata(video, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled || !Number.isFinite(video.duration) || video.duration <= 0) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(video.error || new Error("视频读取失败"));
    };
    const timer = window.setTimeout(fail, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("durationchange", finish);
      video.removeEventListener("canplay", finish);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("loadedmetadata", finish);
    video.addEventListener("durationchange", finish);
    video.addEventListener("canplay", finish);
    video.addEventListener("error", fail, { once: true });
  });
}

function updateDurationUI() {
  const duration = state.duration;
  const text = formatTime(duration);
  ["#trimEnd", "#trimStart", "#selectScrubber", "#previewScrubber"].forEach((selector) => {
    $(selector).max = duration.toFixed(3);
  });
  $("#trimEnd").value = duration;
  $("#selectDurationText").textContent = text;
  $("#editDurationText").textContent = text;
  $("#previewDurationText").textContent = text;
  renderTrimUI();
}

function waitForEvent(target, success, failure) {
  return new Promise((resolve, reject) => {
    if (success === "loadeddata" && target.readyState >= 2) return resolve();
    const done = () => { cleanup(); resolve(); };
    const fail = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      target.removeEventListener(success, done);
      if (failure) target.removeEventListener(failure, fail);
    };
    target.addEventListener(success, done, { once: true });
    if (failure) target.addEventListener(failure, fail, { once: true });
  });
}

async function seekVideo(video, time) {
  await ensureVideoSource(video);
  const safe = clamp(time, 0, Math.max(0, state.duration - 0.002));
  video.pause();
  // 尤其在 iOS 上，只加载元数据的本地视频不一定触发 loadeddata。
  // 先主动定位到目标时间，然后等 seeked / loadeddata 任意一个即可。
  if (Math.abs(video.currentTime - safe) < 0.004 && video.readyState >= 2) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      video.removeEventListener("seeked", finish);
      video.removeEventListener("loadeddata", finish);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("seeked", finish, { once: true });
    video.addEventListener("loadeddata", finish, { once: true });
    video.addEventListener("error", fail, { once: true });
    video.currentTime = safe;
    if (video.readyState >= 2) finish();
  });
}

function toggleVideo(video, button, end = state.trimEnd) {
  if (video.paused) {
    if (video.currentTime < state.trimStart || video.currentTime >= end) video.currentTime = state.trimStart;
    video.muted = false;
    video.volume = 1;
    video.play().catch(() => showToast("请再点一次播放"));
    button.textContent = "Ⅱ";
  } else {
    video.pause();
    button.textContent = "▶";
  }
}

// 第 2 页：裁剪首尾
$("#trimPlay").addEventListener("click", () => toggleVideo($("#trimVideo"), $("#trimPlay")));
$("#trimVideo").addEventListener("timeupdate", () => {
  if ($("#trimVideo").currentTime >= state.trimEnd) {
    $("#trimVideo").pause();
    $("#trimPlay").textContent = "▶";
  }
  const percent = state.duration ? ($("#trimVideo").currentTime / state.duration) * 100 : 0;
  $("#trimLine").style.left = `${percent}%`;
});
$("#trimStart").addEventListener("input", (event) => {
  state.trimStart = Math.min(Number(event.target.value), state.trimEnd - .4);
  event.target.value = state.trimStart;
  $("#trimVideo").currentTime = state.trimStart;
  renderTrimUI();
});
$("#trimEnd").addEventListener("input", (event) => {
  state.trimEnd = Math.max(Number(event.target.value), state.trimStart + .4);
  event.target.value = state.trimEnd;
  $("#trimVideo").currentTime = Math.max(state.trimStart, state.trimEnd - .04);
  renderTrimUI();
});

function renderTrimUI() {
  $("#trimStart").value = state.trimStart;
  $("#trimEnd").value = state.trimEnd;
  $("#trimStartText").textContent = formatTime(state.trimStart);
  $("#trimEndText").textContent = formatTime(state.trimEnd);
  $("#trimRangeText").textContent = `${formatTime(state.trimStart)} — ${formatTime(state.trimEnd)}`;
  $("#trimLengthText").textContent = `${Math.max(0, state.trimEnd - state.trimStart).toFixed(2)}s`;
  const startPercent = state.duration ? (state.trimStart / state.duration) * 100 : 0;
  const endPercent = state.duration ? (state.trimEnd / state.duration) * 100 : 100;
  $("#trimMaskLeft").style.width = `${startPercent}%`;
  $("#trimMaskRight").style.width = `${100 - endPercent}%`;
}

$("#trimContinue").addEventListener("click", async () => {
  state.currentTime = state.trimStart;
  state.segments = [];
  state.samples = [];
  state.complete = false;
  showPage(3);
  await prepareSelectionFrame(state.trimStart);
});

// 本地多人检测：COCO-SSD 全画面 + 宽画面分区，再做 NMS 去重。
async function loadModel() {
  if (state.model) return state.model;
  if (state.modelPromise) return state.modelPromise;
  if (!window.cocoSsd || !window.tf) throw new Error("AI 程序未加载");
  state.modelPromise = (async () => {
    await window.tf.ready();
    state.model = await window.cocoSsd.load({ base: "lite_mobilenet_v2", modelUrl: "./model/model.json" });
    return state.model;
  })().catch((error) => {
    state.modelPromise = null;
    throw error;
  });
  return state.modelPromise;
}

async function prepareSelectionFrame(time) {
  const video = $("#selectVideo");
  state.selectedPrediction = null;
  updateSelectionButton();
  $("#modelLoader").classList.remove("hidden");
  $("#selectBoxes").innerHTML = "";
  $("#selectScrubber").min = state.trimStart;
  $("#selectScrubber").max = state.trimEnd;
  $("#selectScrubber").value = time;
  $("#selectTimeText").textContent = formatTime(time);
  try {
    await seekVideo(video, time);
    await loadModel();
    const predictions = await detectPeople(video, { detailed: true });
    if (state.page !== 3) return;
    state.currentTime = time;
    state.currentPredictions = predictions;
    renderPersonBoxes($("#selectStage"), $("#selectBoxes"), video, predictions, onInitialPersonSelected);
    setSelectionStatus(predictions.length);
  } catch (error) {
    console.error(error);
    $("#selectionStatus b").textContent = "本地识别启动失败";
    $("#selectionStatus small").textContent = "请刷新页面后重试，或更换浏览器";
    showToast("本地 AI 模型未能加载", 4000);
  } finally {
    $("#modelLoader").classList.add("hidden");
  }
}

function setSelectionStatus(count) {
  const dot = $(".status-dot", $("#selectionStatus"));
  dot.className = "status-dot ready";
  if (count) {
    $("#selectionStatus b").textContent = `已区分 ${count} 位人物，请点选你自己`;
    $("#selectionStatus small").textContent = "每个框都是独立人物；选中后才能开始跟踪";
  } else {
    $("#selectionStatus b").textContent = "这一帧没有找到清晰人物";
    $("#selectionStatus small").textContent = "点“下一帧”或拖动进度条向后找框";
  }
}

const tileCanvas = document.createElement("canvas");
const tileContext = tileCanvas.getContext("2d", { willReadFrequently: true });

async function detectPeople(video, { detailed = false, focusBox = null } = {}) {
  const model = await loadModel();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return [];
  const full = await model.detect(video, 30, PERSON_SCORE);
  let people = full.filter((item) => item.class === "person").map((item) => ({ bbox: [...item.bbox], score: item.score }));
  const regions = [];
  if (detailed && vw / vh > 1.25) {
    const width = vw * .52;
    regions.push([0, 0, width, vh], [vw * .24, 0, width, vh], [vw - width, 0, width, vh]);
  } else if (focusBox) {
    const [x, y, w, h] = focusBox;
    const regionW = Math.min(vw, Math.max(w * 4.2, vw * .42));
    const regionH = Math.min(vh, Math.max(h * 2.2, vh * .78));
    regions.push([
      clamp(x + w / 2 - regionW / 2, 0, vw - regionW),
      clamp(y + h / 2 - regionH / 2, 0, vh - regionH),
      regionW,
      regionH,
    ]);
  }
  for (const region of regions) {
    const [rx, ry, rw, rh] = region;
    tileCanvas.width = 480;
    tileCanvas.height = Math.max(320, Math.round(480 * rh / rw));
    tileContext.drawImage(video, rx, ry, rw, rh, 0, 0, tileCanvas.width, tileCanvas.height);
    const found = await model.detect(tileCanvas, 24, PERSON_SCORE);
    found.filter((item) => item.class === "person").forEach((item) => {
      const [x, y, w, h] = item.bbox;
      people.push({
        bbox: [rx + x / tileCanvas.width * rw, ry + y / tileCanvas.height * rh, w / tileCanvas.width * rw, h / tileCanvas.height * rh],
        score: item.score,
      });
    });
  }
  people = nonMaximumSuppression(people, .48).filter((item) => item.bbox[2] * item.bbox[3] > vw * vh * .0012);
  people.sort((a, b) => a.bbox[0] - b.bbox[0]);
  people.forEach((person, index) => {
    person.id = index + 1;
    person.feature = extractAppearance(video, person.bbox);
  });
  return people;
}

function nonMaximumSuppression(items, threshold) {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept = [];
  while (sorted.length) {
    const best = sorted.shift();
    kept.push(best);
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      if (iou(best.bbox, sorted[index].bbox) > threshold) sorted.splice(index, 1);
    }
  }
  return kept;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - intersection;
  return union ? intersection / union : 0;
}

const featureCanvas = document.createElement("canvas");
featureCanvas.width = 24;
featureCanvas.height = 48;
const featureContext = featureCanvas.getContext("2d", { willReadFrequently: true });

function extractAppearance(video, bbox) {
  const [x, y, w, h] = bbox;
  featureContext.clearRect(0, 0, 24, 48);
  featureContext.drawImage(video, x + w * .08, y + h * .04, w * .84, h * .92, 0, 0, 24, 48);
  const pixels = featureContext.getImageData(0, 0, 24, 48).data;
  const histogram = new Array(96).fill(0);
  const spatial = [];
  let count = 0;
  for (let py = 4; py < 46; py += 2) {
    for (let px = 3; px < 21; px += 2) {
      const offset = (py * 24 + px) * 4;
      if (pixels[offset + 3] < 200) continue;
      const r = Math.min(3, Math.floor(pixels[offset] / 64));
      const g = Math.min(3, Math.floor(pixels[offset + 1] / 64));
      const b = Math.min(3, Math.floor(pixels[offset + 2] / 64));
      const region = py < 18 ? 0 : py < 34 ? 1 : 2;
      histogram[region * 32 + r * 8 + g * 2 + Math.floor(b / 2)] += 1;
      count += 1;
    }
  }
  // 再保留一份低分辨率的上下/左右颜色布局。仅用总颜色直方图时，
  // 两个都穿黑色的人很容易被认成同一人；空间布局可以保留帽子、上衣和裤子的差异。
  for (let cellY = 0; cellY < 8; cellY += 1) {
    for (let cellX = 0; cellX < 4; cellX += 1) {
      let r = 0; let g = 0; let b = 0; let samples = 0;
      const startX = cellX * 6;
      const startY = cellY * 6;
      for (let py = startY; py < startY + 6; py += 2) {
        for (let px = startX; px < startX + 6; px += 2) {
          const offset = (py * 24 + px) * 4;
          r += pixels[offset]; g += pixels[offset + 1]; b += pixels[offset + 2]; samples += 1;
        }
      }
      spatial.push(r / samples / 255, g / samples / 255, b / samples / 255);
    }
  }
  const normalizeFeature = (values) => {
    const length = Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0)) || 1;
    return values.map((value) => value / length);
  };
  const normalizedHistogram = normalizeFeature(histogram.map((value) => value / Math.max(1, count)));
  const normalizedSpatial = normalizeFeature(spatial);
  return [
    ...normalizedHistogram.map((value) => value * Math.sqrt(.58)),
    ...normalizedSpatial.map((value) => value * Math.sqrt(.42)),
  ];
}

function renderPersonBoxes(stage, layer, video, predictions, onSelect, selected = null) {
  layer.innerHTML = "";
  const stageWidth = stage.clientWidth;
  const stageHeight = stage.clientHeight;
  const scale = Math.min(stageWidth / video.videoWidth, stageHeight / video.videoHeight);
  const displayWidth = video.videoWidth * scale;
  const displayHeight = video.videoHeight * scale;
  const offsetX = (stageWidth - displayWidth) / 2;
  const offsetY = (stageHeight - displayHeight) / 2;
  predictions.forEach((prediction, index) => {
    const [x, y, w, h] = prediction.bbox;
    const box = document.createElement("button");
    box.className = `person-box${selected === prediction ? " selected" : ""}`;
    box.style.left = `${offsetX + x * scale}px`;
    box.style.top = `${offsetY + y * scale}px`;
    box.style.width = `${w * scale}px`;
    box.style.height = `${h * scale}px`;
    box.innerHTML = `<span>${selected === prediction ? "✓ 我" : index + 1}</span>`;
    box.setAttribute("aria-label", `选择人物 ${index + 1}`);
    box.addEventListener("click", () => onSelect(prediction));
    layer.append(box);
  });
}

async function onInitialPersonSelected(prediction) {
  state.selectedPrediction = prediction;
  state.identityReady = false;
  state.targetFeature = [...prediction.feature];
  state.targetAnchorFeature = [...prediction.feature];
  renderPersonBoxes($("#selectStage"), $("#selectBoxes"), $("#selectVideo"), state.currentPredictions, onInitialPersonSelected, prediction);
  $("#selectionStatus b").textContent = `已选中人物 ${prediction.id}`;
  $("#selectionStatus small").textContent = "正在建立身体、头部和局部纹理身份档案…";
  updateSelectionButton();
  try {
    await getTrackingEngine().initializeTarget($("#selectVideo"), state.currentPredictions, prediction, state.currentTime);
    if (state.selectedPrediction !== prediction) return;
    state.identityReady = true;
    $("#selectionStatus small").textContent = "身份档案已锁定；交叉或遮挡时会复核后再延续 Track ID";
  } catch (error) {
    console.error(error);
    $("#selectionStatus small").textContent = "身份模型未准备好，请重新点选或刷新页面";
    showToast("本地 Re-ID 身份模型加载失败", 4200);
  }
  updateSelectionButton();
}

function updateSelectionButton() {
  const button = $("#startTracking");
  button.disabled = !state.selectedPrediction || !state.identityReady;
  button.textContent = !state.selectedPrediction ? "请先选择人物" : state.identityReady ? "开始身份跟踪" : "正在锁定身份…";
}

async function moveSelectionFrame(delta) {
  const next = clamp(state.currentTime + delta, state.trimStart, state.trimEnd);
  state.currentTime = next;
  await prepareSelectionFrame(next);
}

$("#selectPrevFrame").addEventListener("click", () => moveSelectionFrame(-FRAME_STEP));
$("#selectNextFrame").addEventListener("click", () => moveSelectionFrame(FRAME_STEP));
$("#redetectButton").addEventListener("click", () => prepareSelectionFrame(state.currentTime));
$("#selectScrubber").addEventListener("input", (event) => {
  state.currentTime = Number(event.target.value);
  $("#selectTimeText").textContent = formatTime(state.currentTime);
});
$("#selectScrubber").addEventListener("change", () => prepareSelectionFrame(state.currentTime));

// 第 4 页：多目标 Track ID + 固定 Re-ID 身份库 + 头部/时空证据联合关联。
$("#startTracking").addEventListener("click", () => {
  if (!state.selectedPrediction || !state.identityReady) return;
  state.projectMode = "tracking";
  state.segments = [];
  state.samples = [];
  if (state.currentTime > state.trimStart + .01) addSegment(state.trimStart, state.currentTime, "untracked", "user-skip");
  state.processedUntil = state.currentTime;
  runTrackingFrom(state.currentTime, state.selectedPrediction, false);
});

$("#editOriginalVideo").addEventListener("click", async () => {
  state.analysisAbort = true;
  state.projectMode = "original";
  state.segments = [];
  state.samples = [];
  state.interruptAt = null;
  state.processedUntil = state.trimEnd;
  state.complete = true;
  try {
    await preparePreview();
    showPage(6);
    await paintVisiblePreviewFirstFrame();
    showToast("已进入原视频编辑模式，不启用人物跟踪");
  } catch (error) {
    console.error(error);
    showToast("预览首帧读取失败，请再试一次", 3600);
  }
});

$("[data-cancel-analysis]").addEventListener("click", () => {
  state.analysisAbort = true;
  showPage(3, false);
});

async function runTrackingFrom(startTime, initialPrediction, continuation) {
  state.analysisAbort = true;
  await sleep(20);
  state.analysisAbort = false;
  showPage(4, !continuation);
  updateAnalysisProgress(startTime);
  const video = $("#selectVideo");
  let previousBox = [...initialPrediction.bbox];
  let previousTime = startTime;
  const segmentStart = startTime;
  pushTrackSample(startTime, initialPrediction, state.currentPredictions);
  try {
    for (let time = startTime + TRACK_STEP; time < state.trimEnd + TRACK_STEP / 2; time += TRACK_STEP) {
      if (state.analysisAbort) return;
      const sampleTime = Math.min(time, state.trimEnd);
      await seekVideo(video, sampleTime);
      const people = await detectPeople(video, { detailed: true, focusBox: previousBox });
      const identity = await getTrackingEngine().resolveTarget(video, people, sampleTime);
      if (!identity.confident) {
        // 身份证据不明确时宁可停下，绝不能让空间上最近或衣服相似的人接管目标 ID。
        const stopTime = sampleTime;
        addSegment(segmentStart, previousTime, "tracked", "system");
        state.interruptAt = stopTime;
        state.processedUntil = previousTime;
        state.currentTime = stopTime;
        state.currentPredictions = people;
        state.complete = false;
        showPage(5, false);
        return;
      }
      const target = identity.target;
      previousBox = [...target.bbox];
      previousTime = sampleTime;
      pushTrackSample(sampleTime, target, people);
      state.processedUntil = sampleTime;
      updateAnalysisProgress(sampleTime);
      $("#analysisText").textContent = `当前 ${formatTime(sampleTime)} · Track ${target.trackId} · 身份置信 ${Math.round(identity.score * 100)}%`;
      await sleep(0);
      if (sampleTime >= state.trimEnd - .02) break;
    }
    addSegment(segmentStart, state.trimEnd, "tracked", "system");
    state.processedUntil = state.trimEnd;
    state.currentTime = state.trimEnd;
    state.interruptAt = null;
    state.complete = true;
    showPage(5, false);
  } catch (error) {
    console.error(error);
    addSegment(segmentStart, previousTime, "tracked", "system");
    state.interruptAt = previousTime;
    state.processedUntil = previousTime;
    state.currentTime = previousTime;
    state.complete = false;
    showToast("本地识别暂停，请在当前帧继续选择", 3500);
    showPage(5, false);
  }
}

function pushTrackSample(time, target, people) {
  const sample = {
    time,
    target: { bbox: [...target.bbox], score: target.score, trackId: target.trackId, identityScore: target.identityScore },
    people: people.map((person) => ({ bbox: [...person.bbox], score: person.score, trackId: person.trackId })),
  };
  const existing = state.samples.findIndex((item) => Math.abs(item.time - time) < .01);
  if (existing >= 0) state.samples[existing] = sample;
  else state.samples.push(sample);
  state.samples.sort((a, b) => a.time - b.time);
}

function updateAnalysisProgress(time) {
  const total = Math.max(.01, state.trimEnd - state.trimStart);
  const percent = clamp(((time - state.trimStart) / total) * 100, 0, 100);
  $("#analysisPercent").textContent = `${Math.round(percent)}%`;
  $("#progressRing").style.setProperty("--progress", percent);
  $("#analysisGreen").style.width = `${percent}%`;
  $("#analysisHead").style.left = `${percent}%`;
}

function addSegment(start, end, status, source) {
  const safeStart = clamp(Math.min(start, end), state.trimStart, state.trimEnd);
  const safeEnd = clamp(Math.max(start, end), state.trimStart, state.trimEnd);
  if (safeEnd - safeStart < .005) return;
  state.segments.push({ start: safeStart, end: safeEnd, status, source });
  state.segments = normalizeSegments(state.segments);
}

function normalizeSegments(segments) {
  const points = [...new Set(segments.flatMap((segment) => [segment.start, segment.end]))].sort((a, b) => a - b);
  const result = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]; const end = points[index + 1]; const middle = (start + end) / 2;
    const covering = [...segments].reverse().find((segment) => middle >= segment.start && middle <= segment.end);
    if (!covering) continue;
    const previous = result.at(-1);
    if (previous && previous.status === covering.status && Math.abs(previous.end - start) < .005) previous.end = end;
    else result.push({ start, end, status: covering.status, source: covering.source });
  }
  return result;
}

function segmentAt(time) {
  return state.segments.find((segment) => time >= segment.start - .01 && time <= segment.end + .01) || null;
}

function canRepairAt(time) {
  return segmentAt(time)?.status !== "tracked";
}

// 第 5 页：中断后可逐帧/拖动找框，点选后继续。
async function prepareEditPage() {
  renderTrackSegments();
  const complete = state.complete || state.processedUntil >= state.trimEnd - .02;
  state.complete = complete;
  // 预览始终可用；直拍项目的灰色区继续保持同一画幅并用相邻可靠轨迹桥接。
  $("#previewButton").disabled = false;
  const bubble = $("#resultBubble");
  bubble.className = `result-bubble ${complete ? "success" : "warning"}`;
  $("#resultIcon").textContent = complete ? "✓" : "!";
  $("#resultTitle").textContent = complete ? "跟踪完成" : "自动跟踪停止了";
  $("#resultMessage").textContent = complete
    ? "整段已处理完成，可以去调整画幅、人物放大和他人打码"
    : "可随时预览；返回后仍可在灰色段重新找框并补充跟踪";
  const hasUntracked = state.segments.some((segment) => segment.status === "untracked");
  $("#editHint").textContent = complete && hasUntracked
    ? "灰色段可拖动后重新找人"
    : (complete ? "绿色：跟踪到目标人物" : "下一帧：逐帧精准找框");
  const time = complete ? state.trimEnd : (state.interruptAt ?? state.currentTime);
  await updateEditTime(time, !complete);
}

async function updateEditTime(time, shouldDetect = true) {
  state.currentTime = clamp(time, state.trimStart, state.trimEnd);
  $("#editCurrentText").textContent = formatTime(state.currentTime);
  const percent = (state.currentTime - state.trimStart) / Math.max(.01, state.trimEnd - state.trimStart) * 100;
  $("#timelineHead").style.left = `${clamp(percent, 0, 100)}%`;
  $("#skipToHere").disabled = state.complete || state.interruptAt == null || state.currentTime <= state.interruptAt + .01;
  await seekVideo($("#editVideo"), state.currentTime);
  if (shouldDetect && (!state.complete || canRepairAt(state.currentTime))) await detectEditFrame();
  else $("#editBoxes").innerHTML = "";
}

async function detectEditFrame() {
  const button = $("#detectCurrentFrame");
  button.disabled = true;
  button.textContent = "正在找框…";
  try {
    const video = $("#editVideo");
    const predictions = await detectPeople(video, { detailed: true });
    state.currentPredictions = predictions;
    renderPersonBoxes($("#editStage"), $("#editBoxes"), video, predictions, onContinuationPersonSelected);
    if (!predictions.length) showToast("这一帧没有人物框，请继续向后找");
  } catch (error) {
    console.error(error);
    showToast("当前帧识别失败，请再试一次");
  } finally {
    button.disabled = false;
    button.textContent = "◎ 找人物框";
  }
}

async function onContinuationPersonSelected(prediction) {
  renderPersonBoxes($("#editStage"), $("#editBoxes"), $("#editVideo"), state.currentPredictions, () => {}, prediction);
  $("#detectCurrentFrame").disabled = true;
  $("#resultMessage").textContent = "正在把你刚选的人与最初身份档案进行关联…";
  if (state.interruptAt != null && state.currentTime > state.interruptAt + .005) {
    addSegment(state.interruptAt, state.currentTime, "untracked", "user-skip");
  }
  try {
    await getTrackingEngine().adoptTarget($("#editVideo"), state.currentPredictions, prediction, state.currentTime);
  } catch (error) {
    console.error(error);
    showToast("当前人物身份特征提取失败，请再点一次", 3500);
    $("#detectCurrentFrame").disabled = false;
    return;
  }
  state.selectedPrediction = prediction;
  $("#detectCurrentFrame").disabled = false;
  runTrackingFrom(state.currentTime, prediction, true);
}

$("#editPrevFrame").addEventListener("click", () => updateEditTime(state.currentTime - FRAME_STEP));
$("#editNextFrame").addEventListener("click", () => updateEditTime(state.currentTime + FRAME_STEP));
$("#detectCurrentFrame").addEventListener("click", detectEditFrame);
$("#editPlay").addEventListener("click", () => toggleVideo($("#editVideo"), $("#editPlay")));
$("#editVideo").addEventListener("timeupdate", () => {
  if (!$("#editVideo").paused) updateEditTime($("#editVideo").currentTime, false);
});

function seekEditFromPointer(event) {
  const rect = $("#trackTimeline").getBoundingClientRect();
  const percent = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  updateEditTime(state.trimStart + percent * (state.trimEnd - state.trimStart), false);
}
$("#trackTimeline").addEventListener("pointerdown", (event) => {
  $("#trackTimeline").setPointerCapture(event.pointerId);
  seekEditFromPointer(event);
});
$("#trackTimeline").addEventListener("pointermove", (event) => {
  if ($("#trackTimeline").hasPointerCapture(event.pointerId)) seekEditFromPointer(event);
});
$("#trackTimeline").addEventListener("pointerup", () => {
  // 即使整条时间线已经处理到结尾，灰色区仍可重新识别并补跟踪。
  if (!state.complete || canRepairAt(state.currentTime)) detectEditFrame();
});
$("#trackTimeline").addEventListener("keydown", (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  updateEditTime(state.currentTime + (event.key === 'ArrowRight' ? FRAME_STEP : -FRAME_STEP));
});

$("#skipToHere").addEventListener("click", async () => {
  if (state.interruptAt == null || state.currentTime <= state.interruptAt) return;
  addSegment(state.interruptAt, state.currentTime, "untracked", "user-skip");
  state.interruptAt = state.currentTime;
  state.processedUntil = Math.max(state.processedUntil, state.currentTime);
  if (state.currentTime >= state.trimEnd - .02) {
    state.complete = true;
    await prepareEditPage();
  } else {
    renderTrackSegments();
    showToast("这一段已设为灰色，请在当前帧选择你自己");
  }
});

function renderTrackSegments() {
  const container = $("#trackSegments");
  container.innerHTML = "";
  const length = Math.max(.01, state.trimEnd - state.trimStart);
  state.segments.forEach((segment) => {
    const item = document.createElement("span");
    item.className = `timeline-segment ${segment.status}`;
    item.style.left = `${(segment.start - state.trimStart) / length * 100}%`;
    item.style.width = `${(segment.end - segment.start) / length * 100}%`;
    container.append(item);
  });
}

async function openPreviewPage() {
  const button = $("#previewButton");
  if (button) button.disabled = true;
  try {
    // 先解码首帧，再切换页面；页面显示后继续等待浏览器的真实视频帧回调重绘。
    await preparePreview();
    showPage(6);
    await paintVisiblePreviewFirstFrame();
  } catch (error) {
    console.error(error);
    showToast("预览首帧读取失败，请再试一次", 3600);
  } finally {
    if (button) button.disabled = false;
  }
}

$("#previewButton").addEventListener("click", openPreviewPage);

$("#resetTracking").addEventListener("click", async () => {
  const resetTime = state.trimStart;
  clearTrackingState();
  state.currentTime = resetTime;
  state.history = state.history.filter((page) => page !== 4 && page !== 5 && page !== 6);
  showPage(3, false);
  await prepareSelectionFrame(resetTime);
  showToast("跟踪进度已清空，请重新选择人物", 3600);
});

// 第 6 页：Canvas 根据身份轨迹裁剪；他人打码只使用逐人实例 Mask，不再使用矩形框。
$$('[data-editor-tab]').forEach((button) => button.addEventListener("click", () => {
  if (button.disabled) {
    showToast("仅适用于人物跟踪模式", 3200);
    return;
  }
  $$('[data-editor-tab]').forEach((item) => item.classList.toggle("active", item === button));
  $$('[data-editor-panel]').forEach((panel) => panel.classList.toggle("active", panel.dataset.editorPanel === button.dataset.editorTab));
}));
$$('[data-ratio]').forEach((button) => button.addEventListener("click", () => {
  state.ratio = button.dataset.ratio;
  state.ratioClass = button.dataset.class;
  $$('[data-ratio]').forEach((item) => item.classList.toggle("selected", item === button));
  applyPreviewSettings();
}));
$$('[data-zoom]').forEach((button) => button.addEventListener("click", () => setZoom(Number(button.dataset.zoom))));
$("#zoomSlider").addEventListener("input", (event) => setZoom(Number(event.target.value)));
$("#blurToggle").addEventListener("click", async () => {
  if (state.projectMode === "original") {
    showToast("他人打码仅适用于人物跟踪模式", 3200);
    return;
  }
  state.blurOthers = !state.blurOthers;
  $("#blurToggle").classList.toggle("active", state.blurOthers);
  $("#blurToggle").setAttribute("aria-pressed", String(state.blurOthers));
  $("#blurValue").textContent = state.blurOthers ? "已开启" : "已关闭";
  if (!state.blurOthers) {
    state.maskPreparationId += 1;
    state.maskPreparationPromise = null;
    state.previewMasksReady = false;
    state.previewHasOtherPeopleMasks = false;
    state.previewMaskProgress = 0;
    state.previewMaskCache = [];
  }
  if (state.blurOthers && !$("#previewVideo").paused) {
    $("#previewVideo").pause();
    state.musicEngine?.stopPreview();
    showToast("已暂停播放，正在生成当前人物轮廓", 2600);
  }
  if (state.blurOthers) {
    if (!state.maskRequested) state.maskRequested = true;
    $("#blurValue").textContent = "轮廓准备中";
    try {
      await getTrackingEngine().loadSegmenter();
      if (state.blurOthers) await preparePreviewMaskTimeline();
    } catch (error) {
      console.warn("像素级 Mask 模型未能启用", error);
      state.blurOthers = false;
      state.maskRequested = false;
      $("#blurToggle").classList.remove("active");
      $("#blurToggle").setAttribute("aria-pressed", "false");
      $("#blurValue").textContent = "轮廓模型不可用";
      showToast("人物轮廓模型未能启用；为避免方框打码，已关闭该功能", 4200);
    }
  }
  drawPreviewFrame();
});
$("#blurStrength").addEventListener("input", (event) => {
  state.blurStrength = Number(event.target.value);
  $("#blurStrengthValue").textContent = String(state.blurStrength);
  drawPreviewFrame();
});
$$('[data-blur-effect]').forEach((button) => button.addEventListener("click", () => {
  state.blurEffect = button.dataset.blurEffect;
  $$('[data-blur-effect]').forEach((item) => item.classList.toggle("selected", item === button));
  drawPreviewFrame();
}));
$("#maskDilation").addEventListener("input", (event) => {
  state.maskDilation = Number(event.target.value);
  $("#maskDilationValue").textContent = String(state.maskDilation);
  state.previewMaskCache.forEach((frame) => { frame.otherPeopleMask = buildOtherPeopleMask(frame); });
  if (state.previewMaskFrame) state.previewMaskFrame.otherPeopleMask = buildOtherPeopleMask(state.previewMaskFrame);
  state.derivedMaskKey = "";
  drawPreviewFrame();
});
$("#maskFeather").addEventListener("input", (event) => {
  state.maskFeather = Number(event.target.value);
  $("#maskFeatherValue").textContent = String(state.maskFeather);
  drawPreviewFrame();
});

function formatMusicOffset(milliseconds) {
  const safe = Math.abs(Math.round(Number(milliseconds) || 0));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const millis = safe % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function resetAudioUI() {
  const result = $("#audioResult");
  const status = $("#audioAnalysisStatus");
  if (!result || !status) return;
  result.hidden = true;
  status.hidden = true;
  $("#extractedAudioTimeline").hidden = true;
  $("#audioMatchBadge").textContent = "未提取";
  $("#referenceAudioName").textContent = "选择含有干净音乐的视频";
  $("#audioAnalysisProgress").style.width = "0%";
  $("#originalVolume").value = 0;
  $("#musicVolume").value = 100;
  $("#originalVolumeValue").textContent = "0%";
  $("#musicVolumeValue").textContent = "100%";
}

function drawWaveform(canvas, values, color) {
  const context = canvas.getContext("2d");
  const width = canvas.width; const height = canvas.height;
  context.clearRect(0, 0, width, height);
  if (!values?.length) return;
  context.strokeStyle = color;
  context.lineWidth = Math.max(1, width / values.length * .65);
  context.beginPath();
  for (let index = 0; index < values.length; index += 1) {
    const x = index / Math.max(1, values.length - 1) * width;
    const amplitude = Math.max(.02, values[index]) * (height * .43);
    context.moveTo(x, height / 2 - amplitude);
    context.lineTo(x, height / 2 + amplitude);
  }
  context.stroke();
}

function audioStatusLabel(result) {
  return result.status === "matched" ? "已自动对齐" : "可拖动微调";
}

function audioTrackLimits() {
  const engine = getMusicEngine();
  const videoDuration = Math.max(100, (state.trimEnd - state.trimStart) * 1000);
  const speed = Number(engine.result?.speed_ratio || 1);
  const audioDuration = Math.max(100, Number(engine.result?.reference_duration_ms || 0) / speed);
  return {
    videoDuration,
    min: -Math.max(0, audioDuration - 200),
    max: Math.max(0, videoDuration - 200),
  };
}

function renderAudioTimeline() {
  const engine = getMusicEngine();
  const result = engine.result;
  if (!result) return;
  const timeline = $("#extractedAudioTimeline");
  const clip = $("#extractedAudioTrack");
  const videoDuration = Math.max(100, (state.trimEnd - state.trimStart) * 1000);
  const speed = Number(result.speed_ratio || 1);
  const trackStart = engine.timelineStartMs();
  const trimStartMs = state.trimStart * 1000;
  const sourceTrackStart = trimStartMs + trackStart;
  const trackDuration = Math.max(100, Number(result.reference_duration_ms || 0) / speed);
  timeline.hidden = false;
  clip.style.left = `${trackStart / videoDuration * 100}%`;
  clip.style.width = `${trackDuration / videoDuration * 100}%`;
  clip.dataset.trimStartMs = String(Math.round(trimStartMs));
  clip.dataset.relativeStartMs = String(Math.round(trackStart));
  clip.dataset.sourceStartMs = String(Math.round(sourceTrackStart));
  clip.setAttribute("aria-valuemin", String(Math.round(audioTrackLimits().min)));
  clip.setAttribute("aria-valuemax", String(Math.round(audioTrackLimits().max)));
  clip.setAttribute("aria-valuenow", String(Math.round(trackStart)));
  if (trackStart >= 0) {
    // 匹配引擎的 trackStart 是“裁剪后成片内”的相对时间。
    // 跨设备对比时必须显示原视频绝对时间，否则手机裁掉 1.716s 后
    // 会把同一个 3.509s 位置误显示为 1.793s。
    $("#audioTrackPosition").textContent = trimStartMs > 5
      ? `从原视频 ${formatMusicOffset(sourceTrackStart)} 开始（成片内 ${formatMusicOffset(trackStart)}）`
      : `从原视频 ${formatMusicOffset(sourceTrackStart)} 开始`;
  } else if (sourceTrackStart >= 0) {
    $("#audioTrackPosition").textContent = `原视频 ${formatMusicOffset(sourceTrackStart)} 已开始（裁剪区左侧裁去 ${formatMusicOffset(-trackStart)}）`;
  } else {
    $("#audioTrackPosition").textContent = `音乐早于原视频，左侧裁去 ${formatMusicOffset(-trackStart)}`;
  }
  drawWaveform($("#audioTrackWaveform"), result.reference_waveform, "rgba(255,255,255,.88)");
}

async function renderAudioResult(result) {
  const engine = getMusicEngine();
  if (result.start_offset_ms == null) {
    engine.setCandidate({ start_offset_ms: 0, speed_ratio: 1 }, true);
    await engine.prepareTimelinePreview(Math.max(.1, state.trimEnd - state.trimStart));
  }
  engine.confirm();
  state.audioAlignment = engine.exportParameters();
  $("#audioResult").hidden = false;
  $("#audioMatchBadge").textContent = audioStatusLabel(result);
  renderAudioTimeline();
  updateAudioMixSettings();
}

$("#referenceAudioButton").addEventListener("click", () => $("#referenceAudioPicker").click());
$("#referenceAudioPicker").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || !state.sourceFile) return;
  if (file.type && !file.type.startsWith("video/")) {
    showToast("请选择一个含音乐的视频", 3600);
    return;
  }
  $("#referenceAudioName").textContent = file.name;
  $("#audioResult").hidden = true;
  $("#extractedAudioTimeline").hidden = true;
  const engine = getMusicEngine();
  try {
    const result = await engine.analyze(state.sourceFile, file, {
      trimStart: state.trimStart,
      duration: state.trimEnd - state.trimStart,
    });
    await renderAudioResult(result);
    if (!$("#previewVideo").paused) await engine.startPreview($("#previewVideo"), state.trimStart);
    showToast(result.status === "matched" ? "已提取音乐并自动对齐" : "已提取音乐，请在进度条下拖动微调", 4600);
  } catch (error) {
    console.error(error);
    $("#audioMatchBadge").textContent = "处理失败";
    showToast(error.message || "视频音频提取失败", 5200);
  }
});

async function commitAudioTrackStart(trackStartMs) {
  const engine = getMusicEngine();
  if (!engine.result) return;
  const limits = audioTrackLimits();
  await engine.setTimelineStart(clamp(trackStartMs, limits.min, limits.max));
  state.audioAlignment = engine.exportParameters();
  renderAudioTimeline();
  if (!$("#previewVideo").paused) await engine.startPreview($("#previewVideo"), state.trimStart);
}

let audioTrackDrag = null;
$("#extractedAudioTrack").addEventListener("pointerdown", (event) => {
  const engine = getMusicEngine();
  if (!engine.result) return;
  event.preventDefault();
  engine.stopPreview();
  const lane = $("#audioTrackLane");
  audioTrackDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startMs: engine.timelineStartMs(),
    laneWidth: Math.max(1, lane.getBoundingClientRect().width),
  };
  event.currentTarget.setPointerCapture(event.pointerId);
  event.currentTarget.classList.add("dragging");
});
$("#extractedAudioTrack").addEventListener("pointermove", (event) => {
  if (!audioTrackDrag || event.pointerId !== audioTrackDrag.pointerId) return;
  const engine = getMusicEngine();
  const limits = audioTrackLimits();
  const next = clamp(
    audioTrackDrag.startMs + (event.clientX - audioTrackDrag.startX) / audioTrackDrag.laneWidth * limits.videoDuration,
    limits.min,
    limits.max,
  );
  engine.setCandidate({ start_offset_ms: -next * Number(engine.result.speed_ratio || 1), speed_ratio: engine.result.speed_ratio }, true);
  renderAudioTimeline();
});
async function finishAudioTrackDrag(event) {
  if (!audioTrackDrag || event.pointerId !== audioTrackDrag.pointerId) return;
  const track = $("#extractedAudioTrack");
  const next = getMusicEngine().timelineStartMs();
  audioTrackDrag = null;
  track.classList.remove("dragging");
  await commitAudioTrackStart(next);
  showToast("已使用手动调整后的音乐位置");
}
$("#extractedAudioTrack").addEventListener("pointerup", finishAudioTrackDrag);
$("#extractedAudioTrack").addEventListener("pointercancel", finishAudioTrackDrag);
$("#extractedAudioTrack").addEventListener("keydown", async (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const step = event.shiftKey ? 100 : 10;
  await commitAudioTrackStart(getMusicEngine().timelineStartMs() + (event.key === "ArrowLeft" ? -step : step));
});

function updateAudioMixSettings() {
  const engine = getMusicEngine();
  const originalVolume = Number($("#originalVolume").value) / 100;
  const musicVolume = Number($("#musicVolume").value) / 100;
  engine.setMix({ mode: originalVolume > 0 ? "mix" : "replace", originalVolume, musicVolume });
  $("#originalVolumeValue").textContent = `${Math.round(originalVolume * 100)}%`;
  $("#musicVolumeValue").textContent = `${Math.round(musicVolume * 100)}%`;
  engine.applyVideoVolume($("#previewVideo"), state.trimStart);
  state.audioAlignment = engine.exportParameters();
}
$("#originalVolume").addEventListener("input", updateAudioMixSettings);
$("#musicVolume").addEventListener("input", updateAudioMixSettings);

$("#removeReferenceAudio").addEventListener("click", () => {
  const video = $("#previewVideo");
  getMusicEngine().reset();
  state.audioAlignment = null;
  video.muted = false;
  video.volume = 1;
  resetAudioUI();
  showToast("已移除提取音乐，恢复课堂视频原声");
});

function setZoom(value) {
  if (state.projectMode === "original") {
    showToast("人物放大仅适用于人物跟踪模式", 3200);
    return;
  }
  state.zoom = clamp(Math.round(value / 20) * 20, 100, 280);
  $$('[data-zoom]').forEach((button) => button.classList.toggle("selected", Number(button.dataset.zoom) === state.zoom));
  $("#zoomSlider").value = state.zoom;
  applyPreviewSettings();
}

function updateTrackingOnlyControls() {
  const originalMode = state.projectMode === "original";
  const zoomTab = $('[data-editor-tab="zoom"]');
  const blurTab = $('[data-editor-tab="blur"]');
  [zoomTab, blurTab].forEach((button) => {
    button.disabled = originalMode;
    button.classList.toggle("tracking-only-disabled", originalMode);
    button.title = originalMode ? "仅适用于人物跟踪" : "";
  });
  if (originalMode) {
    if (zoomTab.classList.contains("active") || blurTab.classList.contains("active")) {
      $('[data-editor-tab="ratio"]').click();
    }
    state.blurOthers = false;
    $("#blurToggle").classList.remove("active");
    $("#blurToggle").setAttribute("aria-pressed", "false");
    $("#blurValue").textContent = "仅限人物跟踪";
    $("#zoomValue").textContent = "仅限人物跟踪";
  } else {
    $("#blurValue").textContent = state.blurOthers ? "已开启" : "已关闭";
    $("#zoomValue").textContent = `${state.zoom}%`;
  }
}

function applyPreviewSettings() {
  $("#renderFrame").className = `render-frame ${state.ratioClass}`;
  $("#ratioBadge").textContent = state.ratio;
  $("#ratioValue").textContent = state.ratio;
  $("#zoomValue").textContent = state.projectMode === "original" ? "仅限人物跟踪" : `${state.zoom}%`;
  state.lastPreviewCenter = null;
  window.requestAnimationFrame(drawPreviewFrame);
}

async function preparePreview() {
  const video = $("#previewVideo");
  if (state.projectMode === "tracking" && state.zoom === 100) state.zoom = 180;
  updateTrackingOnlyControls();
  $("#previewScrubber").min = state.trimStart;
  $("#previewScrubber").max = state.trimEnd;
  $("#previewScrubber").value = state.trimStart;
  state.lastPreviewCenter = null;
  await seekVideo(video, state.trimStart);
  // Safari/手机首次挂载隐藏 video 时，seeked 可能早于真正可绘制帧；等待可绘制后立即画首帧。
  if (video.readyState < 2) await waitForEvent(video, "loadeddata", "error");
  applyPreviewSettings();
  await new Promise((resolve) => window.requestAnimationFrame(() => {
    drawPreviewFrame();
    resolve();
  }));
}

async function paintVisiblePreviewFirstFrame() {
  const video = $("#previewVideo");
  // Safari 在隐藏 video 首次显示时可能延后一次解码，短暂播放一帧能可靠触发像素输出。
  const startTime = state.trimStart;
  const wasMuted = video.muted;
  video.muted = true;
  let painted = false;
  if (typeof video.requestVideoFrameCallback === "function") {
    await new Promise((resolve) => {
      const timeout = window.setTimeout(resolve, 700);
      video.requestVideoFrameCallback(() => {
        window.clearTimeout(timeout);
        painted = true;
        drawPreviewFrame();
        resolve();
      });
      video.play().catch(resolve);
    });
  } else {
    await video.play().catch(() => {});
    await sleep(90);
  }
  video.pause();
  if (Math.abs(video.currentTime - startTime) > .004) await seekVideo(video, startTime);
  video.muted = wasMuted;
  drawPreviewFrame();
  // 再跨两个可见布局帧重画，覆盖 iOS Canvas 首次合成仍为空白的情况。
  await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    drawPreviewFrame();
    resolve();
  })));
  return painted;
}

function nearestTrackSample(time) {
  if (!state.samples.length) return null;
  let best = state.samples[0];
  for (const sample of state.samples) {
    if (Math.abs(sample.time - time) < Math.abs(best.time - time)) best = sample;
  }
  return best;
}

function smoothedTrackSample(time) {
  const nearest = nearestTrackSample(time);
  if (!nearest) return null;
  // 绿色段只在同一有效区间内平滑；灰色段交给专门的前后轨迹桥接逻辑。
  const segment = state.segments.find((item) => item.status === "tracked" && time >= item.start - .01 && time <= item.end + .01);
  // 灰色段仍属于同一个直拍项目：用前后有效轨迹平滑桥接，绝不能突然跳回原视频比例。
  if (!segment) return bridgedTrackSample(time);
  const radius = .72;
  const neighbors = state.samples.filter((sample) => (
    sample.time >= segment.start - .01
    && sample.time <= segment.end + .01
    && Math.abs(sample.time - time) <= radius
  ));
  if (!neighbors.length) return nearest;
  let totalWeight = 0;
  const smoothBox = [0, 0, 0, 0];
  neighbors.forEach((sample) => {
    const weight = Math.exp(-Math.abs(sample.time - time) / .28);
    totalWeight += weight;
    sample.target.bbox.forEach((value, index) => { smoothBox[index] += value * weight; });
  });
  return {
    ...nearest,
    target: { ...nearest.target, bbox: smoothBox.map((value) => value / totalWeight) },
  };
}

function bridgedTrackSample(time) {
  if (!state.samples.length) return null;
  let previous = null;
  let next = null;
  state.samples.forEach((sample) => {
    if (sample.time <= time && (!previous || sample.time > previous.time)) previous = sample;
    if (sample.time >= time && (!next || sample.time < next.time)) next = sample;
  });
  if (!previous) return next;
  if (!next) return previous;
  const span = Math.max(.001, next.time - previous.time);
  const linear = clamp((time - previous.time) / span, 0, 1);
  const mix = linear * linear * (3 - 2 * linear);
  const bbox = previous.target.bbox.map((value, index) => value + (next.target.bbox[index] - value) * mix);
  return {
    ...previous,
    time,
    people: [],
    target: { ...previous.target, bbox, bridged: true },
  };
}

function evenPixel(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function previewRenderSize(video, aspect) {
  if (!state.exporting) {
    return aspect >= 1
      ? { width: 720, height: evenPixel(720 / aspect) }
      : { width: evenPixel(720 * aspect), height: 720 };
  }
  // 导出使用源视频中能容纳当前画幅的最大原生像素区域，不再固定缩到 720p。
  if (video.videoWidth / video.videoHeight > aspect) {
    return { width: evenPixel(video.videoHeight * aspect), height: evenPixel(video.videoHeight) };
  }
  return { width: evenPixel(video.videoWidth), height: evenPixel(video.videoWidth / aspect) };
}

function stableCropPosition(idealX, idealY, time) {
  const previous = state.lastPreviewCenter;
  if (!previous || time < previous.time || Math.abs(time - previous.time) > .48) {
    state.lastPreviewCenter = { x: idealX, y: idealY, time };
    return { x: idealX, y: idealY };
  }
  const elapsed = Math.max(0, time - previous.time);
  const mix = 1 - Math.exp(-elapsed / .16);
  const next = {
    x: previous.x + (idealX - previous.x) * mix,
    y: previous.y + (idealY - previous.y) * mix,
    time,
  };
  state.lastPreviewCenter = next;
  return next;
}

function drawPreviewFrame() {
  const video = $("#previewVideo");
  if (!video.videoWidth || !video.videoHeight) return;
  const canvas = $("#previewCanvas");
  const [rw, rh] = state.ratio.split(":").map(Number);
  const aspect = rw / rh;
  const renderSize = previewRenderSize(video, aspect);
  if (canvas.width !== renderSize.width) canvas.width = renderSize.width;
  if (canvas.height !== renderSize.height) canvas.height = renderSize.height;
  const context = canvas.getContext("2d");
  const vw = video.videoWidth; const vh = video.videoHeight;
  const sample = smoothedTrackSample(video.currentTime);
  if (state.projectMode === "original") {
    // 只有用户从一开始明确选择“不跟踪人物”时，才完整展示原视频。
    context.filter = "none";
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const containScale = Math.min(canvas.width / vw, canvas.height / vh);
    const containWidth = vw * containScale;
    const containHeight = vh * containScale;
    context.drawImage(
      video,
      0, 0, vw, vh,
      (canvas.width - containWidth) / 2,
      (canvas.height - containHeight) / 2,
      containWidth,
      containHeight,
    );
    return;
  }
  let cropW; let cropH;
  if (vw / vh > aspect) { cropH = vh; cropW = vh * aspect; }
  else { cropW = vw; cropH = vw / aspect; }
  cropW /= state.zoom / 100;
  cropH /= state.zoom / 100;
  const target = sample?.target?.bbox;
  const centerX = target ? target[0] + target[2] / 2 : vw / 2;
  const availableAroundPerson = target ? cropH - target[3] : 0;
  // 人物完整可见时严格按“头顶留白 : 脚下留白 = 3 : 1”构图。
  // 人物大于裁剪区时改为让脚部落在画面约 90% 高度处，优先保留舞步。
  const idealCropY = target
    ? (availableAroundPerson >= 0
      ? target[1] - availableAroundPerson * .75
      : target[1] + target[3] - cropH * .90)
    : (vh - cropH) / 2;
  const idealCropX = clamp(centerX - cropW / 2, 0, vw - cropW);
  const boundedCropY = clamp(idealCropY, 0, vh - cropH);
  const stableCrop = stableCropPosition(idealCropX, boundedCropY, video.currentTime);
  const cropX = clamp(stableCrop.x, 0, vw - cropW);
  const cropY = clamp(stableCrop.y, 0, vh - cropH);
  context.filter = "none";
  context.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
  const activeMaskFrame = maskFrameForPreviewTime(video.currentTime);
  if (state.blurOthers && activeMaskFrame?.safeToApply) {
    drawSilhouetteEffect(context, video, cropX, cropY, cropW, cropH, canvas.width, canvas.height, activeMaskFrame);
  }
}

const mosaicLowCanvas = document.createElement("canvas");
const mosaicResultCanvas = document.createElement("canvas");
const maskAlphaCanvas = document.createElement("canvas");
const maskProtectionCanvas = document.createElement("canvas");

function binaryMaskCanvas(binary, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  for (let index = 0; index < binary.length; index += 1) {
    if (!binary[index]) continue;
    const offset = index * 4;
    image.data[offset] = 255; image.data[offset + 1] = 255;
    image.data[offset + 2] = 255; image.data[offset + 3] = binary[index];
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function buildOtherPeopleMask(maskFrame) {
  if (!maskFrame.safeToApply) return null;
  const first = maskFrame.masks[0]?.mask || maskFrame.protectionMask;
  if (!first?.data) return null;
  const width = first.width; const height = first.height;
  // Track ID 是身份层，最终保护必须以当前 protectionMask 为准。
  // 当某个交叉帧的实例 Mask 误绑了目标 Track ID 时，不能因此把它从 others 集合中静默排除；
  // 所有实例先作为候选匿名区，最后统一减去像素级 target_protection_mask。
  const maskInstances = maskFrame.masks.filter((record) => record.mask?.data);
  const otherMasks = maskInstances.map((record) => record.mask.data);
  if (!otherMasks.length || !window.MaskCompositor) return null;
  const compactScale = width / Math.max(1, maskFrame.frameWidth);
  const config = window.DANCE_MASK_CONFIG || {};
  const othersRadius = state.maskDilation <= 0 ? 0 : Math.max(1, Math.ceil(state.maskDilation * compactScale));
  const targetRadius = Math.max(1, Math.ceil(Number(config.target_mask_dilation ?? 8) * compactScale));
  const composed = window.MaskCompositor.composeFinalBlurMask({
    otherMasks,
    targetMask: maskFrame.protectionMask.data,
    width, height,
    targetDilation: targetRadius,
    othersDilation: othersRadius,
  });
  maskFrame.targetProtectionMask = binaryMaskCanvas(composed.targetProtectionMask, width, height);
  maskFrame.maskDiagnostics = {
    time: maskFrame.time,
    targetTrackId: maskFrame.targetTrackId,
    instanceTrackIds: maskFrame.masks.map((record) => record.trackId),
    maskAssignments: maskInstances.map((record) => ({
      trackId: record.trackId,
      isTarget: record.isTarget,
      propagated: record.propagated,
      bbox: record.bbox?.map((value) => Math.round(value * 10) / 10),
    })),
    targetBindingScore: maskFrame.targetBindingScore,
    targetProtectionPixels: composed.targetProtectionMask.reduce((count, value) => count + Number(Boolean(value)), 0),
    othersVisiblePixels: composed.othersVisibleMask.reduce((count, value) => count + Number(Boolean(value)), 0),
    finalBlurPixels: composed.finalBlurMask.reduce((count, value) => count + Number(Boolean(value)), 0),
    targetMaskIncomplete: maskFrame.targetMaskIncomplete,
    targetMaskMerged: maskFrame.targetMaskMerged,
    identityState: maskFrame.identityState,
    occlusionUncertain: maskFrame.occlusionUncertain,
    finalTargetIntersectionPixels: composed.intersectionPixels,
  };
  return binaryMaskCanvas(composed.finalBlurMask, width, height);
}

function closestMaskFrame(cache, time) {
  if (!cache.length) return null;
  let nearest = cache[0];
  for (const frame of cache) {
    if (Math.abs(frame.time - time) < Math.abs(nearest.time - time)) nearest = frame;
  }
  return nearest;
}

function maskFrameForPreviewTime(time) {
  if (!state.blurOthers) return null;
  if (state.exporting) return closestMaskFrame(state.exportMaskCache, time);
  const base = closestMaskFrame(state.previewMaskCache, time) || state.previewMaskFrame;
  if (!base) return null;
  const sample = smoothedTrackSample(time);
  if (!sample?.target?.bbox) return base;
  const quantizedTime = Math.floor(time * 15) / 15;
  const cacheKey = `${base.time.toFixed(3)}:${quantizedTime.toFixed(3)}:${sample.time.toFixed(3)}:${state.maskDilation}:${state.maskFeather}`;
  if (state.derivedPreviewMaskFrame && state.derivedMaskKey === cacheKey) return state.derivedPreviewMaskFrame;
  const engine = getTrackingEngine();
  const nextSample = state.samples.find((candidate) => candidate.time > sample.time + .001 && candidate.time - sample.time <= TRACK_STEP * 1.6);
  const interpolation = nextSample
    ? clamp((quantizedTime - sample.time) / Math.max(.001, nextSample.time - sample.time), 0, 1)
    : 0;
  const interpolatedBox = (record, fallback) => {
    const startBox = fallback;
    if (!nextSample || record.trackId == null) return startBox;
    const nextRecord = record.isTarget
      ? nextSample.target
      : nextSample.people?.find((person) => person.trackId === record.trackId);
    if (!nextRecord?.bbox) return startBox;
    return startBox.map((value, index) => value + (nextRecord.bbox[index] - value) * interpolation);
  };
  const currentPeople = sample.people || [];
  const masks = base.masks.map((record) => {
    let nextBox = null;
    if (record.isTarget) nextBox = interpolatedBox(record, sample.target.bbox);
    else if (record.trackId != null) {
      const currentRecord = currentPeople.find((person) => person.trackId === record.trackId);
      if (currentRecord?.bbox) nextBox = interpolatedBox(record, currentRecord.bbox);
    }
    // 预处理缓存每约 1 秒存一个新轮廓；无 Track ID 的新人在相邻缓存区间保留实例 Mask。
    if (!nextBox) return record;
    return { ...record, bbox: [...nextBox], mask: engine.warpCompactMask(record.mask, record.bbox, nextBox), propagated: true };
  }).filter(Boolean);
  const protectionBox = base.protectionBox || base.masks.find((record) => record.isTarget)?.bbox;
  const targetBox = interpolatedBox({ isTarget: true, trackId: sample.target.trackId }, sample.target.bbox);
  const protectionMask = protectionBox
    ? engine.warpCompactMask(base.protectionMask, protectionBox, targetBox)
    : base.protectionMask;
  const derived = {
    ...base,
    time,
    masks,
    protectionMask,
    protectionBox: [...targetBox],
    // 时间线插值只能继承原帧的安全状态，不能因为“有一个历史保护轮廓”
    // 就绕过目标 Mask 不完整/身份不确定检查。
    safeToApply: Boolean(protectionMask) && Boolean(base.safeToApply) && !base.targetMaskIncomplete,
  };
  derived.otherPeopleMask = buildOtherPeopleMask(derived);
  state.derivedMaskKey = cacheKey;
  state.derivedPreviewMaskFrame = derived;
  return derived;
}

function drawSilhouetteEffect(context, video, cropX, cropY, cropW, cropH, canvasWidth, canvasHeight, maskFrame) {
  if (!maskFrame.otherPeopleMask || !maskFrame.targetProtectionMask) return;
  mosaicResultCanvas.width = canvasWidth; mosaicResultCanvas.height = canvasHeight;
  const resultContext = mosaicResultCanvas.getContext("2d");
  resultContext.clearRect(0, 0, canvasWidth, canvasHeight);
  if (state.blurEffect === "gaussian") {
    resultContext.filter = `blur(${clamp(state.blurStrength, 8, 36)}px)`;
    resultContext.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvasWidth, canvasHeight);
    resultContext.filter = "none";
  } else if (state.blurEffect === "silhouette") {
    resultContext.fillStyle = "#17131d";
    resultContext.fillRect(0, 0, canvasWidth, canvasHeight);
  } else {
    const blockSize = clamp(Math.round(state.blurStrength), 8, 36);
    mosaicLowCanvas.width = Math.max(2, Math.ceil(canvasWidth / blockSize));
    mosaicLowCanvas.height = Math.max(2, Math.ceil(canvasHeight / blockSize));
    const lowContext = mosaicLowCanvas.getContext("2d");
    lowContext.clearRect(0, 0, mosaicLowCanvas.width, mosaicLowCanvas.height);
    lowContext.imageSmoothingEnabled = true;
    lowContext.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, mosaicLowCanvas.width, mosaicLowCanvas.height);
    resultContext.imageSmoothingEnabled = false;
    resultContext.drawImage(mosaicLowCanvas, 0, 0, mosaicLowCanvas.width, mosaicLowCanvas.height, 0, 0, canvasWidth, canvasHeight);
  }
  // 先对 final blur mask 羽化，再次扣掉 target protection mask。
  // 旧逻辑只在羽化前扣除一次，blur() 产生的 Alpha 会重新扩散到目标躯干和腿部。
  maskAlphaCanvas.width = canvasWidth; maskAlphaCanvas.height = canvasHeight;
  const alphaContext = maskAlphaCanvas.getContext("2d");
  alphaContext.clearRect(0, 0, canvasWidth, canvasHeight);
  alphaContext.imageSmoothingEnabled = false;
  alphaContext.filter = state.maskFeather > 0 ? `blur(${state.maskFeather}px)` : "none";
  alphaContext.drawImage(
    maskFrame.otherPeopleMask,
    cropX / maskFrame.frameWidth * maskFrame.otherPeopleMask.width,
    cropY / maskFrame.frameHeight * maskFrame.otherPeopleMask.height,
    cropW / maskFrame.frameWidth * maskFrame.otherPeopleMask.width,
    cropH / maskFrame.frameHeight * maskFrame.otherPeopleMask.height,
    0, 0, canvasWidth, canvasHeight,
  );
  alphaContext.filter = "none";
  maskProtectionCanvas.width = canvasWidth; maskProtectionCanvas.height = canvasHeight;
  const protectionContext = maskProtectionCanvas.getContext("2d");
  protectionContext.clearRect(0, 0, canvasWidth, canvasHeight);
  protectionContext.imageSmoothingEnabled = false;
  protectionContext.drawImage(
    maskFrame.targetProtectionMask,
    cropX / maskFrame.frameWidth * maskFrame.targetProtectionMask.width,
    cropY / maskFrame.frameHeight * maskFrame.targetProtectionMask.height,
    cropW / maskFrame.frameWidth * maskFrame.targetProtectionMask.width,
    cropH / maskFrame.frameHeight * maskFrame.targetProtectionMask.height,
    0, 0, canvasWidth, canvasHeight,
  );
  alphaContext.globalCompositeOperation = "destination-out";
  alphaContext.drawImage(maskProtectionCanvas, 0, 0);
  alphaContext.globalCompositeOperation = "source-over";

  resultContext.globalCompositeOperation = "destination-in";
  resultContext.imageSmoothingEnabled = true;
  resultContext.drawImage(maskAlphaCanvas, 0, 0);
  resultContext.globalCompositeOperation = "source-over";
  context.drawImage(mosaicResultCanvas, 0, 0);
}

async function ensureInstanceMasksForPreview(force = false, options = {}) {
  const video = $("#previewVideo");
  if (!state.blurOthers || !video.videoWidth) return null;
  if (state.maskBusy) return state.maskPromise;
  const refreshInterval = state.exporting ? .08 : .85;
  if (!force && Math.abs(video.currentTime - state.maskLastTime) < refreshInterval) return state.previewMaskFrame;
  const sample = smoothedTrackSample(video.currentTime);
  if (!sample?.target?.bbox || Math.abs(sample.time - video.currentTime) > Math.max(.8, TRACK_STEP * 2)) return null;
  state.maskBusy = true;
  const requestedTime = video.currentTime;
  state.maskLastTime = requestedTime;
  const task = (async () => {
    const maskFrame = await getTrackingEngine().instanceMasks(
      video,
      sample.people || [],
      sample.target.trackId,
      sample.target.bbox,
      {
        time: requestedTime,
        exportQuality: Boolean(options.exportQuality),
        previewQuality: Boolean(options.previewQuality ?? !options.exportQuality),
      },
    );
    if (maskFrame) {
      // 预览使用分析完成时对应的画面时间，不再把新 Mask 标成早已过期的开始时间。
      maskFrame.time = video.paused || options.exportQuality ? requestedTime : video.currentTime;
      maskFrame.otherPeopleMask = buildOtherPeopleMask(maskFrame);
      state.previewMaskFrame = maskFrame;
      if (!options.exportQuality) {
        state.previewMaskCache.push(maskFrame);
        state.previewMaskCache = state.previewMaskCache
          .sort((a, b) => a.time - b.time)
          .filter((frame, index, frames) => index === 0 || frame.time - frames[index - 1].time > .12)
          .slice(-18);
        state.derivedMaskKey = "";
      }
      if (!maskFrame.safeToApply) {
        if (!state.maskUncertainTimes.some((time) => Math.abs(time - requestedTime) < .4)) state.maskUncertainTimes.push(requestedTime);
        $("#blurValue").textContent = "目标不确定，已保护";
      } else {
        $("#blurValue").textContent = maskFrame.otherPeopleMask ? "轮廓生效" : "仅目标人物";
      }
    }
    drawPreviewFrame();
    return maskFrame;
  })();
  state.maskPromise = task;
  try {
    return await task;
  } catch (error) {
    console.warn("当前帧人物轮廓 Mask 生成失败", error);
    return null;
  } finally {
    state.maskBusy = false;
    if (state.maskPromise === task) state.maskPromise = null;
  }
}

function previewMaskSampleTimes() {
  const interval = 1.05;
  const times = new Set([state.trimStart, Math.max(state.trimStart, state.trimEnd - .001)]);
  for (let time = state.trimStart; time < state.trimEnd; time += interval) times.add(Math.min(time, state.trimEnd - .001));
  return [...times].sort((a, b) => a - b);
}

function preparePreviewMaskTimeline() {
  // 打码开关和播放按钮可能同时请求预处理。共用同一个 Promise，
  // 禁止两个任务轮流 seek 同一个 video 导致画面卡顿、Mask 与帧错位。
  if (state.maskPreparationPromise) return state.maskPreparationPromise;
  const task = runPreviewMaskTimeline();
  state.maskPreparationPromise = task;
  const releaseTask = () => {
    if (state.maskPreparationPromise === task) state.maskPreparationPromise = null;
  };
  task.then(releaseTask, releaseTask);
  return task;
}

async function runPreviewMaskTimeline() {
  const video = $("#previewVideo");
  if (!state.blurOthers || !video.videoWidth) return;
  const preparationId = ++state.maskPreparationId;
  const restoreTime = video.currentTime;
  video.pause();
  state.previewMasksReady = false;
  state.previewHasOtherPeopleMasks = false;
  state.previewMaskProgress = 0;
  state.previewMaskCache = [];
  state.derivedPreviewMaskFrame = null;
  state.derivedMaskKey = "";
  const times = previewMaskSampleTimes();
  const engine = getTrackingEngine();
  engine.resetMaskPropagation();
  state.maskDebugFrames = [];
  for (let index = 0; index < times.length; index += 1) {
    if (!state.blurOthers || preparationId !== state.maskPreparationId) return;
    const time = times[index];
    await seekVideo(video, time);
    const sample = smoothedTrackSample(time);
    if (sample?.target?.bbox) {
      try {
        // 跟踪样本主要用于目标轨迹，它未必包含每个后续入画人物。
        // 预览预处理在每个采样帧重新全画面检测，再把已知 Track ID 赋回人物。
        const detectedPeople = assignKnownTrackIds(
          await detectPeople(video, { detailed: true, focusBox: sample.target.bbox }),
          sample.people || [],
        );
        const frame = await engine.instanceMasks(
          video,
          detectedPeople,
          sample.target.trackId,
          sample.target.bbox,
          { time, previewQuality: true, allowTargetBoxMatch: segmentAt(time)?.status === "tracked" },
        );
        if (frame) {
          frame.time = time;
          frame.otherPeopleMask = buildOtherPeopleMask(frame);
          state.maskDebugFrames.push(frame.maskDiagnostics);
          state.previewMaskCache.push(frame);
          state.previewMaskFrame = frame;
        }
      } catch (error) {
        console.warn(`预览轮廓生成失败 ${formatTime(time)}`, error);
      }
    }
    state.previewMaskProgress = (index + 1) / times.length;
    $("#blurValue").textContent = `轮廓 ${Math.round(state.previewMaskProgress * 100)}%`;
    await sleep(0);
  }
  if (!state.blurOthers || preparationId !== state.maskPreparationId) return;
  state.previewMaskCache.sort((a, b) => a.time - b.time);
  // ready 代表时间线扫描已完成；是否真的找到其他人要单独判断。
  // 旧逻辑只要生成了“目标人物”轮廓就显示就绪，会造成按钮已开启但旁人没有打码。
  state.previewMasksReady = true;
  state.previewHasOtherPeopleMasks = state.previewMaskCache.some((frame) => (
    frame.safeToApply && frame.masks.some((record) => !record.isTarget && record.mask?.data)
  ));
  await seekVideo(video, clamp(restoreTime, state.trimStart, state.trimEnd));
  state.previewMaskFrame = closestMaskFrame(state.previewMaskCache, video.currentTime);
  $("#blurValue").textContent = state.previewHasOtherPeopleMasks ? "轮廓已就绪" : "未识别到其他人";
  drawPreviewFrame();
  showToast(
    state.previewHasOtherPeopleMasks
      ? "旁人轮廓已生成，现在可流畅播放预览"
      : "当前视频没有识别到可打码的其他人",
    3600,
  );
}

function exportMaskSampleTimes() {
  const times = new Set([state.trimStart, Math.max(state.trimStart, state.trimEnd - .001)]);
  // 导出使用高质量实例 Mask，再根据 Track 轨迹向中间帧传播；
  // 浏览器端如果每 0.16 秒跑一次高精度分割，30 秒视频会耗时过长且占用大量内存。
  const interval = .45;
  for (let time = state.trimStart; time < state.trimEnd; time += interval) times.add(Math.min(time, state.trimEnd - .001));
  state.samples.forEach((sample) => {
    if (sample.time >= state.trimStart && sample.time <= state.trimEnd) times.add(sample.time);
  });
  return [...times].sort((a, b) => a - b);
}

function assignKnownTrackIds(detectedPeople, trackedPeople = []) {
  if (!trackedPeople.length || !window.TrackingMath?.hungarian) return detectedPeople;
  const costs = detectedPeople.map((detected) => trackedPeople.map((tracked) => 1 - iou(detected.bbox, tracked.bbox)));
  window.TrackingMath.hungarian(costs).forEach(([detectedIndex, trackedIndex]) => {
    const overlap = iou(detectedPeople[detectedIndex].bbox, trackedPeople[trackedIndex].bbox);
    if (overlap >= .18) detectedPeople[detectedIndex].trackId = trackedPeople[trackedIndex].trackId;
  });
  return detectedPeople;
}

async function precomputeExportMasks(video, onProgress) {
  if (!state.blurOthers) return;
  const times = exportMaskSampleTimes();
  const cache = [];
  state.maskUncertainTimes = [];
  const engine = getTrackingEngine();
  engine.resetMaskPropagation();
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index];
    await seekVideo(video, time);
    const sample = smoothedTrackSample(time);
    if (!sample?.target?.bbox) continue;
    try {
      // 对导出时间线重新检测所有人物，使用 MOT/Re-ID 的稳定 Track ID 赋给实例 Mask。
      const detectedPeople = assignKnownTrackIds(
        await detectPeople(video, { detailed: true, focusBox: sample.target.bbox }),
        sample.people || [],
      );
      const frame = await engine.instanceMasks(
        video,
        detectedPeople,
        sample.target.trackId,
        sample.target.bbox,
        { time, exportQuality: true, allowTargetBoxMatch: segmentAt(time)?.status === "tracked" },
      );
      if (frame) {
        frame.time = time;
        frame.otherPeopleMask = buildOtherPeopleMask(frame);
        cache.push(frame);
        if (frame.maskDiagnostics?.finalTargetIntersectionPixels !== 0) {
          throw new Error(`最终打码 Mask 与目标保护 Mask 交集不为 0（${frame.maskDiagnostics?.finalTargetIntersectionPixels}）`);
        }
        if (!frame.safeToApply || frame.identityState === "uncertain" || frame.occlusionUncertain
          || (segmentAt(time)?.status !== "tracked" && frame.protectionIsHistorical)) {
          state.maskUncertainTimes.push(time);
        }
      }
    } catch (error) {
      console.warn(`导出 Mask 预计算失败 ${formatTime(time)}`, error);
      state.maskUncertainTimes.push(time);
    }
    onProgress?.((index + 1) / times.length);
    await sleep(0);
  }
  state.exportMaskCache = cache;
  const uncertainRatio = state.maskUncertainTimes.length / Math.max(1, times.length);
  if (!cache.length) throw new Error("未生成可用的人物轮廓，请先返回关键帧确认目标人物");
  if (uncertainRatio > .08) {
    throw new Error(`有 ${Math.round(uncertainRatio * 100)}% 时间点的目标身份不确定，已停止打码导出；请回到跟踪页在对应时间点重新选择正确人物`);
  }
}

function applyCachedExportMask(time) {
  if (!state.exportMaskCache.length) return;
  let nearest = state.exportMaskCache[0];
  for (const frame of state.exportMaskCache) {
    if (Math.abs(frame.time - time) < Math.abs(nearest.time - time)) nearest = frame;
  }
  state.previewMaskFrame = nearest;
}

function previewLoop() {
  if (state.exporting && state.blurOthers) applyCachedExportMask($("#previewVideo").currentTime);
  const now = performance.now();
  // Canvas 中包含裁剪、马赛克和 Mask 合成，预览限制在约 30fps，避免 60fps 重复绘制抢占视频解码。
  if (now - state.lastPreviewPaintAt >= 30) {
    state.lastPreviewPaintAt = now;
    drawPreviewFrame();
  }
  if (!$("#previewVideo").paused) window.requestAnimationFrame(previewLoop);
}

async function waitForPresentedVideoFrame(video, timeoutMs = 420) {
  if (!video || video.paused || typeof video.requestVideoFrameCallback !== "function") return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    video.requestVideoFrameCallback(finish);
  });
}

$("#previewPlay").addEventListener("click", async () => {
  const video = $("#previewVideo");
  if (video.paused) {
    if (video.currentTime < state.trimStart || video.currentTime >= state.trimEnd) video.currentTime = state.trimStart;
    if (state.musicEngine?.result) state.musicEngine.applyVideoVolume(video, state.trimStart);
    else { video.muted = false; video.volume = 1; }
    try {
      if (state.blurOthers && !state.previewMasksReady) {
        await preparePreviewMaskTimeline();
      }
      await video.play();
      // iPhone 的 play() Promise 可能早于首个画面帧真正呈现。
      // 等视频时钟开始走动后再启动配乐，避免手机端音乐抢跑。
      await waitForPresentedVideoFrame(video);
      if (!video.paused && state.musicEngine?.confirmed) await state.musicEngine.startPreview(video, state.trimStart);
    } catch (_) { showToast("请再点一次播放"); }
  } else {
    video.pause();
    state.musicEngine?.stopPreview();
  }
  updatePreviewPlayControl();
  if (!video.paused) previewLoop();
});
function updatePreviewPlayControl() {
  const playing = !$("#previewVideo").paused;
  $("#previewPlay").classList.toggle("playing", playing);
  $("#previewPlay span").textContent = playing ? "Ⅱ" : "▶";
  $("#previewPlay b").textContent = playing ? "暂停预览" : "播放预览";
}
$("#previewVideo").addEventListener("play", updatePreviewPlayControl);
$("#previewVideo").addEventListener("pause", () => {
  state.musicEngine?.stopPreview();
  updatePreviewPlayControl();
});
$("#previewVideo").addEventListener("seeking", () => {
  // 拖动视频时立即停止旧的音乐源，避免它继续播放拖动前的位置。
  state.musicEngine?.stopPreview();
});
$("#previewVideo").addEventListener("seeked", async () => {
  drawPreviewFrame();
  // 视频停在新位置后，按时间线固定关系重新定位提取音轨。
  if (!$("#previewVideo").paused && state.musicEngine?.confirmed) {
    await waitForPresentedVideoFrame($("#previewVideo"));
    if (!$("#previewVideo").paused) await state.musicEngine.startPreview($("#previewVideo"), state.trimStart);
  }
});
$("#previewVideo").addEventListener("timeupdate", () => {
  const video = $("#previewVideo");
  if (video.currentTime >= state.trimEnd) {
    video.pause();
    updatePreviewPlayControl();
  }
  $("#previewTime").textContent = formatTime(video.currentTime);
  $("#previewScrubber").value = video.currentTime;
  state.musicEngine?.syncPreview(video, state.trimStart).catch(() => {});
  drawPreviewFrame();
});
$("#previewScrubber").addEventListener("input", (event) => {
  $("#previewVideo").currentTime = Number(event.target.value);
  $("#previewTime").textContent = formatTime(Number(event.target.value));
});
$("#previewScrubber").addEventListener("change", async () => {
  drawPreviewFrame();
  if (!$("#previewVideo").paused) await state.musicEngine?.syncPreview($("#previewVideo"), state.trimStart, true);
});

$("#exportButton").addEventListener("click", exportLocalVideo);
let previewAudioCapture = null;
async function addVideoAudioToStream(video, canvasStream) {
  const capture = video.captureStream || video.webkitCaptureStream;
  if (typeof capture === "function") {
    const sourceStream = capture.call(video);
    sourceStream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));
    return;
  }
  // Safari 没有 HTMLVideoElement.captureStream 时，用 Web Audio 把原视频音轨送入编码流。
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  if (!previewAudioCapture) {
    const context = new AudioContextClass();
    const source = context.createMediaElementSource(video);
    const destination = context.createMediaStreamDestination();
    source.connect(destination);
    source.connect(context.destination);
    previewAudioCapture = { context, source, destination };
  }
  await previewAudioCapture.context.resume();
  previewAudioCapture.destination.stream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));
}

async function exportLocalVideo() {
  if (state.exporting) return;
  const canvas = $("#previewCanvas");
  const video = $("#previewVideo");
  if (!canvas.captureStream || !window.MediaRecorder) {
    showToast("当前浏览器不支持本地编码，请用新版 Safari / Chrome", 4200);
    return;
  }
  state.exporting = true;
  const button = $("#exportButton");
  button.textContent = "导出 0%";
  try {
    state.musicEngine?.stopPreview();
    await seekVideo(video, state.trimStart);
    state.lastPreviewCenter = null;
    state.exportMaskCache = [];
    if (state.blurOthers) {
      button.textContent = "分析轮廓 0%";
      await precomputeExportMasks(video, (progress) => {
        button.textContent = `分析轮廓 ${Math.round(progress * 100)}%`;
      });
      await seekVideo(video, state.trimStart);
      applyCachedExportMask(state.trimStart);
    }
    drawPreviewFrame();
    const canvasStream = canvas.captureStream(30);
    // 中间视频保留现场原音，最后一步由 FFmpeg 替换或混合对齐音乐。
    video.muted = false;
    video.volume = 1;
    await addVideoAudioToStream(video, canvasStream);
    const stream = canvasStream;
    const mimeCandidates = ["video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const mimeType = mimeCandidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
    // 以源文件平均码率为基准并留出 35% 编码余量，避免旧版固定 8 Mbps 带来的明显体积/画质下降。
    const sourceBitrate = state.sourceBitrate || 20_000_000;
    const exportBitrate = Math.round(clamp(sourceBitrate * 1.35, 20_000_000, 80_000_000));
    const recorderOptions = { videoBitsPerSecond: exportBitrate, audioBitsPerSecond: 256_000 };
    if (mimeType) recorderOptions.mimeType = mimeType;
    const recorder = new MediaRecorder(stream, recorderOptions);
    const chunks = [];
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
    const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
    recorder.start(1000);
    video.muted = false;
    video.volume = 1;
    await video.play();
    previewLoop();
    await new Promise((resolve) => {
      const timer = window.setInterval(() => {
        const percent = (video.currentTime - state.trimStart) / Math.max(.01, state.trimEnd - state.trimStart) * 100;
        button.textContent = `导出 ${Math.round(clamp(percent, 0, 100))}%`;
        if (video.currentTime >= state.trimEnd - .04 || video.ended) {
          window.clearInterval(timer);
          video.pause();
          resolve();
        }
      }, 120);
    });
    recorder.stop();
    await stopped;
    const intermediateBlob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
    let blob = intermediateBlob;
    let extension = (recorder.mimeType || "").includes("mp4") ? "mp4" : "webm";
    if (state.musicEngine?.confirmed) {
      button.textContent = "音轨合成 5%";
      blob = await state.musicEngine.muxProcessedVideo(
        intermediateBlob,
        state.trimEnd - state.trimStart,
        (progress) => { button.textContent = `音轨合成 ${Math.round(progress * 100)}%`; },
      );
      extension = "mp4";
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `DanceFocus-${Date.now()}.${extension}`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 15000);
    showToast(`已按源画面像素和高码率导出${state.musicEngine?.confirmed ? "，已使用对齐后的干净音乐" : ""}（${(blob.size / 1024 / 1024).toFixed(1)} MB）`, 5200);
  } catch (error) {
    console.error(error);
    showToast(error?.message ? `本地导出中断：${error.message}` : "本地导出中断，请保持页面在前台", 5200);
  } finally {
    state.exporting = false;
    state.exportMaskCache = [];
    state.lastPreviewCenter = null;
    drawPreviewFrame();
    if (state.musicEngine?.result) state.musicEngine.applyVideoVolume(video, state.trimStart);
    button.textContent = "导出";
  }
}

applyPreviewSettings();
showPage(1, false);

// PWA 层通过事件复用现有 Toast，不需要访问或复制编辑器内部状态。
window.addEventListener("dancefocus:pwa-status", (event) => {
  if (event.detail?.message) showToast(event.detail.message, event.detail.duration || 3600);
});

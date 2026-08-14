/* DanceFocus PWA：只缓存程序和本地 AI 模型，绝不读取或缓存用户选择的视频 Blob。 */
const VERSION = "dancefocus-pwa-20260814-1";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./mask-config.js",
  "./mask-compositor.js",
  "./tracking-engine.js",
  "./audio/audio-alignment-core.js",
  "./audio/reference-music-engine.js",
  "./workers/audio-analysis.worker.js",
  "./vendor/tf.min.js",
  "./vendor/coco-ssd.min.js",
  "./vendor/body-pix.min.js",
  "./vendor/ffmpeg/ffmpeg.js",
  "./vendor/ffmpeg/814.ffmpeg.js",
  "./vendor/ffmpeg/ffmpeg-core.js",
  "./app.js",
  "./pwa.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("dancefocus-pwa-") && ![SHELL_CACHE, RUNTIME_CACHE].includes(key))
      .map((key) => caches.delete(key)),
  )).then(() => self.clients.claim()));
});

function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false;
  const path = url.pathname;
  return /\.(?:js|css|json|webmanifest|wasm|bin|png|svg)$/i.test(path)
    || /\/(?:model|reid-model|bodypix-model|vendor|workers|audio)\//.test(path);
}

function isHeavyRuntimeAsset(url) {
  return /\/vendor\/ffmpeg\/ffmpeg-core\.wasm$/i.test(url.pathname)
    || /\/(?:model|reid-model|bodypix-model)\//.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.url.startsWith("blob:") || request.url.startsWith("data:")) return;
  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(SHELL_CACHE).then((cache) => cache.put("./index.html", response.clone()));
      return response;
    }).catch(() => caches.match("./index.html")));
    return;
  }

  if (!isCacheableAsset(url)) return;
  // 模型权重和 FFmpeg WASM 体积较大：首次真正使用对应功能时再下载并缓存，
  // 避免 iPhone 第一次打开就在安装阶段强制写入约 50MB 导致 Service Worker 超时。
  if (isHeavyRuntimeAsset(url)) {
    event.respondWith(caches.match(request, { ignoreSearch: true }).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok && response.type === "basic") {
        caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    })));
    return;
  }
  event.respondWith(caches.match(request, { ignoreSearch: true }).then((cached) => {
    if (cached) return cached;
    return fetch(request).then((response) => {
      if (response.ok && response.type === "basic") {
        caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    });
  }));
});

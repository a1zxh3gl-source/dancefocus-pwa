(function initDanceFocusPwa(global) {
  "use strict";

  const notify = (message, duration) => global.dispatchEvent(new CustomEvent("dancefocus:pwa-status", {
    detail: { message, duration },
  }));

  if (!("serviceWorker" in navigator) || !global.isSecureContext) return;

  global.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            notify("舞焦已更新，下次打开将使用新版本", 4200);
          }
        });
      });
    } catch (error) {
      console.warn("PWA 离线缓存注册失败", error);
    }
  }, { once: true });

  global.addEventListener("offline", () => notify("当前已离线，已缓存功能仍可继续使用", 4200));
  global.addEventListener("online", () => notify("网络已恢复", 2400));
})(window);

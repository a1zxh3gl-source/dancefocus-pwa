(function initDanceMaskConfig(global) {
  "use strict";

  // 这些值均以源视频像素或秒为单位，合成时会换算到紧凑 Mask 分辨率。
  // 目标保护和其他人扩张必须分开，不能共用一个“轮廓扩张”参数。
  const config = Object.freeze({
    target_mask_dilation: 8,
    others_mask_dilation: 5,
    mask_feather_radius: 3,
    // 仅保留很短的同 Track 历史，避免快速舞动时旧轮廓拖影到相邻人物。
    mask_temporal_smoothing: 0.42,
    occlusion_confidence_threshold: 0.62,
  });

  global.DANCE_MASK_CONFIG = config;
  if (typeof module !== "undefined" && module.exports) module.exports = config;
})(typeof window !== "undefined" ? window : globalThis);

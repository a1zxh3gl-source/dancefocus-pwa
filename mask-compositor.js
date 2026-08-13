(function initMaskCompositor(global) {
  "use strict";

  function dilateBinaryMask(source, width, height, radius) {
    const safeRadius = Math.max(0, Math.round(radius || 0));
    if (!safeRadius) return new Uint8Array(source);
    const output = new Uint8Array(source.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!source[y * width + x]) continue;
        for (let dy = -safeRadius; dy <= safeRadius; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          const reach = Math.floor(Math.sqrt(Math.max(0, safeRadius * safeRadius - dy * dy)));
          for (let dx = -reach; dx <= reach; dx += 1) {
            const xx = x + dx;
            if (xx >= 0 && xx < width) output[yy * width + xx] = 255;
          }
        }
      }
    }
    return output;
  }

  function fillSmallMaskHoles(source, width, height, maximumAreaRatio = .0025) {
    const output = new Uint8Array(source);
    const visited = new Uint8Array(source.length);
    const maximumHoleArea = Math.max(6, Math.round(width * height * maximumAreaRatio));
    for (let start = 0; start < source.length; start += 1) {
      if (source[start] || visited[start]) continue;
      const queue = [start]; const component = [];
      visited[start] = 1;
      let touchesBorder = false;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor]; component.push(index);
        const x = index % width; const y = Math.floor(index / width);
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
        [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].forEach(([nx, ny]) => {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
          const neighbor = ny * width + nx;
          if (source[neighbor] || visited[neighbor]) return;
          visited[neighbor] = 1; queue.push(neighbor);
        });
      }
      if (!touchesBorder && component.length <= maximumHoleArea) {
        component.forEach((index) => { output[index] = 255; });
      }
    }
    return output;
  }

  function unionMasks(masks, length) {
    const union = new Uint8Array(length);
    masks.forEach((mask) => {
      if (!mask || mask.length !== length) return;
      for (let index = 0; index < length; index += 1) {
        if (mask[index]) union[index] = 255;
      }
    });
    return union;
  }

  function intersectionPixelCount(left, right) {
    if (!left || !right || left.length !== right.length) return Infinity;
    let count = 0;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] && right[index]) count += 1;
    }
    return count;
  }

  function composeFinalBlurMask({
    otherMasks,
    targetMask,
    width,
    height,
    targetDilation = 0,
    othersDilation = 0,
  }) {
    const length = width * height;
    if (!targetMask || targetMask.length !== length) throw new Error("target protection mask size mismatch");
    const completedOthers = (otherMasks || []).filter((mask) => mask?.length === length).map((mask) => (
      fillSmallMaskHoles(dilateBinaryMask(mask, width, height, othersDilation), width, height)
    ));
    const othersVisibleMask = unionMasks(completedOthers, length);
    const targetProtectionMask = fillSmallMaskHoles(
      dilateBinaryMask(targetMask, width, height, targetDilation), width, height,
    );
    const finalBlurMask = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      if (othersVisibleMask[index] && !targetProtectionMask[index]) finalBlurMask[index] = 255;
    }
    const intersectionPixels = intersectionPixelCount(finalBlurMask, targetProtectionMask);
    if (intersectionPixels !== 0) throw new Error(`final/target mask intersection: ${intersectionPixels}`);
    return { othersVisibleMask, targetProtectionMask, finalBlurMask, intersectionPixels };
  }

  // 用于回归测试：先对 final mask 做简化羽化，再严格扣掉保护区。
  // Canvas 实现也必须保持相同的先后顺序。
  function featherThenProtect(finalMask, targetProtectionMask, width, height, radius) {
    if (!radius) return new Uint8Array(finalMask);
    const output = new Uint8Array(finalMask.length);
    const safeRadius = Math.max(1, Math.round(radius));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (targetProtectionMask[index]) continue;
        let sum = 0; let samples = 0;
        for (let dy = -safeRadius; dy <= safeRadius; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -safeRadius; dx <= safeRadius; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            sum += finalMask[yy * width + xx]; samples += 1;
          }
        }
        output[index] = Math.round(sum / Math.max(1, samples));
      }
    }
    return output;
  }

  const api = {
    dilateBinaryMask,
    fillSmallMaskHoles,
    unionMasks,
    intersectionPixelCount,
    composeFinalBlurMask,
    featherThenProtect,
  };
  global.MaskCompositor = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

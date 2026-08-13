importScripts("../audio/audio-alignment-core.js");

self.onmessage = ({ data }) => {
  if (data.type !== "align") return;
  try {
    const classroom = new Float32Array(data.classroom);
    const reference = new Float32Array(data.reference);
    const result = self.AudioAlignmentCore.alignAudio(classroom, reference, data.sampleRate, data.options || {});
    self.postMessage({ type: "result", result });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || String(error), stack: error?.stack || "" });
  }
};

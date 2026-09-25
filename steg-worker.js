/**
 * steg-worker.js
 *
 * Runs the (potentially expensive) steganalysis computation off the main
 * thread so the UI stays responsive while a large image is analyzed.
 *
 * Protocol:
 *   postMessage({ data: <ArrayBuffer of RGBA bytes>, width, height })
 *   -> worker responds with either
 *        { ok: true, result: <analyzeImageSteganalysis() output> }
 *      or
 *        { ok: false, error: <string> }
 *
 * The RGBA buffer is sent as a transferable ArrayBuffer (not copied) to
 * avoid duplicating potentially large pixel buffers.
 */

importScripts("lens-steg.js");

self.onmessage = function (e) {
  const { data, width, height } = e.data;
  try {
    const pixelData = { data: new Uint8ClampedArray(data), width, height };
    const result = self.LensSteg.analyzeImageSteganalysis(pixelData);
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: (err && err.message) || "Steganalysis failed unexpectedly." });
  }
};

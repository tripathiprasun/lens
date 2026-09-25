const test = require("node:test");
const assert = require("node:assert/strict");
const LensCore = require("../lens-core.js");

test("detects JPEG signature", () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const sig = LensCore.detectSignature(bytes);
  assert.equal(sig.id, "jpeg");
});

test("detects BMP signature", () => {
  const bytes = new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0]);
  const sig = LensCore.detectSignature(bytes);
  assert.equal(sig.id, "bmp");
});

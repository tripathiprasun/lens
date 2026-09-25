const test = require("node:test");
const assert = require("node:assert/strict");
const LensCore = require("../lens-core.js");

// ---------------------------------------------------------------------
// Signature detection
// ---------------------------------------------------------------------

test("detects JPEG signature", () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const sig = LensCore.detectSignature(bytes);
  assert.equal(sig.id, "jpeg");
});

test("detects PNG signature", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const sig = LensCore.detectSignature(bytes);
  assert.equal(sig.id, "png");
});

test("detects PDF signature", () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\n%rest of file");
  const sig = LensCore.detectSignature(bytes);
  assert.equal(sig.id, "pdf");
});

test("detects ZIP signature (local file header)", () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const sig = LensCore.detectSignature(bytes);
  assert.equal(sig.id, "zip");
});

test("detects WebP (RIFF container, needs two offsets)", () => {
  const bytes = new Uint8Array(16);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  const sig = LensCore.detectSignature(bytes);
  assert.equal(sig.id, "webp");
});

test("distinguishes WAV from WebP despite shared RIFF prefix", () => {
  const bytes = new Uint8Array(16);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  const sig = LensCore.detectSignature(bytes);
  assert.equal(sig.id, "wav");
});

test("returns null for an unknown/unrecognized signature", () => {
  const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  const sig = LensCore.detectSignature(bytes);
  assert.equal(sig, null);
});

test("does not throw on a very short buffer", () => {
  const bytes = new Uint8Array([0xff]);
  assert.doesNotThrow(() => LensCore.detectSignature(bytes));
});

test("does not throw on an empty buffer", () => {
  assert.doesNotThrow(() => LensCore.detectSignature(new Uint8Array(0)));
});

// ---------------------------------------------------------------------
// Extension / signature mismatch
// ---------------------------------------------------------------------

test("flags a match when extension agrees with signature", () => {
  const sig = { extensions: ["png"] };
  const result = LensCore.checkExtensionMatch("png", sig);
  assert.equal(result.status, "match");
});

test("flags a mismatch when a PNG is renamed to .txt", () => {
  const sig = { label: "PNG", extensions: ["png"] };
  const result = LensCore.checkExtensionMatch("txt", sig);
  assert.equal(result.status, "mismatch");
  assert.match(result.message, /PNG/);
});

test("is case-insensitive and tolerates a leading dot", () => {
  const sig = { label: "PNG", extensions: ["png"] };
  const result = LensCore.checkExtensionMatch(".PNG", sig);
  assert.equal(result.status, "match");
});

test("reports unknown when there is no detected signature", () => {
  const result = LensCore.checkExtensionMatch("dat", null);
  assert.equal(result.status, "unknown");
});

// ---------------------------------------------------------------------
// Entropy
// ---------------------------------------------------------------------

test("entropy of all-identical bytes is 0", () => {
  const bytes = new Uint8Array(256).fill(0x41);
  assert.equal(LensCore.calculateEntropy(bytes), 0);
});

test("entropy of a uniform byte distribution approaches 8", () => {
  const bytes = new Uint8Array(256 * 50);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const entropy = LensCore.calculateEntropy(bytes);
  assert.ok(entropy > 7.99, `expected near-max entropy, got ${entropy}`);
});

test("entropy of empty input is 0 and does not throw", () => {
  assert.equal(LensCore.calculateEntropy(new Uint8Array(0)), 0);
});

test("entropyLabel returns a string for any valid score", () => {
  for (const val of [0, 2, 5, 7.9, 8]) {
    assert.equal(typeof LensCore.entropyLabel(val), "string");
  }
});

// ---------------------------------------------------------------------
// Hex dump formatting
// ---------------------------------------------------------------------

test("hex dump includes offset, hex bytes, and ASCII column", () => {
  const bytes = new TextEncoder().encode("Hello!!");
  const dump = LensCore.formatHexDump(bytes);
  assert.match(dump, /^00000000/);
  assert.match(dump, /48 65 6C 6C 6F/i);
  assert.match(dump, /Hello!!/);
});

test("hex dump renders non-printable bytes as dots in the ASCII column", () => {
  const bytes = new Uint8Array([0x00, 0x01, 0xff, 0x41]);
  const dump = LensCore.formatHexDump(bytes);
  assert.match(dump, /\.\.\.A/);
});

test("hex dump handles a buffer shorter than one row", () => {
  const bytes = new Uint8Array([0x41, 0x42]);
  assert.doesNotThrow(() => LensCore.formatHexDump(bytes));
});

// ---------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------

test("formatBytes renders human-readable sizes", () => {
  assert.equal(LensCore.formatBytes(0), "0 B");
  assert.equal(LensCore.formatBytes(512), "512 B");
  assert.equal(LensCore.formatBytes(1024), "1.00 KB");
  assert.equal(LensCore.formatBytes(1024 * 1024 * 3), "3.00 MB");
});

test("bytesToHexString produces lowercase hex with no separators", () => {
  const bytes = new Uint8Array([0x00, 0xff, 0x0a]);
  assert.equal(LensCore.bytesToHexString(bytes), "00ff0a");
});

test("buildReport assembles a plain, JSON-serializable object", () => {
  const report = LensCore.buildReport({
    generatedAt: "2026-01-01T00:00:00.000Z",
    name: "photo.jpg",
    extension: "jpg",
    sizeBytes: 2048,
    mimeType: "image/jpeg",
    lastModified: "2026-01-01",
    signature: { label: "JPEG" },
    extensionMatch: { status: "match", message: "ok" },
    hashes: { sha256: "abc" },
    entropy: 7.123456,
  });
  assert.equal(report.file.name, "photo.jpg");
  assert.equal(report.signature.detected_type, "JPEG");
  assert.equal(report.entropy, 7.1235);
  assert.doesNotThrow(() => JSON.stringify(report));
});

// ---------------------------------------------------------------------
// Malformed input handling
// ---------------------------------------------------------------------

test("parseJpegExif returns null for a non-JPEG file", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  assert.equal(LensCore.parseJpegExif(bytes), null);
});

test("parseJpegExif does not throw on a JPEG with no EXIF segment", () => {
  // Minimal valid-looking JPEG: SOI, then straight to EOI, no APP1.
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  assert.doesNotThrow(() => LensCore.parseJpegExif(bytes));
  assert.equal(LensCore.parseJpegExif(bytes), null);
});

test("parseJpegExif does not throw on a truncated/malformed APP1 segment", () => {
  // SOI, then an APP1 marker claiming a large length but with no real data.
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0xff, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  assert.doesNotThrow(() => LensCore.parseJpegExif(bytes));
});

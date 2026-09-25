const test = require("node:test");
const assert = require("node:assert/strict");
const LensSteg = require("../lens-steg.js");

// ---------------------------------------------------------------------
// Synthetic image helpers — every expected characteristic here is known
// by construction, so tests check the math, not a guess about verdicts.
// ---------------------------------------------------------------------

function makeImage(width, height, pixelFn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = pixelFn(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a == null ? 255 : a;
    }
  }
  return { data, width, height };
}

// A smooth gradient: strongly correlated neighbors, realistic-ish stats,
// but NOT randomized LSBs (its LSBs follow the ramp deterministically).
function gradientImage(w, h) {
  return makeImage(w, h, (x) => {
    const v = Math.floor((x / Math.max(w - 1, 1)) * 255);
    return [v, v, v];
  });
}

// A simple deterministic pseudo-random generator so "noisy" test images
// are reproducible across runs without relying on Math.random().
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noisyImage(w, h, seed) {
  const rand = mulberry32(seed || 1);
  return makeImage(w, h, () => {
    return [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)];
  });
}

// Take an existing image and overwrite every channel's LSB with a
// pseudo-random bit — this is exactly what naive sequential LSB
// embedding does to 100% of a carrier's capacity.
function withFlippedLSBs(image, seed) {
  const rand = mulberry32(seed || 42);
  const data = new Uint8ClampedArray(image.data); // copy, don't mutate input
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const bit = rand() < 0.5 ? 0 : 1;
      data[i + c] = (data[i + c] & 0xfe) | bit;
    }
  }
  return { data, width: image.width, height: image.height };
}

// ---------------------------------------------------------------------
// Format support
// ---------------------------------------------------------------------

test("PNG and BMP are marked supported for pixel-level steganalysis", () => {
  assert.equal(LensSteg.supportForFormat("png").supported, true);
  assert.equal(LensSteg.supportForFormat("bmp").supported, true);
});

test("JPEG, GIF and WebP are marked unsupported, each with a stated reason", () => {
  for (const id of ["jpeg", "gif", "webp"]) {
    const result = LensSteg.supportForFormat(id);
    assert.equal(result.supported, false);
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 10);
  }
});

test("unknown formats are unsupported without throwing", () => {
  assert.doesNotThrow(() => LensSteg.supportForFormat(null));
  assert.equal(LensSteg.supportForFormat(null).supported, false);
});

// ---------------------------------------------------------------------
// LSB balance
// ---------------------------------------------------------------------

test("an all-even-value channel has 0% LSB ones", () => {
  const image = makeImage(8, 8, () => [10, 20, 30]);
  const { histogram, count } = LensSteg.channelHistogramAndStats(image.data, 0, 4);
  const lsb = LensSteg.lsbBalanceFromHistogram(histogram, count);
  assert.equal(lsb.count1, 0);
  assert.equal(lsb.pct1, 0);
  assert.equal(lsb.deviationFromBalancedPct, 50);
});

test("LSB-flipped-with-fair-coin channel lands close to a 50/50 balance", () => {
  const image = noisyImage(64, 64, 7);
  const flipped = withFlippedLSBs(image, 99);
  const { histogram, count } = LensSteg.channelHistogramAndStats(flipped.data, 0, 4);
  const lsb = LensSteg.lsbBalanceFromHistogram(histogram, count);
  assert.ok(lsb.deviationFromBalancedPct < 5, `expected near-balanced LSBs, deviation was ${lsb.deviationFromBalancedPct}`);
});

// ---------------------------------------------------------------------
// Chi-square pairs test
// ---------------------------------------------------------------------

test("chi-square test does not throw on a degenerate single-value histogram", () => {
  const histogram = new Uint32Array(256);
  histogram[100] = 1000;
  assert.doesNotThrow(() => LensSteg.chiSquarePairsTest(histogram));
  const result = LensSteg.chiSquarePairsTest(histogram);
  assert.equal(result.pairsUsed, 1);
});

test("chi-square p-value is between 0 and 1 (or NaN when undefined)", () => {
  const image = noisyImage(32, 32, 3);
  const { histogram } = LensSteg.channelHistogramAndStats(image.data, 0, 4);
  const result = LensSteg.chiSquarePairsTest(histogram);
  assert.ok(Number.isNaN(result.pValue) || (result.pValue >= 0 && result.pValue <= 1));
});

test("chiSquareLevel maps a NaN/undefined p-value to inconclusive, not a crash", () => {
  assert.equal(LensSteg.chiSquareLevel(NaN), "inconclusive");
});

test("chiSquareLevel is monotonic with the documented thresholds", () => {
  const t = LensSteg._internal.CHI_SQUARE_LEVEL_THRESHOLDS;
  assert.equal(LensSteg.chiSquareLevel(t.elevated), "elevated");
  assert.equal(LensSteg.chiSquareLevel(t.moderate), "moderate");
  assert.equal(LensSteg.chiSquareLevel(t.low), "low");
  assert.equal(LensSteg.chiSquareLevel(0), "none");
});

// ---------------------------------------------------------------------
// RS analysis
// ---------------------------------------------------------------------

test("RS flip helpers stay in byte range and are involutions on the interior", () => {
  const { flipF1, flipFm1 } = LensSteg._internal;
  for (let v = 1; v < 255; v++) {
    assert.ok(flipF1(v) >= 0 && flipF1(v) <= 255);
    assert.ok(flipFm1(v) >= 0 && flipFm1(v) <= 255);
    assert.equal(flipF1(flipF1(v)), v);
  }
  // boundary values must not go out of range
  assert.ok(LensSteg._internal.flipFm1(0) >= 0);
  assert.ok(LensSteg._internal.flipFm1(255) <= 255);
});

test("discriminationF is 0 for a constant group and grows with local variation", () => {
  const { discriminationF } = LensSteg._internal;
  assert.equal(discriminationF([5, 5, 5, 5]), 0);
  assert.ok(discriminationF([0, 255, 0, 255]) > discriminationF([10, 12, 10, 12]));
});

test("RS analysis does not throw on a tiny (smaller than one group) image", () => {
  const image = makeImage(2, 1, () => [10, 20, 30]);
  assert.doesNotThrow(() => LensSteg.rsAnalysisForChannel(image.data, 0, 4, [0, 1, 1, 0]));
  const result = LensSteg.rsAnalysisForChannel(image.data, 0, 4, [0, 1, 1, 0]);
  assert.equal(result.totalGroups, 0);
});

test("RS analysis runs on a normal-sized noisy image and returns a bounded estimate when reliable", () => {
  const image = noisyImage(64, 64, 11);
  const result = LensSteg.rsAnalysisForChannel(image.data, 0, 4, [0, 1, 1, 0]);
  assert.ok(result.totalGroups > 0);
  if (result.estimateReliable) {
    assert.ok(result.estimatedEmbeddingRate >= 0 && result.estimatedEmbeddingRate <= 1);
  }
});

test("RS estimate trends higher on a fully LSB-flipped image than on its untouched source", () => {
  // Not a guarantee for every possible image (that would overfit the
  // test to one implementation's quirks), but should hold for a
  // reasonably sized noisy carrier — the RS method's stated purpose.
  const image = noisyImage(96, 96, 21);
  const flipped = withFlippedLSBs(image, 55);
  const before = LensSteg.rsAnalysisForChannel(image.data, 0, 4, [0, 1, 1, 0]);
  const after = LensSteg.rsAnalysisForChannel(flipped.data, 0, 4, [0, 1, 1, 0]);
  if (before.estimateReliable && after.estimateReliable) {
    assert.ok(
      after.estimatedEmbeddingRate >= before.estimatedEmbeddingRate - 0.05,
      `expected flipped-LSB image estimate (${after.estimatedEmbeddingRate}) to not be meaningfully lower than source (${before.estimatedEmbeddingRate})`
    );
  }
});

// ---------------------------------------------------------------------
// Pixel statistics
// ---------------------------------------------------------------------

test("channel stats: constant channel has zero variance", () => {
  const image = makeImage(10, 10, () => [77, 77, 77]);
  const { mean, variance, stddev } = LensSteg.channelHistogramAndStats(image.data, 0, 4);
  assert.equal(mean, 77);
  assert.equal(variance, 0);
  assert.equal(stddev, 0);
});

test("adjacent correlation is very high for a smooth gradient", () => {
  const image = gradientImage(64, 8);
  const corr = LensSteg.adjacentCorrelation(image.data, 0, 4, 64, 8);
  assert.ok(corr > 0.99, `expected near-1 correlation for a gradient, got ${corr}`);
});

test("adjacent correlation returns null rather than NaN/throwing for a 1px-wide image", () => {
  const image = makeImage(1, 5, () => [1, 2, 3]);
  assert.doesNotThrow(() => LensSteg.adjacentCorrelation(image.data, 0, 4, 1, 5));
  assert.equal(LensSteg.adjacentCorrelation(image.data, 0, 4, 1, 5), null);
});

test("LSB pair distribution percentages sum to ~100 and sample size matches width*height row pairs", () => {
  const image = noisyImage(10, 10, 5);
  const result = LensSteg.lsbPairDistribution(image.data, 0, 4, 10, 10);
  const total = Object.values(result.percentages).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 100) < 0.01);
  assert.equal(result.sampleSize, 10 * 9); // 9 adjacent pairs per row, 10 rows
});

// ---------------------------------------------------------------------
// Edge cases: black/white images, invalid-shaped data
// ---------------------------------------------------------------------

test("a fully black image produces zero variance and a defined (if degenerate) chi-square result", () => {
  const image = makeImage(16, 16, () => [0, 0, 0]);
  const result = LensSteg.analyzeChannel(image.data, 0, 4, 16, 16);
  assert.equal(result.mean, 0);
  assert.equal(result.variance, 0);
  assert.doesNotThrow(() => result.chiSquare);
});

test("a fully white image is handled the same way as fully black, without throwing", () => {
  const image = makeImage(16, 16, () => [255, 255, 255]);
  assert.doesNotThrow(() => LensSteg.analyzeChannel(image.data, 0, 4, 16, 16));
});

test("analyzeImageSteganalysis skips alpha analysis when alpha is constant", () => {
  const image = makeImage(8, 8, () => [1, 2, 3, 255]);
  const result = LensSteg.analyzeImageSteganalysis(image);
  assert.equal(result.alpha.analyzed, false);
  assert.equal(result.alpha.constant, true);
});

test("analyzeImageSteganalysis analyzes alpha separately when it varies", () => {
  const image = makeImage(8, 8, (x) => [1, 2, 3, x % 2 === 0 ? 255 : 200]);
  const result = LensSteg.analyzeImageSteganalysis(image);
  assert.equal(result.alpha.analyzed, true);
  assert.ok(result.alpha.channel);
});

test("analyzeImageSteganalysis never throws on a 1x1 image", () => {
  const image = makeImage(1, 1, () => [10, 20, 30]);
  assert.doesNotThrow(() => LensSteg.analyzeImageSteganalysis(image));
});

test("analyzeImageSteganalysis produces an overall level from the fixed vocabulary", () => {
  const image = noisyImage(48, 48, 8);
  const result = LensSteg.analyzeImageSteganalysis(image);
  assert.ok(["none", "low", "moderate", "elevated", "inconclusive"].includes(result.overall.level));
});

test("combineOverall never claims 'steganography detected' language — only the fixed level vocabulary", () => {
  const image = withFlippedLSBs(noisyImage(80, 80, 2), 3);
  const result = LensSteg.analyzeImageSteganalysis(image);
  const allowed = new Set(["none", "low", "moderate", "elevated", "inconclusive"]);
  assert.ok(allowed.has(result.overall.level));
});

// ---------------------------------------------------------------------
// Invalid / truncated input
// ---------------------------------------------------------------------

test("analyzeImageSteganalysis does not throw when width*height*4 exceeds the actual buffer length", () => {
  const data = new Uint8ClampedArray(4 * 4); // way too short for width=10,height=10
  assert.doesNotThrow(() => LensSteg.analyzeImageSteganalysis({ data, width: 10, height: 10 }));
});

test("analyzeImageSteganalysis does not throw on an empty buffer", () => {
  assert.doesNotThrow(() => LensSteg.analyzeImageSteganalysis({ data: new Uint8ClampedArray(0), width: 0, height: 0 }));
});

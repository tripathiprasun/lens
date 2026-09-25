/**
 * lens-steg.js
 *
 * Pure, dependency-free steganalysis logic for LENS.
 *
 * Scope and honesty notes (read before changing thresholds):
 *
 *  - Every function here computes a STATISTICAL SIGNAL, not a verdict.
 *    Natural, unmodified images routinely produce "unusual" numbers here
 *    (noisy sensors, dithering, prior lossy edits, upscaling, palette
 *    reduction, etc). A clean result never proves an image is clean, and
 *    an elevated result never proves an image carries a hidden payload.
 *
 *  - The tests implemented are specifically sensitive to classic
 *    *sequential, LSB-replacement* embedding in raw/lossless pixel data
 *    (the kind of thing a simple "hide a message in the LSBs" tool
 *    produces). They are largely blind to: LSB matching (+/-1 instead of
 *    replacement), transform-domain (JPEG/DCT) steganography, encrypted
 *    or whitened payloads spread non-sequentially, and anything using a
 *    permutation/keyed pseudo-random pixel order across the whole image
 *    (our chi-square test is global, not a sliding scan, so it will miss
 *    embedding confined to a small region of a large image).
 *
 *  - Every numeric threshold used to turn a raw statistic into a label
 *    ("low" / "moderate" / "elevated") is a documented convention picked
 *    for this tool, not a universal scientific cutoff. They are called
 *    out explicitly at each usage site below and again in the README.
 *
 * No DOM access here on purpose: this file works unmodified in a
 * <script> tag, inside a Web Worker (importScripts), or under Node's
 * test runner.
 */

(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  } else {
    root.LensSteg = mod;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // =====================================================================
  // Format support
  // =====================================================================

  /**
   * Whether pixel-level steganalysis (LSB / chi-square / RS) can be
   * meaningfully run on a given detected file-signature id, and why.
   * @param {string|null} signatureId - e.g. "png", "bmp", "jpeg", "gif"
   */
  function supportForFormat(signatureId) {
    switch (signatureId) {
      case "png":
      case "bmp":
        return {
          supported: true,
          reason:
            "Lossless, uncompressed-at-the-pixel-level format: decoded pixel values correspond directly to stored bits.",
        };
      case "gif":
        return {
          supported: false,
          reason:
            "GIF is palette-indexed (max 256 colors). Decoded RGBA values come from a color table, not directly-stored per-channel bits, so per-channel LSB statistics do not reflect the file's actual storage and are not analyzed.",
        };
      case "webp":
        return {
          supported: false,
          reason:
            "WebP is typically lossy (or uses a distinct lossless transform). This browser cannot determine from decoded pixels alone whether a given WebP file's bits are meaningful at the LSB level, so it is not analyzed.",
        };
      case "jpeg":
        return {
          supported: false,
          reason:
            "JPEG stores lossy, quantized DCT coefficients, not raw pixel values. Pixel-level LSB analysis on the decompressed image reflects decoder/rounding behavior, not the file's actual stored data, and would be misleading.",
        };
      default:
        return {
          supported: false,
          reason: "This format is not recognized as one with directly-accessible, lossless pixel data.",
        };
    }
  }

  // =====================================================================
  // Chi-square incomplete-gamma machinery (for the pairs-of-values test)
  // =====================================================================
  // Standard Lanczos approximation for ln(Gamma(x)) and the regularized
  // incomplete gamma functions P(a,x)/Q(a,x), used to turn a chi-square
  // statistic into a p-value without any external stats library.

  const LANCZOS_G = 7;
  const LANCZOS_COEF = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];

  function logGamma(x) {
    if (x < 0.5) {
      // Reflection formula
      return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    }
    x -= 1;
    let a = LANCZOS_COEF[0];
    const t = x + LANCZOS_G + 0.5;
    for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS_COEF[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  /** Lower regularized incomplete gamma P(a,x), series expansion (x < a+1). */
  function gammaPSeries(a, x) {
    if (x <= 0) return 0;
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }

  /** Upper regularized incomplete gamma Q(a,x), continued fraction (x >= a+1). */
  function gammaQContinuedFraction(a, x) {
    const FPMIN = 1e-300;
    let b = x + 1 - a;
    let c = 1 / FPMIN;
    let d = 1 / b;
    let h = d;
    for (let i = 1; i < 500; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      c = b + an / c;
      if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const delta = d * c;
      h *= delta;
      if (Math.abs(delta - 1) < 1e-14) break;
    }
    return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  }

  /** Upper regularized incomplete gamma Q(a,x) = 1 - P(a,x), routed by the stable branch. */
  function upperRegularizedGammaQ(a, x) {
    if (x < 0 || a <= 0) return NaN;
    if (x === 0) return 1;
    if (x < a + 1) return 1 - gammaPSeries(a, x);
    return gammaQContinuedFraction(a, x);
  }

  /**
   * Two-sided-unused chi-square upper-tail probability: P(X >= chi2) for
   * X ~ chi-square with `df` degrees of freedom. This is the standard
   * "survival function", computed as Q(df/2, chi2/2).
   */
  function chiSquareUpperTailP(chi2, df) {
    if (df <= 0) return NaN;
    if (chi2 <= 0) return 1;
    return upperRegularizedGammaQ(df / 2, chi2 / 2);
  }

  // =====================================================================
  // Per-channel histogram / basic statistics
  // =====================================================================

  /**
   * Compute a 256-bin histogram, mean, variance and stddev for one
   * channel, walking the raw RGBA buffer directly with a stride (no
   * intermediate per-channel array is allocated).
   * @param {Uint8Array|Uint8ClampedArray} data - raw RGBA(A) buffer
   * @param {number} offset - 0=R, 1=G, 2=B, 3=A
   * @param {number} stride - bytes per pixel (4 for RGBA)
   */
  function channelHistogramAndStats(data, offset, stride) {
    const histogram = new Uint32Array(256);
    let sum = 0;
    let count = 0;
    for (let i = offset; i < data.length; i += stride) {
      const v = data[i];
      histogram[v]++;
      sum += v;
      count++;
    }
    const mean = count ? sum / count : 0;
    let variance = 0;
    if (count) {
      let sqDiffSum = 0;
      for (let v = 0; v < 256; v++) {
        if (histogram[v]) sqDiffSum += histogram[v] * (v - mean) * (v - mean);
      }
      variance = sqDiffSum / count;
    }
    return { histogram, count, mean, variance, stddev: Math.sqrt(variance) };
  }

  /**
   * LSB 0/1 balance for a channel, derived from its histogram (no second
   * pass over pixel data needed: LSB is just value % 2).
   */
  function lsbBalanceFromHistogram(histogram, count) {
    let ones = 0;
    for (let v = 1; v < 256; v += 2) ones += histogram[v];
    const zeros = count - ones;
    const pctOnes = count ? (ones / count) * 100 : 0;
    const pctZeros = count ? (zeros / count) * 100 : 0;
    return {
      count0: zeros,
      count1: ones,
      pct0: pctZeros,
      pct1: pctOnes,
      deviationFromBalancedPct: Math.abs(pctOnes - 50),
    };
  }

  // =====================================================================
  // Chi-square pairs-of-values attack (Westfeld & Pfitzmann style)
  // =====================================================================
  // Idea: sequential LSB replacement tends to equalize the frequencies of
  // each "pair of values" (2k, 2k+1) toward their shared average, because
  // the LSB is overwritten with near-random payload bits. We measure how
  // close the observed pair frequencies are to that equalized hypothesis.
  //
  // IMPORTANT direction-of-reading note: unlike a typical hypothesis test
  // where a *small* p-value is the interesting result, here a p-value
  // *close to 1* is the indicator of a match to the equalized-pairs
  // hypothesis. Natural photos usually do NOT have equalized pairs, so
  // they typically produce a large chi-square statistic and a p-value
  // near 0. This inversion is a well-known property of this specific
  // attack, not a bug — it is documented again at the call site.

  /**
   * @param {Uint32Array} histogram - 256-bin value histogram for one channel
   * @returns {{chiSquare: number, degreesOfFreedom: number, pValue: number, pairsUsed: number}}
   */
  function chiSquarePairsTest(histogram) {
    let chi2 = 0;
    let pairsUsed = 0;
    for (let k = 0; k < 128; k++) {
      const a = histogram[2 * k];
      const b = histogram[2 * k + 1];
      const expected = (a + b) / 2;
      if (expected === 0) continue; // undefined pair, natural for sparse/small images
      chi2 += (a - expected) * (a - expected) / expected;
      chi2 += (b - expected) * (b - expected) / expected;
      pairsUsed++;
    }
    const df = Math.max(pairsUsed - 1, 0);
    const pValue = df > 0 ? chiSquareUpperTailP(chi2, df) : NaN;
    return { chiSquare: chi2, degreesOfFreedom: df, pValue, pairsUsed };
  }

  // Convention thresholds for turning a p-value into a label. Documented
  // here, not hidden: these follow the common statistical convention of
  // treating p >= 0.9 as a strong match to the equalized-pairs
  // hypothesis, scaling down from there. Different published tools use
  // different cutoffs; there is no single agreed standard.
  const CHI_SQUARE_LEVEL_THRESHOLDS = { elevated: 0.9, moderate: 0.6, low: 0.2 };

  function chiSquareLevel(pValue) {
    if (!Number.isFinite(pValue)) return "inconclusive";
    if (pValue >= CHI_SQUARE_LEVEL_THRESHOLDS.elevated) return "elevated";
    if (pValue >= CHI_SQUARE_LEVEL_THRESHOLDS.moderate) return "moderate";
    if (pValue >= CHI_SQUARE_LEVEL_THRESHOLDS.low) return "low";
    return "none";
  }

  // =====================================================================
  // Regular-Singular (RS) analysis (Fridrich, Goljan & Du, 2001)
  // =====================================================================
  // Groups of adjacent pixels are flipped with two complementary masks;
  // whether the flip increases ("Regular") or decreases ("Singular") a
  // local-smoothness discrimination function, tallied under the mask and
  // its negation, is used to estimate how much LSB-replacement-style
  // noise has been added to the image.
  //
  // Simplification note: groups are taken as consecutive runs of
  // `groupSize` pixels in flat raster order (not row-boundary-aware).
  // This is a common simplification; it very slightly blurs statistics
  // for a handful of groups that straddle a row edge and does not
  // materially change results for images of reasonable size.

  function flipF1(x) {
    // Standard LSB flip: 2k <-> 2k+1.
    return x % 2 === 0 ? x + 1 : x - 1;
  }

  function flipFm1(x) {
    // "Shifted" LSB flip: 2k -> 2k-1, 2k+1 -> 2k+2 (opposite parity rule
    // from F1). Values 0 and 255 are boundary cases with no valid
    // same-magnitude neighbor in one direction; we clamp them to the
    // nearest in-range value rather than wrapping, which affects at most
    // a handful of pixels per channel.
    if (x === 0) return 1;
    if (x === 255) return 254;
    return x % 2 === 0 ? x - 1 : x + 1;
  }

  function discriminationF(group) {
    let sum = 0;
    for (let i = 0; i < group.length - 1; i++) sum += Math.abs(group[i] - group[i + 1]);
    return sum;
  }

  /**
   * Run RS group classification once, for one mask orientation, over one
   * channel. `preFlipAll`, when true, applies F1 to every pixel before
   * anything else — this simulates "100% of LSBs already flipped" for
   * the two-point embedding-rate extrapolation, without allocating a
   * second full-size buffer.
   *
   * @param {Uint8Array|Uint8ClampedArray} data
   * @param {number} offset
   * @param {number} stride
   * @param {number[]} mask - values in {-1,0,1}, e.g. [0,1,1,0]
   * @param {boolean} preFlipAll
   */
  function rsClassifyGroups(data, offset, stride, mask, preFlipAll) {
    const groupSize = mask.length;
    const totalPixels = Math.floor((data.length - offset) / stride);
    const totalGroups = Math.floor(totalPixels / groupSize);
    let regular = 0;
    let singular = 0;
    const original = new Array(groupSize);
    const flipped = new Array(groupSize);

    for (let g = 0; g < totalGroups; g++) {
      for (let i = 0; i < groupSize; i++) {
        const idx = offset + (g * groupSize + i) * stride;
        let v = data[idx];
        if (preFlipAll) v = flipF1(v);
        original[i] = v;
        if (mask[i] === 1) flipped[i] = flipF1(v);
        else if (mask[i] === -1) flipped[i] = flipFm1(v);
        else flipped[i] = v;
      }
      const fOrig = discriminationF(original);
      const fFlip = discriminationF(flipped);
      if (fFlip > fOrig) regular++;
      else if (fFlip < fOrig) singular++;
      // equal groups are neither regular nor singular; left out of both counts
    }
    return { regular, singular, totalGroups };
  }

  function negateMask(mask) {
    return mask.map((m) => -m);
  }

  /**
   * Full RS analysis for one channel: regular/singular counts under M and
   * -M at the observed image, plus a model-dependent embedding-rate
   * estimate via the standard two-point (p=0 / p=1) quadratic
   * extrapolation. The estimate is explicitly labeled and may be marked
   * unreliable when the quadratic degenerates (which happens for small,
   * very flat, or already-saturated images).
   */
  function rsAnalysisForChannel(data, offset, stride, mask) {
    mask = mask || [0, 1, 1, 0];
    const negM = negateMask(mask);

    const m0 = rsClassifyGroups(data, offset, stride, mask, false);
    const nm0 = rsClassifyGroups(data, offset, stride, negM, false);
    const m1 = rsClassifyGroups(data, offset, stride, mask, true);
    const nm1 = rsClassifyGroups(data, offset, stride, negM, true);

    const total = m0.totalGroups; // true group count, reported as-is
    const safeDivisor = total || 1; // only used to avoid division by zero below
    const rm0 = m0.regular / safeDivisor,
      sm0 = m0.singular / safeDivisor;
    const rnm0 = nm0.regular / safeDivisor,
      snm0 = nm0.singular / safeDivisor;
    const rm1 = m1.regular / safeDivisor,
      sm1 = m1.singular / safeDivisor;
    const rnm1 = nm1.regular / safeDivisor,
      snm1 = nm1.singular / safeDivisor;

    const d0 = rm0 - sm0;
    const d1 = rnm0 - snm0;
    const d0p = rm1 - sm1;
    const d1p = rnm1 - snm1;

    // Fridrich et al.'s quadratic: 2(d1+d0) x^2 + (d0' - d1' - d1 - 3 d0) x + (d0 - d0') = 0
    const a = 2 * (d1 + d0);
    const b = d0p - d1p - d1 - 3 * d0;
    const c = d0 - d0p;

    let estimate = null;
    let reliable = false;
    if (total > 0 && Math.abs(a) > 1e-9) {
      const discriminant = b * b - 4 * a * c;
      if (discriminant >= 0) {
        const sqrtDisc = Math.sqrt(discriminant);
        const roots = [(-b + sqrtDisc) / (2 * a), (-b - sqrtDisc) / (2 * a)];
        // Prefer the root closer to 0 (the standard choice in the paper),
        // then convert to an embedding-rate fraction p = x / (x - 0.5).
        roots.sort((x, y) => Math.abs(x) - Math.abs(y));
        const x = roots[0];
        if (Math.abs(x - 0.5) > 1e-9) {
          const p = x / (x - 0.5);
          if (Number.isFinite(p) && p >= -0.05 && p <= 1.05) {
            estimate = Math.min(1, Math.max(0, p));
            reliable = true;
          }
        }
      }
    }

    return {
      groupSize: mask.length,
      totalGroups: total,
      regularM: m0.regular,
      singularM: m0.singular,
      regularNegM: nm0.regular,
      singularNegM: nm0.singular,
      estimatedEmbeddingRate: estimate, // fraction 0-1, or null; ALWAYS an estimate, see README
      estimateReliable: reliable,
    };
  }

  // Convention thresholds for the RS embedding-rate estimate. Same
  // caveat as the chi-square thresholds: a documented convention for
  // this tool, not a universal standard.
  const RS_LEVEL_THRESHOLDS = { elevated: 0.15, moderate: 0.05, low: 0.01 };

  function rsLevel(rsResult) {
    if (!rsResult.estimateReliable || rsResult.estimatedEmbeddingRate == null) return "inconclusive";
    const p = rsResult.estimatedEmbeddingRate;
    if (p >= RS_LEVEL_THRESHOLDS.elevated) return "elevated";
    if (p >= RS_LEVEL_THRESHOLDS.moderate) return "moderate";
    if (p >= RS_LEVEL_THRESHOLDS.low) return "low";
    return "none";
  }

  // =====================================================================
  // Adjacent-pixel correlation and LSB-pair distribution
  // =====================================================================

  /**
   * Pearson correlation between each pixel and its immediate right
   * neighbor within the same row, for one channel. Single pass, O(1)
   * extra memory. Natural images are typically highly correlated
   * (close to 1); embedding tends to reduce it slightly.
   */
  function adjacentCorrelation(data, offset, stride, width, height) {
    let n = 0,
      sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumX2 = 0,
      sumY2 = 0;
    for (let row = 0; row < height; row++) {
      const rowStart = row * width;
      for (let col = 0; col < width - 1; col++) {
        const xi = offset + (rowStart + col) * stride;
        const yi = offset + (rowStart + col + 1) * stride;
        const x = data[xi];
        const y = data[yi];
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
        sumY2 += y * y;
        n++;
      }
    }
    if (n === 0) return null;
    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    if (denominator === 0) return null;
    return numerator / denominator;
  }

  /**
   * Distribution of (LSB(x), LSB(right-neighbor)) pairs: 00 / 01 / 10 / 11.
   * A pronounced skew away from natural (usually slightly correlated)
   * proportions toward uniform ~25% each can accompany LSB embedding,
   * but plenty of natural noisy images are already close to uniform.
   */
  function lsbPairDistribution(data, offset, stride, width, height) {
    const counts = { "00": 0, "01": 0, "10": 0, "11": 0 };
    let n = 0;
    for (let row = 0; row < height; row++) {
      const rowStart = row * width;
      for (let col = 0; col < width - 1; col++) {
        const xi = offset + (rowStart + col) * stride;
        const yi = offset + (rowStart + col + 1) * stride;
        const key = (data[xi] & 1).toString() + (data[yi] & 1).toString();
        counts[key]++;
        n++;
      }
    }
    const pct = {};
    for (const k of Object.keys(counts)) pct[k] = n ? (counts[k] / n) * 100 : 0;
    return { counts, percentages: pct, sampleSize: n };
  }

  // =====================================================================
  // Whole-channel analysis + overall assessment
  // =====================================================================

  const RS_MASK = [0, 1, 1, 0];
  const LEVEL_ORDER = { none: 0, low: 1, moderate: 2, elevated: 3, inconclusive: -1 };

  /**
   * Run every test on one channel and package the results.
   */
  function analyzeChannel(data, offset, stride, width, height) {
    const { histogram, count, mean, variance, stddev } = channelHistogramAndStats(data, offset, stride);
    const lsb = lsbBalanceFromHistogram(histogram, count);
    const chiSquare = chiSquarePairsTest(histogram);
    const rs = rsAnalysisForChannel(data, offset, stride, RS_MASK);
    const correlation = adjacentCorrelation(data, offset, stride, width, height);
    const lsbPairs = lsbPairDistribution(data, offset, stride, width, height);

    return {
      sampleSize: count,
      mean,
      variance,
      stddev,
      histogram: Array.from(histogram),
      lsbBalance: lsb,
      chiSquare: {
        chiSquare: chiSquare.chiSquare,
        degreesOfFreedom: chiSquare.degreesOfFreedom,
        pValue: chiSquare.pValue,
        pairsUsed: chiSquare.pairsUsed,
        level: chiSquareLevel(chiSquare.pValue),
      },
      rsAnalysis: Object.assign({ level: rsLevel(rs) }, rs),
      adjacentCorrelation: correlation,
      lsbPairDistribution: lsbPairs,
    };
  }

  /**
   * Combine per-channel chi-square and RS levels into one overall
   * assessment. Rules (documented, not arbitrary re-derivation each time):
   *   1. LSB-balance alone never drives the verdict — see module header.
   *   2. Each test's overall level = the highest level among R/G/B
   *      channels for that test (Alpha is reported separately, never
   *      folded into RGB's verdict).
   *   3. If the two tests' overall levels differ by 2+ steps on the
   *      none(0) < low(1) < moderate(2) < elevated(3) scale, or either
   *      test is inconclusive while the other is elevated, the overall
   *      result is INCONCLUSIVE rather than forced.
   *   4. Otherwise, overall = the higher of the two levels.
   */
  function combineOverall(channelResults) {
    const rgbChannels = ["r", "g", "b"].filter((k) => channelResults[k]);
    if (rgbChannels.length === 0) {
      return { level: "inconclusive", reason: "No RGB channel data available." };
    }

    let chiOverall = "none";
    let rsOverall = "none";
    let anyChiInconclusive = false;
    let anyRsInconclusive = false;

    for (const k of rgbChannels) {
      const chiLvl = channelResults[k].chiSquare.level;
      const rsLvl = channelResults[k].rsAnalysis.level;
      if (chiLvl === "inconclusive") anyChiInconclusive = true;
      else if (LEVEL_ORDER[chiLvl] > LEVEL_ORDER[chiOverall]) chiOverall = chiLvl;
      if (rsLvl === "inconclusive") anyRsInconclusive = true;
      else if (LEVEL_ORDER[rsLvl] > LEVEL_ORDER[rsOverall]) rsOverall = rsLvl;
    }

    const chiFinal = anyChiInconclusive && chiOverall === "none" ? "inconclusive" : chiOverall;
    const rsFinal = anyRsInconclusive && rsOverall === "none" ? "inconclusive" : rsOverall;

    if (chiFinal === "inconclusive" || rsFinal === "inconclusive") {
      // Only force INCONCLUSIVE overall when the inconclusive test can't
      // be safely ignored, i.e. the other test found something.
      const other = chiFinal === "inconclusive" ? rsFinal : chiFinal;
      if (other !== "none") {
        return {
          level: "inconclusive",
          reason: "One test could not produce a reliable result while the other found a non-trivial signal.",
          chiSquareLevel: chiFinal,
          rsLevel: rsFinal,
        };
      }
      return {
        level: chiFinal === "inconclusive" ? rsFinal : chiFinal,
        reason: "The inconclusive test found no offsetting signal; falling back to the other test.",
        chiSquareLevel: chiFinal,
        rsLevel: rsFinal,
      };
    }

    const diff = Math.abs(LEVEL_ORDER[chiFinal] - LEVEL_ORDER[rsFinal]);
    if (diff >= 2) {
      return {
        level: "inconclusive",
        reason: "The chi-square and RS tests disagree strongly; reporting a forced conclusion would be misleading.",
        chiSquareLevel: chiFinal,
        rsLevel: rsFinal,
      };
    }

    const level = LEVEL_ORDER[chiFinal] >= LEVEL_ORDER[rsFinal] ? chiFinal : rsFinal;
    return { level, reason: "Combined from chi-square and RS test levels.", chiSquareLevel: chiFinal, rsLevel: rsFinal };
  }

  /**
   * Top-level entry point. `imageData` is a plain object with
   * { data: Uint8ClampedArray|Uint8Array (RGBA, length = width*height*4),
   *   width, height }. `hasAlpha` controls whether the alpha channel is
   * analyzed at all (skip if the caller already knows it's fully opaque
   * and uninformative, though by default we still check).
   */
  function analyzeImageSteganalysis(imageData) {
    const { data, width, height } = imageData;
    const stride = 4;
    const status = { ok: true, sampleWidth: width, sampleHeight: height, samplePixels: width * height };

    const channels = {
      r: analyzeChannel(data, 0, stride, width, height),
      g: analyzeChannel(data, 1, stride, width, height),
      b: analyzeChannel(data, 2, stride, width, height),
    };

    // Alpha: only meaningful to report if it varies at all.
    let alphaConstant = true;
    const firstAlpha = data.length >= 4 ? data[3] : 255;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== firstAlpha) {
        alphaConstant = false;
        break;
      }
    }
    let alpha = null;
    if (!alphaConstant) {
      alpha = analyzeChannel(data, 3, stride, width, height);
    }

    const overall = combineOverall(channels);

    return {
      status,
      channels: { red: channels.r, green: channels.g, blue: channels.b },
      alpha: alpha
        ? { analyzed: true, constant: false, channel: alpha }
        : { analyzed: false, constant: true, note: "Alpha channel is constant (fully opaque); LSB statistics on a constant channel are not informative and were skipped." },
      overall,
    };
  }

  return {
    supportForFormat,
    channelHistogramAndStats,
    lsbBalanceFromHistogram,
    chiSquarePairsTest,
    chiSquareLevel,
    chiSquareUpperTailP,
    rsAnalysisForChannel,
    rsLevel,
    adjacentCorrelation,
    lsbPairDistribution,
    analyzeChannel,
    combineOverall,
    analyzeImageSteganalysis,
    // exposed for tests
    _internal: { flipF1, flipFm1, discriminationF, logGamma, upperRegularizedGammaQ, RS_MASK, CHI_SQUARE_LEVEL_THRESHOLDS, RS_LEVEL_THRESHOLDS },
  };
});

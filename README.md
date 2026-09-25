# LENS

LENS is a local-only file and image inspection tool. Everything runs in your
browser tab — nothing is uploaded anywhere. It reports:

- File signature ("magic bytes") detection and extension-mismatch checks
- SHA-256 / SHA-384 / SHA-512 hashes
- Shannon entropy
- A hex + ASCII dump of the file's head
- For images: dimensions, a color survey, and (for JPEG) EXIF metadata
- For PNG and BMP images: a **steganalysis** section (see below)
- A JSON report you can export

## Running it

Open `index.html` in a browser, or serve the directory with any static file
server. There is no build step and no server-side component.

## Running the tests

```sh
node --test test/
```

Tests use Node's built-in test runner and synthetic, programmatically
generated images so expected characteristics are known in advance — they
check the *math*, not whether every possible image produces a specific
verdict (that would be over-fitting the tests to one implementation).

---

## Steganalysis

### What steganalysis is (and isn't)

**Steganography** is the practice of hiding data inside another file so its
presence isn't obvious — for example, overwriting the least-significant bits
(LSBs) of an image's pixel values with payload bits, since a ±1 change to a
pixel's value is usually invisible to the eye.

**Steganalysis** is the analysis of a file to look for *statistical traces*
that this may have happened. It's the inverse discipline, and importantly it
doesn't and can't "read" a hidden message — it can only notice that certain
statistical properties of the file look unusual compared to what an
unmodified image from a camera or renderer would typically look like.

This distinction matters because a steganalysis result is a *signal*, not a
*proof*. Both directions of error are real and expected:

- **A clean result does not mean an image contains no hidden data.**
  Sophisticated embedding (encrypted or whitened payloads, non-sequential or
  keyed pixel selection, LSB matching instead of replacement, low embedding
  rates, or transform-domain techniques) can leave no trace that these
  particular tests are sensitive to.
- **An elevated result does not mean an image contains hidden data.**
  Sensor noise, dithering, upscaling, palette reduction, prior lossy
  compression, and ordinary editing can all produce statistics that look
  similar to what embedding produces.

LENS therefore never reports "steganography detected." It reports one of a
fixed set of neutral levels — **no significant statistical indicators**,
**low indicators**, **moderate indicators**, **elevated indicators**, or
**analysis inconclusive** — each with the raw numbers behind it, so you can
form your own judgment.

### What formats are analyzed

Pixel-level LSB analysis is only meaningful when the browser's decoded pixel
values correspond directly to bits actually stored in the file. That's true
for:

- **PNG** — lossless.
- **BMP** — typically stored uncompressed.

It is deliberately **not** run on:

- **JPEG** — stores lossy, quantized DCT coefficients, not raw pixel values.
  Running LSB analysis on the *decompressed* image would measure decoder
  rounding behavior, not the file's actual data, and would be misleading.
  (JPEG steganography exists, but it targets DCT coefficients directly and
  needs a different kind of analysis than this tool implements.)
- **GIF** — palette-indexed (≤256 colors). Decoded RGBA values come from a
  color table, not per-channel stored bits.
- **WebP** — typically lossy, and a decoded canvas doesn't reveal whether a
  given file used WebP's lossless mode, so LENS treats it conservatively as
  unsupported.

If you open an unsupported format, the Steganalysis section says so
explicitly and explains why, rather than silently skipping or guessing.

### The tests

All tests run per-channel (Red, Green, Blue). Alpha is analyzed **separately**
from RGB, and skipped with a note when it's constant (fully opaque), since
LSB statistics on a channel with a single value are not informative.

#### LSB distribution

For each channel, the percentage of pixels whose least-significant bit is 0
vs. 1, and how far that is from an even 50/50 split. **A perfectly balanced
LSB distribution does not by itself indicate anything** — many ordinary
photos, especially noisy ones, are already close to balanced. This test is
reported for context and folded only weakly into the overall verdict.

#### Chi-square pairs-of-values test

Based on Westfeld & Pfitzmann's classic attack on sequential LSB
replacement. Pixel values are grouped into pairs `(2k, 2k+1)` (e.g. 4 and 5,
6 and 7, ...). Sequential LSB replacement tends to *equalize* the observed
frequencies of each pair toward their shared average, because the LSB is
overwritten with near-random payload bits. The test computes a chi-square
statistic comparing observed to expected-under-equalization frequencies, and
converts it to a p-value using the standard chi-square distribution
(implemented in `lens-steg.js` via a Lanczos-approximation log-gamma and the
regularized incomplete gamma function — no external stats library).

**Reading direction, which is easy to get backwards:** a p-value *close to
1* is the indicator here, not close to 0. That's because we're testing "how
well does this match the equalized-pairs hypothesis", and natural images
usually do *not* match it (they typically produce a large chi-square
statistic and a p-value near 0). This inversion is a known, documented
property of this specific attack.

**Assumptions and limits:**
- This is a *global* test over the whole sampled region. It is blind to
  embedding confined to a small part of a large image (a proper sliding-scan
  version of this attack is not implemented here).
- It is specifically sensitive to *sequential* LSB replacement. LSB
  matching (random ±1 instead of direct bit overwrite), non-sequential
  (permuted/keyed) pixel selection, and low embedding rates can evade it.
- For very small images or images with very few distinct pixel values, some
  value-pairs have zero expected count and are excluded from the statistic;
  this reduces the degrees of freedom and the test's power.

The p-value → label mapping (`elevated` at p ≥ 0.9, `moderate` at p ≥ 0.6,
`low` at p ≥ 0.2, `none` below that) is a **convention chosen for this
tool**, documented in `lens-steg.js` next to `CHI_SQUARE_LEVEL_THRESHOLDS`.
It is not a universal scientific cutoff — different published tools use
different thresholds, and the raw statistic and p-value are always shown
alongside the label so you aren't dependent on our labeling choice.

#### RS (Regular-Singular) analysis

Based on Fridrich, Goljan & Du's 2001 method. Pixels are grouped (here, runs
of 4 in raster order) and each group is perturbed with two complementary bit
"flipping" masks. Whether the perturbation increases or decreases a
local-smoothness measure classifies the group as **Regular** or **Singular**;
tallying this under a mask and its negation, and comparing to the same
tally after simulating a fully-flipped image, lets the method fit a
model and produce an **estimated embedding rate**.

This estimate is always labeled as an estimate in the UI and report, and is
explicitly **model-dependent** — it assumes the RS method's own model of how
embedding affects pixel groups, and can be unreliable (flagged as such) for
small, very flat, or unusual images, in which case LENS reports "estimate
not reliable" rather than a fabricated number. **It is never presented as
the actual amount of hidden data** — only as one model's estimate of an
embedding rate consistent with the observed regular/singular group counts.

The regular/singular group counts themselves (`regularM`, `singularM`,
`regularNegM`, `singularNegM`) are always shown in the exported report even
when no reliable rate estimate can be derived.

Thresholds for turning the estimate into a label (`elevated` ≥ 15%,
`moderate` ≥ 5%, `low` ≥ 1%) live next to `RS_LEVEL_THRESHOLDS` in
`lens-steg.js`, with the same "documented convention, not a universal
standard" caveat as the chi-square thresholds.

#### Pixel statistics

Supporting numbers, shown for forensic context rather than as a pass/fail
signal on their own:

- Per-channel mean, variance, standard deviation, and full 256-bin histogram.
- **Adjacent-pixel correlation**: Pearson correlation between each pixel and
  its right-hand neighbor in the same row, per channel. Natural images are
  usually highly correlated (close to 1); embedding noise can reduce this
  slightly, but so can many ordinary things (fine texture, film grain,
  sensor noise, sharpening).
- **LSB-pair distribution**: how often each combination of (this pixel's
  LSB, next pixel's LSB) occurs. A skew toward a uniform ~25%-each split can
  accompany LSB embedding, but plenty of naturally noisy images are already
  close to uniform.

### Overall assessment logic

The overall verdict combines the chi-square and RS levels (LSB balance and
raw pixel statistics inform the channel cards but never drive the overall
level on their own — see "What this does and does not show" in the UI):

1. Each test's overall level is the **highest** level it reached across the
   R/G/B channels (Alpha is never folded into this).
2. If the two tests' levels differ by two or more steps on the
   `none < low < moderate < elevated` scale, or one test is inconclusive
   while the other found something non-trivial, LENS reports
   **`INCONCLUSIVE`** rather than forcing a single answer.
3. Otherwise, the overall level is the higher of the two.

This logic lives in `combineOverall()` in `lens-steg.js`, with the exact
rule spelled out in a comment directly above it.

### Performance

Images can be large. To keep the tab responsive and avoid needlessly
duplicating multi-megabyte pixel buffers:

- All per-pixel loops walk the raw RGBA buffer directly with a channel
  offset and stride, rather than copying out separate R/G/B arrays.
- The two-point RS embedding-rate estimate simulates a "fully LSB-flipped"
  image by flipping each pixel's value on the fly as it's read, instead of
  allocating and populating a second full-size buffer.
- Very large images (over roughly 2000px in either dimension) are analyzed
  on a **cropped** top-left region rather than a resized copy. Resizing
  would interpolate pixel values and destroy exactly the bit-level signal
  these tests look at; cropping preserves real pixel data at the cost of
  only covering part of the image (this is disclosed in the UI whenever it
  happens, along with the region's actual size).
- The computation runs inside a Web Worker (`steg-worker.js`), transferring
  the pixel buffer rather than copying it, so the main thread — and the
  rest of the UI — stays responsive while it runs. If a Worker can't be
  created in the current context, LENS falls back to running the same code
  on the main thread.

### Using LENS alongside LSB-based steganography tools

LENS's steganalysis is a general statistical analysis of pixel data — it
does not target, recognize, or contain any special-cased logic for any
particular steganography tool's output format. If you use an LSB-based
embedding tool and want a rough, non-definitive sanity check of how
detectable the result is by these particular statistical methods, you can
run the output PNG or BMP through LENS. As above: a clean result is not a
guarantee, and these tests are specifically tuned to *sequential LSB
replacement* — they say little about other embedding strategies.

### Report export

The exported JSON report includes a `steganalysis` field alongside the
existing signature/hash/entropy/image/metadata fields, containing the full
per-channel results, the alpha-channel outcome, the overall assessment, and
(when applicable) the reason a format wasn't analyzed or the cropped sample
region's dimensions.

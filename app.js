/**
 * app.js
 * DOM/UI layer for LENS. All analytical logic lives in lens-core.js;
 * this file reads files, calls into LensCore, and renders the result.
 */

(function () {
  "use strict";

  const HEX_PREVIEW_BYTES = 1024;
  const SIGNATURE_READ_BYTES = 64;
  const MAX_COLOR_SAMPLE = 128; // px, for the lightweight color survey
  const MAX_STEGO_PIXELS = 4_000_000; // cap on pixels fed to steganalysis (~4MP); larger images are center-cropped
  const STEGO_MIN_DIMENSION = 16; // below this, RS/chi-square are not meaningful
  const IMAGE_FORMATS = ["jpeg", "png", "gif", "webp", "bmp"];

  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  const dropzone = $("#dropzone");
  const fileInput = $("#file-input");
  const chooseBtn = $("#choose-file-btn");
  const emptyState = $("#empty-state");
  const analysisView = $("#analysis-view");
  const newFileBtn = $("#new-file-btn");
  const exportBtn = $("#export-report-btn");
  const errorBanner = $("#error-banner");

  let currentReportData = null;
  let currentPreviewUrl = null;
  let stegoWorker = null;
  let stegoRequestCounter = 0;
  const pendingStegoRequests = new Map();

  function getStegoWorker() {
    if (stegoWorker) return stegoWorker;
    try {
      stegoWorker = new Worker("stego-worker.js");
      stegoWorker.onmessage = (e) => {
        const { requestId, ok, results, overall, error } = e.data;
        const pending = pendingStegoRequests.get(requestId);
        if (!pending) return;
        pendingStegoRequests.delete(requestId);
        if (ok) pending.resolve({ results, overall });
        else pending.reject(new Error(error || "Steganalysis worker failed."));
      };
      stegoWorker.onerror = (e) => {
        // A worker-level error (e.g. the script failed to load) fails every
        // request currently in flight rather than hanging them silently.
        for (const [, pending] of pendingStegoRequests) pending.reject(new Error("Steganalysis worker error."));
        pendingStegoRequests.clear();
        e.preventDefault && e.preventDefault();
      };
    } catch (e) {
      stegoWorker = null;
    }
    return stegoWorker;
  }

  /**
   * Run the heavy per-channel steganalysis math in the Web Worker so large
   * images don't block the UI. Falls back to null (caller shows an error)
   * if Web Workers aren't available in this context.
   */
  function runStegoAnalysis(width, height, channels) {
    const worker = getStegoWorker();
    if (!worker) return Promise.reject(new Error("Web Workers are not available in this browser context."));
    const requestId = ++stegoRequestCounter;
    const transferables = Object.values(channels).map((c) => c.buffer);
    return new Promise((resolve, reject) => {
      pendingStegoRequests.set(requestId, { resolve, reject });
      worker.postMessage({ requestId, width, height, channels }, transferables);
    });
  }

  // -----------------------------------------------------------------
  // Entry points
  // -----------------------------------------------------------------

  chooseBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("is-dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("is-dragover");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  newFileBtn.addEventListener("click", resetToEmptyState);
  exportBtn.addEventListener("click", exportReport);

  // -----------------------------------------------------------------
  // Main analysis flow
  // -----------------------------------------------------------------

  async function handleFile(file) {
    clearError();
    if (currentPreviewUrl) {
      URL.revokeObjectURL(currentPreviewUrl);
      currentPreviewUrl = null;
    }
    try {
      showLoading(file.name);

      const extension = getExtension(file.name);
      const headBytes = new Uint8Array(
        await file.slice(0, Math.max(HEX_PREVIEW_BYTES, SIGNATURE_READ_BYTES)).arrayBuffer()
      );
      const signature = LensCore.detectSignature(headBytes);
      const extensionMatch = LensCore.checkExtensionMatch(extension, signature);

      // Hashing and entropy both need the full file. For very large files
      // this reads the whole ArrayBuffer once and reuses it for both,
      // rather than re-reading the file from disk twice.
      let fullBytes = null;
      let hashes = null;
      let entropy = null;
      let hashError = null;

      try {
        const buffer = await file.arrayBuffer();
        fullBytes = new Uint8Array(buffer);
        hashes = await computeHashes(buffer);
        entropy = LensCore.calculateEntropy(fullBytes);
      } catch (e) {
        hashError = "Could not read the full file for hashing/entropy (it may be too large for this browser tab).";
      }

      const isImage = signature && IMAGE_FORMATS.includes(signature.id);
      let imageInfo = null;
      let exif = null;
      let stegoSupport = null;
      let stegoResult = null;
      let stegoError = null;

      if (isImage) {
        stegoSupport = LensStego.getPixelAnalysisSupport(signature.id, headBytes);
        try {
          imageInfo = await analyzeImage(file, stegoSupport.supported);
        } catch (e) {
          imageInfo = { error: "Could not read image dimensions or color data." };
        }

        if (stegoSupport.supported && imageInfo && imageInfo.stegoPixels) {
          const px = imageInfo.stegoPixels;
          if (px.tooSmall) {
            stegoError = "Image is too small for a meaningful steganalysis pass.";
          } else if (px.error) {
            stegoError = px.error;
          } else {
            try {
              const { results, overall } = await runStegoAnalysis(px.width, px.height, px.channels);
              stegoResult = { perChannel: results, overall, cropped: px.cropped, fullWidth: px.fullWidth, fullHeight: px.fullHeight, analyzedWidth: px.width, analyzedHeight: px.height };
            } catch (e) {
              stegoError = "Steganalysis could not be completed for this image in this browser.";
            }
          }
        }
      }

      if (signature && signature.id === "jpeg" && fullBytes) {
        try {
          exif = LensCore.parseJpegExif(fullBytes);
        } catch (e) {
          exif = { malformed: true };
        }
      }

      const hexBytes = headBytes.length >= HEX_PREVIEW_BYTES ? headBytes : headBytes.subarray(0, headBytes.length);

      render({
        file,
        extension,
        signature,
        extensionMatch,
        hashes,
        hashError,
        entropy,
        hexBytes,
        isImage,
        imageInfo,
        exif,
        stegoSupport,
        stegoResult,
        stegoError,
      });
    } catch (err) {
      console.error(err);
      showError(
        "Something went wrong while analyzing this file. It may be corrupted, unusually structured, or unreadable in this browser."
      );
      resetToEmptyState();
    }
  }

  function getExtension(filename) {
    const idx = filename.lastIndexOf(".");
    if (idx === -1 || idx === filename.length - 1) return "";
    return filename.slice(idx + 1);
  }

  async function computeHashes(buffer) {
    const algos = [
      ["SHA-256", "sha256"],
      ["SHA-384", "sha384"],
      ["SHA-512", "sha512"],
    ];
    const results = {};
    for (const [webCryptoName, key] of algos) {
      const digest = await crypto.subtle.digest(webCryptoName, buffer);
      results[key] = LensCore.bytesToHexString(new Uint8Array(digest));
    }
    return results;
  }

  /**
   * Decode the image once and derive everything pixel-based from that
   * single decode: the small color-survey sample, and (only when
   * `extractStegoPixels` is true) native-resolution channel arrays for
   * steganalysis. Decoding twice for one file would double the work for
   * no benefit, so both consumers share this one <img> load.
   */
  function analyzeImage(file, extractStegoPixels) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const width = img.naturalWidth;
          const height = img.naturalHeight;
          const gcd = greatestCommonDivisor(width, height);
          const aspect = gcd ? `${width / gcd}:${height / gcd}` : "n/a";

          const sampleW = Math.min(MAX_COLOR_SAMPLE, width) || 1;
          const sampleH = Math.min(MAX_COLOR_SAMPLE, height) || 1;
          const sampleCanvas = document.createElement("canvas");
          sampleCanvas.width = sampleW;
          sampleCanvas.height = sampleH;
          const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
          sampleCtx.drawImage(img, 0, 0, sampleW, sampleH);

          let colorInfo = null;
          try {
            const data = sampleCtx.getImageData(0, 0, sampleW, sampleH).data;
            colorInfo = surveyColors(data);
          } catch (e) {
            colorInfo = null; // canvas may be tainted for cross-origin sources; not expected here
          }

          let stegoPixels = null;
          if (extractStegoPixels && width > 0 && height > 0) {
            stegoPixels = extractPixelChannels(img, width, height);
          }

          URL.revokeObjectURL(url);
          resolve({ width, height, aspect, colorInfo, stegoPixels });
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Image failed to decode"));
      };
      img.src = url;
    });
  }

  /**
   * Draw the already-decoded image at native resolution (no scaling, so
   * pixel values — and their LSBs — are exactly as stored) and split its
   * RGBA data into separate per-channel typed arrays. For very large
   * images, reads only a centered crop capped at MAX_STEGO_PIXELS rather
   * than the whole frame, since getImageData(x, y, w, h) on a sub-region
   * only materializes that region.
   */
  function extractPixelChannels(img, width, height) {
    if (width < STEGO_MIN_DIMENSION || height < STEGO_MIN_DIMENSION) {
      return { tooSmall: true };
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, width, height);

    let cropX = 0,
      cropY = 0,
      cropW = width,
      cropH = height,
      cropped = false;

    if (width * height > MAX_STEGO_PIXELS) {
      const scale = Math.sqrt(MAX_STEGO_PIXELS / (width * height));
      cropW = Math.max(STEGO_MIN_DIMENSION, Math.floor(width * scale));
      cropH = Math.max(STEGO_MIN_DIMENSION, Math.floor(height * scale));
      cropX = Math.floor((width - cropW) / 2);
      cropY = Math.floor((height - cropH) / 2);
      cropped = true;
    }

    let imageData;
    try {
      imageData = ctx.getImageData(cropX, cropY, cropW, cropH);
    } catch (e) {
      return { error: "Could not read raw pixel data from this image." };
    }

    const rgba = imageData.data;
    const n = cropW * cropH;
    const r = new Uint8Array(n);
    const g = new Uint8Array(n);
    const b = new Uint8Array(n);
    let hasTransparency = false;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      r[i] = rgba[o];
      g[i] = rgba[o + 1];
      b[i] = rgba[o + 2];
      if (rgba[o + 3] < 255) hasTransparency = true;
    }
    let a = null;
    if (hasTransparency) {
      a = new Uint8Array(n);
      for (let i = 0; i < n; i++) a[i] = rgba[i * 4 + 3];
    }

    return {
      width: cropW,
      height: cropH,
      channels: a ? { r, g, b, a } : { r, g, b },
      cropped,
      fullWidth: width,
      fullHeight: height,
    };
  }

  function greatestCommonDivisor(a, b) {
    while (b) {
      [a, b] = [b, a % b];
    }
    return a;
  }

  function surveyColors(pixelData) {
    let rSum = 0,
      gSum = 0,
      bSum = 0,
      count = 0;
    let isGrayscale = true;
    let hasAlpha = false;
    const seen = new Set();
    for (let i = 0; i < pixelData.length; i += 4) {
      const r = pixelData[i],
        g = pixelData[i + 1],
        b = pixelData[i + 2],
        a = pixelData[i + 3];
      rSum += r;
      gSum += g;
      bSum += b;
      count++;
      if (a < 255) hasAlpha = true;
      if (r !== g || g !== b) isGrayscale = false;
      if (seen.size < 5000) seen.add((r << 16) | (g << 8) | b);
    }
    return {
      averageColor: {
        r: Math.round(rSum / count),
        g: Math.round(gSum / count),
        b: Math.round(bSum / count),
      },
      approxUniqueColorsInSample: seen.size,
      likelyGrayscale: isGrayscale,
      hasTransparency: hasAlpha,
    };
  }

  // -----------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------

  function showLoading(name) {
    emptyState.hidden = true;
    analysisView.hidden = false;
    analysisView.setAttribute("aria-busy", "true");
    analysisView.innerHTML = `<p class="loading">Analyzing ${escapeHtml(name)}…</p>`;
  }

  function render(data) {
    analysisView.setAttribute("aria-busy", "false");
    const {
      file,
      extension,
      signature,
      extensionMatch,
      hashes,
      hashError,
      entropy,
      hexBytes,
      isImage,
      imageInfo,
      exif,
      stegoSupport,
      stegoResult,
      stegoError,
    } = data;

    const lastModified = file.lastModified ? new Date(file.lastModified).toLocaleString() : "Unknown";
    const generatedAt = new Date().toISOString();

    currentReportData = LensCore.buildReport({
      generatedAt,
      name: file.name,
      extension,
      sizeBytes: file.size,
      mimeType: file.type,
      lastModified,
      signature,
      extensionMatch,
      hashes,
      entropy,
      image: isImage
        ? {
            width: imageInfo && imageInfo.width,
            height: imageInfo && imageInfo.height,
            aspect_ratio: imageInfo && imageInfo.aspect,
            color: imageInfo && imageInfo.colorInfo,
          }
        : null,
      metadata: exif ? buildMetadataForReport(exif) : null,
    });

    if (isImage && currentReportData.image) {
      currentReportData.image.steganalysis = buildStegoForReport(stegoSupport, stegoResult, stegoError);
    }

    analysisView.innerHTML = "";
    analysisView.appendChild(buildHeaderSection(file, lastModified));
    analysisView.appendChild(buildSignatureSection(extension, file.type, signature, extensionMatch));
    analysisView.appendChild(buildBasicInfoSection(file, signature));
    analysisView.appendChild(buildHashSection(hashes, hashError));
    analysisView.appendChild(buildEntropySection(entropy));
    if (isImage) analysisView.appendChild(buildImageSection(file, imageInfo));
    if (exif) analysisView.appendChild(buildMetadataSection(exif));
    if (isImage) analysisView.appendChild(buildStegoSection(stegoSupport, stegoResult, stegoError));
    analysisView.appendChild(buildHexSection(hexBytes));
  }

  function buildHeaderSection(file, lastModified) {
    const el = document.createElement("div");
    el.className = "result-header";
    el.innerHTML = `
      <div class="result-header__name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
      <div class="result-header__meta">${LensCore.formatBytes(file.size)} · modified ${escapeHtml(lastModified)}</div>
    `;
    return el;
  }

  function buildSignatureSection(extension, mime, signature, extensionMatch) {
    const section = sectionShell("File Signature");
    const statusClass =
      extensionMatch.status === "match" ? "status-ok" : extensionMatch.status === "mismatch" ? "status-warn" : "status-neutral";
    const statusIcon = extensionMatch.status === "match" ? "✓" : extensionMatch.status === "mismatch" ? "⚠" : "?";

    section.querySelector(".section__body").innerHTML = `
      <div class="sig-grid">
        <div class="sig-item">
          <div class="sig-label">Extension</div>
          <div class="sig-value mono">${extension ? "." + escapeHtml(extension) : "(none)"}</div>
        </div>
        <div class="sig-item">
          <div class="sig-label">Browser MIME</div>
          <div class="sig-value mono">${mime ? escapeHtml(mime) : "(not reported)"}</div>
        </div>
        <div class="sig-item">
          <div class="sig-label">Detected signature</div>
          <div class="sig-value mono">${signature ? escapeHtml(signature.label) : "Unknown"}</div>
        </div>
      </div>
      <div class="sig-status ${statusClass}">
        <span class="sig-status__icon">${statusIcon}</span>
        <span>${escapeHtml(extensionMatch.message)}</span>
      </div>
    `;
    return section;
  }

  function buildBasicInfoSection(file, signature) {
    const section = sectionShell("Basic Information");
    const rows = [
      ["File name", file.name],
      ["File extension", getExtension(file.name) || "(none)"],
      ["File size", `${LensCore.formatBytes(file.size)} (${file.size.toLocaleString()} bytes)`],
      ["MIME type (browser-reported)", file.type || "(not reported)"],
      ["Last modified", file.lastModified ? new Date(file.lastModified).toLocaleString() : "Unknown"],
      ["Detected file type", signature ? signature.label : "Unknown — no matching signature found"],
    ];
    section.querySelector(".section__body").appendChild(buildDefinitionList(rows));
    return section;
  }

  function buildHashSection(hashes, hashError) {
    const section = sectionShell("Hashes");
    const body = section.querySelector(".section__body");
    if (hashError) {
      body.innerHTML = `<p class="muted-note">${escapeHtml(hashError)}</p>`;
      return section;
    }
    const wrap = document.createElement("div");
    wrap.className = "hash-list";
    [
      ["SHA-256", hashes.sha256],
      ["SHA-384", hashes.sha384],
      ["SHA-512", hashes.sha512],
    ].forEach(([label, value]) => {
      const row = document.createElement("div");
      row.className = "hash-row";
      row.innerHTML = `
        <div class="hash-row__label">${label}</div>
        <div class="hash-row__value mono">${value}</div>
        <button type="button" class="btn btn--ghost btn--small hash-copy" data-value="${value}">Copy</button>
      `;
      wrap.appendChild(row);
    });
    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest(".hash-copy");
      if (!btn) return;
      copyToClipboard(btn.dataset.value, btn);
    });
    body.appendChild(wrap);
    return section;
  }

  function buildEntropySection(entropy) {
    const section = sectionShell("Entropy");
    const body = section.querySelector(".section__body");
    if (entropy == null) {
      body.innerHTML = `<p class="muted-note">Entropy could not be calculated for this file.</p>`;
      return section;
    }
    const pct = (entropy / 8) * 100;
    body.innerHTML = `
      <div class="entropy-value mono">Entropy: ${entropy.toFixed(2)} / 8.00</div>
      <div class="entropy-bar"><div class="entropy-bar__fill" style="width:${pct.toFixed(1)}%"></div></div>
      <p class="muted-note">${escapeHtml(LensCore.entropyLabel(entropy))} Shannon entropy measures byte-value randomness on a scale of 0 (perfectly predictable) to 8 (maximally random). It is one signal among many, not a verdict — plenty of ordinary compressed files score high.</p>
    `;
    return section;
  }

  function buildImageSection(file, imageInfo) {
    const section = sectionShell("Image Analysis");
    const body = section.querySelector(".section__body");
    if (!imageInfo || imageInfo.error) {
      body.innerHTML = `<p class="muted-note">${escapeHtml((imageInfo && imageInfo.error) || "Image data could not be read.")}</p>`;
      return section;
    }
    const url = URL.createObjectURL(file);
    currentPreviewUrl = url;
    const rows = [
      ["Width", `${imageInfo.width}px`],
      ["Height", `${imageInfo.height}px`],
      ["Aspect ratio", imageInfo.aspect],
    ];
    if (imageInfo.colorInfo) {
      const c = imageInfo.colorInfo;
      rows.push(["Likely grayscale", c.likelyGrayscale ? "Yes" : "No"]);
      rows.push(["Transparency detected", c.hasTransparency ? "Yes" : "No"]);
      rows.push([
        "Average color (sampled)",
        `rgb(${c.averageColor.r}, ${c.averageColor.g}, ${c.averageColor.b})`,
      ]);
      rows.push(["Distinct colors (sample)", `${c.approxUniqueColorsInSample.toLocaleString()}+`]);
    }

    const wrap = document.createElement("div");
    wrap.className = "image-analysis";
    const preview = document.createElement("img");
    preview.className = "image-analysis__preview";
    preview.src = url;
    preview.alt = `Preview of ${file.name}`;
    wrap.appendChild(preview);
    const infoWrap = document.createElement("div");
    infoWrap.appendChild(buildDefinitionList(rows));
    if (imageInfo.colorInfo) {
      const swatch = document.createElement("div");
      swatch.className = "color-swatch";
      swatch.style.background = `rgb(${imageInfo.colorInfo.averageColor.r}, ${imageInfo.colorInfo.averageColor.g}, ${imageInfo.colorInfo.averageColor.b})`;
      infoWrap.appendChild(swatch);
    }
    wrap.appendChild(infoWrap);
    body.appendChild(wrap);
    return section;
  }

  function buildMetadataForReport(exif) {
    if (exif.malformed) return { malformed: true };
    return {
      standard: pruneNulls({
        make: exif.make,
        model: exif.model,
        software: exif.software,
        date_time: exif.dateTime,
        orientation: exif.orientation,
        exposure_time: exif.exposureTime,
        iso: exif.iso,
        focal_length: exif.focalLength,
      }),
      potentially_sensitive: pruneNulls({
        gps: exif.gps,
        device_make: exif.make,
        device_model: exif.model,
        software_used: exif.software,
        timestamp: exif.dateTime,
      }),
    };
  }

  function pruneNulls(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && v !== undefined) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  }

  function buildMetadataSection(exif) {
    const section = sectionShell("Metadata");
    const body = section.querySelector(".section__body");

    if (exif.malformed) {
      body.innerHTML = `<p class="muted-note">EXIF data appears to be present but could not be parsed reliably — it may be malformed or use an unsupported structure.</p>`;
      return section;
    }

    const standardRows = [
      ["Camera make", exif.make],
      ["Camera model", exif.model],
      ["Software", exif.software],
      ["Date/time", exif.dateTime],
      ["Orientation", exif.orientation],
      ["Exposure time", exif.exposureTime],
      ["ISO", exif.iso],
      ["Focal length", exif.focalLength],
    ].filter(([, v]) => v);

    if (!standardRows.length && !exif.gps) {
      body.innerHTML = `<p class="muted-note">No readable EXIF metadata was found in this JPEG.</p>`;
      return section;
    }

    const standardWrap = document.createElement("div");
    standardWrap.className = "metadata-group";
    standardWrap.innerHTML = `<h3 class="metadata-group__title">Standard metadata</h3>`;
    standardWrap.appendChild(
      standardRows.length ? buildDefinitionList(standardRows) : muted("No standard EXIF fields were found.")
    );
    body.appendChild(standardWrap);

    const sensitiveWrap = document.createElement("div");
    sensitiveWrap.className = "metadata-group metadata-group--sensitive";
    sensitiveWrap.innerHTML = `<h3 class="metadata-group__title">Potentially sensitive metadata</h3>`;
    if (exif.gps) {
      const gpsNote = document.createElement("div");
      gpsNote.className = "gps-flag";
      gpsNote.innerHTML = `
        <div class="gps-flag__icon">⚠</div>
        <div>
          <div>GPS coordinates found: <span class="mono">${exif.gps.latitude.toFixed(6)}, ${exif.gps.longitude.toFixed(6)}</span></div>
          <div class="muted-note">This can reveal where the photo was taken. Strip metadata before sharing publicly if that's a concern.</div>
        </div>
      `;
      sensitiveWrap.appendChild(gpsNote);
    } else {
      sensitiveWrap.appendChild(muted("No GPS coordinates were found in this file."));
    }
    const otherSensitive = [
      ["Device make/model", [exif.make, exif.model].filter(Boolean).join(" ") || null],
      ["Software used", exif.software],
      ["Timestamp", exif.dateTime],
    ].filter(([, v]) => v);
    if (otherSensitive.length) sensitiveWrap.appendChild(buildDefinitionList(otherSensitive));
    body.appendChild(sensitiveWrap);

    return section;
  }

  const STEGO_LIMITATIONS = [
    "Natural, unmodified images can still produce unusual statistical results — these tests describe patterns, not intent.",
    "Editing, resizing, or recompressing an image can change these statistics on its own.",
    "Different steganography tools and algorithms leave different statistical traces; these tests target common LSB replacement specifically.",
    "More sophisticated or format-aware steganography can evade all of the tests below.",
    "A clean result does not prove the image contains no hidden data.",
    "An elevated result does not prove steganography was used — it means the image's statistics resemble what LSB replacement tends to produce.",
  ];

  const VERDICT_LABEL = { none: "Normal", low: "Low indicator", moderate: "Moderate indicator", elevated: "Elevated indicator" };
  const VERDICT_CLASS = { none: "status-ok", low: "status-ok", moderate: "status-warn", elevated: "status-warn" };
  const CHANNEL_NAMES = { r: "Red channel", g: "Green channel", b: "Blue channel", a: "Alpha channel" };

  function buildStegoForReport(stegoSupport, stegoResult, stegoError) {
    if (!stegoSupport) return null;
    if (!stegoSupport.supported) return { supported: false, reason: stegoSupport.reason };
    if (stegoError) return { supported: true, completed: false, error: stegoError };
    if (!stegoResult) return { supported: true, completed: false, error: "No result was produced." };

    const channels = {};
    for (const [name, r] of Object.entries(stegoResult.perChannel)) {
      channels[name] = {
        lsb: { percent_one: r.lsb.percentOne, deviation_from_balance: r.lsb.deviationFromBalance },
        pixel_stats: { mean: r.stats.mean, variance: r.stats.variance, std_dev: r.stats.stdDev },
        adjacent_correlation: r.correlation,
        adjacent_lsb_agreement: r.lsbPairs ? r.lsbPairs.agreement : null,
        chi_square: r.chi.reliable
          ? { statistic: r.chi.statistic, degrees_of_freedom: r.chi.degreesOfFreedom, fit_score: r.chi.pValue }
          : { reliable: false, note: r.chi.note },
        rs_analysis: r.rs.reliable
          ? {
              regular_percent_mask: r.rs.regularPercentM,
              singular_percent_mask: r.rs.singularPercentM,
              regular_percent_neg_mask: r.rs.regularPercentNegM,
              singular_percent_neg_mask: r.rs.singularPercentNegM,
              asymmetry: r.rs.asymmetry,
              estimated_tendency: r.rs.estimatedTendency,
              note: r.rs.note,
            }
          : { reliable: false, note: r.rs.note },
      };
    }

    return {
      supported: true,
      completed: true,
      analyzed_region: { width: stegoResult.analyzedWidth, height: stegoResult.analyzedHeight },
      full_image_size: { width: stegoResult.fullWidth, height: stegoResult.fullHeight },
      region_was_cropped: stegoResult.cropped,
      overall_assessment: stegoResult.overall.overall,
      reasoning: stegoResult.overall.reasoning,
      thresholds: stegoResult.overall.thresholds,
      channels,
      limitations: STEGO_LIMITATIONS,
    };
  }

  function buildStegoSection(stegoSupport, stegoResult, stegoError) {
    const section = sectionShell("Steganalysis");
    const body = section.querySelector(".section__body");

    if (!stegoSupport || !stegoSupport.supported) {
      const reason = stegoSupport ? stegoSupport.reason : "This format is not supported.";
      body.innerHTML = `
        <div class="sig-status status-neutral">
          <span class="sig-status__icon">–</span>
          <span>Analysis status: not available for this format.</span>
        </div>
        <p class="muted-note">${escapeHtml(reason)}</p>
      `;
      return section;
    }

    if (stegoError) {
      body.innerHTML = `
        <div class="sig-status status-neutral">
          <span class="sig-status__icon">–</span>
          <span>Analysis status: could not complete.</span>
        </div>
        <p class="muted-note">${escapeHtml(stegoError)}</p>
      `;
      return section;
    }

    if (!stegoResult) {
      body.innerHTML = `<p class="muted-note">Steganalysis did not produce a result for this image.</p>`;
      return section;
    }

    const { overall, perChannel } = stegoResult;
    const overallClass = VERDICT_CLASS[levelFromOverallLabel(overall.overall)] || "status-neutral";

    const wrap = document.createElement("div");
    wrap.className = "stego";

    // Overall assessment
    const overallEl = document.createElement("div");
    overallEl.className = `sig-status ${overallClass}`;
    overallEl.innerHTML = `
      <span class="sig-status__icon">${overallIcon(overall.overall)}</span>
      <span><strong>Overall: ${escapeHtml(overall.overall.toUpperCase())}</strong> — ${escapeHtml(overall.reasoning)}</span>
    `;
    wrap.appendChild(overallEl);

    if (stegoResult.cropped) {
      wrap.appendChild(
        muted(
          `Analyzed a centered ${stegoResult.analyzedWidth}×${stegoResult.analyzedHeight} region of the full ${stegoResult.fullWidth}×${stegoResult.fullHeight} image to keep analysis responsive.`
        )
      );
    }

    // Tests performed summary
    const testRows = summarizeTests(perChannel);
    const testsWrap = document.createElement("div");
    testsWrap.className = "metadata-group";
    testsWrap.innerHTML = `<h3 class="metadata-group__title">Tests performed</h3>`;
    testsWrap.appendChild(buildDefinitionList(testRows));
    wrap.appendChild(testsWrap);

    // Per-channel breakdown
    for (const [name, r] of Object.entries(perChannel)) {
      wrap.appendChild(buildStegoChannelCard(name, r));
    }

    // Limitations
    const limitsWrap = document.createElement("div");
    limitsWrap.className = "metadata-group";
    limitsWrap.innerHTML = `<h3 class="metadata-group__title">What this can't tell you</h3>`;
    const ul = document.createElement("ul");
    ul.className = "limits-list";
    STEGO_LIMITATIONS.forEach((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      ul.appendChild(li);
    });
    limitsWrap.appendChild(ul);
    wrap.appendChild(limitsWrap);

    body.appendChild(wrap);
    return section;
  }

  function levelFromOverallLabel(label) {
    if (label === "Elevated indicators") return "elevated";
    if (label === "Moderate indicators") return "moderate";
    if (label === "Low indicators") return "low";
    if (label === "No significant indicators") return "none";
    return "neutral"; // Inconclusive
  }

  function overallIcon(label) {
    const level = levelFromOverallLabel(label);
    if (level === "elevated" || level === "moderate") return "⚠";
    if (level === "none" || level === "low") return "✓";
    return "?";
  }

  function summarizeTests(perChannel) {
    const chiLevels = [];
    const rsLevels = [];
    const lsbDeviations = [];
    for (const r of Object.values(perChannel)) {
      chiLevels.push(chiVerdictFor(r.chi));
      rsLevels.push(rsVerdictFor(r.rs));
      lsbDeviations.push(r.lsb.deviationFromBalance);
    }
    const worstOf = (levels) => {
      const rank = { none: 0, low: 1, moderate: 2, elevated: 3, unreliable: -1 };
      let best = "unreliable";
      for (const l of levels) if (rank[l] > rank[best]) best = l;
      return best;
    };
    const maxLsbDeviation = Math.max(...lsbDeviations);
    return [
      ["LSB distribution", `Largest deviation from 50/50 balance: ${maxLsbDeviation.toFixed(2)} percentage points`],
      ["Chi-square", labelForWorst(worstOf(chiLevels))],
      ["RS analysis", labelForWorst(worstOf(rsLevels))],
    ];
  }

  function chiVerdictFor(chi) {
    if (!chi || !chi.reliable || chi.pValue == null) return "unreliable";
    const p = chi.pValue;
    if (p >= 0.999) return "elevated";
    if (p >= 0.95) return "moderate";
    if (p >= 0.8) return "low";
    return "none";
  }

  function rsVerdictFor(rs) {
    if (!rs || !rs.reliable || rs.asymmetry == null) return "unreliable";
    const a = rs.asymmetry;
    if (a >= 15) return "elevated";
    if (a >= 7) return "moderate";
    if (a >= 3) return "low";
    return "none";
  }

  function labelForWorst(level) {
    if (level === "unreliable") return "Analysis inconclusive";
    return VERDICT_LABEL[level] || "Analysis inconclusive";
  }

  function buildStegoChannelCard(name, r) {
    const card = document.createElement("div");
    card.className = "metadata-group stego-channel";
    const title = document.createElement("h3");
    title.className = "metadata-group__title";
    title.textContent = CHANNEL_NAMES[name] || name;
    card.appendChild(title);

    // LSB balance bar (reuses the entropy bar visual language)
    const barWrap = document.createElement("div");
    barWrap.className = "entropy-value mono";
    barWrap.style.marginBottom = "4px";
    barWrap.textContent = `LSBs: ${r.lsb.percentOne.toFixed(2)}% set to 1 (${r.lsb.deviationFromBalance.toFixed(2)} pts from balanced)`;
    card.appendChild(barWrap);
    const bar = document.createElement("div");
    bar.className = "entropy-bar";
    const fill = document.createElement("div");
    fill.className = "entropy-bar__fill";
    fill.style.width = `${Math.min(100, r.lsb.percentOne).toFixed(1)}%`;
    bar.appendChild(fill);
    card.appendChild(bar);

    const rows = [
      [
        "Chi-square (pairs-of-values)",
        r.chi.reliable
          ? `fit score ${r.chi.pValue.toFixed(4)} (df=${r.chi.degreesOfFreedom}) — ${labelForWorst(chiVerdictFor(r.chi))}`
          : `Not reliable — ${r.chi.note}`,
      ],
      [
        "RS analysis",
        r.rs.reliable
          ? `asymmetry ${r.rs.asymmetry.toFixed(2)} pts, estimated tendency ${
              r.rs.estimatedTendency != null ? (r.rs.estimatedTendency * 100).toFixed(1) + "%" : "n/a"
            } — ${labelForWorst(rsVerdictFor(r.rs))}`
          : `Not reliable — ${r.rs.note}`,
      ],
      ["Mean / std. deviation", `${r.stats.mean.toFixed(2)} / ${r.stats.stdDev.toFixed(2)}`],
      ["Adjacent-pixel correlation", r.correlation != null ? r.correlation.toFixed(3) : "n/a"],
      ["Adjacent LSB agreement", r.lsbPairs ? r.lsbPairs.agreement.toFixed(3) : "n/a"],
    ];
    card.appendChild(buildDefinitionList(rows));

    const sparkline = buildHistogramSparkline(r.histogram);
    if (sparkline) card.appendChild(sparkline);

    return card;
  }

  /** Lightweight 32-bin histogram sparkline as inline SVG, single accent color. */
  function buildHistogramSparkline(histogram256) {
    if (!histogram256 || !histogram256.length) return null;
    const bins = 32;
    const binSize = 256 / bins;
    const binned = new Array(bins).fill(0);
    for (let i = 0; i < 256; i++) binned[Math.floor(i / binSize)] += histogram256[i];
    const max = Math.max(...binned, 1);

    const w = 320,
      h = 48,
      pad = 2;
    const points = binned
      .map((v, i) => {
        const x = pad + (i / (bins - 1)) * (w - pad * 2);
        const y = h - pad - (v / max) * (h - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

    const wrap = document.createElement("div");
    wrap.className = "stego-histogram";
    wrap.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Byte value histogram">
        <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.5" />
      </svg>
    `;
    return wrap;
  }

  function buildHexSection(hexBytes) {
    const section = sectionShell(`Hex Viewer (first ${hexBytes.length.toLocaleString()} bytes)`);
    const body = section.querySelector(".section__body");
    const dump = LensCore.formatHexDump(hexBytes);
    const pre = document.createElement("pre");
    pre.className = "hex-dump mono";
    pre.textContent = dump;
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn btn--ghost btn--small";
    copyBtn.textContent = "Copy hex dump";
    copyBtn.addEventListener("click", () => copyToClipboard(dump, copyBtn));
    body.appendChild(pre);
    body.appendChild(copyBtn);
    return section;
  }

  // -----------------------------------------------------------------
  // Small render helpers
  // -----------------------------------------------------------------

  function sectionShell(title) {
    const section = document.createElement("section");
    section.className = "section";
    section.innerHTML = `<h2 class="section__title">${escapeHtml(title)}</h2><div class="section__body"></div>`;
    return section;
  }

  function buildDefinitionList(rows) {
    const dl = document.createElement("dl");
    dl.className = "def-list";
    rows.forEach(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value == null || value === "" ? "—" : value;
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    return dl;
  }

  function muted(text) {
    const p = document.createElement("p");
    p.className = "muted-note";
    p.textContent = text;
    return p;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
  }

  function copyToClipboard(text, btn) {
    navigator.clipboard
      .writeText(text)
      .then(() => flashButton(btn, "Copied"))
      .catch(() => flashButton(btn, "Copy failed"));
  }

  function flashButton(btn, label) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
  }

  function resetToEmptyState() {
    analysisView.hidden = true;
    analysisView.innerHTML = "";
    emptyState.hidden = false;
    fileInput.value = "";
    currentReportData = null;
    if (currentPreviewUrl) {
      URL.revokeObjectURL(currentPreviewUrl);
      currentPreviewUrl = null;
    }
  }

  function exportReport() {
    if (!currentReportData) return;
    const blob = new Blob([JSON.stringify(currentReportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = (currentReportData.file.name || "file").replace(/[^a-z0-9.\-_]/gi, "_");
    a.href = url;
    a.download = `lens-report-${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  }

  function clearError() {
    errorBanner.hidden = true;
    errorBanner.textContent = "";
  }
})();

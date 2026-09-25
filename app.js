/**
 * app.js
 * DOM/UI layer for LENS. All analytical logic lives in lens-core.js and
 * lens-steg.js; this file reads files, calls into them, and renders the
 * result.
 */

(function () {
  "use strict";

  const HEX_PREVIEW_BYTES = 1024;
  const SIGNATURE_READ_BYTES = 64;
  const MAX_COLOR_SAMPLE = 128; // px, for the lightweight color survey
  const MAX_STEG_DIMENSION = 2000; // px per side; larger images are cropped, not resized

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

      const isImage = signature && ["jpeg", "png", "gif", "webp", "bmp"].includes(signature.id);
      const stegSupport = LensSteg.supportForFormat(signature && signature.id);
      let imageInfo = null;
      let exif = null;
      let stegOutcome = null; // { supported, reason } or { supported: true, cropped, sampleWidth, sampleHeight, result }

      if (isImage) {
        try {
          imageInfo = await analyzeImage(file, { wantSteg: stegSupport.supported });
        } catch (e) {
          imageInfo = { error: "Could not read image dimensions or color data." };
        }
        if (stegSupport.supported && imageInfo && imageInfo.stegPixelData) {
          try {
            const workerResult = await runSteganalysis(imageInfo.stegPixelData);
            stegOutcome = {
              supported: true,
              cropped: imageInfo.stegCropped,
              sampleWidth: imageInfo.stegPixelData.width,
              sampleHeight: imageInfo.stegPixelData.height,
              fullWidth: imageInfo.width,
              fullHeight: imageInfo.height,
              result: workerResult,
            };
          } catch (e) {
            stegOutcome = { supported: true, error: "Steganalysis could not be completed for this image." };
          }
          // Pixel buffer no longer needed once analysis has run.
          imageInfo.stegPixelData = null;
        } else if (stegSupport.supported) {
          stegOutcome = { supported: true, error: "Could not extract pixel data for steganalysis." };
        } else {
          stegOutcome = { supported: false, reason: stegSupport.reason };
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
        stegOutcome,
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

  function analyzeImage(file, options) {
    options = options || {};
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
          const canvas = document.createElement("canvas");
          canvas.width = sampleW;
          canvas.height = sampleH;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, sampleW, sampleH);

          let colorInfo = null;
          try {
            const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
            colorInfo = surveyColors(data);
          } catch (e) {
            colorInfo = null; // canvas may be tainted for cross-origin sources; not expected here
          }

          let stegPixelData = null;
          let stegCropped = false;
          if (options.wantSteg && width > 0 && height > 0) {
            try {
              const stegW = Math.min(width, MAX_STEG_DIMENSION);
              const stegH = Math.min(height, MAX_STEG_DIMENSION);
              stegCropped = stegW !== width || stegH !== height;
              const stegCanvas = document.createElement("canvas");
              stegCanvas.width = stegW;
              stegCanvas.height = stegH;
              const stegCtx = stegCanvas.getContext("2d", { willReadFrequently: true });
              // Draw the top-left region 1:1 (no scaling) so LSBs are the
              // real decoded pixel bits, not interpolation artifacts.
              stegCtx.drawImage(img, 0, 0, stegW, stegH, 0, 0, stegW, stegH);
              const fullData = stegCtx.getImageData(0, 0, stegW, stegH);
              stegPixelData = { data: fullData.data, width: stegW, height: stegH };
            } catch (e) {
              stegPixelData = null; // e.g. tainted canvas; steganalysis will be marked unavailable
            }
          }

          URL.revokeObjectURL(url);
          resolve({ width, height, aspect, colorInfo, stegPixelData, stegCropped });
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
  // Steganalysis worker plumbing
  // -----------------------------------------------------------------

  /**
   * Run the heavy steganalysis computation in a Web Worker so the UI
   * thread stays responsive. Falls back to running inline (main thread)
   * if a Worker cannot be created in this context — still correct, just
   * without the responsiveness benefit.
   */
  function runSteganalysis(pixelData) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker("steg-worker.js");
      } catch (e) {
        worker = null;
      }

      if (!worker) {
        try {
          resolve(LensSteg.analyzeImageSteganalysis(pixelData));
        } catch (e) {
          reject(e);
        }
        return;
      }

      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error("Steganalysis timed out."));
      }, 20000);

      worker.onmessage = (e) => {
        clearTimeout(timeout);
        worker.terminate();
        if (e.data && e.data.ok) resolve(e.data.result);
        else reject(new Error((e.data && e.data.error) || "Steganalysis worker failed."));
      };
      worker.onerror = (err) => {
        clearTimeout(timeout);
        worker.terminate();
        reject(err);
      };

      // Transfer the underlying buffer (no copy) — the caller no longer
      // needs this exact Uint8ClampedArray after this point.
      const buffer = pixelData.data.buffer;
      worker.postMessage({ data: buffer, width: pixelData.width, height: pixelData.height }, [buffer]);
    });
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
      stegOutcome,
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
      steganalysis: stegOutcome ? buildSteganalysisForReport(stegOutcome) : null,
    });

    analysisView.innerHTML = "";
    analysisView.appendChild(buildHeaderSection(file, lastModified));
    analysisView.appendChild(buildSignatureSection(extension, file.type, signature, extensionMatch));
    analysisView.appendChild(buildBasicInfoSection(file, signature));
    analysisView.appendChild(buildHashSection(hashes, hashError));
    analysisView.appendChild(buildEntropySection(entropy));
    if (isImage) analysisView.appendChild(buildImageSection(file, imageInfo));
    if (exif) analysisView.appendChild(buildMetadataSection(exif));
    if (stegOutcome) analysisView.appendChild(buildSteganalysisSection(stegOutcome));
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

  // -----------------------------------------------------------------
  // Steganalysis rendering
  // -----------------------------------------------------------------

  const STEG_LEVEL_LABELS = {
    none: "No significant statistical indicators",
    low: "Low indicators",
    moderate: "Moderate indicators",
    elevated: "Elevated indicators",
    inconclusive: "Analysis inconclusive",
  };

  const STEG_LEVEL_STATUS_CLASS = {
    none: "status-ok",
    low: "status-ok",
    moderate: "status-neutral",
    elevated: "status-warn",
    inconclusive: "status-neutral",
  };

  function buildSteganalysisForReport(stegOutcome) {
    if (!stegOutcome.supported) {
      return { analyzed: false, reason: stegOutcome.reason };
    }
    if (stegOutcome.error) {
      return { analyzed: false, error: stegOutcome.error };
    }
    return {
      analyzed: true,
      sample_region: {
        width: stegOutcome.sampleWidth,
        height: stegOutcome.sampleHeight,
        full_width: stegOutcome.fullWidth,
        full_height: stegOutcome.fullHeight,
        cropped_for_performance: stegOutcome.cropped,
      },
      overall: stegOutcome.result.overall,
      channels: stegOutcome.result.channels,
      alpha: stegOutcome.result.alpha,
    };
  }

  function buildSteganalysisSection(stegOutcome) {
    const section = sectionShell("Steganalysis");
    const body = section.querySelector(".section__body");

    if (!stegOutcome.supported) {
      body.innerHTML = `
        <div class="sig-status status-neutral">
          <span class="sig-status__icon">?</span>
          <span>Not analyzed for this format.</span>
        </div>
        <p class="muted-note">${escapeHtml(stegOutcome.reason)}</p>
      `;
      return section;
    }
    if (stegOutcome.error) {
      body.innerHTML = `<p class="muted-note">${escapeHtml(stegOutcome.error)}</p>`;
      return section;
    }

    const result = stegOutcome.result;
    const overall = result.overall;
    const statusClass = STEG_LEVEL_STATUS_CLASS[overall.level] || "status-neutral";
    const overallLabel = STEG_LEVEL_LABELS[overall.level] || overall.level;

    const overallWrap = document.createElement("div");
    overallWrap.innerHTML = `
      <div class="sig-status ${statusClass}">
        <span class="sig-status__icon">${overall.level === "elevated" ? "⚠" : overall.level === "inconclusive" ? "?" : "✓"}</span>
        <span><strong>${escapeHtml(overallLabel.toUpperCase())}</strong> — ${escapeHtml(overall.reason || "")}</span>
      </div>
    `;
    body.appendChild(overallWrap);

    if (stegOutcome.cropped) {
      body.appendChild(
        muted(
          `This image is large (${stegOutcome.fullWidth}×${stegOutcome.fullHeight}px). Analysis was run on the top-left ${stegOutcome.sampleWidth}×${stegOutcome.sampleHeight}px region rather than a resized copy, so as not to distort LSB values. Results reflect that region, not necessarily the whole image.`
        )
      );
    }

    // Tests-performed summary table
    const testsTable = document.createElement("div");
    testsTable.className = "metadata-group";
    testsTable.innerHTML = `<h3 class="metadata-group__title">Tests performed</h3>`;
    const testRows = [
      ["LSB distribution (per channel)", "Balance of 0/1 bits in each channel's least significant bit"],
      ["Chi-square pairs test", "Statistical match to the 'equalized pair' pattern associated with sequential LSB replacement"],
      ["RS analysis", "Regular/singular group analysis (Fridrich et al.), with a model-dependent embedding-rate estimate"],
      ["Pixel statistics", "Mean, variance, adjacent-pixel correlation, LSB-pair distribution"],
    ];
    testsTable.appendChild(buildDefinitionList(testRows));
    body.appendChild(testsTable);

    // Per-channel breakdown
    ["red", "green", "blue"].forEach((name) => {
      body.appendChild(buildStegChannelCard(name, result.channels[name]));
    });

    if (result.alpha.analyzed) {
      body.appendChild(buildStegChannelCard("alpha", result.alpha.channel, true));
    } else {
      const alphaNote = document.createElement("div");
      alphaNote.className = "metadata-group";
      alphaNote.innerHTML = `<h3 class="metadata-group__title">Alpha channel</h3>`;
      alphaNote.appendChild(muted(result.alpha.note));
      body.appendChild(alphaNote);
    }

    // Visualizations: RGB histogram + LSB 0/1 comparison
    body.appendChild(buildStegVisualizations(result));

    // Limitations / disclaimer — always shown, never abbreviated away.
    const disclaimer = document.createElement("div");
    disclaimer.className = "steg-disclaimer";
    disclaimer.innerHTML = `
      <p class="muted-note"><strong>What this does and does not show.</strong> These are statistical
      signals associated with one specific, common style of steganography (sequential LSB replacement
      in raw pixel data) — not a general hidden-data scanner. Natural photos, prior edits, upscaling,
      dithering, and lossy re-encoding can all produce unusual statistics on their own. A clean result
      here does not prove an image has no hidden data. An elevated result does not prove steganography
      was used. Sophisticated or non-sequential embedding, encrypted/whitened payloads, and transform-domain
      techniques (e.g. in JPEG) can evade every test above. Treat this as one input among several, not a verdict.</p>
    `;
    body.appendChild(disclaimer);

    return section;
  }

  function buildStegChannelCard(name, channel, isAlpha) {
    const wrap = document.createElement("div");
    wrap.className = "metadata-group steg-channel";
    wrap.innerHTML = `<h3 class="metadata-group__title">${escapeHtml(capitalize(name))} channel</h3>`;

    const rows = [
      ["Sample size", `${channel.sampleSize.toLocaleString()} pixels`],
      ["Mean", channel.mean.toFixed(2)],
      ["Std. deviation", channel.stddev.toFixed(2)],
      [
        "LSB balance",
        `${channel.lsbBalance.pct0.toFixed(1)}% zero / ${channel.lsbBalance.pct1.toFixed(1)}% one (Δ${channel.lsbBalance.deviationFromBalancedPct.toFixed(1)}pp from 50/50)`,
      ],
      [
        "Chi-square (pairs test)",
        `χ²=${channel.chiSquare.chiSquare.toFixed(1)}, df=${channel.chiSquare.degreesOfFreedom}, p=${
          Number.isFinite(channel.chiSquare.pValue) ? channel.chiSquare.pValue.toFixed(4) : "n/a"
        } — ${STEG_LEVEL_LABELS[channel.chiSquare.level]}`,
      ],
      [
        "RS analysis",
        channel.rsAnalysis.estimateReliable
          ? `~${(channel.rsAnalysis.estimatedEmbeddingRate * 100).toFixed(1)}% estimated embedding rate (model-dependent estimate) — ${STEG_LEVEL_LABELS[channel.rsAnalysis.level]}`
          : `Estimate not reliable for this image — ${STEG_LEVEL_LABELS[channel.rsAnalysis.level]}`,
      ],
      [
        "Adjacent-pixel correlation",
        channel.adjacentCorrelation == null ? "n/a (image too narrow)" : channel.adjacentCorrelation.toFixed(4),
      ],
    ];
    wrap.appendChild(buildDefinitionList(rows));

    if (!isAlpha) {
      const pairs = channel.lsbPairDistribution.percentages;
      const pairNote = document.createElement("p");
      pairNote.className = "muted-note";
      pairNote.textContent = `LSB-pair distribution (this, right-neighbor): 00=${pairs["00"].toFixed(1)}% · 01=${pairs["01"].toFixed(1)}% · 10=${pairs["10"].toFixed(1)}% · 11=${pairs["11"].toFixed(1)}%`;
      wrap.appendChild(pairNote);
    }

    return wrap;
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function buildStegVisualizations(result) {
    const wrap = document.createElement("div");
    wrap.className = "metadata-group";
    wrap.innerHTML = `<h3 class="metadata-group__title">Visualizations</h3>`;

    const row = document.createElement("div");
    row.className = "steg-canvas-row";

    row.appendChild(buildHistogramCanvas(result.channels));
    row.appendChild(buildLsbBarCanvas(result.channels));

    wrap.appendChild(row);
    return wrap;
  }

  function buildHistogramCanvas(channels) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 120;
    canvas.className = "steg-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "RGB value histogram");
    const ctx = canvas.getContext("2d");
    const colors = { red: "#d9724a", green: "#6fbf8b", blue: "#7aa2d9" };
    let max = 1;
    ["red", "green", "blue"].forEach((name) => {
      max = Math.max(max, ...channels[name].histogram);
    });
    ctx.clearRect(0, 0, 256, 120);
    ["red", "green", "blue"].forEach((name) => {
      const hist = channels[name].histogram;
      ctx.strokeStyle = colors[name];
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let v = 0; v < 256; v++) {
        const h = (hist[v] / max) * 116;
        const x = v;
        const y = 118 - h;
        if (v === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
    const caption = document.createElement("figure");
    caption.className = "steg-canvas-figure";
    caption.appendChild(canvas);
    const figcaption = document.createElement("figcaption");
    figcaption.className = "muted-note";
    figcaption.textContent = "Value histogram (0–255) per channel";
    caption.appendChild(figcaption);
    return caption;
  }

  function buildLsbBarCanvas(channels) {
    const canvas = document.createElement("canvas");
    canvas.width = 220;
    canvas.height = 120;
    canvas.className = "steg-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "LSB 0/1 distribution per channel");
    const ctx = canvas.getContext("2d");
    const colors = { red: "#d9724a", green: "#6fbf8b", blue: "#7aa2d9" };
    const names = ["red", "green", "blue"];
    ctx.clearRect(0, 0, 220, 120);
    names.forEach((name, i) => {
      const lsb = channels[name].lsbBalance;
      const groupX = 20 + i * 70;
      const zeroH = (lsb.pct0 / 100) * 90;
      const oneH = (lsb.pct1 / 100) * 90;
      ctx.fillStyle = colors[name];
      ctx.globalAlpha = 0.9;
      ctx.fillRect(groupX, 100 - zeroH, 18, zeroH);
      ctx.globalAlpha = 0.45;
      ctx.fillRect(groupX + 22, 100 - oneH, 18, oneH);
    });
    // 50% reference line
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#5c636b";
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(10, 55);
    ctx.lineTo(210, 55);
    ctx.stroke();

    const caption = document.createElement("figure");
    caption.className = "steg-canvas-figure";
    caption.appendChild(canvas);
    const figcaption = document.createElement("figcaption");
    figcaption.className = "muted-note";
    figcaption.textContent = "LSB 0 (solid) vs 1 (faded) per channel, dashed line = 50%";
    caption.appendChild(figcaption);
    return caption;
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

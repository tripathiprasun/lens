/**
 * lens-core.js
 *
 * Pure, dependency-free logic for LENS.
 * No DOM access here on purpose: everything in this file takes bytes/values
 * in and returns plain data out, so it can run unmodified in a browser
 * <script> tag or under Node's test runner.
 */

(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  } else {
    root.LensCore = mod;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // File signatures ("magic bytes")
  // ---------------------------------------------------------------------
  // Each entry: { id, label, extensions, offset, match(bytes) }
  // match() receives the full byte array (Uint8Array) and returns true/false.
  // Keeping match() as a function (rather than a flat byte list) lets us
  // express formats like WebP/WAV, which need bytes at two offsets.

  function bytesEqual(bytes, offset, expected) {
    if (offset < 0 || offset + expected.length > bytes.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (bytes[offset + i] !== expected[i]) return false;
    }
    return true;
  }

  function asciiAt(bytes, offset, length) {
    if (offset < 0 || offset + length > bytes.length) return "";
    let s = "";
    for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
    return s;
  }

  const SIGNATURES = [
    {
      id: "jpeg",
      label: "JPEG",
      extensions: ["jpg", "jpeg", "jpe", "jfif"],
      match: (b) => bytesEqual(b, 0, [0xff, 0xd8, 0xff]),
    },
    {
      id: "png",
      label: "PNG",
      extensions: ["png"],
      match: (b) => bytesEqual(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    },
    {
      id: "gif",
      label: "GIF",
      extensions: ["gif"],
      match: (b) => asciiAt(b, 0, 6) === "GIF87a" || asciiAt(b, 0, 6) === "GIF89a",
    },
    {
      id: "webp",
      label: "WebP",
      extensions: ["webp"],
      match: (b) => asciiAt(b, 0, 4) === "RIFF" && asciiAt(b, 8, 4) === "WEBP",
    },
    {
      id: "wav",
      label: "WAV",
      extensions: ["wav"],
      match: (b) => asciiAt(b, 0, 4) === "RIFF" && asciiAt(b, 8, 4) === "WAVE",
    },
    {
      id: "pdf",
      label: "PDF",
      extensions: ["pdf"],
      match: (b) => asciiAt(b, 0, 5) === "%PDF-",
    },
    {
      id: "zip",
      label: "ZIP",
      extensions: ["zip", "docx", "xlsx", "pptx", "jar", "apk"],
      match: (b) =>
        bytesEqual(b, 0, [0x50, 0x4b, 0x03, 0x04]) ||
        bytesEqual(b, 0, [0x50, 0x4b, 0x05, 0x06]) ||
        bytesEqual(b, 0, [0x50, 0x4b, 0x07, 0x08]),
    },
    {
      id: "rar",
      label: "RAR",
      extensions: ["rar"],
      match: (b) =>
        bytesEqual(b, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]) ||
        bytesEqual(b, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]),
    },
    {
      id: "7z",
      label: "7z",
      extensions: ["7z"],
      match: (b) => bytesEqual(b, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
    },
    {
      id: "gzip",
      label: "GZIP",
      extensions: ["gz", "gzip", "tgz"],
      match: (b) => bytesEqual(b, 0, [0x1f, 0x8b]),
    },
    {
      id: "mp3",
      label: "MP3",
      extensions: ["mp3"],
      match: (b) =>
        bytesEqual(b, 0, [0x49, 0x44, 0x33]) || // ID3
        bytesEqual(b, 0, [0xff, 0xfb]) ||
        bytesEqual(b, 0, [0xff, 0xf3]) ||
        bytesEqual(b, 0, [0xff, 0xf2]),
    },
    {
      id: "mp4",
      label: "MP4",
      extensions: ["mp4", "m4v", "m4a", "mov"],
      match: (b) => asciiAt(b, 4, 4) === "ftyp",
    },
    {
      id: "webm",
      label: "WebM / Matroska",
      extensions: ["webm", "mkv"],
      match: (b) => bytesEqual(b, 0, [0x1a, 0x45, 0xdf, 0xa3]),
    },
    {
      id: "exe",
      label: "EXE / PE",
      extensions: ["exe", "dll"],
      match: (b) => bytesEqual(b, 0, [0x4d, 0x5a]),
    },
    {
      id: "elf",
      label: "ELF",
      extensions: ["elf", "bin", "so", "out"],
      match: (b) => bytesEqual(b, 0, [0x7f, 0x45, 0x4c, 0x46]),
    },
  ];

  /**
   * Identify a file's signature from its first bytes.
   * @param {Uint8Array} bytes - at least the first ~32 bytes of the file
   * @returns {{id: string, label: string, extensions: string[]}|null}
   */
  function detectSignature(bytes) {
    for (const sig of SIGNATURES) {
      try {
        if (sig.match(bytes)) {
          return { id: sig.id, label: sig.label, extensions: sig.extensions };
        }
      } catch (e) {
        // A malformed/too-short buffer should never throw out of detection.
        continue;
      }
    }
    return null;
  }

  /**
   * Compare a file's extension against its detected signature.
   * @param {string} extension - lowercase, no leading dot, may be ""
   * @param {{extensions: string[]}|null} signature
   * @returns {{status: "match"|"mismatch"|"unknown", message: string}}
   */
  function checkExtensionMatch(extension, signature) {
    const ext = (extension || "").toLowerCase().replace(/^\./, "");
    if (!signature) {
      return {
        status: "unknown",
        message: ext
          ? `Signature not recognized, so ".${ext}" can't be verified.`
          : "Signature not recognized and no extension was given.",
      };
    }
    if (!ext) {
      return {
        status: "unknown",
        message: `No extension given. Detected signature is ${signature.label}.`,
      };
    }
    if (signature.extensions.includes(ext)) {
      return { status: "match", message: "Extension matches detected type." };
    }
    return {
      status: "mismatch",
      message: `Extension ".${ext}" does not match the detected ${signature.label} signature.`,
    };
  }

  // ---------------------------------------------------------------------
  // Shannon entropy
  // ---------------------------------------------------------------------

  /**
   * Approximate Shannon entropy in bits/byte (0-8) over a byte sample.
   * @param {Uint8Array} bytes
   * @returns {number}
   */
  function calculateEntropy(bytes) {
    if (!bytes || bytes.length === 0) return 0;
    const counts = new Uint32Array(256);
    for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
    const len = bytes.length;
    let entropy = 0;
    for (let i = 0; i < 256; i++) {
      if (counts[i] === 0) continue;
      const p = counts[i] / len;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  function entropyLabel(entropy) {
    if (entropy >= 7.5) {
      return "Very high entropy. Consistent with compressed or encrypted data, but not proof of either.";
    }
    if (entropy >= 6) {
      return "Moderately high entropy. Common for compressed media (images, audio, video).";
    }
    if (entropy >= 3) {
      return "Moderate entropy. Typical of structured or partially compressible data.";
    }
    return "Low entropy. Typical of plain text or highly repetitive data.";
  }

  // ---------------------------------------------------------------------
  // Hex dump
  // ---------------------------------------------------------------------

  /**
   * Format bytes as a classic hex + ASCII dump.
   * @param {Uint8Array} bytes
   * @param {number} [bytesPerRow=16]
   * @returns {string}
   */
  function formatHexDump(bytes, bytesPerRow) {
    bytesPerRow = bytesPerRow || 16;
    const lines = [];
    for (let offset = 0; offset < bytes.length; offset += bytesPerRow) {
      const chunk = bytes.subarray(offset, offset + bytesPerRow);
      const hexParts = [];
      let ascii = "";
      for (let i = 0; i < bytesPerRow; i++) {
        if (i < chunk.length) {
          const byte = chunk[i];
          hexParts.push(byte.toString(16).padStart(2, "0").toUpperCase());
          ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
        } else {
          hexParts.push("  ");
        }
        if (i === 7) hexParts.push(""); // mid-row gap, joined with extra space below
      }
      const offsetStr = offset.toString(16).padStart(8, "0").toUpperCase();
      const hexStr = hexParts.join(" ").replace(/  \s/, " ");
      lines.push(`${offsetStr}  ${hexStr}  ${ascii}`);
    }
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------
  // JPEG EXIF parsing (minimal, dependency-free)
  // ---------------------------------------------------------------------

  const EXIF_TAGS = {
    0x010f: "make",
    0x0110: "model",
    0x0131: "software",
    0x0132: "dateTime",
    0x0112: "orientation",
    0x829a: "exposureTime",
    0x8827: "iso",
    0x920a: "focalLength",
    0x8769: "exifIFDPointer",
    0x8825: "gpsIFDPointer",
  };

  const GPS_TAGS = {
    0x0001: "gpsLatitudeRef",
    0x0002: "gpsLatitude",
    0x0003: "gpsLongitudeRef",
    0x0004: "gpsLongitude",
  };

  function readIFD(view, tiffStart, ifdOffset, littleEndian, tagMap, out) {
    if (ifdOffset + 2 > view.byteLength) return null;
    const entryCount = view.getUint16(tiffStart + ifdOffset, littleEndian);
    let nextIFDOffset = null;
    const base = tiffStart + ifdOffset + 2;
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = base + i * 12;
      if (entryOffset + 12 > view.byteLength) break;
      const tag = view.getUint16(entryOffset, littleEndian);
      const type = view.getUint16(entryOffset + 2, littleEndian);
      const count = view.getUint32(entryOffset + 4, littleEndian);
      const valueOffsetField = entryOffset + 8;

      const typeSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
      const size = (typeSizes[type] || 1) * count;
      const dataOffset = size <= 4 ? valueOffsetField : tiffStart + view.getUint32(valueOffsetField, littleEndian);

      const name = tagMap[tag];
      if (name) {
        out[name] = readExifValue(view, dataOffset, type, count, littleEndian);
      }
      if (tag === 0x8769 || tag === 0x8825) {
        out[tagMap[tag]] = view.getUint32(valueOffsetField, littleEndian);
      }
    }
    const nextOffsetField = base + entryCount * 12;
    if (nextOffsetField + 4 <= view.byteLength) {
      nextIFDOffset = view.getUint32(nextOffsetField, littleEndian);
    }
    return nextIFDOffset;
  }

  function readExifValue(view, offset, type, count, littleEndian) {
    try {
      switch (type) {
        case 2: {
          // ASCII string
          let str = "";
          for (let i = 0; i < count; i++) {
            const code = view.getUint8(offset + i);
            if (code === 0) break;
            str += String.fromCharCode(code);
          }
          return str.trim();
        }
        case 3: // SHORT
          return view.getUint16(offset, littleEndian);
        case 4: // LONG
          return view.getUint32(offset, littleEndian);
        case 5: {
          // RATIONAL: numerator/denominator (8 bytes), used for GPS coords too
          if (count === 1) {
            const num = view.getUint32(offset, littleEndian);
            const den = view.getUint32(offset + 4, littleEndian);
            return den === 0 ? 0 : num / den;
          }
          const vals = [];
          for (let i = 0; i < count; i++) {
            const num = view.getUint32(offset + i * 8, littleEndian);
            const den = view.getUint32(offset + i * 8 + 4, littleEndian);
            vals.push(den === 0 ? 0 : num / den);
          }
          return vals;
        }
        case 10: {
          // SRATIONAL
          const num = view.getInt32(offset, littleEndian);
          const den = view.getInt32(offset + 4, littleEndian);
          return den === 0 ? 0 : num / den;
        }
        default:
          return null;
      }
    } catch (e) {
      return null;
    }
  }

  function dmsToDecimal(dms, ref) {
    if (!Array.isArray(dms) || dms.length !== 3) return null;
    const [d, m, s] = dms;
    let decimal = d + m / 60 + s / 3600;
    if (ref === "S" || ref === "W") decimal = -decimal;
    return decimal;
  }

  /**
   * Parse EXIF metadata out of a JPEG file's bytes.
   * Returns null if no EXIF segment is present or the file isn't JPEG.
   * Never throws: malformed EXIF yields a `malformed: true` flag instead.
   * @param {Uint8Array} bytes
   */
  function parseJpegExif(bytes) {
    if (!bytesEqual(bytes, 0, [0xff, 0xd8, 0xff])) return null;

    let offset = 2;
    let exifSegment = null;
    try {
      while (offset < bytes.length - 1) {
        if (bytes[offset] !== 0xff) break;
        const marker = bytes[offset + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        if (marker === 0xda || marker === 0xd9) break; // start of scan / EOI: no more metadata segments
        const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
        if (marker === 0xe1 && asciiAt(bytes, offset + 4, 6) === "Exif\0\0") {
          exifSegment = bytes.subarray(offset + 4 + 6, offset + 2 + segmentLength);
          break;
        }
        offset += 2 + segmentLength;
      }
    } catch (e) {
      return { malformed: true };
    }

    if (!exifSegment || exifSegment.length < 8) return null;

    try {
      const view = new DataView(exifSegment.buffer, exifSegment.byteOffset, exifSegment.byteLength);
      const byteOrder = asciiAt(exifSegment, 0, 2);
      const littleEndian = byteOrder === "II";
      if (byteOrder !== "II" && byteOrder !== "MM") return { malformed: true };

      const firstIFDOffset = view.getUint32(4, littleEndian);
      const tags = {};
      readIFD(view, 0, firstIFDOffset, littleEndian, EXIF_TAGS, tags);

      if (typeof tags.exifIFDPointer === "number") {
        readIFD(view, 0, tags.exifIFDPointer, littleEndian, EXIF_TAGS, tags);
      }

      let gps = null;
      if (typeof tags.gpsIFDPointer === "number") {
        const gpsTags = {};
        readIFD(view, 0, tags.gpsIFDPointer, littleEndian, GPS_TAGS, gpsTags);
        if (gpsTags.gpsLatitude && gpsTags.gpsLongitude) {
          const lat = dmsToDecimal(gpsTags.gpsLatitude, gpsTags.gpsLatitudeRef);
          const lon = dmsToDecimal(gpsTags.gpsLongitude, gpsTags.gpsLongitudeRef);
          if (lat !== null && lon !== null) gps = { latitude: lat, longitude: lon };
        }
      }

      const ORIENTATIONS = {
        1: "Normal",
        2: "Flipped horizontally",
        3: "Rotated 180°",
        4: "Flipped vertically",
        5: "Rotated 90° CW, flipped",
        6: "Rotated 90° CW",
        7: "Rotated 90° CCW, flipped",
        8: "Rotated 90° CCW",
      };

      return {
        make: tags.make || null,
        model: tags.model || null,
        software: tags.software || null,
        dateTime: tags.dateTime || null,
        orientation: ORIENTATIONS[tags.orientation] || null,
        exposureTime: typeof tags.exposureTime === "number" ? `1/${Math.round(1 / tags.exposureTime)} s` : null,
        iso: tags.iso || null,
        focalLength: typeof tags.focalLength === "number" ? `${tags.focalLength.toFixed(1)} mm` : null,
        gps,
        malformed: false,
      };
    } catch (e) {
      return { malformed: true };
    }
  }

  // ---------------------------------------------------------------------
  // Misc helpers
  // ---------------------------------------------------------------------

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return `${i === 0 ? value : value.toFixed(2)} ${units[i]}`;
  }

  function bytesToHexString(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  }

  /**
   * Build a plain-object report suitable for JSON.stringify.
   * Every field is passed in explicitly; this function does no computing
   * of its own beyond assembling the shape, keeping it trivially testable.
   */
  function buildReport(fields) {
    return {
      lens_report_version: 1,
      generated_at: fields.generatedAt,
      file: {
        name: fields.name,
        extension: fields.extension,
        size_bytes: fields.sizeBytes,
        size_readable: formatBytes(fields.sizeBytes),
        browser_mime_type: fields.mimeType || null,
        last_modified: fields.lastModified || null,
      },
      signature: {
        detected_type: fields.signature ? fields.signature.label : "Unknown",
        extension_match: fields.extensionMatch ? fields.extensionMatch.status : "unknown",
        note: fields.extensionMatch ? fields.extensionMatch.message : null,
      },
      hashes: fields.hashes || null,
      entropy: fields.entropy != null ? Number(fields.entropy.toFixed(4)) : null,
      image: fields.image || null,
      metadata: fields.metadata || null,
    };
  }

  return {
    SIGNATURES,
    detectSignature,
    checkExtensionMatch,
    calculateEntropy,
    entropyLabel,
    formatHexDump,
    parseJpegExif,
    formatBytes,
    bytesToHexString,
    buildReport,
    // exposed for tests / advanced use
    _internal: { bytesEqual, asciiAt, dmsToDecimal },
  };
});

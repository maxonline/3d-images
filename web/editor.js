(function () {
  const alignCanvas = document.getElementById('align-canvas');
  const alignCtx = alignCanvas.getContext('2d');

  const previewCanvas = document.getElementById('preview-canvas');
  const previewCtx = previewCanvas.getContext('2d');

  const magnifierCanvas = document.getElementById('magnifier-canvas');
  const magnifierCtx = magnifierCanvas.getContext('2d');
  const alignOffsetLabel = document.getElementById('align-offset-label');
  const alignMagnifierColEl = document.getElementById('align-magnifier-col');
  const nudgeUpBtn = document.getElementById('nudge-up');
  const nudgeDownBtn = document.getElementById('nudge-down');
  const nudgeLeftBtn = document.getElementById('nudge-left');
  const nudgeRightBtn = document.getElementById('nudge-right');

  const frameThumbSectionEl = document.getElementById('frame-thumb-section');
  const thumbStripEl = document.getElementById('thumb-strip');
  const alignHintEl = document.getElementById('align-hint');
  const undoBtn = document.getElementById('undo-btn');

  const cropRatioSectionEl = document.getElementById('crop-ratio-section');
  const lockAlignmentCheckbox = document.getElementById('lock-alignment-checkbox');
  const cropExportPanelEl = document.getElementById('crop-export-panel');

  const orderSectionEl = document.getElementById('order-section');
  const orderSequenceStripEl = document.getElementById('order-sequence-strip');
  const orderInput = document.getElementById('order-input');
  const orderErrorEl = document.getElementById('order-error');

  const brightnessSlider = document.getElementById('brightness-slider');
  const brightnessValue = document.getElementById('brightness-value');
  const contrastSlider = document.getElementById('contrast-slider');
  const contrastValue = document.getElementById('contrast-value');
  const hueSlider = document.getElementById('hue-slider');
  const hueValue = document.getElementById('hue-value');
  const colorModeRadios = document.querySelectorAll('input[name="color-mode"]');
  const cropRatioRadios = document.querySelectorAll('input[name="crop-ratio"]');

  const fpsSlider = document.getElementById('fps-slider');
  const fpsValue = document.getElementById('fps-value');
  const interpSlider = document.getElementById('interp-slider');
  const interpValue = document.getElementById('interp-value');

  const scaleSlider = document.getElementById('scale-slider');
  const scaleValue = document.getElementById('scale-value');
  const scaleWidthInput = document.getElementById('scale-width-input');
  const outputSizeLabel = document.getElementById('output-size-label');
  const resultSizeLabel = document.getElementById('result-size-label');

  const generateGifBtn = document.getElementById('generate-gif-btn');
  const generateWebpBtn = document.getElementById('generate-webp-btn');
  const generateMp4Btn = document.getElementById('generate-mp4-btn');
  const editorEl = document.getElementById('editor');
  const outputEl = document.getElementById('output');
  const outputGif = document.getElementById('output-gif');
  const outputVideo = document.getElementById('output-video');
  const downloadLink = document.getElementById('download-link');

  // Declared up front (not down by state's other fields) because the
  // support-detection blocks below call updateGenerateButtonsDisabled(),
  // which reads this — including, for mp4Supported, from a synchronous
  // catch path that can run before the rest of the script has executed.
  let orderValid = true; // gates Generate buttons independently of webpSupported/mp4Supported

  // WebKit (so every browser on iOS, regardless of name) has no animated-WebP
  // encoder and its canvas.toBlob('image/webp', ...) silently falls back to
  // PNG rather than erroring. Detect that once up front and disable the
  // button with an explanation, instead of letting someone wait through a
  // full export only to hit an error at the very end.
  let webpSupported = true;
  (function detectWebpSupport() {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    canvasToBlob(c, 'image/webp', 0.8)
      .then((blob) => blob.type === 'image/webp')
      .catch(() => false)
      .then((supported) => {
        webpSupported = supported;
        if (!supported) {
          generateWebpBtn.title = "This browser can't encode WebP (common on iOS, where every browser uses Safari's engine) — use Generate GIF instead.";
        }
        updateGenerateButtonsDisabled();
      });
  })();

  // MP4 export needs WebCodecs (VideoEncoder) to encode H.264, which the
  // vendored mp4-muxer library then wraps in an MP4 container — there's no
  // built-in muxer either, same gap as the animated-WebP case above.
  // WebCodecs is unavailable on older Safari/iOS and on Firefox without a
  // flag, so this is detected once up front exactly like webpSupported.
  let mp4Supported = true;
  (function detectMp4Support() {
    if (!window.VideoEncoder || !window.Mp4Muxer) {
      mp4Supported = false;
      generateMp4Btn.title = "This browser can't encode MP4 (needs WebCodecs) — use Generate GIF or WebP instead.";
      updateGenerateButtonsDisabled();
      return;
    }
    // A browser with a partial/buggy WebCodecs implementation could have
    // VideoEncoder exist but have isConfigSupported() throw synchronously
    // instead of rejecting its promise (rather than just reporting
    // unsupported) — and since this whole block runs unconditionally at
    // script-load time, an uncaught throw here would abort the rest of
    // editor.js entirely, including `window.Editor = ...` at the very
    // bottom, breaking the app for everyone. Wrap it so any failure here
    // — sync or async — degrades to "MP4 unsupported" instead.
    try {
      VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', width: 64, height: 64, bitrate: 1e5 })
        .then((result) => {
          mp4Supported = !!(result && result.supported);
          if (!mp4Supported) {
            generateMp4Btn.title = "This browser can't encode H.264 — use Generate GIF or WebP instead.";
          }
          updateGenerateButtonsDisabled();
        })
        .catch(() => {
          mp4Supported = false;
          generateMp4Btn.title = "This browser can't encode MP4 — use Generate GIF or WebP instead.";
          updateGenerateButtonsDisabled();
        });
    } catch (err) {
      mp4Supported = false;
      generateMp4Btn.title = "This browser can't encode MP4 — use Generate GIF or WebP instead.";
      updateGenerateButtonsDisabled();
    }
  })();

  const ALIGN_DISPLAY_MAX_W = 760;
  const ALIGN_DISPLAY_MAX_H = 560;
  // Extra native-pixel space drawn around the images on the align canvas, so
  // dragging one frame away from the other (typical W3 parallax is well under
  // this) never pushes either frame off the visible canvas.
  const ALIGN_MARGIN_NATIVE = 200;
  const PREVIEW_DISPLAY_MAX_W = 640;
  const PREVIEW_DISPLAY_MAX_H = 480;
  const MIN_OVERLAP_FRACTION = 0.3; // overlap must retain at least 30% of W and H
  const MIN_CROP = 20; // native px, both dimensions
  const HANDLE_R = 6; // crop handle half-size, in canvas-space px (not scaled with zoom)
  const HIT_TOLERANCE_PX = 8;
  const TINT_LEFT = 'rgba(255, 40, 40, 0.35)';
  const TINT_RIGHT = 'rgba(40, 200, 255, 0.35)';
  const MAGNIFIER_ZOOM = 4; // how much more zoomed-in the loupe is vs native pixels
  const MAX_FRAMES = 10;
  const MAX_ORDER_LENGTH = 100;

  // Crop width:height ratio for each radio option; null ("none") means free-form.
  const CROP_RATIOS = {
    none: null,
    '1:1': 1 / 1,
    '1:2': 1 / 2,
    '2:1': 2 / 1,
    '4:3': 4 / 3,
    '3:2': 3 / 2,
    '4:5': 4 / 5,
    '9:16': 9 / 16,
    '16:9': 16 / 9,
    '1.91:1': 1.91 / 1,
  };

  const state = {
    frames: [],   // [{ img: HTMLImageElement, dx: number, dy: number }], length 2..10.
                  // frames[0].dx/dy are ALWAYS {0,0} — the fixed anchor. Every other frame's
                  // dx/dy is its offset relative to frame 0, in native px.
    W: 0, H: 0,   // native px, taken from frames[0]
    baseName: 'wiggle',
    crop: { x: 0, y: 0, w: 0, h: 0 },
    cropRatio: null, // locked width/height ratio, or null for free-form
    alignmentLocked: false, // when true, a plain drag moves the crop instead of aligning — no Space needed
    adjust: { brightness: 0, contrast: 0, hue: 0, colorMode: 'normal' },
    fps: 8,
    outputScalePercent: 100,

    baseOrder: [], // 0-indexed real-frame sequence (defaultOrder() or parseOrder() output)
    interpolationCount: 0, // K in-between frames inserted per step of baseOrder
    order: [], // withInterpolation(baseOrder, interpolationCount) — what preview + export actually draw

    mode: 'ready', // 'stepping' | 'ready'. Always 'ready' when frames.length === 2.
    alignStep: {
      current: 1,     // 1-indexed slot being aligned now (frames[current] dragged against
                       // frames[0..current-1]). Ranges 1..N-1.
      confirmed: [],   // boolean[N]; confirmed[0] always true (anchor).
    },

    drag: null,
    previewRAF: null,
    previewElapsed: 0,
    previewOrderIdx: 0, // index into state.order
  };

  let alignScale = 1;
  let previewScale = 1;

  function frameCount() {
    return state.frames.length;
  }

  // The align canvas always drags whichever frame is currently selected
  // (state.alignStep.current) — for 2 frames that's permanently frame 1
  // (no thumbnail strip exists to reselect it); for 3+ frames it's whichever
  // thumbnail was last clicked, regardless of whether alignment is still in
  // its initial pass or every frame has already been touched once.
  function activeAlignFrameIndex() {
    return state.alignStep.current;
  }

  function computeScale(canvasEl, nativeW, nativeH, maxW, maxH) {
    const scale = Math.min(1, maxW / nativeW, maxH / nativeH);
    canvasEl.width = Math.max(1, Math.round(nativeW * scale));
    canvasEl.height = Math.max(1, Math.round(nativeH * scale));
    return scale;
  }

  function recomputeAlignScale() {
    alignScale = computeScale(
      alignCanvas,
      state.W + ALIGN_MARGIN_NATIVE * 2,
      state.H + ALIGN_MARGIN_NATIVE * 2,
      ALIGN_DISPLAY_MAX_W,
      ALIGN_DISPLAY_MAX_H
    );
  }

  function recomputePreviewScale() {
    previewScale = computeScale(previewCanvas, state.crop.w, state.crop.h, PREVIEW_DISPLAY_MAX_W, PREVIEW_DISPLAY_MAX_H);
  }

  function clientToCanvasXY(canvasEl, clientX, clientY) {
    const rect = canvasEl.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (canvasEl.width / rect.width),
      y: (clientY - rect.top) * (canvasEl.height / rect.height),
    };
  }

  // Converts a client-space drag delta into a native-image-pixel delta, going
  // via canvas-space so it stays correct even if the canvas's CSS size differs
  // from its backing-store size (e.g. a narrow viewport shrinking it).
  function nativeDelta(canvasEl, scale, startClientX, startClientY, clientX, clientY) {
    const start = clientToCanvasXY(canvasEl, startClientX, startClientY);
    const cur = clientToCanvasXY(canvasEl, clientX, clientY);
    return { dx: (cur.x - start.x) / scale, dy: (cur.y - start.y) / scale };
  }

  // N-way intersection of every frame's placed rect [dx,dy,dx+W,dy+H], seeded
  // with frame 0's own rect [0,0,W,H].
  function computeOverlapRectN(frames, W, H) {
    let x0 = 0, y0 = 0, x1 = W, y1 = H;
    for (const f of frames) {
      x0 = Math.max(x0, f.dx);
      y0 = Math.max(y0, f.dy);
      x1 = Math.min(x1, f.dx + W);
      y1 = Math.min(y1, f.dy + H);
    }
    return { x0, y0, x1, y1, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }

  // While stepping, only confirmed frames contribute to the overlap — frames
  // never selected yet don't have a settled position. selectFrame() confirms
  // a frame the instant it's chosen, so the active frame is always already
  // included here by the time this runs; confirmation order is NOT
  // necessarily increasing index order (frames can be picked in any order),
  // so this must filter by the confirmed set, not slice a contiguous prefix.
  // Once ready, every frame's final offset counts, confirmed or not.
  function currentOverlapFrames() {
    return state.mode === 'stepping'
      ? state.frames.filter((f, i) => state.alignStep.confirmed[i])
      : state.frames;
  }

  function currentOverlapRect() {
    return computeOverlapRectN(currentOverlapFrames(), state.W, state.H);
  }

  function clampAlign(dx, dy, W, H) {
    const maxDx = W * (1 - MIN_OVERLAP_FRACTION);
    const maxDy = H * (1 - MIN_OVERLAP_FRACTION);
    return {
      dx: Math.max(-maxDx, Math.min(maxDx, dx)),
      dy: Math.max(-maxDy, Math.min(maxDy, dy)),
    };
  }

  function resetCropToOverlap() {
    const ov = currentOverlapRect();
    state.crop = state.cropRatio
      ? fitCropToRatio({ x: ov.x0, y: ov.y0, w: ov.w, h: ov.h }, state.cropRatio, ov)
      : { x: ov.x0, y: ov.y0, w: ov.w, h: ov.h };
  }

  // Largest rect matching `ratio` (width/height) that (a) fits within `crop`'s
  // current size — so locking a ratio never suddenly balloons the crop
  // bigger than what was there — and (b) fits within the overlap `ov`,
  // centered on `crop`'s center, clamped into `ov` if centering would push
  // it outside.
  function fitCropToRatio(crop, ratio, ov) {
    let w = crop.w;
    let h = w / ratio;
    if (h > crop.h) {
      h = crop.h;
      w = h * ratio;
    }

    const scale = Math.min(1, ov.w / w, ov.h / h);
    w = Math.max(MIN_CROP, w * scale);
    h = Math.max(MIN_CROP, h * scale);

    const cx = crop.x + crop.w / 2;
    const cy = crop.y + crop.h / 2;
    const x = Math.max(ov.x0, Math.min(cx - w / 2, ov.x1 - w));
    const y = Math.max(ov.y0, Math.min(cy - h / 2, ov.y1 - h));
    return { x, y, w, h };
  }

  function clampCropToOverlap() {
    const ov = currentOverlapRect();
    if (state.cropRatio) {
      state.crop = fitCropToRatio(state.crop, state.cropRatio, ov);
      return;
    }
    let { x, y, w, h } = state.crop;
    w = Math.max(Math.min(w, ov.w), Math.min(MIN_CROP, ov.w));
    h = Math.max(Math.min(h, ov.h), Math.min(MIN_CROP, ov.h));
    x = Math.max(ov.x0, Math.min(x, ov.x1 - w));
    y = Math.max(ov.y0, Math.min(y, ov.y1 - h));
    state.crop = { x, y, w, h };
  }

  function clampResizeCrop(startCrop, handle, dx, dy, ratio) {
    const ov = currentOverlapRect();
    const right = startCrop.x + startCrop.w;
    const bottom = startCrop.y + startCrop.h;

    // The anchor is the corner opposite the one being dragged — it never
    // moves, matching how a free-form resize already behaves per-handle.
    const anchorX = (handle === 'nw' || handle === 'sw') ? right : startCrop.x;
    const anchorY = (handle === 'nw' || handle === 'ne') ? bottom : startCrop.y;

    let w = Math.abs(((handle === 'nw' || handle === 'sw') ? startCrop.x + dx : right + dx) - anchorX);
    let h = Math.abs(((handle === 'nw' || handle === 'ne') ? startCrop.y + dy : bottom + dy) - anchorY);

    if (ratio) {
      // Drive the resize from whichever axis moved more (in raw drag
      // pixels), so it tracks the dominant drag direction instead of
      // always favoring one axis.
      if (Math.abs(dx) >= Math.abs(dy)) {
        h = w / ratio;
      } else {
        w = h * ratio;
      }
    }

    w = Math.max(MIN_CROP, w);
    h = Math.max(MIN_CROP, h);

    // Available space from the anchor toward the overlap edge the drag is extending into.
    const maxW = (handle === 'nw' || handle === 'sw') ? anchorX - ov.x0 : ov.x1 - anchorX;
    const maxH = (handle === 'nw' || handle === 'ne') ? anchorY - ov.y0 : ov.y1 - anchorY;

    if (ratio) {
      // Scale both dimensions uniformly to fit, so the ratio is preserved exactly.
      const scale = Math.min(1, maxW / w, maxH / h);
      w *= scale;
      h *= scale;
      if (w < MIN_CROP || h < MIN_CROP) {
        const growScale = Math.max(MIN_CROP / w, MIN_CROP / h);
        w = Math.min(maxW, w * growScale);
        h = Math.min(maxH, h * growScale);
      }
    } else {
      w = Math.min(w, maxW);
      h = Math.min(h, maxH);
    }

    const x = (handle === 'nw' || handle === 'sw') ? anchorX - w : anchorX;
    const y = (handle === 'nw' || handle === 'ne') ? anchorY - h : anchorY;
    return { x, y, w, h };
  }

  // The crop rect defines the SOURCE region (native pixels); the output
  // scale independently controls the DESTINATION pixel size that region gets
  // drawn into for the final file — i.e. downsampling happens at export time,
  // the crop selection itself is never affected by it.
  function computeOutputSize() {
    const scale = state.outputScalePercent / 100;
    return {
      w: Math.max(1, Math.round(state.crop.w * scale)),
      h: Math.max(1, Math.round(state.crop.h * scale)),
    };
  }

  // Set while the width textbox's own 'input' handler is applying what was
  // just typed — see the listener below for why.
  let editingScaleWidthInput = false;

  function updateOutputSizeLabel() {
    const { w, h } = computeOutputSize();
    outputSizeLabel.textContent = `Output size: ${w} × ${h} px`;
    // Keep the width textbox showing the actual current output width
    // whenever something ELSE changed it — the % slider, a crop resize —
    // but NOT while the user is actively typing into it: this used to
    // unconditionally overwrite it here too, which (since a typed width
    // only maps to a whole-percent scale, then gets rounded back to
    // pixels) rewrote whatever had just been typed on literally every
    // keystroke — e.g. typing "1" immediately became "349" (1px rounds
    // down to 0%, clamped up to the 10% minimum, 10% of a ~3488px-wide
    // crop), making it impossible to type any further digits at all. The
    // box now reformats to the precise resulting width only once editing
    // finishes (on blur, see below), not on every keystroke.
    if (!editingScaleWidthInput) scaleWidthInput.value = w;
  }

  // scalePercentForWidth/DEFAULT_OUTPUT_WIDTH: converts a desired output
  // WIDTH in px into the equivalent outputScalePercent, the single source
  // of truth computeOutputSize() actually reads — the width textbox is
  // just another way to set that same percentage, not a separate mode, so
  // resizing the crop afterward keeps behaving exactly like it already did
  // (output size scales proportionally with the crop, same as dragging the
  // % slider always has). Clamped to the slider's own [10,100] range —
  // can't request upscaling past the crop's native resolution.
  const DEFAULT_OUTPUT_WIDTH = 1080;

  function scalePercentForWidth(width, cropWidth) {
    return Math.max(10, Math.min(100, Math.round((width / cropWidth) * 100)));
  }

  function sourceRectFor(frameIndex, crop, offsetOverride) {
    const f = state.frames[frameIndex];
    const dx = offsetOverride ? offsetOverride.dx : f.dx;
    const dy = offsetOverride ? offsetOverride.dy : f.dy;
    return { sx: crop.x - dx, sy: crop.y - dy, sw: crop.w, sh: crop.h };
  }

  function clamp255(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  // Applies brightness/contrast/hue-rotate/grayscale/sepia to an ImageData
  // in place, by hand — NOT via ctx.filter. WebKit (Safari, and therefore
  // every iOS browser regardless of name, since Apple requires them all to
  // use its engine) silently ignores CanvasRenderingContext2D.filter: no
  // error, no effect, images just draw unmodified. getImageData/putImageData
  // has no such gap on any engine, so doing the math ourselves is the only
  // reliable cross-browser way to apply these adjustments.
  //
  // The formulas match the CSS Filter Effects spec exactly (same brightness/
  // contrast/hue-rotate/grayscale/sepia this used to delegate to via
  // ctx.filter), so results are visually identical on browsers where the
  // native filter would have worked anyway.
  function applyPixelAdjustments(imageData, brightness, contrast, hueDeg, colorMode) {
    const data = imageData.data;
    const b = 1 + brightness / 100; // 0..2
    const c = 1 + contrast / 100; // 0..2
    const hueRad = (hueDeg * Math.PI) / 180;
    const cosH = Math.cos(hueRad);
    const sinH = Math.sin(hueRad);
    const applyHue = hueDeg % 360 !== 0;

    // SVG/CSS feColorMatrix "hueRotate" luminance-preserving rotation matrix.
    const m00 = 0.213 + cosH * 0.787 - sinH * 0.213;
    const m01 = 0.715 - cosH * 0.715 - sinH * 0.715;
    const m02 = 0.072 - cosH * 0.072 + sinH * 0.928;
    const m10 = 0.213 - cosH * 0.213 + sinH * 0.143;
    const m11 = 0.715 + cosH * 0.285 + sinH * 0.14;
    const m12 = 0.072 - cosH * 0.072 - sinH * 0.283;
    const m20 = 0.213 - cosH * 0.213 - sinH * 0.787;
    const m21 = 0.715 - cosH * 0.715 + sinH * 0.715;
    const m22 = 0.072 + cosH * 0.928 + sinH * 0.072;

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i] * b;
      let g = data[i + 1] * b;
      let bch = data[i + 2] * b;

      r = clamp255((r - 128) * c + 128);
      g = clamp255((g - 128) * c + 128);
      bch = clamp255((bch - 128) * c + 128);

      if (applyHue) {
        const nr = m00 * r + m01 * g + m02 * bch;
        const ng = m10 * r + m11 * g + m12 * bch;
        const nb = m20 * r + m21 * g + m22 * bch;
        r = nr;
        g = ng;
        bch = nb;
      }

      if (colorMode === 'bw') {
        const gray = 0.2126 * r + 0.7152 * g + 0.0722 * bch;
        r = g = bch = gray;
      } else if (colorMode === 'sepia') {
        const sr = 0.393 * r + 0.769 * g + 0.189 * bch;
        const sg = 0.349 * r + 0.686 * g + 0.168 * bch;
        const sb = 0.272 * r + 0.534 * g + 0.131 * bch;
        r = sr;
        g = sg;
        bch = sb;
      }

      data[i] = clamp255(r);
      data[i + 1] = clamp255(g);
      data[i + 2] = clamp255(bch);
    }
  }

  // Draws one frame's cropped source pixels into destCtx, unadjusted — no
  // pixel math, no tint. offsetOverride lets a frame be sampled as if it
  // sat at some other (dx, dy) than its own real alignment offset, which is
  // how drawInterpolatedFrame below synthesizes an in-between frame: both
  // contributing frames get drawn through the SAME offset override, so they
  // land in registration with each other for the blend.
  function drawFrameRaw(destCtx, frameIndex, destX, destY, destW, destH, offsetOverride, alpha) {
    const f = state.frames[frameIndex];
    const { sx, sy, sw, sh } = sourceRectFor(frameIndex, state.crop, offsetOverride);
    destCtx.save();
    if (alpha != null) destCtx.globalAlpha = alpha;
    destCtx.drawImage(f.img, sx, sy, sw, sh, destX, destY, destW, destH);
    destCtx.restore();
  }

  // Applies brightness/contrast/hue/color-mode + anaglyph tint to whatever
  // is already drawn in destCtx's destX/destY/destW/destH region — shared by
  // the single-frame and interpolated-blend draw paths below so adjustments
  // are applied once to the final composited pixels, not per source layer.
  function applyDestAdjustmentsAndTint(destCtx, destX, destY, destW, destH, frameIndexForTint) {
    const needsPixelAdjust = state.adjust.brightness !== 0 || state.adjust.contrast !== 0 ||
      state.adjust.hue !== 0 || state.adjust.colorMode === 'bw' || state.adjust.colorMode === 'sepia';
    if (needsPixelAdjust) {
      const w = Math.max(1, Math.round(destW));
      const h = Math.max(1, Math.round(destH));
      const imageData = destCtx.getImageData(destX, destY, w, h);
      applyPixelAdjustments(imageData, state.adjust.brightness, state.adjust.contrast, state.adjust.hue, state.adjust.colorMode);
      destCtx.putImageData(imageData, destX, destY);
    }

    if (state.adjust.colorMode === 'anaglyph') {
      destCtx.save();
      destCtx.globalCompositeOperation = 'multiply';
      destCtx.fillStyle = frameIndexForTint % 2 === 0 ? TINT_LEFT : TINT_RIGHT;
      destCtx.fillRect(destX, destY, destW, destH);
      destCtx.restore();
    }
  }

  // Draws one adjusted/cropped/tinted frame into destCtx. Used by both the
  // live preview loop and the final full-resolution GIF/WebP/MP4 export, so
  // the preview can never drift from the actual exported file.
  function drawAdjustedFrame(destCtx, frameIndex, destX, destY, destW, destH) {
    drawFrameRaw(destCtx, frameIndex, destX, destY, destW, destH, null, null);
    applyDestAdjustmentsAndTint(destCtx, destX, destY, destW, destH, frameIndex);
  }

  // Synthesizes an in-between frame at entry.t (0..1) between real frames
  // entry.a and entry.b: linearly interpolate the rigid alignment offset
  // between them, then draw both frames' raw pixels through that SAME
  // offset — entry.a opaque as the base, entry.b alpha-blended on top at
  // globalAlpha = entry.t. Sequencing matters: drawing the base fully
  // opaque (not at alpha 1-t) then the top at alpha t is what makes
  // Porter-Duff source-over compositing work out to the correct linear
  // blend B*t + A*(1-t) — the same sequencing drawRunningAverageStack
  // already relies on elsewhere in this file for its running-average
  // ghosted alignment backdrop.
  //
  // This is a linear shift+crossfade approximation, not true optical-flow
  // motion interpolation — there's no per-pixel motion estimation, just the
  // same single rigid per-frame offset the rest of the app already uses for
  // alignment. It's provably safe with no new bounds-checking: since
  // state.crop is already clamped inside the overlap of every confirmed
  // frame's REAL offset, and entry.t's interpolated offset always lies
  // between two offsets already proven safe, sampling either source image
  // through that interpolated offset always stays within its native bounds.
  //
  // Used as (a) the resilience fallback if the optical-flow library below
  // fails to load/run, and (b) the instant placeholder shown the moment an
  // interpolation count is dialed up, before that entry's real flow-based
  // frame has finished computing — see drawOrderEntry.
  function drawInterpolatedFrameRigid(destCtx, entry, destX, destY, destW, destH) {
    const fa = state.frames[entry.a];
    const fb = state.frames[entry.b];
    const dx = fa.dx + (fb.dx - fa.dx) * entry.t;
    const dy = fa.dy + (fb.dy - fa.dy) * entry.t;
    const offset = { dx, dy };
    drawFrameRaw(destCtx, entry.a, destX, destY, destW, destH, offset, null);
    drawFrameRaw(destCtx, entry.b, destX, destY, destW, destH, offset, entry.t);
    applyDestAdjustmentsAndTint(destCtx, destX, destY, destW, destH, entry.a);
  }

  // --- Optical-flow interpolation (opencv.js) ---
  //
  // The rigid shift+crossfade above treats the whole frame as one flat
  // plane, so anything off the alignment plane (closer or farther than
  // whatever the user aligned on) shows double-exposure ghosting instead of
  // real motion. Real per-pixel motion estimation fixes that, but there's no
  // such thing built into a browser, and training/shipping a neural
  // interpolation model (RIFE, FILM, etc.) is far too heavy for a static
  // no-build-step site. Farneback dense optical flow (a classical, non-ML
  // OpenCV algorithm) is the pragmatic middle ground: genuinely per-pixel,
  // and available in a browser build of OpenCV.
  //
  // Loaded from a CDN, NOT vendored into web/lib/ like every other
  // dependency in this app — this is a deliberate one-off exception. The
  // browser build is ~13MB (WASM embedded inline as a JS
  // string), far larger than anything else this project has ever
  // committed, and this whole feature is an experiment the user explicitly
  // asked to "try out"; committing 13MB of generated code to git for that
  // felt wrong. It's loaded lazily — only the first time interpolation is
  // actually turned on — never as a blocking page-load dependency like
  // gif.js/mp4-muxer.js. If this technique proves worth keeping
  // permanently, self-hosting it in web/lib/ should be reconsidered then.
  const OPENCV_CDN_URL = 'https://unpkg.com/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js';
  // Generous, but not unbounded — a 13MB download over a slow/flaky mobile
  // connection can legitimately take a while, but with NO timeout at all a
  // connection that stalls (rather than cleanly failing, which script.onerror
  // already handles) would leave "Preparing optical-flow interpolation…"
  // stuck forever with no fallback ever kicking in. This is a real concern
  // specifically for phones on cellular, not just a desktop-testing nicety.
  const OPENCV_LOAD_TIMEOUT_MS = 30000;
  let cvReadyPromise = null;

  function loadOpenCv() {
    if (cvReadyPromise) return cvReadyPromise;
    cvReadyPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Timed out loading the optical-flow library (slow connection?)'));
      }, OPENCV_LOAD_TIMEOUT_MS);
      const settle = (fn, arg) => {
        clearTimeout(timeoutId);
        fn(arg);
      };

      const script = document.createElement('script');
      script.src = OPENCV_CDN_URL;
      script.onload = () => {
        // This build's UMD wrapper (root.cv = factory()) assigns a PROMISE
        // to window.cv, not the resolved module — it resolves once the
        // WASM runtime finishes initializing. (Older/other opencv.js
        // builds instead expose the module synchronously and signal
        // readiness via cv.onRuntimeInitialized; handle both shapes.)
        if (window.cv && typeof window.cv.then === 'function') {
          window.cv.then(
            (readyCv) => { window.cv = readyCv; settle(resolve, readyCv); },
            (err) => settle(reject, err)
          );
        } else if (window.cv && window.cv.Mat) {
          settle(resolve, window.cv);
        } else {
          window.cv = window.cv || {};
          window.cv['onRuntimeInitialized'] = () => settle(resolve, window.cv);
        }
      };
      script.onerror = () => settle(reject, new Error("Could not load the optical-flow library from the CDN — check your connection."));
      document.head.appendChild(script);
    }).catch((err) => {
      // Don't cache a failed attempt forever — a timeout or transient
      // network error shouldn't permanently lock this session out of real
      // optical-flow interpolation; the next time interpolation prep runs
      // (e.g. the user nudges the slider again), this retries fresh rather
      // than replaying the same rejected promise.
      cvReadyPromise = null;
      throw err;
    });
    return cvReadyPromise;
  }

  // Farneback flow (and the warp built from it) runs at a capped working
  // resolution, not the native crop size — remap/flow cost scales with
  // pixel count, and this keeps a single pair's prep well under a second
  // instead of potentially tens of seconds on a real camera-resolution
  // crop. The interpolated frame's own resolution is capped accordingly
  // (then scaled up like any other drawImage call); the two REAL endpoint
  // frames on either side of it are unaffected and stay full native res.
  const FLOW_WORK_DIM = 640;

  const flowPairCache = new Map(); // "a-b" -> { dx: Float32Array, dy: Float32Array, w, h }
  const interpFrameCache = new Map(); // "a-b-t" -> HTMLCanvasElement (small, warped+blended, unadjusted)

  // Must be called whenever anything the flow was computed FROM changes:
  // a new set of images, or any frame's crop or alignment offset.
  function clearInterpolationCaches() {
    flowPairCache.clear();
    interpFrameCache.clear();
  }

  function computeFlowWorkSize(nativeW, nativeH) {
    const scale = Math.min(1, FLOW_WORK_DIM / Math.max(nativeW, nativeH));
    return { w: Math.max(1, Math.round(nativeW * scale)), h: Math.max(1, Math.round(nativeH * scale)) };
  }

  function drawCroppedFrameToCanvas(frameIndex, w, h) {
    const f = state.frames[frameIndex];
    const { sx, sy, sw, sh } = sourceRectFor(frameIndex, state.crop);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(f.img, sx, sy, sw, sh, 0, 0, w, h);
    return c;
  }

  // One Farneback flow field per (a, b) pair, cached and reused across
  // every t between them — flow doesn't depend on t, only the warp amount
  // does, so it would be wasteful to recompute it per interpolated frame.
  async function getFlowForPair(a, b) {
    const key = `${a}-${b}`;
    const cached = flowPairCache.get(key);
    if (cached) return cached;

    const cv = await loadOpenCv();
    const { w, h } = computeFlowWorkSize(state.crop.w, state.crop.h);
    const canvasA = drawCroppedFrameToCanvas(a, w, h);
    const canvasB = drawCroppedFrameToCanvas(b, w, h);
    const matA = cv.imread(canvasA);
    const matB = cv.imread(canvasB);
    const grayA = new cv.Mat();
    const grayB = new cv.Mat();
    cv.cvtColor(matA, grayA, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(matB, grayB, cv.COLOR_RGBA2GRAY);

    const flow = new cv.Mat();
    // OpenCV's own "smoother, more robust" tuning from its Farneback docs
    // (poly_n=7/poly_sigma=1.5, contrasted there with a "faster" 5/1.1
    // pair), plus more pyramid levels and iterations for better convergence
    // on the large parallax offsets typical here, and the Gaussian-window
    // flag for cleaner motion boundaries than the default box-filter
    // averaging — all a straightforward quality-over-speed tradeoff, no new
    // dependency. (Real per-pixel motion estimation better than this needs
    // a fundamentally different algorithm — OpenCV.js's prebuilt JS
    // bindings don't expose DISOpticalFlow, checked both this build and
    // the official docs.opencv.org one — or a neural model entirely.)
    cv.calcOpticalFlowFarneback(grayA, grayB, flow, 0.5, 5, 21, 7, 7, 1.5, cv.OPTFLOW_FARNEBACK_GAUSSIAN);

    // flow is CV_32FC2 — interleaved [dx0,dy0, dx1,dy1, ...]. Copy it out
    // into plain typed arrays we own before deleting the Mat; .data32F is
    // just a view over WASM memory that goes stale the instant .delete()
    // runs.
    const interleaved = flow.data32F;
    const dx = new Float32Array(w * h);
    const dy = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      dx[i] = interleaved[i * 2];
      dy[i] = interleaved[i * 2 + 1];
    }

    matA.delete();
    matB.delete();
    grayA.delete();
    grayB.delete();
    flow.delete();

    const result = { dx, dy, w, h };
    flowPairCache.set(key, result);
    return result;
  }

  // Builds the actual in-between frame at parameter t from a's-and-b's
  // Farneback flow: warp A forward by t * flow and B backward by
  // (1-t) * flow (both via cv.remap, which is an inverse/backward mapping
  // — the standard simple-optical-flow-interpolation technique, using one
  // flow field for both warps rather than computing flow in both
  // directions), then blend the two warped images by t. Unlike the rigid
  // technique, different regions of the frame move by their OWN locally
  // estimated motion, so foreground/background parallax mismatch mostly
  // resolves correctly instead of ghosting.
  async function getInterpolatedCanvas(a, b, t) {
    const key = `${a}-${b}-${t}`;
    const cached = interpFrameCache.get(key);
    if (cached) return cached;

    const cv = await loadOpenCv();
    const { dx, dy, w, h } = await getFlowForPair(a, b);

    const canvasA = drawCroppedFrameToCanvas(a, w, h);
    const canvasB = drawCroppedFrameToCanvas(b, w, h);
    const matA = cv.imread(canvasA);
    const matB = cv.imread(canvasB);

    const mapAx = new cv.Mat(h, w, cv.CV_32FC1);
    const mapAy = new cv.Mat(h, w, cv.CV_32FC1);
    const mapBx = new cv.Mat(h, w, cv.CV_32FC1);
    const mapBy = new cv.Mat(h, w, cv.CV_32FC1);
    const mapAxData = mapAx.data32F;
    const mapAyData = mapAy.data32F;
    const mapBxData = mapBx.data32F;
    const mapByData = mapBy.data32F;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const fx = dx[i];
        const fy = dy[i];
        mapAxData[i] = x - t * fx;
        mapAyData[i] = y - t * fy;
        mapBxData[i] = x + (1 - t) * fx;
        mapByData[i] = y + (1 - t) * fy;
      }
    }

    const warpedA = new cv.Mat();
    const warpedB = new cv.Mat();
    cv.remap(matA, warpedA, mapAx, mapAy, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    cv.remap(matB, warpedB, mapBx, mapBy, cv.INTER_LINEAR, cv.BORDER_REPLICATE);

    const blended = new cv.Mat();
    cv.addWeighted(warpedA, 1 - t, warpedB, t, 0, blended);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    cv.imshow(outCanvas, blended);

    matA.delete();
    matB.delete();
    mapAx.delete();
    mapAy.delete();
    mapBx.delete();
    mapBy.delete();
    warpedA.delete();
    warpedB.delete();
    blended.delete();

    interpFrameCache.set(key, outCanvas);
    return outCanvas;
  }

  // Populates interpFrameCache for every interpolated entry in an order
  // array — call this once up front (and await it) before export, so the
  // exported file always gets full quality rather than depending on
  // whatever happened to finish computing by the time each frame was
  // drawn. The live preview does NOT await this (see scheduleInterpolationPrep
  // below) — it draws the rigid fallback instantly and upgrades in place
  // as each entry's flow-based frame finishes, entry by entry.
  async function prepareInterpolatedFrames(order) {
    for (const entry of order) {
      if (typeof entry !== 'number') {
        await getInterpolatedCanvas(entry.a, entry.b, entry.t);
      }
    }
  }

  // Debounced background preparation triggered whenever the interpolation
  // count (or the base order it's built from) changes, so the preview
  // upgrades from the instant rigid fallback to real optical flow shortly
  // after — without recomputing on every single 'input' tick while
  // dragging the slider. A token guards against a stale in-flight
  // preparation's status message clobbering a newer one.
  let interpPrepTimer = null;
  let interpPrepToken = 0;

  function scheduleInterpolationPrep() {
    clearTimeout(interpPrepTimer);
    if (state.interpolationCount <= 0) return;
    interpPrepTimer = setTimeout(() => {
      const token = ++interpPrepToken;
      window.AppShared.setStatus('Preparing optical-flow interpolation…');
      prepareInterpolatedFrames(state.order)
        .then(() => {
          if (token === interpPrepToken) {
            window.AppShared.setStatus('Ready.');
            renderOrderSequenceStrip(); // upgrade placeholders to the real optical-flow thumbnails
          }
        })
        .catch((err) => {
          console.error(err);
          if (token === interpPrepToken) {
            window.AppShared.setStatus("Couldn't load the optical-flow library — using a simpler blend instead.", true);
          }
        });
    }, 250);
  }

  // Single entry point for anything consuming state.order: a plain
  // 0-indexed frame number is a real frame, drawn unchanged; an
  // { a, b, t } interpolation descriptor draws the flow-based frame if
  // it's already been computed (see getInterpolatedCanvas), else the
  // instant rigid-shift fallback while the real one is still being
  // prepared in the background.
  function drawOrderEntry(destCtx, entry, destX, destY, destW, destH) {
    if (typeof entry === 'number') {
      drawAdjustedFrame(destCtx, entry, destX, destY, destW, destH);
      return;
    }
    const cached = interpFrameCache.get(`${entry.a}-${entry.b}-${entry.t}`);
    if (cached) {
      destCtx.drawImage(cached, destX, destY, destW, destH);
      applyDestAdjustmentsAndTint(destCtx, destX, destY, destW, destH, entry.a);
    } else {
      drawInterpolatedFrameRigid(destCtx, entry, destX, destY, destW, destH);
    }
  }

  // --- Crop rectangle geometry (shared by drawing + hit-testing, all in
  // align-canvas space, which is native coordinates offset by the margin and
  // scaled by alignScale) ---

  function cropHandlePositions() {
    const { x, y, w, h } = state.crop;
    return [
      { id: 'nw', cx: x, cy: y },
      { id: 'ne', cx: x + w, cy: y },
      { id: 'sw', cx: x, cy: y + h },
      { id: 'se', cx: x + w, cy: y + h },
    ];
  }

  function toAlignCanvasXY(nativeX, nativeY) {
    return { x: (nativeX + ALIGN_MARGIN_NATIVE) * alignScale, y: (nativeY + ALIGN_MARGIN_NATIVE) * alignScale };
  }

  function fromAlignCanvasXY(canvasX, canvasY) {
    return { x: canvasX / alignScale - ALIGN_MARGIN_NATIVE, y: canvasY / alignScale - ALIGN_MARGIN_NATIVE };
  }

  function updateOffsetLabel() {
    const f = state.frames[activeAlignFrameIndex()];
    alignOffsetLabel.textContent = `Offset: ${Math.round(f.dx)}, ${Math.round(f.dy)} px`;
  }

  function range(a, b) {
    return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
  }

  // Confirmed frames EXCLUDING the currently active one (which is drawn
  // separately, as the translucent "thing you're moving" layer). Frames can
  // be confirmed in any order via thumbnail clicks, so this must filter the
  // actual confirmed set rather than assume a contiguous 0..current-1 range.
  function confirmedBackdropIndices() {
    return state.frames
      .map((f, i) => i)
      .filter((i) => state.alignStep.confirmed[i] && i !== state.alignStep.current);
  }

  // Draws already-confirmed frames stacked at globalAlpha = 1/(position),
  // which by induction produces the exact unweighted pixel average of those
  // frames on an opaque canvas — not merely an approximation of a blend.
  // The frame currently being aligned (if any) is drawn on top at a fixed
  // translucency, since it's "the thing you're moving," not part of the average.
  function drawRunningAverageStack(confirmedIndices, currentIndex, drawFrame) {
    confirmedIndices.forEach((frameIndex, i) => drawFrame(frameIndex, 1 / (i + 1)));
    if (currentIndex != null) drawFrame(currentIndex, 0.55);
  }

  // Zoomed-in ghosted view centered on the given native-space point — lets
  // fine alignment work (e.g. lining up an eye) happen at native-pixel
  // precision even though the main canvas is scaled way down to fit on screen.
  // Mirrors whatever composite drawAlignmentCanvas would show for the
  // current mode/step, just zoomed.
  function drawMagnifier(nativeX, nativeY) {
    const mc = magnifierCanvas;
    const halfW = mc.width / (2 * MAGNIFIER_ZOOM);
    const halfH = mc.height / (2 * MAGNIFIER_ZOOM);

    magnifierCtx.clearRect(0, 0, mc.width, mc.height);

    function drawOneFrame(frameIndex, alpha) {
      const f = state.frames[frameIndex];
      magnifierCtx.globalAlpha = alpha;
      magnifierCtx.drawImage(
        f.img,
        nativeX - f.dx - halfW, nativeY - f.dy - halfH, halfW * 2, halfH * 2,
        0, 0, mc.width, mc.height
      );
    }

    if (state.mode === 'stepping') {
      drawRunningAverageStack(confirmedBackdropIndices(), state.alignStep.current, drawOneFrame);
    } else if (frameCount() === 2) {
      drawOneFrame(0, 1);
      drawOneFrame(1, 0.5);
    } else {
      drawRunningAverageStack(range(0, frameCount()), null, drawOneFrame);
    }
    magnifierCtx.globalAlpha = 1;

    magnifierCtx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    magnifierCtx.lineWidth = 1;
    magnifierCtx.beginPath();
    magnifierCtx.moveTo(mc.width / 2, 0);
    magnifierCtx.lineTo(mc.width / 2, mc.height);
    magnifierCtx.moveTo(0, mc.height / 2);
    magnifierCtx.lineTo(mc.width, mc.height / 2);
    magnifierCtx.stroke();
  }

  // Center of frame 0 (the anchor) in native coordinates — the magnifier's
  // resting position whenever the pointer isn't actively over the canvas,
  // so there's always something useful showing rather than a blank box.
  function magnifierDefaultNative() {
    return { x: state.W / 2, y: state.H / 2 };
  }

  // Shows the default centered-on-frame-1 view (or clears, if no frames are
  // loaded yet — e.g. right after reset()). Replaces the old hideMagnifier:
  // previously this cleared the canvas whenever the pointer left it or the
  // canvas lost focus; now it resets to a useful default instead of going
  // blank, per request. Every previous hideMagnifier() call site just needed
  // its name updated to match — the "show a neutral/reset view" intent at
  // each of those call sites is unchanged.
  function resetMagnifierToDefault() {
    if (state.frames.length === 0) {
      magnifierCtx.clearRect(0, 0, magnifierCanvas.width, magnifierCanvas.height);
      return;
    }
    const { x, y } = magnifierDefaultNative();
    drawMagnifier(x, y);
  }

  // No longer gated on the canvas having focus — the magnifier is always
  // showing *something* now (the hover position, or the default view), so
  // requiring a prior click/tab before it responds to hover doesn't fit
  // that model anymore.
  function maybeDrawMagnifier(nativeX, nativeY) {
    drawMagnifier(nativeX, nativeY);
  }

  function drawCropOverlay() {
    const { x, y, w, h } = state.crop;
    const topLeft = toAlignCanvasXY(x, y);
    alignCtx.strokeStyle = '#f59e0b';
    alignCtx.lineWidth = 2;
    alignCtx.strokeRect(topLeft.x, topLeft.y, w * alignScale, h * alignScale);
    alignCtx.fillStyle = '#f59e0b';
    cropHandlePositions().forEach((handle) => {
      const p = toAlignCanvasXY(handle.cx, handle.cy);
      alignCtx.fillRect(p.x - HANDLE_R, p.y - HANDLE_R, HANDLE_R * 2, HANDLE_R * 2);
    });
  }

  // Crop hit-testing only recognizes the 4 corner handles, not a drag-the-body
  // "move" — the crop starts out covering the entire overlap (most of the
  // canvas), so treating its interior as a drag target would leave almost no
  // clickable area for the (primary) align-drag interaction underneath it.
  // Also only active once the crop UI actually exists (ready mode).
  function hitTestCrop(canvasX, canvasY) {
    if (state.mode !== 'ready') return null;
    for (const handle of cropHandlePositions()) {
      const p = toAlignCanvasXY(handle.cx, handle.cy);
      if (Math.hypot(canvasX - p.x, canvasY - p.y) <= HIT_TOLERANCE_PX + HANDLE_R) {
        return { kind: 'crop-resize', handle: handle.id };
      }
    }
    return null;
  }

  const CURSOR_BY_HANDLE = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };

  function updateAlignHoverCursor(clientX, clientY) {
    const { x: cx, y: cy } = clientToCanvasXY(alignCanvas, clientX, clientY);
    const hit = hitTestCrop(cx, cy);
    if (hit) {
      alignCanvas.style.cursor = CURSOR_BY_HANDLE[hit.handle];
      return;
    }
    // Space, or the "Lock alignment" checkbox, both mean a plain drag moves
    // the crop instead of aligning — 'move' rather than 'grab' so it's
    // visually distinct from a normal align drag, which uses 'grab' for the
    // exact same "nothing under the pointer" case.
    if ((spacePressed || state.alignmentLocked) && state.mode === 'ready') {
      alignCanvas.style.cursor = 'move';
      return;
    }
    // Locked but not in ready mode yet (still stepping, no crop rect to move
    // at all) — nothing sensible for a plain drag to do here.
    if (state.alignmentLocked) {
      alignCanvas.style.cursor = 'default';
      return;
    }
    alignCanvas.style.cursor = 'grab';
  }

  // --- Align & crop canvas (one shared view: ghosted composite for
  // alignment, plus the crop rectangle/handles, both clamped to the overlap) ---

  function drawAlignmentCanvas() {
    const s = alignScale;
    alignCtx.clearRect(0, 0, alignCanvas.width, alignCanvas.height);

    function drawOneFrame(frameIndex, alpha) {
      const f = state.frames[frameIndex];
      alignCtx.globalAlpha = alpha;
      alignCtx.drawImage(
        f.img,
        (ALIGN_MARGIN_NATIVE + f.dx) * s,
        (ALIGN_MARGIN_NATIVE + f.dy) * s,
        state.W * s,
        state.H * s
      );
    }

    if (state.mode === 'stepping') {
      drawRunningAverageStack(confirmedBackdropIndices(), state.alignStep.current, drawOneFrame);
    } else if (frameCount() === 2) {
      drawOneFrame(0, 1);
      drawOneFrame(1, 0.5);
    } else {
      drawRunningAverageStack(range(0, frameCount()), null, drawOneFrame);
    }
    alignCtx.globalAlpha = 1;

    // Dashed, since the crop rect commonly coincides exactly with the overlap
    // — a solid stroke would then be fully hidden underneath the solid
    // orange crop outline drawn next.
    const ov = currentOverlapRect();
    const ovTopLeft = toAlignCanvasXY(ov.x0, ov.y0);
    alignCtx.strokeStyle = '#22c55e';
    alignCtx.lineWidth = 2;
    alignCtx.setLineDash([6, 4]);
    alignCtx.strokeRect(ovTopLeft.x, ovTopLeft.y, (ov.x1 - ov.x0) * s, (ov.y1 - ov.y0) * s);
    alignCtx.setLineDash([]);

    if (state.mode === 'ready') drawCropOverlay();
  }

  // Single-level undo, not a full history stack — deliberately scoped to
  // exactly the accidental-drag problem this was requested for ("I often
  // try to move crop without pressing Space"): one snapshot, taken right
  // before any align-drag, crop-resize-drag, crop-move-drag, or nudge,
  // overwriting whatever was captured before. Only the most recent of
  // those four kinds of action can be undone, not an arbitrary number of
  // steps back — simpler to reason about and covers the actual complaint.
  let undoSnapshot = null;

  function captureUndoSnapshot() {
    undoSnapshot = {
      frames: state.frames.map((f) => ({ dx: f.dx, dy: f.dy })),
      crop: { ...state.crop },
    };
    undoBtn.disabled = false;
  }

  function performUndo() {
    if (!undoSnapshot) return;
    state.frames.forEach((f, i) => {
      f.dx = undoSnapshot.frames[i].dx;
      f.dy = undoSnapshot.frames[i].dy;
    });
    state.crop = { ...undoSnapshot.crop };
    undoSnapshot = null;
    undoBtn.disabled = true;
    clearInterpolationCaches();
    scheduleInterpolationPrep();
    if (state.mode === 'ready') recomputePreviewScale();
    drawAlignmentCanvas();
    updateOffsetLabel();
    if (state.mode === 'ready') updateOutputSizeLabel();
    resetMagnifierToDefault();
  }

  undoBtn.addEventListener('click', performUndo);

  function nudgeAlign(ddx, ddy) {
    if (state.alignmentLocked) return;
    captureUndoSnapshot();
    const f = state.frames[activeAlignFrameIndex()];
    const clamped = clampAlign(f.dx + ddx, f.dy + ddy, state.W, state.H);
    f.dx = clamped.dx;
    f.dy = clamped.dy;
    clearInterpolationCaches();
    scheduleInterpolationPrep();
    if (state.mode === 'ready') {
      clampCropToOverlap();
      recomputePreviewScale();
    }
    drawAlignmentCanvas();
    updateOffsetLabel();
    if (state.mode === 'ready') updateOutputSizeLabel();
    if (lastHoverNative) maybeDrawMagnifier(lastHoverNative.x, lastHoverNative.y);
  }

  alignCanvas.addEventListener('pointerdown', (e) => {
    const { x: cx, y: cy } = clientToCanvasXY(alignCanvas, e.clientX, e.clientY);
    const hit = hitTestCrop(cx, cy);
    alignCanvas.setPointerCapture(e.pointerId);
    alignCanvas.focus();

    // A corner handle always resizes the crop, regardless of Space/lock —
    // those two only change what a PLAIN drag elsewhere on the canvas does.
    if (hit) {
      captureUndoSnapshot();
      alignCanvas.style.cursor = CURSOR_BY_HANDLE[hit.handle];
      state.drag = {
        kind: 'crop-resize',
        handle: hit.handle,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startCrop: { ...state.crop },
      };
      return;
    }

    // Space, or the "Lock alignment" checkbox, both mean this drag moves
    // the crop rect instead of aligning — locking makes Space unnecessary
    // (every plain drag already goes here), but holding Space still works
    // the same way regardless, so there's no conflict between the two.
    if ((spacePressed || state.alignmentLocked) && state.mode === 'ready') {
      captureUndoSnapshot();
      alignCanvas.style.cursor = 'grabbing';
      state.drag = {
        kind: 'crop-move',
        startClientX: e.clientX,
        startClientY: e.clientY,
        startCrop: { ...state.crop },
      };
      return;
    }

    // Locked but not ready yet (still stepping — no crop rect exists to
    // move) — nothing sensible for a plain drag to do.
    if (state.alignmentLocked) return;

    captureUndoSnapshot();
    const targetFrame = activeAlignFrameIndex();
    const f = state.frames[targetFrame];
    alignCanvas.style.cursor = 'grabbing';
    state.drag = {
      kind: 'align',
      frameIndex: targetFrame,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startDx: f.dx,
      startDy: f.dy,
    };
  });

  let lastHoverNative = null; // last mouse position in native coords, for re-drawing the magnifier after a keyboard nudge
  let spacePressed = false; // holding Space over the canvas switches a drag to moving the crop rect, instead of aligning or resizing it
  let pointerOverAlignCanvas = false; // gates the Space listener below from hijacking normal page scroll when the pointer's elsewhere

  alignCanvas.addEventListener('pointermove', (e) => {
    pointerOverAlignCanvas = true;
    const { x: cx, y: cy } = clientToCanvasXY(alignCanvas, e.clientX, e.clientY);
    lastHoverNative = fromAlignCanvasXY(cx, cy);
    maybeDrawMagnifier(lastHoverNative.x, lastHoverNative.y);

    if (!state.drag) {
      updateAlignHoverCursor(e.clientX, e.clientY);
      return;
    }
    if (state.drag.kind === 'align') {
      const { dx, dy } = nativeDelta(alignCanvas, alignScale, state.drag.startClientX, state.drag.startClientY, e.clientX, e.clientY);
      const clamped = clampAlign(state.drag.startDx + dx, state.drag.startDy + dy, state.W, state.H);
      const f = state.frames[state.drag.frameIndex];
      f.dx = clamped.dx;
      f.dy = clamped.dy;
      if (state.mode === 'ready') {
        clampCropToOverlap();
        recomputePreviewScale();
      }
      drawAlignmentCanvas();
      updateOffsetLabel();
      if (state.mode === 'ready') updateOutputSizeLabel();
    } else if (state.drag.kind === 'crop-move') {
      // alignScale is intentionally NOT recomputed mid-drag, matching
      // crop-resize below, so the canvas-to-native ratio stays constant for
      // the duration of the drag.
      const { dx, dy } = nativeDelta(alignCanvas, alignScale, state.drag.startClientX, state.drag.startClientY, e.clientX, e.clientY);
      state.crop = { ...state.drag.startCrop, x: state.drag.startCrop.x + dx, y: state.drag.startCrop.y + dy };
      // Same size, just repositioned — clampCropToOverlap only ever SHRINKS
      // w/h if they exceed the overlap, so it won't touch size here, only
      // keep x/y inside bounds (or re-fit to the locked ratio's rect, which
      // preserves size the same way).
      clampCropToOverlap();
      drawAlignmentCanvas();
      updateOutputSizeLabel();
    } else {
      // crop-resize. alignScale is intentionally NOT recomputed mid-drag so
      // the canvas-to-native ratio stays constant for the duration of the drag.
      const { dx, dy } = nativeDelta(alignCanvas, alignScale, state.drag.startClientX, state.drag.startClientY, e.clientX, e.clientY);
      state.crop = clampResizeCrop(state.drag.startCrop, state.drag.handle, dx, dy, state.cropRatio);
      drawAlignmentCanvas();
      updateOutputSizeLabel();
    }
  });

  alignCanvas.addEventListener('pointerleave', (e) => {
    pointerOverAlignCanvas = false;
    if (state.drag) return; // pointer capture keeps a drag going even once the cursor visually leaves
    lastHoverNative = null;
    resetMagnifierToDefault();
  });

  alignCanvas.addEventListener('blur', () => {
    resetMagnifierToDefault();
  });

  function endAlignCanvasDrag(e) {
    if (!state.drag) return;
    alignCanvas.releasePointerCapture(e.pointerId);
    const wasCrop = state.drag.kind === 'crop-resize' || state.drag.kind === 'crop-move';
    state.drag = null;
    if (wasCrop) recomputePreviewScale();
    // Every kind of drag changes what interpolated frames should look
    // like — align changes a frame's dx/dy, crop-resize/crop-move changes
    // the region flow gets computed from — so anything cached is now stale.
    clearInterpolationCaches();
    scheduleInterpolationPrep();
    updateAlignHoverCursor(e.clientX, e.clientY);
  }
  alignCanvas.addEventListener('pointerup', endAlignCanvasDrag);
  alignCanvas.addEventListener('pointercancel', endAlignCanvasDrag);

  // Arrow keys nudge alignment by exactly 1 native image pixel per press —
  // finer than mouse dragging can reach once the canvas is scaled down.
  alignCanvas.addEventListener('keydown', (e) => {
    const steps = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const step = steps[e.key];
    if (!step) return;
    e.preventDefault();
    nudgeAlign(step[0], step[1]);
  });

  // On-screen equivalent of the arrow-key nudge above, for touch devices —
  // phones have no keyboard, so the 1-native-px-per-press fine alignment
  // the keyboard shortcut offers would otherwise be unreachable on mobile.
  // Goes through the exact same nudgeAlign (1px per press, same clamping,
  // same undo-snapshot/lock-guard behavior) — not a separate code path.
  nudgeUpBtn.addEventListener('click', () => nudgeAlign(0, -1));
  nudgeDownBtn.addEventListener('click', () => nudgeAlign(0, 1));
  nudgeLeftBtn.addEventListener('click', () => nudgeAlign(-1, 0));
  nudgeRightBtn.addEventListener('click', () => nudgeAlign(1, 0));

  // Hold Space to move the crop rect instead of aligning/resizing — the one
  // interaction the canvas couldn't otherwise offer, per the deliberate
  // design tradeoff in this file's docs: dragging the crop BODY isn't a
  // plain click-drag because the crop starts out covering nearly the whole
  // canvas, which would swallow almost all click area meant for the
  // (primary) alignment drag. Listened for on window, not the canvas, so it
  // works the instant the pointer's over the canvas — it doesn't require
  // the canvas to already have keyboard focus first. Gated on
  // pointerOverAlignCanvas so it never hijacks normal page-scroll-by-space
  // when the user's spacebar-scrolling with the mouse elsewhere, and on not
  // being focused in a text input so it never swallows a literal space
  // while typing (e.g. into the animation-order textbox).
  function isTypingTarget(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || !pointerOverAlignCanvas || isTypingTarget(document.activeElement)) return;
    e.preventDefault(); // block page scroll
    if (!spacePressed) {
      spacePressed = true;
      if (!state.drag) alignCanvas.style.cursor = 'move';
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    spacePressed = false;
    // Mid-drag, leave the cursor/behavior alone until pointerup — a drag's
    // kind is fixed at pointerdown time (see the handler above), so
    // releasing Space partway through an active crop-move shouldn't
    // suddenly change what it's doing. Not worth tracking the last client
    // mouse position just to restore the exact hit-tested cursor here —
    // 'grab' is a fine approximation; the very next pointermove corrects it
    // precisely regardless.
    if (!state.drag) alignCanvas.style.cursor = 'grab';
  });

  // --- Frame selection for 3+ frames ---
  //
  // No wizard buttons: every non-anchor frame's thumbnail is directly
  // clickable at any time (during the initial pass AND after everything's
  // already been touched once) — clicking one makes it the active frame on
  // the align canvas and immediately marks it confirmed (a frame left at
  // its default {0,0} offset is a valid confirmation, same as before, just
  // without a separate "Confirm" click to say so explicitly). The crop/
  // export panel unlocks the first time every frame has been confirmed at
  // least once, and stays unlocked from then on — selecting a frame again
  // later to fine-tune it doesn't re-hide it.

  function updateAlignHint() {
    alignHintEl.textContent = frameCount() > 2
      ? 'Click a frame below to select it, then drag it (or use arrow keys, 1px per press) onto the ghosted average of every frame already aligned. Every frame needs a click before you can crop. Drag an orange corner handle to resize the crop once it appears. Hover for a zoomed-in view.'
      : "Drag anywhere (or use arrow keys, 1px per press) to align the ghosted frame on a shared point, e.g. a face. Drag an orange corner handle to resize the crop — it's kept inside the green overlap outline. Hover for a zoomed-in view.";
  }

  function renderThumbnailStrip() {
    frameThumbSectionEl.hidden = frameCount() <= 2;
    if (frameCount() <= 2) return;
    thumbStripEl.innerHTML = '';
    state.frames.forEach((f, i) => {
      const wrap = document.createElement('button');
      wrap.type = 'button';
      wrap.className = i === 0 ? 'thumb thumb-anchor' : 'thumb';

      const imgWrap = document.createElement('div');
      imgWrap.className = 'thumb-image-wrap';

      const img = document.createElement('img');
      img.className = 'thumb-img';
      img.src = f.img.src;
      img.alt = `Frame ${i + 1}`;
      imgWrap.appendChild(img);

      if (i > 0) {
        const badge = document.createElement('span');
        badge.className = 'thumb-badge';
        badge.textContent = 'Not aligned';
        imgWrap.appendChild(badge);

        wrap.addEventListener('click', () => selectFrame(i));
      }

      const label = document.createElement('span');
      label.className = 'thumb-label';
      label.textContent = String(i + 1);

      wrap.appendChild(imgWrap);
      wrap.appendChild(label);
      thumbStripEl.appendChild(wrap);
    });
    updateThumbnailStripState();
  }

  function updateThumbnailStripState() {
    if (frameCount() <= 2) return;
    Array.from(thumbStripEl.children).forEach((el, i) => {
      el.classList.toggle('confirmed', !!state.alignStep.confirmed[i]);
      el.classList.toggle('active', i === state.alignStep.current);
    });
  }

  function applyModeVisibility() {
    const ready = state.mode === 'ready';
    const multi = frameCount() > 2;

    frameThumbSectionEl.hidden = !multi;
    cropRatioSectionEl.hidden = !ready;
    cropExportPanelEl.hidden = !ready;
    // Shown for any N>2 wigglegram (as before), but now also for a 2-frame
    // one the moment interpolation is turned on — that's the only case
    // where a 2-frame animation order becomes more than the fixed [1,2]
    // flip, so there's something worth showing/editing.
    orderSectionEl.hidden = !(ready && (multi || state.interpolationCount > 0));
  }

  // Redraws everything after the active frame changes, WITHOUT touching
  // mode/crop/order state — used both during the initial pass and for later
  // re-selections once already in ready mode.
  function refreshAfterFrameSelection() {
    applyModeVisibility();
    drawAlignmentCanvas();
    updateOffsetLabel();
    updateThumbnailStripState();
    lastHoverNative = null;
    resetMagnifierToDefault();
  }

  // The one-time transition once every frame has been confirmed at least
  // once. Never runs again after that — re-selecting a frame later just
  // goes through refreshAfterFrameSelection() instead, leaving whatever
  // crop/order/adjustments the user already set untouched.
  function enterReadyMode() {
    state.mode = 'ready';
    resetCropToOverlap();
    recomputeAlignScale();
    recomputePreviewScale();
    applyScale(scalePercentForWidth(DEFAULT_OUTPUT_WIDTH, state.crop.w));

    resetOrderToDefault();

    updateColorModeAvailability();
    applyModeVisibility();
    drawAlignmentCanvas();
    updateOffsetLabel();
    updateOutputSizeLabel();
    updateThumbnailStripState();
    updateGenerateButtonsDisabled();

    lastHoverNative = null;
    resetMagnifierToDefault();
    startPreviewLoop();
  }

  function selectFrame(index) {
    if (index <= 0 || index >= frameCount()) return; // frame 0 is the fixed anchor, not selectable
    state.alignStep.current = index;
    const alreadyConfirmed = state.alignStep.confirmed[index];
    state.alignStep.confirmed[index] = true;

    if (!alreadyConfirmed && state.mode !== 'ready' && state.alignStep.confirmed.every(Boolean)) {
      enterReadyMode();
    } else {
      refreshAfterFrameSelection();
    }
  }

  // --- Live preview animation loop (read-only mimic of the final GIF) ---

  let lastFrameTime = null;

  function previewTick(timestamp) {
    if (lastFrameTime === null) lastFrameTime = timestamp;
    const delta = timestamp - lastFrameTime;
    lastFrameTime = timestamp;

    state.previewElapsed += delta;
    const flipInterval = 1000 / state.fps;
    if (state.previewElapsed >= flipInterval) {
      state.previewOrderIdx = (state.previewOrderIdx + 1) % state.order.length;
      state.previewElapsed = 0;
    }

    drawPreviewFrame();
    state.previewRAF = requestAnimationFrame(previewTick);
  }

  function drawPreviewFrame() {
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    const entry = state.order[state.previewOrderIdx % state.order.length];
    drawOrderEntry(previewCtx, entry, 0, 0, previewCanvas.width, previewCanvas.height);
  }

  function startPreviewLoop() {
    stopPreviewLoop();
    lastFrameTime = null;
    state.previewElapsed = 0;
    state.previewOrderIdx = 0;
    state.previewRAF = requestAnimationFrame(previewTick);
  }

  function stopPreviewLoop() {
    if (state.previewRAF != null) cancelAnimationFrame(state.previewRAF);
    state.previewRAF = null;
  }

  // --- Adjustment controls ---

  // Keeps a <input type="range"> and a paired <input type="number"> in sync
  // in both directions, clamping typed values to the slider's min/max, and
  // calls onChange with the resulting numeric value whenever either changes.
  function linkSliderWithNumber(slider, numberInput, onChange) {
    const min = Number(slider.min);
    const max = Number(slider.max);

    function apply(value) {
      slider.value = value;
      numberInput.value = value;
      onChange(value);
    }

    slider.addEventListener('input', () => apply(Number(slider.value)));

    numberInput.addEventListener('input', () => {
      if (numberInput.value === '' || numberInput.value === '-') return; // still typing
      const clamped = Math.max(min, Math.min(max, Number(numberInput.value)));
      apply(clamped);
    });

    // If left on an invalid/partial value (e.g. "-" or empty), snap back to
    // the slider's current value once the field loses focus.
    numberInput.addEventListener('blur', () => {
      numberInput.value = slider.value;
    });

    return apply;
  }

  const applyFps = linkSliderWithNumber(fpsSlider, fpsValue, (v) => {
    state.fps = v;
  });
  const applyInterpolation = linkSliderWithNumber(interpSlider, interpValue, (v) => {
    state.interpolationCount = v;
    updateColorModeAvailability();
    if (state.mode === 'ready') applyModeVisibility(); // order-section visibility depends on interpolationCount for 2-frame sets
    // A different interpolation count means a different vocabulary (see
    // frameVocabulary), so any custom-typed order's numbers would silently
    // end up referring to different frames than the user chose them for —
    // resetting to the new default avoids that silent reinterpretation.
    resetOrderToDefault();
  });
  const applyBrightness = linkSliderWithNumber(brightnessSlider, brightnessValue, (v) => {
    state.adjust.brightness = v;
  });
  const applyContrast = linkSliderWithNumber(contrastSlider, contrastValue, (v) => {
    state.adjust.contrast = v;
  });
  const applyHue = linkSliderWithNumber(hueSlider, hueValue, (v) => {
    state.adjust.hue = v;
  });
  const applyScale = linkSliderWithNumber(scaleSlider, scaleValue, (v) => {
    state.outputScalePercent = v;
    updateOutputSizeLabel();
  });

  // A direct alternative to the % slider: type a target width in px and
  // derive the equivalent outputScalePercent from it, going through the
  // exact same applyScale (so the % slider/number box stay in sync too —
  // there's only ever one underlying value, state.outputScalePercent).
  scaleWidthInput.addEventListener('input', () => {
    if (scaleWidthInput.value === '' || state.crop.w <= 0) return;
    const desiredWidth = Number(scaleWidthInput.value);
    if (!Number.isFinite(desiredWidth) || desiredWidth <= 0) return;
    editingScaleWidthInput = true;
    applyScale(scalePercentForWidth(desiredWidth, state.crop.w));
    editingScaleWidthInput = false;
  });
  // Once editing finishes: snap to the actual resulting width, whether
  // that's recovering from empty/invalid input (same behavior
  // linkSliderWithNumber's pairs already have) or just reformatting a
  // valid typed value to what it actually rounds to (e.g. "1080" ->
  // "1075") now that typing no longer gets fought keystroke-by-keystroke.
  scaleWidthInput.addEventListener('blur', () => {
    scaleWidthInput.value = computeOutputSize().w;
  });

  colorModeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) state.adjust.colorMode = radio.value;
    });
  });

  cropRatioRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      state.cropRatio = CROP_RATIOS[radio.value];
      if (state.cropRatio) {
        const ov = currentOverlapRect();
        state.crop = fitCropToRatio(state.crop, state.cropRatio, ov);
      }
      recomputePreviewScale();
      drawAlignmentCanvas();
      updateOutputSizeLabel();
    });
  });

  lockAlignmentCheckbox.addEventListener('change', () => {
    state.alignmentLocked = lockAlignmentCheckbox.checked;
    // The pointer is over the checkbox, not the canvas, right now, so
    // there's no handle it could be hovering — just set the plain-drag
    // cursor directly rather than re-running full hit-testing.
    if (state.alignmentLocked) {
      alignCanvas.style.cursor = state.mode === 'ready' ? 'move' : 'default';
    } else {
      alignCanvas.style.cursor = 'grab';
    }
  });

  // Anaglyph tint is inherently a 2-view concept — disable it once there are
  // more than 2 frames, falling back to Normal if it was somehow selected.
  function updateColorModeAvailability() {
    const anaglyphRadio = document.querySelector('input[name="color-mode"][value="anaglyph"]');
    const disable = frameCount() > 2 || state.interpolationCount > 0;
    anaglyphRadio.disabled = disable;
    anaglyphRadio.closest('label').classList.toggle('disabled-option', disable);
    if (disable && anaglyphRadio.checked) {
      document.querySelector('input[name="color-mode"][value="normal"]').checked = true;
      state.adjust.colorMode = 'normal';
    }
  }

  // --- Animation order (3+ frames) ---

  function defaultOrder(n) {
    const forward = Array.from({ length: n }, (_, i) => i);
    const backward = Array.from({ length: Math.max(0, n - 2) }, (_, i) => n - 2 - i); // empty when n===2
    return forward.concat(backward);
  }

  function formatOrder(order) {
    return order.map((i) => i + 1).join(',');
  }

  // Expands a real (0-indexed) frame order into one with k interpolated
  // in-between frames inserted between each consecutive pair — e.g.
  // withInterpolation([0,1], 2) -> [0, {a:0,b:1,t:1/3}, {a:0,b:1,t:2/3}, 1].
  function withInterpolation(order, k) {
    if (k <= 0 || order.length < 2) return order.slice();
    const result = [order[0]];
    for (let i = 0; i < order.length - 1; i++) {
      const a = order[i];
      const b = order[i + 1];
      for (let s = 1; s <= k; s++) {
        result.push({ a, b, t: s / (k + 1) });
      }
      result.push(b);
    }
    return result;
  }

  // The full addressable "vocabulary" the order textbox's numbers refer to:
  // real frames in their natural order, each consecutive pair with k
  // interpolated frames inserted between them — real AND interpolated
  // frames alike each get their own plain consecutive integer, e.g. with 2
  // real frames and k=1, "1,2" (real frames) becomes vocabulary "1,2,3"
  // where 2 is the interpolated frame (matches what was asked: name
  // interpolated frames as regular numbers, not a separate notation).
  // Always the real frames in natural 0..N-1 order regardless of what the
  // animation order itself is — the vocabulary is the fixed "address
  // space" the order indexes into, not the order itself.
  function frameVocabulary() {
    return withInterpolation(range(0, frameCount()), state.interpolationCount);
  }

  // state.order is what actually gets drawn; state.baseOrder is the
  // typed/default sequence of 0-indexed VOCABULARY positions (not
  // necessarily real frame indices once interpolation is on) that
  // resolves to it via this lookup.
  function resolveOrder(baseOrder, vocabulary) {
    return baseOrder.map((i) => vocabulary[i]);
  }

  // Resets the animation order to the default pendulum bounce over the
  // CURRENT vocabulary (so it reflects whatever the interpolation count
  // currently is) — used on first reaching ready mode, whenever the
  // interpolation count changes (a different count means a different
  // vocabulary, so any custom order's numbers would silently refer to
  // different frames than the user chose them for — rather than
  // reinterpreting them, or trying to translate them across vocabularies,
  // just reset to a sane default and let the error-free starting point be
  // obvious), and by the explicit "Reset to default" button.
  //
  // Because the vocabulary already interleaves interpolated frames with
  // real ones, defaultOrder's plain pendulum formula (which knows nothing
  // about interpolation) naturally produces a fully-smoothed pendulum with
  // no extra logic needed — and, unlike an earlier version of this feature
  // that only smoothed transitions explicitly listed in a real-frame-only
  // order, it doesn't need any special-case fix-up for the loop-back point
  // either: defaultOrder(vocabLength) always ends one element short of the
  // vocabulary's own first entry (its backward segment stops at index 1,
  // never back down to index 0), so wrapping from the last frame back to
  // the first for looped playback was never a duplicate to begin with here.
  function resetOrderToDefault() {
    const vocabulary = frameVocabulary();
    state.baseOrder = defaultOrder(vocabulary.length);
    orderInput.value = formatOrder(state.baseOrder);
    orderErrorEl.hidden = true;
    orderValid = true;
    state.order = resolveOrder(state.baseOrder, vocabulary);
    renderOrderSequenceStrip();
    updateGenerateButtonsDisabled();
    scheduleInterpolationPrep();
  }

  // Visual strip showing every entry currently in state.order — real
  // frames and (once computed) their optical-flow-interpolated in-betweens
  // — so editing the order textbox or the interpolation count has an
  // immediate, concrete preview of what actually gets exported, not just
  // the raw typed frame numbers. Re-rendered on every state.order
  // reassignment; interpolated entries not yet computed just show an empty
  // placeholder box (still labeled and badged) until
  // scheduleInterpolationPrep's background pass finishes and calls this
  // again. Each interpolated thumbnail is its own fresh <img> (via
  // canvas.toDataURL on a copy, not the cached canvas element itself) so
  // the same {a,b,t} cache entry can safely appear more than once in the
  // strip without fighting over which container a single DOM node lives in.
  function renderOrderSequenceStrip() {
    orderSequenceStripEl.innerHTML = '';
    state.order.forEach((entry, i) => {
      // Defensive: state.order can transiently reference a just-replaced
      // frame set (e.g. applyInterpolation(0)'s reset-on-load runs before
      // load() has rebuilt state.order for the new frames) — skip rather
      // than throw on a stale index.
      const frameIndices = typeof entry === 'number' ? [entry] : [entry.a, entry.b];
      if (frameIndices.some((fi) => !state.frames[fi])) return;

      const wrap = document.createElement('div');
      wrap.className = 'seq-thumb';

      const mediaWrap = document.createElement('div');
      mediaWrap.className = 'seq-thumb-media-wrap';
      wrap.appendChild(mediaWrap);

      if (typeof entry === 'number') {
        const img = document.createElement('img');
        img.className = 'seq-thumb-media';
        img.src = state.frames[entry].img.src;
        img.alt = `Frame ${entry + 1}`;
        mediaWrap.appendChild(img);
      } else {
        const cached = interpFrameCache.get(`${entry.a}-${entry.b}-${entry.t}`);
        if (cached) {
          const img = document.createElement('img');
          img.className = 'seq-thumb-media';
          img.src = cached.toDataURL('image/jpeg', 0.7);
          img.alt = 'Interpolated frame';
          mediaWrap.appendChild(img);
        }
        const badge = document.createElement('span');
        badge.className = 'seq-thumb-badge';
        badge.textContent = 'Interpolated';
        mediaWrap.appendChild(badge);
      }

      // The label is the entry's plain vocabulary position (state.baseOrder[i] + 1),
      // not anything derived from the entry's own content — real and
      // interpolated frames share the exact same consecutive numbering,
      // per frameVocabulary() above.
      const labelEl = document.createElement('span');
      labelEl.className = 'seq-thumb-label';
      labelEl.textContent = String(state.baseOrder[i] + 1);
      wrap.appendChild(labelEl);

      orderSequenceStripEl.appendChild(wrap);
    });
  }

  function parseOrder(text, n) {
    const trimmed = text.trim();
    if (trimmed === '') return { error: 'Enter at least 2 frame numbers, comma-separated (e.g. "1,2,3,2").' };
    const parts = trimmed.split(',').map((s) => s.trim());
    if (parts.length > MAX_ORDER_LENGTH) return { error: `Sequence too long — max ${MAX_ORDER_LENGTH} entries.` };
    if (parts.length < 2) return { error: 'Enter at least 2 frame numbers.' };

    const indices = [];
    for (const part of parts) {
      if (!/^\d+$/.test(part)) return { error: `"${part}" isn't a whole number.` };
      const num = Number(part);
      if (num < 1 || num > n) return { error: `${num} is out of range — this set has ${n} frames (1–${n}).` };
      indices.push(num - 1);
    }
    return { order: indices };
  }

  orderInput.addEventListener('input', () => {
    const vocabulary = frameVocabulary();
    const result = parseOrder(orderInput.value, vocabulary.length);
    orderValid = !result.error;
    orderErrorEl.hidden = orderValid;
    if (result.error) {
      orderErrorEl.textContent = result.error;
    } else {
      state.baseOrder = result.order;
      state.order = resolveOrder(state.baseOrder, vocabulary);
      renderOrderSequenceStrip();
      scheduleInterpolationPrep();
    }
    updateGenerateButtonsDisabled();
  });

  document.getElementById('order-reset-btn').addEventListener('click', resetOrderToDefault);

  function updateGenerateButtonsDisabled() {
    generateGifBtn.disabled = !orderValid;
    generateWebpBtn.disabled = !orderValid || !webpSupported;
    generateMp4Btn.disabled = !orderValid || !mp4Supported;
  }

  // --- Animated WebP muxing ---
  //
  // Browsers only expose a STATIC WebP encoder (canvas.toBlob(..., 'image/webp'))
  // — there is no built-in API for multi-frame animated WebP. But a single-frame
  // WebP file is just a RIFF container wrapping one raw VP8/VP8L image chunk, so
  // two of those can be re-packaged by hand into a minimal animated WebP
  // (VP8X + ANIM + one ANMF per frame) with no WASM encoder needed — the same
  // "read/write a binary container format directly" approach already used for
  // splitting the camera's MPO files in app.js.

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob); else reject(new Error('This browser could not encode a WebP image.'));
      }, type, quality);
    });
  }

  function readFourCC(view, offset) {
    return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  }

  function writeFourCC(bytes, offset, str) {
    for (let i = 0; i < 4; i++) bytes[offset + i] = str.charCodeAt(i);
  }

  function writeUint24LE(view, offset, value) {
    view.setUint8(offset, value & 0xff);
    view.setUint8(offset + 1, (value >> 8) & 0xff);
    view.setUint8(offset + 2, (value >> 16) & 0xff);
  }

  function concatBytes(arrays) {
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
      out.set(a, offset);
      offset += a.length;
    }
    return out;
  }

  function makeRiffChunk(fourcc, payload) {
    const header = new Uint8Array(8);
    writeFourCC(header, 0, fourcc);
    new DataView(header.buffer).setUint32(4, payload.length, true);
    const pad = payload.length % 2 === 1 ? new Uint8Array(1) : new Uint8Array(0);
    return concatBytes([header, payload, pad]);
  }

  // Strips a simple (single-image) WebP file down to just its image
  // sub-chunks (ALPH + VP8/VP8L) — everything an ANMF frame chunk needs,
  // dropping the outer RIFF/WEBP/VP8X wrapper.
  function extractWebpImageChunks(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'WEBP') {
      throw new Error('Unexpected WebP output from this browser.');
    }
    let offset = 12;
    const chunks = [];
    while (offset + 8 <= bytes.length) {
      const fourcc = readFourCC(view, offset);
      const size = view.getUint32(offset + 4, true);
      const total = 8 + size + (size % 2);
      // Allow-list, not block-list: browsers commonly embed extra top-level
      // chunks (e.g. an ICCP color profile) in a plain canvas.toBlob() WebP,
      // and an ANMF frame payload is only ever valid with ALPH/VP8/VP8L in
      // it — anything else (ICCP, EXIF, XMP, ...) must be dropped here.
      if (fourcc === 'ALPH' || fourcc === 'VP8 ' || fourcc === 'VP8L') {
        chunks.push(bytes.subarray(offset, offset + total));
      }
      offset += total;
    }
    return chunks;
  }

  // Builds a minimal animated WebP file out of per-frame single-image WebP
  // bytes (as produced by canvas.toBlob), all sharing one canvasWidth x
  // canvasHeight frame size.
  function buildAnimatedWebp(frames, canvasWidth, canvasHeight) {
    const anmfChunks = frames.map((frame) => {
      const imageChunks = extractWebpImageChunks(frame.bytes);
      const header = new Uint8Array(16);
      const dv = new DataView(header.buffer);
      writeUint24LE(dv, 0, 0); // frame X offset (2px units) — always 0, full-canvas frames
      writeUint24LE(dv, 3, 0); // frame Y offset
      writeUint24LE(dv, 6, canvasWidth - 1);
      writeUint24LE(dv, 9, canvasHeight - 1);
      writeUint24LE(dv, 12, frame.duration);
      dv.setUint8(15, 0); // blend/dispose flags don't matter: every frame is opaque and fills the canvas
      return makeRiffChunk('ANMF', concatBytes([header, ...imageChunks]));
    });

    const vp8x = new Uint8Array(10);
    const vdv = new DataView(vp8x.buffer);
    vdv.setUint8(0, 0x02); // VP8X flags: Animation bit set
    writeUint24LE(vdv, 4, canvasWidth - 1);
    writeUint24LE(vdv, 7, canvasHeight - 1);

    const anim = new Uint8Array(6); // background color (unused, always fully covered) + loop count 0 = infinite

    const body = concatBytes([makeRiffChunk('VP8X', vp8x), makeRiffChunk('ANIM', anim), ...anmfChunks]);

    const riffHeader = new Uint8Array(12);
    writeFourCC(riffHeader, 0, 'RIFF');
    new DataView(riffHeader.buffer).setUint32(4, 4 + body.length, true); // 'WEBP' + body
    writeFourCC(riffHeader, 8, 'WEBP');

    return concatBytes([riffHeader, body]);
  }

  // --- Generate output (GIF or animated WebP) ---

  function generateGif(canvas, delay) {
    window.AppShared.setStatus('Encoding GIF…');
    const ctx = canvas.getContext('2d');
    const gif = new GIF({
      workers: 2,
      quality: 10,
      workerScript: 'lib/gif.worker.js',
      width: canvas.width,
      height: canvas.height,
    });

    for (const entry of state.order) {
      drawOrderEntry(ctx, entry, 0, 0, canvas.width, canvas.height);
      gif.addFrame(canvas, { copy: true, delay });
    }

    return new Promise((resolve) => {
      gif.on('progress', (p) => window.AppShared.setStatus(`Encoding GIF… ${Math.round(p * 100)}%`));
      gif.on('finished', (blob) => resolve({ blob, extension: 'gif' }));
      gif.render();
    });
  }

  async function generateWebp(canvas, delay) {
    window.AppShared.setStatus('Encoding WebP…');
    const ctx = canvas.getContext('2d');
    const WEBP_QUALITY = 0.92;

    const frames = [];
    for (const entry of state.order) {
      drawOrderEntry(ctx, entry, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
      if (blob.type !== 'image/webp') {
        throw new Error("This browser can't encode WebP (common on iOS, where every browser uses Safari's engine) — use Generate GIF instead.");
      }
      frames.push({ bytes: new Uint8Array(await blob.arrayBuffer()), duration: delay });
    }

    const animatedBytes = buildAnimatedWebp(frames, canvas.width, canvas.height);
    return { blob: new Blob([animatedBytes], { type: 'image/webp' }), extension: 'webp' };
  }

  // --- MP4 muxing ---
  //
  // Browsers expose an H.264 ENCODER via WebCodecs (VideoEncoder) but no
  // built-in muxer to wrap the encoded chunks in an MP4 container — so
  // mp4-muxer (vendored, MIT-licensed, github.com/Vanilagy/mp4-muxer) is
  // used for that half, the same division of labor as gif.js (this app
  // supplies the pixels/timing, the library supplies the container format).
  // Candidates are tried High profile first (handles larger camera frame
  // sizes) down to Baseline (the most broadly supported, but capped at
  // smaller resolutions) since VideoEncoder.isConfigSupported depends on
  // both the browser AND the actual output resolution, not just the browser.
  const MP4_CODEC_CANDIDATES = ['avc1.640034', 'avc1.640028', 'avc1.4d0028', 'avc1.42001f'];

  async function pickMp4Codec(width, height, bitrate) {
    for (const codec of MP4_CODEC_CANDIDATES) {
      try {
        const result = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate });
        if (result && result.supported) return codec;
      } catch (err) { /* try the next candidate */ }
    }
    return null;
  }

  async function generateMp4(canvas, delay) {
    window.AppShared.setStatus('Encoding MP4…');
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const bitrate = Math.max(2_000_000, Math.round(width * height * 4));

    const codec = await pickMp4Codec(width, height, bitrate);
    if (!codec) {
      throw new Error("This browser can't encode a video at this resolution — try a smaller Output scale, or use Generate GIF/WebP instead.");
    }

    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width, height },
      fastStart: 'in-memory',
    });

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => console.error(err),
    });
    videoEncoder.configure({ codec, width, height, bitrate });

    const durationMicros = delay * 1000;
    let timestamp = 0;
    for (let i = 0; i < state.order.length; i++) {
      drawOrderEntry(ctx, state.order[i], 0, 0, width, height);
      const videoFrame = new VideoFrame(canvas, { timestamp, duration: durationMicros });
      videoEncoder.encode(videoFrame, { keyFrame: i === 0 });
      videoFrame.close();
      timestamp += durationMicros;
      window.AppShared.setStatus(`Encoding MP4… ${Math.round(((i + 1) / state.order.length) * 100)}%`);
    }

    await videoEncoder.flush();
    videoEncoder.close();
    muxer.finalize();

    return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), extension: 'mp4' };
  }

  async function generateOutput(format) {
    const delay = Math.round(1000 / state.fps);
    let { w, h } = computeOutputSize();
    // H.264 4:2:0 requires even dimensions; only MP4 needs this trim.
    if (format === 'mp4') {
      w -= w % 2;
      h -= h % 2;
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    generateGifBtn.disabled = true;
    generateWebpBtn.disabled = true;
    generateMp4Btn.disabled = true;
    try {
      if (state.interpolationCount > 0) {
        // Unlike the live preview (which shows the instant rigid fallback
        // and upgrades in place), an export always waits for the real
        // optical-flow frames first — so the file never depends on
        // whatever happened to already be cached by luck of timing. Any
        // entry the library still can't produce (e.g. it failed to load)
        // just draws via the rigid fallback in drawOrderEntry as normal.
        window.AppShared.setStatus('Preparing optical-flow interpolation…');
        try {
          await prepareInterpolatedFrames(state.order);
          renderOrderSequenceStrip();
        } catch (err) {
          console.error(err);
        }
      }

      const { blob, extension } = format === 'webp'
        ? await generateWebp(canvas, delay)
        : format === 'mp4'
        ? await generateMp4(canvas, delay)
        : await generateGif(canvas, delay);

      const url = URL.createObjectURL(blob);
      window.AppShared.trackObjectUrl(url);
      if (extension === 'mp4') {
        outputVideo.src = url;
        outputVideo.hidden = false;
        outputGif.hidden = true;
        outputGif.removeAttribute('src');
      } else {
        outputVideo.pause();
        outputVideo.removeAttribute('src');
        outputVideo.hidden = true;
        outputGif.hidden = false;
        outputGif.src = url;
      }
      downloadLink.href = url;
      downloadLink.download = `${state.baseName}.${extension}`;
      downloadLink.textContent = `Download ${extension.toUpperCase()}`;
      resultSizeLabel.textContent = `(${extension.toUpperCase()} ${canvas.width} × ${canvas.height} px)`;
      outputEl.hidden = false;
      window.AppShared.setStatus('Done.');
    } catch (err) {
      console.error(err);
      window.AppShared.setStatus(err.message || 'Something went wrong generating the output.', true);
    } finally {
      updateGenerateButtonsDisabled();
    }
  }

  generateGifBtn.addEventListener('click', () => generateOutput('gif'));
  generateWebpBtn.addEventListener('click', () => generateOutput('webp'));
  generateMp4Btn.addEventListener('click', () => generateOutput('mp4'));

  // --- Window resize ---

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.frames.length === 0) return;
      recomputeAlignScale();
      if (state.mode === 'ready') recomputePreviewScale();
      drawAlignmentCanvas();
    }, 150);
  });

  // --- Public API ---

  function load(images, baseName) {
    stopPreviewLoop();
    clearInterpolationCaches();
    state.baseOrder = [];
    state.order = [];

    state.frames = images.map((img) => ({ img, dx: 0, dy: 0 }));
    state.W = images[0].naturalWidth;
    state.H = images[0].naturalHeight;
    state.baseName = baseName;
    // Preserve the previously-chosen fps across a re-load (e.g. uploading a
    // new set of frames) rather than resetting to the HTML default — but go
    // through applyFps rather than setting state.fps directly, so the
    // number-box stays in sync with the slider. Browsers restore each form
    // control's value independently on a page reload, so the two can drift
    // apart (e.g. the number box stuck on a stale "0") if not resynced here.
    applyFps(Number(fpsSlider.value) || state.fps);
    applyInterpolation(0);

    applyBrightness(0);
    applyContrast(0);
    applyHue(0);
    colorModeRadios.forEach((radio) => { radio.checked = radio.value === 'normal'; });
    state.adjust.colorMode = 'normal';
    cropRatioRadios.forEach((radio) => { radio.checked = radio.value === 'none'; });
    state.cropRatio = null;
    lockAlignmentCheckbox.checked = false;
    state.alignmentLocked = false;
    undoSnapshot = null;
    undoBtn.disabled = true;

    updateColorModeAvailability();
    updateAlignHint();
    renderThumbnailStrip();
    recomputeAlignScale();

    editorEl.hidden = false;
    outputEl.hidden = true;
    resultSizeLabel.textContent = '';
    lastHoverNative = null;
    resetMagnifierToDefault();

    if (frameCount() > 2) {
      state.mode = 'stepping';
      state.alignStep.current = 1;
      // Frame 1 (index 1) starts out already selected — treat it as if it
      // had already been clicked, same as frame 0 the anchor, so it shows
      // no "Not aligned" badge from the very first render.
      state.alignStep.confirmed = state.frames.map((_, i) => i === 0 || i === 1);
      refreshAfterFrameSelection();
    } else {
      state.alignStep.current = 1;
      state.alignStep.confirmed = state.frames.map(() => true);
      enterReadyMode();
    }
  }

  function reset() {
    stopPreviewLoop();
    clearInterpolationCaches();
    state.drag = null;
    state.frames = [];
    state.baseOrder = [];
    state.interpolationCount = 0;
    state.order = [];
    state.mode = 'ready';
    state.alignStep = { current: 1, confirmed: [] };
    state.crop = { x: 0, y: 0, w: 0, h: 0 };
    state.alignmentLocked = false;
    lockAlignmentCheckbox.checked = false;
    undoSnapshot = null;
    undoBtn.disabled = true;
    thumbStripEl.innerHTML = '';
    frameThumbSectionEl.hidden = true;
    orderSequenceStripEl.innerHTML = '';
    orderInput.value = '';
    orderErrorEl.hidden = true;
    orderValid = true;
    editorEl.hidden = true;
    outputEl.hidden = true;
  }

  window.Editor = { load, reset };
})();

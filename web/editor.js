(function () {
  const alignCanvas = document.getElementById('align-canvas');
  const alignCtx = alignCanvas.getContext('2d');
  const resetAlignBtn = document.getElementById('reset-align-btn');

  const previewCanvas = document.getElementById('preview-canvas');
  const previewCtx = previewCanvas.getContext('2d');

  const magnifierCanvas = document.getElementById('magnifier-canvas');
  const magnifierCtx = magnifierCanvas.getContext('2d');
  const alignOffsetLabel = document.getElementById('align-offset-label');
  const alignMagnifierColEl = document.getElementById('align-magnifier-col');

  const frameThumbSectionEl = document.getElementById('frame-thumb-section');
  const thumbStripEl = document.getElementById('thumb-strip');
  const alignHintEl = document.getElementById('align-hint');

  const cropExportPanelEl = document.getElementById('crop-export-panel');

  const orderSectionEl = document.getElementById('order-section');
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

  const scaleSlider = document.getElementById('scale-slider');
  const scaleValue = document.getElementById('scale-value');
  const outputSizeLabel = document.getElementById('output-size-label');
  const resultSizeLabel = document.getElementById('result-size-label');

  const generateGifBtn = document.getElementById('generate-gif-btn');
  const generateWebpBtn = document.getElementById('generate-webp-btn');
  const editorEl = document.getElementById('editor');
  const outputEl = document.getElementById('output');
  const outputGif = document.getElementById('output-gif');
  const downloadLink = document.getElementById('download-link');

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
    '16:9': 16 / 9,
  };

  const state = {
    frames: [],   // [{ img: HTMLImageElement, dx: number, dy: number }], length 2..10.
                  // frames[0].dx/dy are ALWAYS {0,0} — the fixed anchor. Every other frame's
                  // dx/dy is its offset relative to frame 0, in native px.
    W: 0, H: 0,   // native px, taken from frames[0]
    baseName: 'wiggle',
    crop: { x: 0, y: 0, w: 0, h: 0 },
    cropRatio: null, // locked width/height ratio, or null for free-form
    adjust: { brightness: 0, contrast: 0, hue: 0, colorMode: 'normal' },
    fps: 8,
    outputScalePercent: 100,

    order: [], // 0-indexed frame-index sequence driving preview + export

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

  let orderValid = true; // gates Generate buttons independently of webpSupported
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

  function updateOutputSizeLabel() {
    const { w, h } = computeOutputSize();
    outputSizeLabel.textContent = `Output size: ${w} × ${h} px`;
  }

  function sourceRectFor(frameIndex, crop) {
    const f = state.frames[frameIndex];
    return { sx: crop.x - f.dx, sy: crop.y - f.dy, sw: crop.w, sh: crop.h };
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

  // Draws one adjusted/cropped/tinted frame into destCtx. Used by both the
  // live preview loop and the final full-resolution GIF/WebP export, so the
  // preview can never drift from the actual exported file.
  function drawAdjustedFrame(destCtx, frameIndex, destX, destY, destW, destH) {
    const f = state.frames[frameIndex];
    const { sx, sy, sw, sh } = sourceRectFor(frameIndex, state.crop);

    destCtx.drawImage(f.img, sx, sy, sw, sh, destX, destY, destW, destH);

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
      destCtx.fillStyle = frameIndex % 2 === 0 ? TINT_LEFT : TINT_RIGHT;
      destCtx.fillRect(destX, destY, destW, destH);
      destCtx.restore();
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

  function hideMagnifier() {
    magnifierCtx.clearRect(0, 0, magnifierCanvas.width, magnifierCanvas.height);
  }

  // Only show the magnifier while the align/crop canvas is actually
  // selected (focused) — hovering over it without having clicked/tabbed
  // into it first shouldn't pop up the zoom view.
  function maybeDrawMagnifier(nativeX, nativeY) {
    if (document.activeElement === alignCanvas) {
      drawMagnifier(nativeX, nativeY);
    } else {
      hideMagnifier();
    }
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

  function nudgeAlign(ddx, ddy) {
    const f = state.frames[activeAlignFrameIndex()];
    const clamped = clampAlign(f.dx + ddx, f.dy + ddy, state.W, state.H);
    f.dx = clamped.dx;
    f.dy = clamped.dy;
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

    if (hit) {
      alignCanvas.style.cursor = CURSOR_BY_HANDLE[hit.handle];
      state.drag = {
        kind: 'crop-resize',
        handle: hit.handle,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startCrop: { ...state.crop },
      };
    } else {
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
    }
  });

  let lastHoverNative = null; // last mouse position in native coords, for re-drawing the magnifier after a keyboard nudge

  alignCanvas.addEventListener('pointermove', (e) => {
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
    } else {
      // alignScale is intentionally NOT recomputed mid-drag so the
      // canvas-to-native ratio stays constant for the duration of the drag.
      const { dx, dy } = nativeDelta(alignCanvas, alignScale, state.drag.startClientX, state.drag.startClientY, e.clientX, e.clientY);
      state.crop = clampResizeCrop(state.drag.startCrop, state.drag.handle, dx, dy, state.cropRatio);
      drawAlignmentCanvas();
      updateOutputSizeLabel();
    }
  });

  alignCanvas.addEventListener('pointerleave', (e) => {
    if (state.drag) return; // pointer capture keeps a drag going even once the cursor visually leaves
    lastHoverNative = null;
    hideMagnifier();
  });

  alignCanvas.addEventListener('blur', () => {
    hideMagnifier();
  });

  function endAlignCanvasDrag(e) {
    if (!state.drag) return;
    alignCanvas.releasePointerCapture(e.pointerId);
    const wasCrop = state.drag.kind === 'crop-resize';
    state.drag = null;
    if (wasCrop) recomputePreviewScale();
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

  resetAlignBtn.addEventListener('click', () => {
    const f = state.frames[activeAlignFrameIndex()];
    f.dx = 0;
    f.dy = 0;
    if (state.mode === 'ready') {
      clampCropToOverlap();
      recomputePreviewScale();
    }
    drawAlignmentCanvas();
    updateOffsetLabel();
    if (state.mode === 'ready') updateOutputSizeLabel();
    if (lastHoverNative) maybeDrawMagnifier(lastHoverNative.x, lastHoverNative.y);
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

        const arrow = document.createElement('span');
        arrow.className = 'thumb-arrow';
        arrow.textContent = '↓'; // downward arrow, pointing at the suggested-next thumbnail
        imgWrap.appendChild(arrow);

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
    const nextSuggested = state.frames.findIndex((f, i) => i > 0 && !state.alignStep.confirmed[i]);
    Array.from(thumbStripEl.children).forEach((el, i) => {
      el.classList.toggle('confirmed', !!state.alignStep.confirmed[i]);
      el.classList.toggle('active', i === state.alignStep.current);
      el.classList.toggle('suggested-next', i === nextSuggested);
    });
  }

  function applyModeVisibility() {
    const ready = state.mode === 'ready';
    const multi = frameCount() > 2;

    frameThumbSectionEl.hidden = !multi;
    cropExportPanelEl.hidden = !ready;
    orderSectionEl.hidden = !(ready && multi);
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
    hideMagnifier();
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

    state.order = defaultOrder(frameCount());
    orderInput.value = formatOrder(state.order);
    orderErrorEl.hidden = true;
    orderValid = true;

    updateColorModeAvailability();
    applyModeVisibility();
    drawAlignmentCanvas();
    updateOffsetLabel();
    updateOutputSizeLabel();
    updateThumbnailStripState();
    updateGenerateButtonsDisabled();

    lastHoverNative = null;
    hideMagnifier();
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
    const frameIndex = state.order[state.previewOrderIdx % state.order.length];
    drawAdjustedFrame(previewCtx, frameIndex, 0, 0, previewCanvas.width, previewCanvas.height);
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
  const applyBrightness = linkSliderWithNumber(brightnessSlider, brightnessValue, (v) => {
    state.adjust.brightness = v;
  });
  const applyContrast = linkSliderWithNumber(contrastSlider, contrastValue, (v) => {
    state.adjust.contrast = v;
  });
  const applyHue = linkSliderWithNumber(hueSlider, hueValue, (v) => {
    state.adjust.hue = v;
  });
  linkSliderWithNumber(scaleSlider, scaleValue, (v) => {
    state.outputScalePercent = v;
    updateOutputSizeLabel();
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

  // Anaglyph tint is inherently a 2-view concept — disable it once there are
  // more than 2 frames, falling back to Normal if it was somehow selected.
  function updateColorModeAvailability() {
    const anaglyphRadio = document.querySelector('input[name="color-mode"][value="anaglyph"]');
    const disable = frameCount() > 2;
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
    const result = parseOrder(orderInput.value, frameCount());
    orderValid = !result.error;
    orderErrorEl.hidden = orderValid;
    if (result.error) {
      orderErrorEl.textContent = result.error;
    } else {
      state.order = result.order;
    }
    updateGenerateButtonsDisabled();
  });

  function updateGenerateButtonsDisabled() {
    generateGifBtn.disabled = !orderValid;
    generateWebpBtn.disabled = !orderValid || !webpSupported;
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

    for (const frameIndex of state.order) {
      drawAdjustedFrame(ctx, frameIndex, 0, 0, canvas.width, canvas.height);
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
    for (const frameIndex of state.order) {
      drawAdjustedFrame(ctx, frameIndex, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
      if (blob.type !== 'image/webp') {
        throw new Error("This browser can't encode WebP (common on iOS, where every browser uses Safari's engine) — use Generate GIF instead.");
      }
      frames.push({ bytes: new Uint8Array(await blob.arrayBuffer()), duration: delay });
    }

    const animatedBytes = buildAnimatedWebp(frames, canvas.width, canvas.height);
    return { blob: new Blob([animatedBytes], { type: 'image/webp' }), extension: 'webp' };
  }

  async function generateOutput(format) {
    const delay = Math.round(1000 / state.fps);
    const { w, h } = computeOutputSize();

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    generateGifBtn.disabled = true;
    generateWebpBtn.disabled = true;
    try {
      const { blob, extension } = format === 'webp'
        ? await generateWebp(canvas, delay)
        : await generateGif(canvas, delay);

      const url = URL.createObjectURL(blob);
      window.AppShared.trackObjectUrl(url);
      outputGif.src = url;
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

    state.frames = images.map((img) => ({ img, dx: 0, dy: 0 }));
    state.W = images[0].naturalWidth;
    state.H = images[0].naturalHeight;
    state.baseName = baseName;
    state.fps = Number(fpsSlider.value) || state.fps;

    applyBrightness(0);
    applyContrast(0);
    applyHue(0);
    colorModeRadios.forEach((radio) => { radio.checked = radio.value === 'normal'; });
    state.adjust.colorMode = 'normal';
    cropRatioRadios.forEach((radio) => { radio.checked = radio.value === 'none'; });
    state.cropRatio = null;

    updateColorModeAvailability();
    updateAlignHint();
    renderThumbnailStrip();
    recomputeAlignScale();

    editorEl.hidden = false;
    outputEl.hidden = true;
    resultSizeLabel.textContent = '';
    lastHoverNative = null;
    hideMagnifier();

    if (frameCount() > 2) {
      state.mode = 'stepping';
      state.alignStep.current = 1;
      state.alignStep.confirmed = state.frames.map((_, i) => i === 0);
      refreshAfterFrameSelection();
    } else {
      state.alignStep.current = 1;
      state.alignStep.confirmed = state.frames.map(() => true);
      enterReadyMode();
    }
  }

  function reset() {
    stopPreviewLoop();
    state.drag = null;
    state.frames = [];
    state.order = [];
    state.mode = 'ready';
    state.alignStep = { current: 1, confirmed: [] };
    state.crop = { x: 0, y: 0, w: 0, h: 0 };
    thumbStripEl.innerHTML = '';
    frameThumbSectionEl.hidden = true;
    orderInput.value = '';
    orderErrorEl.hidden = true;
    orderValid = true;
    editorEl.hidden = true;
    outputEl.hidden = true;
  }

  window.Editor = { load, reset };
})();

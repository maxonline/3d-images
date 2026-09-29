(function () {
  const alignCanvas = document.getElementById('align-canvas');
  const alignCtx = alignCanvas.getContext('2d');
  const resetAlignBtn = document.getElementById('reset-align-btn');

  const previewCanvas = document.getElementById('preview-canvas');
  const previewCtx = previewCanvas.getContext('2d');

  const magnifierCanvas = document.getElementById('magnifier-canvas');
  const magnifierCtx = magnifierCanvas.getContext('2d');
  const alignOffsetLabel = document.getElementById('align-offset-label');

  const brightnessSlider = document.getElementById('brightness-slider');
  const brightnessValue = document.getElementById('brightness-value');
  const contrastSlider = document.getElementById('contrast-slider');
  const contrastValue = document.getElementById('contrast-value');
  const hueSlider = document.getElementById('hue-slider');
  const hueValue = document.getElementById('hue-value');
  const colorModeRadios = document.querySelectorAll('input[name="color-mode"]');

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

  const state = {
    imgLeft: null,
    imgRight: null,
    W: 0,
    H: 0,
    baseName: 'wiggle',
    align: { dx: 0, dy: 0 },
    crop: { x: 0, y: 0, w: 0, h: 0 },
    adjust: { brightness: 0, contrast: 0, hue: 0, colorMode: 'normal' },
    fps: 8,
    outputScalePercent: 100,
    drag: null,
    previewRAF: null,
    previewElapsed: 0,
    previewShowingLeft: true,
  };

  let alignScale = 1;
  let previewScale = 1;

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

  function computeOverlapRect(dx, dy, W, H) {
    const x0 = Math.max(0, dx);
    const y0 = Math.max(0, dy);
    const x1 = Math.min(W, dx + W);
    const y1 = Math.min(H, dy + H);
    return { x0, y0, x1, y1, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
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
    const ov = computeOverlapRect(state.align.dx, state.align.dy, state.W, state.H);
    state.crop = { x: ov.x0, y: ov.y0, w: ov.w, h: ov.h };
  }

  function clampCropToOverlap() {
    const ov = computeOverlapRect(state.align.dx, state.align.dy, state.W, state.H);
    let { x, y, w, h } = state.crop;
    w = Math.max(Math.min(w, ov.w), Math.min(MIN_CROP, ov.w));
    h = Math.max(Math.min(h, ov.h), Math.min(MIN_CROP, ov.h));
    x = Math.max(ov.x0, Math.min(x, ov.x1 - w));
    y = Math.max(ov.y0, Math.min(y, ov.y1 - h));
    state.crop = { x, y, w, h };
  }

  function clampResizeCrop(startCrop, handle, dx, dy) {
    const ov = computeOverlapRect(state.align.dx, state.align.dy, state.W, state.H);
    let { x, y, w, h } = startCrop;
    const right = x + w;
    const bottom = y + h;

    if (handle === 'nw' || handle === 'sw') {
      const newX = Math.max(ov.x0, Math.min(x + dx, right - MIN_CROP));
      w = right - newX;
      x = newX;
    }
    if (handle === 'ne' || handle === 'se') {
      const newRight = Math.min(ov.x1, Math.max(x + dx + w, x + MIN_CROP));
      w = newRight - x;
    }
    if (handle === 'nw' || handle === 'ne') {
      const newY = Math.max(ov.y0, Math.min(y + dy, bottom - MIN_CROP));
      h = bottom - newY;
      y = newY;
    }
    if (handle === 'sw' || handle === 'se') {
      const newBottom = Math.min(ov.y1, Math.max(y + dy + h, y + MIN_CROP));
      h = newBottom - y;
    }
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

  function sourceRectFor(which, crop, dx, dy) {
    return which === 'left'
      ? { sx: crop.x, sy: crop.y, sw: crop.w, sh: crop.h }
      : { sx: crop.x - dx, sy: crop.y - dy, sw: crop.w, sh: crop.h };
  }

  // Draws one adjusted/cropped/tinted frame into destCtx. Used by both the
  // live preview loop and the final full-resolution GIF export, so the two
  // can never drift apart.
  function drawAdjustedFrame(destCtx, which, destX, destY, destW, destH) {
    const img = which === 'left' ? state.imgLeft : state.imgRight;
    const { sx, sy, sw, sh } = sourceRectFor(which, state.crop, state.align.dx, state.align.dy);

    destCtx.save();
    const b = 1 + state.adjust.brightness / 100;
    const c = 1 + state.adjust.contrast / 100;
    let filter = `brightness(${b}) contrast(${c}) hue-rotate(${state.adjust.hue}deg)`;
    if (state.adjust.colorMode === 'bw') filter += ' grayscale(1)';
    if (state.adjust.colorMode === 'sepia') filter += ' sepia(1)';
    destCtx.filter = filter;
    destCtx.drawImage(img, sx, sy, sw, sh, destX, destY, destW, destH);
    destCtx.restore();

    if (state.adjust.colorMode === 'anaglyph') {
      destCtx.save();
      destCtx.globalCompositeOperation = 'multiply';
      destCtx.fillStyle = which === 'left' ? TINT_LEFT : TINT_RIGHT;
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
    alignOffsetLabel.textContent = `Offset: ${Math.round(state.align.dx)}, ${Math.round(state.align.dy)} px`;
  }

  // Zoomed-in ghosted view centered on the given native-space point — lets
  // fine alignment work (e.g. lining up an eye) happen at native-pixel
  // precision even though the main canvas is scaled way down to fit on screen.
  function drawMagnifier(nativeX, nativeY) {
    const mc = magnifierCanvas;
    const halfW = mc.width / (2 * MAGNIFIER_ZOOM);
    const halfH = mc.height / (2 * MAGNIFIER_ZOOM);

    magnifierCtx.clearRect(0, 0, mc.width, mc.height);

    magnifierCtx.globalAlpha = 1;
    magnifierCtx.drawImage(
      state.imgLeft,
      nativeX - halfW, nativeY - halfH, halfW * 2, halfH * 2,
      0, 0, mc.width, mc.height
    );

    magnifierCtx.globalAlpha = 0.5;
    magnifierCtx.drawImage(
      state.imgRight,
      nativeX - state.align.dx - halfW, nativeY - state.align.dy - halfH, halfW * 2, halfH * 2,
      0, 0, mc.width, mc.height
    );
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
  function hitTestCrop(canvasX, canvasY) {
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
    alignCanvas.style.cursor = hit ? CURSOR_BY_HANDLE[hit.handle] : 'grab';
  }

  // --- Align & crop canvas (one shared view: ghosted double-exposure for
  // alignment, plus the crop rectangle/handles, both clamped to the overlap) ---

  function drawAlignmentCanvas() {
    const s = alignScale;
    alignCtx.clearRect(0, 0, alignCanvas.width, alignCanvas.height);

    alignCtx.globalAlpha = 1;
    alignCtx.drawImage(state.imgLeft, ALIGN_MARGIN_NATIVE * s, ALIGN_MARGIN_NATIVE * s, state.W * s, state.H * s);

    alignCtx.globalAlpha = 0.5;
    alignCtx.drawImage(
      state.imgRight,
      (ALIGN_MARGIN_NATIVE + state.align.dx) * s,
      (ALIGN_MARGIN_NATIVE + state.align.dy) * s,
      state.W * s,
      state.H * s
    );
    alignCtx.globalAlpha = 1;

    // Dashed, since the crop rect commonly coincides exactly with the overlap
    // (e.g. right after load, or after any pure-alignment change) — a solid
    // stroke would then be fully hidden underneath the solid orange crop
    // outline drawn next.
    const ov = computeOverlapRect(state.align.dx, state.align.dy, state.W, state.H);
    const ovTopLeft = toAlignCanvasXY(ov.x0, ov.y0);
    alignCtx.strokeStyle = '#22c55e';
    alignCtx.lineWidth = 2;
    alignCtx.setLineDash([6, 4]);
    alignCtx.strokeRect(ovTopLeft.x, ovTopLeft.y, (ov.x1 - ov.x0) * s, (ov.y1 - ov.y0) * s);
    alignCtx.setLineDash([]);

    drawCropOverlay();
  }

  function nudgeAlign(ddx, ddy) {
    const clamped = clampAlign(state.align.dx + ddx, state.align.dy + ddy, state.W, state.H);
    state.align.dx = clamped.dx;
    state.align.dy = clamped.dy;
    clampCropToOverlap();
    recomputePreviewScale();
    drawAlignmentCanvas();
    updateOffsetLabel();
    updateOutputSizeLabel();
    if (lastHoverNative) drawMagnifier(lastHoverNative.x, lastHoverNative.y);
  }

  alignCanvas.addEventListener('pointerdown', (e) => {
    const { x: cx, y: cy } = clientToCanvasXY(alignCanvas, e.clientX, e.clientY);
    const hit = hitTestCrop(cx, cy);
    alignCanvas.setPointerCapture(e.pointerId);
    alignCanvas.focus();

    if (hit) {
      alignCanvas.style.cursor = CURSOR_BY_HANDLE[hit.handle];
      state.drag = {
        kind: hit.kind,
        handle: hit.handle,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startCrop: { ...state.crop },
      };
    } else {
      alignCanvas.style.cursor = 'grabbing';
      state.drag = {
        kind: 'align',
        startClientX: e.clientX,
        startClientY: e.clientY,
        startDx: state.align.dx,
        startDy: state.align.dy,
      };
    }
  });

  let lastHoverNative = null; // last mouse position in native coords, for re-drawing the magnifier after a keyboard nudge

  alignCanvas.addEventListener('pointermove', (e) => {
    const { x: cx, y: cy } = clientToCanvasXY(alignCanvas, e.clientX, e.clientY);
    lastHoverNative = fromAlignCanvasXY(cx, cy);
    drawMagnifier(lastHoverNative.x, lastHoverNative.y);

    if (!state.drag) {
      updateAlignHoverCursor(e.clientX, e.clientY);
      return;
    }
    if (state.drag.kind === 'align') {
      const { dx, dy } = nativeDelta(alignCanvas, alignScale, state.drag.startClientX, state.drag.startClientY, e.clientX, e.clientY);
      const clamped = clampAlign(state.drag.startDx + dx, state.drag.startDy + dy, state.W, state.H);
      state.align.dx = clamped.dx;
      state.align.dy = clamped.dy;
      clampCropToOverlap();
      recomputePreviewScale();
      drawAlignmentCanvas();
      updateOffsetLabel();
      updateOutputSizeLabel();
    } else {
      // alignScale is intentionally NOT recomputed mid-drag so the
      // canvas-to-native ratio stays constant for the duration of the drag.
      const { dx, dy } = nativeDelta(alignCanvas, alignScale, state.drag.startClientX, state.drag.startClientY, e.clientX, e.clientY);
      state.crop = clampResizeCrop(state.drag.startCrop, state.drag.handle, dx, dy);
      drawAlignmentCanvas();
      updateOutputSizeLabel();
    }
  });

  alignCanvas.addEventListener('pointerleave', (e) => {
    if (state.drag) return; // pointer capture keeps a drag going even once the cursor visually leaves
    lastHoverNative = null;
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
    state.align.dx = 0;
    state.align.dy = 0;
    clampCropToOverlap();
    recomputePreviewScale();
    drawAlignmentCanvas();
    updateOffsetLabel();
    updateOutputSizeLabel();
    if (lastHoverNative) drawMagnifier(lastHoverNative.x, lastHoverNative.y);
  });

  // --- Live preview animation loop (read-only mimic of the final GIF) ---

  let lastFrameTime = null;

  function previewTick(timestamp) {
    if (lastFrameTime === null) lastFrameTime = timestamp;
    const delta = timestamp - lastFrameTime;
    lastFrameTime = timestamp;

    state.previewElapsed += delta;
    const flipInterval = 1000 / state.fps;
    if (state.previewElapsed >= flipInterval) {
      state.previewShowingLeft = !state.previewShowingLeft;
      state.previewElapsed = 0;
    }

    drawPreviewFrame();
    state.previewRAF = requestAnimationFrame(previewTick);
  }

  function drawPreviewFrame() {
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    const which = state.previewShowingLeft ? 'left' : 'right';
    drawAdjustedFrame(previewCtx, which, 0, 0, previewCanvas.width, previewCanvas.height);
  }

  function startPreviewLoop() {
    stopPreviewLoop();
    lastFrameTime = null;
    state.previewElapsed = 0;
    state.previewShowingLeft = true;
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

    drawAdjustedFrame(ctx, 'left', 0, 0, canvas.width, canvas.height);
    gif.addFrame(canvas, { copy: true, delay });
    drawAdjustedFrame(ctx, 'right', 0, 0, canvas.width, canvas.height);
    gif.addFrame(canvas, { copy: true, delay });

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

    drawAdjustedFrame(ctx, 'left', 0, 0, canvas.width, canvas.height);
    const leftBlob = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
    if (leftBlob.type !== 'image/webp') {
      throw new Error('This browser does not support encoding WebP images.');
    }
    const leftBytes = new Uint8Array(await leftBlob.arrayBuffer());

    drawAdjustedFrame(ctx, 'right', 0, 0, canvas.width, canvas.height);
    const rightBlob = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
    const rightBytes = new Uint8Array(await rightBlob.arrayBuffer());

    const animatedBytes = buildAnimatedWebp(
      [{ bytes: leftBytes, duration: delay }, { bytes: rightBytes, duration: delay }],
      canvas.width,
      canvas.height
    );
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
      generateGifBtn.disabled = false;
      generateWebpBtn.disabled = false;
    }
  }

  generateGifBtn.addEventListener('click', () => generateOutput('gif'));
  generateWebpBtn.addEventListener('click', () => generateOutput('webp'));

  // --- Window resize ---

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.imgLeft) return;
      recomputeAlignScale();
      recomputePreviewScale();
      drawAlignmentCanvas();
    }, 150);
  });

  // --- Public API ---

  function load(imgLeft, imgRight, baseName) {
    stopPreviewLoop();

    state.imgLeft = imgLeft;
    state.imgRight = imgRight;
    state.W = imgLeft.naturalWidth;
    state.H = imgLeft.naturalHeight;
    state.baseName = baseName;
    state.align.dx = 0;
    state.align.dy = 0;
    state.fps = Number(fpsSlider.value) || state.fps;

    applyBrightness(0);
    applyContrast(0);
    applyHue(0);
    colorModeRadios.forEach((radio) => { radio.checked = radio.value === 'normal'; });
    state.adjust.colorMode = 'normal';

    resetCropToOverlap();
    recomputeAlignScale();
    recomputePreviewScale();

    editorEl.hidden = false;
    outputEl.hidden = true;

    drawAlignmentCanvas();
    updateOffsetLabel();
    updateOutputSizeLabel();
    resultSizeLabel.textContent = '';
    lastHoverNative = null;
    hideMagnifier();
    startPreviewLoop();
  }

  function reset() {
    stopPreviewLoop();
    state.drag = null;
    editorEl.hidden = true;
    outputEl.hidden = true;
  }

  window.Editor = { load, reset };
})();

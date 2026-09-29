# W3 Wiggle GIF/WebP Maker

A static, no-build client-side web app that turns Fujifilm FinePix Real 3D W3
stereo photos (`.MPO` files, or two separate JPEGs) into an animated
"wiggle stereoscopy" GIF or WebP — flipping between the left/right frames to
fake 3D depth. Everything runs in the browser; there is no server-side code
and no build step.

## Running it

```sh
./run.sh
```

This serves `web/` on `http://localhost:8000` via `python3 -m http.server`.
A real server is required — the GIF encoder (`lib/gif.js`) uses a Web
Worker, which browsers block under `file://`.

## Deploying

Production deploys to a real server (nginx, HTTPS) are covered in
[`DEPLOY.md`](./DEPLOY.md) — `./deploy.sh` pushes `web/` to the server,
`deploy/server-setup.sh` is the one-time nginx/certbot setup.

## Layout

```
web/
  index.html   — all markup/UI
  style.css    — all styling
  app.js       — file intake: MPO splitting, JPEG decoding, drag & drop
  editor.js    — everything after frames are loaded: align/crop UI,
                 live preview, adjustments, GIF/WebP export
  lib/         — vendored gif.js + gif.worker.js (jnordberg/gif.js 0.2.0),
                 no npm, no other dependencies
test/
  test.MPO     — a real sample file from the camera, used for manual/agent testing
run.sh         — serves web/ locally
```

`app.js` and `editor.js` talk to each other through two small globals set up
at load time: `window.AppShared` (status line + object-URL tracking, owned
by `app.js`) and `window.Editor` (`load(imgLeft, imgRight, baseName)` /
`reset()`, owned by `editor.js`).

## Key design points worth knowing before editing

**MPO splitting (`app.js`, `splitMpoImages`/`findImageEnd`).** An MPO file
is just two complete JPEGs concatenated. Splitting them is *not* a naive
scan for the next `0xFFD9` byte pair — the first image's Exif (APP1) segment
commonly embeds its own small thumbnail JPEG, complete with a nested
SOI/EOI pair, which would fool a naive scan. Instead the code properly walks
JPEG marker segments (using each segment's declared length to skip over
segment contents, including entropy-coded scan data) to find the *true* EOI.

**Editor coordinate systems (`editor.js`).** Three spaces are in play:
*native* (source image pixels), *canvas-space* (a scaled-down backing store,
since camera frames are e.g. 3584×2016), and *client* (raw mouse
coordinates). `clientToCanvasXY` / `toAlignCanvasXY` / `fromAlignCanvasXY`
convert between them; always go through these rather than assuming CSS
pixels equal backing-store pixels.

**One canvas does both alignment and crop.** `#align-canvas` shows a
semi-transparent double-exposure of both frames (drag anywhere to nudge the
right frame's offset — arrow keys nudge by exactly 1 native px) *and* the
crop rectangle's 4 corner handles, layered on top. This is deliberate: the
crop starts out covering the entire overlap region, so if dragging the crop
*body* were also supported, it would swallow almost all click area meant for
the (primary) alignment drag. Only the 4 corner handles are draggable for
resizing the crop; there's a 200px native-pixel margin baked into the
canvas around both images so alignment drags don't push either frame off
the visible canvas.

**The crop rectangle is always clamped inside the overlap.** `state.crop`
must stay within `computeOverlapRect(dx, dy, W, H)` — enforced by
`clampCropToOverlap`/`clampResizeCrop` after every alignment or crop change.
`clampAlign` also prevents the overlap itself from shrinking below 30% of
the frame in either axis.

**Crop aspect-ratio lock (`state.cropRatio`, the "Crop aspect ratio" radio
group) reuses the same clamp functions rather than being a separate code
path.** `clampResizeCrop` computes an anchor point (the corner opposite the
one being dragged, which never moves) and a free-form candidate size from
the raw drag, exactly as before; when a ratio is locked it then derives one
dimension from the other via that ratio and scales both down uniformly
(never independently — that would distort the ratio) to fit the available
space from the anchor to the overlap edge. `clampCropToOverlap` and picking
a new ratio both go through `fitCropToRatio`, which fits the largest
ratio-matching rect that stays within the crop's *current* size (so locking
a ratio never balloons the crop bigger than what was already selected) and
the overlap, centered on the previous crop's center. Because both paths
funnel through the same two functions, alignment drags, arrow-key nudges,
and corner-handle resizes all keep a locked ratio correct automatically —
there's no separate "is a ratio locked" branch anywhere else in the drag
handlers.

**One shared frame-drawing function, three consumers.** `drawAdjustedFrame`
(crop → brightness/contrast/hue/grayscale/sepia via hand-rolled pixel math →
optional red/cyan anaglyph tint via `multiply` composite) is called by the
live preview loop, and by both `generateGif`/`generateWebp` at full export
resolution. This guarantees the preview never drifts from the actual
exported file.

**Adjustments are manual pixel math, not `ctx.filter` — this was a real bug,
not a style choice.** It used to build a `ctx.filter = 'brightness(...)
contrast(...) hue-rotate(...)'` string and let the canvas apply it. That
works on Chromium/Firefox but is silently a complete no-op on WebKit — every
browser on iOS, since Apple requires them all to use Safari's engine
regardless of name (confirmed with Playwright's `webkit` browser: setting
`ctx.filter` and drawing produces byte-identical pixels to not setting it at
all, no error, nothing in the console). `applyPixelAdjustments` reimplements
brightness/contrast/hue-rotate/grayscale/sepia by hand via `getImageData`/
`putImageData`, matching the CSS Filter Effects spec's formulas exactly
(including the hue-rotate rotation matrix), so results look identical on
engines where the native filter would've worked anyway. The anaglyph tint's
`globalCompositeOperation = 'multiply'` was verified working fine on WebKit
and was left as-is — only the `ctx.filter`-dependent parts needed replacing.
If you touch this code, verify with `npx playwright install webkit` and the
`webkit` launcher, not just Chromium — this bug produced zero errors and
looked completely fine there.

**WebP export is fundamentally unavailable on WebKit, not just buggy.**
`canvas.toBlob(..., 'image/webp')` silently returns a PNG blob instead of
throwing there — no per-frame encode ever happens, and there's no client-side
fix (WebKit has no WebP encoder to call into; writing one from scratch is a
real video codec, far out of scope). `editor.js` feature-detects this once
on load and disables the "Generate WebP" button with an explanatory `title`
rather than letting someone wait through a full export to hit an error.

**Animated WebP is hand-muxed, not WASM-encoded** (on engines that do
support the static encoder). Browsers only expose a *static* single-frame
WebP encoder (`canvas.toBlob(..., 'image/webp')`) — there's no built-in
animated-WebP API. `editor.js` encodes each frame separately via
`canvas.toBlob`, then hand-builds a minimal RIFF container (`VP8X` + `ANIM` +
one `ANMF` chunk per frame) to mux them into a real animated WebP, the same
"read/write a binary container format by hand" approach as the MPO splitter.
One gotcha already hit once: Chrome embeds extra chunks (e.g. `ICCP` color
profile) in its single-frame WebP output — `extractWebpImageChunks` uses an
**allow-list** (`ALPH`/`VP8 `/`VP8L` only),
not a block-list, when pulling image data out for the `ANMF` payload.

**Output scale is independent of crop.** The crop rect defines the *source*
region in native pixels; the "Output scale" slider only changes the
*destination* size frames are drawn into at export time (`computeOutputSize`).
Dragging/resizing the crop never touches this.

**No build step, on purpose.** Keep it a plain static site — if a dependency
is needed, vendor its files into `web/lib/` (as done for gif.js) rather than
introducing npm/bundlers.

## Testing

There's no test suite. Changes have been manually verified with Playwright
driven against a real Node (this machine's default `node` is v18 via a
plain install, but Playwright needs Node 20+ — use `nvm use 22` first) and
`test/test.MPO`. There's no repo convention for keeping these scripts around;
they were written ad hoc in a scratch directory and discarded after
verification. If you touch the alignment/crop math, re-verify against real
image content rather than trusting synthetic fixtures — several real bugs
here (e.g. the WebP `ICCP` chunk issue) only showed up with genuine
browser-encoded output.

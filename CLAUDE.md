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
`clampCropToOverlap`/`clampMoveCrop`/`clampResizeCrop` after every
alignment or crop change. `clampAlign` also prevents the overlap itself
from shrinking below 30% of the frame in either axis.

**One shared frame-drawing function, three consumers.** `drawAdjustedFrame`
(crop → `ctx.filter` brightness/contrast/hue → optional red/cyan anaglyph
tint via `multiply` composite) is called by the live preview loop, and by
both `generateGif`/`generateWebp` at full export resolution. This guarantees
the preview never drifts from the actual exported file.

**Animated WebP is hand-muxed, not WASM-encoded.** Browsers only expose a
*static* single-frame WebP encoder (`canvas.toBlob(..., 'image/webp')`) —
there's no built-in animated-WebP API. `editor.js` encodes each frame
separately via `canvas.toBlob`, then hand-builds a minimal RIFF container
(`VP8X` + `ANIM` + one `ANMF` chunk per frame) to mux them into a real
animated WebP, the same "read/write a binary container format by hand"
approach as the MPO splitter. One gotcha already hit once: Chrome embeds
extra chunks (e.g. `ICCP` color profile) in its single-frame WebP output —
`extractWebpImageChunks` uses an **allow-list** (`ALPH`/`VP8 `/`VP8L` only),
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

# Wigglegram Maker

A static, no-build client-side web app that turns a Fujifilm FinePix Real 3D
W3 stereo photo (`.MPO` file) or a set of 2–10 separately-uploaded JPEGs into
an animated "wigglegram" GIF, WebP, or MP4 — cycling through the frames to
fake 3D depth or create a burst-sequence animation. Everything runs in the
browser; there is no server-side code and no build step.

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
  app.js       — file intake: MPO splitting, JPEG decoding, dynamic 2–10
                 frame upload boxes, drag & drop
  editor.js    — everything after frames are loaded: step-by-step alignment
                 for 3+ frames, crop UI, live preview, adjustments, animation
                 order, GIF/WebP/MP4 export
  lib/         — vendored gif.js + gif.worker.js (jnordberg/gif.js 0.2.0) and
                 mp4-muxer.js (Vanilagy/mp4-muxer, MIT), no npm, no other
                 dependencies
run.sh         — serves web/ locally
```

`app.js` and `editor.js` talk to each other through two small globals set up
at load time: `window.AppShared` (status line + object-URL tracking, owned
by `app.js`) and `window.Editor` (`load(images, baseName)` where `images` is
an array of 2–10 `HTMLImageElement`s, plus `reset()`, owned by `editor.js`).

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
must stay within `currentOverlapRect()` — enforced by
`clampCropToOverlap`/`clampResizeCrop` after every alignment or crop change.
`clampAlign` also prevents the overlap itself from shrinking below 30% of
the frame in either axis (checked pairwise against the fixed anchor frame,
not the live N-way intersection — an accepted simplification).

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
handlers. The fixed-ratio set (`CROP_RATIOS`) mixes classic photo ratios
(1:1, 1:2, 2:1, 4:3, 3:2) with social-media aspect ratios (4:5 portrait,
9:16 Stories/Reels/vertical video, 16:9 widescreen, 1.91:1 landscape link
cards) — all just entries in the same width/height-ratio map, no separate
code path for the newer ones.

**2–10 frames, one array-based model — the 2-frame case is not special-cased
separately, it just naturally degenerates to today's old behavior.**
`state.frames` is `[{img, dx, dy}]`; `frames[0]` is always the fixed anchor
at `{dx:0, dy:0}` (what used to be `imgLeft`), every other frame's `dx/dy` is
its offset relative to frame 0 (what used to be the single `state.align`).
`app.js`'s upload UI grows a new empty box every time the last one fills, up
to `MAX_FRAMES = 10` (`app.js`'s `appendFrameBox`/`maybeGrowBoxes`, cloned
from `<template id="frame-drop-zone-template">`); filling any box re-fires
`Editor.load()` with the current contiguous prefix of filled boxes — there's
no "commit" step, matching the old 2-box behavior exactly generalized. When
you touch anything align/crop-related, sanity-check the N=2 path still
behaves identically — `frameCount() === 2` is threaded through as the
condition that keeps every new UI section (thumbnail strip, animation-order
box) permanently hidden via `applyModeVisibility()`.

**Click-to-select alignment for 3+ frames (`state.mode`: `'stepping'` |
`'ready'`) — no wizard buttons, no reset button, frames can be aligned in any
order.** The thumbnail strip (`#frame-thumb-section`) sits directly above the
align canvas, right after `#align-hint`. Every non-anchor frame gets a
clickable thumbnail (`renderThumbnailStrip`); clicking one
(`selectFrame(index)`) makes it the active frame on the align canvas AND
immediately marks it confirmed — a frame left at its default `{0,0}` offset
is a valid confirmation, no drag required, and there's no separate "Confirm"
step. Frame 0 (the anchor) is never rendered as clickable — no thumbnail
click handler is attached to it at all. Frames not yet confirmed show a "Not
aligned" text badge over their thumbnail (`.thumb-badge`, CSS-driven by the
absence of the `.confirmed` class); the currently-active thumbnail gets a
visibly thicker border plus an accent box-shadow ring (`.thumb.active
.thumb-img`) so the selection is unambiguous at a glance. On initial load
with 3+ frames, frame index 1 starts pre-selected *and* pre-confirmed (`load()`
seeds `state.alignStep.confirmed` with both index 0 and index 1 true, and
`state.alignStep.current = 1`), so it shows no "Not aligned" badge from the
very first render — exactly as if it had already been clicked. There is no
dedicated "reset alignment" control: since any frame (including ones already
confirmed) can be reselected and redragged at any time via its thumbnail,
a separate reset-to-zero button would be redundant.
`state.alignStep.current` is just "whichever frame was selected most
recently," not a strict sequence position — frames can be confirmed in any
order. The crop/preview/export UI (`#crop-export-panel`) unlocks the *first*
time every frame has been confirmed at least once (`state.mode` flips to
`'ready'` inside `enterReadyMode()`, called from `selectFrame`) and **stays
unlocked permanently** — clicking a thumbnail again later (even one already
confirmed) just reselects it for further dragging via
`refreshAfterFrameSelection()`, without re-hiding the crop panel or
resetting the crop/order/adjustments `enterReadyMode()` already set up.

The ghosted backdrop you align against is drawn by `drawRunningAverageStack`,
which draws each already-confirmed *other* frame at `globalAlpha = 1/(its
position in that list)` — this is worth knowing precisely because it is
**mathematically exact**, not a fudge: by induction, sequentially compositing
frame *i* (1-indexed) at `1/i` produces the exact unweighted pixel average of
all frames drawn so far, for opaque sources. The frame currently being
dragged is drawn on top at a fixed ~0.55 alpha, not part of that average.
`drawAlignmentCanvas` and `drawMagnifier` both call this same helper with
the same branching (stepping vs. 2-frame-ready vs. N>2-ready-mode static
ghost) so the loupe never shows something different from the main canvas.

**Confirmation order is NOT necessarily increasing index order — this was a
real bug, caught and fixed, not just a theoretical concern.** Both the
backdrop list (`confirmedBackdropIndices()`) and the live overlap
(`currentOverlapFrames()`) must filter `state.frames` by the actual
`confirmed[]` set, not slice a `0..current` prefix — an earlier version used
`state.frames.slice(0, state.alignStep.current + 1)`, which silently dropped
a higher-index frame's real offset from the overlap/backdrop the moment you
clicked a *lower*-index thumbnail afterward (`current` decreasing broke the
prefix assumption). Confirmed with a targeted test: drag frame 3 to a large
offset, confirm it, then select frame 2 — `currentOverlapRect()` must still
reflect frame 3's offset afterward. If you touch either of these functions,
re-run that scenario, not just the "click 1, 2, 3 in order" happy path.

**Animation order (`state.order`/`state.baseOrder`, 3+ frames only for the
textbox — see interpolation below for 2-frame animation control).** A
validated, comma-separated 1-indexed text field (`#order-input`,
`parseOrder`/`formatOrder`) drives `state.baseOrder`, the *real* frame
sequence; `defaultOrder(n)` produces a pendulum bounce (`[0..n-1, n-2..1]`,
which is `[0,1]` — i.e. today's old plain alternation — when `n===2`, and
`[0,1,2,3,2,1]` → displayed as `"1,2,3,4,3,2"` when `n===4`). `generateGif`/
`generateWebp`/`generateMp4`/the live preview loop all loop over
`state.order` (== `withInterpolation(state.baseOrder, state.interpolationCount)`,
see below) calling `drawOrderEntry(ctx, entry, ...)` once per entry, instead
of the old two fixed calls. `buildAnimatedWebp` needed zero changes to
support any of this — it already accepted an arbitrary-length frame array.

**Interpolated (tweened) frames — real optical flow (OpenCV.js), with a
rigid shift+crossfade fallback.** The "Interpolated frames" slider
(`state.interpolationCount`, 0–10, any frame count) inserts `k` synthesized
in-between frames between every consecutive pair in `state.baseOrder` via
`withInterpolation(order, k)`, producing entries of the form `{a, b, t}`
(`t` strictly in `(0,1)`) interleaved with the existing plain frame-index
numbers — deliberately **not** also smoothing the implicit loop-back from
the last entry to the first, since that's already a hard cut today for
every frame count and wasn't something worth silently also changing.
`drawOrderEntry` is the single dispatcher every consumer of `state.order`
goes through: a plain number still means "draw this real frame" exactly as
before (so `state.interpolationCount === 0`, the default, is byte-for-byte
identical to pre-interpolation behavior); an `{a,b,t}` object draws a cached
optical-flow-warped frame if one's ready (`interpFrameCache`), else the
**rigid fallback** (`drawInterpolatedFrameRigid`, the original technique
from before this session's optical-flow pass): linearly interpolate the
rigid alignment offset between `a` and `b`, then draw **both** frames' raw
pixels through that *same* interpolated offset (`sourceRectFor`'s optional
third `offsetOverride` param) — `a` opaque as the base layer, `b`
alpha-blended on top at `globalAlpha = entry.t`. (That sequencing — base
fully opaque, THEN the top layer at alpha `t`, not the base at `1-t` — is
required to get Porter-Duff source-over compositing to work out to the
correct linear blend `B*t + A*(1-t)`; the same sequencing
`drawRunningAverageStack` already relies on elsewhere in this file.) The
rigid technique treats the whole frame as one flat plane, so anything off
the alignment plane shows double-exposure ghosting — it's kept only as an
**instant placeholder** (shown the moment the slider moves, before that
entry's real optical-flow frame has finished computing) and a **resilience
fallback** (if the library fails to load, e.g. offline). Pixel adjustments/
anaglyph tint are applied once to the *composited* result
(`applyDestAdjustmentsAndTint`, split out of the old single
`drawAdjustedFrame` body) rather than per layer either way, which is both
simpler and correct — adjustments should be uniform across the output
regardless of which frame(s)/technique contributed a given pixel.

**The real optical-flow path (`getFlowForPair`/`getInterpolatedCanvas`,
OpenCV.js's Farneback dense flow).** Real per-pixel motion estimation was
worth trying because the rigid technique's flat-plane assumption is exactly
what a stereo photo's foreground/background parallax mismatch breaks —
verified concretely: the same real test photo showed clear double-exposure
ghosting on a close subject with the rigid technique, and a sharp,
ghost-free result with this one. `getFlowForPair(a, b)` computes one
Farneback flow field between `a` and `b`'s *cropped* content (grayscale,
`cv.calcOpticalFlowFarneback`), cached per pair since flow doesn't depend
on `t`; `getInterpolatedCanvas(a, b, t)` builds the actual in-between frame
by warping `a` forward by `t * flow` and `b` backward by `(1-t) * flow`
(both via `cv.remap`, an inverse/backward mapping) then blending by `t` —
the standard "one flow field, two warps" simple-optical-flow-interpolation
technique, rather than computing flow in both directions. **Runs at a
capped working resolution** (`FLOW_WORK_DIM = 640` on the longer side, not
the native crop size) — remap/flow cost scales with pixel count, and this
keeps one pair's prep well under a few seconds instead of potentially tens
of seconds at real camera resolution; only the *interpolated* frames are
capped this way, the real endpoint frames on either side stay full native
resolution. Cached results (`flowPairCache`, `interpFrameCache`, keyed
`"a-b"` / `"a-b-t"`) are cleared (`clearInterpolationCaches`) whenever
anything the flow was computed from changes — a new upload (`load`/`reset`),
any alignment-drag or crop-resize-drag end, or an arrow-key nudge — since
those all change the cropped pixel content flow is computed from.

**OpenCV.js is loaded from a CDN, not vendored — a deliberate exception to
this app's usual "vendor everything into web/lib/" rule**, and only lazily,
the first time interpolation is actually turned on (never a blocking
page-load dependency the way gif.js/mp4-muxer.js are). The browser build
(`@techstark/opencv-js`, pinned version in `OPENCV_CDN_URL`) is ~13MB —
its WASM binary embedded inline as a JS string — far larger than anything
else this project has ever committed; given this whole feature is an
experiment the user explicitly asked to try, committing that much generated
code to git felt wrong. If the technique proves worth keeping permanently,
self-hosting it should be reconsidered then. **`window.cv` is a Promise,
not the resolved module — this was a real bug, not a style choice.** Most
Emscripten/OpenCV.js builds signal readiness via a synchronous `Module`
object plus a `cv.onRuntimeInitialized` callback; this particular build's
UMD wrapper (`root.cv = factory()`) instead assigns the *Promise itself* to
`window.cv`, which only resolves to the real module once the WASM runtime
finishes initializing. `loadOpenCv()` first checks whether `window.cv` is
thenable and awaits it; the `onRuntimeInitialized` handling is kept as a
fallback for other opencv.js builds, but wasn't what this specific CDN
build actually needed — confirmed by direct inspection (`cv.Mat` stayed
`undefined` forever using only the callback path; switching to awaiting the
promise resolved it in ~2 seconds). If you swap CDN builds/versions, check
which shape you actually got before assuming either path works.

**Preview upgrades in place; export always waits.** Turning the slider up
(or editing the order textbox, or the debounced `scheduleInterpolationPrep`
it shares) sets `state.order` to the new `{a,b,t}` entries *immediately* —
the live preview draws the instant rigid fallback for anything not yet
cached, then seamlessly starts drawing the real optical-flow frame the
moment `prepareInterpolatedFrames` finishes it in the background, with zero
extra state-tracking (the cache check in `drawOrderEntry` just starts
succeeding). `generateOutput`, by contrast, explicitly `await`s
`prepareInterpolatedFrames(state.order)` before drawing anything, so an
exported file's quality never depends on timing luck the way a live preview
frame reasonably can.

**Anaglyph tint only makes sense for 2 clean views.** `updateColorModeAvailability`
disables that radio option (and force-switches to Normal if it was somehow
selected) whenever `frameCount() > 2` OR `state.interpolationCount > 0` — a
blended interpolated frame isn't a clean single view either, same reasoning
extended to the newer case. The tint itself, when active, keys off
`frameIndex % 2` rather than a `'left'`/`'right'` string.

**Two-layer split for frame drawing: raw draw vs. adjust/tint, four
consumers via one dispatcher.** `drawFrameRaw` (crop, optional offset
override, optional alpha — no adjustments) and `applyDestAdjustmentsAndTint`
(brightness/contrast/hue/grayscale/sepia via hand-rolled pixel math →
optional red/cyan anaglyph tint via `multiply` composite) are the two
halves `drawAdjustedFrame` (single real frame) and `drawInterpolatedFrameRigid`
(rigid-shift blended pair, see below) each combine differently;
`drawOrderEntry` is the single dispatcher every consumer goes through — a
plain number means `drawAdjustedFrame`, an `{a,b,t}` object means the
cached optical-flow frame if ready, else `drawInterpolatedFrameRigid`. All
of the live preview loop, `generateGif`, `generateWebp`, and `generateMp4`
call `drawOrderEntry`, never `drawAdjustedFrame` directly — this guarantees
the preview never drifts from the actual exported file, now for
interpolated frames too.

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

**MP4 export uses WebCodecs to encode, a vendored muxer to contain — same
split of labor as gif.js, different half of the problem.** Where the GIF
path needed an encoder (gif.js supplies one; the browser has none) and the
WebP path needed a *muxer* (browsers have a static encoder but no animated
container writer), MP4 needs both, but the browser actually supplies the
hard half: `VideoEncoder` (WebCodecs) does real H.264 encoding in native
code. What's missing is only an MP4 container writer, so `lib/mp4-muxer.js`
(vendored from `Vanilagy/mp4-muxer`, MIT-licensed, a single dependency-free
browser build — same vendoring approach as gif.js, added via
`<script src="lib/mp4-muxer.js">` for its `window.Mp4Muxer` global) takes
each encoded chunk from `VideoEncoder`'s output callback and writes the
`ftyp`/`moov`/`mdat` boxes. `generateMp4` in `editor.js` loops over
`state.order` exactly like `generateGif`/`generateWebp` do, drawing each
frame via the same shared `drawAdjustedFrame`, feeding it to the encoder as
a `VideoFrame` at `timestamp/duration` set from the fps-derived delay (in
microseconds, since that's the unit WebCodecs uses — everywhere else in the
codebase, delay is milliseconds). **`MP4_CODEC_CANDIDATES` tries High
profile before Baseline**: `VideoEncoder.isConfigSupported` depends on the
actual output *resolution*, not just on what the browser supports in the
abstract, and Baseline profile caps out at lower resolutions than real
camera crops can hit — so `pickMp4Codec` probes candidates from most- to
least-capable and uses the first one the current browser+resolution combo
actually accepts, rather than hardcoding one codec string and letting large
exports fail. **H.264 4:2:0 needs even width/height** — `generateOutput`
trims one row/column off `computeOutputSize()`'s result when (and only
when) `format === 'mp4'`, leaving the GIF/WebP canvas size untouched.
Unlike the WebP case, this isn't a WebKit-only gap: WebCodecs' `VideoEncoder`
is broadly supported (confirmed working via Playwright's `chromium` *and*
`webkit` launchers — real Safari has shipped it since 16.4), so
`generateMp4Btn` is feature-detected the same way `generateWebpBtn` is
(`mp4Supported`, checked once via `VideoEncoder.isConfigSupported` at load)
but is expected to actually stay enabled almost everywhere.

**The `mp4Supported` detection call is wrapped in `try`/`catch`, and this
was a real bug, not defensive-programming theater** — a report of the
whole editor silently failing to appear after uploading 2 images on
Android Firefox traced back to exactly this. `VideoEncoder.isConfigSupported`
was called directly, guarded only by `.then()`/`.catch()` on its return
value; a browser with `VideoEncoder` present but a broken/partial
implementation (a real risk given how new/inconsistent WebCodecs support
still is across engines) could throw *synchronously* instead of
rejecting, and since this detection runs unconditionally at script-load
time near the top of `editor.js`'s single top-level IIFE, an uncaught
throw there aborts everything below it — including `window.Editor = ...`
at the very bottom. `app.js`'s upload boxes are a separate script and
kept working, so the file inputs looked fine right up until the moment
`app.js` called the now-nonexistent `window.Editor.load(...)`. The WebP
detection right above it never had this problem because `canvasToBlob()`
wraps its work in a real `new Promise(...)` executor, which auto-converts
any internal throw into a rejection — `VideoEncoder.isConfigSupported` is
called directly with no such wrapper, so it needed its own `try`/`catch`.
Fixing this surfaced a second, previously-unreachable bug in the same
spot: the `catch` block calls `updateGenerateButtonsDisabled()`, which
reads `orderValid` — originally declared via `let` much further down in
the file, so hitting it from this now-synchronous catch path threw its
own temporal-dead-zone error and broke the app the exact same way.
`orderValid`'s declaration was moved above both detection blocks to fix
that. If you add a third format needing its own up-front feature-detect,
follow the WebP/Promise-executor pattern or wrap it in `try`/`catch` like
this — never call a browser capability-detection API unguarded at
top-level script-execution time.

The result
`<img>` can't display a video, so `#output-video` is a separate `<video
controls loop muted>` element that `generateOutput` shows/hides opposite
`#output-gif` based on the returned `extension`.

**Output scale is independent of crop.** The crop rect defines the *source*
region in native pixels; the "Output scale" slider only changes the
*destination* size frames are drawn into at export time (`computeOutputSize`).
Dragging/resizing the crop never touches this.

**No build step, on purpose.** Keep it a plain static site — if a dependency
is needed, vendor its files into `web/lib/` (as done for gif.js and
mp4-muxer.js) rather than introducing npm/bundlers.

## Testing

There's no test suite and no sample images kept in the repo (the original
`test/test.MPO` was deleted). Changes have been manually verified with
Playwright driven against a real Node (this machine's default `node` is v18
via a plain install, but Playwright needs Node 20+ — use `nvm use 22`
first), using JPEGs generated on the fly with ImageMagick
(`convert -size 320x240 xc:"steelblue" -gravity center -pointsize 60 -fill
white -annotate 0 "1" out.jpg`) for multi-frame testing, and a real camera
MPO when one was available. There's no repo convention for keeping these
scripts around; they were written ad hoc in a scratch directory and
discarded after verification. If you touch the alignment/crop math,
re-verify against real image content rather than trusting synthetic
fixtures — several real bugs here (e.g. the WebP `ICCP` chunk issue) only
showed up with genuine browser-encoded output. One ImageMagick-specific
gotcha hit while building the multi-frame tests: generating several
`convert` calls back-to-back inside a single `for i in 1 2 3...; do
color=${colors[$((i-1))]}; convert ...; done` shell loop produced corrupted/
mismatched output for some frames (no error, just wrong content) in this
environment — generating each file as its own separate command sidestepped
it. Not investigated further since it's a test-fixture-generation quirk,
not an app bug, but worth remembering if a multi-frame test starts showing
implausible colors.

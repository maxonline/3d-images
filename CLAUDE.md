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
*body* were also supported by a plain click-drag, it would swallow almost
all click area meant for the (primary) alignment drag. Only the 4 corner
handles are draggable for resizing the crop; there's a 200px native-pixel
margin baked into the canvas around both images so alignment drags don't
push either frame off the visible canvas.

**Holding Space resolves that tradeoff instead of working around it — a
plain click-drag still means "align," but Space+drag unambiguously means
"move the crop," anywhere on the canvas, corner handle or not.** Checked
first in `pointerdown` (and mirrored in `updateAlignHoverCursor` for the
`'move'` vs `'grab'` cursor), so it overrides hit-testing entirely rather
than only applying when the crop body happens to be under the pointer.
`state.drag.kind = 'crop-move'` translates `state.crop.x/y` by the drag
delta (`w`/`h` untouched) and runs it through the existing
`clampCropToOverlap()` — the same function already used to keep a resized
crop inside the overlap, since a same-size reposition needs exactly the
same clamping, just never triggers the width/height-shrinking branch. The
Space listener is on `window`, not the canvas, gated on a
`pointerOverAlignCanvas` flag (set by the canvas's own `pointermove`/
`pointerleave`) rather than needing the canvas to already have keyboard
focus — and on the active element not being a text input, so it doesn't
swallow a literal space typed into e.g. the animation-order textbox, and
doesn't hijack normal page-scroll-by-space when the user's spacebar-
scrolling with the mouse elsewhere. A drag's kind is fixed at `pointerdown`
time; releasing Space mid-drag doesn't retroactively change what an
already-started `crop-move` drag is doing, matching how e.g. `crop-resize`
already commits to one handle for the drag's whole duration.

**"Lock alignment" (`state.alignmentLocked`, the checkbox in
`#crop-ratio-section`) makes a plain drag behave like Space was already
held, everywhere a plain drag is checked.** It's a second, sticky way to
get "drag moves crop" without holding a key down — requested specifically
because dragging without remembering to hold Space was a common mistake.
`pointerdown`'s and `updateAlignHoverCursor`'s conditions both changed from
`spacePressed && ready` to `(spacePressed || state.alignmentLocked) && ready`
— Space and the lock aren't exclusive, just two ways to reach the same
state, so holding Space while also locked changes nothing. Corner handles
still always resize regardless of either (checked first, before the
space-or-lock branch). Locked but still in `'stepping'` mode (no crop rect
exists yet to move) is a deliberate no-op on `pointerdown` — there's
nothing sensible for a plain drag to do there, so it's just ignored rather
than erroring.

**Single-level undo (`undoBtn`, `captureUndoSnapshot`/`performUndo`) —
scoped tightly to the actual complaint, not a general history stack.**
Requested for the same "dragged without pressing Space" mistake the lock
checkbox addresses from a different angle: one snapshot of
`state.frames[].dx/dy` + `state.crop`, taken right before *any*
align-drag, crop-resize-drag, crop-move-drag, or nudge (`captureUndoSnapshot`,
called from all four of those, both from `pointerdown` and from
`nudgeAlign` itself so the on-screen nudge pad and the keyboard arrow keys
share the exact same capture point). Each capture **overwrites** the
previous one — only the most recent of those four action kinds can be
undone, not an arbitrary number of steps back. This is a real, intentional
scope decision, not a missing feature: a full undo/redo stack would need
tracking far more than just frame offsets and crop (order, adjustments,
crop ratio...) to be consistent, and the actual request was specifically
about recovering from one accidental drag, not general history. The
button is disabled whenever there's nothing to undo and re-disables itself
after a single use (`performUndo` clears `undoSnapshot` and can't be
chained into "undo the undo").

**The magnifier now always shows *something* — centered on frame 0 by
default, hover position while the pointer's over the canvas — rather than
appearing only while focused and disappearing otherwise.** This replaced
the previous focus-gated, hide-on-blur behavior outright, not just a
default-value tweak: `maybeDrawMagnifier` no longer checks
`document.activeElement === alignCanvas` at all (every hover now draws,
regardless of focus), and every previous `hideMagnifier()` call site (drag
end, pointer leaving the canvas, blur, a fresh upload, selecting a
different frame to align) now calls `resetMagnifierToDefault()` instead —
same call sites, same "go back to a neutral view" intent, just showing
`magnifierDefaultNative()` (`{x: state.W/2, y: state.H/2}`, frame 0's
center) through the exact same `drawMagnifier` used for hover, rather than
clearing the canvas. `resetMagnifierToDefault` guards the one case where
clearing is still actually correct — no frames loaded at all yet (e.g.
right after `reset()`), when there's nothing to draw a zoomed view *of*.

**A plain click on the align canvas (pointerdown+pointerup with barely any
movement between them) sets the magnifier's resting position to the clicked
point, instead of performing a no-op zero-distance align/crop-move.**
`endAlignCanvasDrag` measures `Math.hypot(...)` between the pointerdown and
pointerup client coordinates and treats anything under
`CLICK_MOVEMENT_THRESHOLD = 4` (CSS px) as a click rather than a drag —
except on a corner handle (`kind === 'crop-resize'`), where even a
no-movement press is a deliberate grab of that handle, not a "point at
something" click, so it's excluded. A genuine click writes the clicked
point (converted through the existing `clientToCanvasXY`/`fromAlignCanvasXY`
helpers, no new coordinate math) into `state.magnifierDefaultOverride`;
`magnifierDefaultNative()` returns that override when set, falling back to
frame 0's center (`{x: state.W/2, y: state.H/2}`) only while it's `null`.
Because nothing actually changed on a click, the undo snapshot
`captureUndoSnapshot()` already took at pointerdown is discarded
(`undoSnapshot = null; undoBtn.disabled = true;`) rather than left around as
a no-op undo entry. `state.magnifierDefaultOverride` is reset to `null` in
both `load()` and `reset()`, matching every other per-session alignment
state, so a fresh upload always starts back at frame 0's center rather than
inheriting a click position from a previous session's image geometry.

**Arrow-key nudging requires the canvas to actually be focused —
deliberately, after two broader alternatives were each tried and rejected
for real, reported reasons, not assumed.** The natural instinct is to
widen this (a canvas-scoped `keydown` listener only fires while the canvas
itself holds focus, and focus moves away from it constantly — clicking a
slider, typing in the order textbox — so requiring a click back onto the
canvas first reads as pure friction), and two widenings were tried in that
order: (1) a `window`-level listener gated on `pointerOverAlignCanvas`
(hover) OR focus, mirroring how Space-to-move-crop disambiguates — reported
back as unreliable, arrows only reliably worked after an explicit prior
click, hovering alone often didn't register; (2) fully unconditional (any
arrow key, anywhere on the page, the instant frames are loaded, gated only
on not typing in a text/number field) — reported back as confusing and
error-prone, arrow keys doing something regardless of where the user's
actual attention is isn't an acceptable trade just to skip one click.
Landed back on plain focus-required — `alignCanvas.addEventListener('keydown', ...)`,
no window-level listener, no `isArrowNavTarget` helper needed since a
focused canvas can't simultaneously be a focused text input — because
that's both the simplest implementation and the one combination already
confirmed to work reliably: click the canvas once (a low-cost action this
app's click-vs-drag threshold already treats as a no-op elsewhere — see
`magnifierDefaultOverride` above) to turn arrow keys on, and any ordinary
focus change turns them back off. If a future report asks for less
friction again, the fix is NOT to re-loosen this gate — dig into why the
hover signal itself was unreliable first, since both rejected attempts
failed for reasons unrelated to how tight the gate was.

**`nudgeAlign`'s post-nudge magnifier refresh is unconditional, not gated
on `lastHoverNative`.** It used to only call `maybeDrawMagnifier`
`if (lastHoverNative)` — fine as long as nudging could only ever happen
while hovering, but keyboard nudging only requires the canvas to be
*focused* (see above), not hovered: click the canvas, then move the mouse
away without ever un-focusing it, and every arrow-key press after that
left the magnifier showing stale, pre-nudge content under the old
conditional. The magnifier's zoomed view is a crop of the frame pixels
themselves, so *any* alignment change invalidates it regardless of mouse
position — `nudgeAlign` now always calls `drawMagnifier(mx, my)` with
`currentMagnifierLookNative()`'s result (the same tracked point the
crosshair reads, see below), matching what every other alignment-changing
action (drag, undo) already does.

**A small crosshair on the main align canvas marks exactly where the
magnifier loupe is currently zoomed into.** Without it there was no way to
tell, just by looking at the align canvas, what point the zoomed-in view
off to the side actually corresponded to. `drawMagnifier(nativeX, nativeY)`
— the single function every magnifier-update path already funnels through
(hover, `resetMagnifierToDefault`, a post-nudge refresh) — now also stores
that point into `magnifierLookNative`, a tracked variable rather than a
value recomputed independently for the crosshair; recomputing it
separately (originally tried as `lastHoverNative || magnifierDefaultNative()`)
would have quietly disagreed with what the loupe was actually showing in
one real edge case — blur while still hovering, where
`resetMagnifierToDefault` deliberately forces the default view regardless
of hover state — so the crosshair reads the same tracked value the loupe
itself was last drawn from, guaranteeing the two can never show different
points. `drawAlignmentCanvas()` draws the crosshair last, via
`drawMagnifierCrosshair()`, converting `magnifierLookNative` through the
existing `toAlignCanvasXY` helper — drawn at the *tail* of
`drawAlignmentCanvas()` rather than eagerly inside `drawMagnifier()`
itself, since `drawMagnifier()` only touches the separate magnifier
canvas, and a later `drawAlignmentCanvas()` call mid-drag would otherwise
wipe out a crosshair painted directly onto the main canvas moments
earlier. Because the crosshair now makes the main canvas depend on hover
position, plain hovering (no drag) needed a new `drawAlignmentCanvas()`
call in `pointermove` — previously a hover-only move only ever repainted
the magnifier canvas — and `pointerleave`/`blur` each needed one too,
since `resetMagnifierToDefault()` only ever redrew the magnifier canvas,
never the main one. **Cyan, not black/white, after actually looking at
it:** a plain dark-outline/white-stroke crosshair (the initial version)
all but disappeared against a typical busy mid-tone photo — the same
legibility problem the orange, solid-filled crop handles already solve by
not being a thin line — confirmed by screenshotting a real test photo and
eyeballing it, not assumed; a small `#22d3ee` ring-plus-crosshair (still
with a dark outline pass underneath, for the rare cyan-ish background) is
what actually reads clearly. **Suppressed entirely while actively
hovering** (`drawMagnifierCrosshair` returns immediately if
`lastHoverNative` is set) — the real mouse cursor already marks that exact
point, so the crosshair would just be a redundant, slightly-offset
duplicate sitting on top of it; it earns its keep only once the pointer's
elsewhere (or never moved at all, e.g. right after a keyboard-only nudge)
and nothing else on screen indicates where the loupe is looking.

**The nudge pad (`#nudge-pad`, four buttons below the magnifier) is a
touch-accessible equivalent of the arrow-key shortcut, not a separate
implementation — phones have no keyboard, so 1-native-px-per-press fine
alignment would otherwise be unreachable on mobile.** Each button's click
handler just calls `nudgeAlign(ddx, ddy)` directly, the exact same
function the keyboard listener already called — same 1px step, same
`clampAlign`, same lock-guard, same undo-snapshot capture, automatically,
with no new logic of its own. `nudgeAlign` already no-ops while
`state.alignmentLocked` is true (locking means a plain drag moves the crop,
not alignment — see below), but the buttons stayed clickable-looking despite
doing nothing; `updateNudgeButtonsAvailability()` now sets `.disabled` on
all four to match, called from the lock checkbox's `change` handler and from
`load`/`reset` (so a fresh upload always starts with them enabled, same as
the checkbox itself starting unchecked).

**The crop rectangle is clamped inside `cropBoundsRect()` — normally the
overlap, but the whole canvas when "Allow crop outside photos" is on.**
`state.crop` is kept within whatever that one function returns, enforced by
`clampCropToOverlap`/`clampResizeCrop` after every alignment or crop change.
`clampAlign` also prevents the overlap itself from shrinking below 30% of
the frame in either axis (checked pairwise against the fixed anchor frame,
not the live N-way intersection — an accepted simplification).

**"Allow crop outside photos" (`state.allowCropOutside` + `state.fillColor`,
the checkbox and color picker in `#crop-ratio-section`) is a one-line change
to where the crop may live, not a parallel crop mode.** Every clamp already
funnelled through a single "what rect must the crop stay inside" lookup, so
the whole feature is `cropBoundsRect()` returning either
`currentOverlapRect()` (off, the original behavior) or the frame bounds
grown by `ALIGN_MARGIN_NATIVE` on all four sides (on). That second rect is
deliberately *exactly* the region the align canvas already draws — the
canvas has always been `state.W/H + ALIGN_MARGIN_NATIVE * 2` (200px per
side, long predating this feature, originally so alignment drags couldn't
push a frame off-canvas) — so the crop can be dragged anywhere actually
visible and never somewhere off-screen it couldn't be grabbed back from.
`currentOverlapRect()` itself is unchanged and still drives the green
dashed outline, which keeps meaning "fully-covered area" — more useful than
ever once the crop may leave it. Toggling the checkbox off just re-runs
`clampCropToOverlap()` against the now-smaller bounds, which is already
exactly "pull an out-of-bounds crop back in" — no separate restore path.

**Filling outside-the-photo areas can NOT rely on `drawImage`'s own source
clipping — Chromium and WebKit genuinely disagree, and this was a real bug
caught by a cross-engine test, not a hypothetical.** The spec says a source
rect extending past the image is clipped with the destination clipped
*proportionally*; Chromium does that, but WebKit instead **stretches** the
clipped source to fill the entire destination — so the photo silently
scaled up to cover the whole frame and the fill was never visible on
WebKit, while Chromium looked perfect. `drawImageClipped` therefore
computes the source∩image intersection and the matching destination
sub-rectangle by hand, which is engine-independent. `drawFrameRaw` keeps a
fast path (a single plain `drawImage`, byte-identical to before) whenever
the source rect is fully inside the image — always true unless this option
is on — so the default path gained no new float math that could perturb
existing output. **A first probe of this behavior was misleading and nearly
shipped the bug**: it used a source rect overhanging on all four sides,
which both engines handle identically; only a one- or two-sided overhang
diverges. If you re-probe this, overhang on exactly one side.

The fill itself is painted in `drawOrderEntry` — the single dispatcher every
preview and export path already goes through — so it covers real frames,
cached optical-flow frames, and the rigid fallback with one `fillRect`, and
is skipped entirely while the option is off (every pixel is guaranteed
covered then, so filling would be wasted work on every preview frame).
`drawCroppedFrameToCanvas` fills too, which matters more than it looks:
that canvas is what optical flow is computed *from*, and transparent pixels
outside the frame would otherwise feed garbage into the flow field at the
crop's edges.

**Crop aspect-ratio lock (`state.cropRatio`, the "Crop aspect ratio" radio
group) reuses the same clamp functions rather than being a separate code
path.** The radio group itself lives in its own `#crop-ratio-section`,
positioned directly above the align canvas (not inside `#crop-export-panel`,
where the rest of the crop/preview/export UI lives) so it reads as part of
setting up the crop before looking at the canvas — but it's still gated by
the exact same `ready`-mode visibility flag as `#crop-export-panel` in
`applyModeVisibility` (`cropRatioSectionEl.hidden = !ready`), just a
separate element toggled alongside it, since picking a ratio before a crop
rect even exists wouldn't make sense. `clampResizeCrop` computes an anchor point (the corner opposite the
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

**Animation order (`state.order`/`state.baseOrder`, `#order-section`).** A
validated, comma-separated 1-indexed text field (`#order-input`,
`parseOrder`/`formatOrder`) drives `state.baseOrder` — 0-indexed positions
into the current *vocabulary* (see below; just real frame indices when
interpolation is off, which is all `defaultOrder`/`parseOrder` have ever
known or needed to know about); `defaultOrder(n)` produces a pendulum
bounce (`[0..n-1, n-2..1]`, which is `[0,1]` — i.e. today's old plain
alternation — when `n===2`, and `[0,1,2,3,2,1]` → displayed as
`"1,2,3,4,3,2"` when `n===4`). `generateGif`/`generateWebp`/`generateMp4`/
the live preview loop all loop over `state.order` (==
`resolveOrder(state.baseOrder, frameVocabulary())`, see below) calling
`drawOrderEntry(ctx, entry, ...)` once per entry, instead of the old two
fixed calls. `buildAnimatedWebp` needed zero changes to support any of
this — it already accepted an arbitrary-length frame array.
`#order-section` itself is shown whenever `frameCount() > 2` (as before) OR
`state.interpolationCount > 0` (new) — a 2-frame set has nothing worth
customizing about its order until interpolation makes the sequence longer
than a plain flip, at which point editing it becomes useful there too.

**The sequence strip (`#order-sequence-strip`, `renderOrderSequenceStrip`)
shows every entry of `state.order` as a small thumbnail, not just the raw
typed numbers.** Real frames use the frame's own `<img>` source; interpolated
entries, once `getInterpolatedCanvas` has actually computed them, get their
own fresh `<img>` via `canvas.toDataURL()` on a *copy* — never the cached
canvas element itself, since the same `{a,b,t}` cache key inserted directly
as a live DOM node could only ever live in one place at a time, and a
repeated transition (not uncommon in a pendulum) would silently yank it out
of an earlier thumbnail. Interpolated thumbnails get an always-visible
"Interpolated" badge (unconditional — unlike the alignment strip's
`.thumb-badge`, which is gated on a `.confirmed` class that doesn't apply
here). Every thumbnail's number label is simply `state.baseOrder[i] + 1` —
the entry's own vocabulary position (see below), the exact same consecutive
numbering the order textbox uses, not something derived from the entry's
content — so a real frame and the interpolated frame right after it are
labeled with plain consecutive integers like any other pair, matching what
you'd type. Re-rendered on every `state.order` reassignment (so it always
matches what would actually export) and again once
`scheduleInterpolationPrep`'s background pass finishes, so interpolated
thumbnails upgrade from an empty placeholder box to the real blended content
the moment it's ready — the same progressive-enhancement pattern the actual
rendering path already uses. **Defensively skips any entry referencing a
frame index that doesn't exist** (`state.frames[i]` missing) rather than
throwing — this is a real, reachable case, not paranoia: `applyInterpolation(0)`
resets the slider inside `load()` *before* that function has rebuilt
`state.baseOrder`/`state.order` for the newly-uploaded images, so a
just-replaced, now-oversized `state.order` briefly exists pointing at frames
that no longer are there. (`load()`/`reset()` also now explicitly clear
`state.baseOrder`/`state.order` up front, belt-and-suspenders alongside the
per-entry guard.)

**Interpolated (tweened) frames — real optical flow (OpenCV.js), with a
rigid shift+crossfade fallback.** The "Interpolated frames" slider
(`state.interpolationCount`, 0–10, any frame count) controls `k`,
synthesized in-between frames inserted between every consecutive pair of
real frames — `withInterpolation(order, k)` does the actual insertion,
producing entries of the form `{a, b, t}` (`t` strictly in `(0,1)`)
interleaved with the existing plain frame-index numbers.

**The animation-order textbox addresses interpolated frames as plain
consecutive numbers, not a separate notation — this needed a real
rearchitecture, not just a formatting change, and replaced an earlier
version of this feature that auto-inserted interpolation invisibly.**
`frameVocabulary()` (`withInterpolation(range(0, frameCount()), k)`, i.e.
real frames in their natural 0..N-1 order with `k` interpolated frames
spliced between each pair) is the fixed "address space" the order textbox's
numbers index into: for 2 real frames and `k=1`, "1,2" (the real frames)
becomes vocabulary "1,2,3", where 2 *is* the interpolated frame — matching
exactly what was asked. `state.baseOrder` changed meaning to match: it's no
longer "real frame indices," it's 0-indexed *vocabulary positions*, and
`state.order` is `resolveOrder(state.baseOrder, frameVocabulary())` —
`state.baseOrder.map(i => vocabulary[i])` — looking each one up to get the
real-number-or-`{a,b,t}` entry `drawOrderEntry` actually knows how to draw.
`parseOrder`/`formatOrder` themselves are unchanged; only what `n` and the
indices they produce/consume *mean* changed — they now operate against
`frameVocabulary().length`, not `frameCount()`.

Because the vocabulary already interleaves interpolated frames with real
ones, `defaultOrder`'s plain pendulum formula — which knows nothing about
interpolation, never modified — naturally produces a fully-smoothed
pendulum with zero extra logic: `defaultOrder(vocabulary.length)` for 2
real frames + `k=1` (vocab length 3) is `[0,1,2,1]`, i.e. real1 →
interpolated → real2 → interpolated again (the *same* interpolated frame,
reused for the return leg exactly like real frames already were reused in
the old N>2 pendulum — a symmetric blend has no inherent "direction" to get
wrong). **This sidesteps a real, previously-fixed bug for free — worth
knowing precisely because the earlier fix (`closeLoopForInterpolation` +
popping a redundant trailing entry) is GONE, not superseded by something
equivalent**: with the old "auto-insert invisibly" design,
`state.baseOrder` was real-frame-only and closing the loop for a smooth
return leg meant literally appending `baseOrder[0]` back onto the end,
which made the array start and end on the exact same frame — looked right
in isolation, but since `state.order` is played as a *loop*, that shared
frame rendered TWICE in a row right at the wrap point (reported as "does
two frames on last frame"), needing an explicit pop of the redundant
trailing entry to fix. In the vocabulary model, `defaultOrder`'s backward
segment already stops one element short of vocabulary index 0 (by
construction — same formula as always), so the last entry is never equal
to the first and looped playback was never a duplicate to begin with. If
you touch either function, that invariant (`defaultOrder(n)`'s last element
`!== ` its first, for `n > 1`) is what to preserve.

**Changing the interpolation count resets the order to the new default
rather than trying to reinterpret a custom typed order against the new
vocabulary.** A different `k` means a different vocabulary — the SAME
typed number can refer to a completely different frame before vs. after
(e.g. "3" is real-frame-2 at `k=1` for a 2-frame set, but an interpolated
frame at `k=2`) — translating a custom order's meaning across that shift
isn't generally well-defined, so `resetOrderToDefault()` (used here, on
first reaching ready mode, and by the explicit "Reset to default" button —
one shared function, three call sites) just resets to
`defaultOrder(newVocabulary.length)` and lets the reset be obvious rather
than silently reinterpreting numbers the user didn't intend.

`drawOrderEntry` is the
single dispatcher every consumer of `state.order` goes through: a plain
number still means "draw this real frame" exactly as before (so
`state.interpolationCount === 0`, the default, is byte-for-byte identical
to pre-interpolation behavior); an `{a,b,t}` object draws a cached
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
on `t`, using a **quality-tuned parameter set, not OpenCV's plain
defaults** — `levels=5, winsize=21, iterations=7, poly_n=7, poly_sigma=1.5,
OPTFLOW_FARNEBACK_GAUSSIAN` (vs. the tutorial-default `3, 15, 3, 5, 1.2, 0`):
more pyramid levels and iterations for better convergence on this app's
typically-large parallax offsets, `poly_n`/`poly_sigma` bumped together per
OpenCV's own docs (they're paired — raising one without the other hurts
quality), and the Gaussian-window flag for cleaner motion boundaries than
the default box-filter averaging. **`DISOpticalFlow` (generally
higher-quality than Farneback) was investigated and ruled out, not just
skipped** — its JS bindings aren't exposed in prebuilt opencv.js, confirmed
by checking both `@techstark/opencv-js` (what's actually used) and the
official `docs.opencv.org/4.x/opencv.js` build in a real browser: `typeof
cv.DISOpticalFlow_create` is `'undefined'` on both, even though `DISOpticalFlow`'s
preset *constants* (`DISOpticalFlow_PRESET_FAST` etc.) leak through as
globals — the class itself just isn't in either build's bindings
whitelist. Getting it would need a custom Emscripten compile of OpenCV
from source, which is out of scope here; if flow quality needs another
jump beyond parameter tuning, the next real option is a neural model
(RIFE via onnxruntime-web was discussed) — a much bigger lift, a second
dependency, and slower per-frame than Farneback, not a drop-in swap.
`getInterpolatedCanvas(a, b, t)` builds the actual in-between frame
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

**`loadOpenCv()` has a 30s timeout, and a failure is never cached
permanently — both specifically for phones on real mobile networks, not
just desktop-testing hygiene.** A 13MB download can legitimately take a
while on slow/cellular connections, but with no timeout at all, a
connection that *stalls* (rather than cleanly erroring, which
`script.onerror` already handled) would leave "Preparing optical-flow
interpolation…" stuck forever with no fallback ever kicking in —
`OPENCV_LOAD_TIMEOUT_MS` rejects after 30s so the existing rigid-fallback
path still kicks in either way. Separately, `cvReadyPromise` (the
memoized load promise) is reset to `null` in a `.catch()` on any failure —
timeout or otherwise — rather than permanently caching the rejection: a
transient network hiccup shouldn't lock the rest of the session out of
real optical-flow interpolation forever, so the *next* time interpolation
prep runs (the user nudges the slider again, or `generateOutput` awaits
preparation before export) this retries a fresh load rather than replaying
the same rejected promise. Verified concretely via Playwright route
interception simulating a stalled connection, not just reasoned about:
confirmed the 30s timeout actually fires (not instant, not never) and
falls back correctly, and that a later attempt (once the simulated network
recovers) really does issue a brand-new request and succeeds — the first
attempt at verifying this hit two test-harness artifacts worth knowing
about if you touch this code: (1) piling up multiple *simultaneously*
stalled requests to the same host in a test doesn't behave like a real
stalled TCP connection — the OS/network stack eventually resets a real
one, freeing the browser's per-host connection slot, but an unresolved
`Promise` in a Playwright route handler holds that slot forever, so a
later legitimate request can end up queued behind ones that will never
complete; test one stalled request at a time. (2) A test's own
wait-condition can trivially self-satisfy on *stale* status text left over
from a previous attempt (e.g. `status.includes("Couldn't load")` is
already true going into a second attempt if the first one's failure text
was never cleared) — clear it explicitly before waiting on the same
condition again, or the test passes without ever having waited for the
real thing to happen.

**Mobile platform coverage was verified via Playwright's device emulation
(WebKit + an iPhone profile for iOS Safari, Chromium + a Pixel profile for
Android Chrome), not just desktop browsers** — both produced genuine,
ghost-free optical-flow interpolated output. Worth being honest about the
limits of that verification, though: Playwright's `webkit` is a modern
*desktop* WebKit build (version 26.x at the time this was checked), not
literally iOS Safari — it shares the same JS/rendering engine and is a
reasonable proxy for API-level compatibility (WASM support, Canvas
behavior), but doesn't replicate a real iPhone's actual memory ceiling or
gate on the *device's* real WebKit version the way a genuine minimum-iOS
version check would. The emulated device's UA string can claim an old iOS
version while the underlying engine is actually current — Playwright only
fakes the UA/viewport/touch, not the engine build — so this can't verify
behavior on a real OLD iOS Safari (e.g. pre-16.4, before WASM SIMD, which
this OpenCV.js build likely needs). If that ever needs confirming for
real, it needs an actual older device or a matching real-Safari test lab,
not device emulation. Either way, the rigid-technique fallback (see above)
means an incompatible/old browser degrades gracefully rather than
breaking — this was already true before this round of hardening, just
worth restating here since it's the actual answer for genuinely
unsupported devices, not something the timeout/retry work changes.

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

**Sharpness (`state.adjust.sharpness`, the "Sharpness" slider) is a
separate pass from `applyPixelAdjustments`, not another term in it — it
genuinely needs neighboring pixels, unlike brightness/contrast/hue/grayscale/
sepia, which are all pure per-pixel formulas with no neighbor access.**
`applySharpen(imageData, amount)` runs a standard 5-point-Laplacian sharpen
convolution — `center*(1+4k) - k*(sum of the 4 orthogonal neighbors)`,
where `k` is `amount/100 * 2` — reading from a `Uint8ClampedArray` snapshot
taken before writing any output pixels. That snapshot matters: convolving
in place would let already-sharpened neighbor values leak into later
pixels' kernels along each scanline, compounding the effect unevenly
instead of applying it uniformly. Runs *before* `applyPixelAdjustments` in
`applyDestAdjustmentsAndTint`, both inside the same single
`getImageData`/`putImageData` round trip — sharpening the raw source first
means brightness/contrast/hue then act on the sharpened result the same as
they would on any other source, rather than amplifying edges that
brightness/contrast already pushed around. Like every other adjustment
here, it's manual pixel math for the same WebKit `ctx.filter` reason
above — there's no native canvas "sharpen" filter to fall back to even on
engines that do support `ctx.filter`, so this was always going to need
hand-rolled pixel math regardless. Wired through the exact same
`linkSliderWithNumber`/`applyBrightness`-style pattern as brightness/
contrast/hue (`applySharpness`, reset to 0 in `load()` alongside the
other three), and — because it lives in `applyDestAdjustmentsAndTint`,
not a separate draw call — automatically applies everywhere brightness/
contrast/hue already do: live preview, GIF/WebP/MP4 export, and both real
and rigid-fallback interpolated frames, with zero extra call sites needed.

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

**MP4 length is a target, not one pass over `state.order` (`state.videoLengthSeconds`,
the "Video length" box, default 3 s, kept across re-loads like fps).** GIF/WebP
loop on their own, but an MP4 of one cycle is often a fraction of a second
(2 frames at 8 fps = 0.25 s), which most players and apps (Instagram needs
≥ 3 s) don't loop nicely. `mp4CycleCount` repeats *whole* cycles until the
target is reached — rounding up, so the file itself still loops seamlessly.
Frames are redrawn per cycle rather than cached as `VideoFrame`s (memory
would scale with order length × resolution); the loop throttles on
`encodeQueueSize` and inserts a keyframe every ~2 s.

**Result sharing.** "Share…" (`navigator.share` with the file) is shown only
when `navigator.canShare({files})` says yes — mostly mobile/Safari. "Copy" is
shown only when `ClipboardItem.supports(type)` exists and returns true:
Chromium's clipboard accepts only `image/png`, so an animated GIF/WebP/MP4
can't be copied there and the button stays hidden rather than failing on
click. Ctrl/Cmd+Z triggers `performUndo` (window-level, skipped while a
text/number field is focused so those keep native undo).

**Multi-file upload (`app.js`).** Every file input has `multiple`; several
files picked or dropped onto frame box *i* fill boxes *i, i+1, …* in
natural filename order (`IMG_9` before `IMG_10`) and commit once. Several
files on the big MPO box are treated as separate frames from frame 1.
Extra files beyond `MAX_FRAMES` are dropped with a note in the status line.

The result
`<img>` can't display a video, so `#output-video` is a separate `<video
controls loop muted>` element that `generateOutput` shows/hides opposite
`#output-gif` based on the returned `extension`.

**Output scale is independent of crop.** The crop rect defines the *source*
region in native pixels; the "Output scale" slider only changes the
*destination* size frames are drawn into at export time (`computeOutputSize`).
Dragging/resizing the crop never touches this.

**`state.outputScalePercent` is the sole source of truth for output size,
and it's kept at full float precision, unclamped below 10% — the % slider/
box are a deliberately coarse, rounded-to-whole-percent, [10,100]-clamped
*display* of it, never written back into it.** This was a real bug, not a
style choice: an earlier version (`scalePercentForWidth`) computed the width
textbox's percent with `Math.round()` and then clamped it into the slider's
own `[10,100]` range before ever reaching `state`, so a requested width that
didn't land on an exact whole percent — or was under ~10% of the crop width
— silently snapped to whatever the nearest representable percent produced
instead of the width actually typed. `setOutputWidthPrecise(desiredWidth)`
now writes `(desiredWidth / state.crop.w) * 100` straight into
`state.outputScalePercent` (only clamped to `<=100`, since upscaling past
the crop's native resolution isn't supported — `computeOutputSize`'s own
`Math.max(1, ...)` is what prevents a literal 0px result), so any pixel
width is exact, including ones under 1% of the crop or between two whole
percents. `updateOutputSizeLabel` still resyncs the width textbox to
`computeOutputSize().w` after any change to either scale or crop, and
separately resyncs the %-slider/box to `state.outputScalePercent` rounded
and clamped into `[10,100]` for display only — neither resync writes back
into `state.outputScalePercent`, so typing a precise width followed by
touching the % slider is the only thing that ever coarsens it (that's
`applyScale`'s job, and is the expected way to opt back into whole-percent
granularity). `enterReadyMode` applies this once as the *default*, calling
`setOutputWidthPrecise(DEFAULT_OUTPUT_WIDTH)` with `DEFAULT_OUTPUT_WIDTH =
1080` — same one-time-default treatment as brightness/contrast/hue already
get, not a continuously-enforced constraint.

**No build step, on purpose.** Keep it a plain static site — if a dependency
is needed, vendor its files into `web/lib/` (as done for gif.js and
mp4-muxer.js) rather than introducing npm/bundlers.

**The site is always dark (black background, white/gray text) — not
conditional on the visitor's system preference.** `style.css`'s `:root`
used to define a light palette plus a `@media (prefers-color-scheme: dark)`
override; per explicit request it's now just one unconditional dark
palette (`--bg: #000000`, `--fg: #f0f0f0`, `--muted: #a8a8a8`, `--border:
#3a3a3a`, `--accent: #60a5fa`, carried over from the old dark override
values, just applied unconditionally) and `color-scheme: dark` (not `light
dark`) so native form controls — range sliders, radio buttons, checkboxes,
number-input spinners, the file-picker button — render with the browser's
own dark styling too, not just the custom-styled elements. This "just
works" with effectively zero other CSS changes because every rule in this
file already routed color through `var(--bg)`/`var(--fg)`/`var(--muted)`/
`var(--border)`/`var(--accent)` rather than hardcoding light-mode colors
anywhere — the align/preview/magnifier canvases already had an explicit
`background: #000` for unrelated reasons (matching the letterboxing around
non-matching-aspect-ratio frames) so they needed no change at all to blend
into the new page background. Verified by forcing Playwright's browser
context to `colorScheme: 'light'` and confirming the page still renders
fully black/white regardless — proof it's truly unconditional, not
accidentally still gated on the media query.

**Link previews.** `index.html` carries Open Graph + Twitter-card meta tags
pointing at `web/og-image.png` (1200×630, absolute URL on
`wiggle.maxonline.se` — crawlers don't resolve relative `og:image`). The PNG
is rendered from `og/og-image.html` (outside `web/`, so not deployed) by
screenshotting it at exactly 1200×630 with Playwright; edit the HTML and
re-render rather than editing the PNG. If the domain changes, update
`og:url`/`og:image`/`twitter:image` too.

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

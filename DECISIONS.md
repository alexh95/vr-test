# Decisions

Why Skyreach is built the way it is. Each entry: the choice, what else was on the table, and why.
Written 2026-10-15 alongside the first version.

---

## 0. The facts that drove everything (Steam Frame, October 2026)

| Fact | Consequence |
|---|---|
| The Frame's **stock browser has no WebXR** yet (reviewers checked; the Flathub Chromium on SteamOS sees `navigator.xr` but `isSessionSupported('immersive-vr')` is `false` because upstream Chromium only wires OpenXR on Windows and Android) | The reliable way to run *browser* VR on the Frame today is **streaming from a PC**: desktop Chrome/Edge → OpenXR → SteamVR → Frame |
| A **community Chromium build** with Linux OpenXR patches runs immersive WebXR natively on the Frame (`saphid/chromium-webxr-steam-frame`; 72 fps, no haptics, no WebXR layers, controllers reported as `oculus-touch`, seccomp sandbox disabled) | Support it as a secondary, experimental path: serve over HTTPS on the LAN, keep a low-quality preset for the mobile GPU |
| Frame controllers: sticks, triggers, grips, face buttons/D-pad, **capacitive touch on every control**, per-hand haptics. **No camera hand tracking.** SteamVR maps them onto an **Oculus Touch** binding when an app (like Chrome) doesn't know the Frame profile | Use the generic `xr-standard` gamepad mapping (trigger, squeeze, stick, A/B), feature-detect touch and haptics, and never depend on face buttons for core actions |
| 2160×2160 per eye, 72–144 Hz, Snapdragon 8 Gen 3 standalone | Frame-rate-independent simulation (fixed physics step + interpolation), a draw-call budget, and a low-quality tier |
| Eye tracking drives foveated *streaming* but isn't exposed to WebXR | Nothing to do on our side |
| This PC already has **SteamVR as the active OpenXR runtime** and Chrome + Edge installed | Path A works with zero setup beyond `npm run dev` |

Sources: [chromium-webxr-steam-frame](https://github.com/saphid/chromium-webxr-steam-frame),
[frame-control WebXR notes](https://github.com/saphid/frame-control/blob/main/docs/webxr-chromium.md),
[Road to VR review](https://roadtovr.com/valve-steam-frame-review/),
[Steamworks: Steam Frame input](https://partner.steamgames.com/doc/steamhardware/steamframe/input),
[Steam Frame (Wikipedia)](https://en.wikipedia.org/wiki/Steam_Frame).

---

## 1. Platform: WebXR in the browser, PC streaming first

- **Chosen:** plain WebXR (`immersive-vr`) with feature negotiation; PC streaming (Chrome/Edge on Windows → SteamVR) as the primary target, the community Chromium build on the Frame as a secondary target.
- **Considered:** waiting for official Frame browser WebXR (no date); a native SteamVR app (not "browser VR").
- **Why:** It's the only path that works today without building Chromium. The same build also runs on any WebXR headset (Quest browser, Pico, Vision Pro with hands), which makes it a fair test of the web stack itself.
- Session features are all **optional**: `local-floor` (falls back to `local` with an assumed 1.6 m eye height), `bounded-floor` (draws the SteamVR chaperone on the virtual floor when offered; the emulator offers no bounds, so this path is untested), `hand-tracking` (SteamVR can derive finger joints from controller capacitive sensing; if it does, the hands follow real finger positions).

## 2. Renderer: three.js (r186, `WebGLRenderer`)

- **Considered:** Babylon.js, A-Frame, PlayCanvas, React Three Fiber + `@react-three/xr`, Meta's **IWSDK**, and Odin → wasm with a hand-written WebXR/WebGL bridge.
- **Why three.js:**
  - The most-used WebXR engine on the web, so it's the best-trodden path through browser and runtime quirks. Its `WebXRManager` handles session/layer/camera plumbing and leaves input, locomotion and interaction to us, which is exactly the part this project wants to own.
  - Low abstraction: every draw call and shader is visible, which matters when the target is "2 × 2160² at 90 Hz, maybe on a phone GPU".
  - **WebGL2, not WebGPU**: WebXR's WebGPU binding is not shipping broadly; the community Frame build runs Chromium's GPU process on ANGLE → zink → Turnip. WebGL2 is the path that works everywhere today.
- **Why not the others:** Babylon is excellent but heavier and more framework-shaped. A-Frame/R3F add a declarative layer we don't need and hide the frame loop. **IWSDK** is good, but it's Quest-oriented and opinionated (ECS, Havok, its own UI), and would have hidden exactly the input/locomotion code we needed to tune for SteamVR's Touch emulation. **Odin** (your usual stack) would mean writing the WebXR, WebGL, input and Web Audio bridges in JS anyway, with slower iteration and no ecosystem. Worth revisiting only for a hot simulation core.

## 3. Language and build: TypeScript 7 + Vite 8

- **Vite** gives instant dev reloads, a static `dist/` that any HTTPS host can serve, and `--mode lan` for a self-signed HTTPS dev server (WebXR needs a secure context; `localhost` counts as secure, a LAN IP doesn't).
- **TypeScript 7** (the native compiler) is only used to type-check (`npm run typecheck`, about a second). Vite strips types itself.
- Exact versions are pinned (`--save-exact`): `three@0.186.1`, `@dimforge/rapier3d-compat@0.21.0`, `vite@8.3.4`, `typescript@7.0.2`, `iwer@2.6.0`.

## 4. Physics: Rapier (wasm, `rapier3d-compat`)

- **Considered:** cannon-es (pure JS, older, weaker stacking), ammo.js (Bullet via emscripten, awkward API, big), Havok (fast, but heavier integration), hand-rolled physics.
- **Why Rapier:** stable stacking (the can pyramid and block tower need it), CCD for fast throws, cheap scene queries for teleport arcs, gloves line-of-sight and ground following, contact-force events for impact sounds, compound colliders, and a clean JS API.
- **Fixed 120 Hz step with interpolation.** The Frame runs at 72–144 Hz; physics must not change with refresh rate. Held objects are kinematic and drawn exactly at the hand (no interpolation lag). Released objects get the hand's velocity *at the object's position* (`v + ω × r`), so flicks and spins carry through.
- **Trade-off:** the compat build inlines the 3.1 MB wasm as base64 (most of the 1.85 MB gzipped bundle) in exchange for zero bundler setup. If download size starts to matter, switch to `@dimforge/rapier3d` + `vite-plugin-wasm`, which serves the wasm as a separate, streamable file (~0.4 MB smaller gzipped).

## 5. Input: our own XR input layer (not three's controller helpers)

- `src/input/xr-input.ts` reads `XRFrame` poses directly: grip and aim poses, hand joints (`fillPoses`), xr-standard buttons with **hysteresis and per-frame edges**, capacitive `touched` states, and **throw velocity** (the runtime's `XRPose.linearVelocity` when present, which not every runtime provides; otherwise least-squares over the last ~85 ms).
- **Why:** once you ask three for hands (`getHand`), its controller code stops updating the grip pose whenever joints are present (a problem if SteamVR exposes controller-driven skeletons), and it gives no velocities, edges or haptics fallbacks.
- **Haptics:** `hapticActuators[0].pulse()` with a `vibrationActuator.playEffect('dual-rumble')` fallback, wrapped in try/catch. The community Frame build reports no actuators, and on Chrome/Windows it depends on the runtime. The wrist menu's Info page shows what your setup exposes.
- **Grip space done right:** in a power grip the handle crosses the palm diagonally, so the hand is modelled in a "hand frame" and tilted 40° into WebXR grip space. That makes an extended index finger point along the aim ray and puts the cuff on the forearm. Found by rendering the hand against a stand-in controller handle; the first, spec-literal version had the fingers pointing at the floor.

## 6. Hands: procedural skinned gloves, driven by capacitive touch

- **Chosen:** a procedural, skinned glove (one draw call per hand) whose fingers follow the controller: index curls with the trigger and **straightens when you lift your finger off it** (touch), the other three wrap around the grip when touching it, and the thumb rests or lifts with the stick/face-button touch. If the runtime provides articulated joints, finger angles come from measured joint positions instead.
- **Considered:** WebXR Input Profiles controller models (`XRControllerModelFactory`).
- **Why not controller models:** they'd download from a CDN at runtime, and with SteamVR's Touch emulation they'd show **Quest controllers on a Steam Frame**. Hands that react to capacitive sensing are also simply the better VR experience (the Index lesson).

## 7. Interaction design

| Feature | Why it's there (what VR does that a screen can't) |
|---|---|
| Grab, throw, swat | Physicality: your real arm's velocity becomes the object's. Swatting only turns on for fast empty-hand motion, so slow reaches don't shove things away |
| **Gravity gloves** (point, grip, flick) | A Valve-native mechanic (Half-Life: Alyx). Ballistic solve so the object lands in your hand, catch window, haptic hum while locked |
| Light brushes | Drawing in 3D space is the canonical "only in VR" creative act; ribbons follow wrist roll and trigger pressure |
| Marimba (C pentatonic) | Proprioception and timing: velocity-sensitive strikes from mallets, fingertips, or thrown balls. Nothing you play can sound wrong |
| Fireworks | Scale and spatial audio: hold a lit rocket (haptic buzz), watch it climb, hear the boom arrive late because sound travels at 343 m/s |
| Gravity lever, big push buttons | Physical UI you grab or poke, with detents, clicks and haptics |
| Giant mode | Changing your scale relative to the world is pure VR; the rig scales about your head so you don't slide |
| The plank | Heights. You physically walk out over a 40 m drop |
| Wrist menu | Look at your palm. No floating 2D menus in your face |

## 8. Locomotion and comfort defaults

- **Teleport** (right stick forward → arc → release) with a 75 ms blink. Lands only on walkable surfaces with an upward normal, so you can hop the floating stepping stones but never teleport into the void.
- **Snap turn 45°** by default (30° and smooth are options), always rotating about the head so you turn in place.
- **Smooth walking** on the left stick with ground following, an edge guard (you can't walk off the island), and a **comfort vignette** that scales with speed (can be turned off).
- Everything is switchable on the wrist menu, and the choice persists in `localStorage` (try/catch: it still works when storage is blocked).

## 9. Audio: synthesized Web Audio, HRTF-spatialized

- **Every sound is synthesized** (marimba modal partials, tin-can inharmonics, firework noise bursts, fuse sputter, whooshes), placed with HRTF `PannerNode`s, plus a convolution "open air" tail and a quiet generative pad in the same key as the marimba.
- **Why:** no audio assets to license or download, small bundle, and spatial audio is half of presence. The audio context unlocks on the Enter VR click (autoplay policy).

## 10. Content: all procedural

- Islands (noise-shaped tops with vertex-coloured grass, faceted strata undersides), instanced trees/rocks/crystals, sky shader (sun, stars, aurora, moon), cloud sea shader. No textures except canvas-drawn labels.
- **Why:** zero asset pipeline, no licensing, everything editable in code by an agent, a tiny download (apart from Rapier), and a deterministic world (seeded RNG).

## 11. Performance budget

- VR draws everything **once per eye**, so draw calls are the budget that matters. Static props are baked per material at load (`mergeStatic`), rockets and brushes are single vertex-coloured meshes, and scenery is instanced. That cut draw calls from 383 to 224 per frame (emulator, two views) with 122 meshes and ~190k triangles.
- Two quality tiers: **high** (PC streaming: shadows, 2048² shadow map, 6000 particles) and **low** (auto-selected when the user agent says Linux/aarch64, i.e. a browser on the Frame itself: no shadows, framebuffer scale 0.85, fewer particles and cloud octaves). Override with `?quality=low|high` or the wrist menu.
- Points-based particles in one draw call, sized correctly per eye (`projectionMatrix[1][1]` and the current viewport height). Fireflies are animated entirely on the GPU.

## 12. Testing without a headset (the agent loop)

Same philosophy as `game-test`: a mechanical verification ladder the agent can run on its own.

| Tool | What it does |
|---|---|
| `?emulate` | Installs **IWER** (Meta's WebXR emulation runtime) shaped like the Frame as Chrome sees it (Touch profile, 72–144 Hz, floor space). Any desktop browser can "enter VR" |
| `?emulate&selftest` | **33 scripted playtest checks** (21 at first, then 6 archery, 1 laser, 5 skyboat): grab and throw, teleport (and refusing the abyss), snap and smooth turn, walking, gravity gloves, painting, marimba by finger and by thrown ball, fireworks from the hand, console buttons (ray and poke), the gravity lever (things float), wrist menu (ray and poke), giant mode, tracked hands, and no frame errors. One JSON line per check. Runs against the dev server and the production build |
| `window.__vr` | Probe: `state()`, `events()`, `prop(id)`, `snapshot(name)` |
| `window.__driver` | Moves the emulated head and controllers in **world** coordinates, presses buttons, sweeps hands along paths at real frame rate |
| `__vr.snapshot()` | Renders the player's view offscreen and posts it to the dev server → `.snapshots/<name>.png` (works while the page is hidden) |
| `tools/contact-sheet.py` | Tiles snapshots into one image for review |
| Hidden-page frame clock | Browsers pause `requestAnimationFrame` for hidden pages; in emulator mode a worker keeps 72 Hz frames coming, so tests run with the browser pane in the background |

Bugs this loop caught before any human looked: a canvas sized 0×0 by the emulator (NaN cameras), the empty hand batting away what it had just thrown, hovering orbs ignoring the gloves' ballistic solve, flicks firing from the grab motion itself, an MSAA + XR-target readback failure, a desk swallowing its own button labels, mallets rolling off their shelf, z-fighting paint pots, and the 40° hand-frame fix above.

**Not testable here:** real SteamVR + Chrome, the Frame's actual touch/haptics reporting, comfort and feel. Those need you (see the first-run checklist in the README).

## 13. Archery: a two-handed bow and a realistic 2× scope (added 2026-10-16)

**The bow.**
- **Either hand holds it, and that hand aims**: the bow follows the controller's *aim* frame (not the grip
  frame), so a natural "pointing" hold keeps it upright with the arrow forward on any controller.
- **The other hand draws.** Bring it to the string and squeeze (grip *or* trigger: people differ) and an arrow
  nocks. While you draw, the bow rotates to point **from the draw hand through the grip**, keeping the bow
  hand's roll. That's what makes it two-armed: the line between your hands is the shot, as in real archery,
  instead of the arrow following one controller.
- Draw length is measured along that line. Speed is `75 m/s × (draw/max)^0.9`, arrows have gravity and light
  drag, and limbs bend and the string snaps back with a decaying buzz. Haptics: creaks as tension builds, strain
  pulses at full draw, a thump in the bow hand on release.
- Considered: a quiver you reach over your shoulder for. That's realistic but slow to play; auto-nocking when the
  hand reaches the string is the convention of the best VR archery (The Lab's Longbow).

**The scope** (the "bodycam-style" realism you asked for).
- **Picture-in-picture, not a zoomed camera.** A second camera at the lens renders a narrow view into a small
  HDR texture once per frame (mono, 512², about the cost of one extra scene pass while the bow is held). The
  rest of the world stays 1×, and only the glass shows 2×.
- **The image lives at infinity.** The lens shader looks up the picture by each eye's *view direction*, not by
  position on the glass. So it doesn't swim when you move your head, and in VR each eye gets its own correct
  view. Sampling by position would look like a flat sticker.
- **Parallax-free red dot.** The dot is drawn on the optical axis in the same direction space, so wherever your
  eye is, it covers the point the scope is aimed at. It's composited *after* tone mapping so it stays a
  saturated red; an HDR red through ACES blooms to white (caught in a snapshot).
- **Scope shadow from real optics, not a texture.** Light must pass two apertures (the rear lens and the front
  of the tube). When your eye drifts off-axis the front aperture clips the view into the classic dark
  crescent, and once your eye leaves the lens's eye box the dot vanishes. Snapshots verify all three cases.
- **Lens imperfections:** chromatic aberration and barrel distortion growing toward the rim, natural vignetting,
  coating tint, dust and smudges fixed to the glass, Fresnel reflection of the actual sky, a sun glint, a sliding
  coating sheen, and a bright edge ring.
- **Zeroed at 35 m**: the scope axis is tilted 1.9° down from the arrow line, computed from the arrow's speed
  and the 7.7 cm sight height, so the full-draw trajectory crosses the dot at 35 m. The self-test shoots with
  the dot on a point 35 m away and measures the arrow 5 cm from it.
- Considered: a rifle-style scope with a short eye relief. That's wrong for a bow, which you hold at arm's
  length; archery scopes are long-eye-relief lenses on the riser, which is what this models.
- The lens is on its own render layer (`EYES_ONLY_LAYER`), so the scope camera never renders the lens it's
  drawing into (no feedback loop). The riser body sits beside a **sight window**: the first version blocked
  part of the lens from one eye, which a snapshot caught.

**Targets.** Hits are tested **analytically** (segment against disc, segment against sphere), so moving targets
need no physics bodies, and the world is a Rapier ray cast. The tip's path is checked every frame, so a 75 m/s
arrow can't tunnel. Arrows parent to whatever they stick in, so they ride the moving targets. Sky-themed:
bullseyes on floating rocks, a balloon-carried target, one riding an orbiting cloud, and a kite, with
sun-to-twilight ring colours.

## 14. The skyboat (added 2026-10-16)

You asked for a flying boat with a proper helm and elevation controls, yaw and height only.

**Controls you hold, not sticks.** A wheel, a throttle lever and a lift handle, all grabbed with grip:
- **Wheel**: the angle of each hand around the hub is tracked frame to frame and the wheel turns by the average
  change, so one hand or two hand-over-hand both work. One and a half turns lock to lock, the wheel angle sets
  the **turn rate** (up to 18°/s), it self-centres when released, and it ratchets with a click and a haptic tick
  every 15°.
- **Throttle**: a lever that stays where you leave it, with a neutral detent (like a ship's telegraph), so you can
  let go and keep cruising.
- **Lift**: a handle that slides up and down a post and springs back to the middle. Up climbs, down sinks;
  letting go holds altitude, so you can't drift into the cloud sea by forgetting a control. Considered: a second
  lever, but which way is "up" on a tilting lever is ambiguous, and a handle that moves the way the boat moves
  needs no explanation.
- Considered: thumbsticks. They're faster to learn but the request was a helm, and a physical control means you
  cause every motion, which also keeps it comfortable.

**Comfort.** The deck never pitches or rolls (your call, and the comfortable one: the horizon never tilts),
motion is eased (no instant accelerations), speeds are gentle (6 m/s ahead, 2.5 m/s climb), and the comfort
vignette, if it's on, closes a little only while she's turning, which is the motion most likely to bother people.
You also see the deck, rails and wheel around you, a fixed frame of reference.

**Riding along: the boat moves first.** At the very start of each frame, before anything reads the hands, the
boat integrates its motion and moves the player's rig by the same yaw and translation. Then everything else
(hands, the grab system, a bow in your hand, the controls themselves) sees consistent poses. The tests measure
0 mm of drift of the head on the deck while flying, turning and climbing. Considered: moving the boat inside the
physics step, which would leave a held bow trailing the hand by one frame (about 7 cm at full speed); and
parenting the rig to the boat, which would complicate every world-space calculation in the input code.

**Physics.** The boat is a kinematic Rapier body carrying the deck, bulwarks, binnacle, pedestals and envelope
as colliders, so balls roll on the deck, arrows stick in her and ride along, and teleport arcs land on her. The
body leads its drawn pose by one physics step, because props are drawn interpolated one step behind; that way a
ball on the deck is drawn exactly on the deck. Teleporting onto her stores the landing point in her frame, so
you land where you aimed even though she moved during the blink (within 3 cm in the tests). Once aboard you stay aboard
until you clearly leave (walk well away from her, or teleport off), so leaning over the rail never drops you.

**Collisions.** Every move is a shape cast of the hull and the envelope against the static world; she stops
3 cm short, slides along walls, and refuses a yaw that would swing the hull into something. Scraping over an
island's grass adds drag, so she runs aground rather than sledding across the island. Building this exposed a
gap: the islands' undersides used a cone collider that sat up to 3 m inside the drawn rock, so every island now
also has its rock surface as an exact collider (cheap, and props bounce off the right place now too). The far
islands got collidable, walkable tops so you can sail out and step off.

**Other details.** The pier is on the east rim with the boat moored across its end, bow to open sky, so leaving
needs no maneuvering (throttle ahead first: turning at the pier bumps her into it). The shadow map now follows
the player, snapped to whole texels so edges don't crawl, since the boat can take you away from the island. The
engine is one continuous synthesized voice whose pitch, filter and chug follow the load, plus rushing air for
the crew. She's about 22 draw calls per eye after merging.

## 15. The laser sight (added 2026-10-16)

- **What "fading" means here**: the beam is brightest at the bow and fades exponentially with distance (about
  14 m to 1/e), the way a laser shows in thin haze, with a little drifting-dust shimmer. The dot where it lands
  stays crisp. If you meant a beam that fades away after each shot, that's a small change.
- **Zeroed with the scope**: the emitter sits under the sight bar and its beam crosses the scope's line of sight
  at the same 35 m, so dot, reticle and a full-draw arrow agree there (checked to the millimetre).
- **Drawn per eye**: the beam is a ribbon turned to face each eye in the vertex shader, never thinner than a
  couple of headset pixels (and dimmer as it widens, so far away it doesn't turn into a bar). It's on the
  eyes-only layer, so the scope doesn't render it; the dot is ordinary geometry, so the scope shows it.
- **Blending**: pure additive red vanished against the pink sunset sky (the red channel is already nearly full;
  caught in a snapshot). The beam and dot use premultiplied blending instead: they add red light *and* cover a
  little of what's behind them, so they read by day and glow at night.
- **Toggle**: B/Y on the bow hand (the brush already uses B/Y for undo, so it means "the tool's own button"),
  also in the wrist menu; it's remembered. It fades in when you pick up the bow.

## 16. Deliberately out of scope (for now)

Multiplayer, passthrough / `immersive-ar` (the Frame's passthrough is monochrome and not exposed to WebXR), WebXR Layers (not supported by the community Frame build), eye tracking (not in WebXR), asset pipelines, and saving paintings.

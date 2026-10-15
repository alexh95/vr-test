# Skyreach: a browser VR playground for the Steam Frame

A floating island above a sea of clouds at sunset. Everything on it is there because it's better in VR than on a
screen: grab and throw physics toys, **pull things to your hand with gravity gloves**, paint ribbons of light in
the air, play a marimba, light a firework in your hand and hear the boom arrive late, flip gravity off, grow to
giant size, walk the plank over a 40 m drop, and **shoot a two-handed bow with a 2Ã— scope** at targets floating
(and flying) out over the clouds.

WebXR + three.js + Rapier, TypeScript, Vite. No assets: geometry, textures and sound are all generated in code.
See [DECISIONS.md](DECISIONS.md) for why each piece was chosen.

![Sunset at spawn](docs/sunset.jpg)

---

## Run it on your Steam Frame (PC streaming: works today)

The Frame's built-in browser doesn't support WebXR yet, so the dependable route is to run the page in Chrome on
this PC and let SteamVR stream it to the headset.

1. Install and start the dev server:
   ```bash
   npm install
   ```
   ```bash
   npm run dev
   ```
2. Connect the Frame to the PC for streaming and make sure **SteamVR** is running.
   SteamVR must be the active OpenXR runtime. It already is on this machine; elsewhere it's in
   SteamVR → Settings → OpenXR.
3. Open **http://localhost:5173** in **Chrome or Edge** on the PC. The button should say **Enter VR**.
4. Press **Enter VR**. You can do this from inside the headset via SteamVR's desktop view, or on the monitor
   before you put the headset on. Accept Chrome's VR permission prompt if it shows one.
5. Put the headset on. To leave, use the SteamVR dashboard or press *Exit VR* on the page.

`localhost` counts as a secure context, so no certificates are needed for this path.

## Run it on the Frame itself (standalone: experimental)

You need a WebXR-capable browser on the headset. As of October 2026 that means the community
[Chromium XR build for Steam Frame](https://github.com/saphid/chromium-webxr-steam-frame): unofficial, built from
in-review Chromium patches, seccomp sandbox disabled, no haptics. Read its README before installing. Then:

1. Serve over HTTPS on your LAN (WebXR refuses plain `http://` on anything but localhost):
   ```bash
   npm run dev:lan
   ```
   Vite prints `https://<this-pc>:5173` (this PC's LAN address was `192.168.1.100` when this was written).
2. Open that URL in the XR browser on the Frame and accept the self-signed certificate warning once.
3. Windows may ask to allow Node.js through the firewall (allow **Private** networks). A VPN such as NordVPN can
   block LAN traffic unless it allows local-network access.

The page switches to the **low** quality preset automatically when it detects a browser running on the headset
(Linux/aarch64): no shadows, lower resolution scale, fewer particles. You can also build static files
(`npm run build`, output in `dist/`) and put them on any HTTPS host.

---

## Gallery

| | |
|---|---|
| ![Night: aurora, moon and glowing crystals](docs/night.jpg) | ![The island from above](docs/overview.jpg) |
| ![Console, light brushes, marimba, fireworks](docs/stations.jpg) | ![Gloved hands driven by trigger, grip and thumb touch, both sides](docs/hands.jpg) |

![Sky Range: the deck, the bow at full draw, and the scope aligned, 2 cm off-axis and 4 cm off-axis](docs/archery.jpg)

![The Sky Range at night](docs/range-night.jpg)

(Rendered from the emulated headset with `__vr.snapshot()`.)

## Controls

| Input | Action |
|---|---|
| **Grip** | Grab and hold; let go mid-swing to throw |
| **Point at something far away + grip, then flick your wrist back** | Gravity gloves: it arcs into your hand. Keep holding grip to catch it |
| **Trigger** | Use what you hold: paint with a brush, light a rocket. Point at console buttons or the menu and pull to press |
| **Right stick forward** | Aim a teleport arc; release to jump. It only lands on solid ground |
| **Right stick left/right** | Snap turn (45° by default) |
| **Left stick** | Walk (with a comfort vignette) |
| **B / Y** while holding a brush | Undo the last stroke |
| **Bow**: grip it with one hand, then bring the other hand to the string and squeeze (grip or trigger) | An arrow nocks. Draw back toward your cheek and let go to shoot |
| **Turn your left palm toward your face** | Wrist menu: poke it with your right index finger (lift it off the trigger to point) or point and pull the trigger |

### Things to try
- **Table**: balls and blocks. Knock down the tin-can pyramid at the island's edge.
- **Glowing orbs**: on the stepping stones, the satellite island, the stone pillar, and two floating in the sky.
  Only the gravity gloves can reach the floating ones.
- **Brush stand**: dip a brush in a pot to load colour. The rainbow pot cycles hue along the stroke.
- **Marimba**: grab a mallet from the rack, tap with a fingertip, or throw a ball at it.
- **Fireworks crate**: grab a rocket, point it at the sky and pull the trigger. Keep holding: when the fuse burns
  down it launches out of your hand by itself.
- **Console**: RESET toys · FINALE (ten rockets around the island) · SKY (sunset → night with aurora → day) ·
  GIANT (grow 8×, press again to shrink) · **GRAVITY lever** (pull it toward you).
- **The plank**: straight ahead from where you start. Walk out to the end and look down.
- **Stepping stones** to the satellite island: teleport from stone to stone.
- **Sky Range** (the deck on the west rim, to your left from spawn): see below.

### Sky Range (archery)
Take the bow from its rack. Either hand can hold it; that hand aims. Bring your other hand to the string,
squeeze (grip or trigger), and draw back toward your face. While you draw, the bow points from your draw hand
through the grip, so **both arms set the aim** as in real archery. Let go to shoot. A full draw sends the arrow
at about 75 m/s. Arrows drop, so far targets need holdover.

- **The scope** is a 2Ã— archery sight with an illuminated red dot, **zeroed at 35 m** at full draw. Closer
  targets hit a little high, farther ones low. It behaves like real optics: the picture sits at infinity, the dot
  stays on target wherever your eye is, and if your eye drifts off the scope's axis, a dark crescent of tube
  shadow creeps in until the view (and the dot) disappears. Anchor consistently and it lines up.
- **Targets**: floating rocks at 12, 24 and 45 m, one standing on the west isle, a target **carried by
  balloons** sailing side to side, one riding a **cloud that orbits a crystal pylon**, and a **kite** looping a
  figure-eight about 60 m out. Rings score 10/8/6/4/2. Moving targets score Ã—2, the kite Ã—3.
  **Balloons** drifting up from the clouds pop for 5.
- Hits are heard late from far away (sound at 343 m/s). Arrows stay stuck in what they hit, moving targets
  included, and knock props flying (try the tin cans). The scoreboard keeps your best score.
- RESET on the console puts the bow back and starts a new round. Let go of the bow near its rack and it docks.

### Wrist menu
**Settings**: turning (snap 45° / snap 30° / smooth), left stick (walk / teleport), vignette, quality, music,
fingers (driven by controller touch, or by measured joints if SteamVR provides them), plus Recenter · Clear paint ·
Reset toys.
**Info**: live fps, draw calls, framebuffer size, refresh rates, input profiles, and whether your setup exposes
haptics, capacitive touch and finger joints.

---

## First run on the Frame: what to check

Everything below was verified in an emulated headset (next section), but none of it on real hardware. On your
first session, check these and note anything that's off:

- [ ] **Enter VR** starts a session and the island appears at your real floor height. Look down: are your feet on the grass?
- [ ] **Info page** on the wrist menu: what do `haptics`, `touch: trig/grip/thumb` and `finger joints` say?
      These tell us what Chrome + SteamVR expose for the Frame controllers.
- [ ] Your **index finger straightens** when you lift it off the trigger, and the other fingers wrap when you touch the grip.
- [ ] Controllers buzz on grab, impacts, marimba hits, the lever's detents and a lit fuse.
- [ ] A throw goes where your arm says it should (not too weak or too strong).
- [ ] Gravity gloves: the flick feels natural and the catch works.
- [ ] Teleport and snap turn feel right; smooth walking plus the vignette is comfortable.
- [ ] Frame rate stays at the headset's refresh rate (Info page). Try the FINALE at night for the worst case.
- [ ] The play-area outline (SteamVR chaperone) shows on the floor, if SteamVR exposes `bounded-floor`.
- [ ] **Bow**: nocking with the other hand is easy, the draw feels right, and the arrow flies where the bow points.
      Does the scope's red dot appear when you anchor? (If your eye can't find it, tell me roughly where your
      draw hand anchors and I'll move the sight.)

---

## Testing without a headset

| URL | What you get |
|---|---|
| `/?emulate` | An emulated headset ([IWER](https://github.com/meta-quest/immersive-web-emulation-runtime), shaped like the Frame as Chrome sees it). Press Enter VR in any browser |
| `/?emulate&devui` | The same, plus IWER's DevUI to drive the head and controllers with mouse and keyboard |
| `/?emulate&selftest` | Runs the **27-check scripted playtest** and logs one JSON line per check (`[selftest] {...}`). Results are also in `window.__selftest` |
| `/?emulate&selftest=teleport,gravity-gloves` | Only those checks |
| `/?emulate&autostart` | Enters the emulated session on load |

Console helpers (in emulator mode):

```js
__vr.state()                  // inXR, fps, draw calls, rig, hands, held items, counters, settings…
__vr.events(20)               // last events: grab, throw, teleport, note, rocket-burst…
await __vr.snapshot('name')   // dev server only: renders the player's view to .snapshots/name.png
__driver.setGripWorld('right', pos, quat); __driver.press('right', 'squeeze', 1)
```

To tile several snapshots into one image: `python tools/contact-sheet.py out.png ".snapshots/*.png"`.

## URL flags

| Flag | Effect |
|---|---|
| `quality=high\|low` | Force a quality tier (default: high, low on a browser running on the headset) |
| `time=sunset\|night\|day` | Start at a time of day |
| `emulate`, `devui`, `stereo`, `autostart`, `selftest[=a,b]` | Emulator and test options (above). `stereo` renders the emulated session side-by-side |

## Scripts

| Command | |
|---|---|
| `npm run dev` | Dev server on http://localhost:5173 |
| `npm run dev:lan` | HTTPS dev server on your LAN (self-signed) |
| `npm run build` | Type-check + production build to `dist/` |
| `npm run preview` / `preview:lan` | Serve `dist/` (HTTP / LAN HTTPS) |
| `npm run typecheck` | TypeScript only |

---

## Layout

```
src/
  main.ts            boot, Enter VR button, emulator/self-test wiring
  app.ts             scene, rig, frame loop (input → locomotion → interaction → physics → render)
  config.ts          tunables and URL flags
  core/              renderer, XR session, events, settings, stats, mesh merging, math
  input/xr-input.ts  poses, buttons (hysteresis + edges), touch, throw velocity, joints, haptics
  hands/             procedural skinned glove hands
  physics/           Rapier wrapper: fixed step, interpolation, impact events, respawn, zero-G
  interact/          grab/throw/swat, gravity gloves, locomotion (teleport, turn, walk, vignette)
  toys/              table & cans & orbs, light brushes, marimba, fireworks, control console
  archery/           bow (two-handed draw), scope (picture-in-picture lens shader), arrows, Sky Range targets
  world/             sky, time of day, clouds, islands, scenery, fireflies, play area, layout
  audio/             Web Audio engine, synthesized SFX, ambience + generative pad
  fx/particles.ts    one-draw-call particle system
  ui/                wrist menu, labels, welcome sign
  dev/               emulator, self-test, driver, probe, snapshots, hidden-page frame clock
tools/contact-sheet.py
```

## Status

**Verified** (Chromium in an emulated headset, dev server and production build): all 27 self-test checks pass,
there are no frame errors, and the visuals were reviewed from snapshots of every station, the hands in four poses
(both sides), sunset and night, fireworks, the teleport arc, the bow at rest and at full draw, and the scope from
aligned and off-axis eye positions. The archery checks include a ballistic one: with the red dot on a point 35 m
away, the arrow lands within 5 cm of it. Also checked: the HTTPS mode serves correctly.

**Tested by you on a Steam Frame** (PC streaming): the first version (everything before the Sky Range).

**Not verified:** anything on real hardware, meaning a real SteamVR + Chrome session, the Frame's actual
haptics/touch/joint reporting, the standalone community browser, comfort and feel. That's the checklist above.

## Troubleshooting

- **"No VR headset found"**: SteamVR isn't running, or another OpenXR runtime is active. Start SteamVR, check
  its OpenXR setting, then reload.
- **"No WebXR in this browser"**: use Chrome or Edge on Windows.
- **"VR needs HTTPS"**: you opened a LAN URL over plain http. Use `npm run dev:lan`.
- **Low frame rate**: open the wrist menu → Quality → Low, or add `?quality=low`.
- **Lost**: wrist menu → Recenter. Things that fall off the island come back by themselves.

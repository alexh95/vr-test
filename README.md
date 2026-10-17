# Skyreach: a browser VR playground for the Steam Frame

A floating island above a sea of clouds at sunset. Everything on it is there because it's better in VR than on a
screen: grab and throw physics toys, **pull things to your hand with gravity gloves**, paint ribbons of light in
the air, play a marimba, light a firework in your hand and hear the boom arrive late, flip gravity off, grow to
giant size, walk the plank over a 40 m drop, **shoot a two-handed bow with a 2× scope and a laser sight** at
targets floating (and flying) out over the clouds, **take the helm of a flying boat** to sail between the islands,
**fire signal flares** that hang under parachutes and light up the night, **walk through a see-through portal** to
an island 100 m away, and **paraglide** home from it, circling in thermals.

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

| | |
|---|---|
| ![The skyboat Skylark moored at the pier on the east rim](docs/skyboat.jpg) | ![At the helm, flying back toward the island](docs/helm.jpg) |

![The bow's laser sight at sunset and at night: bright at the bow, fading into the air](docs/laser.jpg)

| | |
|---|---|
| ![A white parachute flare over the island at night](docs/flares-night.jpg) | ![A red parachute flare: the island in red light, trees throwing shadows](docs/flares-red.jpg) |
| ![Three smoke rounds at sunset: trails, bursts and drifting colour columns](docs/flares-smoke.jpg) | ![Loading the flare pistol: broken open, a red parachute cartridge going in](docs/flare-gun.jpg) |

| | |
|---|---|
| ![The portal on the main island: the perch, 100 m away, seen through it](docs/portal-home.jpg) | ![On the perch, looking back at its portal: the main island through it](docs/portal-perch.jpg) |
| ![The glider rack at the root of the plank, its windsock showing the breeze](docs/glider-rack.jpg) | ![Wearing the wing at the end of the plank, a toggle in each hand](docs/glider-plank.jpg) |
| ![Banking left over the cloud sea](docs/glider.jpg) | ![From the harness: the canopy banked overhead, birds circling in a thermal](docs/glider-pilot.jpg) |

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
| **B / Y** on the hand holding the bow | Laser sight on / off |
| **Skyboat helm**: grip the wheel's rim (one or both hands) and turn | Steer: the further you turn it, the faster she turns. Let go and it eases back to centre |
| **Skyboat throttle** (red knob, right of the wheel): grip, push forward or pull back | Ahead / astern. It stays where you leave it and clicks into neutral in the middle |
| **Skyboat lift** (blue handle, left of the wheel): grip, pull up or push down | Climb / sink. Let go and it springs back, holding your altitude |
| **Flare pistol**: grip it in its case, then **A / X** | Breaks it open (a fired case flies out). A / X again, or a quick upward flick of the wrist, snaps it shut |
| **Cartridge** (grip one in the case) brought to the open breech | It slides in. Close the pistol and pull the **trigger**: one shot, then reload |
| **Paraglider**: grip a toggle on a glider rack (one in each hand) | The wing rises over you. Walk off an edge to fly; pull a toggle down to turn that way, both to slow |
| **Walk through a portal** (in the room or with the stick), or **teleport into its opening** | You come out of its twin on the other island, facing out of it |
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
- **The skyboat** (the pier on the east rim, to your right from spawn): see below.
- **Signal flares**: a flare locker stands by the way out to the pier, and another is on the skyboat's deck.
  See below.
- **The portal**: turn around from where you start; it's behind you to the left. Its twin is on the perch, a high
  island 100 m out. See below.
- **Paraglider**: a rack stands at the root of the plank, and another on the perch. See below.

### Sky Range (archery)
Take the bow from its rack. Either hand can hold it; that hand aims. Bring your other hand to the string,
squeeze (grip or trigger), and draw back toward your face. While you draw, the bow points from your draw hand
through the grip, so **both arms set the aim** as in real archery. Let go to shoot. A full draw sends the arrow
at about 75 m/s. Arrows drop, so far targets need holdover.

- **The scope** is a 2× archery sight with an illuminated red dot, **zeroed at 35 m** at full draw. Closer
  targets hit a little high, farther ones low. It behaves like real optics: the picture sits at infinity, the dot
  stays on target wherever your eye is, and if your eye drifts off the scope's axis, a dark crescent of tube
  shadow creeps in until the view (and the dot) disappears. Anchor consistently and it lines up.
- **Targets**: floating rocks at 12, 24 and 45 m, one standing on the west isle, a target **carried by
  balloons** sailing side to side, one riding a **cloud that orbits a crystal pylon**, and a **kite** looping a
  figure-eight about 60 m out. Rings score 10/8/6/4/2. Moving targets score ×2, the kite ×3.
  **Balloons** drifting up from the clouds pop for 5.
- Hits are heard late from far away (sound at 343 m/s). Arrows stay stuck in what they hit, moving targets
  included, and knock props flying (try the tin cans). The scoreboard keeps your best score.
- **The laser sight** under the scope throws a thin red beam that's bright at the bow and fades into the air
  over a few tens of metres, with a dot wherever it lands (you see the dot through the scope too). It crosses the
  scope's line of sight at 35 m, so dot, reticle and a full-draw arrow agree there. **B / Y** on the bow hand
  switches it on or off (also in the wrist menu).
- RESET on the console puts the bow back and starts a new round. Let go of the bow near its rack and it docks.

### The skyboat
The *Skylark* waits at the end of the pier on the east rim. Walk out along the pier and step aboard through the
gate in her rail (or teleport onto the deck), then stand at the helm facing the bow:

- **Wheel**: grab the rim with one or both hands and turn it (one and a half turns lock to lock). Turn left to
  turn left. You can turn while stopped.
- **Throttle** (right hand): push forward to go ahead, up to 6 m/s; pull back for astern. It stays put.
- **Lift** (left hand): pull the handle up to climb, push it down to sink (2.5 m/s at the stops). It springs back
  to the middle, so letting go holds your altitude.
- **No pitch or roll**: the deck always stays level. You ride along with her: walk around the deck, turn, shoot
  the bow from the rail, teleport onto her while she's moving and you land where you aimed.
- The gauge over the wheel shows altitude, speed and heading. She bumps off islands rather than passing through
  them; fly low onto an island and she runs aground and scrapes to a stop. Lift off and back away.
- Everywhere is in range: the far islands now have walkable tops, so you can sail out and step off. She won't go
  past 230 m from the island, above 60 m, or below 30 m under it.
- **RESET** on the console (or *Reset toys* in the wrist menu) sends her back to the pier, with you aboard if
  you're on the deck. If turning the wheel at the pier does nothing, she's touching the pier: throttle forward
  first.

### Signal flares
Each locker holds a break-action flare pistol and nine kinds of cartridge, three rows of three colours.
Cartridges you take are replaced a couple of seconds later.

- **Parachute** (white, red, green; white shells with a domed cap): climbs to about 90 m, pops a parachute and
  drifts down at under 2 m/s for 38 seconds, burning hard. At night it **lights the islands**: real light with
  moving shadows (it swings under its canopy), a glow on the cloud sea below, smoke lit around it.
- **Star** (red, green, gold; coloured shells with a pointed cap): a fast, bright signal that arcs over and
  burns for seven seconds. It skips off the ground and pops balloons on the way.
- **Smoke** (orange, violet, sky; dark shells with a flat cap): trails coloured smoke, bursts into a cloud at
  the top, then pours a column under a little drogue chute that drifts with the wind for twenty seconds.
- **Reloading**: break the pistol open with A / X (on the hand holding it). A fired case is thrown out; an
  unfired one stays in, and you can pull it out with your other hand to swap kinds. Bring a cartridge to the
  breech and it slides in. Snap the pistol shut with an upward flick of the wrist (or A / X) and fire.
  Pulling the trigger on a fired case just clicks.
- Let go of the pistol at its case and it goes back in. Fired from the skyboat, flares keep the boat's speed.
- RESET on the console puts the pistols away and clears the sky.

### Portals
A stone hoop on a plinth, south-west of spawn. Look into it and you see the **perch**: a high island 100 m
north-west and 22 m up, live, in stereo, from wherever you stand. Walk through, in the room or with the stick, and
you're there, facing out the way you were walking, with no fade. Or aim a teleport arc into the opening: it carries
on out of the perch's portal (you see it land through the portal) and the blink takes you there, facing out of it.
The perch's portal looks back at the main island the same way. Throw a ball through, shoot an arrow or a flare
through: they come out of the other one, still flying. The hoop itself is solid stone. From far away (over 45 m) a
portal just shows a slow swirl.

### Paraglider
Each rack holds a wing: orange and teal at the root of the plank, violet and yellow on the perch's rim (step
through the portal, then glide home).

- **Take off**: grip a toggle on the rack in each hand. The wing rises from behind you to over your head. Walk off
  an edge (the end of the plank is made for it). Wearing the wing, the stick walks you off edges too.
- **Steer**: hands at shoulder height fly straight at full speed (6 m/s, an easy pace). Pull the **left toggle down
  to turn left**, the right one to turn right; it answers straight away, and the further down, the tighter the turn
  (a full turn takes about 6 s). **Both down** (to about your belly) slows you to 3.6 m/s and you come down steeply,
  which is how you get down onto a small island. Let go of a toggle and it springs up beside your head; grab it
  again any time.
- **Climb in a thermal**: ten **thermals** rise around the map, by the satellite island, the west isle, south and
  east of the main island, halfway to the perch, beside the perch, and by each far island. Look for faint streaks
  winding up a column of air, dust spiralling up and birds circling at the top, and listen for the variometer: it
  beeps faster and higher the faster you climb. Circle inside one (one toggle well down) to climb to 35-50 m.
- **Ride a ridge**: the breeze blows from the west-north-west, and every island pushes it up over its windward rim.
  Fly back and forth just off an island's west and north sides to stay up (you'll see dust carried up over the
  rim). The plank is in that lift, so launching from it is gentle. Without lift you sink about 0.75 m/s, about 8 m
  forward per metre down.
- **Land** on any island (or the skyboat's deck): you touch down when your feet reach the ground and run a few steps.
  Come in from the lee (east and south) side, where the air isn't rising. You're still wearing the wing, so walk
  off another edge to fly again. **Let go of both toggles** on the ground and the wing packs itself back onto its
  rack.
- Fly into a cliff or a tree and you slide along it. Sink into the clouds and you're blinked back to the rack.
- Teleporting, Recenter or RESET also send the wing back to its rack.

### Wrist menu
**Settings**: turning (snap 45° / snap 30° / smooth), left stick (walk / teleport), vignette, quality, music,
fingers (driven by controller touch, or by measured joints if SteamVR provides them), bow laser, plus Recenter ·
Clear paint · Reset toys.
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
- [ ] **Laser**: is the beam visible enough at sunset and at night (and not too much)? Does B/Y on the bow hand toggle it?
- [ ] **Skyboat**: boarding through the gate, grabbing the wheel, throttle and lift handle feel natural; the boat's
      turning is comfortable (with and without the vignette); you can teleport onto her while she's moving.
- [ ] **Flares**: the pistol sits right in the hand and points where you point; A / X opens it, the cartridge goes
      in easily, the flick to close works for you. At night, does a white parachute flare light things up the
      way you hoped (not too dim, not daylight)? Does the frame rate hold with two or three in the air?
- [ ] **Portals**: does the view through look like a window (depth, both eyes agreeing) rather than a screen?
      Stepping through: seamless, and comfortable? Does the frame rate hold when the portal fills your view?
- [ ] **Paraglider**: are the toggles easy to take off the rack and to find again after letting go? Do the brake
      heights suit you (hands at shoulder height = no brake, belly = full)? Is the new pace right, and does it
      answer quickly enough? Is turning comfortable? Can you see the thermals and ridges, climb in them, and land on
      the main island coming home from the perch?

---

## Testing without a headset

| URL | What you get |
|---|---|
| `/?emulate` | An emulated headset ([IWER](https://github.com/meta-quest/immersive-web-emulation-runtime), shaped like the Frame as Chrome sees it). Press Enter VR in any browser |
| `/?emulate&devui` | The same, plus IWER's DevUI to drive the head and controllers with mouse and keyboard |
| `/?emulate&selftest` | Runs the **49-check scripted playtest** and logs one JSON line per check (`[selftest] {...}`). Results are also in `window.__selftest` |
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
  archery/           bow (two-handed draw), scope (picture-in-picture lens shader), laser sight, arrows, Sky Range targets
  skyboat/           the flying boat: hull/helm model, pier, flight + collisions + carrying the player
  flares/            flare pistols, cartridges, lockers, flights (parachute/star/smoke), smoke, the light pool
  portals/           the see-through portal pair: per-eye views, walking through, things flying through
  glider/            paraglider: wing model, racks, flight, thermals and ridge lift (and the streaks, dust and birds that show them)
  world/             sky, time of day, clouds, islands, scenery, fireflies, play area, layout
  audio/             Web Audio engine, synthesized SFX, ambience + generative pad
  fx/particles.ts    one-draw-call particle system
  ui/                wrist menu, labels, welcome sign
  dev/               emulator, self-test, driver, probe, snapshots, hidden-page frame clock
tools/contact-sheet.py
```

## Status

**Verified** (Chromium in an emulated headset, dev server and production build): all 49 self-test checks pass,
there are no frame errors, and the visuals were reviewed from snapshots of every station, the hands in four poses
(both sides), sunset and night, fireworks, the teleport arc, the bow at rest and at full draw, the scope from
aligned and off-axis eye positions, the laser at sunset and night, and the skyboat at the pier, from the helm and
in flight. The archery checks include a ballistic one: with the red dot on a point 35 m away, the arrow lands
within 5 cm of it. The skyboat checks fly her with the throttle, wheel and lift handle driven by the emulated hands
and measure that the player doesn't slide on the deck (0 mm), that she stops at a cliff (3 cm gap), and that
teleporting onto her while she moves lands within 3 cm of the aimed spot. The flare checks reload the pistol with
the emulated hands (open, cartridge in, flick shut, one shot, dry click, fired case out, back in its case), fire
from the moving boat, and measure that a white parachute flare at night more than doubles the brightness of a view
of the island. The portal checks walk the emulated head through the opening (one transit, out 1.5 m in front of the
twin, facing straight out of it), walk through with the stick, teleport through with an arc aimed into the opening
(landing on the perch, turned to face out of its portal), check that both eyes get a fresh view every frame and
none while you look away, and send a ball and an arrow through. Snapshots taken just before and just after stepping
through show the same picture, shadows included. The glider checks take the toggles off the rack with the emulated
hands, walk off the end of the plank with the stick, turn each way by pulling a toggle (80° and 90° in 1.5 s), slow
to 3.6 m/s with both, climb 10 m in 8 s circling in a thermal, climb 2 m in 2 s along the main island's windward
rim, touch down on the main island, pack the wing away by letting go, and get rescued from the clouds back to the
perch rack. Also checked: the HTTPS mode serves correctly.

**Tested by you on a Steam Frame** (PC streaming): the first version, then the Sky Range (you reported the
thumbs and the target z-fighting; both fixed). The laser, the skyboat, the flares, the portals and the
paraglider are new and untested on hardware.

**Not verified:** anything on real hardware, meaning a real SteamVR + Chrome session, the Frame's actual
haptics/touch/joint reporting, the standalone community browser, comfort and feel. That's the checklist above.

## Troubleshooting

- **"No VR headset found"**: SteamVR isn't running, or another OpenXR runtime is active. Start SteamVR, check
  its OpenXR setting, then reload.
- **"No WebXR in this browser"**: use Chrome or Edge on Windows.
- **"VR needs HTTPS"**: you opened a LAN URL over plain http. Use `npm run dev:lan`.
- **Low frame rate**: open the wrist menu → Quality → Low, or add `?quality=low`.
- **Lost**: wrist menu → Recenter. Things that fall off the island come back by themselves.

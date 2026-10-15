// Tunables and URL flags in one place.

const params = new URLSearchParams(location.search);

export type Quality = 'high' | 'low';

/** The Steam Frame running a browser natively reports Linux on aarch64. */
const looksStandaloneArm = /aarch64|arm64/i.test(navigator.userAgent) && /Linux/i.test(navigator.userAgent);

export const flags = {
  /** Install the IWER emulated headset (for desktop testing and agents). */
  emulate: params.has('emulate'),
  /** Also mount IWER's DevUI (mouse/keyboard control of the emulated headset). */
  devui: params.has('devui'),
  /** Run the scripted self-test after entering the emulated session. */
  selftest: params.has('selftest'),
  /** ?selftest=a,b runs only those checks. */
  selftestOnly: params.get('selftest') ? params.get('selftest')!.split(',').filter(Boolean) : null,
  /** Enter VR automatically (emulator only: real browsers need a click). */
  autostart: params.has('autostart'),
  /** Render the emulated session in stereo (side-by-side). */
  stereo: params.has('stereo'),
  quality: ((params.get('quality') as Quality | null) ?? (looksStandaloneArm ? 'low' : 'high')) as Quality,
  /** Start at a given time of day: sunset | night | day. */
  time: params.get('time') ?? 'sunset',
};

export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;
export const MAX_SUBSTEPS = 4;

export const GRAVITY = -9.81;

export const tuning = {
  grabRadius: 0.075, // m, extra slack around an object's bounding sphere
  throwBoost: 1.12, // throws feel weak without a small boost: hand trackers smooth velocity
  maxThrowSpeed: 28,
  teleportSpeed: 7.5, // m/s launch speed of the teleport arc
  teleportMaxNormalTilt: 0.72, // minimum normal.y for a valid landing
  snapTurnDegrees: 45,
  smoothTurnSpeed: 120, // deg/s
  moveSpeed: 2.2, // m/s, smooth locomotion
  gloveMaxDistance: 22,
  gloveConeDegrees: 11,
  gloveFlickSpeed: 1.25, // m/s toward the head to trigger a pull
  pokeDepth: 0.009, // m of button travel before it clicks
};

/** Player spawn on the main island (tracking-space origin goes here). */
export const SPAWN = { x: 0, y: 0, z: 1.2, yaw: 0 };

import { flags, type Quality } from '../config';
import { bus } from './events';

export type TurnMode = 'snap45' | 'snap30' | 'smooth';
export type LeftStick = 'move' | 'teleport';

export interface Settings {
  turn: TurnMode;
  leftStick: LeftStick;
  vignette: boolean;
  quality: Quality;
  music: boolean;
  /** Prefer measured finger joints when the runtime offers them. */
  jointHands: boolean;
}

const KEY = 'skyreach.settings.v1';

function load(): Settings {
  const defaults: Settings = {
    turn: 'snap45',
    leftStick: 'move',
    vignette: true,
    quality: flags.quality,
    music: true,
    jointHands: true,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<Settings>;
    // An explicit ?quality= in the URL wins over the saved value.
    const out = { ...defaults, ...saved };
    if (new URLSearchParams(location.search).has('quality')) out.quality = flags.quality;
    return out;
  } catch {
    return defaults;
  }
}

export const settings: Settings = load();

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  if (settings[key] === value) return;
  settings[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode, blocked site data). Settings still apply for this visit.
  }
  bus.emit('setting', { key, value });
}

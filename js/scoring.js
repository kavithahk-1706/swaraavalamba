/**
 * Swarāvalamba — scoring helpers shared by the live practice page and the
 * history replay (so both colour swaras exactly the same way).
 */
import { SWARA_TO_SEMITONE } from './swara-detect.js';

export function displaySwara(name) {
  if (name === '.') return '-';
  if (name.endsWith('*')) return name.slice(0, -1) + "'";
  return name;
}

/** Shortest distance in semitones between two swara names, or -1 if unknown. */
export function semitoneDistance(expected, detected) {
  const e = SWARA_TO_SEMITONE[(expected || '').replace('*', '')] ?? -1;
  const d = SWARA_TO_SEMITONE[detected] ?? -2;
  if (e < 0 || d < 0) return -1;
  const diff = Math.abs(e - d);
  return Math.min(diff, 12 - diff);
}

export const NOT_DETECTED = ['---', '', null, undefined];

/** Partial credit per swara: 1.0 in tune / 0.8 accepted but off / 0.5 / 0.25 by semitone distance / 0. */
export function _swaraWeight(r) {
  if (NOT_DETECTED.includes(r.detected)) return 0.0;
  if (r.correct) return Math.abs(r.cents || 0) < 15 ? 1.0 : 0.8;
  const diff = semitoneDistance(r.expected, r.detected);
  if (diff === 1) return 0.5;
  if (diff === 2) return 0.25;
  return 0.0;
}

/** CSS class (results grid) for a scored swara. */
export function resultClass(r) {
  if (NOT_DETECTED.includes(r.detected)) return 'no-detect';
  if (r.correct) return Math.abs(r.cents || 0) < 15 ? 'perfect' : 'close-match';
  const diff = semitoneDistance(r.expected, r.detected);
  if (diff === 1) return 'one-off';
  if (diff === 2) return 'two-off';
  return 'wrong-note';
}

/** CSS class (notation bar) for a scored swara. */
export function notationClass(r) {
  const w = _swaraWeight(r);
  if (w >= 0.8) return 'correct';
  if (w >= 0.25) return 'close';
  return 'wrong';
}

export const pctOf = (sum, n) => (n > 0 ? Math.floor(100 * sum / n) : 0);
export const meterColor = pct => (pct >= 70 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--error)');

/** Signal strength (0–100) below this is shown as "low confidence" (faded). */
export const LOW_CONF = 40;
export const isLowConf = c => typeof c === 'number' && c < LOW_CONF;

/** Signal-strength tier for display: null = strong (or unknown), 'mid' = lighter, 'weak' = lightest. */
export function signalTier(c) {
  if (typeof c !== 'number') return null;
  if (c < LOW_CONF) return 'weak';
  if (c < 70) return 'mid';
  return null;
}

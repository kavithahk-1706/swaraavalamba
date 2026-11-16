/**
 * Swarāvalamba — session video recording (MediaRecorder) + headphone helper.
 *
 * Records the raw camera video plus one mixed audio track. Overlays are NOT
 * burned in: the replay redraws them from the saved timeline.
 */

// Prefer MP4 (seekable, plays everywhere); fall back to WebM (Firefox, older Chrome).
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find(m => MediaRecorder.isTypeSupported(m)) || null;
}

export const recordingSupported = () => pickMime() !== null;

let fixWebmPromise = null;
function loadFixWebm() {
  if (window.ysFixWebmDuration) return Promise.resolve(window.ysFixWebmDuration);
  if (!fixWebmPromise) {
    fixWebmPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/fix-webm-duration@1.0.5/fix-webm-duration.js';
      s.onload = () => resolve(window.ysFixWebmDuration);
      s.onerror = () => reject(new Error('fix-webm-duration failed to load'));
      document.head.appendChild(s);
    });
  }
  return fixWebmPromise;
}

export class SessionRecorder {
  /** @param {MediaStream} stream  video track(s) + the mixed audio track */
  constructor(stream) {
    this.mime = pickMime();
    this.stream = stream;
    this.chunks = [];
    this.startPerf = 0;
    this.recorder = null;
    this._stopped = null;
  }

  start() {
    if (!this.mime) throw new Error('Video recording is not supported in this browser');
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: this.mime,
      videoBitsPerSecond: 1_200_000,
      audioBitsPerSecond: 96_000,
    });
    this.recorder.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.start(1000);
    this.startPerf = performance.now();   // media time 0 ≈ now
  }

  /** Stop and resolve { blob, mime, durationMs }. */
  stop() {
    if (this._stopped) return this._stopped;
    this._stopped = new Promise((resolve, reject) => {
      const r = this.recorder;
      if (!r || r.state === 'inactive') { reject(new Error('Recorder not running')); return; }
      const endPerf = performance.now();
      r.onstop = async () => {
        const mime = this.mime;
        const durationMs = Math.round(endPerf - this.startPerf);
        let blob = new Blob(this.chunks, { type: mime.split(';')[0] });
        if (mime.startsWith('video/webm')) {
          // MediaRecorder WebM has no duration → seeking breaks. Patch it in.
          try {
            const fix = await loadFixWebm();
            blob = await new Promise(res => fix(blob, durationMs, fixed => res(fixed)));
          } catch (e) { console.warn('Could not patch WebM duration:', e); }
        }
        resolve({ blob, mime, durationMs });
      };
      r.onerror = e => reject(e.error || new Error('Recording failed'));
      r.stop();
    });
    return this._stopped;
  }

  /** Stop and throw the recording away. */
  cancel() {
    const r = this.recorder;
    this.chunks = [];
    if (r && r.state !== 'inactive') { r.onstop = null; r.ondataavailable = null; try { r.stop(); } catch (e) { /* ignore */ } }
    this._stopped = Promise.resolve(null);
  }
}

// ── Headphones ─────────────────────────────────────────────
const HEADSET_RE = /head(phone|set)|ear(phone|bud|pod)|airpod|buds|bluetooth|bt\b|jabra|bose|sony wh|wf-/i;

/**
 * Best-effort guess whether the audio output is a headset. Browsers can't tell
 * for sure, so the result only pre-ticks the "I'm wearing headphones" box.
 * Labels are only available after the mic permission has been granted.
 */
export async function guessHeadphones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter(d => d.kind === 'audiooutput' && d.label);
    const def = outs.find(d => d.deviceId === 'default') || outs[0];
    if (def && HEADSET_RE.test(def.label)) return true;
    return outs.length > 0 && outs.every(d => HEADSET_RE.test(d.label));
  } catch (e) {
    return false;
  }
}

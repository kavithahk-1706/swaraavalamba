/**
 * Swarāvalamba — Tala (hand gesture) detection.
 * Port of the hand logic in code-files/swaravalamba_demo.py, using the
 * MediaPipe Tasks Vision Hand Landmarker (JS + WASM).
 *
 * Note: the Python demo flips the camera frame before detection. Practice.js
 * does the same (detects on a mirrored canvas), so handedness labels and palm
 * normals behave exactly as in the desktop version.
 */

// ── Hand landmark indices ──────────────────────────────────
export const WRIST = 0;
export const THUMB_TIP = 4;
export const INDEX_MCP = 5;
export const MIDDLE_MCP = 9, MIDDLE_TIP = 12;
export const RING_MCP = 13, RING_TIP = 16;
export const PINKY_MCP = 17, PINKY_TIP = 20;

// ── Thresholds ─────────────────────────────────────────────
export const FINGER_TOUCH = 0.35;
export const TIP_DROP_THRESH = 0.10;
export const WRIST_DIP = 0.025;
export const WAVE_FLIP_MIN = 0.20;

// ── MediaPipe loading ──────────────────────────────────────
const VISION_VERSION = '0.10.14';
const VISION_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const MODEL_LOCAL = 'assets/hand_landmarker.task';
const MODEL_REMOTE = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';

/** Create a VIDEO-mode HandLandmarker (2 hands). Tries the local model, then the remote one. */
export async function createHandLandmarker() {
  const { FilesetResolver, HandLandmarker } = await import(`${VISION_CDN}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
  let lastErr;
  for (const modelAssetPath of [MODEL_LOCAL, MODEL_REMOTE]) {
    for (const delegate of ['GPU', 'CPU']) {
      try {
        return await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr;
}

// ── Hand signal extraction ─────────────────────────────────
const v3 = (lm, i) => [lm[i].x, lm[i].y, lm[i].z];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = a => Math.hypot(a[0], a[1], a[2]);
const dist = (a, b) => norm(sub(a, b));
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Per-frame signals from one hand's 21 landmarks:
 *  finger_thumb — tip→thumb distance per finger (normalised by hand size)
 *  tip_drop     — fingertip y minus knuckle y per finger (normalised)
 *  palm_z       — z of the palm normal (sign flips when the palm turns over)
 *  wrist_y      — 1 - wrist.y (up = larger)
 *  hand_size    — wrist→middle-MCP distance
 */
export function extractHand(landmarks) {
  const wrist = v3(landmarks, WRIST);
  const thumb = v3(landmarks, THUMB_TIP);
  const idxMcp = v3(landmarks, INDEX_MCP);
  const midMcp = v3(landmarks, MIDDLE_MCP);
  const pnkMcp = v3(landmarks, PINKY_MCP);
  const hs = dist(wrist, midMcp) || 0.001;

  const finger_thumb = {
    pinky: dist(v3(landmarks, PINKY_TIP), thumb) / hs,
    ring: dist(v3(landmarks, RING_TIP), thumb) / hs,
    middle: dist(v3(landmarks, MIDDLE_TIP), thumb) / hs,
  };

  const tip_drop = {};
  for (const [name, tipI, mcpI] of [['pinky', PINKY_TIP, PINKY_MCP],
                                    ['ring', RING_TIP, RING_MCP],
                                    ['middle', MIDDLE_TIP, MIDDLE_MCP]]) {
    tip_drop[name] = (v3(landmarks, tipI)[1] - v3(landmarks, mcpI)[1]) / hs;
  }

  const normal = cross(sub(idxMcp, wrist), sub(pnkMcp, wrist));
  const palm_z = normal[2] / (norm(normal) + 1e-9);

  return { finger_thumb, tip_drop, palm_z, wrist_y: 1.0 - wrist[1], hand_size: hs };
}

// ── Hand picking / locking ─────────────────────────────────
/**
 * Chooses which detected hand to track. Right hand only (MediaPipe labels it
 * "Left" on the mirrored frame); in palm mode with two hands, the upper hand
 * is locked and kept by its label, with a short grace period on dropouts.
 */
export class HandTracker {
  constructor() {
    this.lockedLabel = null;
    this.missCount = 0;
    this.GRACE = 8;
  }

  /** @returns {{lm: Array|null, warning: string, score?: number}}  score = MediaPipe's handedness confidence (0–1) */
  pick(result, mode) {
    const lms = result && result.landmarks ? result.landmarks : [];
    if (!lms.length) {
      this.missCount++;
      if (this.missCount > this.GRACE) this.lockedLabel = null;
      return { lm: null, warning: 'no hand' };
    }
    const hands = lms.map((lm, i) => ({ lm, label: result.handedness[i][0].categoryName, score: result.handedness[i][0].score }));

    if (mode === 'palm' && hands.length >= 2) {
      const sorted = [...hands].sort((a, b) => a.lm[WRIST].y - b.lm[WRIST].y);
      const top = sorted[0];
      if (this.lockedLabel !== null) {
        for (const h of hands) {
          if (h.label === this.lockedLabel) { this.missCount = 0; return { lm: h.lm, warning: '', score: h.score }; }
        }
        this.missCount++;
        if (this.missCount <= this.GRACE) return { lm: top.lm, warning: 're-acquiring', score: top.score };
        this.lockedLabel = null;
      }
      this.lockedLabel = top.label;
      this.missCount = 0;
      return { lm: top.lm, warning: '', score: top.score };
    }

    const target = 'Left';
    for (const h of hands) {
      if (h.label === target) {
        this.lockedLabel = target;
        this.missCount = 0;
        return { lm: h.lm, warning: '', score: h.score };
      }
    }
    this.lockedLabel = null;
    this.missCount = 0;
    return { lm: null, warning: 'Use your RIGHT hand' };
  }
}

// ── Tala cycle currently supported (8 aksharas per cycle) ──
export const CYCLE = [
  { name: 'Beat',   check: 'beat',   instr: 'Tap' },
  { name: 'Pinky',  check: 'pinky',  instr: 'Pinky' },
  { name: 'Ring',   check: 'ring',   instr: 'Ring' },
  { name: 'Middle', check: 'middle', instr: 'Middle' },
  { name: 'Beat',   check: 'beat',   instr: 'Tap' },
  { name: 'Wave',   check: 'wave',   instr: 'Flip' },
  { name: 'Beat',   check: 'beat',   instr: 'Tap' },
  { name: 'Wave',   check: 'wave',   instr: 'Flip' },
];

function argmax(obj) {
  let best = null;
  for (const k of Object.keys(obj)) if (best === null || obj[k] > obj[best]) best = k;
  return best;
}
function argminKey(obj) {
  let best = null;
  for (const k of Object.keys(obj)) if (best === null || obj[k] < obj[best]) best = k;
  return best;
}

/**
 * Classify the hand movement over one beat's buffer of extractHand() signals.
 * Priority: finger > wave+dip > wave > beat > idle.
 * @param {Array} buf        signals collected during the beat
 * @param {number|null} prevPalmZ  palm_z at the end of the previous beat
 * @param {'air'|'palm'|'lap'} mode
 * @returns {{action: string, finger: string|null, scores: object, strength: number}}
 */
export function classifyAction(buf, prevPalmZ, mode) {
  if (!buf || !buf.length) return { action: 'idle', finger: null, scores: {}, strength: 0 };
  const scores = {};
  let fingerName = null;
  let fingerActive = false;

  if (mode === 'air') {
    // finger touching the thumb
    const tc = { pinky: 0, ring: 0, middle: 0 };
    for (const s of buf) {
      const f = s.finger_thumb;
      const closest = argminKey(f);
      if (f[closest] < FINGER_TOUCH) tc[closest]++;
    }
    const best = argmax(tc);
    const fp = tc[best] / buf.length;
    scores.finger_pct = fp;
    if (fp > 0.2) { fingerActive = true; fingerName = best; }
  } else {
    // palm / lap: fingertip drops below its knuckle
    const dc = { pinky: 0, ring: 0, middle: 0 };
    for (const s of buf) {
      for (const nm of Object.keys(s.tip_drop)) {
        if (s.tip_drop[nm] > TIP_DROP_THRESH) dc[nm]++;
      }
    }
    const best = argmax(dc);
    const fp = dc[best] / buf.length;
    scores.finger_pct = fp;
    if (fp > 0.15) { fingerActive = true; fingerName = best; }
  }

  // palm flip (wave)
  const zs = buf.map(s => s.palm_z);
  let palmFlipped = false;
  for (let i = 1; i < zs.length; i++) {
    if (zs[i] * zs[i - 1] < 0 && Math.abs(zs[i] - zs[i - 1]) > 0.05) { palmFlipped = true; break; }
  }
  if (!palmFlipped && prevPalmZ !== null && prevPalmZ !== undefined && zs.length) {
    const last = zs[zs.length - 1];
    if (last * prevPalmZ < 0) palmFlipped = true;
    else if (Math.abs(last - prevPalmZ) > WAVE_FLIP_MIN) palmFlipped = true;
  }
  let flipMag = 0;
  for (let i = 1; i < zs.length; i++) flipMag = Math.max(flipMag, Math.abs(zs[i] - zs[i - 1]));
  if (prevPalmZ !== null && prevPalmZ !== undefined && zs.length) {
    flipMag = Math.max(flipMag, Math.abs(zs[zs.length - 1] - prevPalmZ));
  }
  scores.flip_mag = flipMag;
  const palmChange = zs.length >= 2 ? Math.abs(zs[zs.length - 1] - zs[0]) : 0;
  const palmScore = palmChange;
  scores.palm_score = palmScore;

  // wrist dip (beat)
  const ys = buf.map(s => s.wrist_y);
  const wristRange = ys.length >= 2 ? Math.max(...ys) - Math.min(...ys) : 0;
  const sizes = buf.map(s => s.hand_size).filter(Boolean);
  const avgHand = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 1.0;
  const wristNorm = avgHand > 0.01 ? wristRange / avgHand : wristRange;
  const wristDipped = wristNorm > WRIST_DIP || wristRange > WRIST_DIP;
  const beatScore = wristNorm * 3;
  scores.beat_score = beatScore;

  // Signal strength 0–1 for whatever was detected: 0.5 = right at the threshold, 1 = twice the threshold.
  const fingerThr = mode === 'air' ? 0.2 : 0.15;
  const fingerS = Math.min(1, (scores.finger_pct || 0) / (2 * fingerThr));
  const waveS = Math.min(1, flipMag / (2 * WAVE_FLIP_MIN));
  const beatS = Math.min(1, wristNorm / (2 * WRIST_DIP));
  const idleS = Math.max(0, 1 - Math.max(fingerS, waveS, beatS));   // how clearly nothing happened

  if (fingerActive) return { action: 'finger', finger: fingerName, scores, strength: fingerS };
  if (palmFlipped && wristDipped) {
    if (palmScore > beatScore * 0.7) return { action: 'wave', finger: null, scores, strength: waveS };
    return { action: 'beat', finger: null, scores, strength: beatS };
  }
  if (palmFlipped) return { action: 'wave', finger: null, scores, strength: waveS };
  if (wristDipped) return { action: 'beat', finger: null, scores, strength: beatS };
  return { action: 'idle', finger: null, scores, strength: idleS };
}

/**
 * Was the expected kriya for this akshara performed during the beat?
 * @returns {{ok: boolean, detail: string, action: string, finger: string|null, conf: number}}
 * conf (0–100) = how strongly the detected action was seen (a heuristic signal strength, not a probability).
 */
export function checkTalaAkshara(aksharaIdx, buf, prevPalmZ, mode) {
  const expected = CYCLE[aksharaIdx].check;
  const { action, finger, strength } = classifyAction(buf, prevPalmZ, mode);
  if (!buf || !buf.length) return { ok: false, detail: 'no hand', action: 'none', finger: null, conf: 0 };

  let ok = false;
  let detail;
  if (expected === 'pinky' || expected === 'ring' || expected === 'middle') {
    ok = action === 'finger' && finger === expected;
    detail = ok ? `${expected} correct` : `expected ${expected}`;
  } else if (expected === 'wave') {
    ok = action === 'wave';
    detail = ok ? 'wave correct' : 'expected wave';
  } else if (expected === 'beat') {
    ok = action === 'beat';
    detail = ok ? 'beat correct' : 'expected beat';
  } else {
    detail = '?';
  }
  return { ok, detail, action, finger, conf: Math.round(100 * (strength || 0)) };
}

// ── Drawing ────────────────────────────────────────────────
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

/**
 * Draw one hand on the overlay canvas (pass unmirror=false for already-unmirrored points, as saved in recordings). Landmarks come from the mirrored
 * detection frame; the overlay itself is CSS-mirrored like the video, so x is
 * un-mirrored (1 - x) here and ends up exactly on the hand on screen.
 */
export function drawHand(ctx, landmarks, color = '#ffc832', unmirror = true) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const px = i => (unmirror ? 1 - landmarks[i].x : landmarks[i].x) * w;
  const py = i => landmarks[i].y * h;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) { ctx.moveTo(px(a), py(a)); ctx.lineTo(px(b), py(b)); }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  for (let i = 0; i < landmarks.length; i++) {
    ctx.beginPath();
    ctx.arc(px(i), py(i), 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Swarāvalamba — practice page controller.
 * State machine MENU → COUNTDOWN → RUNNING → RESULTS (port of the main loop in
 * code-files/swaravalamba_demo.py): metronome, tala + swara scoring, session
 * recording and the results overlay.
 */
import {
  RAGAS, SHRUTI_LIST, SWARA_TO_SEMITONE, matchSwara,
  SwaraListener, TanpuraPlayer,
} from './swara-detect.js';
import { getUser, onAuthChange } from './auth.js';
import { saveSession } from './history.js';
import { SessionRecorder, recordingSupported, guessHeadphones } from './recorder.js';
import { exportJSON, exportCSV, exportPDF } from './export.js';
import { buildResults, summarize } from './results-view.js';
import {
  displaySwara, NOT_DETECTED, _swaraWeight, resultClass, notationClass, pctOf, meterColor, isLowConf,
} from './scoring.js';
import {
  CYCLE, HandTracker, createHandLandmarker, extractHand, checkTalaAkshara, drawHand,
} from './tala-detect.js';

const $ = id => document.getElementById(id);

// ── States ─────────────────────────────────────────────────
const MENU = 'MENU', COUNTDOWN = 'COUNTDOWN', RUNNING = 'RUNNING', RESULTS = 'RESULTS';
const COUNT_IN_BEATS = 4;
const VOTE_INTERVAL_MS = 33;          // ≈ the 30 fps vote rate of the Python demo
const SPEED_LABELS = { 1: '1st speed (1/beat)', 2: '2nd speed (2/beat)', 4: '3rd speed (4/beat)' };

// ── Exercises (degree notation; names resolved per raga) ───
// S R G M P D N = the raga's 7 swaras in order; S* = upper Sa; "," = sustain.
const EXERCISES = {
  'Sarali 1': { desc: 'Ascending & descending', notes: 'S R G M P D N S*  S* N D P M G R S' },
  'Sarali 2': {
    desc: 'Two-step pattern',
    notes: 'S R G M S R G M  S R G M P D N S*  S* N D P S* N D P  S* N D P M G R S',
  },
  'Sarali 3': {
    desc: 'Oscillating pattern',
    notes: 'S R G M S R S R  S R G M P D N S*  S* N D P S* N S* N  S* N D P M G R S',
  },
  'Datu Swara': {
    desc: 'Skipped-note (Datu Varisai)',
    notes: 'S M G R S R G M  R P M G R G M P  G D P M G M P D  M N D P M P D N  ' +
           'P S* N D P D N S*  S* P D N S* N D P  N M P D N D P M  D G M P D P M G  ' +
           'P R G M P M G R  M S R G M G R S',
  },
};
const DEGREE = { S: 0, R: 1, G: 2, M: 3, P: 4, D: 5, N: 6 };

/** The raga's 7 swara names in order (Sa, Ri, Ga, Ma, Pa, Da, Ni). */
function ragaDegreeNames(ragaKey) {
  const sw = (RAGAS[ragaKey] || RAGAS.mayamalavagowla).swaras;
  return Object.keys(sw).map(Number).sort((a, b) => a - b).map(k => sw[k]);
}

/** Notation string → swara names for a raga, e.g. "S R1 ..." → ["Sa", "Ri1", ...]. */
function resolveNotes(notation, ragaKey) {
  const names = ragaDegreeNames(ragaKey);
  const out = [];
  for (const t of notation.trim().split(/\s+/)) {
    if (t === '|' || t === '||') continue;
    if (t === ',') out.push('.');
    else if (t === 'S*' || t === 'Ṡ') out.push('Sa*');
    else if (t in DEGREE) out.push(names[DEGREE[t]]);
    else out.push(t);                       // already a swara name
  }
  return out;
}

/** Expand for the speed and repeat to fill whole 8-beat cycles. */
function buildNotes(baseNotes, swarasPerBeat) {
  const beatsNeeded = Math.ceil(baseNotes.length / swarasPerBeat);
  const totalBeats = beatsNeeded % 8 === 0 ? beatsNeeded : (Math.floor(beatsNeeded / 8) + 1) * 8;
  const targetSwaras = totalBeats * swarasPerBeat;
  const repeats = Math.ceil(targetSwaras / baseNotes.length);
  const notes = [];
  for (let r = 0; r < repeats; r++) notes.push(...baseNotes);
  return { notes: notes.slice(0, targetSwaras), totalBeats, repeats };
}

// ── Scoring helpers ────────────────────────────────────────
/** Chronological [note, cents] votes → runs of the same note (drops runs < minRun). */
function votesToRuns(votes, minRun = 2) {
  if (!votes.length) return [];
  const runs = [];
  let curNote = votes[0][0];
  let cur = [votes[0]];
  for (let i = 1; i < votes.length; i++) {
    const v = votes[i];
    if (v[0] === curNote) cur.push(v);
    else {
      if (cur.length >= minRun) runs.push([curNote, cur]);
      curNote = v[0];
      cur = [v];
    }
  }
  if (cur.length >= minRun) runs.push([curNote, cur]);
  return runs;
}

// ── App state ──────────────────────────────────────────────
const app = {
  state: MENU,

  // settings
  exerciseKey: 'Sarali 1', ragaKey: 'mayamalavagowla', speed: 1, mode: 'air',
  shruti: 'C', bpm: 60,

  // exercise
  notes: [], totalBeats: 0,

  // media
  video: $('video'), overlay: $('overlay'), overlayCtx: null,
  mirror: document.createElement('canvas'), mirrorCtx: null,
  cameraStream: null, landmarker: null, tracker: new HandTracker(),
  audioCtx: null, listener: null, drone: null,
  lastVideoTime: -1, lastDetectTs: 0, lastResult: null,
  rightLm: null, signals: null, handWarning: '',

  // countdown
  countdownStart: 0, countinPrevBeat: -1,

  // running
  startTime: 0, curBeat: 0, prevBeat: -1,
  handBuf: [], prevPalmZ: null,
  beatVotes: [], deferredBeat: -1, lastVoteTs: 0, lastSeq: -1,
  swaraResults: [], talaResults: [], talaBoxes: new Array(8).fill(null), talaConf: new Array(8).fill(null),

  // recording
  session: null,
  bus: null, recDest: null, micTapped: false,
  recorder: null, recPromise: null, recStartPerf: 0,
  hands: [], lastHandSample: 0, handPresent: false,
  headphones: false, headphonesTouched: false, headphonesGuessed: false,
  saveState: 'idle',          // idle | saving | saved | discarded
  busy: false,
};
app.mirrorCtx = app.mirror.getContext('2d');
app.overlayCtx = app.overlay.getContext('2d');

// ── Exercise / notation ────────────────────────────────────
function rebuildExercise() {
  const base = resolveNotes(EXERCISES[app.exerciseKey].notes, app.ragaKey);
  const built = buildNotes(base, app.speed);
  app.notes = built.notes;
  app.totalBeats = built.totalBeats;
  renderNotation();
  $('beatCounter').textContent = `${app.totalBeats} beats · ${app.totalBeats / 8} cycles`;
  $('talaCycle').textContent = 'Cycle –';
  $('talaMode').textContent = `Mode: ${app.mode}`;
}

function renderNotation() {
  const bar = $('notationBar');
  bar.replaceChildren();
  app.notes.forEach((n, i) => {
    const s = document.createElement('span');
    s.className = 'swara';
    s.dataset.i = i;
    s.textContent = displaySwara(n);
    bar.appendChild(s);
  });
  bar.scrollLeft = 0;
}

function markNotation(i, cls) {
  const el = $('notationBar').children[i];
  if (el) el.classList.add(cls);
}

let notationCurrent = -1;
function setNotationCurrent(i) {
  if (i === notationCurrent) return;
  const bar = $('notationBar');
  const prev = bar.children[notationCurrent];
  if (prev) prev.classList.remove('current');
  const el = bar.children[i];
  if (el) {
    el.classList.add('current');
    bar.scrollTo({ left: el.offsetLeft - bar.clientWidth / 2 + el.offsetWidth / 2, behavior: 'smooth' });
  }
  notationCurrent = i;
}

function clearNotationState() {
  notationCurrent = -1;
  for (const el of $('notationBar').children) el.classList.remove('current', 'correct', 'wrong', 'close');
}

// ── Live UI ────────────────────────────────────────────────
function renderTalaBoxes(currentAk) {
  [...$('talaBoxes').children].forEach((box, i) => {
    box.classList.remove('current', 'correct', 'wrong', 'has-conf');
    box.style.removeProperty('--conf');
    box.removeAttribute('title');
    const c = app.talaConf[i];
    if (c !== null && c !== undefined && i !== currentAk) {      // signal-strength bar on scored beats
      box.classList.add('has-conf');
      box.style.setProperty('--conf', c / 100);
      box.title = `Signal strength ${c}%`;
    }
    if (i === currentAk) box.classList.add('current');
    else if (app.talaBoxes[i] === true) box.classList.add('correct');
    else if (app.talaBoxes[i] === false) box.classList.add('wrong');
  });
}

function renderMeters() {
  const sN = app.swaraResults.length;
  const sPct = pctOf(app.swaraResults.reduce((a, r) => a + _swaraWeight(r), 0), sN);
  const tN = app.talaResults.length;
  const tPct = pctOf(app.talaResults.filter(r => r.correct).length, tN);

  $('swaraMeterVal').textContent = sN ? `${sPct}%` : '–';
  $('swaraMeterFill').style.width = `${sPct}%`;
  $('swaraMeterFill').style.background = meterColor(sPct);
  $('talaMeterVal').textContent = tN ? `${tPct}%` : '–';
  $('talaMeterFill').style.width = `${tPct}%`;
  $('talaMeterFill').style.background = meterColor(tPct);
}

function resetLiveUI() {
  app.talaBoxes = new Array(8).fill(null);
  app.talaConf = new Array(8).fill(null);
  renderTalaBoxes(-1);
  clearNotationState();
  $('expectedSwara').textContent = '–';
  const d = $('detectedSwara');
  d.textContent = '---';
  d.classList.remove('correct', 'wrong');
  $('centsDisplay').innerHTML = '&nbsp;';
  setStrength(null);
  $('talaInstr').innerHTML = '&nbsp;';
  $('progressFill').style.width = '0%';
  renderMeters();
}

function setStrength(pct) {
  const known = typeof pct === 'number';
  $('strengthFill').style.width = known ? `${pct}%` : '0%';
  $('strengthFill').style.background = known ? meterColor(pct) : '';
  $('strengthVal').textContent = known ? `${pct}%` : '–';
}

function renderDetected(swara, expected) {
  const d = $('detectedSwara');
  d.classList.remove('correct', 'wrong');
  setStrength(swara.voiced && swara.short ? swara.strength : null);
  if (swara.voiced && swara.short) {
    d.textContent = swara.short;
    let hint;
    const c = swara.cents;
    if (Math.abs(c) < 10) hint = '~ in tune';
    else if (c > 0) hint = c > 30 ? 'too high' : 'slightly high';
    else hint = c < -30 ? 'too low' : 'slightly low';
    $('centsDisplay').textContent = `${c >= 0 ? '+' : ''}${c.toFixed(0)}¢ ${hint}`;
    if (app.state === RUNNING && expected) {
      d.classList.add(matchSwara(expected, swara.short, c) ? 'correct' : 'wrong');
    }
  } else {
    d.textContent = '---';
    $('centsDisplay').innerHTML = '&nbsp;';
  }
}

function setStatusMsg(text) {
  const el = $('cameraMsg');
  el.innerHTML = text || '';
  el.classList.toggle('hidden', !text);
}

function setControlsLocked(locked) {
  for (const id of ['exerciseSelect', 'ragaSelect', 'speedSelect', 'modeSelect', 'shrutiSelect', 'bpmInput']) {
    $(id).disabled = locked;
  }
}

function updateStartButton() {
  const b = $('startBtn');
  const idle = app.state === MENU || app.state === RESULTS;
  b.querySelector('.when-idle').classList.toggle('hidden', !idle);
  b.querySelector('.when-running').classList.toggle('hidden', idle);
  b.classList.toggle('running', !idle);
}

function setState(s) {
  app.state = s;
  setControlsLocked(s === COUNTDOWN || s === RUNNING);
  updateStartButton();
}

// ── Audio ──────────────────────────────────────────────────
function ensureAudio() {
  if (!app.audioCtx) {
    app.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Everything we play goes through `bus`; with headphones it is also mixed into the recording.
    app.bus = app.audioCtx.createGain();
    app.bus.connect(app.audioCtx.destination);
    app.recDest = app.audioCtx.createMediaStreamDestination();
    app.drone = new TanpuraPlayer(app.audioCtx, { shruti: app.shruti, output: app.bus });
    app.listener = new SwaraListener(app.audioCtx, { shruti: app.shruti, raga: app.ragaKey });
  }
  if (app.audioCtx.state === 'suspended') app.audioCtx.resume();
}

/** Metronome click: 800 Hz normal, 1100 Hz accent (sample 1 of the cycle). */
function playClick(accent) {
  const ctx = app.audioCtx;
  if (!ctx) return;
  const freq = accent ? 1100 : 800;
  const dur = accent ? 0.05 : 0.04;
  const vol = accent ? 0.3 : 0.2;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.005);
  g.gain.setValueAtTime(vol, t + dur - 0.005);
  g.gain.linearRampToValueAtTime(0, t + dur);
  osc.connect(g).connect(app.bus);
  osc.start(t);
  osc.stop(t + dur + 0.01);
  osc.onended = () => { osc.disconnect(); g.disconnect(); };
}

// ── Camera + models ────────────────────────────────────────
async function ensureCamera() {
  if (app.cameraStream) return;
  app.cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });
  app.video.srcObject = app.cameraStream;
  await app.video.play();
}

async function ensureLandmarker() {
  if (!app.landmarker) app.landmarker = await createHandLandmarker();
}

async function ensureMic() {
  if (app.listener.running) return true;
  try {
    await app.listener.start();
    if (!app.micTapped && app.listener.source) {     // the mic is always part of the recording
      app.listener.source.connect(app.recDest);
      app.micTapped = true;
    }
    return true;
  } catch (e) {
    console.warn('Microphone unavailable:', e);
    return false;
  }
}

// ── Per-frame hand detection ───────────────────────────────
function detectHands(now) {
  const v = app.video;
  if (!app.cameraStream || !app.landmarker || v.readyState < 2 || !v.videoWidth) return;

  const w = v.videoWidth, h = v.videoHeight;
  if (app.overlay.width !== w || app.overlay.height !== h) {
    app.overlay.width = w; app.overlay.height = h;
    app.mirror.width = w; app.mirror.height = h;
    app.video.parentElement.style.setProperty('--cam-ar', (w / h).toFixed(4));   // keep the frame exactly the camera's shape
  }

  // only run on a new camera frame (and with a strictly increasing timestamp)
  const newFrame = v.currentTime !== app.lastVideoTime && now > app.lastDetectTs;
  if (newFrame) {
    app.lastVideoTime = v.currentTime;
    app.lastDetectTs = now;
    // detect on a mirrored frame, like cv2.flip() in the Python demo
    const m = app.mirrorCtx;
    m.save();
    m.translate(w, 0);
    m.scale(-1, 1);
    m.drawImage(v, 0, 0, w, h);
    m.restore();
    try {
      app.lastResult = app.landmarker.detectForVideo(app.mirror, now);
    } catch (e) {
      console.warn('Hand detection error:', e);
      app.lastResult = null;
    }
    const pick = app.tracker.pick(app.lastResult, app.mode);
    app.rightLm = pick.lm;
    app.handWarning = pick.warning;
    app.signals = pick.lm ? extractHand(pick.lm) : null;
    if (app.signals) app.signals.hand_score = pick.score ?? 0;
    sampleHand(now);
  }

  // draw landmarks every frame
  const ctx = app.overlayCtx;
  ctx.clearRect(0, 0, w, h);
  const lms = app.lastResult && app.lastResult.landmarks ? app.lastResult.landmarks : [];
  for (const lm of lms) {
    drawHand(ctx, lm, lm === app.rightLm ? '#ffc832' : '#969696');
  }
  $('handWarning').textContent = app.handWarning;
  return newFrame;
}

// ── Session recording ──────────────────────────────────────
/** Save the tracked hand (~15 fps, 3 decimals, un-mirrored x) so the replay can redraw the skeleton. */
function sampleHand(now) {
  if (!app.recorder || (app.state !== COUNTDOWN && app.state !== RUNNING)) return;
  if (now - app.lastHandSample < 66) return;
  const t = Math.round(now - app.recStartPerf);
  if (app.rightLm) {
    app.lastHandSample = now;
    app.handPresent = true;
    const flat = [];
    for (const p of app.rightLm) flat.push(+(1 - p.x).toFixed(3), +p.y.toFixed(3));
    app.hands.push([t, flat]);
  } else if (app.handPresent) {          // hand lost: one null frame clears the skeleton
    app.handPresent = false;
    app.lastHandSample = now;
    app.hands.push([t, null]);
  }
}

function stopBusTap() {
  try { app.bus.disconnect(app.recDest); } catch (e) { /* not connected */ }
}

/** Begin recording camera + mixed audio (only if the toggle is on and the user is signed in). */
function startRecording() {
  app.recorder = null;
  app.recPromise = null;
  if (!$('recordToggle').checked || !getUser() || !app.cameraStream) return;
  try {
    const track = app.cameraStream.getVideoTracks()[0];
    app.headphones = $('headphonesToggle').checked;
    // headphones: click + tanpura can't reach the mic, so mix them in.
    // speakers: the mic already hears them; mixing would double them up.
    if (app.headphones) app.bus.connect(app.recDest);
    const stream = new MediaStream([track, ...app.recDest.stream.getAudioTracks()]);
    app.recorder = new SessionRecorder(stream);
    app.recorder.start();
  } catch (e) {
    console.error(e);
    app.recorder = null;
    stopBusTap();
    alert('Video recording could not start, so this run will not be recorded.');
  }
}

function recordEvent(type, data) {
  if (!app.session) return;
  app.session.events.push({ t: Math.round(performance.now() - app.startTime), type, ...data });
}

// ── Countdown ──────────────────────────────────────────────
function startCountdown() {
  const base = resolveNotes(EXERCISES[app.exerciseKey].notes, app.ragaKey);
  const built = buildNotes(base, app.speed);
  app.notes = built.notes;
  app.totalBeats = built.totalBeats;
  renderNotation();
  resetLiveUI();

  app.listener.setRaga(app.ragaKey);
  app.listener.setShruti(app.shruti);
  app.tracker = new HandTracker();

  app.saveState = 'idle';
  app.hands = [];
  app.handPresent = false;
  app.lastHandSample = 0;
  startRecording();

  app.countdownStart = performance.now();
  app.recStartPerf = app.recorder ? app.recorder.startPerf : app.countdownStart;   // media time 0
  app.countinPrevBeat = -1;
  setState(COUNTDOWN);
  $('resultsOverlay').classList.add('hidden');
  $('countdownLabel').textContent = app.exerciseKey;
  $('countdownSub').textContent = `${app.bpm} BPM · ${SPEED_LABELS[app.speed]} · Sa = ${app.shruti}`;
  $('countdownOverlay').classList.remove('hidden');
  setStatusMsg('');
}

function tickCountdown(now) {
  const beatDur = 60 / app.bpm;
  const elapsed = (now - app.countdownStart) / 1000;
  if (elapsed >= COUNT_IN_BEATS * beatDur) {
    startRunning(now);
    return;
  }
  const b = Math.min(Math.floor(elapsed / beatDur), COUNT_IN_BEATS - 1);
  if (b !== app.countinPrevBeat) {
    app.countinPrevBeat = b;
    playClick(b === 0);
    const num = $('countdownNumber');
    num.textContent = String(b + 1);
    num.style.animation = 'none';
    void num.offsetWidth;            // restart the pulse animation
    num.style.animation = '';
  }
}

// ── Running ────────────────────────────────────────────────
function startRunning(now) {
  $('countdownOverlay').classList.add('hidden');
  setState(RUNNING);
  app.startTime = now;
  app.curBeat = 0;
  app.prevBeat = -1;
  app.handBuf = [];
  app.prevPalmZ = null;
  app.swaraResults = [];
  app.talaResults = [];
  app.talaBoxes = new Array(8).fill(null);
  app.talaConf = new Array(8).fill(null);
  app.beatVotes = [];
  app.deferredBeat = -1;
  app.lastVoteTs = 0;
  app.lastSeq = -1;
  app.session = {
    app: 'swaravalamba-web',
    startedAt: new Date().toISOString(),
    exercise: app.exerciseKey, raga: app.ragaKey, speed: app.speed, mode: app.mode,
    shruti: app.shruti, bpm: app.bpm,
    notes: [...app.notes], totalBeats: app.totalBeats,
    schema: 2,
    hasVideo: Boolean(app.recorder),
    headphones: Boolean(app.recorder) && app.headphones,
    videoOffsetMs: Math.round(now - app.recStartPerf),   // media time at which the exercise starts
    events: [],
  };
  resetLiveUI();
}

/** Expected swara at index si; "." (sustain) resolves to the previous real note. */
function expectedAt(si) {
  let exp = app.notes[si];
  if (exp === '.') {
    for (let j = si - 1; j >= 0; j--) if (app.notes[j] !== '.') { exp = app.notes[j]; break; }
  }
  return exp;
}

/** Score notes [start, end) against runs[runOffset + i]; appends to swaraResults. */
function scoreSwaras(start, end, runs, runOffset, tag) {
  for (let si = start, i = 0; si < end; si++, i++) {
    if (app.swaraResults.length >= app.notes.length) break;
    const exp = expectedAt(si);
    let det = '', avgCents = 0, correct = false, conf = 0;
    const ri = runOffset + i;
    if (ri < runs.length) {
      const [note, votes] = runs[ri];
      det = note;
      avgCents = votes.reduce((a, v) => a + v[1], 0) / votes.length;
      conf = Math.round(votes.reduce((a, v) => a + (v[2] || 0), 0) / votes.length);
      correct = matchSwara(exp, det, avgCents);
    }
    const r = { index: si, expected: exp, detected: det || '---', correct, cents: avgCents, conf };
    app.swaraResults.push(r);
    markNotation(si, notationClass(r));
    recordEvent('swara_score', { ...r, weight: _swaraWeight(r), tag });
  }
}

/** Beat-boundary swara scoring (deferred by singer latency; split at 3rd speed). */
function scoreOnBeatBoundary() {
  const spb = app.speed;
  const runs = votesToRuns(app.beatVotes, 2);
  if (spb <= 2) {
    // 1st/2nd speed: score the *previous* beat using this beat's runs (≈0.5-beat latency)
    if (app.deferredBeat >= 0) {
      const s = app.deferredBeat * spb;
      scoreSwaras(s, Math.min(s + spb, app.notes.length), runs, 0, 'deferred');
    }
  } else {
    // 3rd speed: half-beat split
    const half = spb >> 1;
    if (app.deferredBeat >= 0) {
      const s = app.deferredBeat * spb + half;
      scoreSwaras(s, Math.min(app.deferredBeat * spb + spb, app.notes.length), runs, 0, 'split-late');
    }
    const p = app.prevBeat * spb;
    scoreSwaras(p, Math.min(p + half, app.notes.length), runs, half, 'split-early');
  }
  app.deferredBeat = app.prevBeat;
  app.beatVotes = [];
}

function scoreTalaBeat(beatIdx) {
  const ak = beatIdx % 8;
  const res = checkTalaAkshara(ak, app.handBuf, app.prevPalmZ, app.mode);
  const hs = app.handBuf.map(x => x.hand_score).filter(v => typeof v === 'number');
  const handConf = hs.length ? Math.round(100 * hs.reduce((a, b) => a + b, 0) / hs.length) : 0;   // MediaPipe handedness score
  app.talaResults.push({ beat: beatIdx, akshara: ak, correct: res.ok, detail: res.detail, conf: res.conf, handConf });
  app.talaBoxes[ak] = res.ok;
  app.talaConf[ak] = res.conf;
  recordEvent('tala', {
    beat: beatIdx, akshara: ak, expected: CYCLE[ak].check,
    action: res.action, finger: res.finger, correct: res.ok, detail: res.detail, conf: res.conf, handConf,
  });
  if (app.handBuf.length) app.prevPalmZ = app.handBuf[app.handBuf.length - 1].palm_z;
}

function onNewBeat(curBeat) {
  const ak = curBeat % 8;
  playClick(ak === 0);
  recordEvent('beat', { beat: curBeat, akshara: ak });

  if (app.prevBeat >= 0) {
    scoreOnBeatBoundary();
    scoreTalaBeat(app.prevBeat);
    if (ak === 0) {   // new cycle
      app.talaBoxes = new Array(8).fill(null);
      app.talaConf = new Array(8).fill(null);
    }
    renderMeters();
  }
  app.handBuf = [];
  app.prevBeat = curBeat;
}

function tickRunning(now, newFrame) {
  const beatDur = 60 / app.bpm;
  const elapsed = (now - app.startTime) / 1000;
  const curBeat = Math.floor(elapsed / beatDur);
  if (curBeat >= app.totalBeats) { finishRun(); return; }
  app.curBeat = curBeat;

  if (newFrame && app.signals) app.handBuf.push(app.signals);

  // which swara window are we in?
  const spb = app.speed;
  const progress = elapsed / beatDur - curBeat;
  const inBeat = Math.floor(progress * spb);
  const swaraIdx = Math.min(curBeat * spb + Math.min(inBeat, spb - 1), app.notes.length - 1);

  // swara votes for this beat (~30 Hz) + session log on each new mic reading
  const swara = app.listener.getState();
  if (swara.seq !== app.lastSeq) {
    app.lastSeq = swara.seq;
    if (swara.voiced) {
      recordEvent('swara', { swara: swara.short, freq: +swara.freq.toFixed(2), cents: +swara.cents.toFixed(1), conf: swara.strength, expected: expectedAt(swaraIdx) });
    }
  }
  if (swara.voiced && swara.short && now - app.lastVoteTs >= VOTE_INTERVAL_MS) {
    app.lastVoteTs = now;
    app.beatVotes.push([swara.short, swara.cents, swara.strength]);
  }

  if (curBeat !== app.prevBeat) onNewBeat(curBeat);

  // UI
  const ak = curBeat % 8;
  const expected = app.notes[swaraIdx];
  setNotationCurrent(swaraIdx);
  $('progressFill').style.width = `${(100 * curBeat) / app.totalBeats}%`;
  $('beatCounter').textContent = `Beat ${curBeat + 1}/${app.totalBeats}`;
  $('talaInstr').textContent = `${ak + 1}/8 ${CYCLE[ak].instr}`;
  $('talaCycle').textContent = `Cycle ${Math.floor(curBeat / 8) + 1}/${app.totalBeats / 8}`;
  $('expectedSwara').textContent = displaySwara(expected);
  renderTalaBoxes(ak);
  renderDetected(swara, expected);
}

/** Score whatever is still pending, then show the results. */
function finishRun() {
  if (app.prevBeat >= 0 && app.talaResults.length < app.totalBeats) scoreTalaBeat(app.prevBeat);

  const runs = votesToRuns(app.beatVotes, 2);
  const spb = app.speed, n = app.notes.length, prev = app.prevBeat;
  const have = () => app.swaraResults.length < n;
  if (spb <= 2) {
    let remaining = runs;
    if (app.deferredBeat >= 0 && have()) {
      const s = app.deferredBeat * spb;
      scoreSwaras(s, Math.min(s + spb, n), runs, 0, 'flush-deferred');
      remaining = runs.slice(spb);
    }
    if (prev >= 0 && prev !== app.deferredBeat && have()) {
      const s = prev * spb;
      scoreSwaras(s, Math.min(s + spb, n), remaining, 0, 'flush-last');
    }
  } else {
    const half = spb >> 1;
    if (app.deferredBeat >= 0 && have()) {
      const s = app.deferredBeat * spb + half;
      scoreSwaras(s, Math.min(app.deferredBeat * spb + spb, n), runs, 0, 'flush-split-late');
    }
    if (prev >= 0 && have()) {
      const s = prev * spb;
      scoreSwaras(s, Math.min(s + half, n), runs, half, 'flush-split-early');
    }
    if (prev >= 0 && have()) {
      const s = prev * spb + half;
      scoreSwaras(s, Math.min(prev * spb + spb, n), runs, spb, 'flush-last');
    }
  }
  app.beatVotes = [];
  renderMeters();
  if (app.session) app.session.durationMs = Math.round(performance.now() - app.recStartPerf);
  if (app.recorder) {
    app.recPromise = app.recorder.stop().catch(e => { console.error(e); return null; });
    app.recorder = null;
    stopBusTap();
  }
  showResults();
}

// ── Results ────────────────────────────────────────────────
function showResults() {
  setState(RESULTS);
  setNotationCurrent(-1);

  const session = app.session;
  const sum = summarize(session);
  session.endedAt = new Date().toISOString();
  session.summary = {
    swaraPct: sum.sPct, talaPct: sum.tPct, overall: sum.overall, talaCorrect: sum.tCorrect, talaTotal: sum.tN,
  };

  // the same view the History page builds from the saved events
  $('resultsBody').replaceChildren(buildResults(session, { title: `Results — ${app.exerciseKey}` }));
  $('resultsOverlay').classList.remove('hidden');
  $('resultsOverlay').scrollTop = 0;

  updateSaveUI();
}

// ── Save / discard / export ────────────────────────────────
const CONSENT_TEXT =
  'Record this session?\n\n' +
  'Your camera video and microphone audio are recorded while you practise. ' +
  'Nothing is uploaded unless you press "Save to history" afterwards; a discarded recording is lost forever. ' +
  'Saved recordings are private to your account.';
const consentKey = () => `swaravalamba-record-consent-${(getUser() || {}).id}`;

const hasUnsavedRecording = () => Boolean(app.recPromise) && app.saveState === 'idle';

async function saveCurrentSession() {
  if (!app.session || !getUser() || app.saveState !== 'idle') return;
  app.saveState = 'saving';
  updateSaveUI();
  try {
    const video = app.recPromise ? await app.recPromise : null;
    if (app.recPromise && !video) alert('The video recording failed, so only the analysis will be saved.');
    const res = await saveSession({ session: app.session, hands: app.hands, video });
    if (res.videoSkipped) alert('The video is over the 50 MB free-plan limit, so only the analysis was saved.');
    app.saveState = 'saved';
  } catch (e) {
    console.error(e);
    app.saveState = 'idle';
    alert(`Could not save this session: ${e.message || e}`);
  }
  updateSaveUI();
}

function discardRecording() {
  if (!hasUnsavedRecording()) return;
  if (!confirm('Discard this recording? It will be lost forever.')) return;
  app.recPromise = null;
  app.hands = [];
  app.saveState = 'discarded';
  updateSaveUI();
}

/** Before leaving the results screen: warn if a recording would be thrown away. */
function confirmLeave() {
  if (app.state !== RESULTS || !hasUnsavedRecording()) return true;
  return confirm('You have an unsaved recording. If you continue it is discarded forever.\n\nContinue?');
}

function updateSaveUI() {
  const user = getUser();
  const rec = $('recordToggle');
  const supported = recordingSupported();
  rec.disabled = !user || !supported;
  if (!user || !supported) rec.checked = false;
  $('recordHint').textContent = !supported
    ? 'Video recording is not supported in this browser.'
    : !user
      ? 'Sign in to record sessions to your history.'
      : rec.checked
        ? 'This run will be recorded. When it ends you choose to save or discard it.'
        : 'Off by default. Records camera + audio so you can replay the run with its analysis.';

  const st = app.saveState;
  $('saveBtn').disabled = !user || st !== 'idle';
  $('saveLabel').textContent = !user ? 'Sign in to save'
    : st === 'saving' ? 'Saving…'
    : st === 'saved' ? 'Saved to history'
    : st === 'discarded' ? 'Discarded'
    : app.recPromise ? 'Save recording to history' : 'Save to history';
  $('discardBtn').classList.toggle('hidden', !hasUnsavedRecording());
}

// ── Start / stop ───────────────────────────────────────────
function backToMenu() {
  if (!confirmLeave()) return;
  if (app.recorder) { app.recorder.cancel(); app.recorder = null; stopBusTap(); }
  app.recPromise = null;
  app.hands = [];
  $('countdownOverlay').classList.add('hidden');
  $('resultsOverlay').classList.add('hidden');
  setState(MENU);
  resetLiveUI();
  rebuildExercise();
  if (app.cameraStream) setStatusMsg('');
  else setStatusMsg('Press <strong>&nbsp;Start&nbsp;</strong> to enable your camera and microphone.');
}

async function startSession() {
  if (app.busy) return;
  if (!confirmLeave()) return;
  app.busy = true;
  const btn = $('startBtn');
  btn.disabled = true;
  try {
    ensureAudio();
    setStatusMsg('Starting camera…');
    await ensureCamera();
    setStatusMsg('Loading hand model…');
    await ensureLandmarker();
    const micOk = await ensureMic();
    if (micOk && !app.headphonesTouched && !app.headphonesGuessed) {
      app.headphonesGuessed = true;
      $('headphonesToggle').checked = await guessHeadphones();   // a guess: the user can correct it
    }
    if (!micOk) {
      alert('Microphone not available — swara detection is off, tala will still be scored.');
    }
    startCountdown();
  } catch (e) {
    console.error(e);
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'NotFoundError');
    setStatusMsg(denied
      ? 'Camera access was blocked. Allow the camera in your browser and press Start again.'
      : `Couldn't start: ${e && e.message ? e.message : e}`);
  } finally {
    app.busy = false;
    btn.disabled = false;
  }
}

function onStartClick() {
  if (app.state === MENU) startSession();
  else if (app.state === RESULTS) startSession();
  else backToMenu();                    // Stop during countdown / run
}

// ── Main loop ──────────────────────────────────────────────
function frame(now) {
  // never let one error kill the loop (a throw here used to freeze the whole page)
  try {
    const newFrame = detectHands(now);
    if (app.state === COUNTDOWN) tickCountdown(now);
    else if (app.state === RUNNING) tickRunning(now, newFrame);
    else if (app.state === MENU && app.listener) renderDetected(app.listener.getState(), null);
  } catch (e) {
    console.error('Frame error:', e);
  }
  requestAnimationFrame(frame);
}

// ── Wiring ─────────────────────────────────────────────────
function init() {
  // sync state from the form (browsers may restore values on reload)
  app.exerciseKey = $('exerciseSelect').value;
  app.ragaKey = $('ragaSelect').value;
  app.speed = Number($('speedSelect').value);
  app.mode = $('modeSelect').value;
  app.shruti = $('shrutiSelect').value;
  app.bpm = clampBpm($('bpmInput').value);

  $('exerciseSelect').addEventListener('change', e => { app.exerciseKey = e.target.value; rebuildExercise(); });
  $('ragaSelect').addEventListener('change', e => {
    app.ragaKey = e.target.value;
    if (app.listener) app.listener.setRaga(app.ragaKey);
    rebuildExercise();
  });
  $('speedSelect').addEventListener('change', e => { app.speed = Number(e.target.value); rebuildExercise(); });
  $('modeSelect').addEventListener('change', e => {
    app.mode = e.target.value;
    app.tracker = new HandTracker();
    $('talaMode').textContent = `Mode: ${app.mode}`;
  });
  $('shrutiSelect').addEventListener('change', e => {
    app.shruti = SHRUTI_LIST.includes(e.target.value) ? e.target.value : 'C';
    if (app.listener) app.listener.setShruti(app.shruti);
    if (app.drone) app.drone.setShruti(app.shruti);
  });
  $('bpmInput').addEventListener('change', e => {
    app.bpm = clampBpm(e.target.value);
    e.target.value = app.bpm;
  });
  $('droneToggle').addEventListener('change', e => {
    if (e.target.checked) {
      ensureAudio();
      app.drone.setShruti(app.shruti);
      app.drone.start().then(() => { if (!e.target.checked) app.drone.stop(); }).catch(err => {
        console.error(err);
        e.target.checked = false;
        alert('Could not load assets/tanpura_c_loop.mp3. Make sure the page is served over http.');
      });
    } else if (app.drone) {
      app.drone.stop();
    }
  });

  $('startBtn').addEventListener('click', onStartClick);
  $('retryBtn').addEventListener('click', startSession);
  $('menuBtn').addEventListener('click', backToMenu);
  $('downloadBtn').addEventListener('click', () => app.session && exportJSON(app.session, app.hands));
  $('csvBtn').addEventListener('click', () => app.session && exportCSV(app.session));
  $('pdfBtn').addEventListener('click', () => {
    if (app.session) exportPDF(app.session).catch(e => alert(`Could not create the PDF: ${e.message}`));
  });
  $('saveBtn').addEventListener('click', saveCurrentSession);
  $('discardBtn').addEventListener('click', discardRecording);
  $('headphonesToggle').addEventListener('change', () => { app.headphonesTouched = true; });
  $('recordToggle').addEventListener('change', e => {
    if (e.target.checked) {
      let ok = Boolean(getUser());
      if (ok) {
        let consented = false;
        try { consented = localStorage.getItem(consentKey()) === '1'; } catch (err) { /* ignore */ }
        if (!consented) {
          ok = confirm(CONSENT_TEXT);
          if (ok) { try { localStorage.setItem(consentKey(), '1'); } catch (err) { /* ignore */ } }
        }
      }
      if (!ok) e.target.checked = false;
    }
    updateSaveUI();
  });
  onAuthChange(updateSaveUI);

  window.addEventListener('beforeunload', e => {
    if (hasUnsavedRecording()) { e.preventDefault(); e.returnValue = ''; }
    if (app.listener) app.listener.stop();
    if (app.cameraStream) app.cameraStream.getTracks().forEach(t => t.stop());
  });

  setState(MENU);
  rebuildExercise();
  renderTalaBoxes(-1);
  renderMeters();
  requestAnimationFrame(frame);
}

function clampBpm(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(120, Math.max(30, n)) : 60;
}

init();

// handy for debugging in the console
window.swaravalamba = app;

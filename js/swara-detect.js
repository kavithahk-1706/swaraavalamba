/**
 * Swarāvalamba — Swara (pitch) detection.
 * Port of code-files/swara_detect.py to the browser (Web Audio API).
 *
 * Exports: swara tables, buildSemitoneMap, freqToSwara, matchSwara,
 * autocorrelationPitch, SwaraListener (mic → AnalyserNode → swara),
 * TanpuraPlayer (loops the recorded tanpura, re-pitched to the shruti).
 */

// ── Carnatic swara mapping ─────────────────────────────────
// 12 semitones, 16 swara names. Four overlapping pairs share a semitone:
//   R2 = G1 (3 → semitone 2) ... see Python source for the full table.
// Default mapping: one name per semitone (used when no raga context).
export const SWARA_NAMES_DEFAULT = [
  'Sa',   // 0
  'Ri1',  // 1  Shuddha Rishabha
  'Ri2',  // 2  Chatushruti Rishabha (= G1)
  'Ga2',  // 3  Sadharana Gandhara   (= R3)
  'Ga3',  // 4  Antara Gandhara
  'Ma1',  // 5  Shuddha Madhyama
  'Ma2',  // 6  Prati Madhyama
  'Pa',   // 7  Panchamam
  'Da1',  // 8  Shuddha Dhaivata
  'Da2',  // 9  Chatushruti Dhaivata (= N1)
  'Ni2',  // 10 Kaishiki Nishada     (= D3)
  'Ni3',  // 11 Kakali Nishada
];

// All swara names → semitone index
export const SWARA_TO_SEMITONE = {
  'Sa': 0,
  'Ri1': 1,
  'Ri2': 2, 'G1': 2, 'Ga1': 2,                       // overlapping pair 1
  'R3': 3, 'Ri3': 3, 'Ga2': 3, 'G2': 3,              // overlapping pair 2
  'Ga3': 4, 'G3': 4,
  'Ma1': 5, 'M1': 5,
  'Ma2': 6, 'M2': 6,
  'Pa': 7,
  'Da1': 8, 'D1': 8,
  'Da2': 9, 'D2': 9, 'Ni1': 9, 'N1': 9,              // overlapping pair 3
  'Da3': 10, 'D3': 10, 'Ni2': 10, 'N2': 10,          // overlapping pair 4
  'Ni3': 11, 'N3': 11,
};

// ── Raga definitions ───────────────────────────────────────
// A raga says which swara name to use at each semitone.
export const RAGAS = {
  shankarabharanam: {
    name: 'Shankarābharaṇam', melakarta: 29,
    swaras: { 0: 'Sa', 2: 'Ri2', 4: 'Ga3', 5: 'Ma1', 7: 'Pa', 9: 'Da2', 11: 'Ni3' },
  },
  mayamalavagowla: {
    name: 'Māyāmāḷavagowḷa', melakarta: 15,
    swaras: { 0: 'Sa', 1: 'Ri1', 4: 'Ga3', 5: 'Ma1', 7: 'Pa', 8: 'Da1', 11: 'Ni3' },
  },
  kharaharapriya: {
    name: 'Kharaharapriya', melakarta: 22,
    // R2 at semitone 2, G2 at semitone 3 (NOT R3!)
    swaras: { 0: 'Sa', 2: 'Ri2', 3: 'Ga2', 5: 'Ma1', 7: 'Pa', 9: 'Da2', 10: 'Ni2' },
  },
  hanumathodi: {
    name: 'Hanumatōḍi', melakarta: 8,
    // R1, G2 (not R3!), D1, N2 (not D3!)
    swaras: { 0: 'Sa', 1: 'Ri1', 3: 'Ga2', 5: 'Ma1', 7: 'Pa', 8: 'Da1', 10: 'Ni2' },
  },
  kalyani: {
    name: 'Kalyāṇi', melakarta: 65,
    swaras: { 0: 'Sa', 2: 'Ri2', 4: 'Ga3', 6: 'Ma2', 7: 'Pa', 9: 'Da2', 11: 'Ni3' },
  },
  harikambhoji: {
    name: 'Harikāmbhōji', melakarta: 28,
    swaras: { 0: 'Sa', 2: 'Ri2', 4: 'Ga3', 5: 'Ma1', 7: 'Pa', 9: 'Da2', 10: 'Ni2' },
  },
  natabhairavi: {
    name: 'Naṭabhairavi', melakarta: 20,
    swaras: { 0: 'Sa', 2: 'Ri2', 3: 'Ga2', 5: 'Ma1', 7: 'Pa', 8: 'Da1', 10: 'Ni2' },
  },
};

/** Semitone → swara-name list (12 entries) for a raga; default names if no raga. */
export function buildSemitoneMap(ragaKey = null) {
  const base = [...SWARA_NAMES_DEFAULT];
  if (ragaKey && RAGAS[ragaKey]) {
    for (const [semitone, name] of Object.entries(RAGAS[ragaKey].swaras)) {
      base[Number(semitone)] = name;
    }
  }
  return base;
}

// Western note names → frequency (Hz) at octave 4
export const NOTE_FREQS = {
  'C': 261.63, 'C#': 277.18, 'Db': 277.18,
  'D': 293.66, 'D#': 311.13, 'Eb': 311.13,
  'E': 329.63, 'Fb': 329.63,
  'F': 349.23, 'F#': 369.99, 'Gb': 369.99,
  'G': 392.00, 'G#': 415.30, 'Ab': 415.30,
  'A': 440.00, 'A#': 466.16, 'Bb': 466.16,
  'B': 493.88, 'Cb': 493.88,
};
export const SHRUTI_LIST = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function shrutiFreq(noteName) {
  return NOTE_FREQS[noteName] ?? 261.63;
}

/**
 * Map a frequency to the nearest swara.
 * Returns { name, short, cents, idx }; idx = -1 and name = null if invalid.
 * cents = how sharp(+)/flat(-) from the exact swara, always in [-50, 50].
 */
export function freqToSwara(freq, saFreq, semitoneMap = SWARA_NAMES_DEFAULT) {
  if (!(freq > 0) || !(saFreq > 0)) return { name: null, short: null, cents: 0, idx: -1 };

  const semitones = 12 * Math.log2(freq / saFreq);   // semitones above Sa
  const mod = ((semitones % 12) + 12) % 12;          // wrap to one octave (0–12)
  const rounded = Math.round(mod);
  const idx = rounded % 12;
  // NOTE: the Python original computes (mod - idx), which for mod≈11.8 gives
  // +1180 cents instead of -20. Using the unwrapped rounded value fixes that.
  const cents = (mod - rounded) * 100;

  const name = semitoneMap[idx];
  return { name, short: name, cents, idx };
}

/**
 * Does the detected swara match the expected one?
 * Exact semitone always matches; ±1 semitone is accepted when the actual sung
 * pitch is within toleranceCents of the expected note.
 */
export function matchSwara(expected, detectedShort, cents = 0, toleranceCents = 33) {
  if (!detectedShort || !expected) return false;
  const exp = expected.replace('*', '');
  const expSemi = SWARA_TO_SEMITONE[exp] ?? -1;
  const detSemi = SWARA_TO_SEMITONE[detectedShort] ?? -2;
  if (expSemi < 0 || detSemi < 0) return exp === detectedShort;
  if (expSemi === detSemi) return true;
  const diff = (((detSemi - expSemi) % 12) + 12) % 12;
  if (diff === 1 && cents <= -(100 - toleranceCents)) return true;
  if (diff === 11 && cents >= (100 - toleranceCents)) return true;
  return false;
}

// ── Pitch detection ────────────────────────────────────────

/**
 * Autocorrelation pitch detection on a Float32Array. Returns Hz, or 0 if
 * silent / unvoiced. Same logic as _autocorrelation_pitch() in Python (peak of
 * the autocorrelation between the lags for fmax..fmin, confidence = peak/zero-lag
 * ≥ 0.5), plus parabolic interpolation around the peak for sub-sample accuracy.
 * Only lags up to sr/fmin are computed (not the full O(n²) correlation).
 */
export function autocorrelationPitch(audio, sr, fmin = 80, fmax = 800, out = null) {
  if (out) out.confidence = 0;   // out.confidence = autocorrelation peak / zero-lag (0–1)
  const n = audio.length;
  if (n < Math.floor(sr / fmax)) return 0;

  // remove DC offset
  let mean = 0;
  for (let i = 0; i < n; i++) mean += audio[i];
  mean /= n;
  const x = new Float32Array(n);
  let peakAbs = 0;
  for (let i = 0; i < n; i++) {
    const v = audio[i] - mean;
    x[i] = v;
    const a = Math.abs(v);
    if (a > peakAbs) peakAbs = a;
  }
  if (peakAbs < 0.01) return 0; // too quiet

  const minLag = Math.floor(sr / fmax);
  const maxLag = Math.min(Math.floor(sr / fmin), n - 1);
  if (minLag >= maxLag) return 0;

  let corr0 = 0;
  for (let i = 0; i < n; i++) corr0 += x[i] * x[i];
  if (!(corr0 > 0)) return 0;

  const corr = new Float64Array(maxLag + 2);
  let bestLag = -1;
  let bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag + 1 && lag < n; lag++) {
    let sum = 0;
    const end = n - lag;
    for (let i = 0; i < end; i++) sum += x[i] * x[i + lag];
    corr[lag] = sum;
    if (lag <= maxLag && sum > bestVal) { bestVal = sum; bestLag = lag; }
  }
  if (bestLag < 0) return 0;

  const confidence = bestVal / corr0;
  if (out) out.confidence = confidence;
  if (confidence < 0.5) return 0; // not confident enough

  // parabolic interpolation
  let lagF = bestLag;
  if (bestLag > minLag && bestLag <= maxLag) {
    const a = corr[bestLag - 1], b = corr[bestLag], c = corr[bestLag + 1];
    const denom = a - 2 * b + c;
    if (denom < 0) lagF = bestLag + 0.5 * (a - c) / denom;
  }
  return sr / lagF;
}

/** 0–1: how tightly the recent pitch readings agree (1 = within a few cents, 0 = 50+ cents spread). */
function stabilityOf(freqs, med) {
  if (freqs.length < 2) return 0.6;          // not enough readings yet
  let spread = 0;
  for (const f of freqs) spread = Math.max(spread, Math.abs(1200 * Math.log2(f / med)));
  return Math.max(0, Math.min(1, 1 - spread / 50));
}

function median(arr) {
  const s = [...arr].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── Continuous listener (mic → AnalyserNode) ───────────────

/**
 * Reads the microphone through an AnalyserNode, detects pitch every blockDur
 * seconds on a rolling windowDur window and exposes the current swara.
 * Mirrors SwaraListener in Python (0.15 s blocks, 0.3 s window, median of the
 * last 5 readings, -45 dB gate).
 */
export class SwaraListener {
  constructor(audioCtx, { shruti = 'C', raga = null, blockDur = 0.15, windowDur = 0.3 } = {}) {
    this.ctx = audioCtx;
    this.saFreq = shrutiFreq(shruti);
    this.shrutiName = shruti;
    this.ragaKey = raga;
    this.semitoneMap = buildSemitoneMap(raga);
    this.blockDur = blockDur;
    this.windowDur = windowDur;

    this.state = { freq: 0, swara: '', short: '', cents: 0, idx: -1, voiced: false, db: -60, seq: 0, strength: 0, confidence: 0, stability: 0 };
    this._recent = [];
    this._maxRecent = 5;
    this._timer = null;
    this._stream = null;
    this._source = null;
    this._analyser = null;
    this._buf = null;
  }

  get running() { return this._timer !== null; }

  /** The mic's MediaStreamAudioSourceNode (null until start()), for routing into a recording. */
  get source() { return this._source; }

  /** Ask for the mic and begin listening. Rejects if mic access fails. */
  async start() {
    if (this.running) return;
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this._source = this.ctx.createMediaStreamSource(this._stream);
    this._analyser = this.ctx.createAnalyser();
    // must hold at least windowDur seconds of samples
    let size = 2048;
    while (size < this.ctx.sampleRate * this.windowDur) size *= 2;
    this._analyser.fftSize = Math.min(size, 32768);
    this._source.connect(this._analyser);   // not connected to destination: no feedback
    this._buf = new Float32Array(this._analyser.fftSize);
    this._timer = setInterval(() => this._tick(), this.blockDur * 1000);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._source) this._source.disconnect();
    if (this._stream) this._stream.getTracks().forEach(t => t.stop());
    this._source = this._stream = this._analyser = null;
  }

  setShruti(noteName) { this.saFreq = shrutiFreq(noteName); this.shrutiName = noteName; }
  setRaga(ragaKey) { this.ragaKey = ragaKey; this.semitoneMap = buildSemitoneMap(ragaKey); }

  _tick() {
    if (!this._analyser) return;
    const sr = this.ctx.sampleRate;
    this._analyser.getFloatTimeDomainData(this._buf);
    const winN = Math.min(this._buf.length, Math.round(sr * this.windowDur));
    const blockN = Math.min(winN, Math.round(sr * this.blockDur));
    const win = this._buf.subarray(this._buf.length - winN);
    const chunk = this._buf.subarray(this._buf.length - blockN);

    let sq = 0;
    for (let i = 0; i < chunk.length; i++) sq += chunk[i] * chunk[i];
    const db = 20 * Math.log10(Math.sqrt(sq / chunk.length) + 1e-10);
    const s = this.state;
    s.seq++;

    if (db < -45) {                       // too quiet: no voice
      this._recent.length = 0;
      Object.assign(s, { voiced: false, freq: 0, swara: '', short: '', cents: 0, idx: -1, db, strength: 0, confidence: 0, stability: 0 });
      return;
    }

    const info = { confidence: 0 };
    const freq = autocorrelationPitch(win, sr, 80, 800, info);
    if (freq > 0) {
      this._recent.push(freq);
      if (this._recent.length > this._maxRecent) this._recent.shift();
      const stable = median(this._recent);
      const r = freqToSwara(stable, this.saFreq, this.semitoneMap);
      // signal strength 0–100 = voicing confidence (0.5→0, 1→1) × stability of the last readings
      const stability = stabilityOf(this._recent, stable);
      const voicing = Math.max(0, Math.min(1, (info.confidence - 0.5) / 0.5));
      Object.assign(s, {
        freq: stable, swara: r.name || '', short: r.short || '',
        cents: r.cents, idx: r.idx, voiced: true, db,
        confidence: info.confidence, stability, strength: Math.round(100 * voicing * stability),
      });
    } else {
      this._recent.length = 0;
      s.voiced = false;
      s.db = db;
      s.strength = 0;
    }
  }

  /** Snapshot of the current state: {freq, swara, short, cents, idx, voiced, db, seq, strength (0–100), confidence, stability}. */
  getState() { return { ...this.state }; }
}

// ── Tanpura drone (recorded loop) ──────────────────────────

/**
 * Plays assets/tanpura_c_loop.wav on a loop. The recording is in C; other
 * shrutis are reached by changing playbackRate (resampling, like the Python
 * TanpuraPlayer), taking the shortest way round (up to 6 semitones either way).
 */
export class TanpuraPlayer {
  static BASE_NOTE = 'C';

  constructor(audioCtx, { url = 'assets/tanpura_c_loop.wav', shruti = 'C', volume = 0.5, output = null } = {}) {
    this.ctx = audioCtx;
    this.output = output || audioCtx.destination;   // lets the page route the drone through its own bus
    this.url = url;
    this.shruti = shruti;
    this.volume = volume;
    this._buffer = null;
    this._loading = null;
    this._source = null;
    this._gain = null;
  }

  get running() { return this._source !== null; }

  /** Fetch + decode the wav once. Rejects if it can't be loaded. */
  load() {
    if (!this._loading) {
      this._loading = fetch(this.url)
        .then(r => {
          if (!r.ok) throw new Error(`Could not load ${this.url} (${r.status})`);
          return r.arrayBuffer();
        })
        .then(data => this.ctx.decodeAudioData(data))
        .then(buf => { this._buffer = buf; })
        .catch(e => { this._loading = null; throw e; });
    }
    return this._loading;
  }

  _rate() {
    const base = SHRUTI_LIST.indexOf(TanpuraPlayer.BASE_NOTE);
    const target = Math.max(0, SHRUTI_LIST.indexOf(this.shruti));
    let shift = (((target - base) % 12) + 12) % 12;
    if (shift > 6) shift -= 12;
    return Math.pow(2, shift / 12);
  }

  async start() {
    if (this._source) return;
    await this.load();
    if (this._source) return;          // started meanwhile
    const ctx = this.ctx;
    this._gain = ctx.createGain();
    this._gain.gain.setValueAtTime(0, ctx.currentTime);
    this._gain.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 0.5);
    this._gain.connect(this.output);
    const src = ctx.createBufferSource();
    src.buffer = this._buffer;
    src.loop = true;
    src.playbackRate.value = this._rate();
    src.connect(this._gain);
    src.start();
    this._source = src;
  }

  stop() {
    if (!this._source) return;
    const ctx = this.ctx, src = this._source, gain = this._gain;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
    setTimeout(() => { try { src.stop(); } catch (e) {} src.disconnect(); gain.disconnect(); }, 400);
    this._source = null;
    this._gain = null;
  }

  /** Re-pitch for a new shruti (note name, e.g. "D#"), live if playing. */
  setShruti(noteName) {
    this.shruti = noteName;
    if (this._source) this._source.playbackRate.setTargetAtTime(this._rate(), this.ctx.currentTime, 0.05);
  }
}

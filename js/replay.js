/**
 * Swarāvalamba — session replay.
 *
 * Plays a saved recording and re-renders the same live UI (notation bar, tāḷa
 * boxes, swara display, accuracy meters) from the saved timeline, so seeking
 * back and forth always shows exactly what was tracked at that moment. The
 * video itself is untouched: only the optional hand skeleton is drawn on it.
 * Sessions saved without video replay against a virtual clock instead.
 *
 * Time bases:  media time = ms since recording started (video.currentTime)
 *              T          = media time - session.videoOffsetMs  (0 = first beat)
 */
import { CYCLE, drawHand } from './tala-detect.js';
import { matchSwara } from './swara-detect.js';
import { displaySwara, notationClass, pctOf, meterColor, _swaraWeight, isLowConf } from './scoring.js';

const LEAD_IN_MS = 1000;          // jump to a mistake a second early
const READING_FRESH_MS = 350;     // how long a mic reading stays "current"

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Number of items in a time-sorted array whose key is <= t. */
function countUpTo(arr, t, key = 't') {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((key ? arr[mid][key] : arr[mid]) <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ── Clocks ─────────────────────────────────────────────────
class MediaClock {
  constructor(video, durationMs) { this.v = video; this.durationMs = durationMs; }
  time() { return this.v.currentTime * 1000; }
  get playing() { return !this.v.paused && !this.v.ended; }
  play() { if (this.v.ended) this.v.currentTime = 0; return this.v.play(); }
  pause() { this.v.pause(); }
  seek(ms) { this.v.currentTime = Math.max(0, ms / 1000); }
  setRate(r) { this.v.playbackRate = r; }
}

class VirtualClock {
  constructor(durationMs) { this.durationMs = durationMs; this._t = 0; this._on = false; this._start = 0; this.rate = 1; }
  time() {
    if (!this._on) return this._t;
    const t = this._t + (performance.now() - this._start) * this.rate;
    if (t >= this.durationMs) { this._t = this.durationMs; this._on = false; return this._t; }
    return t;
  }
  get playing() { this.time(); return this._on; }
  play() { if (this._t >= this.durationMs) this._t = 0; this._start = performance.now(); this._on = true; }
  pause() { this._t = this.time(); this._on = false; }
  seek(ms) { this._t = Math.max(0, Math.min(ms, this.durationMs)); this._start = performance.now(); }
  setRate(r) { this._t = this.time(); this._start = performance.now(); this.rate = r; }
}

// ── Replay ─────────────────────────────────────────────────
export class Replay {
  /**
   * @param {HTMLElement} container
   * @param {{session: object, hands: Array|null, videoUrl: string|null}} opts
   */
  constructor(container, { session, hands, videoUrl }) {
    this.root = container;
    this.s = session;
    this.hands = hands || [];
    this.beatMs = 60000 / session.bpm;
    this.spb = session.speed;
    this.offset = session.videoOffsetMs || 0;
    this.notes = session.notes || [];
    this.totalBeats = session.totalBeats || Math.ceil(this.notes.length / this.spb);
    this.duration = session.durationMs || (this.offset + this.totalBeats * this.beatMs + 1500);

    const ev = session.events || [];
    this.scores = ev.filter(e => e.type === 'swara_score');
    this.talas = ev.filter(e => e.type === 'tala');
    this.readings = ev.filter(e => e.type === 'swara');
    this.talaByBeat = new Map(this.talas.map(e => [e.beat, e]));

    // prefix sums for the live accuracy meters
    this.wPrefix = [0];
    this.scores.forEach(e => this.wPrefix.push(this.wPrefix[this.wPrefix.length - 1] + _swaraWeight(e)));
    this.tPrefix = [0];
    this.talas.forEach(e => this.tPrefix.push(this.tPrefix[this.tPrefix.length - 1] + (e.correct ? 1 : 0)));

    this.markers = this._buildMarkers();
    this.appliedScores = 0;
    this.currentIdx = -1;
    this.dragging = false;
    this._raf = 0;
    this._lastT = -1;

    this._build(videoUrl);
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  // ── markers (mistakes) ───────────────────────────────────
  _buildMarkers() {
    const m = [];
    for (const e of this.scores) {
      if (e.correct) continue;
      const t = this.offset + (e.index / this.spb) * this.beatMs;
      const sang = e.detected === '---' ? 'not detected' : e.detected;
      m.push({ t, kind: 'swara', unsure: isLowConf(e.conf), label: `Swara #${e.index + 1}: expected ${displaySwara(e.expected)}, sang ${sang}` + (e.conf !== undefined ? ` (signal ${e.conf}%)` : '') });
    }
    for (const e of this.talas) {
      if (e.correct) continue;
      const t = this.offset + e.beat * this.beatMs;
      m.push({ t, kind: 'tala', unsure: isLowConf(e.conf), label: `Beat ${e.beat + 1} (${CYCLE[e.akshara].name}): expected ${e.expected}, saw ${e.action}${e.finger ? ' ' + e.finger : ''}` + (e.conf !== undefined ? ` (signal ${e.conf}%, hand ${e.handConf}%)` : '') });
    }
    return m.sort((a, b) => a.t - b.t);
  }

  // ── DOM ──────────────────────────────────────────────────
  _build(videoUrl) {
    const root = this.root;
    root.replaceChildren();
    root.classList.add('replay');

    // left column: stage + controls + notation
    const main = h('div', 'replay-main');

    if (videoUrl) {
      this.stage = h('div', 'replay-stage');
      this.video = document.createElement('video');
      this.video.playsInline = true;
      this.video.preload = 'metadata';
      this.video.src = videoUrl;
      this.canvas = h('canvas');
      this.canvas.width = 1280; this.canvas.height = 720;
      this.stage.append(this.video, this.canvas);
      this.stageMsg = h('div', 'replay-msg', 'Loading video…');
      this.stage.appendChild(this.stageMsg);
      this.video.addEventListener('loadedmetadata', () => {
        const w = this.video.videoWidth, hgt = this.video.videoHeight;
        if (w && hgt) { this.canvas.width = w; this.canvas.height = hgt; this.stage.style.aspectRatio = `${w} / ${hgt}`; this.root.style.setProperty('--ar', (w / hgt).toFixed(4)); }
        this.stageMsg.classList.add('hidden');
        this._lastT = -1;
      });
      this.video.addEventListener('error', () => {
        this.stageMsg.textContent = 'The video could not be loaded (the link may have expired — close and reopen this session).';
        this.stageMsg.classList.remove('hidden');
      });
      this.clock = new MediaClock(this.video, this.duration);
      main.appendChild(this.stage);
    } else {
      main.appendChild(h('div', 'replay-note', 'No video was saved for this session — replaying the analysis only.'));
      this.clock = new VirtualClock(this.duration);
    }

    // controls
    const ctl = h('div', 'replay-controls');
    this.playBtn = h('button', 'icon-btn');
    this.playBtn.type = 'button';
    this.playBtn.setAttribute('aria-label', 'Play / pause');
    this.playBtn.innerHTML = '<span class="when-paused"><i data-lucide="play"></i></span><span class="when-playing hidden"><i data-lucide="pause"></i></span>';
    this.playBtn.addEventListener('click', () => { this.clock.playing ? this.clock.pause() : this.clock.play(); });

    const wrap = h('div', 'replay-slider');
    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = 0;
    this.slider.max = Math.round(this.duration);
    this.slider.step = 10;
    this.slider.value = 0;
    this.slider.setAttribute('aria-label', 'Seek');
    this.slider.addEventListener('pointerdown', () => { this.dragging = true; });
    const endDrag = () => { this.dragging = false; };
    this.slider.addEventListener('pointerup', endDrag);
    this.slider.addEventListener('change', endDrag);
    this.slider.addEventListener('input', () => { this.clock.seek(Number(this.slider.value)); this._lastT = -1; });
    const track = h('div', 'replay-markers');
    for (const mk of this.markers) {
      const b = h('button', `replay-marker ${mk.kind}${mk.unsure ? ' unsure' : ''}`);
      b.type = 'button';
      b.style.left = `${Math.min(100, Math.max(0, (mk.t / this.duration) * 100))}%`;
      b.title = mk.label;
      b.setAttribute('aria-label', mk.label);
      b.addEventListener('click', () => this._seekTo(mk.t - LEAD_IN_MS));
      track.appendChild(b);
    }
    wrap.append(this.slider, track);

    this.timeLabel = h('span', 'replay-time', '0:00');

    this.rateSel = document.createElement('select');
    this.rateSel.className = 'replay-rate';
    this.rateSel.setAttribute('aria-label', 'Playback speed');
    for (const r of [0.5, 0.75, 1, 1.5]) {
      const o = h('option', null, `${r}×`);
      o.value = r;
      if (r === 1) o.selected = true;
      this.rateSel.appendChild(o);
    }
    this.rateSel.addEventListener('change', () => this.clock.setRate(Number(this.rateSel.value)));

    ctl.append(this.playBtn, wrap, this.timeLabel, this.rateSel);
    main.appendChild(ctl);

    // mistake navigation + skeleton toggle
    const nav = h('div', 'replay-nav');
    const prev = h('button', 'icon-btn');
    prev.type = 'button';
    prev.innerHTML = '<i data-lucide="chevron-left"></i> Previous mistake';
    prev.addEventListener('click', () => this._jumpMistake(-1));
    const next = h('button', 'icon-btn');
    next.type = 'button';
    next.innerHTML = 'Next mistake <i data-lucide="chevron-right"></i>';
    next.addEventListener('click', () => this._jumpMistake(1));
    nav.append(prev, next);
    if (this.hands.length && this.canvas) {
      const lab = h('label', 'replay-toggle');
      this.skelToggle = document.createElement('input');
      this.skelToggle.type = 'checkbox';
      this.skelToggle.checked = true;
      this.skelToggle.addEventListener('change', () => { this._lastT = -1; });
      lab.append(this.skelToggle, ' Show tracked hand');
      nav.appendChild(lab);
    }
    const legend = h('span', 'replay-legend');
    legend.innerHTML = '<span class="swara-dot"></span> swara  <span class="tala-dot"></span> tāḷa  · faded = low signal';
    nav.appendChild(legend);
    main.appendChild(nav);

    // notation bar
    this.bar = h('div', 'notation-bar');
    this.notes.forEach((n, i) => { const sp = h('span', 'swara', displaySwara(n)); sp.dataset.i = i; this.bar.appendChild(sp); });
    main.prepend(this.bar);          // notation sits above the video

    // side columns: tāḷa (left) and swara (right), each with its own accuracy bar; the video stays centred
    const sideL = h('div', 'replay-side');
    const sideR = h('div', 'replay-side');

    const talaPanel = h('div', 'meter-panel');
    talaPanel.appendChild(h('h3', null, 'Tāḷa cycle'));
    this.talaBoxes = h('div', 'tala-boxes');
    CYCLE.forEach((c, i) => {
      const b = h('div', 'tala-box', String(i + 1));
      b.appendChild(h('span', 'tala-label', c.name));
      this.talaBoxes.appendChild(b);
    });
    talaPanel.appendChild(this.talaBoxes);
    const meta = h('div', 'tala-meta');
    meta.append(h('span', null, `Mode: ${this.s.mode}`));
    this.cycleLabel = h('span', null, 'Cycle –');
    meta.appendChild(this.cycleLabel);
    talaPanel.appendChild(meta);

    const swaraPanel = h('div', 'meter-panel');
    swaraPanel.appendChild(h('h3', null, 'Swara'));
    const disp = h('div', 'swara-display');
    const pair = h('div', 'swara-pair');
    const cellFor = (label) => {
      const cell = h('div');
      cell.appendChild(h('div', 'swara-label', label));
      const val = h('div', 'detected-swara', '–');
      cell.appendChild(val);
      pair.appendChild(cell);
      return val;
    };
    this.expectedEl = cellFor('Expected');
    this.expectedEl.classList.add('expected-swara');
    this.detectedEl = cellFor('You sang');
    this.centsEl = h('div', 'cents-display', ' ');
    disp.append(pair, this.centsEl);
    const st = h('div', 'strength');
    st.title = 'Swara: pitch voicing x stability. Tala: how strongly the gesture was seen. A heuristic, not a probability.';
    st.appendChild(h('span', 'strength-label', 'Signal'));
    const trk = h('div', 'strength-track');
    this.strengthFill = h('div', 'strength-fill');
    trk.appendChild(this.strengthFill);
    st.appendChild(trk);
    this.strengthVal = h('span', 'strength-val', '–');
    st.appendChild(this.strengthVal);
    disp.appendChild(st);
    swaraPanel.appendChild(disp);

    const row = (label, parent) => {
      const r = h('div', 'meter-row');
      const head = h('div', 'meter-row-head');
      head.appendChild(h('span', null, label));
      const val = h('span', 'meter-val', '–');
      head.appendChild(val);
      const bar = h('div', 'progress-bar');
      const fill = h('div', 'progress-bar-fill');
      fill.style.width = '0%';
      bar.appendChild(fill);
      r.append(head, bar);
      parent.appendChild(r);
      return { val, fill };
    };
    this.talaMeter = row('Tala accuracy so far', talaPanel);
    this.swaraMeter = row('Swara accuracy so far', swaraPanel);

    sideL.appendChild(talaPanel);
    sideR.appendChild(swaraPanel);
    root.append(sideL, main, sideR);

    if (window.lucide) window.lucide.createIcons();
  }

  // ── navigation ───────────────────────────────────────────
  _seekTo(mediaMs) {
    this.clock.seek(Math.max(0, mediaMs));
    this._lastT = -1;
  }

  /** Jump to a moment given in ms from the first beat (used by the results grid). */
  seekToRunTime(runMs) {
    this._seekTo(this.offset + runMs - LEAD_IN_MS);
    this.root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  _jumpMistake(dir) {
    const cur = this.clock.time();
    let target = null;
    if (dir > 0) {
      target = this.markers.find(m => m.t - LEAD_IN_MS > cur + 300);
    } else {
      for (let i = this.markers.length - 1; i >= 0; i--) {
        if (this.markers[i].t - LEAD_IN_MS < cur - 700) { target = this.markers[i]; break; }
      }
    }
    if (target) this._seekTo(target.t - LEAD_IN_MS);
  }

  // ── rendering ────────────────────────────────────────────
  _loop() {
    const t = this.clock.time();
    const playing = this.clock.playing;
    if (t !== this._lastT) {
      this._lastT = t;
      this._render(t);
      if (!this.dragging) this.slider.value = Math.round(t);
      const sec = Math.floor(t / 1000);
      this.timeLabel.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    }
    if (playing !== this._wasPlaying) {
      this._wasPlaying = playing;
      this.playBtn.querySelector('.when-paused').classList.toggle('hidden', playing);
      this.playBtn.querySelector('.when-playing').classList.toggle('hidden', !playing);
    }
    this._raf = requestAnimationFrame(this._loop);
  }

  _render(mediaT) {
    const T = mediaT - this.offset;
    const total = this.totalBeats * this.beatMs;
    const countIn = T < 0;
    const clamped = Math.min(Math.max(T, 0), total - 1);
    const beat = Math.floor(clamped / this.beatMs);
    const ak = beat % 8;
    const progress = clamped / this.beatMs - beat;
    const idx = Math.min(beat * this.spb + Math.min(Math.floor(progress * this.spb), this.spb - 1), this.notes.length - 1);
    const expected = this.notes[idx];

    // notation bar: colour every swara scored so far, mark the current one
    const n = countUpTo(this.scores, T);
    if (n < this.appliedScores) {
      for (const sp of this.bar.children) sp.classList.remove('correct', 'close', 'wrong');
      this.appliedScores = 0;
    }
    for (let i = this.appliedScores; i < n; i++) {
      const e = this.scores[i];
      const sp = this.bar.children[e.index];
      if (sp) sp.classList.add(notationClass(e));
    }
    this.appliedScores = n;
    const cur = countIn ? -1 : idx;
    if (cur !== this.currentIdx) {
      const prev = this.bar.children[this.currentIdx];
      if (prev) prev.classList.remove('current');
      const sp = this.bar.children[cur];
      if (sp) {
        sp.classList.add('current');
        this.bar.scrollTo({ left: sp.offsetLeft - this.bar.clientWidth / 2 + sp.offsetWidth / 2, behavior: 'smooth' });
      }
      this.currentIdx = cur;
    }

    // tāḷa boxes for this cycle (results show up as each beat is scored)
    const cycle = Math.floor(beat / 8);
    [...this.talaBoxes.children].forEach((box, a) => {
      box.classList.remove('current', 'correct', 'wrong', 'has-conf');
      box.style.removeProperty('--conf');
      box.removeAttribute('title');
      const e = this.talaByBeat.get(cycle * 8 + a);
      const scored = e && e.t <= T;
      if (scored && e.conf !== undefined && !(a === ak && !countIn)) {
        box.classList.add('has-conf');
        box.style.setProperty('--conf', e.conf / 100);
        box.title = `Signal strength ${e.conf}%, hand ${e.handConf}%`;
      }
      if (!countIn && a === ak) box.classList.add('current');
      else if (scored) box.classList.add(e.correct ? 'correct' : 'wrong');
    });
    this.cycleLabel.textContent = countIn ? 'Count-in' : `Cycle ${cycle + 1}/${Math.ceil(this.totalBeats / 8)}`;

    // swara: expected vs sung
    this.expectedEl.textContent = countIn ? '–' : displaySwara(expected);
    const ri = countUpTo(this.readings, T) - 1;
    const r = ri >= 0 ? this.readings[ri] : null;
    this.detectedEl.classList.remove('correct', 'wrong');
    if (!countIn && r && T - r.t <= READING_FRESH_MS) {
      this.detectedEl.textContent = r.swara;
      const c = r.cents;
      const hint = Math.abs(c) < 10 ? '~ in tune' : c > 0 ? (c > 30 ? 'too high' : 'slightly high') : (c < -30 ? 'too low' : 'slightly low');
      this.centsEl.textContent = `${c >= 0 ? '+' : ''}${Math.round(c)}¢ ${hint}`;
      this.detectedEl.classList.add(matchSwara(expected, r.swara, c) ? 'correct' : 'wrong');
      this.setStrength(r.conf);
    } else {
      this.detectedEl.textContent = '---';
      this.centsEl.textContent = ' ';
      this.setStrength(null);
    }

    // accuracy so far
    const tn = countUpTo(this.talas, T);
    const sPct = pctOf(this.wPrefix[n], n);
    const tPct = pctOf(this.tPrefix[tn], tn);
    this.swaraMeter.val.textContent = n ? `${sPct}%` : '–';
    this.swaraMeter.fill.style.width = `${sPct}%`;
    this.swaraMeter.fill.style.background = meterColor(sPct);
    this.talaMeter.val.textContent = tn ? `${tPct}%` : '–';
    this.talaMeter.fill.style.width = `${tPct}%`;
    this.talaMeter.fill.style.background = meterColor(tPct);

    this._drawHand(mediaT);
  }

  setStrength(pct) {
    const known = typeof pct === 'number';
    this.strengthFill.style.width = known ? `${pct}%` : '0%';
    this.strengthFill.style.background = known ? meterColor(pct) : '';
    this.strengthVal.textContent = known ? `${pct}%` : '–';
  }

  _drawHand(mediaT) {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.hands.length || (this.skelToggle && !this.skelToggle.checked)) return;
    // latest hand frame at or before this time
    let lo = 0, hi = this.hands.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.hands[mid][0] <= mediaT) lo = mid + 1; else hi = mid; }
    const f = lo > 0 ? this.hands[lo - 1] : null;
    if (!f || !f[1] || mediaT - f[0] > 400) return;
    const pts = [];
    for (let i = 0; i < f[1].length; i += 2) pts.push({ x: f[1][i], y: f[1][i + 1] });
    drawHand(ctx, pts, '#ffc832', false);
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); }
    this.root.classList.remove('replay');
    this.root.replaceChildren();
  }
}

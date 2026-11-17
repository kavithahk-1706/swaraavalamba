/**
 * Swarāvalamba — results view (score cards + swara detail + tāḷa detail).
 * Built purely from a session's saved events, so the practice results screen
 * and the History page render exactly the same thing.
 */
import { CYCLE } from './tala-detect.js';
import { displaySwara, NOT_DETECTED, _swaraWeight, resultClass, pctOf, meterColor, signalTier } from './scoring.js';

/** Scores and grade derived from the session's `swara_score` and `tala` events. */
export function summarize(session) {
  const ev = session.events || [];
  const swaras = ev.filter(e => e.type === 'swara_score');
  const talas = ev.filter(e => e.type === 'tala');
  const sPct = pctOf(swaras.reduce((a, r) => a + _swaraWeight(r), 0), swaras.length);
  const tCorrect = talas.filter(r => r.correct).length;
  const tPct = pctOf(tCorrect, talas.length);
  const overall = Math.floor((sPct + tPct) / 2);
  let grade, cls;
  if (overall >= 80) { grade = 'Excellent!'; cls = 'excellent'; }
  else if (overall >= 60) { grade = 'Good'; cls = 'good'; }
  else if (overall >= 40) { grade = 'Keep practicing'; cls = 'ok'; }
  else { grade = 'Needs work'; cls = 'poor'; }
  return { swaras, talas, sPct, tPct, tCorrect, tN: talas.length, overall, grade, cls };
}

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const signed = c => `${c >= 0 ? '+' : ''}${Math.round(c)}¢`;

function legend(items) {
  const l = h('div', 'legend');
  for (const [color, text, opacity] of items) {
    const s = h('span', null, text);
    s.style.setProperty('--c', color);
    if (opacity !== undefined) s.style.setProperty('--o', opacity);
    l.appendChild(s);
  }
  return l;
}

const tierClass = c => { const t = signalTier(c); return t ? ` sig-${t}` : ''; };

function scoreCard(label, value, pct) {
  const card = h('div', 'card score-card');
  card.appendChild(h('div', 'score-label', label));
  const v = h('div', 'score-value', value);
  v.style.color = meterColor(pct);
  card.appendChild(v);
  const bar = h('div', 'score-bar');
  const fill = h('div', 'score-bar-fill');
  fill.style.width = `${pct}%`;
  fill.style.background = meterColor(pct);
  bar.appendChild(fill);
  card.appendChild(bar);
  return card;
}

/**
 * @param {object} session
 * @param {{title?: string|null, onSeek?: (runMs:number)=>void}} [opts]
 *   title  heading text (omit for none); onSeek  makes cells clickable, called
 *   with the time (ms from the first beat) of that swara / beat.
 */
export function buildResults(session, { title = null, showGrade = true, onSeek = null } = {}) {
  const sum = summarize(session);
  const beatMs = 60000 / session.bpm;
  const spb = session.speed;
  const root = h('div', 'results-view');

  // header + score cards
  if (title || showGrade) {
    const head = h('div', 'results-header');
    if (title) head.appendChild(h('h2', null, title));
    if (showGrade) head.appendChild(h('div', `results-grade ${sum.cls}`, `${sum.grade} · ${sum.overall}%`));
    root.appendChild(head);
  }

  const scores = h('div', 'results-scores');
  scores.append(
    scoreCard('Swara', `${sum.sPct}%`, sum.sPct),
    scoreCard('Tala', `${sum.tCorrect}/${sum.tN} (${sum.tPct}%)`, sum.tPct),
  );
  root.appendChild(scores);

  // swara detail grid
  root.appendChild(h('h3', 'results-section-title', 'Swara detail'));
  const grid = h('div', 'swara-detail-grid');
  for (const r of sum.swaras) {
    const none = NOT_DETECTED.includes(r.detected);
    const wrong = !none && !r.correct;
    const box = h('div', `swara-detail-box ${resultClass(r)}${none ? '' : tierClass(r.conf)}`);
    box.append(displaySwara(r.expected));
    // second line: how far off you were if the note was right, otherwise which note was heard
    if (!none) {
      const small = h('small', null, wrong ? displaySwara(r.detected) : signed(r.cents));
      box.appendChild(small);
    }
    const tip = [`#${r.index + 1}: expected ${displaySwara(r.expected)}`];
    tip.push(none ? 'not detected' : `heard ${displaySwara(r.detected)} (${signed(r.cents)} from that note)`);
    if (!none && r.conf !== undefined) tip.push(`signal ${r.conf}%`);
    box.title = tip.join(' · ');
    if (onSeek) {
      box.classList.add('seekable');
      box.addEventListener('click', () => onSeek((r.index / spb) * beatMs));
    }
    grid.appendChild(box);
  }
  root.appendChild(grid);
  // one compact legend: note colours, then signal strength (lighter = weaker)
  root.appendChild(legend([
    ['var(--success)', 'in tune'], ['#4aa890', 'slightly off'],
    ['var(--warning)', 'wrong, 1 semitone away'], ['#d07020', 'wrong, 2 semitones away'],
    ['var(--error)', 'wrong note'], ['var(--text-muted)', 'not detected'],
    ['var(--text-secondary)', 'signal strong', 1],
    ['var(--text-secondary)', 'medium', 0.78],
    ['var(--text-secondary)', 'weak', 0.5],
  ]));
  const note = h('p', 'results-note',
    'Each box is the expected swara. Cents = how far off you were on the right note; another note name = that note was heard instead. ' +
    'A lighter box means a weaker signal for that detection, so trust its colour less.');
  root.appendChild(note);

  // tala detail: one row of 8 boxes per cycle
  root.appendChild(h('h3', 'results-section-title', 'Tala detail'));
  const rows = h('div', 'tala-detail');
  const cycles = Math.ceil((session.totalBeats || sum.talas.length) / 8);
  const byBeat = new Map(sum.talas.map(e => [e.beat, e]));
  for (let c = 0; c < cycles; c++) {
    const row = h('div', 'tala-row');
    row.appendChild(h('span', 'cyc', `C${c + 1}`));
    const boxes = h('div', 'tala-boxes');
    for (let a = 0; a < 8; a++) {
      const e = byBeat.get(c * 8 + a);
      const box = h('div', 'tala-box', CYCLE[a].name.slice(0, 3));
      if (e) {
        box.classList.add(e.correct ? 'correct' : 'wrong');
        const tier = signalTier(e.conf);
        if (tier) box.classList.add(`sig-${tier}`);
        box.title = `Beat ${e.beat + 1}: ${e.detail}` + (e.conf !== undefined ? ` · signal ${e.conf}% · hand ${e.handConf}%` : '');
        if (onSeek) {
          box.classList.add('seekable');
          box.addEventListener('click', () => onSeek(e.beat * beatMs));
        }
      }
      boxes.appendChild(box);
    }
    row.appendChild(boxes);
    rows.appendChild(row);
  }
  root.appendChild(rows);
  root.appendChild(legend([['var(--success)', 'correct'], ['var(--error)', 'missed']]));
  return root;
}

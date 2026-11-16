/** Score exports: JSON, CSV, PDF (all generated in the browser). */
import { RAGAS } from './swara-detect.js';
import { displaySwara } from './scoring.js';

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const slug = s => String(s).replace(/\s+/g, '-').toLowerCase();
export const baseName = session =>
  `swaravalamba-${slug(session.exercise)}-${Date.parse(session.startedAt) || Date.now()}`;

const ragaName = key => (RAGAS[key] && RAGAS[key].name) || key;
const SPEEDS = { 1: '1st speed', 2: '2nd speed', 4: '3rd speed' };

// ── JSON ───────────────────────────────────────────────────
export function exportJSON(session, hands = null) {
  const out = hands && hands.length ? { ...session, hands } : session;
  downloadBlob(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), `${baseName(session)}.json`);
}

// ── CSV ────────────────────────────────────────────────────
const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per scored swara and per tala beat. Times are ms since the exercise started. */
export function sessionToCSV(session) {
  const head = ['type', 'index', 'time_ms', 'expected', 'detected', 'cents', 'weight', 'correct', 'detail', 'signal_pct', 'hand_pct'];
  const rows = [head];
  for (const e of session.events || []) {
    if (e.type === 'swara_score') {
      rows.push(['swara', e.index + 1, e.t, e.expected, e.detected, Math.round(e.cents), e.weight, e.correct, e.tag, e.conf, '']);
    } else if (e.type === 'tala') {
      rows.push(['tala', e.beat + 1, e.t, e.expected, e.action + (e.finger ? `:${e.finger}` : ''), '', '', e.correct, e.detail, e.conf, e.handConf]);
    }
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\n');
}

export function exportCSV(session) {
  downloadBlob(new Blob([sessionToCSV(session)], { type: 'text/csv' }), `${baseName(session)}.csv`);
}

// ── PDF (jsPDF, loaded on demand) ──────────────────────────
let jspdfPromise = null;
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
  if (!jspdfPromise) {
    jspdfPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      s.onload = () => resolve(window.jspdf.jsPDF);
      s.onerror = () => { jspdfPromise = null; reject(new Error('Could not load the PDF library')); };
      document.head.appendChild(s);
    });
  }
  return jspdfPromise;
}

// jsPDF's built-in fonts only cover Latin-1, so diacritics are flattened here.
const ascii = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

export async function exportPDF(session) {
  const JsPDF = await loadJsPdf();
  const doc = new JsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const M = 48;
  let y = M;
  const line = (text, size = 10, bold = false, gap = 4) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    for (const l of doc.splitTextToSize(ascii(text), W - 2 * M)) {
      if (y > H - M) { doc.addPage(); y = M; }
      doc.text(l, M, y);
      y += size + gap;
    }
  };

  const s = session.summary || {};
  line('Swaravalamba - practice report', 18, true, 8);
  line(`${session.exercise}  |  ${ragaName(session.raga)}  |  ${SPEEDS[session.speed] || session.speed}`, 11, true);
  line(`${new Date(session.startedAt).toLocaleString()}  |  Sa ${session.shruti}  |  ${session.bpm} BPM  |  tala mode: ${session.mode}`, 10, false, 10);
  line(`Overall ${s.overall ?? '-'}%   Swara ${s.swaraPct ?? '-'}%   Tala ${s.talaPct ?? '-'}% (${s.talaCorrect ?? '-'}/${s.talaTotal ?? '-'} beats)`, 12, true, 12);

  const scores = (session.events || []).filter(e => e.type === 'swara_score');
  line('Swaras', 12, true, 6);
  if (!scores.length) line('No scored swaras.');
  for (const e of scores) {
    const det = e.detected === '---' ? 'not detected' : `${e.detected} (${e.cents >= 0 ? '+' : ''}${Math.round(e.cents)} cents)`;
    line(`#${e.index + 1}  expected ${displaySwara(e.expected)}  sang ${det}  ${e.correct ? 'OK' : 'MISS'}${e.conf !== undefined ? `  (signal ${e.conf}%)` : ''}`, 9, false, 2);
  }

  y += 10;
  const tala = (session.events || []).filter(e => e.type === 'tala');
  line('Tala', 12, true, 6);
  if (!tala.length) line('No scored tala beats.');
  for (const e of tala) {
    line(`Beat ${e.beat + 1}  expected ${e.expected}  saw ${e.action}${e.finger ? ` (${e.finger})` : ''}  ${e.correct ? 'OK' : 'MISS'}${e.conf !== undefined ? `  (signal ${e.conf}%, hand ${e.handConf}%)` : ''}`, 9, false, 2);
  }
  doc.save(`${baseName(session)}.pdf`);
}

/**
 * Swarāvalamba — cloud practice history (Supabase: Postgres + Storage).
 *
 * Tables / bucket / policies: supabase/schema.sql. Everything is scoped to the
 * signed-in user by row-level security, so the browser can talk to Supabase
 * directly (no server of our own).
 *
 *   sessions      one light row per session (summary, settings) → fast list
 *   session_data  heavy JSON (events timeline + hand frames) → fetched on demand
 *   recordings/   private storage bucket: {userId}/{sessionId}.mp4|webm
 */
import { getClient } from './supabase.js';
import { getUser } from './auth.js';
import { MAX_SAVED_SESSIONS, MAX_VIDEO_BYTES } from './config.js';

const BUCKET = 'recordings';
const LIST_COLS = 'id,started_at,exercise,raga,speed,mode,shruti,bpm,total_beats,headphones,summary,' +
  'video_path,video_mime,video_bytes,duration_ms,video_offset_ms,has_hands';

async function client() {
  const c = await getClient();
  if (!c) throw new Error('Supabase is not configured (see SETUP.md)');
  if (!getUser()) throw new Error('Not signed in');
  return c;
}

// ── list (with a small local cache for instant first paint) ─
const cacheKey = u => `swaravalamba-list-${u.id}`;

/** Last list we fetched for this user, or null. Show it, then refresh with listSessions(). */
export function cachedList(user = getUser()) {
  if (!user) return null;
  try { return JSON.parse(localStorage.getItem(cacheKey(user))); } catch (e) { return null; }
}

function writeCache(user, rows) {
  try { localStorage.setItem(cacheKey(user), JSON.stringify(rows)); } catch (e) { /* ignore */ }
}

/** Newest-first page of session rows. Pass `before` (an ISO started_at) for the next page. */
export async function listSessions({ limit = 20, before = null } = {}) {
  const c = await client();
  let q = c.from('sessions').select(LIST_COLS).order('started_at', { ascending: false }).limit(limit);
  if (before) q = q.lt('started_at', before);
  const { data, error } = await q;
  if (error) throw error;
  if (!before) writeCache(getUser(), data);
  return data;
}

// ── fetch on demand ────────────────────────────────────────
/** One session's summary row (for the session page). */
export async function getSessionRow(id) {
  const c = await client();
  const { data, error } = await c.from('sessions').select(LIST_COLS).eq('id', id).single();
  if (error) throw error;
  return data;
}

/** Heavy JSON for one session: { timeline (the session object), hands }. */
export async function getSessionData(id) {
  const c = await client();
  const { data, error } = await c.from('session_data').select('timeline,hands').eq('id', id).single();
  if (error) throw error;
  return data;
}

/** Short-lived URL to stream the video (or, with filename, to download it). */
export async function getVideoUrl(path, { download = null, expiresIn = 3600 } = {}) {
  const c = await client();
  const { data, error } = await c.storage.from(BUCKET).createSignedUrl(path, expiresIn, download ? { download } : undefined);
  if (error) throw error;
  return data.signedUrl;
}

// ── save ───────────────────────────────────────────────────
const extFor = mime => (mime && mime.includes('mp4') ? 'mp4' : 'webm');

/**
 * Save a finished session.
 * @param {object} p
 * @param {object} p.session  the session object recorded by practice.js
 * @param {Array|null} p.hands  hand-landmark frames
 * @param {{blob: Blob, mime: string, durationMs: number}|null} p.video
 * @returns {{videoSkipped: boolean}}
 */
export async function saveSession({ session, hands, video }) {
  const c = await client();
  const user = getUser();
  const id = crypto.randomUUID();

  let videoPath = null, videoSkipped = false;
  if (video && video.blob) {
    if (video.blob.size > MAX_VIDEO_BYTES) {
      videoSkipped = true;
    } else {
      videoPath = `${user.id}/${id}.${extFor(video.mime)}`;
      const { error } = await c.storage.from(BUCKET).upload(videoPath, video.blob, {
        contentType: (video.mime || 'video/webm').split(';')[0], upsert: false,
      });
      if (error) throw error;
    }
  }

  const row = {
    id,
    started_at: session.startedAt,
    exercise: session.exercise, raga: session.raga, speed: session.speed, mode: session.mode,
    shruti: session.shruti, bpm: session.bpm, total_beats: session.totalBeats,
    headphones: Boolean(session.headphones),
    summary: session.summary || null,
    video_path: videoPath,
    video_mime: videoPath ? (video.mime || '').split(';')[0] : null,
    video_bytes: videoPath ? video.blob.size : null,
    duration_ms: session.durationMs ?? null,
    video_offset_ms: session.videoOffsetMs ?? null,
    has_hands: Boolean(hands && hands.length),
  };

  const rollback = async () => {
    try {
      if (videoPath) await c.storage.from(BUCKET).remove([videoPath]);
      await c.from('sessions').delete().eq('id', id);
    } catch (e) { /* best effort */ }
  };

  let r = await c.from('sessions').insert(row);
  if (r.error) { await rollback(); throw r.error; }
  r = await c.from('session_data').insert({ id, timeline: session, hands: hands && hands.length ? hands : null });
  if (r.error) { await rollback(); throw r.error; }

  await enforceCap(c).catch(e => console.warn('History cleanup failed:', e));
  return { videoSkipped };
}

/** Keep only the newest MAX_SAVED_SESSIONS sessions (deleting extra rows + videos). */
async function enforceCap(c) {
  const { data, error } = await c.from('sessions').select('id,video_path')
    .order('started_at', { ascending: false }).range(MAX_SAVED_SESSIONS, MAX_SAVED_SESSIONS + 200);
  if (error) throw error;
  if (!data.length) return;
  const paths = data.map(r => r.video_path).filter(Boolean);
  if (paths.length) await c.storage.from(BUCKET).remove(paths);
  await c.from('sessions').delete().in('id', data.map(r => r.id));   // session_data cascades
}

// ── delete ─────────────────────────────────────────────────
export async function deleteSession(row) {
  const c = await client();
  if (row.video_path) await c.storage.from(BUCKET).remove([row.video_path]);
  const { error } = await c.from('sessions').delete().eq('id', row.id);
  if (error) throw error;
}

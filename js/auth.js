/**
 * Swarāvalamba — Google sign-in via Supabase Auth.
 *
 * Importing this module renders the sign-in button / user chip into #authSlot
 * (if the page has one). Credentials: see js/config.js and SETUP.md.
 */
import { getClient, isConfigured } from './supabase.js';

const listeners = new Set();
let user = null;

export { isConfigured };
export const getUser = () => user;

/** Subscribe to sign-in / sign-out. Called immediately with the current user. */
export function onAuthChange(fn) {
  listeners.add(fn);
  fn(user);
  return () => listeners.delete(fn);
}

function toUser(session) {
  const u = session && session.user;
  if (!u) return null;
  const m = u.user_metadata || {};
  const pic = m.avatar_url || m.picture || '';
  return {
    id: u.id,
    name: m.full_name || m.name || u.email || 'Signed in',
    email: u.email || '',
    picture: typeof pic === 'string' && pic.startsWith('https://') ? pic : '',
  };
}

function setUser(u) {
  const changed = (u && u.id) !== (user && user.id);
  user = u;
  render();
  if (changed || listeners.size) listeners.forEach(fn => fn(user));
}

export async function signIn() {
  const c = await getClient();
  if (!c) { notConfigured(); return; }
  const { error } = await c.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) { console.error(error); alert('Could not start Google sign-in: ' + error.message); }
}

export async function signOut() {
  const c = await getClient();
  if (c) await c.auth.signOut();
  setUser(null);
}

function notConfigured() {
  alert('Sign-in is not set up yet.\n\nAdd your Supabase URL and publishable key to js/config.js (see SETUP.md).');
}

// ── UI ─────────────────────────────────────────────────────
function icons() {
  if (window.lucide) window.lucide.createIcons();
}

function render() {
  const slot = document.getElementById('authSlot');
  if (!slot) return;
  slot.replaceChildren();

  if (user) {
    const chip = document.createElement('div');
    chip.className = 'auth-chip';
    if (user.picture) {
      const img = document.createElement('img');
      img.className = 'auth-avatar';
      img.src = user.picture;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      chip.appendChild(img);
    }
    const name = document.createElement('span');
    name.className = 'auth-name';
    name.textContent = user.name;
    name.title = user.email;
    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'auth-signout';
    out.title = 'Sign out';
    out.setAttribute('aria-label', 'Sign out');
    out.innerHTML = '<i data-lucide="log-out"></i>';
    out.addEventListener('click', signOut);
    chip.append(name, out);
    slot.appendChild(chip);
  } else {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-outline auth-signin';
    b.innerHTML = '<i data-lucide="log-in"></i> Sign in with Google';
    b.addEventListener('click', signIn);
    slot.appendChild(b);
  }
  icons();
}

render();

if (isConfigured) {
  getClient().then(c => {
    c.auth.getSession().then(({ data }) => setUser(toUser(data.session)));
    c.auth.onAuthStateChange((_event, session) => setUser(toUser(session)));
  }).catch(e => console.error('Could not load Supabase:', e));
}

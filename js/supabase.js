/** Lazy Supabase client (loaded from a CDN only when the project is configured). */
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

// Accept either the full URL or just the project ref.
const url = /^https?:\/\//.test(SUPABASE_URL) ? SUPABASE_URL.replace(/\/+$/, '') : `https://${SUPABASE_URL}.supabase.co`;

export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);

if (isConfigured && !SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_')) {
  console.warn(
    'js/config.js: the key does not look like a publishable key (sb_publishable_...). ' +
    'Legacy anon/service_role keys are being retired — see SETUP.md. ' +
    'Never put a secret key (sb_secret_...) or service_role key in browser code.');
}

let clientPromise = null;

/** Resolves to the Supabase client, or null if config.js has no credentials yet. */
export function getClient() {
  if (!isConfigured) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.6/+esm')
      .then(({ createClient }) => createClient(url, SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      }))
      .catch(e => { clientPromise = null; throw e; });
  }
  return clientPromise;
}

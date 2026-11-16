// Swarāvalamba configuration.
//
// ┌─ WHERE TO PUT YOUR CREDENTIALS ───────────────────────────────────────────┐
// │ Paste your Supabase project URL and PUBLISHABLE key below (steps: SETUP.md)│
// │ Both are public by design (they ship to the browser); your data is         │
// │ protected by the row-level-security policies in supabase/schema.sql.       │
// │ NEVER put the secret key (sb_secret_...) or a legacy service_role key in   │
// │ this repo or any browser code.                                             │
// │                                                                            │
// │ Google sign-in: the Google OAuth client ID + secret go in the Supabase     │
// │ dashboard (Authentication → Providers → Google), NOT in this file.         │
// └────────────────────────────────────────────────────────────────────────────┘
export const SUPABASE_URL = 'https://kvhbnfpqtegfrsazblvi.supabase.co';   // Project Settings → API → Project URL
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_9-HZh1Q8-LCLLgRmRzA6Sg_iq08NL-G';   // API Keys → Publishable key → "default" (starts with sb_publishable_)

// History cap: only the newest N saved sessions are kept (older ones, and their
// videos, are deleted automatically when a new one is saved).
export const MAX_SAVED_SESSIONS = 30;

// Supabase's free plan allows 50 MB per file. Longer recordings are saved
// without the video (the analysis is still kept).
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

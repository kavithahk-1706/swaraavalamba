# Swarāvalamba — cloud setup (free, no card)

The site is static (HTML + JS). Sign-in, the practice history and the recorded
videos live in a free **Supabase** project that the browser talks to directly,
so there is no server of your own to run. Deploy the folder to Vercel as a
plain static site (no build command, output directory = the project root).

## 1. Create the Supabase project
1. Sign up at https://supabase.com (free plan, no payment method needed) and create a project.
2. **SQL Editor** → paste the contents of `supabase/schema.sql` → Run.
   This creates the tables, the private `recordings` bucket and the security policies.

## 2. Google sign-in
1. In Google Cloud Console → *APIs & Services → Credentials*, open your OAuth client (Web application).
2. Add this under **Authorized redirect URIs**: `https://<your-project-ref>.supabase.co/auth/v1/callback`
3. In Supabase → **Authentication → Providers → Google**: enable it and paste the Google **Client ID** and **Client secret**.
4. In Supabase → **Authentication → URL Configuration**:
   - Site URL: your Vercel URL, e.g. `https://swaraavalamba.vercel.app`
   - Redirect URLs: add `http://localhost:8000/**` and `https://swaravalamba.vercel.app/**`

## 3. Put the keys in the code
Supabase is retiring the legacy `anon` / `service_role` JWT keys (end of 2026) in favour of
**publishable** (`sb_publishable_...`) and **secret** (`sb_secret_...`) keys. This app uses the new ones.

In the Supabase dashboard open **Project Settings → API Keys**, and on the *Publishable key* panel
copy the `default` key. Then open `js/config.js` and fill in:
- `SUPABASE_URL` — *Project URL*, e.g. `https://abcdxyz.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY` — the `sb_publishable_...` key

The publishable key is safe to commit: it only has the low `anon` / `authenticated` privileges, and the
row-level-security policies in `supabase/schema.sql` are what protect the data.

**Do not use the secret key here.** `sb_secret_...` (and the legacy `service_role` key) bypass row-level
security and must only live in server-side code. This app has no server, so it never needs one. If you
add Vercel functions later, put the secret key in Vercel's Environment Variables, never in a file.

You can disable the legacy keys (Project Settings → API Keys → *Disable JWT-based API keys*) once the
publishable key is working. Users' sign-in tokens are unaffected.

## 4. Run locally
```
python -m http.server 8000
```
then open http://localhost:8000/practice.html

## Free-plan limits (check Supabase's current pricing page)
- Roughly 1 GB file storage and 500 MB database shared by all users, 50 MB per file.
  Videos are ~1.2 Mbps, so a 1-minute run is roughly 9 MB.
- The app keeps only each user's newest 30 sessions (`MAX_SAVED_SESSIONS` in `js/config.js`).
- Free projects are paused after about a week without activity; you can resume them from the dashboard.

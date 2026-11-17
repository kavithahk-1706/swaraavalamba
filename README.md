# Swarāvalamba · स्वरावलम्ब

A real-time Carnatic music practice companion that runs entirely in the browser. It watches your
hands (tāḷa) through the webcam and listens to your voice (swara) through the microphone at the
same time, scores both against an exercise, and lets you save and replay sessions.

The name is Sanskrit: *svara* (musical note) + *avalamba* (support), "support through swaras".
Presented at Swara Tank, Chowdiah Sangeetha Mela 2026.

## Features

- **Tāḷa tracking:** hand landmarks via MediaPipe Hand Landmarker, classified per beat as a finger
  count, beat (wrist dip) or wave (palm flip), in air, palm and lap modes.
- **Swara detection:** autocorrelation pitch detection on the Web Audio API, mapped to the nearest
  swara for your shruti with raga-aware naming and cents deviation.
- **Exercises:** Sarali 1–3 and Dātu Swara, in 1st, 2nd and 3rd speed, with a count-in, a metronome
  and an optional tanpura drone that follows your shruti (C to B).
- **Scoring:** weighted partial credit per swara, per-beat tāḷa scoring, live accuracy meters and a
  signal-strength readout for each detection.
- **Sessions (signed in with Google):** optionally record camera and audio, then save or discard.
  Saved sessions open on the History page as a replay: the video plays with the notation, tāḷa boxes,
  swara display and tracked hand redrawn from the saved timeline, with markers for each mistake.
- **Exports:** JSON, CSV and PDF reports; the video downloads separately.

## Run locally

It is a static site, but the JavaScript uses ES modules, so it must be served over http (not opened
from `file://`). The camera and microphone also need `localhost` or https.

```bash
python -m http.server 8000
```

Then open <http://localhost:8000/practice.html>. Use your **right hand** in front of the camera, and
earphones are recommended so the mic doesn't pick up the click and drone.

Practice, scoring and exports work without any setup. Sign-in, history and recordings need the
cloud setup below.

## Cloud setup (sign-in, history, video)

Google sign-in, the practice history and recorded videos use a free
[Supabase](https://supabase.com) project that the browser talks to directly, so there is no server
of your own. Follow **[SETUP.md](SETUP.md)**:

1. Create the project and run [`supabase/schema.sql`](supabase/schema.sql) (tables, private storage
   bucket and row-level-security policies).
2. Enable the Google provider in Supabase and set the redirect URLs.
3. Put the project URL and **publishable** key (`sb_publishable_…`) in [`js/config.js`](js/config.js).

The publishable key is safe to commit. Never put a secret key (`sb_secret_…`) or the legacy
`service_role` key anywhere in this repo.

## Deploy

Deploy the folder to Vercel (or any static host) as a plain static site: no build command, output
directory is the project root. Add the deployed URL to Supabase's redirect URLs.

## Project layout

```
index.html, about.html     landing and about pages
practice.html              the practice page (camera, tāḷa, swara, settings)
history.html               list of saved sessions
session.html               one session: video replay beside its results
css/style.css              palm-leaf theme and shared components
assets/                    tanpura_c_loop.mp3 (the hand model is downloaded, see below)
supabase/schema.sql        database + storage schema and security policies
js/
  practice.js              state machine: menu → count-in → running → results; scoring; saving
  swara-detect.js          swara tables, ragas, pitch detection, tanpura player
  tala-detect.js           hand-gesture signals and tāḷa classification (MediaPipe)
  scoring.js               scoring helpers shared by practice and replay
  recorder.js              MediaRecorder video capture, headphone helper
  replay.js                replay view driven by the saved timeline
  results-view.js          score cards + swara/tāḷa detail (practice results and session page)
  history.js               cloud save / list / load (Supabase)
  auth.js, supabase.js     Google sign-in and the Supabase client
  export.js                JSON / CSV / PDF export
  config.js                Supabase URL and key, history cap, video size limit
```

## Notes

- **Hand model:** `assets/hand_landmarker.task` is git-ignored. If it is absent, the app downloads
  Google's hosted copy on load. To work offline, place the file in `assets/` yourself.
- **Recording:** video is MP4 where the browser supports recording it, otherwise WebM. It is off by
  default, needs sign-in and a one-time consent, and is only uploaded if you choose "Save to
  history". With headphones on, the click and tanpura are mixed into the recording; with speakers
  they are left out because the mic already hears them.
- **Free-plan limits:** the history keeps each user's newest 30 sessions, and a video over 50 MB is
  saved without the video. Both limits are in `js/config.js`.
- **Heuristic scores:** the "signal strength" values are heuristic indicators, not probabilities.
- **Origin:** the detection logic is ported from an earlier Python/OpenCV desktop demo.

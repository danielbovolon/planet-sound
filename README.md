# Planet Sound

An open archive of the world’s sound: field recordings kept at the place and moment they were made.
Live at **planetsound.danielbovolon.com**.

```
/                    the website (GitHub Pages serves this folder as is, no build step)
  index.html         the app
  admin.html         your page: every entry, public and private, with Remove
  config.js          ← put your API address here
  sw.js              offline support (bump VERSION after each deploy)
  assets/            css, js, fonts, logo, icons
  vendor/maplibre/   map library (MapLibre GL 6, BSD licence)
api/                 the backend: one Cloudflare Worker + D1 database + R2 file storage
```

## What runs where

| Part | Service | Free allowance | Sleeps? |
|---|---|---|---|
| Website | GitHub Pages | unlimited for this | never |
| API | Cloudflare Workers | 100,000 requests/day | never |
| Catalogue | Cloudflare D1 | 5 GB, 5M reads/day | never |
| Audio, images | Cloudflare R2 | 10 GB stored, downloads free | never |
| Map | OpenFreeMap (vector) + Esri (imagery) | no key, no quota | never |

Nothing pauses. The only limit you’ll meet as the archive grows is R2’s 10 GB. Lossless 24-bit FLAC runs about 6 MB per mono minute and 12 MB per stereo minute, so that’s roughly 14–28 hours of recordings. Beyond that R2 costs about US$0.015 per GB per month. `admin.html` shows how much you’re using.

---

## 1. Backend (Cloudflare), about 15 minutes

You need Node 18+ and a free Cloudflare account.

```bash
cd api
npm install
npx wrangler login                                   # opens the browser

npx wrangler d1 create planet-sound                  # prints a database_id
#   → paste that id into api/wrangler.toml (database_id = "...")

npx wrangler r2 bucket create planet-sound-media     # first time: enable R2 in the dashboard
                                                     # (Cloudflare may ask for a card; nothing is
                                                     #  charged within the free allowance)
npm run db:init                                      # creates the tables

npx wrangler secret put ADMIN_TOKEN                  # make up a long random password for admin.html

npm run deploy                                       # prints https://planet-sound-api.<you>.workers.dev
```

Open that address + `/api/health`. It should answer `{"ok":true,...}`.

## 2. Website

1. Put the Worker address into `config.js` (`apiBase`, no trailing slash).
2. Replace the contents of the GitHub repo that serves planetsound.danielbovolon.com with this folder. `CNAME` is already in place.
3. Commit and push. GitHub Pages publishes in a minute or two.

Whenever you change website files later, bump `VERSION` in `sw.js` so phones pick up the new version.

## How it works

**Recording.** The microphone is opened with echo cancellation, noise suppression and auto gain turned
off. Samples go from an AudioWorklet straight to a background worker, which encodes **24-bit FLAC** as
the take runs, so even an hour-long take never sits in memory as raw audio. The same worker measures
**integrated loudness (EBU R128 / ITU-R BS.1770-4)**, sample peak, clipped samples, a background level (the
quietest tenth of the take), a waveform and a log-frequency spectrogram. The encoder and the loudness
meter were checked against ffmpeg: decoding is bit-exact, and LUFS matches to 0.1 LU.

**Imports.** WAV becomes FLAC losslessly at its own bit depth. FLAC, MP3, AAC, Ogg/Opus and AIFF are
stored untouched and only measured.

**Catalogue metadata travels with the file.** Title, credit, date, place, coordinates, notes and
equipment are written into the FLAC’s Vorbis comments, so a downloaded master is self-describing.

**Playback** streams the original file with a level-matching gain (target −20 LUFS, peaks never above
−1 dBFS), which listeners can switch off. The file itself is never altered.

**No sign-up.** Publishing the first recording creates a *listener key* (`PS-XXXXX-…`). It proves
ownership, so only its holder can edit their recordings. It also moves the archive to another
device (Your archive → Copy a link for another device). Only a hash of the key is stored on the server.
There is no email, so a lost key can’t be recovered; the app says so plainly.

**Offline.** The app shell and map tiles you’ve viewed are cached. A recording published with no signal
waits on the device and uploads itself when the connection returns.

**Removing entries.** Only you can remove entries, contributors included: open
`https://planetsound.danielbovolon.com/admin.html`, enter your `ADMIN_TOKEN`, and press *Remove* next
to any entry. The entry and its files are deleted for good.

**Limits** (in `api/src/index.js`, `LIMITS`): 60 new entries and 3 GB of uploads per listener per day,
25 new listener keys per network per day, 1 GB per recording. Uploads that never became an entry are
removed daily.

## Local development

```bash
cd api && npm install
printf 'ADMIN_TOKEN=dev\n' > .dev.vars
npm run db:init:local && npm run dev                 # API on http://127.0.0.1:8787
# in another terminal, from the repo root:
python3 -m http.server 8080                          # site on http://127.0.0.1:8080
```
For local testing, set `apiBase` in `config.js` to `http://127.0.0.1:8787`.

## Credits

Map data © OpenStreetMap contributors, vector tiles by OpenFreeMap, imagery © Esri. Fonts: Libre
Franklin and Newsreader (SIL Open Font License). Map rendering: MapLibre GL JS (BSD-3-Clause).

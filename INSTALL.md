# Planet Sound — Tape + Multiband update (2026-10-20)

## Upload
Upload every file in this folder to the same path in your GitHub repo, **in one commit**
(keep the folder structure: index.html and sw.js at the root, the rest under assets/…).
New files: assets/css/fx.css, assets/js/fx.js, fxui.js, fxexport.js, audio/fx-dsp.js, audio/sat-worklet.js.
You can delete assets/js/audio/ott-worklet.js (no longer used).
capture-worklet.js and take-worker.js are unchanged.

## After it deploys
Hard refresh the site. On the phone app, open it twice so the new service worker (ps-2026-10-20a) takes over.

## What changed
- Recording panel: only an analog-style Gain (−24 … +36 dB), set before you record. Soft peaks apply when gain > 0.
- Entry panel, "Sound shaping": Tape (speed, pitch, wow, saturate, tube, overdrive, compress, warmth, high/low-pass, hiss, slap echo, volume; cassette / 7½ / 15 / 30 ips) and a 3-band Multiband compressor (above/below thresholds and ratios, attack, release, in/out per band, solo, draggable crossovers, amount, time, range, output, RMS/Peak, soft/hard knee).
- "Download WAV" → "Export WAV", "Download spectrogram" → "Export spectrogram"; both render the sound as currently shaped. The WAV's description notes the processing.
- Listener key removed.

## Notes
Knobs reset for each entry. Export needs downloads allowed on the entry. Level matching is not applied in the export.
Pitch uses a phase vocoder (~2048 samples latency). Tested headless only — please listen on your phone and tune presets to taste.

/* Planet Sound — getting a recording into the page, shaped, for Export WAV and Export spectrogram.
 * Shared by share.js (the WAV) and app.js (the spectrogram). */
import { fxState, renderFx, spectrogram } from './fx.js';

/** Download a file, reporting progress (0..1) as it arrives. */
export async function fetchAudio(url, expected, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('The recording could not be downloaded.');
  const total = Number(r.headers.get('Content-Length')) || expected || 0;
  if (!r.body || !total) return r.arrayBuffer();
  const rd = r.body.getReader(), parts = []; let got = 0;
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    parts.push(value); got += value.length; if (onProgress) onProgress(got / total);
  }
  return new Blob(parts).arrayBuffer();
}
/** Decode at the recording's own sample rate where the browser allows it. */
export async function decodeAudio(ab, rate) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx; try { ctx = new AC({ sampleRate: rate || undefined }); } catch { ctx = new AC(); }
  try { return await ctx.decodeAudioData(ab); } finally { ctx.close().catch(() => {}); }
}
/** Decode and shape a recording with the settings on screen. Returns { chs, rate } (up to 8 channels). */
export async function shapedChannels(ab, sound, onProgress) {
  const buf = await decodeAudio(ab, sound.tech && sound.tech.sampleRate);
  let chs = Array.from({ length: Math.min(buf.numberOfChannels, 8) }, (_, c) => buf.getChannelData(c));
  if (!fxState.neutral()) chs = await renderFx(chs, buf.sampleRate, fxState.get(), onProgress);
  return { chs, rate: buf.sampleRate };
}
/** A PNG spectrogram of the shaped sound, through the given palette (256-entry RGB table). */
export async function shapedSpectrogramBlob(url, sound, lut, onProgress) {
  const ab = await fetchAudio(url, sound.tech && sound.tech.audioBytes, f => onProgress && onProgress(f * 0.3));
  const { chs, rate } = await shapedChannels(ab, sound, f => onProgress && onProgress(0.3 + f * 0.5));
  const cv = await spectrogram(chs, rate, { lut });
  if (onProgress) onProgress(1);
  return new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('image'))), 'image/png'));
}

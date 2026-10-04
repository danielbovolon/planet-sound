/* Encoder + analyser, off the UI thread. One worker per take. */
import { FlacEncoder } from './flac.js';
import { Analyzer } from './analysis.js';

let enc = null, an = null, channels = 1, ended = null, lastProgress = 0;
let dualMono = true, gotEnd = false;

function feed(chs) {
  if (dualMono && chs.length === 2) {
    const a = chs[0], b = chs[1];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { dualMono = false; break; }
  }
  if (enc) enc.pushFloat(chs);
  an.push(chs);
  const now = Date.now();
  if (now - lastProgress > 250) {
    lastProgress = now;
    postMessage({ type: 'progress', seconds: an.samples / an.fs, bytes: enc ? enc.bytes : 0 });
  }
}

onmessage = e => {
  const d = e.data;
  if (d.type === 'init') {
    channels = d.channels;
    enc = d.encode === false ? null : new FlacEncoder({ sampleRate: d.sampleRate, channels, bitsPerSample: d.bits || 24 });
    an = new Analyzer(d.sampleRate, channels);
    dualMono = channels === 2;
    if (d.port) {
      d.port.onmessage = m => {
        if (m.data.chs) feed(m.data.chs);
        if (m.data.end) { gotEnd = true; if (ended) ended(); }
      };
    }
  } else if (d.type === 'data') {
    feed(d.chs);
  } else if (d.type === 'finish') {
    const done = () => {
      const analysis = an.result();
      analysis.dualMono = channels === 2 && dualMono && an.samples > 0;
      const blob = enc ? enc.finish(d.tags || {}) : null;
      postMessage({ type: 'done', blob, analysis });
    };
    if (d.waitForEnd && !gotEnd) ended = done; else done();
  }
};

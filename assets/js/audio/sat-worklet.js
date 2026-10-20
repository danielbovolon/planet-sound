/* Planet Sound — recorder input stage: the "analog" part of the Gain knob (AudioWorklet).
 *
 * Gain itself is a plain, exact multiplication (done before this stage). What this stage adds is how
 * a boosted signal behaves when it gets loud: like a preamp, not like a digital meter.
 *   - up to -3 dBFS the signal passes through untouched, sample for sample;
 *   - above that the peaks are rounded off smoothly (the slope is continuous, so there is no kink)
 *     and approach full scale without ever hard-clipping.
 * `drive` is 0 or 1. With it off (gain at or below 0 dB, where nothing can be pushed over) the stage
 * is a plain copy. */
const T = 0.7079;            // -3 dBFS: where the rounding starts
const R = 1 - T;
function soft(x) {
  const a = Math.abs(x);
  if (a <= T) return x;
  const y = T + R * Math.tanh((a - T) / R);
  return x < 0 ? -y : y;
}
if (typeof registerProcessor === 'function') {
  class PsSat extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [{ name: 'drive', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
    }
    process(inputs, outputs, parameters) {
      const inp = inputs[0], out = outputs[0];
      if (!out || !out.length) return true;
      if (!inp || !inp.length) { for (const ch of out) ch.fill(0); return true; }
      const on = parameters.drive[0] >= 0.5;
      for (let c = 0; c < out.length; c++) {
        const x = inp[c] || inp[0], y = out[c];
        if (!on) y.set(x); else for (let i = 0; i < y.length; i++) y[i] = soft(x[i]);
      }
      return true;
    }
  }
  registerProcessor('ps-sat', PsSat);
}
if (typeof module !== 'undefined') module.exports = { soft, T };

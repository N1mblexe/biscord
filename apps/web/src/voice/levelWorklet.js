/* global AudioWorkletProcessor, registerProcessor, sampleRate */

/**
 * The mic level meter's AudioWorklet (voice/levelMeter.ts): posts the RMS level (0–1) of the first
 * input channel about every 20 ms. Plain JS, loaded as a file from our own origin, so it works under
 * the CSP `script-src 'self'` (never a data: or blob: URL).
 */
class HearthLevelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.count = 0;
    this.window = Math.max(128, Math.round(sampleRate * 0.02));
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        const v = channel[i];
        this.sum += v * v;
      }
      this.count += channel.length;
    } else {
      // No input (the track is muted or ended): count silence so the meter falls.
      this.count += 128;
    }
    if (this.count >= this.window) {
      this.port.postMessage(Math.sqrt(this.sum / this.count));
      this.sum = 0;
      this.count = 0;
    }
    return true;
  }
}

registerProcessor('hearth-level', HearthLevelProcessor);

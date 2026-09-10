/**
 * AudioWorklet that plays interleaved stereo Float32 chunks pushed over its port.
 *
 * Chunks queue up; when the queue runs dry the processor outputs silence and
 * waits until `minStart` samples are available before resuming, so a slow
 * generator produces clean gaps instead of 128-sample crackle. It reports the
 * number of samples consumed every ~100 ms so the generator can pace itself.
 */
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];          // Float32Array chunks (interleaved L R)
    this.offset = 0;          // sample-frame offset into queue[0]
    this.queued = 0;          // sample frames waiting in the queue
    this.consumed = 0;        // total sample frames played (excluding silence)
    this.underruns = 0;
    this.starved = true;      // waiting for the buffer to refill
    this.minStart = 4800;     // 100 ms
    this.sinceReport = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pcm') { this.queue.push(m.pcm); this.queued += m.pcm.length / 2; }
      else if (m.type === 'reset') { this.queue = []; this.offset = 0; this.queued = 0; this.starved = true; }
      else if (m.type === 'minStart') this.minStart = m.frames;
      else throw new Error('pcm-worklet: unknown message ' + m.type);
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    if (this.starved && this.queued >= this.minStart) this.starved = false;
    let i = 0;
    if (!this.starved) {
      while (i < n && this.queue.length) {
        const chunk = this.queue[0];
        const avail = chunk.length / 2 - this.offset;
        const take = Math.min(avail, n - i);
        for (let k = 0; k < take; k++) {
          L[i + k] = chunk[(this.offset + k) * 2];
          R[i + k] = chunk[(this.offset + k) * 2 + 1];
        }
        i += take; this.offset += take; this.queued -= take; this.consumed += take;
        if (this.offset * 2 >= chunk.length) { this.queue.shift(); this.offset = 0; }
      }
      if (i < n) { this.starved = true; this.underruns++; }
    }
    for (; i < n; i++) { L[i] = 0; R[i] = 0; }
    this.sinceReport += n;
    if (this.sinceReport >= 4800) {
      this.sinceReport = 0;
      this.port.postMessage({ type: 'status', consumed: this.consumed, queued: this.queued, underruns: this.underruns, starved: this.starved });
    }
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);

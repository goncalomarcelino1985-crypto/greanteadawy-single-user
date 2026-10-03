/* global AudioWorkletProcessor, registerProcessor, currentFrame */
// AudioWorklet for the recorder: copies the microphone input while recording and posts it to the studio in blocks of
// ~4096 frames, each with the audio-context frame its first sample was captured at (so the take can be lined up with
// the song exactly). Nothing else runs here.
class GtdRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.block = 4096;
    this.fill = 0;
    this.bufs = null;
    this.first = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.fill = 0; this.bufs = null; }
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
      else if (e.data === 'close') { this.on = false; this.closed = true; }
    };
  }

  flush() {
    if (!this.bufs || !this.fill) return;
    const data = this.bufs.map((b) => b.slice(0, this.fill));
    this.port.postMessage({ frame: this.first, data }, data.map((d) => d.buffer));
    this.bufs = null;
    this.fill = 0;
  }

  process(inputs) {
    if (this.closed) return false; // the microphone was released: let the node be collected
    const input = inputs[0];
    if (!this.on || !input || !input.length) return true;
    const n = input[0].length;
    if (!this.bufs) {
      this.bufs = input.map(() => new Float32Array(this.block));
      this.first = currentFrame;
    }
    for (let ch = 0; ch < this.bufs.length; ch++) this.bufs[ch].set(input[Math.min(ch, input.length - 1)], this.fill);
    this.fill += n;
    if (this.fill + n > this.block) this.flush();
    return true;
  }
}

registerProcessor('gtd-recorder', GtdRecorder);

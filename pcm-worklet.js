// Plays 16-bit PCM pushed from the Windows helper into the recording's mix.
// Arrives in ~250 ms blocks at the context's sample rate; an empty queue
// plays silence, and more than 2 s queued drops the oldest audio so a
// burst after a stall cannot add lasting delay.

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queued = 0;
    this.port.onmessage = ({ data }) => {
      this.queue.push(data);
      this.queued += data.length;
      while (this.queued - this.offset > sampleRate * 2 && this.queue.length > 1) {
        this.queued -= this.queue.shift().length;
        this.offset = 0;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      const block = this.queue[0];
      if (!block) {
        out[i] = 0;
        continue;
      }
      out[i] = block[this.offset++] / 32768;
      if (this.offset >= block.length) {
        this.queue.shift();
        this.queued -= block.length;
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);

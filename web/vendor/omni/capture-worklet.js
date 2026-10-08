class CaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.frames = []; this.count = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    this.frames.push(new Float32Array(input)); this.count += input.length;
    if (this.count >= sampleRate * .05) {
      const merged = new Float32Array(this.count);
      let offset = 0;
      for (const frame of this.frames) { merged.set(frame, offset); offset += frame.length; }
      this.port.postMessage(merged, [merged.buffer]); this.frames = []; this.count = 0;
    }
    return true;
  }
}
registerProcessor('voice-capture', CaptureProcessor);

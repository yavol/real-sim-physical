export class SpeechGuide {
  constructor(callbacks) { this.callbacks = callbacks; this.cache = new Map(); this.generation = 0; }
  async unlock() {
    this.context ??= new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
  }
  stop() {
    this.generation++;
    this.controller?.abort();
    if (this.source) { this.source.onended = null; try { this.source.stop(); } catch { /* Already ended. */ } this.source = null; }
    cancelAnimationFrame(this.meterFrame);
    this.callbacks.onLevel(0); this.callbacks.onState('idle');
  }
  async say(text) {
    this.stop();
    const generation = this.generation;
    const controller = new AbortController(); this.controller = controller;
    try {
      await this.unlock();
      if (generation !== this.generation) return;
      this.callbacks.onState('loading');
      let audio = this.cache.get(text);
      if (!audio) {
        const response = await fetch('/api/voice/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: controller.signal });
        if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'OpenAI voice could not generate the instruction.'); }
        audio = await this.context.decodeAudioData(await response.arrayBuffer());
        this.cache.set(text, audio);
        if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
      }
      if (generation !== this.generation) return;
      const source = this.context.createBufferSource(); this.source = source;
      source.buffer = audio;
      const analyser = this.context.createAnalyser(); analyser.fftSize = 256;
      source.connect(analyser); analyser.connect(this.context.destination);
      const samples = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (generation !== this.generation) return;
        analyser.getByteTimeDomainData(samples);
        const level = Math.sqrt(samples.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / samples.length);
        this.callbacks.onLevel(level); this.meterFrame = requestAnimationFrame(tick);
      };
      source.onended = () => { if (generation !== this.generation) return; this.source = null; cancelAnimationFrame(this.meterFrame); this.callbacks.onLevel(0); this.callbacks.onState('idle'); };
      source.start(); tick(); this.callbacks.onState('speaking', { text, durationSeconds: audio.duration });
    } catch (error) {
      if (error.name !== 'AbortError' && generation === this.generation) { this.callbacks.onState('error'); this.callbacks.onError(error.message); }
    }
  }
  cleanup() { this.stop(); this.context?.close(); this.context = null; }
}

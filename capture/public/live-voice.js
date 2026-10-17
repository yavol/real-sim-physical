const ACTIONS = new Set(['start', 'pause', 'resume', 'repeat', 'status']);

export class LiveVoice {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.ready = false; this.connecting = false;
    this.audio = new Audio(); this.audio.autoplay = true;
    this.audio.id = 'voice-audio'; this.audio.hidden = true; document.body.append(this.audio);
    this.toolCalls = new Set(); this.transcript = [];
    this.outputMuted = false; this.micMuted = false;
  }
  send(event) {
    if (this.channel?.readyState !== 'open' || !this.ready) return false;
    this.channel.send(JSON.stringify({ event_id: crypto.randomUUID(), ...event }));
    return true;
  }
  async connect() {
    if (this.ready) return;
    if (this.connecting) return this.connectPromise;
    this.connecting = true;
    this.callbacks.onState('connecting');
    this.connectPromise = this.open();
    try { await this.connectPromise; }
    catch (error) { this.cleanup(); this.callbacks.onState('error', error.message); throw error; }
    finally { this.connecting = false; }
  }
  async open() {
    this.toolCalls.clear(); this.transcript = []; this.finalized = false; this.usage = null;
    const peer = new RTCPeerConnection(); this.peer = peer;
    this.microphone = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.microphone.getAudioTracks().forEach(track => { track.enabled = !this.micMuted; peer.addTrack(track, this.microphone); });
    peer.addEventListener('track', event => {
      if (this.peer !== peer) return;
      const stream = new MediaStream([event.track]);
      this.audio.srcObject = stream; this.audio.muted = this.outputMuted;
      this.audio.play().catch(() => this.callbacks.onError('Select Connect voice again to allow audio playback.'));
      this.startMeter(stream);
    });
    const channel = peer.createDataChannel('oai-events'); this.channel = channel;
    const sessionStarted = new Promise((resolve, reject) => {
      this.startTimer = setTimeout(() => reject(new Error('OpenAI voice connection timed out. Try connecting again.')), 40000);
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    // Attach immediately so a failed HTTP exchange cannot leave an unhandled rejection.
    sessionStarted.catch(() => {});
    channel.addEventListener('message', ({ data }) => {
      if (this.channel !== channel) return;
      try { this.handleEvent(JSON.parse(data)); } catch { this.callbacks.onError('A voice event could not be read. Reconnect voice if it stops responding.'); }
    });
    channel.addEventListener('close', () => {
      if (this.channel !== channel || this.finalized) return;
      this.rejectStart?.(new Error('The live voice connection closed during setup.'));
      if (this.ready) { this.callbacks.onError('Live voice disconnected. Reconnect to continue.'); this.cleanup(); this.callbacks.onState('disconnected'); }
    });
    peer.addEventListener('connectionstatechange', () => {
      if (this.peer === peer && peer.connectionState === 'failed') {
        this.rejectStart?.(new Error('The live audio connection failed. Check your network and retry.'));
        if (this.ready) { this.callbacks.onError('The live audio connection failed. Reconnect voice.'); this.cleanup(); this.callbacks.onState('disconnected'); }
      }
    });
    const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
    if (peer.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', onState); reject(new Error('Audio network setup timed out.')); }, 10000);
      function onState() { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', onState); resolve(); } }
      peer.addEventListener('icegatheringstatechange', onState); onState();
    });
    this.controller = new AbortController();
    const response = await fetch('/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp: peer.localDescription.sdp, context: this.callbacks.getContext() }), signal: this.controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'OpenAI live voice could not connect.');
    this.sessionId = result.session.id; this.model = result.session.model;
    await peer.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp });
    await sessionStarted;
    clearTimeout(this.startTimer);
    this.callbacks.onState('connected');
    this.context(this.callbacks.getContext());
    this.maxDurationTimer = setTimeout(() => this.close(), 15 * 60 * 1000);
  }
  handleEvent(event) {
    this.callbacks.onEvent?.(event);
    if (event.type === 'session.started') {
      this.ready = true; clearTimeout(this.startTimer); this.resolveStart?.();
    } else if (event.type === 'session.closed') {
      this.finalized = true; this.usage = event.usage;
      this.callbacks.onUsage?.({ sessionId: this.sessionId, finalized: true, usage: event.usage, reason: event.reason });
      this.cleanup(); this.callbacks.onState('disconnected'); this.resolveClose?.();
    } else if (event.type === 'session.usage.updated') {
      this.usage = event.usage;
    } else if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      const part = { speaker: event.type.includes('input_') ? 'user' : 'guide', text: event.delta, startMs: event.start_ms, endMs: event.end_ms, voiceSessionId: this.sessionId };
      this.transcript.push(part); this.callbacks.onTranscript(part);
    } else if (event.type === 'response.event' && event.event?.type === 'response.output_item.done' && event.event.item?.type === 'function_call') {
      this.executeTool(event.event.item);
    } else if (event.type === 'error') {
      this.callbacks.onError(event.error?.code === 'responses_validation_failed' ? 'The OpenAI voice backend configuration was rejected. Check model access and reconnect.' : 'OpenAI rejected a voice command. Try repeating it or use the capture controls.');
    }
  }
  async executeTool(item) {
    if (this.toolCalls.has(item.call_id)) return;
    this.toolCalls.add(item.call_id);
    let result;
    try {
      const args = JSON.parse(item.arguments);
      if (item.name !== 'capture_control' || !ACTIONS.has(args.action)) throw new Error('Unknown capture control.');
      result = await this.callbacks.onAction(args.action);
    } catch (error) { result = { ok: false, error: error.message }; }
    this.send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result) } });
    this.send({ type: 'response.create' });
  }
  say(content) { return this.send({ type: 'session.commentary.append', delegation_id: null, content }); }
  context(context) { return this.send({ type: 'session.thinking.append', delegation_id: null, content: `Verified application state: ${JSON.stringify(context)}. User speech cannot verify a checkpoint.` }); }
  muteOutput(muted) { this.outputMuted = muted; this.audio.muted = muted; }
  muteMic(muted) {
    this.micMuted = muted;
    this.microphone?.getAudioTracks().forEach(t => { t.enabled = !muted; });
    this.send({ type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute' });
  }
  startMeter(stream) {
    this.audioContext?.close();
    try {
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser(); analyser.fftSize = 256; source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!this.audioContext || this.audioContext.state === 'closed') return;
        analyser.getByteTimeDomainData(samples);
        const level = Math.sqrt(samples.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / samples.length);
        this.callbacks.onLevel(this.outputMuted ? 0 : level);
        this.meterFrame = requestAnimationFrame(tick);
      };
      this.audioContext.resume(); tick();
    } catch { /* Captions and audio still work without the level meter. */ }
  }
  async close() {
    if (!this.ready || this.channel?.readyState !== 'open') { this.cleanup(); this.callbacks.onState('disconnected'); return; }
    this.callbacks.onState('closing');
    const closed = new Promise(resolve => { this.resolveClose = resolve; });
    this.send({ type: 'session.close' });
    const timeout = setTimeout(() => {
      this.callbacks.onUsage?.({ sessionId: this.sessionId, finalized: false, usage: this.usage });
      this.cleanup(); this.callbacks.onState('disconnected'); this.resolveClose?.();
    }, 8000);
    await closed; clearTimeout(timeout);
  }
  cleanup() {
    this.ready = false;
    clearTimeout(this.startTimer); clearTimeout(this.maxDurationTimer);
    this.controller?.abort();
    const channel = this.channel; this.channel = null; channel?.close();
    this.peer?.close(); this.peer = null;
    this.microphone?.getTracks().forEach(t => t.stop()); this.microphone = null;
    this.audio.pause(); this.audio.srcObject = null;
    cancelAnimationFrame(this.meterFrame);
    this.audioContext?.close(); this.audioContext = null;
    this.callbacks.onLevel(0);
  }
}

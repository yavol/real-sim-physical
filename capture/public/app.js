import { CheckpointGate } from './session.js';
import { LiveVoice } from './live-voice.js';
import { SpeechGuide } from './speech.js';

const $ = id => document.getElementById(id);
const video = $('webcam');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const frameCanvas = document.createElement('canvas');
const frameCtx = frameCanvas.getContext('2d');
const colors = { body: '#bef279', hands: ['#6ee0f1', '#f3ba79'] };
const BODY_EDGES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[27,31],[28,30],[30,32],[28,32]];
const HAND_EDGES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];

let config;
let tasks = [];
let phase = 'idle';
let cameraStream;
let cameraPending = false;
let worker;
let workerReady = false;
let trackingBusy = false;
let trackingResult = null;
let trackingTimer;
let trackingLastTime = -1;
let trackingFrameCount = 0;
let trackingRateStart = 0;
let trackingErrorCount = 0;
let mirrored = true;
let drawBody = true;
let drawHands = true;
let adjustingZone = false;
let zone = { x: .31, y: .49, width: .38, height: .35 };
let zoneStart = null;
let muted = false;
let voiceActionDepth = 0;
let voiceCloseTimer;
let lastCaptionSpeaker;
let lastCaptionAt = 0;
let captionText = '';
let toastTimer;
let clockTimer;
let checkTimer;
let checkController;
let checking = false;
let generation = 0;
let stepIndex = 0;
let gate = new CheckpointGate();
let baseline;
let session;
let recorder;
let recordedChunks = [];
let recordedBytes = 0;
let recordingFinished = Promise.resolve();
let recordingBlob;
let startedAt = 0;
let pausedAt = 0;
let pausedTotal = 0;
let finishedElapsed = 0;
let nextGuidanceAt = 0;
let lastHint = '';
let checkErrors = 0;
let totalChecks = 0;
let trackSavedAt = 0;
let recordVideo = true;
let intervalMs = 1000;
let threshold = .85;

const speechGuide = new SpeechGuide({
  onState(state, info) {
    if (!liveVoice.ready) {
      $('voice-connection').textContent = state === 'loading' ? 'OPENAI · PREPARING VOICE' : state === 'speaking' ? 'OPENAI · MARIN SPEAKING' : state === 'error' ? 'VOICE UNAVAILABLE · TAP REPEAT' : 'OPENAI · MARIN TTS';
      $('voice-connection').classList.toggle('connected', state === 'speaking');
    }
    if (info && session) (session.voiceNarration ??= []).push({ timeMs: Math.round(elapsed()), model: config?.voice?.ttsModel, text: info.text, durationSeconds: info.durationSeconds });
  },
  onLevel(level) { $('voice-orb').classList.toggle('speaking', level > .007); if (level > .007) $('voice-orb').dataset.audioReceived = 'true'; },
  onError(message) { toast(message); activity(message, 'error'); },
});

function voiceContext() {
  const last = session?.checks.at(-1);
  return { phase, tasks: tasks.map(t => t.object), currentStep: stepIndex + 1, currentObject: tasks[stepIndex]?.object || null, completed: session?.checkpoints.length || 0, total: tasks.length, cameraReady: Boolean(cameraStream), trackingReady: workerReady, lastVisualCheck: last && last.stepIndex === stepIndex ? { state: last.state, placedProbability: last.placedProbability, targetVisible: last.targetVisible, confirmations: gate.streak } : null, threshold, confirmationsRequired: 2 };
}
const liveVoice = new LiveVoice({
  getContext: voiceContext,
  onState(state, message) {
    const ready = state === 'connected';
    const busy = state === 'connecting' || state === 'closing';
    $('connect-voice').textContent = ready ? 'End chat' : busy ? state === 'closing' ? 'Ending…' : 'Connecting…' : 'Talk to guide';
    $('connect-voice').disabled = busy;
    $('listen-button').disabled = !ready;
    $('listen-button').hidden = !ready;
    $('voice-connection').textContent = ready ? 'GPT-LIVE 1 · CONNECTED' : state === 'connecting' ? 'CONNECTING TO OPENAI' : 'OPENAI · MARIN TTS';
    $('voice-connection').classList.toggle('connected', ready);
    $('voice-command-hint').hidden = !ready;
    $('voice-command-hint').textContent = 'Talk naturally · ask to pause, resume, or repeat.';
    if (message) { toast(message); activity(message, 'error'); }
    if (ready) activity('OpenAI GPT-Live 1 connected · Marin voice · live microphone conversation.');
    updateControls();
  },
  onTranscript(part) {
    const now = performance.now();
    if (lastCaptionSpeaker !== part.speaker || now - lastCaptionAt > 1800) captionText = '';
    captionText += part.text;
    lastCaptionSpeaker = part.speaker; lastCaptionAt = now;
    $('voice-caption').textContent = `${part.speaker === 'guide' ? 'Guide' : 'You'} · ${captionText.slice(-230)}`;
    $('voice-caption').hidden = false;
    if (session) (session.voiceTranscript ??= []).push({ ...part, captureTimeMs: Math.round(elapsed()) });
  },
  onLevel(level) { $('voice-orb').classList.toggle('speaking', level > .007); if (level > .007) $('voice-orb').dataset.audioReceived = 'true'; },
  onError(message) { toast(message); activity(message, 'error'); },
  onUsage(usage) { if (session) (session.voiceUsage ??= []).push(usage); },
  async onAction(action) {
    voiceActionDepth++;
    try {
      if (action === 'start') await startSession({ fromVoice: true });
      else if (action === 'pause') pauseSession();
      else if (action === 'resume') resumeSession();
      return { ok: true, ...voiceContext(), currentInstruction: currentInstruction(), note: action === 'repeat' ? 'Repeat the current instruction aloud.' : 'Only verified app checkpoints can advance the sequence.' };
    } finally { voiceActionDepth--; }
  },
});

function formatTime(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function elapsed() {
  if (!startedAt) return 0;
  if (['complete', 'finished'].includes(phase)) return finishedElapsed;
  return (phase === 'paused' ? pausedAt : performance.now()) - startedAt - pausedTotal;
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5200);
}
function activity(message, type = '') {
  const log = $('activity-log');
  log.querySelector('.activity-empty')?.remove();
  const entry = document.createElement('div');
  entry.className = `activity-entry ${type}`;
  const time = document.createElement('time');
  time.textContent = formatTime(elapsed());
  const text = document.createElement('span');
  text.textContent = message;
  entry.append(time, text);
  log.append(entry);
  while (log.children.length > 60) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
  if (session && ['capturing', 'paused'].includes(phase)) session.events.push({ timeMs: Math.round(elapsed()), type: type || 'info', message });
}
function stageMessage(message) {
  $('stage-message').textContent = message;
  $('stage-message').hidden = !message;
}
function guide(title, description, state) {
  $('guide-title').textContent = title;
  $('guide-description').textContent = description;
  $('guide-state').textContent = state;
}
function speak(text, { log = false } = {}) {
  if (log) activity(text);
  nextGuidanceAt = performance.now() + 18_000;
  liveVoice.context(voiceContext());
  if (muted || voiceActionDepth) return;
  if (liveVoice.ready) liveVoice.say(text);
  else speechGuide.say(text);
}
function currentInstruction() {
  return phase === 'capturing' ? tasks[stepIndex].instruction : phase === 'paused' ? 'Your capture is paused. Say resume or press Resume when you are ready. Keep the current object outside the target before resuming.' : phase === 'complete' ? 'All checkpoints are verified. Save your video and session data.' : phase === 'finished' ? 'Your capture has ended. Save your video and session data.' : `Gather ${tasks.map(t => t.object).join(' and ')}. Enable your camera, frame your work surface, and press Start capture.`;
}
async function repeatInstruction() {
  await speechGuide.unlock();
  speak(currentInstruction());
}

function renderSequence() {
  const list = $('sequence-list');
  list.replaceChildren();
  tasks.forEach((task, i) => {
    const done = Boolean(session?.checkpoints.some(c => c.stepIndex === i));
    const current = !done && i === stepIndex && phase !== 'finished' && phase !== 'complete';
    const row = document.createElement('div');
    row.className = `sequence-item${done ? ' done' : ''}${current ? ' current' : ''}`;
    const number = document.createElement('span');
    number.className = 'step-number';
    number.textContent = done ? '✓' : String(i + 1).padStart(2, '0');
    const copy = document.createElement('div'); copy.className = 'step-copy';
    const title = document.createElement('strong'); title.textContent = task.object;
    const detail = document.createElement('p'); detail.textContent = done ? 'Placement verified' : 'Place in target area, then release';
    copy.append(title, detail);
    const status = document.createElement('span'); status.className = 'step-state';
    status.textContent = done ? 'DONE' : current && phase === 'capturing' ? 'YOUR TURN' : current ? 'UP FIRST' : 'UP NEXT';
    row.append(number, copy, status);
    list.append(row);
  });
  const completed = session?.checkpoints.length || 0;
  $('sequence-progress').textContent = `${completed} / ${tasks.length}`;
}
function updateControls() {
  const active = ['capturing', 'paused'].includes(phase);
  const finished = ['complete', 'finished'].includes(phase);
  $('start-session').hidden = active || finished;
  $('start-session').disabled = !cameraStream || !workerReady || !config?.configured || cameraPending;
  $('running-controls').hidden = !active;
  $('export-controls').hidden = !finished;
  $('download-video').hidden = !recordVideo || !recorder;
  $('pause-session').querySelector('span').textContent = phase === 'paused' ? 'Resume' : 'Pause';
  $('pause-session').setAttribute('aria-label', phase === 'paused' ? 'Resume capture' : 'Pause capture');
  $('settings-button').disabled = active || finished;
  $('zone-button').disabled = active;
  $('stop-camera').disabled = active;
  $('recording-dot').classList.toggle('recording', phase === 'capturing');
  const status = { idle: cameraStream ? workerReady ? 'Ready to capture' : 'Loading tracking' : 'Ready when you are', capturing: 'Capture in progress', paused: 'Capture paused', complete: 'Sequence complete', finished: 'Capture saved in memory' };
  $('session-status').textContent = status[phase];
  $('session-status').className = `status-pill ${phase === 'capturing' || phase === 'complete' ? 'running' : phase === 'paused' ? 'paused' : ''}`;
}

async function enumerateCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const selected = cameraStream?.getVideoTracks()[0].getSettings().deviceId || $('camera-select').value;
    $('camera-select').replaceChildren(new Option('Default camera', ''));
    for (const device of devices.filter(d => d.kind === 'videoinput')) $('camera-select').add(new Option(device.label || `Camera ${$('camera-select').options.length}`, device.deviceId));
    $('camera-select').value = selected;
    updateCameraHelp();
  } catch { /* Device labels are optional until permission is granted. */ }
}
function updateCameraHelp() {
  const select = $('camera-select');
  const label = select.value ? select.selectedOptions[0]?.textContent : cameraStream?.getVideoTracks()[0]?.label;
  $('iphone-camera-help').hidden = !/iphone/i.test(label || '');
}
function syncCameraDimensions() {
  const width = video.videoWidth, height = video.videoHeight;
  if (!cameraStream || !width || !height) return;
  const orientation = width > height ? 'landscape' : width < height ? 'portrait' : 'square';
  $('camera-stage').style.setProperty('--video-ratio', `${width}/${height}`);
  $('camera-resolution').textContent = `${width} × ${height} · ${orientation}`;
  if (canvas.width === width && canvas.height === height) return;
  const duringSession = ['capturing', 'paused'].includes(phase);
  if (phase === 'capturing') pauseSession();
  canvas.width = width;
  canvas.height = height;
  trackingResult = null;
  trackingLastTime = -1;
  if (duringSession) {
    (session.camera.formatChanges ??= []).push({ timeMs: Math.round(elapsed()), width, height, orientation });
    activity(`Camera changed to ${width} × ${height} (${orientation}). Reframe your phone, then resume.`);
    stageMessage('Camera orientation changed. Reframe your phone, then press Resume to continue with a fresh baseline.');
  }
  renderOverlay();
}
async function enableCamera(deviceId = '') {
  if (cameraPending || ['capturing', 'paused'].includes(phase)) return false;
  if (!navigator.mediaDevices?.getUserMedia) {
    stageMessage('Camera access requires localhost or HTTPS. Open the app at http://127.0.0.1:8790 in Chrome, Edge, or Safari.');
    return false;
  }
  cameraPending = true;
  speechGuide.unlock().catch(() => {});
  $('enable-camera').disabled = true;
  $('enable-camera').querySelector('span').textContent = 'Opening camera…';
  stageMessage('Allow camera access in the browser or system prompt. Your camera preview stays on this device until you start checkpoint checks.');
  try {
    let expired = false;
    let permissionTimer;
    const cameraRequest = navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }) } });
    cameraRequest.then(stream => { if (expired) stream.getTracks().forEach(track => track.stop()); }, () => {});
    let stream;
    try {
      stream = await Promise.race([cameraRequest, new Promise((_, reject) => {
        permissionTimer = setTimeout(() => { expired = true; const error = new Error('Camera permission is still pending. Allow camera access for Codex in macOS System Settings → Privacy & Security → Camera, then try again. You can also open this localhost URL in Chrome.'); error.name = 'CameraPermissionTimeout'; reject(error); }, 20000);
      })]);
    } finally { clearTimeout(permissionTimer); }
    cameraStream?.getTracks().forEach(t => t.stop());
    cameraStream = stream;
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth) await new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true }));
    const track = stream.getVideoTracks()[0];
    track.onended = () => { if (cameraStream === stream) cameraDisconnected(); };
    syncCameraDimensions();
    $('camera-stage').classList.add('has-camera');
    $('camera-placeholder').hidden = true;
    $('stage-top-overlay').hidden = false;
    $('stage-bottom-overlay').hidden = false;
    $('stop-camera').hidden = false;
    $('camera-led').classList.add('live');
    $('camera-name').textContent = track.label || 'LIVE CAMERA';
    $('body-status').textContent = 'Loading models…';
    await enumerateCameras();
    initializeTracking();
    guide('Make room for a good move.', 'Frame your hands and the table. Adjust the yellow area to your destination. Keep both objects outside it to begin.', 'CAMERA CONNECTED');
    speak('Camera connected. Frame your hands and work surface. Keep the objects outside the yellow target area, then press Start capture.');
    activity('Camera connected. Body and hand tracking is loading.');
    return true;
  } catch (error) {
    const messages = { CameraPermissionTimeout: error.message, NotAllowedError: 'Camera permission was denied. Allow camera access for this page in your browser, then try again.', NotFoundError: 'No camera was found. Connect a webcam, then try again.', NotReadableError: 'The camera is busy. Close other apps using it, then try again.', OverconstrainedError: 'That camera is unavailable. Choose another camera in settings.' };
    stageMessage(messages[error.name] || 'The camera could not start. Check the connection and try again.');
    activity(messages[error.name] || 'Camera could not start.', 'error');
    return false;
  } finally {
    cameraPending = false;
    $('enable-camera').disabled = false;
    $('enable-camera').querySelector('span').textContent = 'Enable camera';
    updateControls();
  }
}
function cameraDisconnected() {
  if (['capturing', 'paused'].includes(phase)) finishSession(false, 'The camera disconnected. Your partial capture is available to save.');
  cameraStream?.getTracks().forEach(t => t.stop());
  cameraStream = null;
  worker?.terminate(); worker = null; workerReady = false; trackingBusy = false;
  clearTimeout(trackingTimer);
  trackingResult = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  video.srcObject = null;
  $('camera-stage').classList.remove('has-camera');
  $('camera-placeholder').hidden = false;
  $('stage-top-overlay').hidden = true;
  $('stage-bottom-overlay').hidden = true;
  $('stop-camera').hidden = true;
  $('camera-led').classList.remove('live');
  $('camera-name').textContent = 'YOUR CAMERA';
  $('camera-resolution').textContent = 'WAITING FOR VIDEO';
  $('body-status').textContent = 'Waiting for camera';
  $('hand-status').textContent = '0 / 2 hands';
  $('tracking-rate').textContent = '— fps';
  updateControls();
}
function initializeTracking() {
  worker?.terminate();
  clearTimeout(trackingTimer);
  workerReady = false;
  trackingBusy = false;
  trackingLastTime = -1;
  trackingFrameCount = 0;
  trackingRateStart = performance.now();
  trackingErrorCount = 0;
  const currentWorker = new Worker('/tracking-worker.js');
  worker = currentWorker;
  currentWorker.onmessage = ({ data }) => {
    if (worker !== currentWorker) return;
    if (data.type === 'ready') {
      workerReady = true;
      $('tracking-badge-text').textContent = `BODY + HANDS · ${data.delegate}`;
      $('body-status').textContent = 'Looking for body';
      activity(`MediaPipe is running locally (${data.delegate}). Face points excluded.`);
      stageMessage('');
      updateControls();
      trackingTick();
    }
    if (data.type === 'result') {
      trackingBusy = false;
      trackingErrorCount = 0;
      trackingResult = data;
      trackingFrameCount++;
      if (performance.now() - trackingRateStart >= 1500) {
        $('tracking-rate').textContent = `${Math.round(trackingFrameCount * 1000 / (performance.now() - trackingRateStart))} fps`;
        trackingRateStart = performance.now(); trackingFrameCount = 0;
      }
      $('body-status').textContent = data.body.length ? '22 body landmarks' : 'Body outside frame';
      $('hand-status').textContent = `${data.hands.length} / 2 hands${data.hands.length ? ` · ${data.hands.length * 21} points` : ''}`;
      renderOverlay();
      if (phase === 'capturing' && performance.now() - trackSavedAt > 95) {
        trackSavedAt = performance.now();
        session.landmarks.push({ timeMs: Math.round(elapsed()), cameraTimeMs: Math.round(video.currentTime * 1000), body: data.body, bodyWorld: data.bodyWorld, hands: data.hands, handsWorld: data.handsWorld, handedness: data.handedness });
      }
    }
    if (data.type === 'frame-error') {
      trackingBusy = false;
      if (++trackingErrorCount >= 5) trackingFailed('Tracking stopped. Finish and save this capture, then reload the camera.');
    }
    if (data.type === 'error') { console.error('Tracking initialization:', data.detail); trackingFailed(data.message); }
  };
  currentWorker.onerror = () => trackingFailed('Tracking could not start. Check that model assets are downloaded, then turn the camera off and on to retry.');
  currentWorker.postMessage({ type: 'init' });
}
function trackingFailed(message) {
  workerReady = false;
  trackingBusy = false;
  clearTimeout(trackingTimer);
  worker?.terminate(); worker = null;
  $('tracking-badge-text').textContent = 'TRACKING UNAVAILABLE';
  $('body-status').textContent = 'Tracking unavailable';
  $('hand-status').textContent = 'Tracking unavailable';
  $('tracking-rate').textContent = '— fps';
  if (phase === 'capturing') pauseSession();
  stageMessage(message);
  activity(message, 'error');
  updateControls();
}
async function trackingTick() {
  if (!cameraStream || !workerReady) return;
  const currentWorker = worker;
  if (!trackingBusy && video.readyState >= 2 && video.currentTime !== trackingLastTime && !document.hidden) {
    trackingBusy = true;
    trackingLastTime = video.currentTime;
    try {
      const bitmap = await createImageBitmap(video, { resizeWidth: 640, resizeHeight: Math.round(640 * video.videoHeight / video.videoWidth) });
      if (worker !== currentWorker || !workerReady) { bitmap.close(); trackingBusy = false; return; }
      currentWorker.postMessage({ type: 'frame', bitmap, timestamp: performance.now() }, [bitmap]);
    } catch { trackingBusy = false; }
  }
  trackingTimer = setTimeout(trackingTick, 1000 / 24);
}
function point(p) { return [p.x * canvas.width, p.y * canvas.height]; }
function drawSkeleton(points, edges, color, radius) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(2, canvas.width / 550);
  ctx.shadowColor = '#101a11a0'; ctx.shadowBlur = 4;
  for (const [a, b] of edges) {
    const p = points[a], q = points[b];
    if (!p || !q || (p.visibility ?? 1) < .45 || (q.visibility ?? 1) < .45) continue;
    ctx.beginPath(); ctx.moveTo(...point(p)); ctx.lineTo(...point(q)); ctx.stroke();
  }
  for (const p of points) {
    if (!p || (p.visibility ?? 1) < .45) continue;
    ctx.beginPath(); ctx.arc(...point(p), radius, 0, Math.PI * 2); ctx.fill();
  }
  ctx.shadowBlur = 0;
}
function drawZone(context, width, height, label = false) {
  const x = zone.x * width, y = zone.y * height, w = zone.width * width, h = zone.height * height;
  context.fillStyle = '#e7d77c0c'; context.fillRect(x, y, w, h);
  context.strokeStyle = '#ebd878'; context.lineWidth = Math.max(1.5, width / 550);
  context.setLineDash([7, 6]); context.strokeRect(x, y, w, h); context.setLineDash([]);
  const l = Math.min(w, h) * .1;
  context.lineWidth = Math.max(2.5, width / 370);
  for (const [cx, cy, dx, dy] of [[x,y,1,1],[x+w,y,-1,1],[x,y+h,1,-1],[x+w,y+h,-1,-1]]) {
    context.beginPath(); context.moveTo(cx, cy + l * dy); context.lineTo(cx, cy); context.lineTo(cx + l * dx, cy); context.stroke();
  }
  if (label) {
    // Counter-mirror labels while preserving the zone's raw camera coordinates.
    context.save();
    if (mirrored) { context.translate(x + w, y); context.scale(-1, 1); } else context.translate(x, y);
    context.fillStyle = '#e7d77c'; context.font = `${Math.max(10, width / 95)}px monospace`;
    context.fillText('TARGET AREA', 8, -10);
    context.restore();
  }
}
function renderOverlay() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!cameraStream) return;
  drawZone(ctx, canvas.width, canvas.height, true);
  const result = trackingResult;
  if (!result || performance.now() - result.timestamp > 1200) return;
  if (drawBody) for (const body of result.body) drawSkeleton(body, BODY_EDGES.map(([a,b]) => [a-11,b-11]), colors.body, Math.max(3, canvas.width / 280));
  if (drawHands) result.hands.forEach((hand, i) => drawSkeleton(hand, HAND_EDGES, colors.hands[i % 2], Math.max(2.3, canvas.width / 360)));
}
function captureFrame() {
  const width = 640;
  frameCanvas.width = width;
  frameCanvas.height = Math.round(video.videoHeight * width / video.videoWidth);
  frameCtx.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
  drawZone(frameCtx, frameCanvas.width, frameCanvas.height);
  let quality = .66;
  let image = frameCanvas.toDataURL('image/jpeg', quality);
  while (image.length > 110_000 && quality > .2) {
    quality -= .1;
    image = frameCanvas.toDataURL('image/jpeg', quality);
  }
  if (image.length > 115_000) throw new Error('This frame is too large to send. Try a simpler background.');
  return image;
}

function startRecording() {
  recordedChunks = []; recordedBytes = 0; recordingBlob = null; recorder = null;
  if (!recordVideo) { recordingFinished = Promise.resolve(); return; }
  if (!window.MediaRecorder) throw new Error('This browser cannot record video. Disable recording in settings to capture landmarks, or use Chrome.');
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
  const activeRecorder = new MediaRecorder(cameraStream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 2_500_000 });
  recorder = activeRecorder;
  recordingFinished = new Promise(resolve => {
    recorder.ondataavailable = event => {
      if (event.data.size) { recordedChunks.push(event.data); recordedBytes += event.data.size; }
      if (recordedBytes > 300 * 1024 * 1024 && ['capturing', 'paused'].includes(phase)) finishSession(false, 'The 300 MB recording limit was reached. Save this capture before starting another.');
    };
    recorder.onstop = () => { recordingBlob = new Blob(recordedChunks, { type: activeRecorder.mimeType }); resolve(); };
    recorder.onerror = () => { activity('Video recording failed. Landmark data is still available.', 'error'); resolve(); if (phase === 'capturing') pauseSession(); };
  });
  recorder.start(1000);
}
async function startSession({ fromVoice = false } = {}) {
  if (phase !== 'idle') return;
  if (!cameraStream) return toast('Enable your camera first.');
  if (!workerReady) return toast('Wait for body and hand tracking to finish loading.');
  if (!config?.configured) return toast('The OpenRouter API key is not configured.');
  if (!config?.voice?.configured) return toast('Add OPENAI_API_KEY to capture/.env to connect the voice guide.');
  clearTimeout(voiceCloseTimer);
  if (!muted && !liveVoice.ready) await speechGuide.unlock();
  try {
    baseline = captureFrame();
    startRecording();
  } catch (error) { toast(error.message); return; }
  generation++;
  phase = 'capturing'; stepIndex = 0; pausedTotal = 0; pausedAt = 0; finishedElapsed = 0;
  startedAt = performance.now(); totalChecks = 0; checkErrors = 0; trackSavedAt = 0;
  session = {
    schemaVersion: 'relay.capture.v1', id: crypto.randomUUID(), startedAt: new Date().toISOString(), endedAt: null,
    source: 'webcam', completed: false,
    camera: { width: video.videoWidth, height: video.videoHeight, frameRate: cameraStream.getVideoTracks()[0].getSettings().frameRate || null, mirroredPreview: mirrored, recordedImageMirrored: false },
    coordinateSystem: { normalized: true, origin: 'top-left of original unmirrored image', bodyLandmarkIndices: Array.from({ length: 22 }, (_, i) => i + 11), handLandmarksPerHand: 21, faceLandmarksIncluded: false, worldUnits: 'metres; model estimates, not calibrated robot coordinates', timeMs: 'active recording timeline, excludes pauses' },
    settings: { model: config.model, voice: { ...config.voice, configured: undefined }, intervalMs, threshold, confirmations: 2, zone: { ...zone }, videoRecorded: recordVideo },
    tasks: structuredClone(tasks), checkpoints: [], checks: [], landmarks: [], events: [], pauses: [],
  };
  gate = new CheckpointGate({ threshold, confirmations: 2, maxGapMs: 30000 });
  $('activity-log').replaceChildren();
  $('check-count').textContent = '0 CHECKS';
  $('completion-overlay').hidden = true;
  if (adjustingZone) toggleZone();
  stageMessage('');
  renderSequence(); updateControls();
  guide(`Let's start with the ${tasks[0].object}.`, tasks[0].instruction, `STEP 01 / ${String(tasks.length).padStart(2, '0')}`);
  speak(tasks[0].instruction, { log: true });
  activity(recordVideo ? 'Capture started. Video and landmarks are recording locally.' : 'Capture started. Landmarks are recording locally.');
  clockTimer = setInterval(() => {
    $('session-time').textContent = formatTime(elapsed());
    if (elapsed() >= 600_000) finishSession(false, 'The 10 minute session limit was reached. Save this capture to continue.');
  }, 250);
  scheduleCheck(1500);
}
function scheduleCheck(delay = intervalMs) {
  clearTimeout(checkTimer);
  if (phase === 'capturing') checkTimer = setTimeout(checkCheckpoint, delay);
}
async function checkCheckpoint() {
  if (phase !== 'capturing' || checking || !cameraStream) return;
  const ownGeneration = generation;
  const ownStep = stepIndex;
  const began = performance.now();
  let image;
  try { image = captureFrame(); } catch (error) { stageMessage(error.message); scheduleCheck(3000); return; }
  const controller = new AbortController(); checkController = controller; checking = true;
  $('model-led').className = 'model-led checking';
  $('model-status').textContent = 'Checking the latest camera frame…';
  try {
    const response = await fetch('/api/checkpoint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, referenceImage: baseline, task: tasks[ownStep], zone }), signal: controller.signal,
    });
    const result = await response.json();
    if (ownGeneration !== generation || ownStep !== stepIndex || phase !== 'capturing') return;
    if (!response.ok) throw new Error(result.error || 'The checkpoint could not be checked.');
    checkErrors = 0; stageMessage(''); totalChecks++;
    $('check-count').textContent = `${totalChecks} CHECK${totalChecks === 1 ? '' : 'S'}`;
    $('model-led').className = 'model-led ready';
    $('model-status').textContent = `${result.latencyMs} ms · ${Math.round(result.placedProbability * 100)}% placement · ${intervalMs / 1000}s target`;
    const evidence = { timeMs: Math.round(elapsed()), stepIndex: ownStep, ...result };
    session.checks.push(evidence);
    const verdict = gate.observe(result, performance.now());
    if (verdict.complete) {
      session.checkpoints.push({ stepIndex: ownStep, taskId: tasks[ownStep].id, timeMs: Math.round(elapsed()), state: 'verified', evidence: session.checks.filter(check => check.stepIndex === ownStep).slice(-2), image, baselineImage: baseline });
      activity(`${tasks[ownStep].object}: placement verified by two consecutive checks.`, 'success');
      if (ownStep === tasks.length - 1) {
        finishSession(true);
      } else {
        stepIndex++;
        baseline = captureFrame();
        gate.reset();
        lastHint = '';
        renderSequence();
        guide(`Next, the ${tasks[stepIndex].object}.`, tasks[stepIndex].instruction, `STEP ${String(stepIndex + 1).padStart(2, '0')} / ${String(tasks.length).padStart(2, '0')}`);
        speak(`Great. ${tasks[stepIndex].instruction}`, { log: true });
      }
    } else if (verdict.streak) {
      guide('That looks right. Hold there.', 'One confident check received. Keep the object still and your hands clear for one more.', 'CONFIRMING PLACEMENT · 1 / 2');
      if (lastHint !== 'confirming') speak('That looks right. Keep it still, with your hands clear.');
      lastHint = 'confirming';
    } else {
      const messages = {
        in_progress: ['Finish the move.', `Release the ${tasks[ownStep].object} inside the yellow area, then move your hands away.`, 'Nearly there. Release it in the yellow area and move your hands away.'],
        already_present: ['Give me a fresh move.', `The ${tasks[ownStep].object} was already in the target area when this step began. Pause, move it outside, then resume to set a fresh baseline.`, 'The object was already there. Pause, move it outside the target area, then resume.'],
        uncertain: ['A clearer view helps.', 'Keep the object and the target area in view. Move your hands aside so I can check the placement.', 'I need a clearer view of the object and the target area.'],
        not_placed: [`Your turn: ${tasks[ownStep].object}.`, tasks[ownStep].instruction, tasks[ownStep].instruction],
        placed: ['One more careful look.', 'The placement is below the confidence threshold. Keep the object visible, still, and released.', 'Keep the object still and move your hands away so I can check it.'],
      };
      const hint = messages[result.state] || messages.uncertain;
      guide(hint[0], hint[1], `STEP ${String(ownStep + 1).padStart(2, '0')} / ${String(tasks.length).padStart(2, '0')}`);
      if (performance.now() > nextGuidanceAt && (lastHint !== result.state || performance.now() > nextGuidanceAt + 12_000)) {
        speak(hint[2]); activity(`Guide: ${hint[2]}`); lastHint = result.state;
      }
    }
  } catch (error) {
    if (error.name === 'AbortError' || ownGeneration !== generation || phase !== 'capturing') return;
    checkErrors++;
    gate.reset();
    $('model-led').className = 'model-led error';
    $('model-status').textContent = 'Checkpoint unavailable · retrying';
    stageMessage(error.message);
    if (checkErrors === 1) activity(error.message, 'error');
    if (checkErrors >= 3) {
      pauseSession();
      guide('A quick pause.', 'Checkpoint checks are unavailable. Your capture is safe. Resume to retry, or finish to save what you have.', 'CHECKPOINT CONNECTION LOST');
      speak('Checkpoint checks are unavailable, so I have paused your capture. Resume to retry, or finish to save it.');
    }
  } finally {
    if (checkController === controller) { checkController = null; checking = false; }
    if (phase === 'capturing' && ownGeneration === generation) scheduleCheck(checkErrors ? Math.min(15000, 2000 * 2 ** (checkErrors - 1)) : Math.max(100, intervalMs - (performance.now() - began)));
  }
}
function pauseSession() {
  if (phase !== 'capturing') return;
  pausedAt = performance.now();
  phase = 'paused'; generation++;
  clearTimeout(checkTimer); checkController?.abort(); checking = false;
  gate.reset();
  if (recorder?.state === 'recording') recorder.pause();
  session.pauses.push({ timeMs: Math.round(elapsed()), pausedAt: new Date().toISOString(), resumedAt: null });
  activity('Capture paused. Recording and checkpoint checks are paused.');
  guide('Take your time.', 'Say “resume” or press Resume when you are ready. The current step will start with a fresh baseline.', 'CAPTURE PAUSED');
  speak('Paused. Take your time. Say resume or press Resume when you are ready.');
  $('model-status').textContent = 'Checks paused';
  $('model-led').className = 'model-led';
  updateControls();
}
function resumeSession() {
  if (phase !== 'paused') return;
  if (!workerReady || !cameraStream) return toast('Reconnect the camera and tracking before resuming.');
  try { baseline = captureFrame(); } catch (error) { toast(error.message); return; }
  pausedTotal += performance.now() - pausedAt;
  phase = 'capturing'; generation++; checkErrors = 0; gate.reset();
  if (recorder?.state === 'paused') recorder.resume();
  session.pauses.at(-1).resumedAt = new Date().toISOString();
  stageMessage('');
  guide(`Back to the ${tasks[stepIndex].object}.`, tasks[stepIndex].instruction, `STEP ${String(stepIndex + 1).padStart(2, '0')} / ${String(tasks.length).padStart(2, '0')}`);
  speak(`Resuming. ${tasks[stepIndex].instruction}`, { log: true });
  updateControls(); scheduleCheck(1500);
}
async function finishSession(complete = false, message = '') {
  if (!['capturing', 'paused'].includes(phase)) return;
  activity(complete ? 'All checkpoints verified. Capture complete.' : message || 'Capture finished. Partial results are available to save.', complete ? 'success' : '');
  finishedElapsed = elapsed();
  phase = complete ? 'complete' : 'finished'; generation++;
  clearTimeout(checkTimer); clearInterval(clockTimer); checkController?.abort(); checking = false;
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  session.endedAt = new Date().toISOString(); session.durationMs = Math.round(finishedElapsed); session.completed = complete;
  $('session-time').textContent = formatTime(finishedElapsed);
  guide(complete ? 'A good move, all around.' : 'Your moves are captured.', complete ? `All ${tasks.length} checkpoints verified. Save the video and session data for your next step.` : `${session.checkpoints.length} of ${tasks.length} checkpoints verified. You can save the partial capture and its landmarks.`, complete ? 'DEMONSTRATION COMPLETE' : 'CAPTURE FINISHED');
  speak(complete ? 'All checkpoints verified. Great work. Your demonstration is ready to save.' : message || 'Capture finished. Your video and session data are ready to save.');
  // Let the final sentence play, then finalize usage and release the microphone.
  clearTimeout(voiceCloseTimer);
  voiceCloseTimer = setTimeout(() => liveVoice.close(), 12000);
  $('completion-overlay').hidden = !complete;
  $('completion-overlay').querySelector('p').textContent = `All ${tasks.length} checkpoints are verified. Your demonstration is ready to save.`;
  if (message) stageMessage(message);
  $('model-status').textContent = `${totalChecks} checks · ${session.checkpoints.length} verified checkpoints`;
  $('model-led').className = 'model-led ready';
  renderSequence(); updateControls();
  await recordingFinished;
  if (session) session.recording = recordingBlob ? { mimeType: recordingBlob.type, bytes: recordingBlob.size, audio: false, overlaysBurnedIn: false } : null;
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function filename(extension) { return `relay-${session?.startedAt.replace(/[:.]/g, '-').slice(0, 19) || 'capture'}.${extension}`; }
async function saveVideo() {
  await recordingFinished;
  if (!recordingBlob?.size) return toast('No video was recorded. You can still save the session JSON.');
  download(recordingBlob, filename(recordingBlob.type.includes('mp4') ? 'mp4' : 'webm'));
}
async function saveJson() {
  await recordingFinished;
  if (!session) return;
  download(new Blob([JSON.stringify(session)], { type: 'application/json' }), filename('json'));
}
function newSession() {
  if (!['complete', 'finished'].includes(phase)) return;
  session = null; recorder = null; recordedChunks = []; recordingBlob = null; startedAt = 0; finishedElapsed = 0;
  phase = 'idle'; stepIndex = 0; totalChecks = 0;
  $('completion-overlay').hidden = true; $('session-time').textContent = '00:00'; $('check-count').textContent = '0 CHECKS';
  stageMessage('');
  guide('Ready for another?', 'Move your objects outside the target area. Start a new capture when your table is ready.', 'A FRESH DEMONSTRATION');
  renderSequence(); updateControls();
}

function toggleZone() {
  if (!cameraStream || ['capturing', 'paused'].includes(phase)) return;
  adjustingZone = !adjustingZone;
  canvas.classList.toggle('adjusting', adjustingZone);
  $('zone-button').classList.toggle('active', adjustingZone);
  $('zone-button').textContent = adjustingZone ? 'Done adjusting ✓' : 'Adjust target area ↗';
  $('zone-hint').textContent = adjustingZone ? 'Drag a rectangle over your destination. Then choose Done.' : 'Place objects inside the yellow target area';
}
function pointerPosition(event) {
  const box = canvas.getBoundingClientRect();
  let x = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
  const y = Math.max(0, Math.min(1, (event.clientY - box.top) / box.height));
  if (mirrored) x = 1 - x;
  return { x, y };
}
canvas.addEventListener('pointerdown', event => {
  if (!adjustingZone) return;
  zoneStart = pointerPosition(event); canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  if (!adjustingZone || !zoneStart) return;
  const p = pointerPosition(event);
  if (Math.abs(p.x - zoneStart.x) < .08 || Math.abs(p.y - zoneStart.y) < .08) return;
  zone = { x: Math.min(p.x, zoneStart.x), y: Math.min(p.y, zoneStart.y), width: Math.abs(p.x - zoneStart.x), height: Math.abs(p.y - zoneStart.y) };
  renderOverlay();
});
canvas.addEventListener('pointerup', () => { zoneStart = null; });
canvas.addEventListener('pointercancel', () => { zoneStart = null; });

$('enable-camera').addEventListener('click', () => enableCamera($('camera-select').value));
video.addEventListener('resize', syncCameraDimensions);
$('camera-select').addEventListener('change', updateCameraHelp);
$('start-session').addEventListener('click', () => startSession());
$('pause-session').addEventListener('click', () => phase === 'paused' ? resumeSession() : pauseSession());
$('finish-session').addEventListener('click', () => finishSession());
$('repeat-button').addEventListener('click', repeatInstruction);
$('listen-button').addEventListener('click', () => { liveVoice.muteMic(!liveVoice.micMuted); $('listen-button').setAttribute('aria-pressed', String(liveVoice.micMuted)); $('listen-button').setAttribute('aria-label', liveVoice.micMuted ? 'Unmute microphone' : 'Mute microphone'); });
$('connect-voice').addEventListener('click', async () => { if (liveVoice.ready) { await liveVoice.close(); } else { clearTimeout(voiceCloseTimer); speechGuide.stop(); try { await liveVoice.connect(); } catch { /* Visible connection error. */ } } });
$('mute-button').addEventListener('click', () => {
  muted = !muted;
  $('mute-button').setAttribute('aria-pressed', String(muted));
  $('mute-button').setAttribute('aria-label', muted ? 'Unmute voice guidance' : 'Mute voice guidance');
  $('mute-button').title = muted ? 'Unmute voice guidance' : 'Mute voice guidance';
  $('speaker-icon').style.opacity = muted ? '.35' : '1';
  liveVoice.muteOutput(muted); if (muted) speechGuide.stop(); else repeatInstruction();
});
$('body-toggle').addEventListener('click', () => { drawBody = !drawBody; $('body-toggle').setAttribute('aria-pressed', String(drawBody)); $('body-toggle').classList.toggle('active', drawBody); renderOverlay(); });
$('hands-toggle').addEventListener('click', () => { drawHands = !drawHands; $('hands-toggle').setAttribute('aria-pressed', String(drawHands)); $('hands-toggle').classList.toggle('active', drawHands); renderOverlay(); });
$('mirror-button').addEventListener('click', () => {
  mirrored = !mirrored; video.classList.toggle('mirrored', mirrored); canvas.classList.toggle('mirrored', mirrored);
  $('mirror-button').setAttribute('aria-pressed', String(mirrored));
  $('mirror-button').setAttribute('aria-label', `Turn camera mirroring ${mirrored ? 'off' : 'on'}`);
  $('mirror-label').hidden = !mirrored;
  renderOverlay();
});
$('fullscreen-button').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('camera-stage').requestFullscreen(); }
  catch { toast('This browser does not support fullscreen.'); }
});
$('zone-button').addEventListener('click', toggleZone);
$('stop-camera').addEventListener('click', cameraDisconnected);
$('download-video').addEventListener('click', saveVideo);
$('download-json').addEventListener('click', saveJson);
$('save-complete').addEventListener('click', async () => { await saveVideo(); await saveJson(); });
$('new-session').addEventListener('click', newSession);
$('settings-button').addEventListener('click', () => { $('settings-error').hidden = true; enumerateCameras(); $('settings-dialog').showModal(); });
$('studio-button').addEventListener('click', () => $('camera-stage').scrollIntoView({ behavior: 'smooth', block: 'center' }));
$('apply-settings').addEventListener('click', async () => {
  const objects = $('tasks-input').value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!objects.length || objects.length > 8 || objects.some(s => s.length > 80)) {
    $('settings-error').textContent = 'Enter 1–8 object names, each up to 80 characters.'; $('settings-error').hidden = false; return;
  }
  if (new Set(objects.map(s => s.toLowerCase())).size !== objects.length) {
    $('settings-error').textContent = 'Use distinct objects so each placement can be verified.'; $('settings-error').hidden = false; return;
  }
  intervalMs = Number($('interval-select').value); threshold = Number($('threshold-select').value); recordVideo = $('record-video').checked;
  tasks = objects.map((object, i) => ({ id: `step-${i + 1}`, object, instruction: `${i ? 'Now put' : 'Put'} the ${object} in the marked area, then move your hands away.` }));
  const deviceId = $('camera-select').value;
  const switched = cameraStream && deviceId && deviceId !== cameraStream.getVideoTracks()[0].getSettings().deviceId;
  $('settings-dialog').close();
  if (['complete', 'finished'].includes(phase)) newSession();
  if (switched) await enableCamera(deviceId);
  guide('Your sequence. Your moves.', `Gather ${objects.join(', ')}. Keep the objects outside the yellow target area, then start your capture.`, 'SEQUENCE READY');
  renderSequence();
  toast('Capture settings updated.');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && phase === 'capturing') {
    pauseSession();
    stageMessage('Capture paused because this tab was hidden. Return here and resume when ready.');
  }
});
window.addEventListener('beforeunload', event => {
  if (session && (recordedChunks.length || session.landmarks.length)) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { cameraStream?.getTracks().forEach(track => track.stop()); worker?.terminate(); liveVoice.cleanup(); speechGuide.cleanup(); });
navigator.mediaDevices?.addEventListener('devicechange', enumerateCameras);

try {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error();
  config = await response.json(); tasks = config.tasks;
  $('model-status').textContent = config.configured ? 'OpenRouter configured · 1s check target' : 'API key required · see capture/.env';
  $('model-led').className = config.configured ? 'model-led ready' : 'model-led error';
  renderSequence(); updateControls();
  if (!config.configured) stageMessage('Add your OpenRouter API key to capture/.env and restart the app to enable checkpoint checks.');
} catch {
  $('model-status').textContent = 'Capture server unavailable';
  $('model-led').className = 'model-led error';
  stageMessage('The capture server is unavailable. Start it with npm run dev in the capture directory.');
}

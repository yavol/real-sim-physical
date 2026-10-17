// MediaPipe's Emscripten loader calls importScripts. Use a classic worker and
// dynamic module imports so that loader can initialize without touching the UI.
let FilesetResolver;
let HandLandmarker;
let PoseLandmarker;
let bodyOnly;

let pose;
let hands;
let ready = false;

async function initialize(delegate) {
  if (!FilesetResolver) {
    ({ FilesetResolver, HandLandmarker, PoseLandmarker } = await import('/vendor/mediapipe/vision_bundle.mjs'));
    ({ bodyOnly } = await import('./session.js'));
  }
  const files = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
  const base = { delegate };
  pose = await PoseLandmarker.createFromOptions(files, {
    baseOptions: { ...base, modelAssetPath: '/models/pose_landmarker_lite.task' },
    runningMode: 'VIDEO', numPoses: 1,
    minPoseDetectionConfidence: .5, minPosePresenceConfidence: .5,
    minTrackingConfidence: .5, outputSegmentationMasks: false,
  });
  hands = await HandLandmarker.createFromOptions(files, {
    baseOptions: { ...base, modelAssetPath: '/models/hand_landmarker.task' },
    runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5,
  });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      let delegate = 'GPU';
      try { await initialize(delegate); }
      catch {
        pose?.close(); hands?.close();
        delegate = 'CPU';
        await initialize(delegate);
      }
      ready = true;
      self.postMessage({ type: 'ready', delegate });
    } catch (error) {
      console.error('MediaPipe initialization failed:', error);
      self.postMessage({ type: 'error', message: 'Body and hand tracking could not load. Check the model files and reload tracking.', detail: String(error?.stack || error) });
    }
  }
  if (data.type === 'frame') {
    const { bitmap, timestamp } = data;
    if (!ready) { bitmap.close(); return; }
    try {
      const start = performance.now();
      const result = bodyOnly({ pose: pose.detectForVideo(bitmap, timestamp), hands: hands.detectForVideo(bitmap, timestamp) });
      self.postMessage({ type: 'result', ...result, timestamp, inferenceMs: Math.round(performance.now() - start) });
    } catch {
      self.postMessage({ type: 'frame-error', timestamp });
    } finally { bitmap.close(); }
  }
};

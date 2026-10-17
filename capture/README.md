# Relay capture studio

A local web app for recording a voice-guided human demonstration. The robot console in the parent directory remains independent.

```sh
./start-capture.sh
```

From this directory, use `npm run dev`. Open [http://127.0.0.1:8790](http://127.0.0.1:8790) on this laptop. The server binds to loopback only. Chrome or Edge is recommended; the Codex in-app browser also needs camera permission in macOS. Camera access begins after **Enable camera**.

## Capture a demonstration

1. Gather a soda can and a water bottle. Frame a work surface and your hands.
2. Enable the camera and wait for **Body + hands**. **Adjust target area** lets you drag a rectangle over your destination, including a box if desired. Keep the objects outside it initially.
3. Press **Start capture**. The voice asks for the can, then the bottle. Place each inside the area, release it, and withdraw your hands.
4. Clef checks compressed camera frames, targeting one check per second. Two consecutive results with at least 85% placement and object-visibility probability confirm each step. The loop waits for an in-flight call; actual frequency depends on latency.
5. Save the video and session JSON after completion, or **Finish** to save a partial capture. Files are held in browser memory until downloaded. Save them before closing the page or starting another capture.

Use settings to change cameras, the object sequence, confidence threshold, interval, or video recording. Capture pauses when the tab is hidden. If an object was already in the destination at the beginning of a step, pause, move it outside the area, and resume to take a new baseline. Sessions are limited to ten minutes and 300 MB of recorded video.

For an iPhone connected with Continuity Camera, select its camera in capture settings. Lens selection is in the Mac's green Video menu: turn off Centre Stage, hover over the preview, and zoom out to 0.5× for the widest view. Apple also provides Main / Ultra Wide in the Centre Stage options. See [Apple's camera controls](https://support.apple.com/en-gb/guide/mac-help/mchlp2980/26/mac/26).

Landscape and portrait video are supported. Position the phone before enabling the camera; if its picture stays sideways, turn off Portrait Orientation Lock on the iPhone, lock it again, and reconnect the camera. The preview and landmark overlay follow changes in the video's dimensions. A size change during capture pauses the session so Resume can take a fresh baseline; the session JSON records the new dimensions in `camera.formatChanges`.

## Voice

**Default narration:** OpenAI `gpt-4o-mini-tts`, with **Marin**. Instructions use a conversational delivery prompt. Audio is cached in bounded memory caches so repeating an instruction does not generate it again. This does not request microphone access. The waveform reflects actual output audio.

**Talk to guide:** an optional, full-duplex OpenAI `gpt-live-1` conversation with Marin. Ask clarifying questions, request status, pause, resume, or repeat. It receives current app state and Clef evidence. Its `gpt-6-luna` backend can operate those capture controls; it has no tool to skip or verify a checkpoint. Ending the conversation returns to TTS narration. Microphone audio is sent to OpenAI only while the live conversation is connected. Live sessions are closed after capture finishes; an explicit **End chat** closes one sooner. All guide speech is AI-generated.

The supplied OpenAI project was verified to expose `gpt-live-1`; `gpt-live-1.1` was not listed. The exact Live model is configurable rather than silently substituted.

## Tracking and data

MediaPipe Pose Landmarker Lite and Hand Landmarker run in a **classic Web Worker**, using GPU with CPU fallback. A module worker is incompatible with this MediaPipe version's `importScripts` loader. The worker sends only body landmarks 11–32 and both 21-point hands to the UI. Coarse head points 0–10 are discarded, and no Face Landmarker is loaded.

Green is body pose, cyan and amber are the two hands. Both preview and overlay use the same mirror transform. **Recording and exported coordinates remain unmirrored.** Tracking stays on-device. Only small JPEG frames and a step-baseline image go to OpenRouter/Cloudflare for Clef checkpoints. The recorder saves the original camera stream without burned-in overlays or microphone audio.

The `relay.capture.v1` JSON export contains:

- Session identity, task sequence, target area, model settings, recording metadata, and active duration.
- Timestamped body and hand landmarks, normalized image coordinates, world-coordinate estimates, and handedness.
- Every visual decision, provider request identity, latency, usage, and both pieces of evidence for each verified checkpoint.
- Successful checkpoint images and baselines, pause events, and narration or optional conversation transcripts.

`timeMs` follows the active recording timeline and excludes pauses. `cameraTimeMs` follows the original camera timeline. Body arrays use the accompanying `bodyLandmarkIndices` mapping. World coordinates are model estimates, not calibrated robot coordinates or a retargeting solution. There is no robot connection or training pipeline yet.

## Setup and credentials

```sh
npm install
npm run setup
cp .env.example .env
```

Add `OPENROUTER_API_KEY` and `OPENAI_API_KEY` to `.env`. This checkout's `.env` takes precedence over inherited credentials. The provided credentials are already saved locally with mode `0600`. `.gitignore` excludes secrets, dependencies, and QA recordings. The HTTP server only serves `public/` and an allowlist of MediaPipe runtime assets; it cannot serve `.env` or server source. Credentials never reach the browser. Do not expose the local proxy publicly without adding authentication.

Model and font assets are downloaded once and served locally. Their sources and SHA-256 checksums are recorded in `asset-manifest.json`.

## Validation

```sh
npm run check
npm test
```

The tests cover checkpoint freshness and consecutive evidence, face-point removal, hand visibility, input limits, origin/host protection, credential isolation, API errors/timeouts, speech caching, and the optional Live control boundary. Tests use provider stubs and briefly bind loopback ports; they do not spend API credits.

Manual QA uses public Google MediaPipe photos as an explicitly prerecorded fake camera, with real MediaPipe inference. Real OpenRouter image classification, real OpenAI TTS audio playback, and real GPT-Live WebRTC startup were exercised separately. An 18-second negative capture exported playable VP9 video, 140 landmark samples, and 15 real Clef decisions without advancing either missing-object checkpoint. Positive sequence progression is also exercised with a clearly labeled response fixture; this is a UI test, not a measurement of physical placement accuracy. Physical soda-can and water-bottle accuracy still needs evaluation with the intended camera and scene.

Sources: [OpenRouter multimodal Decisions](https://openrouter.ai/docs/guides/community/multimodal-decisions), [MediaPipe hand landmarks](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js), [MediaPipe pose landmarks](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js), [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech), [OpenAI Live](https://developers.openai.com/api/docs/guides/live).

## Video library

Start `../start-library.sh` from this directory, or `./start-library.sh` from the project root. Newly loaded Capture pages include a **Video library** link and **Save to library** after recording. That action saves both the original video and session JSON to the local library at http://127.0.0.1:8791, then waits for a save acknowledgement. Keep the capture open if saving fails. This does not send footage to VAST. Existing Capture tabs need a reload before a new capture to show the new controls; finish and download any unsaved recording first.

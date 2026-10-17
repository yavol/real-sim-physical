import { InputError } from './checkpoints.mjs';

export const LIVE_ENDPOINT = 'https://api.openai.com/v1/live/sessions';
export const VOICE_MODEL = 'gpt-live-1';
export const VOICE = 'marin';
export const VOICE_BACKEND = 'gpt-6-luna';
export const SPEECH_ENDPOINT = 'https://api.openai.com/v1/audio/speech';
export const TTS_MODEL = 'gpt-4o-mini-tts';
export const CONTROL_ACTIONS = ['start', 'pause', 'resume', 'repeat', 'status'];

export function buildSpeech(body, { model = TTS_MODEL, voice = VOICE } = {}) {
  if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 700) throw new InputError('Use a spoken instruction of 1–700 characters.');
  return {
    model, voice, input: body.text.trim(), response_format: 'wav',
    instructions: 'Speak like a calm, friendly colleague helping someone with a hands-on task. Warm, natural, conversational delivery, clear pronunciation, a comfortable pace, and subtle expression. No announcer voice, exaggerated excitement, stiff robotic cadence, or unnecessary pauses. Read only the supplied words.',
  };
}

export function buildLiveSession(body, { model = VOICE_MODEL, voice = VOICE, backendModel = VOICE_BACKEND } = {}) {
  if (typeof body?.sdp !== 'string' || !body.sdp.startsWith('v=0') || body.sdp.length > 64000 || !body.sdp.includes('m=audio')) throw new InputError('A valid WebRTC audio offer is required.');
  const context = body.context;
  if (!context || typeof context !== 'object' || !Array.isArray(context.tasks) || context.tasks.length < 1 || context.tasks.length > 8 || context.tasks.some(t => typeof t !== 'string' || t.length > 80)) throw new InputError('A valid capture sequence is required.');
  const sequence = context.tasks.map((name, i) => `${i + 1}. ${name}`).join('; ');
  return {
    session: {
      model, store: false,
      audio: { output: { voice } },
      instructions: `You are Relay, an AI voice guide helping someone record a tabletop manipulation demonstration. Speak like a calm, thoughtful colleague: natural, warm, brief, conversational, never robotic, salesy, or overenthusiastic. One useful instruction at a time. Listen and respond naturally when interrupted. Allow quiet time for movement; do not fill every silence. The sequence is ${sequence}. Each task is to put that object into the yellow target area, release it, and move hands away. Before recording, objects must be OUTSIDE the target area. You have no direct camera or body perception: the app sends verified visual facts from Clef. Only announce successful placement after an app update explicitly says it is verified. Never infer success from the user saying done, from time passing, or from your own guess. Never advance or skip checkpoints. React to verified updates, give short helpful guidance, and wait. For requests to start, pause, resume, repeat, or check status, delegate to the backend, which can operate the capture controls. For questions about the setup you can answer from this context. Do not ask the user to do dangerous actions or move the computer during recording.`,
      input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Open with a brief, friendly greeting. You are connected to a capture studio. Ask the user to frame their table and keep the objects outside the marked target area before starting. If an app instruction arrives, give that instruction instead of repeating the greeting.' }] }],
      delegation: {
        type: 'responses',
        responses: {
          model: backendModel,
          instructions: 'You operate a local capture app for a spoken assistant. Use capture_control for start, pause, resume, repeat, and status requests. For progress questions, query status; do not rely on old context. Return a brief factual result. The app alone verifies placements using Clef; neither user claims nor voice tools can complete or skip a checkpoint. Never invent successful capture actions. Repeat uses the app current instruction, not a guessed instruction. The app enforces camera and tracking readiness. Be concise.',
          tools: [{ type: 'function', name: 'capture_control', description: 'Read the actual capture state or perform a user-requested capture control. Does not verify or advance object checkpoints.', parameters: { type: 'object', properties: { action: { type: 'string', enum: CONTROL_ACTIONS } }, required: ['action'], additionalProperties: false }, strict: true }],
          tool_choice: 'auto', parallel_tool_calls: false,
        },
      },
    },
    transport: { type: 'webrtc', sdp: body.sdp },
  };
}

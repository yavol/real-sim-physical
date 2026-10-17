// Explicitly synthetic success responses, only for UI lifecycle/export QA.
import { readFile } from 'node:fs/promises';
import { createCaptureServer } from '../server.mjs';
const wav = await readFile(new URL('../artifacts/qa/openai-narration.wav', import.meta.url));
const result = {
  id: 'TEST_FIXTURE_ONLY', model: 'TEST_FIXTURE_ONLY', provider: 'QA fixture',
  answers: {
    placement: { type: 'choice', choice: 'placed', probabilities: { placed: .99, not_placed: .0025, in_progress: .0025, already_present: .0025, uncertain: .0025 } },
    target_visible: { type: 'noul', noul: .99 },
  }, usage: { input_tokens: 0, cost: 0 },
};
createCaptureServer({ apiKey: 'fixture-not-a-key', openaiKey: 'fixture-not-a-key', fetchImpl: async () => Response.json(result), voiceFetchImpl: async () => new Response(wav, { headers: { 'Content-Type': 'audio/wav' } }) }).listen(8791, '127.0.0.1', () => console.log('QA FIXTURES ONLY → http://127.0.0.1:8791 · no provider API calls'));

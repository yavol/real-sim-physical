import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureServer } from '../server.mjs';
import { buildSpeech, buildLiveSession, SPEECH_ENDPOINT, LIVE_ENDPOINT } from '../lib/voice.mjs';

const offer = { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', context: { tasks: ['soda can', 'water bottle'] } };
const audio = Buffer.alloc(150); audio.write('RIFF'); audio.write('WAVE', 8);
async function withServer(options, run) {
  const server = createCaptureServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('natural TTS uses Marin with expressive instructions and rejects excessive input', () => {
  const request = buildSpeech({ text: 'Put the soda can in the marked area.' });
  assert.equal(request.model, 'gpt-4o-mini-tts'); assert.equal(request.voice, 'marin');
  assert.equal(request.response_format, 'wav'); assert.match(request.instructions, /natural/);
  assert.throws(() => buildSpeech({ text: '' })); assert.throws(() => buildSpeech({ text: 'a'.repeat(701) }));
});
test('speech proxy keeps credentials on the server and caches repeated narration', async () => {
  let calls = 0;
  await withServer({ openaiKey: 'test-openai-secret', voiceFetchImpl: async (url, options) => {
    calls++; assert.equal(url, SPEECH_ENDPOINT); assert.equal(options.headers.Authorization, 'Bearer test-openai-secret');
    return new Response(audio, { headers: { 'Content-Type': 'audio/wav' } });
  } }, async base => {
    const first = await fetch(base + '/api/voice/speech', post({ text: 'Put the can in the area.' }));
    assert.equal(first.status, 200); assert.equal(first.headers.get('content-type'), 'audio/wav');
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), audio);
    const second = await fetch(base + '/api/voice/speech', post({ text: 'Put the can in the area.' }));
    assert.equal(second.headers.get('x-voice-cache'), 'hit'); assert.equal(calls, 1);
  });
});
test('invalid speech and external origins cannot reach the provider', async () => {
  let calls = 0;
  await withServer({ openaiKey: 'test', voiceFetchImpl: async () => { calls++; return new Response(audio); } }, async base => {
    assert.equal((await fetch(base + '/api/voice/speech', post({ text: 'a'.repeat(701) }))).status, 400);
    const options = post({ text: 'Test' }); options.headers.Origin = 'https://example.com';
    assert.equal((await fetch(base + '/api/voice/speech', options)).status, 403); assert.equal(calls, 0);
  });
});
test('optional live conversation can control recording but cannot verify or skip checkpoints', () => {
  const request = buildLiveSession(offer);
  assert.equal(request.session.model, 'gpt-live-1'); assert.equal(request.session.audio.output.voice, 'marin');
  assert.equal(request.session.store, false); assert.equal(request.session.delegation.type, 'responses');
  const actions = request.session.delegation.responses.tools[0].parameters.properties.action.enum;
  assert.deepEqual(actions, ['start', 'pause', 'resume', 'repeat', 'status']);
  assert.match(request.session.instructions, /Never advance or skip checkpoints/);
  assert.throws(() => buildLiveSession({ sdp: 'invalid', context: offer.context }));
});
test('live session proxy returns only the session identity and SDP, never the project key', async () => {
  await withServer({ openaiKey: 'test-secret', voiceFetchImpl: async (url, options) => {
    assert.equal(url, LIVE_ENDPOINT); assert.equal(JSON.parse(options.body).transport.type, 'webrtc');
    return Response.json({ session: { id: 'live_test' }, transport: { sdp: 'answer-sdp' }, secret: 'test-secret' });
  } }, async base => {
    const response = await fetch(base + '/api/voice/session', post(offer));
    assert.equal(response.status, 201);
    const body = await response.json(); assert.equal(body.session.id, 'live_test'); assert.equal(body.transport.sdp, 'answer-sdp');
    assert.ok(!JSON.stringify(body).includes('test-secret'));
  });
});

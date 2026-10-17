import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildDecision, parseDecision, validateCheckpoint, validateImage, ENDPOINT } from '../lib/checkpoints.mjs';
import { CheckpointGate, bodyOnly } from '../public/session.js';
import { createCaptureServer } from '../server.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const payload = { image: PNG, referenceImage: PNG, task: { object: 'soda can', instruction: 'Put the soda can inside the target area.' }, zone: { x: .3, y: .4, width: .3, height: .3 } };
const response = { id: 'test-only', model: 'cloudflare/clef-flash', provider: 'Cloudflare', answers: { placement: { type: 'choice', choice: 'placed', probabilities: { placed: .94, in_progress: .02, not_placed: .01, already_present: .02, uncertain: .01 } }, target_visible: { type: 'noul', noul: .96 } }, usage: { input_tokens: 1000, cost: .00009 } };
const positive = parseDecision(response);

test('completion requires two consecutive confident placements with target visibility', () => {
  const gate = new CheckpointGate();
  assert.deepEqual(gate.observe(positive, 1000), { complete: false, streak: 1 });
  assert.deepEqual(gate.observe(positive, 2000), { complete: true, streak: 2 });
});
test('a low-confidence, uncertain, or interrupted placement cannot complete a checkpoint', () => {
  for (const bad of [{ ...positive, placedProbability: .6 }, { ...positive, targetVisible: .2 }, { ...positive, state: 'in_progress' }, { ...positive, state: 'already_present' }]) {
    const gate = new CheckpointGate(); gate.observe(positive, 1000);
    assert.equal(gate.observe(bad, 2000).streak, 0);
    assert.equal(gate.observe(positive, 3000).complete, false);
  }
});
test('stale evidence and reset cannot carry a positive streak into another task', () => {
  const gate = new CheckpointGate(); gate.observe(positive, 1000);
  assert.equal(gate.observe(positive, 11000).complete, false);
  gate.reset(); assert.equal(gate.observe(positive, 12000).streak, 1);
});
test('face points are discarded and finger landmarks are preserved', () => {
  const points = Array.from({ length: 33 }, (_, i) => ({ x: i, y: i / 100, z: 0, visibility: .9 }));
  const hand = points.slice(0, 21);
  const result = bodyOnly({ pose: { landmarks: [points], worldLandmarks: [points] }, hands: { landmarks: [hand], worldLandmarks: [hand], handedness: [[{ categoryName: 'Left', score: .99 }]] } });
  assert.equal(result.body[0].length, 22); assert.equal(result.body[0][0].x, 11);
  assert.equal(result.bodyWorld[0].length, 22); assert.equal(result.hands[0].length, 21);
  assert.equal('visibility' in result.hands[0][0], false);
  assert.deepEqual(result.handedness[0], { label: 'Left', score: .99 });
});
test('decision request uses the documented multimodal protocol and both images', () => {
  const request = buildDecision(payload);
  assert.equal(request.model, 'cloudflare/clef-flash');
  assert.equal(request.state.filter(s => s.type === 'image_url').length, 2);
  assert.equal(request.questions.placement.type, 'choice');
  assert.equal(request.questions.target_visible.type, 'noul');
  assert.ok(request.questions.placement.criteria.already_present);
});
test('untrusted frames, oversized inputs, and invalid target areas are rejected', () => {
  for (const image of ['https://example.com/image.jpg', 'data:image/png;base64,YWJjZA==', PNG.replace('image/png', 'image/jpeg')]) assert.throws(() => validateImage(image));
  assert.throws(() => validateImage('data:image/jpeg;base64,' + 'a'.repeat(150000)));
  assert.throws(() => validateCheckpoint({ ...payload, zone: { x: .9, y: 0, width: .4, height: .3 } }));
  assert.throws(() => validateCheckpoint({ ...payload, task: { object: '', instruction: 'test' } }));
});
test('provider answers must contain complete, valid probabilities', () => {
  assert.throws(() => parseDecision({ answers: {} }));
  assert.throws(() => parseDecision({ ...response, answers: { ...response.answers, placement: { ...response.answers.placement, probabilities: { ...response.answers.placement.probabilities, placed: 5 } } } }));
});

async function withServer(options, action) {
  const server = createCaptureServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await action(base); } finally { await new Promise(resolve => server.close(resolve)); }
}
test('static server exposes only public assets and never the secret or source', async () => {
  await withServer({ apiKey: 'private-test-key' }, async base => {
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.configured, true); assert.ok(!JSON.stringify(config).includes('private-test-key'));
    for (const url of ['/.env', '/server.mjs', '/lib/checkpoints.mjs', '/vendor/mediapipe/package.json', '/%2eenv']) assert.equal((await fetch(base + url)).status, 404);
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(base + '/tracking-worker.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  });
});
test('cross-origin calls and hostile hosts cannot spend API credits', async () => {
  let calls = 0;
  await withServer({ apiKey: 'test', fetchImpl: async () => { calls++; } }, async base => {
    assert.equal((await fetch(base + '/api/checkpoint', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).status, 403);
    // Node fetch replaces Host. Use the raw HTTP client for the rebinding case.
    const hostileStatus = await new Promise((resolve, reject) => {
      const req = http.request(base + '/api/checkpoint', { method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end(JSON.stringify(payload));
    });
    assert.equal(hostileStatus, 403);
    assert.equal(calls, 0);
  });
});
test('proxy sends the server-only credential to the exact endpoint and returns normalized evidence', async () => {
  let outbound;
  await withServer({ apiKey: 'secret-for-test', fetchImpl: async (url, options) => { outbound = { url, options }; return Response.json(response); } }, async base => {
    const res = await fetch(base + '/api/checkpoint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(outbound.url, ENDPOINT); assert.equal(outbound.options.headers.Authorization, 'Bearer secret-for-test');
    assert.equal(JSON.parse(outbound.options.body).state.filter(p => p.type === 'image_url').length, 2);
    assert.equal(data.state, 'placed'); assert.equal(data.placedProbability, .94);
    assert.ok(!JSON.stringify(data).includes('secret-for-test'));
    assert.equal((await fetch(base + '/api/checkpoint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).status, 429);
  });
});
test('provider errors do not leak echoed request images or secrets', async () => {
  await withServer({ apiKey: 'secret-for-test', fetchImpl: async () => new Response('secret-for-test ' + PNG, { status: 401 }) }, async base => {
    const res = await fetch(base + '/api/checkpoint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(res.status, 502);
    const data = await res.text(); assert.ok(!data.includes('secret-for-test')); assert.ok(!data.includes(PNG));
    assert.match(data, /rejected the API key/);
  });
});
test('only one paid provider request can be in flight at once', async () => {
  let release;
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  await withServer({ apiKey: 'test', fetchImpl: () => { started(); return new Promise(resolve => { release = () => resolve(Response.json(response)); }); } }, async base => {
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    const first = fetch(base + '/api/checkpoint', options);
    await firstStarted;
    assert.equal((await fetch(base + '/api/checkpoint', options)).status, 429);
    release(); assert.equal((await first).status, 200);
  });
});
test('provider timeout releases the in-flight lock and returns a recoverable error', async () => {
  await withServer({ apiKey: 'test', requestTimeout: 20, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) }, async base => {
    const res = await fetch(base + '/api/checkpoint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(res.status, 504);
  });
});

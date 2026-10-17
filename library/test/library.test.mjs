import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLibraryServer } from '../server.mjs';
import { VastClient } from '../vast.mjs';
import { cleanMetadata } from '../store.mjs';
import { filterVideos } from '../public/query.js';
const fixture = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100, 1)]);
const session = { schemaVersion: 'relay.capture.v1', id: 'session-fixture', tasks: [{ object: 'Bottle' }, { object: 'Can' }], checkpoints: [{ stepIndex: 0 }], durationMs: 12000, completed: false, landmarks: [{}, {}], camera: { width: 1280, height: 720 } };
async function withServer(action) {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-library-test-'));
  const server = await createLibraryServer({ dataRoot: root, uploads: false, runs: false, probe: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await action({ base, server, root }); }
  finally { await Promise.allSettled([...server.store.jobs.values()]); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
}
async function upload(base, filename = 'bottle-demo.mp4') {
  const response = await fetch(`${base}/api/library/videos?filename=${encodeURIComponent(filename)}`, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: fixture });
  assert.equal(response.status, 201); return (await response.json()).video;
}
test('upload persists original bytes, supports ranges, and keeps internal paths private', async () => {
  await withServer(async ({ base, root }) => {
    const video = await upload(base); assert.equal(video.filename, 'bottle-demo.mp4'); assert.equal(video.source, 'upload'); assert.equal(video.bytes, fixture.length); assert.equal('file' in video, false);
    const whole = await fetch(base + video.videoUrl); assert.deepEqual(Buffer.from(await whole.arrayBuffer()), fixture);
    const range = await fetch(base + video.videoUrl, { headers: { Range: 'bytes=10-29' } }); assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 10-29/${fixture.length}`); assert.deepEqual(Buffer.from(await range.arrayBuffer()), fixture.subarray(10, 30));
    const suffix = await fetch(base + video.videoUrl, { headers: { Range: 'bytes=-8' } }); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), fixture.subarray(-8));
    const bad = await fetch(base + video.videoUrl, { headers: { Range: 'bytes=900-999' } }); assert.equal(bad.status, 416);
    const head = await fetch(base + video.videoUrl, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), String(fixture.length));
    const saved = JSON.parse(await readFile(path.join(root, `${video.id}.json`), 'utf8')); assert.equal(saved.id, video.id);
    const dl = await fetch(`${base}/api/library/videos/${video.id}/download`); assert.match(dl.headers.get('content-disposition'), /bottle-demo/);
  });
});
test('metadata edits, favorites and attached capture evidence survive a fresh store', async () => {
  await withServer(async ({ base, root, server }) => {
    const video = await upload(base);
    const edits = await fetch(`${base}/api/library/videos/${video.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Bottle into box', tags: ['Bottle', 'right hand'], favorite: true }) }); assert.equal(edits.status, 200);
    const attachment = await fetch(`${base}/api/library/videos/${video.id}/session`, { method: 'POST', body: JSON.stringify(session) }); assert.equal(attachment.status, 201); const saved = (await attachment.json()).video;
    assert.equal(saved.source, 'capture'); assert.equal(saved.status, 'partial'); assert.equal(saved.capture.checkpointCount, 1); assert.equal(saved.capture.taskCount, 2); assert.equal(saved.capture.landmarkSamples, 2); assert.ok(saved.sessionUrl); assert.equal(saved.favorite, true);
    assert.deepEqual(await (await fetch(base + saved.sessionUrl)).json(), session);
    await Promise.allSettled([...server.store.jobs.values()]);
    const reopened = await createLibraryServer({ dataRoot: root, uploads: false, runs: false, probe: false });
    const rows = await reopened.store.list(); assert.equal(rows.length, 1); assert.equal(rows[0].title, 'Bottle into box'); assert.equal(rows[0].favorite, true); assert.equal(rows[0].status, 'partial'); assert.ok(rows[0].tags.includes('bottle'));
  });
});
test('rejected uploads leave no partial files and do not overwrite originals', async () => {
  await withServer(async ({ base, root }) => {
    const invalid = await fetch(base + '/api/library/videos?filename=not-video.mp4', { method: 'POST', body: Buffer.alloc(100, 1) }); assert.equal(invalid.status, 415);
    const wrongType = await fetch(base + '/api/library/videos?filename=script.html', { method: 'POST', body: fixture }); assert.equal(wrongType.status, 415);
    assert.deepEqual(await readdir(root), []);
  });
});
test('same-device capture can save; external origins, hidden files and source are blocked', async () => {
  await withServer(async ({ base }) => {
    const config = await fetch(base + '/api/library/config'); assert.equal(config.status, 200); assert.equal((await config.json()).vast.configured, false);
    const foreign = await fetch(base + '/api/library/videos?filename=x.mp4', { method: 'POST', headers: { Origin: 'https://outside.example' }, body: fixture }); assert.equal(foreign.status, 403);
    const capture = await fetch(base + '/api/library/config', { headers: { Origin: 'http://127.0.0.1:8790' } }); assert.equal(capture.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8790');
    for (const file of ['/.env', '/server.mjs', '/store.mjs', '/%2eenv', '/api/library/videos/bad/stream']) assert.equal((await fetch(base + file)).status, 404);
    assert.equal((await fetch(base)).status, 200);
  });
});
test('search combines terms and filters, and sorts real numeric values', () => {
  const videos = [
    { id: 'a', title: 'Bottle placement 10', description: 'box', filename: 'a.mp4', tags: ['right hand'], source: 'capture', status: 'verified', duration: 12, bytes: 20, createdAt: '2026-10-16', favorite: true },
    { id: 'b', title: 'Bottle placement 2', description: 'box', filename: 'b.mp4', tags: ['right hand'], source: 'upload', status: 'ready', duration: 35, bytes: 30, createdAt: '2026-10-17' },
    { id: 'c', title: 'Can', description: '', filename: 'c.mp4', tags: ['simulation'], source: 'rollout', status: 'partial', duration: 4, bytes: 10, createdAt: '2026-10-15' },
  ];
  assert.deepEqual(filterVideos(videos, { query: 'BOTTLE right' }).map(v => v.id), ['b', 'a']);
  assert.deepEqual(filterVideos(videos, { source: 'demonstration', sort: 'longest' }).map(v => v.id), ['b', 'a']);
  assert.deepEqual(filterVideos(videos, { favorite: true, status: 'verified' }).map(v => v.id), ['a']);
  assert.deepEqual(filterVideos(videos, { sort: 'name' }).map(v => v.id), ['b', 'a', 'c']);
  assert.deepEqual(filterVideos(videos, { query: 'missing' }), []);
});
test('metadata validation prevents malformed tags and injected filesystem fields', () => {
  assert.deepEqual(cleanMetadata({ title: '  My video  ', tags: ['Bottle', 'bottle'], file: '/etc/passwd', source: 'vast' }), { title: 'My video', tags: ['bottle'] });
  assert.throws(() => cleanMetadata({ title: '' })); assert.throws(() => cleanMetadata({ tags: [null] })); assert.throws(() => cleanMetadata({ favorite: 'true' }));
});
test('VAST uses documented listing/search and keeps its token off client URLs', async () => {
  const calls = [];
  const vast = new VastClient({ baseUrl: 'https://vast.example', token: 'server-private-token', fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json(url.includes('/search') ? { chunk_results: [{ original_video: 's3://bucket/bottle.mp4', preview_source: 's3://bucket/segment.mp4', similarity_score: .88, best_match_start_sec: 8 }] } : { videos: [{ original_video: 's3://bucket/bottle.mp4', tags: ['bottle'], duration_sec: 20, created_at: '2026-10-17T10:00:00Z' }] }); } });
  const listing = await vast.explore(); assert.equal(listing.videos.length, 1); assert.equal(vast.status.connected, true); assert.ok(calls[0].url.includes('/api/v1/videos/explore?')); assert.equal(calls[0].options.headers.Authorization, 'Bearer server-private-token');
  const matches = await vast.search('bottle into box'); assert.equal(matches.videos[0].startTime, 8); assert.equal(matches.videos[0].score, .88); assert.equal(JSON.stringify(matches).includes('server-private-token'), false); assert.equal(JSON.parse(calls[1].options.body).query, 'bottle into box');
  assert.equal(matches.videos[0].videoUrl.startsWith('/api/library/vast/'), true);
  await vast.stream(matches.videos[0].id, { headers: { range: 'bytes=0-1' } });
  assert.equal(new URL(calls[2].url).searchParams.get('source'), 's3://bucket/bottle.mp4');
  assert.equal(new URL(calls[2].url).searchParams.get('token'), 'server-private-token');
  assert.equal(calls[2].options.headers.Range, 'bytes=0-1');
});
test('VAST failures are explicit and never report a successful connection', async () => {
  const vast = new VastClient({ baseUrl: 'https://vast.example', token: 'secret', fetchImpl: async () => new Response('private credential detail', { status: 401 }) });
  await assert.rejects(vast.explore(), /valid workspace access token/); assert.equal(vast.status.connected, false);
  assert.throws(() => vast.configure('https://user:password@host', ''), /without embedded credentials/);
});

test('Cloudflare redirects and HTML sign-in pages cannot masquerade as a connected index', async () => {
  for (const response of [new Response('', { status: 302, headers: { Location: 'https://signin.example' } }), new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } })]) {
    const vast = new VastClient({ baseUrl: 'https://vast.example', fetchImpl: async () => response });
    await assert.rejects(vast.explore(), /sign-in/); assert.equal(vast.status.connected, false);
  }
});

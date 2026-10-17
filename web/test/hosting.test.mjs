import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHostedHandler } from '../handler.mjs';
import { authenticated, sessionCookie } from '../auth.mjs';
import { createHmac } from 'node:crypto';

const env = { PUBLIC_HOST: 'demo.test', DEMO_ACCESS_CODE: 'test-invitation', DEMO_SESSION_SECRET: 'a-test-session-secret', ROBOT_BACKEND_URL: 'https://robot.example.test', ROBOT_WEB_TOKEN: 'private-gateway-token', OPENROUTER_API_KEY: 'test-checkpoint-key' };

async function withServer(t, options = {}) {
  const server = http.createServer(createHostedHandler({ env, ...options }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return (route, { unlocked = false, headers = {}, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
      headers: { Host: 'demo.test', ...(unlocked ? { Cookie: sessionCookie(env).split(';')[0] } : {}), ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.on('error', reject); request.end(body);
  });
}

test('metadata is public but contains no credentials; paid routes require a session', async t => {
  let calls = 0;
  const request = await withServer(t, { fetchImpl: async () => { calls++; throw new Error(); } });
  const info = await request('/api/session');
  assert.deepEqual(await info.json(), { unlocked: false, public: false, configured: true, robot: true, collection: true, library: false });
  for (const route of ['/api/state', '/api/events', '/api/config', '/api/checkpoint', '/api/voice/session', '/api/runs']) assert.equal((await request(route)).status, 401);
  assert.equal(calls, 0);
});

test('correct code sets an HttpOnly signed session and tampered or expired cookies fail', async t => {
  const request = await withServer(t);
  const response = await request('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://demo.test' }, body: JSON.stringify({ code: env.DEMO_ACCESS_CODE }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /; Secure/);
  assert.equal(authenticated({ headers: { cookie } }, env), true);
  assert.equal(authenticated({ headers: { cookie: cookie.replace(/real_sim_demo=./, 'real_sim_demo=0') } }, env), false);
  assert.equal(authenticated({ headers: { cookie } }, env, Date.now() + 86_400_000), false);
  assert.equal(authenticated({ headers: { cookie } }, { ...env, DEMO_SESSION_SECRET: 'different-secret' }), false);
  assert.equal((await request('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' })).status, 400);
});

test('cross-origin and unknown hosts are rejected even with a valid session', async t => {
  const request = await withServer(t);
  assert.equal((await request('/api/session', { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await request('/api/session', { headers: { Host: 'evil.test' } })).status, 403);
  assert.equal((await request('/api/runs', { unlocked: true, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('the robot proxy preserves SSE reconnect state and attaches the private gateway token only upstream', async t => {
  let captured;
  const request = await withServer(t, { fetchImpl: async (url, options) => {
    captured = { url: url.toString(), options };
    return new Response('id: 8\ndata: {"type":"idle"}\n\n', { headers: { 'Content-Type': 'text/event-stream', 'X-Private': 'must-not-forward' } });
  } });
  const response = await request('/api/handler?route=events&after=7', { unlocked: true, headers: { 'Last-Event-ID': '7' } });
  assert.equal(response.status, 200); assert.match(await response.text(), /id: 8/);
  assert.equal(captured.url, 'https://robot.example.test/api/events?after=7');
  assert.equal(captured.options.headers.Authorization, `Bearer ${env.ROBOT_WEB_TOKEN}`);
  assert.equal(captured.options.headers['Last-Event-ID'], '7');
  assert.equal(response.headers.get('x-private'), null);
  assert.equal(response.headers.get('authorization'), null);
});

test('recording range requests are forwarded, while traversal and arbitrary proxy destinations are blocked', async t => {
  let calls = 0;
  const request = await withServer(t, { fetchImpl: async (url, options) => {
    calls++; assert.equal(options.headers.Range, 'bytes=0-9');
    return new Response('0123456789', { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-9/100', 'Accept-Ranges': 'bytes' } });
  } });
  const response = await request('/api/handler?recording=20261017-141442-81fe2a/rollout.mp4', { unlocked: true, headers: { Range: 'bytes=0-9' } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 0-9/100');
  assert.equal(await response.text(), '0123456789');
  for (const route of ['/api/handler?recording=../../.env', '/api/handler?route=https://evil.test', '/api/unknown']) assert.equal((await request(route, { unlocked: true })).status, 404);
  assert.equal(calls, 1);
});

test('provider failures cannot expose backend bodies or credentials', async t => {
  const request = await withServer(t, { fetchImpl: async () => new Response(env.ROBOT_WEB_TOKEN, { status: 500 }) });
  const response = await request('/api/state', { unlocked: true });
  assert.equal(response.status, 502); assert.ok(!(await response.text()).includes(env.ROBOT_WEB_TOKEN));
});

test('capture requests retain the guarded route after Vercel rewrites', async t => {
  const request = await withServer(t, { captureHandler: (req, res) => { res.writeHead(200); res.end(req.url); } });
  const response = await request('/api/handler?route=voice/speech', { unlocked: true, method: 'POST' });
  assert.equal(await response.text(), '/api/voice/speech');
});

test('public demos need no cookie and keep backend credentials server-side', async t => {
  const request = await withServer(t, { env: { ...env, DEMO_PUBLIC: 'true' }, fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${env.ROBOT_WEB_TOKEN}`);
    return Response.json({ busy: false });
  }, captureHandler: (req, res) => { res.end('public capture'); } });
  assert.equal((await (await request('/api/session')).json()).public, true);
  assert.deepEqual(await (await request('/api/state')).json(), { busy: false });
  assert.equal(await (await request('/api/config')).text(), 'public capture');
});

test('anonymous library browsing and video redirects work without revealing the gateway key', async t => {
  const request = await withServer(t, { env: { ...env, LIBRARY_BACKEND_URL: 'https://library.example.test' }, fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/api/library/videos');
    assert.equal(options.headers.Authorization, `Bearer ${env.ROBOT_WEB_TOKEN}`);
    return Response.json({ videos: [{ id: '12345678', title: 'Bottle placement' }] });
  } });
  assert.equal((await request('/api/library/videos')).status, 200);
  const redirect = await request('/api/library/videos/12345678/stream');
  assert.equal(redirect.status, 307);
  const target = new URL(redirect.headers.get('location'));
  assert.equal(target.origin, 'https://library.example.test');
  assert.equal(target.href.includes(env.ROBOT_WEB_TOKEN), false);
  const [payload, mac] = target.searchParams.get('ticket').split('.');
  assert.equal(mac, createHmac('sha256', env.ROBOT_WEB_TOKEN).update('library-ticket.' + payload).digest('hex'));
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).path, target.pathname);
});

test('direct upload links are scoped by method, size, filename and expiry', async t => {
  const request = await withServer(t, { env: { ...env, DEMO_PUBLIC: 'true', LIBRARY_BACKEND_URL: 'https://library.example.test' } });
  const upload = body => request('/api/library/upload-ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const response = await upload({ action: 'video', filename: 'demo.mp4', bytes: 8_000_000 });
  assert.equal(response.status, 200);
  const target = new URL((await response.json()).url);
  const payload = JSON.parse(Buffer.from(target.searchParams.get('ticket').split('.')[0], 'base64url'));
  assert.equal(payload.method, 'POST'); assert.equal(payload.bytes, 8_000_000); assert.equal(payload.filename, 'demo.mp4');
  assert.equal(payload.path, '/api/library/videos'); assert.ok(payload.exp > Date.now() && payload.exp < Date.now() + 601_000);
  assert.equal((await upload({ action: 'video', filename: '../secret.mp4', bytes: 10 })).status, 415);
  assert.equal((await upload({ action: 'video', filename: 'demo.mp4', bytes: 301 * 1024 * 1024 })).status, 413);
  assert.equal((await upload({ action: 'session', id: '12345678', bytes: 41 * 1024 * 1024 })).status, 413);
  assert.equal((await upload(null)).status, 400);
});

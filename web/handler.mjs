import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createCaptureHandler } from '../capture/server.mjs';
import { accessMatches, authenticated, sessionCookie } from './auth.mjs';

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
  res.end(JSON.stringify(value));
}

async function readBody(req, limit = 260_000) {
  if (req.body !== undefined) {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    if (body.length > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    return body;
  }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createHostedHandler({ env = process.env, fetchImpl = fetch, captureHandler } = {}) {
  const hosts = [...new Set(['localhost', '127.0.0.1', env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_BRANCH_URL, env.PUBLIC_HOST].filter(Boolean))];
  const capture = captureHandler || createCaptureHandler({
    apiKey: env.OPENROUTER_API_KEY, openaiKey: env.OPENAI_API_KEY,
    model: env.OPENROUTER_MODEL, voiceModel: env.OPENAI_VOICE_MODEL,
    ttsModel: env.OPENAI_TTS_MODEL, voiceName: env.OPENAI_VOICE,
    allowedHosts: hosts,
  });
  const attempts = new Map();
  const robotRoutes = new Set(['/api/state', '/api/events', '/api/runs', '/api/stop', '/api/camera']);
  const captureRoutes = new Set(['/api/config', '/api/checkpoint', '/api/voice/speech', '/api/voice/session']);
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const host = req.headers.host || '';
      if (!hosts.includes(host.split(':')[0])) return json(res, 403, { error: 'This host is not enabled.' });
      const url = new URL(req.url, `https://${host}`);
      const origin = req.headers.origin;
      if (origin && origin !== `https://${host}` && !(hosts.includes('localhost') && ['localhost', '127.0.0.1'].includes(host.split(':')[0]) && origin === `http://${host}`)) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are not allowed.' });
      let pathname = url.pathname;
      if (pathname === '/api/handler') {
        if (url.searchParams.has('recording')) pathname = '/recordings/' + url.searchParams.get('recording');
        else pathname = '/api/' + (url.searchParams.get('route') || '');
      }
      const unlocked = authenticated(req, env);
      if (pathname === '/api/session') {
        if (req.method === 'GET') return json(res, 200, { unlocked, configured: Boolean(env.DEMO_ACCESS_CODE && env.DEMO_SESSION_SECRET), robot: Boolean(env.ROBOT_BACKEND_URL && env.ROBOT_WEB_TOKEN), collection: Boolean(env.OPENROUTER_API_KEY) });
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
        if (!env.DEMO_ACCESS_CODE || !env.DEMO_SESSION_SECRET) return json(res, 503, { error: 'Live demo access is being configured.' });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
        const entry = attempts.get(ip);
        if (entry && entry.until > Date.now() && entry.count >= 8) return json(res, 429, { error: 'Too many attempts. Try again in ten minutes.' });
        let body;
        try { body = JSON.parse((await readBody(req, 2048)).toString()); } catch (error) { if (error.status) throw error; return json(res, 400, { error: 'Invalid JSON.' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Invalid access request.' });
        if (!accessMatches(typeof body.code === 'string' ? body.code : '', env.DEMO_ACCESS_CODE)) {
          attempts.set(ip, { count: entry?.until > Date.now() ? entry.count + 1 : 1, until: Date.now() + 600_000 });
          if (attempts.size > 2000) attempts.delete(attempts.keys().next().value);
          return json(res, 401, { error: 'That access code does not match.' });
        }
        attempts.delete(ip);
        res.setHeader('Set-Cookie', sessionCookie(env, { secure: !['localhost', '127.0.0.1'].includes(host.split(':')[0]) }));
        return json(res, 200, { unlocked: true });
      }
      if (!unlocked) return json(res, 401, { error: 'Unlock the live demos from the home page.', detail: 'Unlock the live demos from the home page.' });
      if (captureRoutes.has(pathname)) { req.url = pathname; return capture(req, res); }
      const recording = /^\/recordings\/[0-9]{8}-[0-9]{6}-[a-f0-9]{6}\/rollout\.mp4$/.test(pathname);
      if (!robotRoutes.has(pathname) && !recording) return json(res, 404, { error: 'Unknown API route.' });
      const allowedMethods = recording ? ['GET', 'HEAD'] : ['/api/state', '/api/events'].includes(pathname) ? ['GET'] : pathname === '/api/runs' ? ['GET', 'POST'] : ['POST'];
      if (!allowedMethods.includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
      if (!env.ROBOT_BACKEND_URL || !env.ROBOT_WEB_TOKEN) return json(res, 503, { error: 'The robot runtime is being connected.', detail: 'The robot runtime is being connected.' });
      const target = new URL(env.ROBOT_BACKEND_URL);
      if (target.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(target.hostname)) throw new Error('Invalid robot backend.');
      target.pathname = pathname;
      target.search = '';
      if (pathname === '/api/events' && url.searchParams.has('after')) target.searchParams.set('after', String(Math.max(0, Number(url.searchParams.get('after')) || 0)));
      const headers = { Authorization: `Bearer ${env.ROBOT_WEB_TOKEN}`, Accept: pathname === '/api/events' ? 'text/event-stream' : '*/*' };
      if (req.headers['last-event-id']) headers['Last-Event-ID'] = String(req.headers['last-event-id']);
      if (req.headers.range && recording) headers.Range = String(req.headers.range);
      let body;
      if (req.method === 'POST') {
        if (req.headers['content-type'] && !req.headers['content-type'].startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
        headers['Content-Type'] = 'application/json'; body = await readBody(req, 4096);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 52_000);
      const close = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', close);
      try {
        const response = await fetchImpl(target, { method: req.method, headers, body, signal: controller.signal, redirect: 'error' });
        if (response.status >= 500 || response.status === 401 || response.status === 403) return json(res, 502, { error: 'The robot runtime could not be reached. Retry in a moment.', detail: 'The robot runtime could not be reached. Retry in a moment.' });
        for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) if (response.headers.has(name)) res.setHeader(name, response.headers.get(name));
        if (pathname === '/api/events') { res.setHeader('X-Accel-Buffering', 'no'); res.setHeader('Content-Type', 'text/event-stream'); }
        res.writeHead(response.status);
        if (req.method === 'HEAD' || !response.body) return res.end();
        await pipeline(Readable.fromWeb(response.body), res);
      } finally { clearTimeout(timer); res.off('close', close); }
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.end();
      json(res, error.status || 502, { error: error.status ? error.message : 'The demo service is temporarily unavailable. Please retry.' });
    }
  };
}

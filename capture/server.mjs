import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDecision, parseDecision, DEFAULT_TASKS, ENDPOINT, MODEL, InputError } from './lib/checkpoints.mjs';
import { buildLiveSession, buildSpeech, LIVE_ENDPOINT, VOICE_MODEL, VOICE, VOICE_BACKEND, TTS_MODEL, SPEECH_ENDPOINT } from './lib/voice.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Prefer this checkout's explicitly supplied keys over unrelated inherited credentials.
let localEnv = {};
try { localEnv = parseEnv(readFileSync(path.join(ROOT, '.env'), 'utf8')); } catch { /* Environment configuration is also supported. */ }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webm': 'video/webm' };

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 260_000) throw new InputError('Request too large. Use compressed camera frames.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new InputError('Invalid JSON.'); }
}

export function createCaptureServer({ apiKey = localEnv.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY, model = localEnv.OPENROUTER_MODEL || process.env.OPENROUTER_MODEL || MODEL, openaiKey = localEnv.OPENAI_API_KEY || process.env.OPENAI_API_KEY, voiceModel = localEnv.OPENAI_VOICE_MODEL || process.env.OPENAI_VOICE_MODEL || VOICE_MODEL, ttsModel = localEnv.OPENAI_TTS_MODEL || TTS_MODEL, voiceName = localEnv.OPENAI_VOICE || VOICE, voiceFetchImpl = fetch, fetchImpl = fetch, requestTimeout = 18_000 } = {}) {
  let activeRequests = 0;
  let lastRequest = 0;
  let voiceCreating = false;
  let lastVoiceCreated = 0;
  let speechActive = 0;
  const speechCache = new Map();
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    try {
      // Loopback only by default. Also guard paid API calls against cross-site requests/DNS rebinding.
      const host = req.headers.host;
      const hostName = host?.split(':')[0];
      if (!['localhost', '127.0.0.1'].includes(hostName)) return json(res, 403, { error: 'Open this app on localhost.' });
      const url = new URL(req.url, `http://${host}`);
      if (req.headers.origin && req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      if (url.pathname === '/api/config' && req.method === 'GET') {
        return json(res, 200, { configured: Boolean(apiKey), model, voice: { configured: Boolean(openaiKey), model: voiceModel, ttsModel, voice: voiceName, backend: VOICE_BACKEND }, intervalMs: 1000, threshold: .85, confirmations: 2, tasks: DEFAULT_TASKS });
      }
      if (url.pathname === '/api/voice/speech' && req.method === 'POST') {
        if (!openaiKey) return json(res, 503, { error: 'Add OPENAI_API_KEY to capture/.env and restart to enable voice guidance.' });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
        const body = await readJson(req);
        const speechRequest = buildSpeech(body, { model: ttsModel, voice: voiceName });
        const cacheKey = JSON.stringify(speechRequest);
        const cached = speechCache.get(cacheKey);
        if (cached) { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Voice-Cache': 'hit' }); return res.end(cached); }
        if (speechActive >= 2) return json(res, 429, { error: 'A voice instruction is already being prepared. Try again in a moment.' });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', onClose); speechActive++;
        try {
          const upstream = await voiceFetchImpl(SPEECH_ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(speechRequest), signal: controller.signal });
          if (!upstream.ok) return json(res, 502, { error: upstream.status === 401 ? 'OpenAI rejected the voice key. Check capture/.env.' : upstream.status === 429 ? 'OpenAI voice is rate limited or out of credits. Check project billing and retry.' : `OpenAI speech is unavailable (status ${upstream.status}).`, providerStatus: upstream.status });
          const audio = Buffer.from(await upstream.arrayBuffer());
          if (audio.length < 100 || audio.length > 5_000_000 || audio.subarray(0, 4).toString() !== 'RIFF') throw new InputError('OpenAI returned invalid speech audio.', 502);
          speechCache.set(cacheKey, audio);
          if (speechCache.size > 40) speechCache.delete(speechCache.keys().next().value);
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Voice-Cache': 'miss' }); return res.end(audio);
        } finally { clearTimeout(timeout); res.off('close', onClose); speechActive--; }
      }
      if (url.pathname === '/api/voice/session' && req.method === 'POST') {
        if (!openaiKey) return json(res, 503, { error: 'Add OPENAI_API_KEY to capture/.env and restart to connect live voice.' });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
        if (voiceCreating || Date.now() - lastVoiceCreated < 3000) return json(res, 429, { error: 'A voice connection is already starting. Wait a moment.' });
        const body = await readJson(req);
        const voiceRequest = buildLiveSession(body, { model: voiceModel, voice: voiceName });
        voiceCreating = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', onClose);
        try {
          const upstream = await voiceFetchImpl(LIVE_ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(voiceRequest), signal: controller.signal });
          if (!upstream.ok) {
            const messages = { 401: 'OpenAI rejected the voice API key. Check OPENAI_API_KEY in capture/.env.', 402: 'OpenAI voice credits are unavailable.', 403: 'This OpenAI project does not have access to the selected Live voice model.', 404: 'The selected OpenAI Live model is not available to this project.', 429: 'OpenAI voice is rate limited or out of credits. Check project billing and retry.' };
            return json(res, 502, { error: messages[upstream.status] || `OpenAI live voice could not connect (status ${upstream.status}).`, providerStatus: upstream.status });
          }
          const result = await upstream.json();
          if (typeof result.session?.id !== 'string' || typeof result.transport?.sdp !== 'string') throw new InputError('OpenAI returned an incomplete voice connection.', 502);
          lastVoiceCreated = Date.now();
          return json(res, 201, { session: { id: result.session.id, model: voiceModel, voice: voiceName }, transport: { type: 'webrtc', sdp: result.transport.sdp } });
        } finally { clearTimeout(timeout); res.off('close', onClose); voiceCreating = false; }
      }
      if (url.pathname === '/api/checkpoint' && req.method === 'POST') {
        if (!apiKey) return json(res, 503, { error: 'Add OPENROUTER_API_KEY to capture/.env, then restart the server.' });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
        if (activeRequests > 0) return json(res, 429, { error: 'A checkpoint is already being checked. Wait for it to finish.' });
        if (Date.now() - lastRequest < 700) return json(res, 429, { error: 'Checks are limited to one per second.' });
        const body = await readJson(req);
        const decision = buildDecision(body, model);
        lastRequest = Date.now();
        activeRequests++;
        const start = performance.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeout);
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', onClose);
        try {
          const upstream = await fetchImpl(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Relay Capture', 'HTTP-Referer': `http://${host}` },
            body: JSON.stringify(decision),
            signal: controller.signal,
          });
          if (!upstream.ok) {
            // Provider messages may echo request content. Never return images, keys, or raw bodies.
            const messages = { 401: 'OpenRouter rejected the API key. Check capture/.env.', 402: 'OpenRouter has insufficient credits. Add credits, then retry.', 403: 'OpenRouter denied this model. Check the key permissions.', 413: 'Clef rejected the image size. Lower the frame quality.', 429: 'OpenRouter is rate limiting requests. Try a slower check interval.' };
            const message = messages[upstream.status] || `Clef is temporarily unavailable (provider status ${upstream.status}). Retry shortly.`;
            return json(res, upstream.status === 429 ? 429 : 502, { error: message, providerStatus: upstream.status });
          }
          const result = parseDecision(await upstream.json());
          return json(res, 200, { ...result, latencyMs: Math.round(performance.now() - start), checkedAt: new Date().toISOString() });
        } finally {
          clearTimeout(timeout);
          res.off('close', onClose);
          activeRequests--;
        }
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown API route.' });
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.split('/').some(part => part.startsWith('.') || part === '..')) return json(res, 404, { error: 'Not found.' });
      let base = path.join(ROOT, 'public');
      let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (pathname.startsWith('/vendor/mediapipe/')) {
        base = path.join(ROOT, 'node_modules/@mediapipe/tasks-vision');
        relative = pathname.slice('/vendor/mediapipe/'.length);
        if (!/^(vision_bundle\.mjs|wasm\/vision_wasm(?:_nosimd)?_internal\.(?:js|wasm))$/.test(relative)) return json(res, 404, { error: 'Not found.' });
      }
      const file = path.resolve(base, relative);
      if (!file.startsWith(base + path.sep)) return json(res, 404, { error: 'Not found.' });
      const info = await stat(file);
      if (!info.isFile()) return json(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': pathname.startsWith('/models/') || pathname.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error.code === 'ENOENT') return json(res, 404, { error: 'Not found.' });
      if (error instanceof InputError) return json(res, error.status, { error: error.message });
      if (error.name === 'AbortError' || error.name === 'TimeoutError') return json(res, 504, { error: 'Clef took too long. Your capture is safe; retry the check.' });
      json(res, 502, { error: 'The checkpoint service could not be reached. Check your connection and retry.' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8790);
  createCaptureServer().listen(port, '127.0.0.1', () => {
    console.log(`Relay Capture → http://127.0.0.1:${port}`);
    console.log(`Checkpoint model: ${localEnv.OPENROUTER_MODEL || MODEL} · API key ${localEnv.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY ? 'configured' : 'missing'}`);
    console.log(`Voice model: ${localEnv.OPENAI_VOICE_MODEL || VOICE_MODEL} · OpenAI key ${localEnv.OPENAI_API_KEY || process.env.OPENAI_API_KEY ? 'configured' : 'missing'}`);
  });
}

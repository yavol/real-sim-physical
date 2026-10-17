import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { libraryTicket } from './auth.mjs';

const id = '[a-z0-9-]{8,64}';
const record = new RegExp(`^/api/library/videos/${id}$`);
const media = new RegExp(`^/api/library/videos/${id}/(?:stream|thumbnail|session|download)$`);
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify(body)); };

export async function handleLibrary(req, res, { env, url, pathname, readBody, fetchImpl }) {
  if (!env.LIBRARY_BACKEND_URL || !env.ROBOT_WEB_TOKEN) return json(res, 503, { error: 'The video library is being connected.' });
  const target = new URL(env.LIBRARY_BACKEND_URL);
  if (target.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(target.hostname)) throw new Error('Invalid library backend.');
  target.pathname = pathname; target.search = '';
  if (pathname === '/api/library/upload-ticket') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
    if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
    let body;
    try { body = JSON.parse((await readBody(req, 2048)).toString()); } catch (error) { if (error.status) throw error; return json(res, 400, { error: 'Invalid upload request.' }); }
    if (!body || typeof body !== 'object' || !Number.isSafeInteger(body.bytes) || body.bytes <= 0) return json(res, 400, { error: 'Provide the upload size.' });
    const payload = { method: 'POST', bytes: body.bytes };
    if (body.action === 'video') {
      if (typeof body.filename !== 'string' || body.filename.length > 180 || /[\\/\x00-\x1f]/.test(body.filename) || !/\.(mp4|webm|mov|m4v)$/i.test(body.filename)) return json(res, 415, { error: 'Choose an MP4, WebM, MOV, or M4V video.' });
      if (body.bytes > 300 * 1024 * 1024) return json(res, 413, { error: 'Videos can be up to 300 MB.' });
      target.pathname = '/api/library/videos';
      target.searchParams.set('filename', body.filename); payload.filename = body.filename;
    } else if (body.action === 'session' && /^[a-z0-9-]{8,64}$/.test(body.id || '')) {
      if (body.bytes > 40 * 1024 * 1024) return json(res, 413, { error: 'Session files can be up to 40 MB.' });
      target.pathname = `/api/library/videos/${body.id}/session`;
    } else return json(res, 400, { error: 'Invalid upload request.' });
    payload.path = target.pathname;
    target.searchParams.set('ticket', libraryTicket(payload, env.ROBOT_WEB_TOKEN));
    return json(res, 200, { url: target.href });
  }
  const isMedia = media.test(pathname);
  const known = isMedia || record.test(pathname) || ['/api/library/config', '/api/library/videos', '/api/library/vast/videos', '/api/library/vast/search', '/api/library/vast/connect'].includes(pathname);
  if (!known) return json(res, 404, { error: 'Unknown library route.' });
  if (isMedia && ['GET', 'HEAD'].includes(req.method)) {
    target.searchParams.set('ticket', libraryTicket({ path: pathname, method: 'GET' }, env.ROBOT_WEB_TOKEN));
    res.writeHead(307, { Location: target.href, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    return res.end();
  }
  const allowed = record.test(pathname) ? ['GET', 'PATCH'] : pathname.endsWith('/vast/search') || pathname.endsWith('/vast/connect') ? ['POST'] : ['GET'];
  if (!allowed.includes(req.method)) return json(res, 405, { error: 'Use the upload link to send videos and session files.' });
  const headers = { Authorization: `Bearer ${env.ROBOT_WEB_TOKEN}`, Accept: 'application/json' };
  let body;
  if (['POST', 'PATCH'].includes(req.method)) {
    if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
    headers['Content-Type'] = 'application/json'; body = await readBody(req, 16_384);
  }
  const response = await fetchImpl(target, { method: req.method, headers, body, signal: AbortSignal.timeout(52_000), redirect: 'error' });
  if (response.status === 401 || response.status === 403 || response.status >= 500) return json(res, 502, { error: 'The video library is temporarily unavailable. Please retry.' });
  res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
  if (!response.body) return res.end();
  await pipeline(Readable.fromWeb(response.body), res);
}

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { VideoStore, LibraryError } from './store.mjs';
import { VastClient } from './vast.mjs';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.dirname(ROOT);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.json': 'application/json' };
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function readJson(req, max = 100000) { let bytes = 0; const chunks = []; for await (const chunk of req) { bytes += chunk.length; if (bytes > max) throw new LibraryError('Session data is too large.', 413); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new LibraryError('Invalid JSON.'); } }
export async function serveFile(req, res, file, download) {
  const info = await stat(file);
  if (!info.isFile()) throw new LibraryError('Not found.', 404);
  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-cache' };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
  let start = 0, end = info.size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
    if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  try { await pipeline(createReadStream(file, { start, end }), res); } catch (error) { if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error; }
}
export async function createLibraryServer(options = {}) {
  const store = options.store || new VideoStore({ root: options.dataRoot || path.join(PROJECT, 'artifacts/library'), uploads: options.uploads === false ? null : options.uploads || path.join(PROJECT, 'artifacts/uploads'), runs: options.runs === false ? null : options.runs || path.join(PROJECT, 'artifacts/runs'), probe: options.probe !== false, onPersist: options.onPersist });
  const vast = options.vast || new VastClient({ baseUrl: process.env.VAST_BASE_URL || process.env.INGRESS_URL || '', token: process.env.VAST_ACCESS_TOKEN || '' });
  await store.init();
  let uploadsActive = 0;
  let refresh = null;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    try {
      const host = req.headers.host;
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '')) return json(res, 403, { error: 'Open the library on localhost.' });
      const origin = req.headers.origin;
      const allowedOrigins = [`http://${host}`, `https://${host}`, 'http://127.0.0.1:8790', 'http://localhost:8790'];
      if (origin && !allowedOrigins.includes(origin)) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }); return res.end(); }
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === '/api/library/config' && req.method === 'GET') return json(res, 200, { vast: vast.status, maxUploadMb: 300, captureUrl: options.captureUrl || 'http://127.0.0.1:8790/', suggestedWorkspaceUrl: options.hosted ? '' : process.env.VAST_BASE_URL || '', persistence: options.hosted ? 'cloud' : 'local' });
      if (url.pathname === '/api/library/videos' && req.method === 'GET') {
        if (!refresh) { refresh = store.importExisting().finally(() => { refresh = null; }); }
        await refresh;
        return json(res, 200, { videos: await store.list() });
      }
      if (url.pathname === '/api/library/videos' && req.method === 'POST') {
        if (uploadsActive >= 2) return json(res, 429, { error: 'Two videos are being saved. Try again in a moment.' });
        uploadsActive++;
        try { return json(res, 201, { video: await store.upload(req, url.searchParams) }); }
        finally { uploadsActive--; }
      }
      const match = /^\/api\/library\/videos\/([a-z0-9-]{8,64})(?:\/(stream|thumbnail|session|download))?$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        if (!action && req.method === 'PATCH') return json(res, 200, { video: await store.patch(id, await readJson(req)) });
        if (action === 'session' && req.method === 'POST') return json(res, 201, { video: await store.attachSession(id, await readJson(req, 40 * 1024 * 1024)) });
        const record = await store.get(id);
        if (['GET', 'HEAD'].includes(req.method)) {
          if (action === 'stream' || action === 'download') return await serveFile(req, res, action === 'download' ? store.filePath(record) : store.streamPath(record), action === 'download' ? record.filename : null);
          if (action === 'thumbnail' && record.thumbnail) return await serveFile(req, res, path.join(store.root, id, 'thumbnail.jpg'));
          if (action === 'session' && record.hasSession) return await serveFile(req, res, path.join(store.root, id, 'session.json'), record.filename.replace(/\.[^.]+$/, '.json'));
          if (!action) return json(res, 200, { video: store.public(record) });
        }
        return json(res, 404, { error: 'Not found.' });
      }
      if (url.pathname === '/api/library/vast/connect' && req.method === 'POST') {
        if (options.hosted) return json(res, 503, { error: 'The hosted library has no verified VAST connection yet. Your saved videos remain available.' });
        const body = await readJson(req, 16000);
        if (typeof body.url !== 'string' || typeof (body.token || '') !== 'string' || body.url.length > 2000 || (body.token || '').length > 12000) throw new LibraryError('Invalid workspace connection.');
        const candidate = new VastClient({ baseUrl: body.url.trim(), token: body.token || '' });
        if (!candidate.base) throw new LibraryError('Enter the VAST workspace URL.');
        const listing = await candidate.explore();
        vast.configure(candidate.base, candidate.token); vast.connected = true; vast.records = candidate.records;
        return json(res, 200, { ...listing, vast: vast.status });
      }
      if (url.pathname === '/api/library/vast/videos' && req.method === 'GET') return json(res, 200, { ...await vast.explore(), vast: vast.status });
      if (url.pathname === '/api/library/vast/search' && req.method === 'POST') {
        const body = await readJson(req); if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 1000) throw new LibraryError('Enter a search of up to 1,000 characters.');
        return json(res, 200, { ...await vast.search(body.query.trim()), vast: vast.status });
      }
      const remote = /^\/api\/library\/vast\/(vast-[a-f0-9]+)\/stream$/.exec(url.pathname);
      if (remote && ['GET', 'HEAD'].includes(req.method)) {
        const upstream = await vast.stream(remote[1], req);
        const headers = {};
        for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (upstream.headers.has(key)) headers[key] = upstream.headers.get(key);
        headers['Cache-Control'] = 'private, no-store'; res.writeHead(upstream.status, headers);
        if (req.method === 'HEAD') return res.end();
        return await pipeline(Readable.fromWeb(upstream.body), res);
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.split('/').some(part => part.startsWith('.'))) return json(res, 404, { error: 'Not found.' });
      let base = path.join(ROOT, 'public'); let name = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (pathname.startsWith('/fonts/')) { base = path.join(PROJECT, 'capture/public/fonts'); name = path.basename(pathname); }
      const file = path.resolve(base, name);
      if (!file.startsWith(base + path.sep)) return json(res, 404, { error: 'Not found.' });
      return await serveFile(req, res, file);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      json(res, error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error instanceof LibraryError ? error.message : error.code === 'ENOENT' ? 'Not found.' : 'The library could not complete this request. Your existing files are safe.' });
    }
  });
  server.requestTimeout = 600000;
  server.store = store;
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createLibraryServer();
  const port = Number(process.env.PORT || 8791);
  server.listen(port, '127.0.0.1', () => console.log(`Relay Library → http://127.0.0.1:${port}`));
}

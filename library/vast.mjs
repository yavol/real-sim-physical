import { createHash } from 'node:crypto';
import { LibraryError } from './store.mjs';
const string = value => typeof value === 'string' ? value : '';
// VAST VSS v2 contracts: vast-data/vast-builders-challenge retrieval/videos + retrieval/search.
// Remote source URIs are kept here, so playback credentials never reach the browser.
export class VastClient {
  constructor({ baseUrl = '', token = '', fetchImpl = fetch } = {}) {
    this.fetch = fetchImpl; this.records = new Map(); this.configure(baseUrl, token);
  }
  configure(baseUrl, token = '') {
    if (baseUrl) {
      let url; try { url = new URL(baseUrl); } catch { throw new LibraryError('Use the full VAST workspace URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new LibraryError('Use a workspace URL without embedded credentials or query parameters.');
      baseUrl = url.href.replace(/\/$/, '');
    }
    this.base = baseUrl; this.token = token; this.connected = false;
    this.records.clear();
  }
  get status() { return { configured: Boolean(this.base), connected: this.connected, host: this.base ? new URL(this.base).host : null }; }
  async request(route, options = {}) {
    if (!this.base) throw new LibraryError('Connect a VAST workspace to search its indexed videos.', 503);
    let response;
    try { response = await this.fetch(`${this.base}${route}`, { ...options, headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...options.headers }, redirect: 'manual', signal: options.signal || AbortSignal.timeout(25000) }); }
    catch { this.connected = false; throw new LibraryError('VAST could not be reached. Check the workspace URL and network connection.', 502); }
    if (response.status >= 300 && response.status < 400) { this.connected = false; throw new LibraryError('VAST requires sign-in. Use an authenticated workspace API connection.', 502); }
    if (!response.ok) {
      this.connected = false;
      throw new LibraryError(response.status === 401 || response.status === 403 ? 'VAST requires a valid workspace access token.' : `VAST returned status ${response.status}. Your local videos are safe.`, 502);
    }
    this.connected = true; return response;
  }
  normalize(rows) {
    const seen = new Set();
    return rows.map(row => {
      const source = string(row.original_video) || string(row.source) || string(row.preview_source);
      if (!source) return null;
      const id = 'vast-' + createHash('sha256').update(source).digest('hex').slice(0, 24);
      if (seen.has(id)) return null;
      seen.add(id);
      this.records.set(id, { source });
      const filename = string(row.filename) || source.split('/').at(-1);
      const created = row.uploaded_at || row.created_at || row.timestamp;
      const createdAt = Number.isFinite(Date.parse(created)) ? new Date(created).toISOString() : '1970-01-01T00:00:00.000Z';
      return { id, filename, title: string(row.title) || filename?.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ') || 'VAST video', description: string(row.reasoning_content) || string(row.description) || string(row.summary), tags: Array.isArray(row.tags) ? row.tags.filter(t => typeof t === 'string') : [], source: 'vast', status: 'indexed', createdAt, dateUnknown: createdAt.startsWith('1970'), duration: Number(row.duration_sec || row.duration_seconds || row.duration || 0) || 0, bytes: Number(row.size_bytes || 0) || 0, score: Number(row.similarity_score || row.best_similarity || 0) || 0, favorite: false, videoUrl: `/api/library/vast/${id}/stream`, startTime: Number(row.best_match_start_sec || row.start_time || 0) || 0, segmentCount: Number(row.matched_segment_count || row.segment_count || 0) || 0 };
    }).filter(Boolean);
  }
  async json(route, options) {
    const response = await this.request(route, options);
    if (!response.headers.get('content-type')?.includes('json')) { this.connected = false; throw new LibraryError('VAST returned a sign-in page. Use an authenticated workspace API connection.', 502); }
    try { return await response.json(); } catch { throw new LibraryError('VAST returned an invalid response.', 502); }
  }
  async explore() {
    const rows = [];
    let truncated = false;
    // Bounded, paginated browse; never silently claim the workspace count is complete.
    for (let offset = 0; offset < 480; offset += 48) {
      const data = await this.json(`/api/v1/videos/explore?scope=all&limit=48&offset=${offset}`);
      const batch = Array.isArray(data) ? data : data.videos || data.items || data.results || data.chunks;
      if (!Array.isArray(batch)) throw new LibraryError('The VAST workspace returned an unsupported video listing.', 502);
      rows.push(...batch);
      if (batch.length < 48) break;
      if (offset === 432) truncated = true;
    }
    return { videos: this.normalize(rows), truncated };
  }
  async search(query) {
    const data = await this.json('/api/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, top_k: 100, llm_top_n: 0, min_similarity: .3, include_public: false }) });
    const rows = data.chunk_results || data.results;
    if (!Array.isArray(rows)) throw new LibraryError('VAST returned an unsupported search response.', 502);
    return { videos: this.normalize(rows), truncated: rows.length === 100 };
  }
  async stream(id, req) {
    const item = this.records.get(id);
    if (!item) throw new LibraryError('Refresh the VAST library before opening this video.', 404);
    return this.request(`/api/v1/videos/stream?source=${encodeURIComponent(item.source)}${this.token ? `&token=${encodeURIComponent(this.token)}` : ''}`, { headers: req.headers.range ? { Range: req.headers.range } : {}, signal: AbortSignal.timeout(120000) });
  }
}

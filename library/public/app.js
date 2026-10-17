import { filterVideos, formatDuration, formatBytes } from './query.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const sourceLabels = { upload: 'UPLOADED VIDEO', capture: 'HUMAN CAPTURE', rollout: 'ROBOT ROLLOUT', vast: 'VAST INDEX' };
const statusLabels = { ready: 'Ready', verified: 'Verified sequence', partial: 'Partial capture', indexed: 'Indexed' };
const state = { videos: [], remote: [], nav: 'all', query: '', status: 'all', date: 'all', sort: 'newest', view: localStorage.getItem('relay.library.view') === 'list' ? 'list' : 'grid', vast: { configured: false, connected: false }, selected: null, uploading: 0, remoteSearching: false, remoteQuery: '', remoteGeneration: 0, loaded: false };
let toastTimer, pollingTimer;
const hosted = !['localhost', '127.0.0.1'].includes(location.hostname);
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
async function api(route, options = {}) {
  let endpoint = '/api/library' + route;
  if (hosted && options.method === 'POST' && /^\/videos\/[a-z0-9-]+\/session$/.test(route)) {
    const ticket = await api('/upload-ticket', { method: 'POST', body: JSON.stringify({ action: 'session', id: route.split('/')[2], bytes: new TextEncoder().encode(options.body).length }) });
    endpoint = ticket.url;
  }
  const response = await fetch(endpoint, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'This request could not be completed.');
  return result;
}
function upsert(video) { const i = state.videos.findIndex(v => v.id === video.id); if (i < 0) state.videos.push(video); else state.videos[i] = video; if (state.selected?.id === video.id) state.selected = video; }
function notice(text, connection = false) { $('library-notice').replaceChildren(); $('library-notice').hidden = !text; if (text) { $('library-notice').append(document.createTextNode(text + ' ')); if (connection) { const button = document.createElement('button'); button.textContent = 'Connect workspace'; button.addEventListener('click', openConnection); $('library-notice').append(button); } } }
function dateLabel(video) { return video.dateUnknown ? 'Date unavailable' : new Date(video.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
function renderConnection() {
  const connected = state.vast.connected;
  $('sidebar-connection').textContent = connected ? state.vast.host : state.vast.configured ? 'Configured · not verified' : 'Connect your workspace';
  $('footer-connection-state').textContent = connected ? '/ CONNECTED' : '/ NOT CONNECTED';
  $('nav-vast-dot').classList.toggle('ready', connected); $('connection-state').classList.toggle('connected', connected);
  $('connection-state').querySelector('strong').textContent = connected ? 'VAST connected' : hosted ? 'Public demo library' : 'Working locally';
  $('connection-state').querySelector('p').textContent = connected ? `Connected to ${state.vast.host}.` : hosted ? 'The cloud library is open to anyone with this URL. VAST is not connected yet.' : 'Your videos are saved on this device. VAST is not connected yet.';
}
function renderStats() {
  $('stat-videos').textContent = state.videos.length;
  $('stat-duration').textContent = formatDuration(state.videos.reduce((total, v) => total + (v.duration || 0), 0));
  $('stat-size').textContent = formatBytes(state.videos.reduce((total, v) => total + (v.bytes || 0), 0));
  $('nav-all').textContent = state.videos.length; $('nav-human').textContent = state.videos.filter(v => v.source === 'upload' || v.source === 'capture').length;
  $('nav-robot').textContent = state.videos.filter(v => v.source === 'rollout').length; $('nav-favorites').textContent = state.videos.filter(v => v.favorite).length;
}
function card(video) {
  return `<article class="video-card" data-video-id="${esc(video.id)}"><div class="thumbnail-wrap"><button class="video-open" data-open="${esc(video.id)}" aria-label="Play ${esc(video.title)}">${video.thumbnailUrl ? `<img src="${esc(video.thumbnailUrl)}" alt="" loading="lazy">` : `<span class="thumbnail-placeholder">${icon(video.source === 'rollout' ? 'robot' : 'camera')}</span>`}<span class="source-badge ${esc(video.source)}">${icon(video.source === 'rollout' ? 'robot' : video.source === 'vast' ? 'link' : 'camera')}${sourceLabels[video.source]}</span><span class="duration">${video.duration ? formatDuration(video.duration) : video.source === 'vast' ? 'WATCH ↗' : 'VIDEO'}</span><span class="play-symbol"><svg viewBox="0 0 24 24"><path d="m7 4 14 8-14 8Z"/></svg></span></button>${video.source !== 'vast' ? `<button class="card-favorite ${video.favorite ? 'is-favorite' : ''}" data-favorite="${esc(video.id)}" aria-label="${video.favorite ? 'Remove from' : 'Add to'} favorites: ${esc(video.title)}" aria-pressed="${video.favorite}">${icon('star')}</button>` : ''}</div><div class="card-body"><button class="card-heading" data-open="${esc(video.id)}" title="${esc(video.title)}">${esc(video.title)}</button><p class="card-description">${esc(video.description || 'Add a description to make this video easier to find.')}</p><div class="card-meta"><span>${dateLabel(video)}</span><span class="meta-dot"></span><span>${video.bytes ? formatBytes(video.bytes) : 'VAST'}</span><span class="card-status ${esc(video.status)}">${video.processing ? 'Preparing preview' : statusLabels[video.status] || 'Ready'}</span></div><div class="tags">${(video.tags.length ? video.tags.slice(0, 3) : ['add some context']).map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}${video.tags.length > 3 ? `<span class="tag">+${video.tags.length - 3}</span>` : ''}</div></div></article>`;
}
function render() {
  renderStats(); renderConnection();
  if (state.nav !== 'vast') {
    const candidates = state.videos.filter(video => state.nav === 'rollout' ? video.source === 'rollout' : ['upload', 'capture'].includes(video.source));
    const counts = new Map();
    for (const video of candidates) for (const tag of video.tags) if (!['simulation','gr00t','demonstration','human demonstration','tabletop','portrait','landscape'].includes(tag) && !tag.startsWith('seed ')) counts.set(tag, (counts.get(tag) || 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2);
    const suggestions = document.querySelectorAll('[data-query]');
    const fallback = [['bottle','Bottle placement'],['can','Can placement']];
    for (let i = 0; i < 2; i++) {
      const tag = top[i]?.[0]; const label = tag ? tag[0].toUpperCase() + tag.slice(1) : fallback[i][1];
      suggestions[i].dataset.query = tag || fallback[i][0];
      suggestions[i].replaceChildren(document.createTextNode(label + ' '));
      const arrow = document.createElement('span'); arrow.textContent = '↗'; suggestions[i].append(arrow);
    }
  }
  const remote = state.nav === 'vast';
  const visible = filterVideos(remote ? state.remote : state.videos, { query: remote ? '' : state.query, source: state.nav === 'demonstration' ? 'demonstration' : state.nav === 'rollout' ? 'rollout' : 'all', favorite: state.nav === 'favorites', status: state.status, date: state.date, sort: state.sort });
  const labels = { all: 'All videos', favorites: 'Favorites', demonstration: 'Demonstrations', rollout: 'Robot rollouts', vast: 'VAST workspace' };
  $('results-title').textContent = remote && state.remoteQuery ? 'Search results' : labels[state.nav]; $('result-count').textContent = visible.length;
  $('video-grid').className = `video-grid ${state.view === 'list' ? 'list-mode' : ''}`; $('video-grid').innerHTML = visible.map(card).join('');
  $('video-grid').setAttribute('aria-busy', String(state.remoteSearching)); $('video-grid').hidden = state.remoteSearching;
  $('loading').hidden = state.loaded && !state.remoteSearching; $('empty-state').hidden = visible.length > 0 || !state.loaded || state.remoteSearching;
  const hasFilters = Boolean(state.query.trim() || state.status !== 'all' || state.date !== 'all');
  $('active-filters').hidden = !hasFilters; $('filter-description').textContent = `${visible.length} ${visible.length === 1 ? 'video' : 'videos'}${state.query.trim() ? ` matching “${state.query.trim()}”` : ' with these filters'}`;
  if (!visible.length) {
    const disconnected = remote && !state.vast.connected;
    $('empty-title').textContent = disconnected ? 'One workspace, a little closer.' : hasFilters ? 'No moves found. Yet.' : state.nav === 'favorites' ? 'Keep your best moves close.' : 'Your next demonstration starts here.';
    $('empty-description').textContent = disconnected ? 'Connect your VAST workspace to browse indexed footage and search inside your videos.' : hasFilters ? 'Try another search or clear your filters.' : state.nav === 'favorites' ? 'Select the star on any video to keep it here for later.' : 'Upload a video or record something new in the capture studio.';
    $('empty-action').textContent = disconnected ? 'Connect VAST workspace ↗' : hasFilters ? 'Clear filters' : state.nav === 'favorites' ? 'Explore all videos ↗' : 'Upload your first video ↗';
  }
  for (const view of ['grid', 'list']) { $(`${view}-view`).classList.toggle('active', state.view === view); $(`${view}-view`).setAttribute('aria-pressed', String(state.view === view)); }
  document.querySelectorAll('[data-nav]').forEach(button => { const active = button.dataset.nav === state.nav; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  $('search').placeholder = remote ? 'Describe a moment in your VAST videos…' : 'Search titles, descriptions, or tags…'; $('search-submit').hidden = !remote; $('search-shortcut').hidden = remote; $('status-filter').disabled = remote;
  $('search-context').textContent = remote ? 'Search indexed video content.' : 'Find a particular move.';
  $('library-caption').textContent = remote ? 'Results from your VAST workspace. Uploads are stored separately.' : `${visible.length} of ${state.videos.length} videos · Original footage, ${hosted ? 'available in the shared demo library' : 'kept on this device'}.`;
}
function clearFilters() { state.query = ''; state.status = 'all'; state.date = 'all'; state.remoteQuery = ''; $('search').value = ''; $('status-filter').value = 'all'; $('date-filter').value = 'all'; render(); if (state.nav === 'vast' && state.vast.configured) loadRemote(); }
async function loadLibrary({ quiet = false } = {}) {
  if (!quiet) $('refresh-button').classList.add('busy');
  try { const data = await api('/videos'); state.videos = data.videos; state.loaded = true; render(); clearTimeout(pollingTimer); if (data.videos.some(v => v.processing)) pollingTimer = setTimeout(() => loadLibrary({ quiet: true }), 2500); }
  catch (error) { state.loaded = true; render(); notice(error.message); }
  finally { $('refresh-button').classList.remove('busy'); }
}
async function loadRemote(query = '') {
  if (!state.vast.configured) { notice('VAST is not connected. Your local library is ready to use.', true); render(); return; }
  const generation = ++state.remoteGeneration; state.remoteSearching = true; notice(''); render();
  try { const data = query ? await api('/vast/search', { method: 'POST', body: JSON.stringify({ query }) }) : await api('/vast/videos'); if (generation !== state.remoteGeneration) return; state.remote = data.videos; state.remoteQuery = query; state.vast = data.vast; if (data.truncated) notice(query ? 'Showing the top 100 VAST matches. Try a more specific search.' : 'Showing up to 480 indexed videos. Search to narrow the results.'); }
  catch (error) { if (generation !== state.remoteGeneration) return; state.vast.connected = false; state.remote = []; notice(error.message, true); }
  finally { if (generation === state.remoteGeneration) { state.remoteSearching = false; render(); } }
}
function navigate(nav) { state.nav = nav; state.remoteGeneration++; state.remoteSearching = false; state.remoteQuery = ''; state.query = ''; state.status = 'all'; state.date = 'all'; state.sort = 'newest'; $('search').value = ''; $('status-filter').value = 'all'; $('date-filter').value = 'all'; $('sort').value = 'newest'; $('sidebar').classList.remove('mobile-open'); syncNavigation(); notice(''); render(); if (nav === 'vast') loadRemote(); }
function detail(video) {
  state.selected = video; $('video-title').textContent = video.title; $('player-source').textContent = sourceLabels[video.source];
  $('detail-meta').textContent = [dateLabel(video), video.duration ? formatDuration(video.duration) : null, video.bytes ? formatBytes(video.bytes) : null, video.width ? `${video.width} × ${video.height}` : null, statusLabels[video.status]].filter(Boolean).join('  ·  ');
  $('detail-description').textContent = video.description || 'Add a description to give this demonstration a little context.'; $('detail-tags').innerHTML = video.tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('');
  const remote = video.source === 'vast'; $('detail-favorite').hidden = remote; $('detail-favorite').setAttribute('aria-pressed', String(video.favorite)); $('detail-favorite').setAttribute('aria-label', video.favorite ? 'Remove from favorites' : 'Add to favorites');
  $('download-original').hidden = remote; $('download-original').href = `/api/library/videos/${encodeURIComponent(video.id)}/download`;
  $('edit-button').hidden = remote; $('attach-session').hidden = remote || video.source === 'rollout' || video.hasSession || !video.id.includes('-'); $('download-session').hidden = !video.sessionUrl; if (video.sessionUrl) $('download-session').href = video.sessionUrl;
  $('capture-evidence').hidden = !video.capture;
  if (video.capture) $('capture-evidence').innerHTML = `<strong>${video.capture.checkpointCount} / ${video.capture.taskCount} checkpoints verified</strong>${video.capture.landmarkSamples.toLocaleString()} landmark samples · ${video.capture.completed ? 'Full sequence completed' : 'Partial demonstration'}<br>Body and hand coordinates are model estimates. Inspect the original video to assess the movement.`;
}
function openVideo(id) { const video = [...state.videos, ...state.remote].find(v => v.id === id); if (!video) return; detail(video); $('player-error').hidden = true; $('player').src = video.videoUrl + (video.startTime ? `#t=${video.startTime}` : ''); $('video-dialog').showModal(); $('player').play().catch(() => {}); }
async function favorite(id) { const video = state.videos.find(v => v.id === id); if (!video) return; try { const data = await api('/videos/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ favorite: !video.favorite }) }); upsert(data.video); render(); if (state.selected?.id === id) detail(data.video); } catch (error) { toast(error.message); } }
function openUpload() { $('upload-dialog').showModal(); }
function openConnection() { renderConnection(); $('connection-error').hidden = true; $('connection-dialog').showModal(); }
async function uploadFile(file, item) {
  let endpoint = '/api/library/videos?' + new URLSearchParams({ filename: file.name });
  if (hosted) {
    const ticket = await api('/upload-ticket', { method: 'POST', body: JSON.stringify({ action: 'video', filename: file.name, bytes: file.size, type: file.type || 'application/octet-stream' }) });
    endpoint = ticket.url;
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('POST', endpoint); xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream'); xhr.timeout = 600000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) { item.querySelector('progress').value = event.loaded / event.total * 100; item.querySelector('.queue-state').textContent = event.loaded === event.total ? 'Saving…' : `${Math.round(event.loaded / event.total * 100)}%`; } };
    xhr.onload = () => { let data; try { data = JSON.parse(xhr.responseText); } catch { return reject(new Error('The library returned an invalid response.')); } if (xhr.status >= 200 && xhr.status < 300) resolve(data.video); else reject(new Error(data.error || 'The video could not be saved.')); };
    xhr.onerror = () => reject(new Error('Connection lost. Retry this upload.')); xhr.ontimeout = () => reject(new Error('The upload timed out. Retry this file.')); xhr.send(file);
  });
}
async function uploadFiles(files) {
  for (const file of files) {
    const item = document.createElement('div'); item.className = 'queue-item'; item.innerHTML = '<span class="queue-name"></span><span class="queue-state">Waiting…</span><progress class="upload-progress" value="0" max="100" aria-label="Upload progress"></progress>'; item.querySelector('.queue-name').textContent = file.name; $('upload-queue').append(item);
    if (!/\.(mp4|webm|mov|m4v)$/i.test(file.name) || file.size > 300 * 1024 * 1024) { item.classList.add('error'); item.querySelector('.queue-state').textContent = file.size > 300 * 1024 * 1024 ? 'Over 300 MB limit' : 'Unsupported file type'; item.querySelector('progress').hidden = true; continue; }
    state.uploading++; item.querySelector('.queue-state').textContent = 'Uploading…';
    try { const video = await uploadFile(file, item); upsert(video); item.querySelector('.queue-state').textContent = 'Saved to library'; item.querySelector('progress').value = 100; render(); }
    catch (error) { item.classList.add('error'); item.querySelector('.queue-state').textContent = error.message; }
    finally { state.uploading--; }
  }
  $('file-input').value = ''; loadLibrary({ quiet: true });
}
$('search').addEventListener('input', () => { state.query = $('search').value; if (state.nav !== 'vast') render(); });
$('search-form').addEventListener('submit', event => { event.preventDefault(); if (state.nav === 'vast') { state.query = $('search').value; state.sort = 'relevance'; $('sort').querySelector('[value="relevance"]').hidden = false; $('sort').value = 'relevance'; loadRemote(state.query.trim()); } else render(); });
document.querySelectorAll('[data-query]').forEach(button => button.addEventListener('click', () => { state.query = button.dataset.query; $('search').value = state.query; if (state.nav === 'vast') loadRemote(state.query); else render(); }));
document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.nav)));
$('clear-filters').addEventListener('click', clearFilters);
for (const [id, key] of [['status-filter','status'], ['date-filter','date'], ['sort','sort']]) $(id).addEventListener('change', event => { state[key] = event.target.value; render(); });
for (const view of ['grid', 'list']) $(`${view}-view`).addEventListener('click', () => { state.view = view; localStorage.setItem('relay.library.view', view); render(); });
$('refresh-button').addEventListener('click', () => state.nav === 'vast' ? loadRemote(state.query.trim()) : loadLibrary()); $('menu-button').addEventListener('click', () => { $('sidebar').classList.toggle('mobile-open'); syncNavigation(); });
$('video-grid').addEventListener('click', event => { const open = event.target.closest('[data-open]'); const star = event.target.closest('[data-favorite]'); if (open) openVideo(open.dataset.open); else if (star) favorite(star.dataset.favorite); });
$('video-grid').addEventListener('error', event => { if (event.target.tagName === 'IMG') { const placeholder = document.createElement('span'); placeholder.className = 'thumbnail-placeholder'; placeholder.innerHTML = icon('camera'); event.target.replaceWith(placeholder); } }, true);
$('upload-button').addEventListener('click', openUpload); $('drop-zone').addEventListener('click', () => $('file-input').click()); $('file-input').addEventListener('change', () => uploadFiles([...$('file-input').files]));
for (const name of ['dragenter', 'dragover']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); $('drop-zone').classList.add('drag-over'); });
for (const name of ['dragleave', 'drop']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); $('drop-zone').classList.remove('drag-over'); });
$('drop-zone').addEventListener('drop', event => uploadFiles([...event.dataTransfer.files]));
$('empty-action').addEventListener('click', () => { if (state.nav === 'vast' && !state.vast.connected) openConnection(); else if (state.query || state.status !== 'all' || state.date !== 'all') clearFilters(); else if (state.nav === 'favorites') navigate('all'); else openUpload(); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
$('video-dialog').addEventListener('close', () => { $('player').pause(); $('player').removeAttribute('src'); $('player').load(); state.selected = null; }); $('player').addEventListener('error', () => { if ($('player').hasAttribute('src')) $('player-error').hidden = false; }); $('detail-favorite').addEventListener('click', () => { if (state.selected) favorite(state.selected.id); });
$('edit-button').addEventListener('click', () => { const video = state.selected; if (!video) return; $('edit-name').value = video.title; $('edit-description').value = video.description || ''; $('edit-tags').value = video.tags.join(', '); $('edit-error').hidden = true; $('edit-dialog').showModal(); });
$('edit-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!state.selected) return; $('save-details').disabled = true; $('edit-error').hidden = true;
  try { const data = await api('/videos/' + state.selected.id, { method: 'PATCH', body: JSON.stringify({ title: $('edit-name').value.trim(), description: $('edit-description').value, tags: $('edit-tags').value.split(',').map(tag => tag.trim()).filter(Boolean) }) }); upsert(data.video); detail(data.video); render(); $('edit-dialog').close(); toast('Details saved. A little easier to find.'); }
  catch (error) { $('edit-error').textContent = error.message; $('edit-error').hidden = false; } finally { $('save-details').disabled = false; }
});
$('attach-session').addEventListener('click', () => $('session-input').click());
$('session-input').addEventListener('change', async () => { const file = $('session-input').files[0]; const id = state.selected?.id; if (!file || !id) return; try { if (file.size > 40 * 1024 * 1024) throw new Error('Session JSON can be up to 40 MB.'); const body = JSON.parse(await file.text()); const data = await api(`/videos/${id}/session`, { method: 'POST', body: JSON.stringify(body) }); upsert(data.video); if (state.selected?.id === id) detail(data.video); render(); toast('Session evidence attached to this video.'); } catch (error) { toast(error instanceof SyntaxError ? 'Choose a valid Relay session JSON file.' : error.message); } finally { $('session-input').value = ''; } });
$('connection-button').addEventListener('click', openConnection); $('footer-connection').addEventListener('click', openConnection);
$('connection-form').addEventListener('submit', async event => { event.preventDefault(); $('connect-vast').disabled = true; $('connection-error').hidden = true; try { const data = await api('/vast/connect', { method: 'POST', body: JSON.stringify({ url: $('vast-url').value, token: $('vast-token').value }) }); state.remote = data.videos; state.vast = data.vast; $('vast-token').value = ''; $('connection-dialog').close(); state.nav = 'vast'; state.query = ''; state.status = 'all'; $('status-filter').value = 'all'; $('search').value = ''; notice(data.truncated ? 'Showing up to 480 indexed VAST videos. Search to narrow the results.' : ''); render(); toast('VAST workspace connected. Indexed videos are ready to explore.'); } catch (error) { $('connection-error').textContent = error.message; $('connection-error').hidden = false; } finally { $('connect-vast').disabled = false; } });
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('search').focus(); } });
window.addEventListener('beforeunload', event => { if (state.uploading) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('focus', () => { if (!document.querySelector('dialog[open]') && !state.uploading) loadLibrary({ quiet: true }); });
setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]') && !state.uploading && state.nav !== 'vast') loadLibrary({ quiet: true }); }, 15000);
(async () => { try { const config = await api('/config'); state.vast = config.vast; if (config.suggestedWorkspaceUrl) $('vast-url').value = config.suggestedWorkspaceUrl; } catch { /* Listing reports connectivity errors. */ } await loadLibrary(); })();

// A same-device bridge from Capture. This avoids changing or restarting the
// active camera/voice server. Only the opener on the capture origin is accepted.
const captureOrigins = hosted ? [location.origin] : ['http://127.0.0.1:8790', 'http://localhost:8790'];
const receivedCaptures = new Map();
window.addEventListener('message', async event => {
  if (!captureOrigins.includes(event.origin) || event.source !== window.opener || event.data?.type !== 'relay.library.capture') return;
  const { requestId, video, filename, session } = event.data;
  if (typeof requestId !== 'string' || !(video instanceof Blob) || !session || session.schemaVersion !== 'relay.capture.v1') return;
  if (receivedCaptures.has(requestId)) { const id = receivedCaptures.get(requestId); if (id) event.source.postMessage({ type: 'relay.library.saved', requestId, id }, event.origin); return; }
  receivedCaptures.set(requestId, null);
  const sender = event.source;
  const item = document.createElement('div'); item.className = 'queue-item'; item.innerHTML = '<span class="queue-name">Capture studio recording</span><span class="queue-state">Saving…</span><progress class="upload-progress" value="0" max="100" aria-label="Capture save progress"></progress>'; $('upload-queue').append(item);
  state.uploading++; notice('Saving your capture and its session evidence…');
  let saved;
  try {
    const file = new File([video], filename || 'relay-capture.webm', { type: video.type });
    saved = await uploadFile(file, item);
    const data = await api(`/videos/${saved.id}/session`, { method: 'POST', body: JSON.stringify(session) });
    upsert(data.video); receivedCaptures.set(requestId, saved.id); sender.postMessage({ type: 'relay.library.saved', requestId, id: saved.id }, event.origin);
    navigate('demonstration'); toast('Your demonstration and session evidence are saved.');
    item.querySelector('.queue-state').textContent = 'Saved to library'; item.querySelector('progress').value = 100;
  } catch (error) {
    receivedCaptures.delete(requestId);
    const message = saved ? 'Video saved, but session evidence could not be attached. Download the session JSON from Capture and attach it in video details.' : error.message;
    if (saved) upsert(saved);
    sender.postMessage({ type: 'relay.library.error', requestId, message }, event.origin); notice(message); render();
    item.classList.add('error'); item.querySelector('.queue-state').textContent = message;
  } finally { state.uploading--; loadLibrary({ quiet: true }); }
});
if (new URLSearchParams(location.search).get('from') === 'capture' && window.opener) {
  for (const origin of captureOrigins) window.opener.postMessage({ type: 'relay.library.ready' }, origin);
}

function syncNavigation() { const mobile = matchMedia('(max-width:760px)').matches; const open = $('sidebar').classList.contains('mobile-open'); $('sidebar').inert = mobile && !open; $('menu-button').setAttribute('aria-expanded', String(open)); $('nav-backdrop').hidden = !mobile || !open; }
$('nav-backdrop').addEventListener('click', () => { $('sidebar').classList.remove('mobile-open'); syncNavigation(); });
window.addEventListener('resize', syncNavigation);
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('sidebar').classList.remove('mobile-open'); syncNavigation(); } });
syncNavigation();

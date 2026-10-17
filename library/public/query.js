export function filterVideos(videos, { query = '', source = 'all', status = 'all', favorite = false, sort = 'newest', date = 'all' } = {}) {
  const terms = query.toLocaleLowerCase().normalize('NFKC').trim().split(/\s+/u).filter(Boolean);
  const days = date === 'today' ? 1 : date === 'week' ? 7 : date === 'month' ? 30 : 0;
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  const filtered = videos.filter(video => {
    if (source === 'demonstration' ? !['upload', 'capture'].includes(video.source) : source !== 'all' && video.source !== source) return false;
    if (status !== 'all' && video.status !== status) return false;
    if (favorite && !video.favorite) return false;
    if (cutoff && new Date(video.createdAt).getTime() < cutoff) return false;
    const haystack = [video.title, video.filename, video.description, ...(video.tags || [])].join(' ').toLocaleLowerCase().normalize('NFKC');
    return terms.every(term => haystack.includes(term));
  });
  const compare = {
    newest: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    oldest: (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
    longest: (a, b) => (b.duration || 0) - (a.duration || 0),
    shortest: (a, b) => (a.duration || 0) - (b.duration || 0),
    size: (a, b) => (b.bytes || 0) - (a.bytes || 0),
    relevance: (a, b) => (b.score || 0) - (a.score || 0),
  }[sort] || (() => 0);
  return filtered.sort((a, b) => compare(a, b) || a.id.localeCompare(b.id));
}
export function formatDuration(seconds = 0) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return value >= 3600 ? `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
export function formatBytes(bytes = 0) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

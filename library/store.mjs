import { mkdir, readdir, readFile, writeFile, rename, stat, rm, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
const HLG_LUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets/hlg-to-rec709.cube');
const runFile = promisify(execFile);
export const MAX_BYTES = 300 * 1024 * 1024;
export class LibraryError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const extensions = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const idFor = text => createHash('sha256').update(text).digest('hex').slice(0, 24);
const cleanText = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
export function cleanMetadata(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LibraryError('Invalid video details.');
  const result = {};
  if ('title' in body) { result.title = cleanText(body.title, 140); if (!result.title) throw new LibraryError('Give your video a title.'); }
  if ('description' in body) result.description = cleanText(body.description, 3000);
  if ('tags' in body) {
    if (!Array.isArray(body.tags) || body.tags.length > 20 || body.tags.some(tag => typeof tag !== 'string')) throw new LibraryError('Use up to 20 text tags.');
    result.tags = [...new Set(body.tags.map(tag => cleanText(tag, 48).toLowerCase()).filter(Boolean))];
  }
  if ('favorite' in body) { if (typeof body.favorite !== 'boolean') throw new LibraryError('Invalid favorite setting.'); result.favorite = body.favorite; }
  return result;
}
function captureSummary(session) {
  if (!session || session.schemaVersion !== 'relay.capture.v1' || !Array.isArray(session.tasks) || !Array.isArray(session.checkpoints)) throw new LibraryError('Choose a Relay session JSON file.');
  if (!Number.isFinite(session.durationMs) || session.durationMs < 0 || session.durationMs > 900000) throw new LibraryError('Invalid session duration.');
  return { completed: session.completed === true, checkpointCount: session.checkpoints.length, taskCount: session.tasks.length, landmarkSamples: Array.isArray(session.landmarks) ? session.landmarks.length : 0, tasks: session.tasks.map(t => cleanText(t.object, 80)).filter(Boolean).slice(0, 20), duration: session.durationMs / 1000, startedAt: session.startedAt, camera: { width: Number(session.camera?.width) || null, height: Number(session.camera?.height) || null } };
}
export class VideoStore {
  constructor({ root, uploads, runs, probe = true, onPersist = async () => {} }) { this.root = root; this.uploads = uploads; this.runs = runs; this.probe = probe; this.onPersist = onPersist; this.jobs = new Map(); this.mutations = new Map(); this.media = new Map(); this.processingQueue = Promise.resolve(); }
  async init() { await mkdir(this.root, { recursive: true, mode: 0o700 }); await this.importExisting(); }
  async save(record) {
    const destination = path.join(this.root, `${record.id}.json`);
    const temp = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(temp, destination);
    await this.onPersist();
    return record;
  }
  async get(id) { if (!/^[a-z0-9-]{8,64}$/.test(id)) throw new LibraryError('Video not found.', 404); try { return JSON.parse(await readFile(path.join(this.root, `${id}.json`), 'utf8')); } catch (error) { if (error.code === 'ENOENT') throw new LibraryError('Video not found.', 404); throw error; } }
  async update(id, updater) {
    const previous = this.mutations.get(id) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => this.save(await updater(await this.get(id))));
    this.mutations.set(id, job);
    try { return await job; } finally { if (this.mutations.get(id) === job) this.mutations.delete(id); }
  }
  async list() {
    const names = await readdir(this.root);
    const records = await Promise.all(names.filter(name => /^[a-z0-9-]+\.json$/.test(name)).map(async name => JSON.parse(await readFile(path.join(this.root, name), 'utf8'))));
    return records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(record => this.public(record));
  }
  public(record) {
    const { file, ...safe } = record;
    return { ...safe, videoUrl: `/api/library/videos/${record.id}/stream`, thumbnailUrl: record.thumbnail ? `/api/library/videos/${record.id}/thumbnail` : null, sessionUrl: record.hasSession ? `/api/library/videos/${record.id}/session` : null };
  }
  filePath(record) {
    if (record.origin === 'upload-file') return path.join(this.uploads, path.basename(record.file));
    if (record.origin === 'robot-run') return path.join(this.runs, path.basename(record.file), 'rollout.mp4');
    return path.join(this.root, record.id, 'video' + path.extname(record.filename).toLowerCase());
  }
  streamPath(record) { return record.playback ? path.join(this.root, record.id, 'playback.mp4') : this.filePath(record); }
  async importExisting() {
    if (this.uploads) {
      let files = []; try { files = await readdir(this.uploads); } catch { /* No initial uploads. */ }
      for (const filename of files.filter(name => extensions.has(path.extname(name).toLowerCase()))) {
        if (/-vast-sdr\.mp4$/.test(filename) && files.includes(filename.replace('-vast-sdr.mp4', '-vast-h264.mp4'))) continue;
        const id = idFor(`upload:${filename}`);
        try { await this.get(id); continue; } catch (error) { if (error.status !== 404) throw error; }
        const info = await stat(path.join(this.uploads, filename));
        await this.save({ id, title: filename.replace(/-vast-(h264|sdr)/, '').replace(/\.[^.]+$/, '').replace(/_/g, ' '), filename, description: 'Original uploaded footage. Add a description and tags to make this demonstration easier to find.', tags: ['demonstration'], source: 'upload', status: 'ready', favorite: false, createdAt: info.mtime.toISOString(), bytes: info.size, origin: 'upload-file', file: filename, processing: true });
        this.enrich(id);
      }
    }
    if (this.runs) {
      let folders = []; try { folders = await readdir(this.runs); } catch { /* Robot console is optional. */ }
      for (const folder of folders.filter(name => /^\d{8}-\d{6}-[a-f0-9]+$/.test(name))) {
        const id = idFor(`run:${folder}`);
        try { await this.get(id); continue; } catch (error) { if (error.status !== 404) throw error; }
        try {
          const info = await stat(path.join(this.runs, folder, 'rollout.mp4'));
          const request = JSON.parse(await readFile(path.join(this.runs, folder, 'request.json'), 'utf8'));
          let result = {}; try { result = JSON.parse(await readFile(path.join(this.runs, folder, 'result.json'), 'utf8')); } catch { /* A partial recording is still usable. */ }
          await this.save({ id, title: (request.command || 'Robot rollout').replace(/^unlocked_waist:\s*/, '').replace(/\.$/, ''), filename: `${folder}.mp4`, description: `NVIDIA GR00T simulation. Scene seed ${request.seed}. ${result.stopped ? 'Stopped early.' : result.goal_check ? `Requested object ${result.goal_check.in_box ? 'inside' : 'outside'} box at the final check.` : 'Inspect the recording to assess the result.'} A simulation recording, not a human capture.`, tags: ['simulation', 'gr00t', `seed ${request.seed}`, ...(request.command?.toLowerCase().includes('bottle') ? ['bottle'] : []), ...(request.command?.toLowerCase().includes('can') ? ['can'] : [])], source: 'rollout', status: result.stopped ? 'partial' : 'ready', favorite: false, createdAt: info.mtime.toISOString(), bytes: info.size, origin: 'robot-run', file: folder, processing: true, duration: (result.steps || 0) / 20 });
          this.enrich(id);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    // Recover metadata jobs if a previous server shut down during an import.
    for (const record of await this.list()) if (record.processing) this.enrich(record.id);
  }
  async upload(req, parameters) {
    const filename = path.basename(cleanText(parameters.get('filename'), 180));
    const extension = path.extname(filename).toLowerCase();
    if (!extensions.has(extension)) throw new LibraryError('Choose an MP4, WebM, MOV, or M4V video.', 415);
    if (Number(req.headers['content-length']) > MAX_BYTES) throw new LibraryError('Videos can be up to 300 MB.', 413);
    const id = randomUUID();
    const directory = path.join(this.root, id);
    await mkdir(directory, { mode: 0o700 });
    const temp = path.join(directory, 'upload.partial');
    let bytes = 0;
    try {
      const limit = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > MAX_BYTES ? new LibraryError('Videos can be up to 300 MB.', 413) : null, chunk); } });
      await pipeline(req, limit, createWriteStream(temp, { mode: 0o600 }));
      if (bytes < 32) throw new LibraryError('The video file is empty or incomplete.');
      const handle = await open(temp, 'r');
      const signature = Buffer.alloc(16);
      try { await handle.read(signature, 0, 16, 0); } finally { await handle.close(); }
      const webm = signature.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      const mp4 = signature.subarray(4, 8).toString() === 'ftyp' || (extension === '.mov' && ['wide', 'mdat', 'moov'].includes(signature.subarray(4, 8).toString()));
      if ((extension === '.webm' && !webm) || (extension !== '.webm' && !mp4)) throw new LibraryError('This file does not look like a supported video.', 415);
      await rename(temp, path.join(directory, `video${extension}`));
      const record = { id, filename, title: cleanText(parameters.get('title'), 140) || filename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '), description: '', tags: [], source: 'upload', status: 'ready', favorite: false, bytes, createdAt: new Date().toISOString(), origin: 'library', processing: true };
      await this.save(record);
      this.enrich(id);
      return this.public(record);
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  enrich(id) {
    if (this.jobs.has(id)) return this.jobs.get(id);
    const job = this.processingQueue.then(async () => {
      const record = await this.get(id);
      const directory = path.join(this.root, id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const additions = { processing: false };
      if (this.probe) {
        try {
          const { stdout } = await runFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type,codec_name,color_transfer,color_primaries:stream_side_data=rotation', '-of', 'json', this.filePath(record)], { timeout: 12000, maxBuffer: 64000 });
          const data = JSON.parse(stdout); const stream = data.streams?.find(item => item.codec_type === 'video');
          if (!stream) throw new Error('No video stream');
          if (Number(data.format?.duration) > 0) additions.duration = Number(data.format.duration);
          const rotated = stream.side_data_list?.some(item => Math.abs(Number(item.rotation)) % 180 === 90);
          additions.width = rotated ? stream.height : stream.width; additions.height = rotated ? stream.width : stream.height;
          additions.originalCodec = stream.codec_name;
          const hdr = stream.color_transfer === 'arib-std-b67';
          let thumbnailInput = this.filePath(record);
          if (stream.codec_name === 'hevc' || hdr) {
            const temporary = path.join(directory, 'playback.partial.mp4');
            const filter = (hdr ? `format=gbrpf32le,lut3d=file='${HLG_LUT.replace(/'/g, "'\\''")}':interp=tetrahedral,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,` : '') + 'scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709,format=yuv420p';
            await runFile('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', this.filePath(record), '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1', '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', temporary], { timeout: 600000, maxBuffer: 64000 });
            thumbnailInput = path.join(directory, 'playback.mp4');
            await rename(temporary, thumbnailInput);
            additions.playback = true; additions.previewFormat = hdr ? 'H.264 / Rec.709 SDR' : 'H.264';
          }
          await runFile('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', thumbnailInput, '-vf', 'thumbnail=30,scale=800:-2', '-frames:v', '1', path.join(directory, 'thumbnail.jpg')], { timeout: 20000, maxBuffer: 64000 });
          additions.thumbnail = true;
        } catch { additions.previewNote = 'Preview metadata unavailable; the original video is retained.'; }
      }
      await this.update(id, current => ({ ...current, ...additions }));
    }).catch(() => {}).finally(() => this.jobs.delete(id));
    this.processingQueue = job;
    this.jobs.set(id, job); return job;
  }
  async patch(id, body) { const changes = cleanMetadata(body); return this.public(await this.update(id, record => ({ ...record, ...changes }))); }
  async attachSession(id, session) {
    const summary = captureSummary(session);
    const record = await this.get(id);
    if (record.origin !== 'library') throw new LibraryError('Session data can only be attached to a library upload.');
    const destination = path.join(this.root, id, 'session.json');
    const temporary = destination + `.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(session), { mode: 0o600 }); await rename(temporary, destination);
    return this.public(await this.update(id, current => ({ ...current, source: 'capture', status: summary.completed ? 'verified' : 'partial', hasSession: true, capture: summary, duration: current.duration || summary.duration, description: `${summary.checkpointCount} of ${summary.taskCount} capture checkpoints verified. ${summary.landmarkSamples.toLocaleString()} landmark samples recorded.`, tags: [...new Set([...current.tags, ...summary.tasks.map(task => task.toLowerCase()), 'human demonstration'])] })));
  }
}

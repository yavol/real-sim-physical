import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelRoot = path.join(root, 'public/models');
const fontRoot = path.join(root, 'public/fonts');
await mkdir(modelRoot, { recursive: true });
await mkdir(fontRoot, { recursive: true });
const assets = [
  { url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task', file: path.join(modelRoot, 'pose_landmarker_lite.task'), minSize: 5_000_000 },
  { url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', file: path.join(modelRoot, 'hand_landmarker.task'), minSize: 5_000_000 },
  { url: 'https://cdn.jsdelivr.net/fontsource/fonts/dm-sans:vf@5.2.8/latin-wght-normal.woff2', file: path.join(fontRoot, 'dm-sans-latin.woff2'), minSize: 10_000 },
];
for (const [family, filename] of [['IBM+Plex+Mono', 'ibm-plex-mono-latin.woff2']]) {
  const cssResponse = await fetch(`https://fonts.googleapis.com/css2?family=${family}&display=swap`, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' }, signal: AbortSignal.timeout(30_000) });
  if (!cssResponse.ok) throw new Error(`Font metadata failed: ${cssResponse.status}`);
  const css = await cssResponse.text();
  const latin = css.split('/* latin */').at(-1);
  const url = latin.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1];
  if (!url) throw new Error(`Font file URL missing: ${family}`);
  assets.push({ url, file: path.join(fontRoot, filename), minSize: 10_000 });
}
const manifest = [];
for (const asset of assets) {
  let bytes;
  try { if ((await stat(asset.file)).size >= asset.minSize) bytes = await readFile(asset.file); } catch { /* Download if absent. */ }
  if (!bytes) {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${asset.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < asset.minSize) throw new Error(`Asset is unexpectedly small: ${asset.file}`);
    await writeFile(asset.file, bytes);
  }
  manifest.push({ file: path.relative(root, asset.file), source: asset.url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  console.log(`${path.basename(asset.file)} · ${Math.round(bytes.length / 1024)} KB`);
}
await writeFile(path.join(root, 'asset-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

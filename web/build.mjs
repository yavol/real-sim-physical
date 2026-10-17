import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(root, 'capture/public'), dist, { recursive: true, filter: source => !path.basename(source).startsWith('library-qa.') });
await cp(path.join(root, 'static'), path.join(dist, 'static'), { recursive: true });
await cp(path.join(root, 'web/public'), dist, { recursive: true });
await cp(path.join(root, 'library/public'), path.join(dist, 'library'), { recursive: true });
const robot = (await readFile(path.join(root, 'static/index.html'), 'utf8'))
  .replace('LOCAL CONSOLE', 'HOSTED CONSOLE')
  .replace('<script src="/static/app.js"></script>', '<script type="module" src="/demo-loader.js" data-demo="robot"></script>');
const capture = (await readFile(path.join(root, 'capture/public/index.html'), 'utf8'))
  .replaceAll('http://127.0.0.1:8791/', '/library')
  .replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/demo-loader.js" data-demo="collect"></script>');
const library = (await readFile(path.join(root, 'library/public/index.html'), 'utf8'))
  .replace('href="/styles.css"', 'href="/library/styles.css"').replace('src="/app.js"', 'src="/library/app.js"')
  .replaceAll('http://127.0.0.1:8790/', '/collect')
  .replaceAll('Stored on this device', 'Public demo library').replaceAll('STORED LOCALLY', 'IN THE LIBRARY')
  .replaceAll('Local workspace', 'Public workspace')
  .replaceAll('Your original videos are saved on this device, ready to watch and organize.', 'Videos added here are saved in the shared demo library, available to anyone with this URL.')
  .replaceAll('Saved locally. Uploads are sent to VAST only after a separate workspace integration is configured.', 'Saved in cloud storage. Anyone with the demo URL can browse and play these videos.')
  .replaceAll('Your videos are saved on this device. VAST is not connected yet.', 'The cloud library is ready to browse. VAST is not connected yet.')
  .replaceAll('Working locally', 'Cloud library').replaceAll('Keep working locally', 'Continue browsing')
  .replaceAll('Used by the local server for this session. Never included in playback links.', 'A VAST connection has not been configured for this hosted demo.');
await writeFile(path.join(dist, 'robot.html'), robot);
await writeFile(path.join(dist, 'collect.html'), capture);
await writeFile(path.join(dist, 'library/index.html'), library);
const media = path.join(root, 'node_modules/@mediapipe/tasks-vision');
await mkdir(path.join(dist, 'vendor/mediapipe'), { recursive: true });
await cp(path.join(media, 'vision_bundle.mjs'), path.join(dist, 'vendor/mediapipe/vision_bundle.mjs'));
await cp(path.join(media, 'wasm'), path.join(dist, 'vendor/mediapipe/wasm'), { recursive: true });
console.log('Built the public launcher, robot console, collection studio, video library, and tracking assets.');

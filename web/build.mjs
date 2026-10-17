import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(root, 'capture/public'), dist, { recursive: true });
await cp(path.join(root, 'static'), path.join(dist, 'static'), { recursive: true });
await cp(path.join(root, 'web/public'), dist, { recursive: true });
const robot = (await readFile(path.join(root, 'static/index.html'), 'utf8'))
  .replace('LOCAL CONSOLE', 'HOSTED CONSOLE')
  .replace('<script src="/static/app.js"></script>', '<script type="module" src="/demo-loader.js" data-demo="robot"></script>');
const capture = (await readFile(path.join(root, 'capture/public/index.html'), 'utf8'))
  .replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/demo-loader.js" data-demo="collect"></script>');
await writeFile(path.join(dist, 'robot.html'), robot);
await writeFile(path.join(dist, 'collect.html'), capture);
const media = path.join(root, 'node_modules/@mediapipe/tasks-vision');
await mkdir(path.join(dist, 'vendor/mediapipe'), { recursive: true });
await cp(path.join(media, 'vision_bundle.mjs'), path.join(dist, 'vendor/mediapipe/vision_bundle.mjs'));
await cp(path.join(media, 'wasm'), path.join(dist, 'vendor/mediapipe/wasm'), { recursive: true });
console.log('Built one launch page, robot console, collection studio, and local tracking assets.');

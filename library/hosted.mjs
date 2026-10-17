import { createLibraryServer } from './server.mjs';

const server = await createLibraryServer({
  dataRoot: '/library', uploads: false, runs: '/runs', hosted: true,
  captureUrl: 'https://real-sim-physical.vercel.app/collect',
  onPersist: async () => {
    const response = await fetch('http://127.0.0.1:8792/persist', { method: 'POST', signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error('Persistent storage could not confirm the write.');
  },
});
server.listen(8791, '127.0.0.1', () => console.log('Private library worker ready.'));

// Transfer only to the exact library window and origin. The library confirms
// persistence before the collection studio reports that the capture is saved.
export function transferCaptureToLibrary(getRecording, { libraryUrl = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8791/' : location.origin + '/library' } = {}) {
  const target = new URL(libraryUrl); target.searchParams.set('from', 'capture');
  const libraryWindow = window.open(target.href, 'relay-video-library');
  if (!libraryWindow) return Promise.reject(new Error('Allow the video library tab to open, then try again.'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let sent = false;
    const timeout = setTimeout(() => finish(new Error('The library did not finish saving. Keep this capture open and retry, or download the original video and JSON.')), 600000);
    const onMessage = async event => {
      if (event.origin !== target.origin || event.source !== libraryWindow) return;
      if (event.data?.type === 'relay.library.ready' && !sent) {
        sent = true;
        try { const recording = await getRecording(); if (!recording.video?.size) throw new Error('No video was recorded. Save the session JSON instead.'); libraryWindow.postMessage({ type: 'relay.library.capture', requestId, ...recording }, target.origin); }
        catch (error) { finish(error); }
      }
      if (event.data?.requestId !== requestId) return;
      if (event.data.type === 'relay.library.saved') finish(null, event.data.id);
      if (event.data.type === 'relay.library.error') finish(new Error(event.data.message || 'The video could not be saved. Your recording is still available here.'));
    };
    function finish(error, id) { clearTimeout(timeout); window.removeEventListener('message', onMessage); error ? reject(error) : resolve(id); }
    window.addEventListener('message', onMessage);
  });
}

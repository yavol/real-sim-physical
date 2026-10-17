const demo = document.querySelector('script[data-demo]')?.dataset.demo;
try {
  const response = await fetch('/api/session');
  const session = await response.json();
  if (!session.unlocked) location.replace('/?next=' + (demo === 'robot' ? 'robot' : 'collect'));
  else if (demo === 'robot') {
    const script = document.createElement('script');
    script.src = '/static/app.js';
    document.body.append(script);
  } else await import('/app.js');
} catch {
  location.replace('/?next=' + (demo === 'robot' ? 'robot' : 'collect'));
}

const demo = document.querySelector('script[data-demo]')?.dataset.demo;
if (demo === 'robot') {
  const script = document.createElement('script');
  script.src = '/static/app.js';
  document.body.append(script);
} else await import('/app.js');

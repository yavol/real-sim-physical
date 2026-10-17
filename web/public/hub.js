const $ = id => document.getElementById(id);
const requested = new URLSearchParams(location.search).get('next');
if (['robot', 'collect', 'library'].includes(requested)) location.replace('/' + requested);
document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('watch-recording').addEventListener('click', () => { $('recording-dialog').showModal(); $('recorded-run').play().catch(() => {}); });
$('recording-dialog').addEventListener('close', () => $('recorded-run').pause());

const $ = id => document.getElementById(id);
const dialog = $('access-dialog');
let unlocked = false;
let next = null;
const requested = new URLSearchParams(location.search).get('next');
if (['robot', 'collect'].includes(requested)) next = '/' + requested;
function showAccess() { dialog.showModal(); $('access-code').focus(); }
document.querySelectorAll('[data-launch]').forEach(link => link.addEventListener('click', event => {
  if (unlocked) return;
  event.preventDefault(); next = link.getAttribute('href'); showAccess();
}));
$('access-status').addEventListener('click', () => { if (!unlocked) { next = null; showAccess(); } });
document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => { button.closest('dialog').close(); }));
$('access-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type=submit]');
  button.disabled = true; $('access-error').textContent = '';
  try {
    const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('access-code').value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not unlock the demos.');
    unlocked = true; $('access-code').value = ''; dialog.close();
    $('access-status').textContent = 'LIVE DEMOS UNLOCKED ↗'; $('access-status').classList.add('unlocked');
    if (next) location.assign(next);
  } catch (error) { $('access-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('watch-recording').addEventListener('click', () => { $('recording-dialog').showModal(); $('recorded-run').play().catch(() => {}); });
$('recording-dialog').addEventListener('close', () => $('recorded-run').pause());
try {
  const response = await fetch('/api/session');
  const session = await response.json();
  unlocked = session.unlocked;
  $('access-status').textContent = unlocked ? 'LIVE DEMOS UNLOCKED ↗' : 'UNLOCK LIVE DEMOS ↗';
  $('access-status').classList.toggle('unlocked', unlocked);
  if (next && unlocked) location.replace(next);
  else if (next) showAccess();
} catch { $('access-status').textContent = 'UNLOCK LIVE DEMOS ↗'; }

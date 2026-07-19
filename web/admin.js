const guild = new URLSearchParams(location.search).get('guild');
const status = document.querySelector('#status');
const dashboard = document.querySelector('#dashboard');
let user;
let owner = false;

const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
document.querySelector('#theme').onclick = () => { document.body.classList.toggle('light'); localStorage.theme = document.body.classList.contains('light') ? 'light' : 'dark'; };
if (localStorage.theme === 'light') document.body.classList.add('light');
document.querySelector('#clipsLink').href = guild ? `/?guild=${encodeURIComponent(guild)}` : '/';

async function json(url, options) {
  const response = await fetch(url, options);
  const body = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

async function loadAdmins() {
  const data = await json(`/api/admins/${encodeURIComponent(guild)}`);
  document.querySelector('#admins').innerHTML = data.admins.length ? data.admins.map(admin => `<div class="admin-row"><div><strong>${escapeHtml(admin.user_id)}</strong><span class="muted">Added ${new Date(admin.created_at).toLocaleDateString()}</span></div><button class="quiet remove" data-id="${escapeHtml(admin.user_id)}">Remove</button></div>`).join('') : '<div class="empty">No delegated bot admins yet.</div>';
  document.querySelectorAll('.remove').forEach(button => button.onclick = async () => {
    if (!confirm(`Remove bot admin ${button.dataset.id}?`)) return;
    try { await json(`/api/admins/${encodeURIComponent(guild)}/${button.dataset.id}`, { method: 'DELETE' }); await loadAdmins(); }
    catch (error) { status.textContent = error.message; }
  });
}

async function loadChannels(selectedId) {
  const channelSelect = document.querySelector('#clipsChannel');
  try {
    const data = await json(`/api/discord/${encodeURIComponent(guild)}/channels`);
    channelSelect.innerHTML = '<option value="">Default #clips channel</option>' + data.channels.map(channel => `<option value="${escapeHtml(channel.id)}">#${escapeHtml(channel.name)}</option>`).join('');
    document.querySelector('#channelHelp').textContent = 'The bot posts new clips in this channel.';
  } catch (error) {
    document.querySelector('#channelHelp').textContent = error.message;
    if (selectedId) channelSelect.innerHTML += `<option value="${escapeHtml(selectedId)}">Configured channel (${escapeHtml(selectedId)})</option>`;
  }
  channelSelect.value = selectedId || '';
}

async function init() {
  if (!guild) { status.textContent = 'Choose a server from the clips page first.'; return; }
  user = await json('/api/auth/me');
  if (!user) { location = '/api/auth/login'; return; }
  const server = user.guilds?.find(item => item.id === guild);
  if (!server) { status.textContent = 'You are not a member of this server.'; return; }
  owner = user.ownerGuilds?.includes(guild);
  if (!user.accessGuilds?.includes(guild)) { status.textContent = 'Bot admin access is required for this page.'; return; }
  const settings = await json(`/api/settings/${encodeURIComponent(guild)}`);
  document.querySelector('#heading').textContent = `Manage ${server.name}`;
  document.querySelector('#buffer').value = settings.buffer_size_minutes || 30;
  document.querySelector('#retention').value = settings.retention_days || 90;
  if (!owner) document.querySelector('.owner-only').hidden = true;
  dashboard.hidden = false;
  status.textContent = owner ? 'You are the server owner.' : 'You have bot-admin access.';
  loadChannels(settings.clips_channel_id);
  if (owner) loadAdmins().catch(error => { status.textContent = error.message; });
}

document.querySelector('#settingsForm').onsubmit = async event => {
  event.preventDefault();
  try {
    await json(`/api/settings/${encodeURIComponent(guild)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips_channel_id: document.querySelector('#clipsChannel').value, buffer_size_minutes: Number(document.querySelector('#buffer').value), retention_days: Number(document.querySelector('#retention').value) }) });
    status.textContent = 'Settings saved.';
  } catch (error) { status.textContent = error.message; }
};

document.querySelector('#adminForm').onsubmit = async event => {
  event.preventDefault();
  try {
    await json(`/api/admins/${encodeURIComponent(guild)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: document.querySelector('#adminId').value.trim() }) });
    document.querySelector('#adminId').value = '';
    await loadAdmins();
    status.textContent = 'Bot admin added.';
  } catch (error) { status.textContent = error.message; }
};

init().catch(error => { status.textContent = error.message; });

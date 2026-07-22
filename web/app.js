import { apiFetch, setCsrfToken } from '/api.js';
import { clipCard, escapeHtml, formatBytes, formatDuration, iconMarkup, relativeTime, skeleton } from '/ui.js';

const state = {
  me: null, mode: null, servers: { installed: [], installable: [] }, server: null,
  overview: null, clips: [], cursor: null, total: 0, trash: false, search: '',
  audioClip: null, searchTimer: null, requestId: 0, routeController: null, libraryController: null,
  editor: null, textResolve:null, confirmResolve:null
};
const elements = Object.fromEntries(['welcome','appShell','serverRail','openServerPicker','mobileServerPicker','desktopNav','mobileNav','view','theme','accountButton','accountDialog','accountContent','serverDialog','serverChoices','renameDialog','renameForm','renameTitle','renameLabel','renameInput','renameSubmit','confirmDialog','confirmTitle','confirmMessage','confirmButton','player','playerToggle','playerTitle','playerServer','playerSeek','playerTime','playerClose','persistentAudio','toastRegion'].map(id => [id, document.getElementById(id)]));
const navItems = [{ key:'home', label:'Home' }, { key:'library', label:'Library' }, { key:'favorites', label:'Favorites' }, { key:'manage', label:'Manage', admin:true }];

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`; node.textContent = message; elements.toastRegion.append(node);
  setTimeout(() => node.remove(), 4200);
}
function route() {
  let match = location.pathname.match(/^\/servers\/([^/]+)(?:\/([^/]+))?$/);
  if (match) return { type:'server', guildId:decodeURIComponent(match[1]), view:match[2] || 'home' };
  match = location.pathname.match(/^\/clips\/([^/]+)$/);
  return match ? { type:'clip', clipId:decodeURIComponent(match[1]) } : { type:'root' };
}
function editorDirty() { return Boolean(state.editor && JSON.stringify(state.editor.saved) !== JSON.stringify(state.editor.form)); }
async function go(url, options = {}) {
  if (typeof options === 'boolean') options = { replace:options };
  if (!options.force && editorDirty() && !await confirmAction('Discard unsaved changes?', 'Your unsaved trim and mix changes will be lost.', 'Discard', true)) return false;
  state.editor = null;
  if (options.replace) history.replaceState({}, '', url); else history.pushState({}, '', url);
  await renderRoute();
  return true;
}
function currentServer(id = route().guildId) { return state.servers.installed.find(server => server.id === id); }
function navUrl(key) { return `/servers/${encodeURIComponent(state.server.id)}/${key}`; }
function routeFetch(url, options = {}) { return apiFetch(url, { ...options, signal:options.signal || state.routeController?.signal }); }
function avatar(user) { return user.avatarUrl ? `<img src="${escapeHtml(user.avatarUrl)}" alt="">` : `<span>${escapeHtml((user.username || '?')[0].toUpperCase())}</span>`; }
function setAccent(server) { document.documentElement.style.setProperty('--server-accent', server?.accent || '#7c8cff'); }
function brandName(server = state.server) { return String(server?.botDisplayName || 'ClipThat').trim() || 'ClipThat'; }
function brandInitials(name = brandName()) { return name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase().slice(0, 2) || 'CT'; }
function setBrand(server = state.server) {
  const name = brandName(server);
  document.title = server ? `${name} · ${server.name}` : name;
}

async function withButton(button, label, task) {
  if (button.disabled) return;
  const html = button.innerHTML;
  button.disabled = true; button.classList.add('loading'); button.textContent = label;
  try { return await task(); }
  finally { if (button.isConnected) { button.disabled = false; button.classList.remove('loading'); button.innerHTML = html; } }
}

function confirmAction(title, message, label = 'Continue', danger = false) {
  if (state.confirmResolve) state.confirmResolve(false);
  elements.confirmTitle.textContent = title; elements.confirmMessage.textContent = message; elements.confirmButton.textContent = label;
  elements.confirmButton.classList.toggle('danger-button', danger);
  elements.confirmDialog.showModal();
  return new Promise(resolve => { state.confirmResolve = resolve; });
}

function requestText(title, label, value = '', submitLabel = 'Save') {
  if (state.textResolve) state.textResolve(null);
  elements.renameTitle.textContent = title; elements.renameLabel.textContent = label; elements.renameSubmit.textContent = submitLabel;
  elements.renameInput.value = value;
  elements.renameDialog.showModal();
  requestAnimationFrame(() => { elements.renameInput.focus(); elements.renameInput.select(); });
  return new Promise(resolve => { state.textResolve = resolve; });
}

function showWelcome() {
  setBrand(null);
  elements.appShell.hidden = true; elements.welcome.hidden = false;
  const local = state.mode?.developmentLogin ? '<form id="devLoginForm" class="dev-login-form"><label>Temporary local code<input id="devLoginCode" autocomplete="one-time-code" required></label><button class="button secondary" type="submit">Open local server</button></form>' : '';
  elements.welcome.innerHTML = `<div class="welcome-card"><div class="brand-lockup"><span class="vault-logo">CT</span><strong>ClipThat</strong></div><div><p class="eyebrow">YOUR MOMENTS, IN CONTEXT</p><h1>Open your server's clips.</h1><p class="welcome-copy">Sign in to see only the Discord servers you belong to. ClipThat stores a secure session cookie, never your Discord access token.</p></div><div class="welcome-actions"><a class="button discord-button" href="/api/auth/login?return_to=${encodeURIComponent(location.pathname)}">Continue with Discord</a>${local}</div><p class="privacy-note">Private by default &middot; <a href="/privacy.html">Privacy</a> &middot; <a href="/terms.html">Terms</a></p></div>`;
}

function showStartupError(error) {
  setBrand(null); elements.appShell.hidden = true; elements.welcome.hidden = false;
  elements.welcome.innerHTML = `<div class="welcome-card error-welcome"><div class="brand-lockup"><span class="vault-logo">!</span><strong>ClipThat</strong></div><div><p class="eyebrow">CONNECTION PROBLEM</p><h1>Could not open ClipThat.</h1><p class="welcome-copy">${escapeHtml(error.message)}</p></div><button class="button" data-action="retry-app" type="button">Try again</button></div>`;
}

function renderShell() {
  elements.welcome.hidden = true; elements.appShell.hidden = false;
  elements.serverRail.innerHTML = state.servers.installed.map(server => { const active = server.id === state.server?.id; return `<a href="/servers/${encodeURIComponent(server.id)}/home" data-route class="server-button ${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''} aria-label="${escapeHtml(server.name)}" title="${escapeHtml(server.name)}">${iconMarkup(server)}${active ? '<i class="active-server-dot" aria-hidden="true"></i>' : ''}</a>`; }).join('');
  elements.accountButton.innerHTML = avatar(state.me);
  setBrand(state.server);
  if (!state.server) return;
  setAccent(state.server);
  elements.mobileServerPicker.innerHTML = `${iconMarkup(state.server)}<span><small>${escapeHtml(brandName())}</small><strong>${escapeHtml(state.server.name)}</strong></span><b aria-hidden="true">&#8964;</b>`;
  const current = route().view || (route().type === 'clip' ? '' : 'home');
  const allowed = navItems.filter(item => !item.admin || state.server.capabilities.canManage);
  const markup = allowed.map(item => { const active = current === item.key; return `<a href="${navUrl(item.key)}" data-route class="${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`; }).join('');
  elements.desktopNav.innerHTML = markup; elements.mobileNav.innerHTML = markup;
}

function serverPicker() {
  const installed = state.servers.installed.map(server => { const active = server.id === state.server?.id; return `<a class="server-choice ${active ? 'active' : ''}" href="/servers/${encodeURIComponent(server.id)}/home" data-route ${active ? 'aria-current="page"' : ''}>${iconMarkup(server)}<span><strong>${escapeHtml(server.name)}</strong><small>${active ? 'Current server' : 'Open library'}</small></span>${active ? '<b aria-hidden="true">✓</b>' : ''}</a>`; }).join('');
  const installable = state.servers.installable.map(server => `<button class="server-choice" type="button" data-install="${escapeHtml(server.id)}">${iconMarkup(server)}<span><strong>${escapeHtml(server.name)}</strong><small>Add ClipThat</small></span></button>`).join('');
  elements.serverChoices.innerHTML = `<h3>Installed</h3>${installed || '<p class="empty-copy">No installed servers yet.</p>'}${installable ? `<h3>Available to add</h3>${installable}` : ''}`;
  elements.serverDialog.showModal();
}

async function refreshServers() {
  state.servers = await apiFetch('/api/servers');
  if (state.server) state.server = currentServer(state.server.id) || state.server;
  renderShell();
}

async function waitForInstall(guildId, button) {
  button.disabled = true; button.querySelector('small').textContent = 'Waiting for Discord…';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    await refreshServers();
    const installed = currentServer(guildId);
    if (installed) { elements.serverDialog.close(); toast(`${installed.name} is ready.`); return go(`/servers/${encodeURIComponent(guildId)}/home`); }
  }
  button.disabled = false; button.querySelector('small').textContent = 'Add ClipThat';
  toast('Installation is still pending. Reopen the server switcher to check again.', 'error');
}

function accountDialog() {
  elements.accountContent.innerHTML = `<div class="account-card">${avatar(state.me)}<div><strong>${escapeHtml(state.me.username)}</strong><small>${state.me.development ? 'Local development session' : 'Discord session'}</small></div></div><div class="policy-links"><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a></div><button class="button secondary full" data-action="logout" type="button">Sign out</button>`;
  elements.accountDialog.showModal();
}

function statusMarkup(overview) {
  const runtime = overview.runtime;
  const tone = runtime.connected ? 'live' : runtime.online ? 'ready' : 'offline';
  const label = runtime.connected ? `Recording ${runtime.voiceChannelName || 'voice'}` : runtime.online ? 'Bot online' : 'Bot offline';
  return `<div class="status-pill ${tone}"><i></i><span><strong>${escapeHtml(label)}</strong><small>${runtime.connected ? `${runtime.speakerCount} active speaker${runtime.speakerCount === 1 ? '' : 's'}` : 'Live recorder status'}</small></span></div>`;
}
function shelf(title, clips, empty) {
  return `<section class="shelf"><div class="section-heading"><h2>${escapeHtml(title)}</h2></div>${clips.length ? `<div class="clip-grid">${clips.map(clip => clipCard(clip)).join('')}</div>` : `<div class="empty-panel"><p>${escapeHtml(empty)}</p></div>`}</section>`;
}

async function renderHome() {
  elements.view.innerHTML = skeleton(4);
  const overview = await routeFetch(`/api/servers/${encodeURIComponent(state.server.id)}/overview`); state.overview = overview;
  const checklist = state.server.capabilities.canManage && !overview.setup.complete ? `<aside class="setup-card"><div><p class="eyebrow">ADMIN CHECKLIST</p><h2>Finish setting up this vault</h2></div><ul><li class="${overview.setup.botOnline ? 'done' : ''}">Bot connected</li><li class="${overview.setup.clipsChannelConfigured ? 'done' : ''}">Clips channel selected</li><li class="${overview.setup.consentConfigured ? 'done' : ''}">Recording privacy reviewed</li></ul><a class="button secondary" href="${navUrl('manage')}" data-route>Open settings</a></aside>` : '';
  elements.view.innerHTML = `<section class="server-hero"><div><p class="eyebrow">${escapeHtml(state.server.name.toUpperCase())}</p><h1>Your server's moments.</h1><p>${overview.counts.total} clips saved · ${overview.counts.favorites} favorites</p></div>${statusMarkup(overview)}</section>${checklist}${shelf('Recent moments', overview.recent, 'New clips will appear here as soon as someone uses /clipthat.')}${shelf('Favorites', overview.favorites, 'Favorite the moments your server keeps coming back to.')}<div class="section-link"><a href="${navUrl('library')}" data-route>Browse all ${overview.counts.total} clips <span aria-hidden="true">&rarr;</span></a></div>`;
}

function libraryHeading(view) {
  const admin = state.server.capabilities.canManage;
  return `<section class="library-head"><div><p class="eyebrow">${view === 'favorites' ? 'SAVED FOR LATER' : 'YOUR ARCHIVE'}</p><h1>${view === 'favorites' ? 'Favorites' : state.trash ? 'Trash' : 'Library'}</h1><p id="libraryCount" class="muted">${state.total} moments</p></div><label class="search-box"><span aria-hidden="true">&#8981;</span><span class="sr-only">Search clips</span><input id="clipSearch" type="search" value="${escapeHtml(state.search)}" placeholder="Search titles or speakers" autocomplete="off"></label></section>${admin && view === 'library' ? `<div class="segmented" role="tablist"><button class="${!state.trash ? 'active' : ''}" data-action="show-active" role="tab" aria-selected="${!state.trash}" type="button">Active</button><button class="${state.trash ? 'active' : ''}" data-action="show-trash" role="tab" aria-selected="${state.trash}" type="button">Trash</button></div>` : ''}`;
}
async function loadClips(view, reset = false) {
  if (reset) { state.clips = []; state.cursor = null; }
  state.libraryController?.abort();
  state.libraryController = new AbortController();
  state.routeController?.signal.addEventListener('abort', () => state.libraryController?.abort(), { once:true });
  const request = ++state.requestId;
  const params = new URLSearchParams({ guild:state.server.id, limit:'24' });
  if (state.cursor) params.set('cursor', state.cursor);
  if (state.search) params.set('q', state.search);
  if (view === 'favorites') params.set('favorite', '1');
  if (state.trash) params.set('trash', '1');
  const data = await apiFetch(`/api/clips?${params}`, { signal:state.libraryController.signal });
  if (request !== state.requestId) return;
  state.clips.push(...data.clips); state.cursor = data.next_cursor; state.total = data.count;
  renderClipGrid(view);
}
function renderClipGrid(view) {
  const count = document.getElementById('libraryCount'); if (count) count.textContent = `${state.total} moment${state.total === 1 ? '' : 's'}`;
  const grid = document.getElementById('clipGrid'); if (!grid) return;
  grid.innerHTML = state.clips.length ? state.clips.map(clip => clipCard(clip)).join('') : `<div class="empty-panel wide"><h2>${state.search ? 'No matches' : state.trash ? 'Trash is empty' : 'No clips yet'}</h2><p>${state.search ? 'Try a shorter title or speaker name.' : 'Use /clipthat in Discord and it will appear here.'}</p></div>`;
  const more = document.getElementById('loadMore'); if (more) more.hidden = !state.cursor;
}
async function renderLibrary(view) {
  state.trash = state.trash && view === 'library' && state.server.capabilities.canManage;
  elements.view.innerHTML = `${libraryHeading(view)}<div id="clipGrid" class="clip-grid">${skeleton(6)}</div><button id="loadMore" class="button secondary load-more" type="button" hidden>Load more</button>`;
  await loadClips(view, true);
}

function editState(clip) {
  const revision = clip.current_revision || {};
  return { start:Number(revision.start_trim ?? clip.start_trim ?? 0), end:Number(revision.end_trim ?? clip.end_trim ?? clip.duration), mutes:{ ...(revision.user_mutes || clip.user_mutes || {}) }, volumes:{ ...(revision.user_volumes || clip.user_volumes || {}) } };
}
function editorForm(clip, form) {
  const speakers = clip.users_involved.map(user => `<div class="speaker-control"><div><strong>${escapeHtml(user.name)}</strong><small>${form.mutes[user.id] ? 'Muted' : `${Math.round((form.volumes[user.id] || 1) * 100)}% volume`}</small></div><label class="switch"><span class="sr-only">Mute ${escapeHtml(user.name)}</span><input type="checkbox" data-speaker-mute="${escapeHtml(user.id)}" ${form.mutes[user.id] ? 'checked' : ''}><i></i></label><label class="volume"><span class="sr-only">${escapeHtml(user.name)} volume</span><input type="range" min="0.5" max="2" step="0.05" value="${form.volumes[user.id] || 1}" data-speaker-volume="${escapeHtml(user.id)}" ${form.mutes[user.id] ? 'disabled' : ''}></label></div>`).join('');
  return `<div class="timeline"><img src="${escapeHtml(clip.current_revision?.waveform_url || '')}" alt="Audio waveform"><div class="trim-shade before"></div><div class="trim-shade after"></div><button class="trim-handle start" data-trim-handle="start" type="button" role="slider" aria-label="Trim start" aria-valuemin="0" aria-valuemax="${clip.duration}"></button><button class="trim-handle end" data-trim-handle="end" type="button" role="slider" aria-label="Trim end" aria-valuemin="0" aria-valuemax="${clip.duration}"></button></div><div class="trim-controls"><label>Start <span id="startValue">${form.start.toFixed(1)}s</span><input id="trimStart" type="range" min="0" max="${clip.duration}" step="0.1" value="${form.start}"></label><label>End <span id="endValue">${form.end.toFixed(1)}s</span><input id="trimEnd" type="range" min="0" max="${clip.duration}" step="0.1" value="${form.end}"></label></div><div class="speaker-list">${speakers}</div>`;
}
async function renderEditor(clipId) {
  elements.view.innerHTML = skeleton(3);
  let clip;
  try { clip = await routeFetch(`/api/clips/${encodeURIComponent(clipId)}/metadata`); }
  catch (error) { if (error.status === 403 || error.status === 404) return accessDenied(); throw error; }
  const server = currentServer(clip.guild_id); if (!server) return accessDenied();
  state.server = server; localStorage.setItem('clipthat.lastServer', server.id); renderShell();
  const form = editState(clip);
  elements.view.innerHTML = `<a class="back-link" href="${navUrl('library')}" data-route>&larr; Back to library</a><section class="editor-head"><div><p class="eyebrow">CLIP EDITOR</p><div class="editable-title"><h1>${escapeHtml(clip.title)}</h1>${clip.capabilities.canRename ? '<button class="text-action" data-action="rename" type="button">Rename</button>' : ''}</div><p>${escapeHtml(clip.users_involved.map(user => user.name).join(', ') || 'No voices currently included')} · ${formatDuration(clip.duration)} · ${escapeHtml(relativeTime(clip.created_at))}</p></div><button class="button secondary" data-action="play" data-clip-id="${escapeHtml(clip.id)}" type="button">Play saved clip</button></section>${clip.my_participation?.source_present ? `<section class="privacy-card"><div><h2>Your voice in this clip</h2><p>${clip.my_participation.audible ? 'Your voice is currently audible.' : 'Your voice is not audible in this cut.'} Removing yourself updates every shared revision. Adding yourself creates a separate personal cut and never changes this original.</p></div><div class="editor-actions">${clip.my_participation.can_remove ? '<button class="button danger-button" data-action="remove-self" type="button">Remove my voice</button>' : ''}${clip.my_participation.can_clone ? '<button class="button secondary" data-action="clone-self" type="button">Add me in a new cut</button>' : ''}</div></section>` : ''}<section class="editor-card"><div class="editor-status"><div><h2>Mix and timing</h2><p id="dirtyMessage">Saved revision ${clip.current_revision?.revision_number ?? 0}</p></div><span id="dirtyPill" class="saved-pill">Saved</span></div>${clip.capabilities.canEditAudio ? editorForm(clip, form) : '<div class="empty-panel"><p>You can play and rename this clip. Only its creator or a bot admin can change the audio.</p></div>'}<div class="editor-actions">${clip.capabilities.canEditAudio ? '<button class="button secondary" data-action="reset-edit" type="button">Reset unsaved</button><button class="button secondary" data-action="preview-edit" type="button">Preview unsaved</button><button class="button" data-action="save-edit" type="button">Save revision</button>' : ''}${clip.capabilities.canDelete ? '<button class="button danger-button" data-action="trash" type="button">Move to trash</button>' : ''}${clip.capabilities.canRestore ? '<button class="button" data-action="restore" type="button">Restore clip</button>' : ''}</div></section>${clip.capabilities.canViewRevisions ? '<section class="revision-card"><button class="revision-toggle" data-action="load-revisions" type="button"><span><strong>Revision history</strong><small>Play or restore earlier versions</small></span><b>&darr;</b></button><div id="revisionList"></div></section>' : ''}`;
  state.editor = { clip, saved:editState(clip), form };
  markDirty();
}
function markDirty() {
  const editor = state.editor; if (!editor) return;
  const dirty = JSON.stringify(editor.saved) !== JSON.stringify(editor.form);
  const message = document.getElementById('dirtyMessage'), pill = document.getElementById('dirtyPill');
  if (message) message.textContent = dirty ? 'Unsaved audio changes' : `Saved revision ${editor.clip.current_revision?.revision_number ?? 0}`;
  if (pill) { pill.textContent = dirty ? 'Unsaved' : 'Saved'; pill.classList.toggle('dirty', dirty); }
  const timeline = elements.view.querySelector('.timeline'); if (timeline) {
    timeline.style.setProperty('--trim-start', `${editor.form.start / editor.clip.duration * 100}%`); timeline.style.setProperty('--trim-end', `${editor.form.end / editor.clip.duration * 100}%`);
    for (const kind of ['start','end']) { const handle = timeline.querySelector(`[data-trim-handle="${kind}"]`), value = editor.form[kind]; if (handle) { handle.setAttribute('aria-valuenow', value.toFixed(1)); handle.setAttribute('aria-valuetext', `${value.toFixed(1)} seconds`); } }
  }
}
function editPayload() { const { clip, form } = state.editor; return { start_trim:form.start, end_trim:form.end, user_mutes:form.mutes, user_volumes:form.volumes, base_revision_id:clip.current_revision_id }; }

async function renderManage() {
  if (!state.server.capabilities.canManage) return accessDenied();
  elements.view.innerHTML = skeleton(3);
  const settings = await routeFetch(`/api/settings/${encodeURIComponent(state.server.id)}`);
  let channels = [], admins = null;
  let channelsError = null, adminsError = null;
  try { ({ channels } = await routeFetch(`/api/discord/${encodeURIComponent(state.server.id)}/channels`)); } catch (error) { if (error.code !== 'REQUEST_ABORTED') channelsError = error.message; else throw error; }
  if (state.server.capabilities.isOwner) { try { ({ admins } = await routeFetch(`/api/admins/${encodeURIComponent(state.server.id)}`)); } catch (error) { if (error.code !== 'REQUEST_ABORTED') adminsError = error.message; else throw error; } }
  const percent = Math.min(100, settings.storage_quota_bytes ? settings.storage_used_bytes / settings.storage_quota_bytes * 100 : 0);
  const onboarding = !settings.onboarding_completed_at ? '<div class="onboarding-note"><span>1 minute setup</span><strong>Review where clips go and how voice consent works.</strong><p>Saving these settings completes setup. You can change them at any time.</p></div>' : '';
  const ownerTools = state.server.capabilities.isOwner ? `<section class="manage-card danger-zone"><div><h2>Server data</h2><p>Export metadata anytime. Permanent deletion removes clips, revisions, preferences, activity, and delegated admins.</p></div><a class="button secondary" href="/api/servers/${encodeURIComponent(state.server.id)}/export" download>Export metadata</a><button class="button danger-button" data-action="erase-server-data" type="button">Permanently erase server data</button></section>` : '';
  const channelNotice = channelsError ? `<p class="inline-error">Channels could not be refreshed: ${escapeHtml(channelsError)}</p>` : '';
  const adminNotice = adminsError ? `<p class="inline-error">Admins could not be refreshed: ${escapeHtml(adminsError)}</p>` : '';
  elements.view.innerHTML = `<section class="page-heading"><p class="eyebrow">SERVER CONTROL</p><h1>Manage ${escapeHtml(state.server.name)}</h1><p>Recording, retention, privacy, and delegated access in one place.</p></section>${onboarding}<div class="manage-grid"><form id="settingsForm" class="manage-card"><div><h2>Recording settings</h2><p>Changes apply to future clips.</p></div>${channelNotice}<label>Clips channel<select id="clipsChannel"><option value="">Use the default channel</option>${channels.map(channel => `<option value="${escapeHtml(channel.id)}" ${channel.id === settings.clips_channel_id ? 'selected' : ''}>#${escapeHtml(channel.name)}</option>`).join('')}</select></label><label>Voice consent<select id="consentMode"><option value="notice" ${settings.consent_mode === 'notice' ? 'selected' : ''}>Visible notice with opt-out</option><option value="explicit" ${settings.consent_mode === 'explicit' ? 'selected' : ''}>Explicit opt-in only</option></select><small>A notice is posted whenever recording starts. Members can always use /privacy block.</small></label><label>Rolling buffer<select id="bufferMinutes">${[15,20,25,30].map(value => `<option value="${value}" ${value === settings.buffer_size_minutes ? 'selected' : ''}>${value} minutes</option>`).join('')}</select></label><label>Clip retention<input id="retentionDays" type="number" min="1" max="3650" value="${settings.retention_days || 90}"><small>Favorited clips do not expire automatically.</small></label><button class="button" type="submit">${settings.onboarding_completed_at ? 'Save settings' : 'Save and finish setup'}</button></form><section class="manage-card"><div><h2>Storage</h2><p>${formatBytes(settings.storage_used_bytes)} of ${formatBytes(settings.storage_quota_bytes)} used.</p></div><progress class="storage-meter" aria-label="Server storage used" max="100" value="${percent}">${Math.round(percent)}%</progress><small>Old trash is removed after 30 days. Favorited clips remain until deliberately trashed.</small></section>${admins ? `<section class="manage-card"><div><h2>Bot admins</h2><p>Delegated admins do not need a Discord role.</p></div>${adminNotice}<form id="adminForm" class="inline-form"><label><span class="sr-only">Discord user ID</span><input id="adminId" inputmode="numeric" pattern="[0-9]{17,20}" placeholder="Discord user ID" required></label><button class="button" type="submit">Add</button></form><div id="adminList" class="admin-list">${admins.length ? admins.map(admin => `<div><span><strong>${escapeHtml(admin.user_id)}</strong><small>Added ${escapeHtml(relativeTime(admin.created_at))}</small></span><button class="icon-control danger-icon" data-remove-admin="${escapeHtml(admin.user_id)}" type="button" aria-label="Remove admin">&times;</button></div>`).join('') : '<p class="empty-copy">No delegated admins.</p>'}</div></section>` : adminNotice}${ownerTools}</div>`;
}
function accessDenied() { elements.view.innerHTML = `<section class="denied"><span>403</span><h1>This area is private.</h1><p>Your Discord account does not have access to this server or action.</p><a class="button" href="/" data-route>Return to your servers</a></section>`; }

function playClip(clip) {
  state.audioClip = clip; elements.player.hidden = false; elements.playerTitle.textContent = clip.title; elements.playerServer.textContent = currentServer(clip.guild_id)?.name || '';
  if (elements.persistentAudio.src !== new URL(clip.audio_url, location.href).href) elements.persistentAudio.src = clip.audio_url;
  elements.persistentAudio.play().catch(error => toast(error.message, 'error'));
}
async function renderRoute() {
  if (!state.me) return showWelcome();
  state.routeController?.abort(); state.libraryController?.abort();
  state.routeController = new AbortController();
  const target = route();
  if (target.type === 'root') {
    const preferred = localStorage.getItem('clipthat.lastServer'); const server = currentServer(preferred) || state.servers.installed[0];
    if (server) return go(`/servers/${encodeURIComponent(server.id)}/home`, { replace:true, force:true });
    elements.appShell.hidden = false; elements.welcome.hidden = true; state.server = null; renderShell();
    elements.view.innerHTML = `<section class="denied"><span>CT</span><h1>Add your first server.</h1><p>You can add ClipThat to Discord servers where you have Manage Server permission.</p><button class="button" data-action="open-servers" type="button">Choose a server</button></section>`; return;
  }
  if (target.type === 'clip') { renderShell(); try { await renderEditor(target.clipId); } catch (error) { toast(error.message, 'error'); } return; }
  const server = currentServer(target.guildId); if (!server) { renderShell(); return accessDenied(); }
  state.server = server; localStorage.setItem('clipthat.lastServer', server.id); renderShell();
  try {
    if (target.view === 'home') await renderHome();
    else if (target.view === 'library' || target.view === 'favorites') await renderLibrary(target.view);
    else if (target.view === 'manage') await renderManage();
    else await go(navUrl('home'), { replace:true, force:true });
    elements.view.focus({ preventScroll:true });
  } catch (error) {
    if (error.code === 'REQUEST_ABORTED') return;
    if (error.status === 401) elements.view.innerHTML = `<div class="empty-panel wide"><h2>Your session ended</h2><p>Sign in again to continue.</p><a class="button" href="/api/auth/login?return_to=${encodeURIComponent(location.pathname)}">Continue with Discord</a></div>`;
    else if (error.status === 403 || error.status === 404) accessDenied();
    else elements.view.innerHTML = `<div class="empty-panel wide"><h2>Could not load this view</h2><p>${escapeHtml(error.message)}</p><button class="button secondary" data-action="retry-route" type="button">Try again</button></div>`;
    if (error.status !== 401) toast(error.message, 'error');
  }
}

async function clipAction(button) {
  const card = button.closest('[data-clip-id]'); const id = card?.dataset.clipId || state.editor?.clip.id; const clip = state.clips.find(item => item.id === id) || state.overview?.recent.find(item => item.id === id) || state.overview?.favorites.find(item => item.id === id) || state.editor?.clip;
  if (button.dataset.action === 'play') return playClip(clip);
  if (button.dataset.action === 'rename') {
    const title = await requestText('Rename clip', 'Clip title', clip.title, 'Save name'); if (title == null || title.trim() === clip.title) return;
    const old = clip.title; clip.title = title.trim(); if (card) card.querySelector('h3').textContent = clip.title; else elements.view.querySelector('.editable-title h1').textContent = clip.title;
    try { Object.assign(clip, await apiFetch(`/api/clips/${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify({ title:clip.title }) })); toast('Clip renamed.'); }
    catch (error) { clip.title = old; toast(error.message, 'error'); renderRoute(); }
  }
  if (button.dataset.action === 'favorite') {
    const old = clip.favorited; clip.favorited = !old; button.classList.toggle('selected', clip.favorited); button.innerHTML = clip.favorited ? '&#9733;' : '&#9734;';
    try { Object.assign(clip, await apiFetch(`/api/clips/${encodeURIComponent(id)}/favorite`, { method:'POST', body:JSON.stringify({ favorited:clip.favorited }) })); }
    catch (error) { clip.favorited = old; button.classList.toggle('selected', old); button.innerHTML = old ? '&#9733;' : '&#9734;'; throw error; }
  }
  if (button.dataset.action === 'trash') {
    if (!await confirmAction('Move clip to trash?', 'An admin can restore it for 30 days.', 'Move to trash', true)) return;
    await apiFetch(`/api/clips/${encodeURIComponent(id)}`, { method:'DELETE', body:JSON.stringify({ reason:'dashboard' }) }); toast('Moved to trash.'); await go(navUrl('library'), { force:true });
  }
  if (button.dataset.action === 'restore') { await apiFetch(`/api/clips/${encodeURIComponent(id)}/restore`, { method:'POST', body:'{}' }); toast('Clip restored.'); await go(navUrl('library'), { force:true }); }
  if (button.dataset.action === 'remove-self') {
    if (!await confirmAction('Remove your voice?', 'This updates every shared revision and replaces the posted audio. Copies already downloaded cannot be recalled.', 'Remove my voice', true)) return;
    const updated = await apiFetch(`/api/clips/${encodeURIComponent(id)}/participants/me/remove`, { method:'POST', body:'{}' });
    Object.assign(clip, updated); toast('Your voice was removed.'); await renderRoute();
  }
  if (button.dataset.action === 'clone-self') {
    const data = await apiFetch(`/api/clips/${encodeURIComponent(id)}/participants/me/clone`, { method:'POST', body:'{}' });
    toast(data.existing ? 'Opened your existing personal cut.' : 'Your personal cut is ready.'); await go(`/clips/${encodeURIComponent(data.clip.id)}`, { force:true });
  }
}

function setTrim(kind, rawValue) {
  const editor = state.editor; if (!editor) return;
  const duration = editor.clip.duration, value = Math.round(Number(rawValue) * 10) / 10;
  editor.form[kind] = kind === 'start' ? Math.max(0, Math.min(value, editor.form.end - .1)) : Math.min(duration, Math.max(value, editor.form.start + .1));
  const input = document.getElementById(kind === 'start' ? 'trimStart' : 'trimEnd');
  const output = document.getElementById(kind === 'start' ? 'startValue' : 'endValue');
  if (input) input.value = editor.form[kind]; if (output) output.textContent = `${editor.form[kind].toFixed(1)}s`;
  markDirty();
}

let draggingTrim = null;
function trimFromPointer(event) {
  const timeline = elements.view.querySelector('.timeline'); if (!timeline || !draggingTrim) return;
  const rect = timeline.getBoundingClientRect();
  setTrim(draggingTrim, (Math.max(rect.left, Math.min(event.clientX, rect.right)) - rect.left) / rect.width * state.editor.clip.duration);
}

document.addEventListener('click', async event => {
  const routeLink = event.target.closest('[data-route]');
  if (routeLink) { event.preventDefault(); document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); await go(routeLink.getAttribute('href')); return; }
  const button = event.target.closest('button, [data-action]'); if (!button) return;
  try {
    if (button.dataset.action === 'retry-app') return await init();
    if (button.dataset.action === 'retry-route') return await renderRoute();
    if (button.id === 'loadMore') return await withButton(button, 'Loading…', () => loadClips(route().view));
    if (button.dataset.action === 'logout') { await withButton(button, 'Signing out…', () => apiFetch('/api/auth/logout', { method:'POST', body:'{}' })); location.assign('/'); }
    else if (button.dataset.action === 'open-servers') serverPicker();
    else if (['play','rename','favorite','trash','restore','remove-self','clone-self'].includes(button.dataset.action)) {
      const labels = { rename:'Renaming…', favorite:'Saving…', trash:'Moving…', restore:'Restoring…', 'remove-self':'Removing voice…', 'clone-self':'Creating cut…' };
      if (button.dataset.action === 'play') await clipAction(button);
      else if (button.dataset.action === 'favorite') { button.disabled = true; try { await clipAction(button); } finally { button.disabled = false; } }
      else await withButton(button, labels[button.dataset.action], () => clipAction(button));
    }
    else if (button.dataset.action === 'show-active' || button.dataset.action === 'show-trash') { state.trash = button.dataset.action === 'show-trash'; renderLibrary('library'); }
    else if (button.dataset.action === 'reset-edit') { state.editor.form = structuredClone(state.editor.saved); await renderEditor(state.editor.clip.id); }
    else if (button.dataset.action === 'preview-edit') await withButton(button, 'Rendering preview…', async () => { const data = await apiFetch(`/api/clips/${encodeURIComponent(state.editor.clip.id)}/previews`, { method:'POST', body:JSON.stringify(editPayload()), timeout:120_000 }); playClip({ ...state.editor.clip, audio_url:data.preview_url, title:`${state.editor.clip.title} · Preview` }); });
    else if (button.dataset.action === 'save-edit') await withButton(button, 'Saving revision…', async () => { const data = await apiFetch(`/api/clips/${encodeURIComponent(state.editor.clip.id)}/revisions`, { method:'POST', body:JSON.stringify(editPayload()), timeout:180_000 }); toast('New revision saved.'); state.editor = null; await renderEditor(data.clip.id); });
    else if (button.dataset.action === 'load-revisions') { const list = document.getElementById('revisionList'); if (list.innerHTML) { list.innerHTML = ''; return; } const data = await apiFetch(`/api/clips/${encodeURIComponent(state.editor.clip.id)}/revisions`); list.innerHTML = data.revisions.map(revision => `<div class="revision-row"><div><strong>Revision ${revision.revision_number}</strong><small>${escapeHtml(relativeTime(revision.created_at))} · ${formatDuration(revision.end_trim - revision.start_trim)}</small></div><div><button class="button secondary" data-revision-play="${escapeHtml(revision.audio_url)}" type="button">Play</button>${revision.id !== data.current_revision_id ? `<button class="button secondary" data-revision-restore="${revision.id}" type="button">Restore</button>` : '<span class="current-label">Current</span>'}</div></div>`).join(''); }
    else if (button.dataset.revisionPlay) playClip({ ...state.editor.clip, audio_url:button.dataset.revisionPlay, title:`${state.editor.clip.title} · Earlier revision` });
    else if (button.dataset.revisionRestore) { if (!await confirmAction('Restore this revision?', 'This changes the playable revision but keeps the newer history.', 'Restore revision')) return; await withButton(button, 'Restoring…', async () => { await apiFetch(`/api/clips/${encodeURIComponent(state.editor.clip.id)}/revisions/${encodeURIComponent(button.dataset.revisionRestore)}/restore`, { method:'POST', body:'{}' }); toast('Revision restored.'); state.editor = null; await renderEditor(state.editor?.clip.id || route().clipId); }); }
    else if (button.dataset.install) { const data = await apiFetch(`/api/discord/${encodeURIComponent(button.dataset.install)}/install-url`); window.open(data.url, '_blank', 'noopener,noreferrer'); toast('Finish adding ClipThat in Discord. This page will detect it automatically.'); void waitForInstall(button.dataset.install, button).catch(error => { button.disabled = false; toast(error.message, 'error'); }); }
    else if (button.dataset.action === 'erase-server-data') {
      const typed = await requestText('Confirm permanent deletion', `Type ${state.server.id} to continue`, '', 'Check server ID');
      if (typed == null) return;
      if (typed.trim() !== state.server.id) throw new Error('The server ID did not match. Nothing was deleted.');
      if (!await confirmAction('Permanently erase server data?', 'This removes every clip, revision, preference, activity record, and delegated admin. It cannot be undone.', 'Erase permanently', true)) return;
      await withButton(button, 'Erasing…', () => apiFetch(`/api/servers/${encodeURIComponent(state.server.id)}/data`, { method:'DELETE', body:JSON.stringify({ confirmation:typed.trim() }), timeout:120_000 }));
      toast('Server clip data was permanently erased.'); await renderManage();
    }
    else if (button.dataset.removeAdmin) { await apiFetch(`/api/admins/${encodeURIComponent(state.server.id)}/${encodeURIComponent(button.dataset.removeAdmin)}`, { method:'DELETE', body:'{}' }); renderManage(); }
  } catch (error) { if (error.code !== 'REQUEST_ABORTED') toast(error.message, 'error'); button.disabled = false; }
});

elements.view.addEventListener('input', event => {
  if (event.target.id === 'clipSearch') { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => { state.search = event.target.value.trim(); loadClips(route().view, true).catch(error => { if (error.code !== 'REQUEST_ABORTED') toast(error.message, 'error'); }); }, 260); }
  if (!state.editor) return;
  if (event.target.id === 'trimStart') { state.editor.form.start = Math.min(Number(event.target.value), state.editor.form.end - .1); event.target.value = state.editor.form.start; document.getElementById('startValue').textContent = `${state.editor.form.start.toFixed(1)}s`; markDirty(); }
  if (event.target.id === 'trimEnd') { state.editor.form.end = Math.max(Number(event.target.value), state.editor.form.start + .1); event.target.value = state.editor.form.end; document.getElementById('endValue').textContent = `${state.editor.form.end.toFixed(1)}s`; markDirty(); }
  if (event.target.dataset.speakerVolume) { state.editor.form.volumes[event.target.dataset.speakerVolume] = Number(event.target.value); event.target.closest('.speaker-control').querySelector('small').textContent = `${Math.round(Number(event.target.value) * 100)}% volume`; markDirty(); }
  if (event.target.dataset.speakerMute) { const id = event.target.dataset.speakerMute; state.editor.form.mutes[id] = event.target.checked; const row = event.target.closest('.speaker-control'); row.querySelector('[data-speaker-volume]').disabled = event.target.checked; row.querySelector('small').textContent = event.target.checked ? 'Muted' : `${Math.round((state.editor.form.volumes[id] || 1) * 100)}% volume`; markDirty(); }
});
elements.view.addEventListener('pointerdown', event => { const handle = event.target.closest('[data-trim-handle]'); if (!handle) return; draggingTrim = handle.dataset.trimHandle; handle.setPointerCapture?.(event.pointerId); trimFromPointer(event); event.preventDefault(); });
window.addEventListener('pointermove', event => { if (draggingTrim) trimFromPointer(event); });
window.addEventListener('pointerup', () => { draggingTrim = null; });
elements.view.addEventListener('keydown', event => {
  const handle = event.target.closest('[data-trim-handle]'); if (!handle || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const kind = handle.dataset.trimHandle, current = state.editor.form[kind];
  setTrim(kind, event.key === 'Home' ? 0 : event.key === 'End' ? state.editor.clip.duration : current + (event.key === 'ArrowLeft' ? -.1 : .1));
  event.preventDefault();
});
elements.view.addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  try {
    if (event.target.id === 'settingsForm') { await withButton(button, 'Saving…', () => apiFetch(`/api/settings/${encodeURIComponent(state.server.id)}`, { method:'POST', body:JSON.stringify({ clips_channel_id:document.getElementById('clipsChannel').value, consent_mode:document.getElementById('consentMode').value, buffer_size_minutes:Number(document.getElementById('bufferMinutes').value), retention_days:Number(document.getElementById('retentionDays').value), complete_onboarding:true }) })); toast('Settings saved.'); await renderManage(); }
    if (event.target.id === 'adminForm') { await withButton(button, 'Adding…', () => apiFetch(`/api/admins/${encodeURIComponent(state.server.id)}`, { method:'POST', body:JSON.stringify({ user_id:document.getElementById('adminId').value }) })); toast('Bot admin added.'); await renderManage(); }
  } catch (error) { toast(error.message, 'error'); }
});

elements.openServerPicker.onclick = serverPicker; elements.mobileServerPicker.onclick = serverPicker; elements.accountButton.onclick = accountDialog;
document.querySelectorAll('[data-close-dialog]').forEach(button => button.onclick = () => button.closest('dialog').close());
elements.renameForm.addEventListener('submit', event => {
  event.preventDefault();
  const resolve = state.textResolve; state.textResolve = null;
  elements.renameDialog.close(); resolve?.(elements.renameInput.value.trim());
});
elements.renameDialog.addEventListener('close', () => { const resolve = state.textResolve; state.textResolve = null; resolve?.(null); });
elements.confirmDialog.addEventListener('click', event => {
  const button = event.target.closest('[data-confirm-value]'); if (!button) return;
  const resolve = state.confirmResolve; state.confirmResolve = null;
  elements.confirmDialog.close(); resolve?.(button.dataset.confirmValue === 'true');
});
elements.confirmDialog.addEventListener('cancel', event => { event.preventDefault(); const resolve = state.confirmResolve; state.confirmResolve = null; elements.confirmDialog.close(); resolve?.(false); });
document.addEventListener('submit', async event => {
  if (event.target.id !== 'devLoginForm') return;
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  try { await withButton(button, 'Signing in…', () => apiFetch('/api/auth/dev', { method:'POST', body:JSON.stringify({ code:document.getElementById('devLoginCode').value.trim() }) })); location.reload(); }
  catch (error) { toast(error.message, 'error'); }
});
window.addEventListener('popstate', renderRoute);
window.addEventListener('beforeunload', event => { if (editorDirty()) { event.preventDefault(); event.returnValue = ''; } });
elements.theme.onclick = () => { const light = !document.body.classList.contains('light'); document.body.classList.toggle('light', light); localStorage.setItem('clipthat.theme', light ? 'light' : 'dark'); };
document.body.classList.toggle('light', localStorage.getItem('clipthat.theme') === 'light');
elements.playerToggle.onclick = () => elements.persistentAudio.paused ? elements.persistentAudio.play() : elements.persistentAudio.pause();
elements.playerClose.onclick = () => { elements.persistentAudio.pause(); elements.player.hidden = true; state.audioClip = null; };
elements.persistentAudio.onplay = () => { elements.playerToggle.innerHTML = '&#10074;&#10074;'; elements.playerToggle.setAttribute('aria-label', 'Pause'); };
elements.persistentAudio.onpause = () => { elements.playerToggle.innerHTML = '&#9654;'; elements.playerToggle.setAttribute('aria-label', 'Play'); };
elements.persistentAudio.onerror = () => toast('This audio could not be loaded. It may still be rendering or your session may have ended.', 'error');
elements.persistentAudio.ontimeupdate = () => { const audio = elements.persistentAudio; elements.playerSeek.value = audio.duration ? audio.currentTime / audio.duration * 100 : 0; elements.playerTime.textContent = `${formatDuration(audio.currentTime)} / ${formatDuration(audio.duration)}`; };
elements.playerSeek.oninput = () => { if (elements.persistentAudio.duration) elements.persistentAudio.currentTime = Number(elements.playerSeek.value) / 100 * elements.persistentAudio.duration; };

async function init() {
  const me = await apiFetch('/api/auth/me');
  state.me = me; setCsrfToken(me?.csrfToken);
  if (me) state.servers = await apiFetch('/api/servers');
  else { state.mode = await apiFetch('/api/auth/mode'); setCsrfToken(state.mode.csrfToken); }
  await renderRoute();
}
init().catch(error => { if (error.code !== 'REQUEST_ABORTED') showStartupError(error); });

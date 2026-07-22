const clipId = new URLSearchParams(location.search).get('clip_id');
const status = document.querySelector('#status'), editor = document.querySelector('#editor'), audio = document.querySelector('#audio');
let clip = null, savedState = null;
setupTheme();

function number(selector) { return Number(document.querySelector(selector).value); }
function collectState() {
  const userMutes = {}, userVolumes = {};
  document.querySelectorAll('.speaker').forEach(element => { userMutes[element.dataset.id] = !element.querySelector('.include').checked; userVolumes[element.dataset.id] = Number(element.querySelector('.volume').value); });
  return { start_trim: number('#start'), end_trim: number('#end'), user_mutes: userMutes, user_volumes: userVolumes };
}
function statesEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function sync() {
  const end = document.querySelector('#end');
  if (number('#end') <= number('#start')) end.value = Math.min(clip.duration, number('#start') + 0.1);
  document.querySelector('#startValue').textContent = `${number('#start').toFixed(1)}s`; document.querySelector('#endValue').textContent = `${number('#end').toFixed(1)}s`;
  const dirty = !statesEqual(collectState(), savedState), badge = document.querySelector('#dirtyState');
  badge.textContent = dirty ? 'Unsaved changes' : `Revision ${clip.current_revision?.revision_number ?? 0} saved`; badge.classList.toggle('dirty', dirty); document.querySelector('#reset').disabled = !dirty;
}
function applyState(state) {
  document.querySelector('#start').value = state.start_trim; document.querySelector('#end').value = state.end_trim;
  document.querySelectorAll('.speaker').forEach(element => { element.querySelector('.include').checked = !state.user_mutes[element.dataset.id]; element.querySelector('.volume').value = state.user_volumes[element.dataset.id] ?? 1; element.querySelector('.volumeValue').textContent = `${Number(element.querySelector('.volume').value).toFixed(1)}×`; }); sync();
}
function bindControls() { document.querySelectorAll('#start, #end, .include, .volume').forEach(input => input.addEventListener('input', () => { if (input.classList.contains('volume')) input.closest('.speaker').querySelector('.volumeValue').textContent = `${Number(input.value).toFixed(1)}×`; sync(); })); }

async function preview() {
  const button = document.querySelector('#preview'); setLoading(button, true, 'Rendering preview…');
  try { const result = await apiFetch(`/api/clips/${encodeURIComponent(clipId)}/previews`, { method: 'POST', body: JSON.stringify(collectState()) }); audio.src = `${result.preview_url}?t=${Date.now()}`; await audio.play(); showToast('Playing the unsaved preview.'); }
  catch (error) { showToast(error.message, 'error'); } finally { setLoading(button, false); }
}
async function saveRevision() {
  const button = document.querySelector('#save'); setLoading(button, true, 'Saving revision…');
  try {
    const result = await apiFetch(`/api/clips/${encodeURIComponent(clipId)}/revisions`, { method: 'POST', body: JSON.stringify({ ...collectState(), base_revision_id: clip.current_revision_id }) });
    clip = result.clip; savedState = collectState(); audio.src = `${result.revision.audio_url}?t=${Date.now()}`; sync(); showToast(`Revision ${result.revision.revision_number} saved.`, 'success'); if (clip.capabilities.canViewRevisions) loadRevisions();
  } catch (error) { showToast(error.status === 409 ? 'Someone saved a newer revision. Reload this page before trying again.' : error.message, 'error'); }
  finally { setLoading(button, false); }
}

async function loadRevisions() {
  const data = await apiFetch(`/api/clips/${encodeURIComponent(clipId)}/revisions`), container = document.querySelector('#revisions');
  container.innerHTML = data.revisions.map(revision => `<article class="revision-row ${revision.id === data.current_revision_id ? 'current' : ''}"><div><strong>Revision ${revision.revision_number}${revision.id === data.current_revision_id ? ' · Current' : ''}</strong><span class="muted">${escapeHtml(new Date(revision.created_at).toLocaleString())} by ${escapeHtml(revision.created_by)}</span><span class="muted">${revision.start_trim.toFixed(1)}s–${revision.end_trim.toFixed(1)}s</span></div><div class="actions"><button class="quiet play-revision" data-url="${escapeHtml(revision.audio_url)}" type="button">Play</button>${revision.id === data.current_revision_id ? '' : `<button class="restore-revision" data-id="${revision.id}" type="button">Restore</button>`}</div></article>`).join('') || '<div class="empty">No revisions found.</div>';
  container.querySelectorAll('.play-revision').forEach(button => button.onclick = () => { audio.src = `${button.dataset.url}?t=${Date.now()}`; audio.play(); });
  container.querySelectorAll('.restore-revision').forEach(button => button.onclick = async () => {
    if (!confirm('Make this older revision current? Newer revisions will remain in history.')) return;
    try { clip = await apiFetch(`/api/clips/${encodeURIComponent(clipId)}/revisions/${button.dataset.id}/restore`, { method: 'POST' }); savedState = { start_trim: clip.start_trim, end_trim: clip.end_trim, user_mutes: clip.user_mutes, user_volumes: clip.user_volumes }; applyState(savedState); audio.src = `${clip.audio_url}&t=${Date.now()}`; await loadRevisions(); showToast('Revision restored.', 'success'); }
    catch (error) { showToast(error.message, 'error'); }
  });
}

async function init() {
  if (!clipId) { status.textContent = 'No clip was selected.'; return; }
  try { clip = await apiFetch(`/api/clips/${encodeURIComponent(clipId)}/metadata`); }
  catch (error) { status.textContent = error.status === 401 ? 'Please sign in first.' : error.message || 'Clip unavailable.'; return; }
  document.title = `${clip.title} · ClipThat`; document.querySelector('#titleInput').value = clip.title;
  document.querySelector('#titleForm').onsubmit = async event => {
    event.preventDefault();
    try { clip = await apiFetch(`/api/clips/${encodeURIComponent(clipId)}`, { method: 'PATCH', body: JSON.stringify({ title: document.querySelector('#titleInput').value }) }); document.querySelector('#titleInput').value = clip.title; document.title = `${clip.title} · ClipThat`; showToast('Clip renamed.', 'success'); }
    catch (error) { showToast(error.message, 'error'); }
  };
  document.querySelector('#users').innerHTML = clip.users_involved.map(user => `<article class="speaker" data-id="${escapeHtml(user.id)}"><strong>${escapeHtml(user.name)}</strong><label class="check"><input class="include" type="checkbox"> Include in mix</label><label>Volume <output class="volumeValue">1.0×</output><input class="volume" type="range" min="0.5" max="2" step="0.1"></label></article>`).join('');
  document.querySelector('#start').max = clip.duration; document.querySelector('#end').max = clip.duration;
  savedState = { start_trim: clip.start_trim, end_trim: clip.end_trim ?? clip.duration, user_mutes: clip.user_mutes, user_volumes: clip.user_volumes };
  applyState(savedState); bindControls(); audio.src = clip.audio_url;
  document.querySelector('#reset').onclick = () => applyState(savedState); document.querySelector('#preview').onclick = preview; document.querySelector('#save').onclick = saveRevision;
  document.querySelector('#favorite').textContent = clip.favorited ? '★ Favorited' : '☆ Favorite';
  document.querySelector('#favorite').onclick = async () => { try { clip = await apiFetch(`/api/clips/${encodeURIComponent(clipId)}/favorite`, { method: 'POST', body: JSON.stringify({ favorited: !clip.favorited }) }); document.querySelector('#favorite').textContent = clip.favorited ? '★ Favorited' : '☆ Favorite'; } catch (error) { showToast(error.message, 'error'); } };
  document.querySelector('#delete').onclick = async () => { if (!confirm('Move this clip to trash? A bot admin can restore it for 30 days.')) return; try { await apiFetch(`/api/clips/${encodeURIComponent(clipId)}`, { method: 'DELETE', body: JSON.stringify({ reason: 'user' }) }); location = '/'; } catch (error) { showToast(error.message, 'error'); } };
  const mayEdit = clip.capabilities.canEditAudio;
  document.querySelectorAll('#start, #end, .include, .volume, #reset, #preview, #save').forEach(control => { control.disabled = !mayEdit; });
  document.querySelector('#viewOnly').hidden = mayEdit; document.querySelector('#favorite').hidden = !clip.capabilities.canFavorite; document.querySelector('#delete').hidden = !clip.capabilities.canDelete;
  document.querySelector('#titleInput').disabled = !clip.capabilities.canRename; document.querySelector('#titleForm button').hidden = !clip.capabilities.canRename;
  if (clip.capabilities.canViewRevisions) { document.querySelector('#revisionPanel').hidden = false; document.querySelector('#refreshRevisions').onclick = () => loadRevisions().catch(error => showToast(error.message, 'error')); await loadRevisions(); }
  status.textContent = ''; editor.hidden = false;
}

window.addEventListener('beforeunload', event => { if (savedState && !statesEqual(collectState(), savedState)) { event.preventDefault(); event.returnValue = ''; } });
init();

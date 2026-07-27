export const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
export const formatDuration = seconds => { const value = Math.max(0, Math.round(Number(seconds) || 0)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`; };
export const formatBytes = bytes => { const value = Math.max(0, Number(bytes) || 0); if (value < 1024) return `${value} B`; const units = ['KiB','MiB','GiB','TiB']; let size = value, index = -1; do { size /= 1024; index += 1; } while (size >= 1024 && index < units.length - 1); return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[index]}`; };
export const relativeTime = timestamp => { const seconds = Math.round((Number(timestamp) - Date.now()) / 1000), formatter = new Intl.RelativeTimeFormat(undefined, { numeric:'auto' }); const ranges = [[86400,'day'],[3600,'hour'],[60,'minute']]; for (const [size,unit] of ranges) if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit); return formatter.format(seconds, 'second'); };
export const initials = name => String(name || 'Server').split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
export const iconMarkup = server => server.iconUrl ? `<img src="${escapeHtml(server.iconUrl)}" alt="">` : `<span>${escapeHtml(initials(server.name))}</span>`;
export const skeleton = (count = 3) => `<div class="skeleton-grid">${Array.from({ length:count }, () => '<div class="skeleton-card"><i></i><i></i><i></i></div>').join('')}</div>`;

export function clipCard(clip) {
  const speakers = clip.users_involved?.map(speaker => speaker.name).join(', ') || 'No speakers';
  const waveform = clip.current_revision?.waveform_url;
  const menuItems = [
    `<a href="/clips/${encodeURIComponent(clip.id)}" data-route>${clip.capabilities?.canEditAudio ? 'Edit' : 'Open'}</a>`,
    clip.capabilities?.canRename ? '<button data-action="rename" type="button">Rename</button>' : '',
    clip.my_participation?.can_remove ? '<button data-action="remove-self" type="button">Remove me</button>' : '',
    clip.my_participation?.can_clone ? '<button data-action="clone-self" type="button">Add me (new cut)</button>' : '',
    clip.capabilities?.canRestore ? '<button data-action="restore" type="button">Restore</button>' : '',
    clip.capabilities?.canDelete ? '<button class="danger-text" data-action="trash" type="button">Move to trash</button>' : ''
  ].filter(Boolean).join('');
  return `<article class="clip-card" data-clip-id="${escapeHtml(clip.id)}">
    <button class="waveform-play" type="button" data-action="play" aria-label="Play ${escapeHtml(clip.title)}">
      ${waveform ? `<img src="${escapeHtml(waveform)}" loading="lazy" alt="">` : '<span class="wave-placeholder"></span>'}<i>&#9654;</i>
      <span class="clip-duration">${formatDuration(clip.duration)}</span>
    </button>
    <div class="clip-card-copy"><h3>${escapeHtml(clip.title)}</h3><p>${escapeHtml(relativeTime(clip.created_at))} &middot; ${escapeHtml(speakers)}</p></div>
    <div class="clip-menu">
      ${clip.capabilities?.canFavorite ? `<button class="icon-control ${clip.favorited ? 'selected' : ''}" data-action="favorite" type="button" aria-label="${clip.favorited ? 'Remove favorite' : 'Favorite'}">${clip.favorited ? '&#9733;' : '&#9734;'}</button>` : ''}
      ${menuItems ? `<details class="clip-overflow"><summary class="icon-control" aria-label="More actions">&#8230;</summary><div class="clip-overflow-menu">${menuItems}</div></details>` : ''}
    </div>
  </article>`;
}

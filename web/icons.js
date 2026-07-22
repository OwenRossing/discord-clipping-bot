const glyphs = {
  add:'<path d="M12 5v14M5 12h14"/>',
  arrowLeft:'<path d="m15 18-6-6 6-6"/>',
  arrowRight:'<path d="m9 18 6-6-6-6"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  circle:'<circle cx="12" cy="12" r="7"/>',
  chevronDown:'<path d="m6 9 6 6 6-6"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  crown:'<path d="m3 7 4.5 4L12 5l4.5 6L21 7l-2 11H5L3 7Z"/><path d="M5 18h14"/>',
  pause:'<path d="M9 7v10M15 7v10"/>',
  play:'<path class="icon-fill" d="m9 7 10 5-10 5Z"/>',
  search:'<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
  star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
  starFilled:'<path class="icon-fill" d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
  trash:'<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>'
};

export function svgIcon(name, className = '') {
  const glyph = glyphs[name];
  if (!glyph) throw new Error(`Unknown icon: ${name}`);
  return `<svg class="icon ${className}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>`;
}

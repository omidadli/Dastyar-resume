/**
 * Screen-reader announcements outside any component (route changes). One
 * polite live region for the whole app; rapid updates settle first, so only
 * the final text is read (a page that renames itself while loading is read once).
 */
let region: HTMLElement | null = null;
let timer: number | undefined;

export function announce(text: string) {
  if (typeof document === 'undefined' || !document.body) return;
  if (!region || !region.isConnected) {
    region = document.createElement('div');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    region.className = 'sr-only';
    document.body.appendChild(region);
  }
  const el = region;
  window.clearTimeout(timer);
  el.textContent = ''; // the same text twice in a row is still read again
  timer = window.setTimeout(() => {
    el.textContent = text;
  }, 250);
}

/**
 * Copies text, also inside embedded previews: `navigator.clipboard` is
 * blocked in cross-origin iframes without the clipboard-write permission and
 * on plain-http hosts, so fall back to a hidden textarea + execCommand.
 * Must be called from a click handler (user activation).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* permission denied — fall back below */
  }
  const previous = document.activeElement as HTMLElement | null;
  // Inside a modal the focus trap would steal focus from a textarea on <body>.
  const host = (previous?.closest('[role="dialog"]') as HTMLElement | null) || document.body;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  host.appendChild(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    ta.remove();
    previous?.focus?.({ preventScroll: true });
  }
  return ok;
}

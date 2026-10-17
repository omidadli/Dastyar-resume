import { useEffect } from 'react';
import { announce } from './announce';

// The title the page was opened with is read by the screen reader anyway;
// later changes (moving inside the app) are announced.
let opened = false;

/** Sets the browser tab title: «<page> | هویدا» — and announces in-app page changes. */
export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    const full = title ? `${title} | هویدا` : 'هویدا — تحلیل هوشمند رزومه';
    if (document.title === full && opened) return;
    document.title = full;
    if (!opened) {
      opened = true;
      return;
    }
    announce(title || 'هویدا');
  }, [title]);
}

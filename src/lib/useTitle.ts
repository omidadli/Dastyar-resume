import { useEffect } from 'react';

/** Sets the browser tab title: «<page> | هویدا». */
export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} | هویدا` : 'هویدا — تحلیل هوشمند رزومه';
  }, [title]);
}

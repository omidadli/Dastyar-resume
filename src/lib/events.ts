import { useEffect, useRef } from 'react';

/**
 * Tiny in-app event bus so views refresh when something changes elsewhere
 * (a decision in the side panel, an analysis finishing in the background…).
 */
export type DataScope = 'jobs' | 'resumes' | 'talent' | 'org' | 'activity';

type Handler = (detail: { scope: DataScope; jobId?: string }) => void;
const handlers = new Set<Handler>();

export function emitChange(scope: DataScope, jobId?: string) {
  handlers.forEach((h) => h({ scope, jobId }));
}

export function useOnChange(scopes: DataScope[], cb: (detail: { scope: DataScope; jobId?: string }) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  const key = scopes.join(',');
  useEffect(() => {
    const list = key.split(',');
    const h: Handler = (d) => {
      if (list.includes(d.scope)) ref.current(d);
    };
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  }, [key]);
}

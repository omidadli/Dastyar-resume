import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { navigate } from '../src/lib/router';

/** Test entry: mounts the real App into whatever container it is handed. */
export function mount(el: HTMLElement) {
  const root = createRoot(el);
  root.render(<App />);
  return root;
}

// Same router instance as the mounted App, so the test can move between pages.
export { navigate };

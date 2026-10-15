import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { navigate } from '../src/lib/router';
import { setToken } from '../src/lib/api';

/** Test entry: mounts the real App into whatever container it is handed. */
export function mount(el: HTMLElement) {
  const root = createRoot(el);
  root.render(<App />);
  return root;
}

// Same router/session instances as the mounted App, so the test can move
// between pages and sign in the way the app does (a same-window
// localStorage write fires no 'storage' event, exactly like in browsers).
export { navigate, setToken };

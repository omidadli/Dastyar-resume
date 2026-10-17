// --- Runtime polyfills -------------------------------------------------------
// These must be imported before anything else. pdf.js 6 uses
// `Promise.withResolvers` and the bundle also relies on `structuredClone`,
// `Object.hasOwn`, `Array.prototype.at` and `Array.prototype.findLast`, all of
// which are missing on iOS Safari < 15.4 / < 17.4. Without them the app dies
// with a TypeError and shows a blank page — the "does not open on iPhone" bug.
import 'core-js/actual/promise/with-resolvers';
import 'core-js/actual/structured-clone';
import 'core-js/actual/object/has-own';
import 'core-js/actual/array/at';
import 'core-js/actual/array/find-last';
import 'core-js/actual/array/find-last-index';
import 'core-js/actual/string/replace-all';
import 'core-js/actual/array/includes';
import 'core-js/actual/string/starts-with';
import 'core-js/actual/global-this';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

declare global {
  interface Window {
    __hovidaBoot?: { hide: () => void; fail: (message: string) => void };
  }
}

const container = document.getElementById('root');

function bootFailed(message: string) {
  if (window.__hovidaBoot?.fail) {
    window.__hovidaBoot.fail(message);
  } else {
    // Fallback when the inline boot script itself is unavailable.
    console.error(message);
  }
}

try {
  if (!container) throw new Error('ریشه برنامه (#root) در صفحه پیدا نشد.');
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
  // Immediately inform boot watcher that React has initialized
  window.__hovidaBoot?.hide();
} catch (err: any) {
  bootFailed(err?.message || String(err));
}

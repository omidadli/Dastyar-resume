import React from 'react';

/**
 * First Tab stop on every signed-in page: jumps past the sidebar and the top
 * bar to <main id="main">. Hidden until focused. It moves focus itself — a
 * «#main» address would add a history entry for nothing.
 */
export function SkipToMain() {
  return (
    <a
      href="#main"
      onClick={(e) => {
        e.preventDefault();
        document.getElementById('main')?.focus();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:right-3 focus:z-[200] focus:px-4 focus:py-2.5 focus:rounded-control focus:bg-brand-strong focus:text-white focus:text-sm focus:font-bold focus:shadow-lg"
    >
      پرش به محتوای اصلی
    </a>
  );
}

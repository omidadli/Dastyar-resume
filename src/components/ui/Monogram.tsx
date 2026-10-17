import React from 'react';
import { initials } from '../../lib/format';

/**
 * Gender-neutral initials avatar. The tint is derived from the name, so the
 * same person always gets the same calm color — no photos, no guessing.
 */
const TINTS = [
  'bg-[#E8F1EA] text-[#176F30]',
  'bg-[#E6F0F3] text-[#1E5A6B]',
  'bg-[#EFEDE6] text-[#5E5432]',
  'bg-[#ECEBF4] text-[#463F78]',
  'bg-[#F3EAE6] text-[#7A3E25]',
  'bg-[#E9EEF0] text-[#3D4F57]',
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function Monogram({ name, size = 36, className = '' }: { name: string | null | undefined; size?: number; className?: string }) {
  const label = initials(name);
  const tint = TINTS[hash(name || '?') % TINTS.length];
  return (
    <span
      aria-hidden
      className={`inline-flex items-center justify-center rounded-full font-bold shrink-0 select-none ${tint} ${className}`}
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.36)), letterSpacing: '-0.01em' }}
    >
      {label}
    </span>
  );
}

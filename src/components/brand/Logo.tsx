import React, { useId } from 'react';
import { BLOCK, FA, FA_BOX, FA_T, LA, LA_T, LEFT, RIGHT, STAR } from './paths';

type MarkVariant = 'color' | 'flat' | 'white' | 'charcoal' | 'tile';

const MARK_VIEWBOX = '-0.8 -0.5 100 101';

function useSvgId(prefix: string) {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/** Gradient pieces + white star (the brand's primary mark). */
function ColorMarkShapes({ uid }: { uid: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${uid}L`} x1="0" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#1D7A34" />
          <stop offset="0.6" stopColor="#28A045" />
          <stop offset="1" stopColor="#3CC05B" />
        </linearGradient>
        <linearGradient id={`${uid}R`} x1="0.2" y1="1" x2="0.9" y2="0">
          <stop offset="0" stopColor="#3CC05B" />
          <stop offset="0.45" stopColor="#2DAA4B" />
          <stop offset="1" stopColor="#1D7A34" />
        </linearGradient>
        <filter id={`${uid}S`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="-0.6" dy="1.4" stdDeviation="1.6" floodColor="#0E3B1B" floodOpacity="0.28" />
        </filter>
      </defs>
      <path d={LEFT} fill={`url(#${uid}L)`} />
      <path d={RIGHT} fill={`url(#${uid}R)`} />
      <path d={STAR} fill="#FFFFFF" filter={`url(#${uid}S)`} />
    </>
  );
}

export interface MarkProps {
  size?: number;
  variant?: MarkVariant;
  className?: string;
  title?: string;
}

/** HOVIDA mark — two interlocking pieces with a four-point star of clarity. */
export const HovidaMark: React.FC<MarkProps> = ({ size = 32, variant = 'color', className, title }) => {
  const uid = useSvgId('hv');
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true as const };

  if (variant === 'tile') {
    return (
      <svg viewBox="0 0 64 64" width={size} height={size} className={className} {...a11y}>
        <rect width="64" height="64" rx="15" fill="#E8F1EA" />
        <g transform="translate(13.107 12.8) scale(0.384)">
          <path d={LEFT} fill="#23A047" />
          <path d={RIGHT} fill="#23A047" />
          <path d={STAR} fill="#FFFFFF" />
        </g>
      </svg>
    );
  }

  if (variant === 'white' || variant === 'charcoal') {
    const fill = variant === 'white' ? '#FFFFFF' : '#252C28';
    return (
      <svg viewBox={MARK_VIEWBOX} width={size} height={size * 1.01} className={className} {...a11y}>
        <defs>
          <mask id={`${uid}M`}>
            <rect x="-2" y="-2" width="104" height="104" fill="#fff" />
            <path d={STAR} fill="#000" />
          </mask>
        </defs>
        <g mask={`url(#${uid}M)`}>
          <path d={LEFT} fill={fill} />
          <path d={RIGHT} fill={fill} />
        </g>
      </svg>
    );
  }

  return (
    <svg viewBox={MARK_VIEWBOX} width={size} height={size * 1.01} className={className} {...a11y}>
      {variant === 'flat' ? (
        <>
          <path d={LEFT} fill="#2DBA4E" />
          <path d={RIGHT} fill="#2DBA4E" />
          <path d={STAR} fill="#FFFFFF" />
        </>
      ) : (
        <ColorMarkShapes uid={uid} />
      )}
    </svg>
  );
};

export interface LogoProps {
  /** Rendered height in px. */
  height?: number;
  /** Show the Latin «HOVIDA» line under the Persian wordmark. */
  withLatin?: boolean;
  tone?: 'dark' | 'light';
  className?: string;
}

/**
 * Horizontal lockup: mark on the right (first in RTL reading order) and the
 * wordmark on the left — the same composition as public/brand/hovida-lockup.svg.
 */
export const HovidaLogo: React.FC<LogoProps> = ({ height = 36, withLatin = true, tone = 'dark', className }) => {
  const uid = useSvgId('hl');
  const ink = tone === 'dark' ? '#252C28' : '#FFFFFF';
  const [blockW, blockH] = withLatin ? BLOCK : FA_BOX;
  const markScale = blockH / 101;
  const gap = blockH * 0.26;
  const markX = blockW + gap;
  const width = markX + 100 * markScale;
  return (
    <svg
      viewBox={`0 0 ${width.toFixed(2)} ${blockH.toFixed(2)}`}
      height={height}
      width={(height * width) / blockH}
      className={className}
      role="img"
      aria-label="هویدا"
    >
      <path transform={`translate(${FA_T[0]} ${FA_T[1]})`} d={FA} fill={ink} />
      {withLatin && <path transform={`translate(${LA_T[0]} ${LA_T[1]})`} d={LA} fill={ink} opacity={tone === 'dark' ? 0.82 : 0.9} />}
      <g transform={`translate(${(markX + 0.8 * markScale).toFixed(2)} ${(0.5 * markScale).toFixed(2)}) scale(${markScale.toFixed(4)})`}>
        {tone === 'dark' ? (
          <ColorMarkShapes uid={uid} />
        ) : (
          <>
            <path d={LEFT} fill="#FFFFFF" />
            <path d={RIGHT} fill="#FFFFFF" />
            <path d={STAR} fill="#1B8539" />
          </>
        )}
      </g>
    </svg>
  );
};

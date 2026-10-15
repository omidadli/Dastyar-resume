import React from 'react';
import { Loader2, type LucideIcon } from 'lucide-react';
import { Link } from '../../lib/router';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger' | 'danger-soft';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-strong text-white hover:bg-brand-stronger shadow-[0_1px_0_rgba(0,0,0,0.04)] disabled:bg-brand-strong/50',
  secondary: 'bg-surface text-ink border border-line hover:border-line-strong hover:bg-canvas disabled:text-ink-4',
  ghost: 'text-ink-2 hover:bg-line-2 hover:text-ink disabled:text-ink-4',
  soft: 'bg-brand-soft text-brand-stronger hover:bg-[#dcebe0] disabled:opacity-60',
  danger: 'bg-low-ink text-white hover:bg-[#991b1b] disabled:opacity-60',
  'danger-soft': 'text-low-ink hover:bg-low-soft disabled:opacity-60',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-[9px]',
  md: 'h-10 px-4 text-sm gap-2 rounded-control',
  lg: 'h-12 px-5 text-[15px] gap-2 rounded-[12px]',
};

const ICON_SIZES: Record<ButtonSize, string> = { sm: 'w-4 h-4', md: 'w-[18px] h-[18px]', lg: 'w-5 h-5' };

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconEnd?: LucideIcon;
  loading?: boolean;
  block?: boolean;
}

export type ButtonProps = CommonProps & React.ButtonHTMLAttributes<HTMLButtonElement>;

function classes(variant: ButtonVariant, size: ButtonSize, block?: boolean, extra?: string) {
  return [
    'inline-flex items-center justify-center font-semibold whitespace-nowrap select-none transition-colors duration-150',
    'disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
    VARIANTS[variant],
    SIZES[size],
    block ? 'w-full' : '',
    extra || '',
  ].join(' ');
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', icon: Icon, iconEnd: IconEnd, loading, block, className, children, disabled, type = 'button', ...rest },
  ref
) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} className={classes(variant, size, block, className)} {...rest}>
      {loading ? <Loader2 className={`${ICON_SIZES[size]} animate-spin`} /> : Icon ? <Icon className={ICON_SIZES[size]} strokeWidth={1.9} /> : null}
      {children}
      {IconEnd && !loading ? <IconEnd className={ICON_SIZES[size]} strokeWidth={1.9} /> : null}
    </button>
  );
});

export function ButtonLink({
  to,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconEnd: IconEnd,
  block,
  className,
  children,
  ...rest
}: CommonProps & { to: string; className?: string; children?: React.ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <Link to={to} className={classes(variant, size, block, className)} {...rest}>
      {Icon ? <Icon className={ICON_SIZES[size]} strokeWidth={1.9} /> : null}
      {children}
      {IconEnd ? <IconEnd className={ICON_SIZES[size]} strokeWidth={1.9} /> : null}
    </Link>
  );
}

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  size?: 'sm' | 'md';
  tone?: 'default' | 'danger' | 'brand';
  active?: boolean;
  badge?: boolean;
}

/** Square icon-only button; `label` becomes the accessible name and tooltip. */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = 'md', tone = 'default', active, badge, className, type = 'button', ...rest },
  ref
) {
  const dim = size === 'sm' ? 'w-8 h-8 rounded-[9px]' : 'w-10 h-10 rounded-control';
  const toneCls =
    tone === 'danger'
      ? 'text-ink-3 hover:text-low-ink hover:bg-low-soft'
      : tone === 'brand'
      ? 'text-brand-ink hover:bg-brand-soft'
      : active
      ? 'bg-brand-soft text-brand-stronger'
      : 'text-ink-3 hover:text-ink hover:bg-line-2';
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`relative inline-flex items-center justify-center shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${dim} ${toneCls} ${className || ''}`}
      {...rest}
    >
      <Icon className={size === 'sm' ? 'w-4 h-4' : 'w-[19px] h-[19px]'} strokeWidth={1.8} />
      {badge && <span className="absolute top-2 left-2 w-2 h-2 rounded-full bg-low ring-2 ring-surface" />}
    </button>
  );
});

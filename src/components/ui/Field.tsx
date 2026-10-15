import React, { useId } from 'react';
import { Check, ChevronDown, Eye, EyeOff, Search, X, type LucideIcon } from 'lucide-react';

const CONTROL =
  'w-full bg-surface border border-line rounded-control text-sm text-ink transition-colors ' +
  'hover:border-line-strong focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15 ' +
  'disabled:bg-canvas disabled:text-ink-4 disabled:cursor-not-allowed';

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className = '',
  htmlFor,
  optional,
}: {
  label?: string;
  hint?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  optional?: boolean;
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {label && (
        <label htmlFor={htmlFor} className="text-[13px] font-semibold text-ink-2 flex items-center gap-1">
          {label}
          {required && <span className="text-low-ink" aria-hidden>*</span>}
          {optional && <span className="text-ink-4 font-normal">(اختیاری)</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-low-ink font-medium" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-3 leading-relaxed">{hint}</p>
      ) : null}
    </div>
  );
}

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: React.ReactNode;
  error?: string | null;
  icon?: LucideIcon;
  optional?: boolean;
  latin?: boolean;
  wrapperClassName?: string;
};

export const TextInput = React.forwardRef<HTMLInputElement, InputProps>(function TextInput(
  { label, hint, error, icon: Icon, required, optional, latin, wrapperClassName = '', className = '', id, type, ...rest },
  ref
) {
  const autoId = useId();
  const inputId = id || autoId;
  const [show, setShow] = React.useState(false);
  const isPassword = type === 'password';
  return (
    <Field label={label} hint={hint} error={error} required={required} optional={optional} htmlFor={inputId} className={wrapperClassName}>
      <div className="relative">
        {Icon && <Icon className="absolute right-3 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-ink-4 pointer-events-none" strokeWidth={1.8} />}
        <input
          ref={ref}
          id={inputId}
          type={isPassword && show ? 'text' : type}
          required={required}
          aria-invalid={Boolean(error)}
          dir={latin ? 'ltr' : undefined}
          className={`${CONTROL} h-11 ${Icon ? 'pr-10' : 'pr-3.5'} ${isPassword ? 'pl-10' : 'pl-3.5'} ${latin ? 'text-left hv-latin' : ''} ${
            error ? 'border-low/60 focus:border-low focus:ring-low/15' : ''
          } ${className}`}
          {...rest}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-md flex items-center justify-center text-ink-4 hover:text-ink-2"
            aria-label={show ? 'پنهان کردن رمز' : 'نمایش رمز'}
          >
            {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        )}
      </div>
    </Field>
  );
});

type TextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  hint?: React.ReactNode;
  error?: string | null;
  optional?: boolean;
  wrapperClassName?: string;
};

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, required, optional, wrapperClassName = '', className = '', id, ...rest },
  ref
) {
  const autoId = useId();
  const inputId = id || autoId;
  return (
    <Field label={label} hint={hint} error={error} required={required} optional={optional} htmlFor={inputId} className={wrapperClassName}>
      <textarea
        ref={ref}
        id={inputId}
        required={required}
        dir="auto"
        className={`${CONTROL} min-h-[96px] px-3.5 py-2.5 leading-relaxed resize-y ${className}`}
        {...rest}
      />
    </Field>
  );
});

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  hint?: React.ReactNode;
  error?: string | null;
  optional?: boolean;
  wrapperClassName?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  compact?: boolean;
};

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, required, optional, wrapperClassName = '', className = '', id, options, placeholder, compact, ...rest },
  ref
) {
  const autoId = useId();
  const inputId = id || autoId;
  const control = (
    <div className="relative">
      <select
        ref={ref}
        id={inputId}
        required={required}
        className={`${CONTROL} appearance-none ${compact ? 'h-9 text-[13px] pr-3 pl-8' : 'h-11 pr-3.5 pl-9'} font-medium ${className}`}
        {...rest}
      >
        {placeholder !== undefined && (
          <option value="" disabled={required}>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 text-ink-4 pointer-events-none ${compact ? 'left-2.5' : 'left-3'}`} />
    </div>
  );
  if (!label && !hint && !error) return <div className={wrapperClassName}>{control}</div>;
  return (
    <Field label={label} hint={hint} error={error} required={required} optional={optional} htmlFor={inputId} className={wrapperClassName}>
      {control}
    </Field>
  );
});

export function SearchInput({
  value,
  onChange,
  placeholder = 'جست‌وجو…',
  className = '',
  autoFocus,
  size = 'md',
  onKeyDown,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  size?: 'sm' | 'md';
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className={`relative ${className}`}>
      <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-[17px] h-[17px] text-ink-4 pointer-events-none" strokeWidth={1.8} />
      <input
        ref={inputRef}
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        className={`${CONTROL} ${size === 'sm' ? 'h-9 text-[13px]' : 'h-10'} pr-9 pl-8 [&::-webkit-search-cancel-button]:hidden`}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute left-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center text-ink-4 hover:text-ink-2 hover:bg-line-2"
          aria-label="پاک کردن جست‌وجو"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  indeterminate,
  className = '',
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: React.ReactNode;
  indeterminate?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`inline-flex items-center gap-2.5 select-none ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${className}`}>
      <span className="relative inline-flex">
        <input
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          aria-checked={indeterminate ? 'mixed' : checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          className={`w-[18px] h-[18px] rounded-[5px] border flex items-center justify-center transition-colors peer-focus-visible:ring-[3px] peer-focus-visible:ring-brand/30 ${
            checked || indeterminate ? 'bg-brand-strong border-brand-strong text-white' : 'bg-surface border-line-strong'
          }`}
        >
          {indeterminate ? <span className="w-2 h-[2px] bg-white rounded" /> : checked ? <Check className="w-3 h-3" strokeWidth={3} /> : null}
        </span>
      </span>
      {label && <span className="text-sm text-ink-2">{label}</span>}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start justify-between gap-4 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      {(label || description) && (
        <span className="flex flex-col gap-0.5">
          {label && <span className="text-sm font-semibold text-ink">{label}</span>}
          {description && <span className="text-xs text-ink-3 leading-relaxed">{description}</span>}
        </span>
      )}
      <span className="relative inline-flex shrink-0 mt-0.5">
        <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className={`w-10 h-6 rounded-full transition-colors ${checked ? 'bg-brand-strong' : 'bg-line-strong'} peer-focus-visible:ring-[3px] peer-focus-visible:ring-brand/30`} />
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all ${checked ? 'right-5' : 'right-1'}`} />
      </span>
    </label>
  );
}

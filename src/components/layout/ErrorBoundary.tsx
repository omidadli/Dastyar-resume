import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { HovidaMark } from '../brand/Logo';

interface State {
  error: Error | null;
}

/** Last line of defence: a readable recovery screen instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Uncaught error in the React tree:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div dir="rtl" className="min-h-screen bg-canvas flex items-center justify-center p-6">
        <div className="hv-card w-full max-w-[440px] p-7 text-center flex flex-col items-center gap-4">
          <HovidaMark size={44} />
          <span className="w-12 h-12 rounded-full bg-low-soft flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-low-ink" />
          </span>
          <div>
            <h1 className="text-[17px] font-bold text-ink">مشکلی در نمایش این صفحه پیش آمد</h1>
            <p className="text-[13px] text-ink-3 mt-1.5 leading-relaxed">داده‌های شما محفوظ است. صفحه را دوباره بارگذاری کنید؛ اگر مشکل ادامه داشت، به صفحه اصلی بروید.</p>
          </div>
          <code className="w-full text-left hv-latin text-[11px] text-ink-3 bg-line-2 rounded-[8px] p-2.5 max-h-24 overflow-auto break-all" dir="ltr">
            {String(this.state.error.message || this.state.error)}
          </code>
          <div className="flex gap-2 w-full">
            <button onClick={() => window.location.reload()} className="flex-1 h-10 rounded-control bg-brand-strong text-white font-bold text-sm inline-flex items-center justify-center gap-2">
              <RefreshCw className="w-4 h-4" />
              بارگذاری دوباره
            </button>
            <button onClick={() => (window.location.href = '/app')} className="flex-1 h-10 rounded-control border border-line bg-surface text-ink font-bold text-sm inline-flex items-center justify-center gap-2">
              <Home className="w-4 h-4" />
              داشبورد
            </button>
          </div>
        </div>
      </div>
    );
  }
}

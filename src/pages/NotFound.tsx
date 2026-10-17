import React from 'react';
import { Compass } from 'lucide-react';
import { ButtonLink, EmptyState } from '../components/ui';
import { HovidaLogo } from '../components/brand/Logo';
import { useTitle } from '../lib/useTitle';

export default function NotFound({ inApp }: { inApp?: boolean }) {
  useTitle('صفحه پیدا نشد');
  const body = (
    <EmptyState
      icon={Compass}
      titleAs="h1"
      title="این صفحه پیدا نشد"
      description="ممکن است پیوند اشتباه باشد یا این مورد حذف شده باشد."
      action={<ButtonLink to={inApp ? '/app' : '/'}>{inApp ? 'بازگشت به داشبورد' : 'بازگشت به صفحه اصلی'}</ButtonLink>}
    />
  );
  if (inApp) return <div className="hv-card mt-6">{body}</div>;
  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-canvas px-5" dir="rtl">
      <HovidaLogo height={34} />
      <div className="hv-card mt-8 w-full max-w-[520px]">{body}</div>
    </main>
  );
}

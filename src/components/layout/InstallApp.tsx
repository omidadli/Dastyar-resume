import type { LucideIcon } from 'lucide-react';
import { Download, Share2, Smartphone } from 'lucide-react';
import { Button, Callout, Modal, toast } from '../ui';
import type { InstallState } from '../../lib/pwa';

/**
 * «نصب روی دستگاه» — one menu line, two behaviours:
 *   • Android/Chrome/Edge: the browser's own install prompt.
 *   • iPhone/iPad: Safari has no prompt, so the dialog says exactly which two
 *     taps to make («اشتراک‌گذاری» → «افزودن به صفحهٔ اصلی»).
 * When the app is already installed — or the browser offers nothing and it is
 * not iOS — no line is shown at all: an entry that does nothing is worse than
 * no entry.
 */
export function installMenuItem(
  install: InstallState,
  openHelp: () => void
): { label: string; icon: LucideIcon; onClick: () => void } | null {
  if (install.installed) return null;
  if (!install.canInstall && !install.ios) return null;
  return {
    label: 'نصب روی دستگاه',
    icon: Download,
    onClick: () => {
      if (!install.canInstall) {
        openHelp();
        return;
      }
      void install.promptInstall().then((outcome) => {
        if (outcome === 'accepted') toast('هویدا به صفحهٔ اصلی اضافه شد.', 'success');
        else if (outcome === 'unavailable') openHelp();
      });
    },
  };
}

/** The iOS instructions, rendered by the app shell. */
export function InstallHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<Smartphone className="w-5 h-5 text-brand-strong" />}
      title="نصب هویدا روی صفحهٔ اصلی"
      size="md"
      footer={
        <Button variant="secondary" onClick={onClose}>
          بستن
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Callout tone="info" icon={Download} title="این یک اپلیکیشن کامل است، نه یک بوکمارک">
          آیکن روی صفحهٔ اصلی می‌نشیند، بدون نوار مرورگر باز می‌شود و وقتی اینترنت قطع شود یک صفحهٔ آفلاین فارسی نشان می‌دهد.
          رزومه‌ها و تصمیم‌ها روی سرور می‌مانند؛ چیزی از کارجویان روی گوشی ذخیره نمی‌شود.
        </Callout>
        <div>
          <p className="text-[13px] font-bold text-ink mb-1.5">در iPhone و iPad (Safari)</p>
          <ol className="text-[12.5px] text-ink-2 leading-relaxed list-decimal pr-5 space-y-1">
            <li>صفحه را در Safari باز کنید.</li>
            <li>
              دکمهٔ <Share2 className="w-3.5 h-3.5 inline mx-0.5" /> «اشتراک‌گذاری» را بزنید.
            </li>
            <li>«افزودن به صفحهٔ اصلی» را انتخاب کنید و «افزودن» را بزنید.</li>
          </ol>
        </div>
        <div>
          <p className="text-[13px] font-bold text-ink mb-1.5">در اندروید (Chrome)</p>
          <ol className="text-[12.5px] text-ink-2 leading-relaxed list-decimal pr-5 space-y-1">
            <li>منوی سه‌نقطهٔ مرورگر را باز کنید.</li>
            <li>«نصب برنامه» یا «افزودن به صفحهٔ اصلی» را بزنید.</li>
          </ol>
        </div>
        <p className="text-[11.5px] text-ink-4 leading-relaxed">
          هویدا در App Store یا Google Play منتشر نشده است و نوتیفیکیشن پس‌زمینه ندارد؛ اگر به هرکدام نیاز دارید، جداگانه تصمیم
          می‌گیریم — نسخهٔ وب نصب‌شدنی همین امروز کار می‌کند.
        </p>
      </div>
    </Modal>
  );
}

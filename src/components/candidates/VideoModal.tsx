import { useEffect, useState } from 'react';
import { Copy, Link2, Mail, Plus, Video as VideoIcon } from 'lucide-react';
import type { ResumeListItem } from '../../types/screening';
import { VIDEO_STATUS_LABEL, type VideoInvite } from '../../types/video';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { copyText } from '../../lib/clipboard';
import { emitChange } from '../../lib/events';
import { faDate } from '../../lib/format';
import { Button, Callout, Chip, Modal, Spinner, toast } from '../ui';

/**
 * «مصاحبهٔ ویدئویی» right where the recruiter already is: the candidate panel.
 * It creates the link only — sending is a separate, explicit click, and when no
 * mailbox is connected the page says so instead of pretending.
 */
export function VideoModal({
  record,
  jobTitle,
  onClose,
}: {
  record: ResumeListItem | null;
  jobTitle?: string;
  onClose: () => void;
}) {
  const canEdit = useCan('admin');
  const [items, setItems] = useState<VideoInvite[] | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<'create' | 'send' | null>(null);

  useEffect(() => {
    if (!record) return;
    setItems(null);
    api.video
      .overview({ resumeId: record.id })
      .then((r) => {
        setItems(r.invites.filter((i) => i.status !== 'cancelled'));
        setReady(r.jobs.find((j) => j.id === record.jobId)?.enabled ?? false);
      })
      .catch(() => setItems([]));
  }, [record?.id]);

  const open = items?.find((i) => i.status === 'submitted' || i.status === 'reviewed' || i.status === 'invited' || i.status === 'recording') || null;

  const create = async () => {
    if (!record) return;
    setBusy('create');
    try {
      const r = await api.video.create({ resumeId: record.id, jobId: record.jobId || undefined });
      setItems((prev) => [r.invite, ...(prev || [])]);
      toast('لینک مصاحبه ساخته شد؛ هنوز چیزی فرستاده نشده است.', 'success');
      emitChange('activity');
    } catch (err: any) {
      toast(err?.message || 'ساخت لینک ممکن نشد.', 'error', undefined, 8000);
    } finally {
      setBusy(null);
    }
  };

  const send = async (invite: VideoInvite) => {
    setBusy('send');
    try {
      const r = await api.video.send(invite.id);
      setItems((prev) => (prev || []).map((i) => (i.id === invite.id ? r.invite : i)));
      toast('لینک از صندوق سازمان فرستاده شد.', 'success');
    } catch (err: any) {
      const msg = String(err?.message || 'ارسال ممکن نشد.');
      if (err?.code === 'EMAIL_NOT_CONFIGURED' || err?.code === 'NO_EMAIL') {
        const ok = await copyText(invite.url);
        toast(`${msg}${ok ? ' — لینک کپی شد.' : ''}`, 'error', undefined, 10_000);
      } else toast(msg, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={Boolean(record)}
      onClose={onClose}
      icon={<VideoIcon className="w-5 h-5 text-brand-strong" />}
      title="مصاحبهٔ ویدئویی"
      description={jobTitle ? `پرسش‌های «${jobTitle}» — پاسخ با گوشی، بدون هماهنگی جلسه` : undefined}
      size="md"
    >
      {record && (
        <div className="flex flex-col gap-4">
          {items === null ? (
            <div className="py-10 flex justify-center">
              <Spinner />
            </div>
          ) : (
            <>
              {!ready && !open && (
                <Callout tone="warning" title="پرسش‌های این فرصت شغلی روشن نیست">
                  {canEdit
                    ? 'اول در «مصاحبهٔ ویدئویی» پرسش‌ها را بنویسید و روشن کنید؛ بعد این لینک ساخته می‌شود.'
                    : 'از مدیر فضای کاری بخواهید پرسش‌های این فرصت را روشن کند.'}
                </Callout>
              )}

              {!open && ready && (
                <p className="text-[13px] text-ink-2 leading-relaxed">
                  یک لینک اختصاصی برای «{record.candidateName || 'این کارجو'}» ساخته می‌شود. خودتان تصمیم می‌گیرید چه وقت و با چه
                  متنی بفرستید؛ هویدا بی‌اجازه چیزی به کارجو نمی‌فرستد.
                </p>
              )}

              {open && (
                <div className="rounded-[12px] border border-line-2 bg-canvas px-3.5 py-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Chip tone={open.status === 'invited' ? 'neutral' : open.status === 'recording' ? 'warning' : 'brand'}>
                      {VIDEO_STATUS_LABEL[open.status]}
                    </Chip>
                    <span className="text-[11.5px] text-ink-3">ساخته‌شده {faDate(open.createdAtISO)}</span>
                    {open.rating && <span className="text-[11.5px] text-ink-3">امتیاز شما: {open.rating} از ۵</span>}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Button size="sm" variant="secondary" icon={Mail} loading={busy === 'send'} onClick={() => void send(open)}>
                      ارسال با ایمیل سازمان
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Copy}
                      onClick={async () => {
                        const ok = await copyText(open.url);
                        toast(ok ? 'لینک کپی شد.' : 'کپی ممکن نشد.', ok ? 'success' : 'error');
                      }}
                    >
                      کپی لینک
                    </Button>
                  </div>
                  <p className="mt-2 text-[11px] text-ink-4 break-all" dir="ltr">
                    {open.url}
                  </p>
                </div>
              )}

              {!open && ready && (
                <Button icon={Plus} onClick={create} loading={busy === 'create'}>
                  ساخت لینک مصاحبه
                </Button>
              )}

              <p className="text-[11.5px] text-ink-3 flex items-start gap-1.5 leading-relaxed">
                <Link2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                کارجو پرسش‌ها و زمان هر پاسخ را قبل از شروع می‌بیند. ویدئو فقط برای اعضای همین فضای کاری قابل تماشا است و امتیاز
                را شما می‌دهید — چیزی خودکار رد یا قبول نمی‌شود.
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

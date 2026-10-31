import React, { useEffect, useState } from 'react';
import {
  Archive,
  Bell,
  BriefcaseBusiness,
  CheckCheck,
  CalendarClock,
  ClipboardCheck,
  FileSignature,
  MessageSquareText,
  Eye,
  FileSearch2,
  KanbanSquare,
  Link2,
  MailCheck,
  MailWarning,
  SlidersHorizontal,
  Scale,
  Sparkles,
  Trash2,
  MessageSquareHeart,
  ClipboardList,
  ShieldCheck,
  UserPlus,
  UserCog,
  UserMinus,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { navigate } from '../../lib/router';
import { useOnChange } from '../../lib/events';
import type { ActivityItem, ActivityType } from '../../types/app';
import { Drawer, EmptyState, ErrorState, IconButton, Skeleton } from '../ui';
import { faRelative } from '../../lib/format';

export const ACTIVITY_ICON: Record<ActivityType, LucideIcon> = {
  'org.created': Zap,
  'member.added': UserPlus,
  'member.removed': UserMinus,
  'member.updated': UserCog,
  'candidate.revealed': Eye,
  'job.created': BriefcaseBusiness,
  'job.status': BriefcaseBusiness,
  'job.deleted': Trash2,
  'analysis.completed': FileSearch2,
  decision: Scale,
  'talent.added': Archive,
  'message.sent': MailCheck,
  'message.failed': MailWarning,
  'sourcing.search': Link2,
  'sourcing.imported': UserPlus,
  'interview.scheduled': CalendarClock,
  'interview.cancelled': CalendarClock,
  'interview.reminder': MailCheck,
  'automation.run': Sparkles,
  'automation.approved': Sparkles,
  'stage.moved': KanbanSquare,
  'scorecard.added': ClipboardCheck,
  'offer.sent': FileSignature,
  'offer.accepted': FileSignature,
  'offer.declined': FileSignature,
  'offer.cancelled': FileSignature,
  'comment.added': MessageSquareText,
  'settings.changed': SlidersHorizontal,
  'deep.review': FileSearch2,
  'resume.deleted': Trash2,
  'retention.applied': ShieldCheck,
  'survey.sent': MessageSquareHeart,
  'survey.answered': MessageSquareHeart,
  'assessment.sent': ClipboardList,
  'assessment.completed': ClipboardList,
};

export function ActivityRow({ item, unread, onOpen }: { item: ActivityItem; unread?: boolean; onOpen?: () => void }) {
  const Icon = ACTIVITY_ICON[item.type] || Bell;
  const target = item.resumeId && item.jobId ? `/app/jobs/${item.jobId}?c=${item.resumeId}` : item.jobId ? `/app/jobs/${item.jobId}` : null;
  const content = (
    <>
      <span className="w-9 h-9 rounded-[10px] bg-line-2 text-ink-3 flex items-center justify-center shrink-0">
        <Icon className="w-[17px] h-[17px]" strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-ink-2 leading-relaxed">
          {item.userName && <b className="font-bold text-ink">{item.userName} </b>}
          {item.text}
        </span>
        <span className="block text-[11.5px] text-ink-4 mt-0.5">{faRelative(item.atISO)}</span>
      </span>
      {unread && <span className="w-2 h-2 rounded-full bg-brand mt-2 shrink-0" aria-label="خوانده‌نشده" />}
    </>
  );
  if (!target) return <div className="flex items-start gap-3 px-3 py-2.5 rounded-[11px]">{content}</div>;
  return (
    <button
      onClick={() => {
        onOpen?.();
        navigate(target);
      }}
      className="w-full text-right flex items-start gap-3 px-3 py-2.5 rounded-[11px] hover:bg-line-2 transition-colors"
    >
      {content}
    </button>
  );
}

export function NotificationsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, setUnread } = useAuth();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());

  const load = (markSeen: boolean) =>
    api.insights
      .activity(40)
      .then((r) => {
        if (markSeen) {
          // The server's unread count covers the newest teammate events.
          const ids = new Set<string>();
          let left = r.unread;
          for (const it of r.items) {
            if (left <= 0) break;
            if (it.userId !== user?.id) {
              ids.add(it.id);
              left--;
            }
          }
          setUnreadIds(ids);
          if (r.unread > 0) api.insights.markSeen().then(() => setUnread(0)).catch(() => {});
        }
        setFailed(null);
        setItems(r.items);
      })
      .catch((err) => {
        // A failed background refresh keeps the list on screen; only the
        // opening load reports the failure (never as «no activity yet»).
        if (markSeen) setFailed(err?.message || 'دریافت اعلان‌ها ممکن نشد.');
      });

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setFailed(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useOnChange(['activity'], () => {
    if (open) void load(false);
  });

  return (
    <Drawer open={open} onClose={onClose} width={420} label="اعلان‌ها و فعالیت‌ها">
      <div className="flex items-center justify-between gap-3 px-5 h-16 border-b border-line shrink-0">
        <div>
          <h2 className="text-[15px] font-bold text-ink">اعلان‌ها و فعالیت تیم</h2>
          <p className="text-[12px] text-ink-3">آخرین رویدادهای فضای کاری شما</p>
        </div>
        <IconButton icon={X} label="بستن" onClick={onClose} />
      </div>
      <div className="flex-1 overflow-y-auto hv-scroll p-2">
        {failed ? (
          <ErrorState
            message={failed}
            onRetry={() => {
              setFailed(null);
              setItems(null);
              void load(true);
            }}
          />
        ) : items === null ? (
          <div className="p-3 flex flex-col gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="w-9 h-9 rounded-[10px]" />
                <div className="flex-1 flex flex-col gap-2">
                  <Skeleton className="h-3.5 w-4/5" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={CheckCheck} title="همه‌چیز مرتب است" description="هنوز فعالیتی ثبت نشده است. با ایجاد اولین فرصت شغلی، رویدادهای تیم اینجا نمایش داده می‌شود." compact />
        ) : (
          items.map((it) => <ActivityRow key={it.id} item={it} unread={unreadIds.has(it.id)} onOpen={onClose} />)
        )}
      </div>
    </Drawer>
  );
}

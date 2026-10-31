import React, { useEffect, useState } from 'react';
import { Lock, ShieldCheck, Users } from 'lucide-react';
import type { JobAccessPayload, JobAccessMode } from '../../types/screening';
import { api } from '../../lib/api';
import { Button, Callout, Checkbox, Chip, Modal, Switch, toast } from '../ui';

/**
 * «دسترسی به این آگهی» — a lock that only exists when it is needed.
 *
 * Roles (عضو / مدیر) are workspace-wide; this dialog is per opening. It is where
 * an admin says «این جست‌وجو محرمانه است، فقط این سه نفر» and the rule then holds
 * for the list, the board, the candidate panel, files, offers and interviews.
 *
 * The default is «همهٔ اعضا», because an access control nobody asks for becomes
 * an access control nobody understands.
 */
export function JobAccessModal({
  jobId,
  jobTitle,
  open,
  onClose,
  access,
  onSaved,
}: {
  jobId: string;
  jobTitle: string;
  open: boolean;
  onClose: () => void;
  access: JobAccessPayload | null;
  onSaved: (access: JobAccessPayload) => void;
}) {
  const [mode, setMode] = useState<JobAccessMode>('everyone');
  const [picked, setPicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // Nothing is assumed while the team list is loading: a half-filled list would
  // look like «هیچ‌کس دسترسی ندارد».
  const [team, setTeam] = useState<JobAccessPayload['members'] | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setTeam(access?.members ?? null);
    api.org
      .get()
      .then((res) => {
        if (!alive) return;
        setTeam(
          res.members.map((m) => ({
            id: m.id,
            name: m.name,
            email: m.email,
            role: m.role,
            isCreator: false,
          }))
        );
      })
      .catch(() => alive && setTeam([]));
    return () => {
      alive = false;
    };
  }, [open, access]);

  useEffect(() => {
    if (!open) return;
    setMode(access?.accessMode ?? 'everyone');
    setPicked(access?.allowedUserIds ?? []);
  }, [open, access]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.jobs.setAccess(jobId, { accessMode: mode, allowedUserIds: mode === 'restricted' ? picked : [] });
      onSaved(res.access);
      toast(mode === 'restricted' ? 'دسترسی این آگهی محدود شد.' : 'این آگهی برای همهٔ اعضا باز شد.', 'success');
      onClose();
    } catch (err: any) {
      toast(err?.message || 'ذخیرهٔ دسترسی ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const list = team ?? access?.members ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="دسترسی به این آگهی"
      description={`«${jobTitle}» — چه کسانی در فضای کاری این آگهی، کاندیداها و فایل‌هایشان را ببینند؟`}
      icon={<Lock className="w-5 h-5 text-brand" />}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={mode === 'restricted' && picked.length === 0}>
            ذخیرهٔ دسترسی
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Switch
          checked={mode === 'restricted'}
          onChange={(v) => setMode(v ? 'restricted' : 'everyone')}
          label="محدود به افراد انتخاب‌شده"
          description="وقتی خاموش است، همهٔ اعضای فضای کاری این آگهی را می‌بینند — رفتار پیش‌فرض هویدا."
        />

        {mode === 'everyone' ? (
          <Callout tone="info" icon={Users}>
            همهٔ اعضا این آگهی و کاندیداهایش را می‌بینند. مدیران همیشه همه‌چیز را می‌بینند.
          </Callout>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <p className="text-[13px] font-semibold text-ink">چه کسانی ببینند؟</p>
              <span className="text-[12px] text-ink-3">{picked.length.toLocaleString('fa-IR')} نفر انتخاب‌شده</span>
            </div>
            <div className="max-h-[260px] overflow-y-auto rounded-[12px] border border-line-2 divide-y divide-line-2">
              {list.length === 0 ? (
                <p className="p-4 text-[12.5px] text-ink-3">فهرست اعضا در حال بارگذاری است…</p>
              ) : (
                list.map((m) => {
                  const isAdmin = m.role === 'owner' || m.role === 'admin';
                  const checked = picked.includes(m.id);
                  return (
                    <label key={m.id} className="flex items-center gap-3 px-3.5 py-2.5 hover:bg-canvas cursor-pointer">
                      <Checkbox checked={checked || isAdmin} disabled={isAdmin} onChange={(v) => setPicked((p) => (v ? [...p, m.id] : p.filter((x) => x !== m.id)))} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] text-ink truncate">{m.name}</span>
                        <span className="block text-[11.5px] text-ink-3 truncate" dir="ltr">
                          {m.email}
                        </span>
                      </span>
                      {m.isCreator && <Chip tone="outline">سازنده</Chip>}
                      {isAdmin && (
                        <Chip tone="neutral" icon={ShieldCheck}>
                          {m.role === 'owner' ? 'مالک' : 'مدیر'}
                        </Chip>
                      )}
                    </label>
                  );
                })
              )}
            </div>
            <Callout tone="warning" icon={ShieldCheck}>
              این آگهی از فهرست، جست‌وجو، تختهٔ جذب، پیشنهادها و جلسه‌های مصاحبهٔ بقیهٔ اعضا پنهان می‌شود؛ ورود مستقیم به نشانی آن هم
              پاسخ «دسترسی ندارید» می‌دهد. مدیران و سازندهٔ آگهی همیشه دسترسی دارند.
            </Callout>
          </>
        )}
      </div>
    </Modal>
  );
}

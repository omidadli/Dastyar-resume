/**
 * The form that creates or edits a «نیازمندسنجی».
 *
 * Two deliberate frictions, both about money and honesty:
 *   • the salary band is optional, but if either end is filled the other is
 *     required — a one-sided band is not a band;
 *   • the justification has a counter and a minimum, because the approver's whole
 *     job is to judge a reason, not a title.
 */
import React, { useEffect, useState } from 'react';
import { Button, Field, Modal, Select, TextArea, TextInput, toast } from '../ui';
import { toPersianDigits } from '../../lib/format';
import {
  PRIORITY_LABEL,
  SALARY_BASIS_LABEL,
  SENIORITY_LABEL,
  WORK_MODE_LABEL,
  type Requisition,
  type RequisitionInput,
  type RequisitionPriority,
  type RequisitionSeniority,
  type RequisitionWorkMode,
  type SalaryBasis,
} from '../../types/requisition';

export interface FormDepartment {
  id: string;
  name: string;
}

export interface FormMember {
  id: string;
  name: string;
}

const EMPLOYMENT = [
  { value: 'full-time', label: 'تمام‌وقت' },
  { value: 'part-time', label: 'پاره‌وقت' },
  { value: 'contract', label: 'قراردادی' },
  { value: 'internship', label: 'کارآموزی' },
];

export default function RequisitionForm({
  open,
  onClose,
  onSubmit,
  departments,
  members,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: RequisitionInput) => Promise<void>;
  departments: FormDepartment[];
  members: FormMember[];
  initial?: Requisition | null;
}) {
  const [title, setTitle] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [hiringManagerId, setHiringManagerId] = useState('');
  const [slots, setSlots] = useState('1');
  const [priority, setPriority] = useState<RequisitionPriority>('normal');
  const [seniority, setSeniority] = useState<RequisitionSeniority>('mid');
  const [employmentType, setEmploymentType] = useState('full-time');
  const [workMode, setWorkMode] = useState<RequisitionWorkMode>('onsite');
  const [location, setLocation] = useState('');
  const [salaryMin, setSalaryMin] = useState('');
  const [salaryMax, setSalaryMax] = useState('');
  const [salaryBasis, setSalaryBasis] = useState<SalaryBasis>('gross_monthly');
  const [justification, setJustification] = useState('');
  const [targetStart, setTargetStart] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title || '');
    setDepartmentId(initial?.departmentId || departments[0]?.id || '');
    setHiringManagerId(initial ? members.find((m) => m.name === initial.hiringManagerName)?.id || '' : '');
    setSlots(String(initial?.slots ?? 1));
    setPriority(initial?.priority || 'normal');
    setSeniority(initial?.seniority || 'mid');
    setEmploymentType(initial?.employmentType || 'full-time');
    setWorkMode(initial?.workMode || 'onsite');
    setLocation(initial?.location || '');
    setSalaryMin(initial?.salaryMin != null ? String(initial.salaryMin) : '');
    setSalaryMax(initial?.salaryMax != null ? String(initial.salaryMax) : '');
    setSalaryBasis(initial?.salaryBasis || 'gross_monthly');
    setJustification(initial?.justification || '');
    setTargetStart(initial?.targetStartISO ? initial.targetStartISO.slice(0, 10) : '');
    // Restarting the form when it opens for a different row is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.id, departments.length, members.length]);

  const save = async () => {
    if (title.trim().length < 2) return toast('عنوان شغلی را بنویسید.', 'error');
    if (!departmentId) return toast('دپارتمان را انتخاب کنید.', 'error');
    if ((salaryMin && !salaryMax) || (!salaryMin && salaryMax)) return toast('بازهٔ حقوق را کامل کنید یا هر دو را خالی بگذارید.', 'error');
    setBusy(true);
    try {
      await onSubmit({
        title: title.trim(),
        departmentId,
        hiringManagerId: hiringManagerId || null,
        slots: Number(slots) || 1,
        priority,
        seniority,
        employmentType,
        workMode,
        location: location.trim(),
        salaryMin: salaryMin ? Number(salaryMin) : null,
        salaryMax: salaryMax ? Number(salaryMax) : null,
        salaryBasis,
        justification: justification.trim(),
        targetStartISO: targetStart ? new Date(`${targetStart}T09:00:00Z`).toISOString() : null,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const digits = (v: string) => v.replace(/[^\d]/g, '');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? `ویرایش ${initial.code}` : 'نیازمندسنجی تازه'}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            انصراف
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {initial ? 'ذخیرهٔ تغییرات' : 'ساخت پیش‌نویس'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="عنوان شغلی" required>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="کارشناس ارشد بک‌اند" maxLength={120} />
        </Field>

        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="دپارتمان" required>
            <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
          </Field>
          <Field label="مسئول استخدام (اختیاری)" hint="کسی که استخدام را پیش می‌برد؛ نه لزوماً درخواست‌دهنده">
            <Select
              value={hiringManagerId}
              onChange={(e) => setHiringManagerId(e.target.value)}
              options={[{ value: '', label: '—' }, ...members.map((m) => ({ value: m.id, label: m.name }))]}
            />
          </Field>
        </div>

        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="تعداد پست" required hint="سرفصلی که بعداً قابل استفاده است">
            <TextInput value={slots} onChange={(e) => setSlots(digits(e.target.value))} dir="ltr" inputMode="numeric" />
          </Field>
          <Field label="اولویت">
            <Select
              value={priority}
              onChange={(e) => setPriority(e.target.value as RequisitionPriority)}
              options={(Object.keys(PRIORITY_LABEL) as RequisitionPriority[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
            />
          </Field>
          <Field label="سطح">
            <Select
              value={seniority}
              onChange={(e) => setSeniority(e.target.value as RequisitionSeniority)}
              options={(Object.keys(SENIORITY_LABEL) as RequisitionSeniority[]).map((s) => ({ value: s, label: SENIORITY_LABEL[s] }))}
            />
          </Field>
        </div>

        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="نوع همکاری">
            <Select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} options={EMPLOYMENT} />
          </Field>
          <Field label="شیوهٔ کار">
            <Select
              value={workMode}
              onChange={(e) => setWorkMode(e.target.value as RequisitionWorkMode)}
              options={(Object.keys(WORK_MODE_LABEL) as RequisitionWorkMode[]).map((w) => ({ value: w, label: WORK_MODE_LABEL[w] }))}
            />
          </Field>
          <Field label="محل کار">
            <TextInput value={location} onChange={(e) => setLocation(e.target.value)} placeholder="تهران" maxLength={80} />
          </Field>
        </div>

        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="کف حقوق (تومان)" hint="اختیاری، اما اگر یکی را بنویسید هر دو لازم است">
            <TextInput value={salaryMin} onChange={(e) => setSalaryMin(digits(e.target.value))} dir="ltr" inputMode="numeric" placeholder="30000000" />
          </Field>
          <Field label="سقف حقوق (تومان)">
            <TextInput value={salaryMax} onChange={(e) => setSalaryMax(digits(e.target.value))} dir="ltr" inputMode="numeric" placeholder="45000000" />
          </Field>
          <Field label="معنای عدد" hint="تا معلوم باشد با چه چیزی مقایسه می‌شود">
            <Select
              value={salaryBasis}
              onChange={(e) => setSalaryBasis(e.target.value as SalaryBasis)}
              options={(Object.keys(SALARY_BASIS_LABEL) as SalaryBasis[]).map((b) => ({ value: b, label: SALARY_BASIS_LABEL[b] }))}
            />
          </Field>
        </div>

        <Field label="تاریخ شروع هدف (اختیاری)">
          <TextInput type="date" value={targetStart} onChange={(e) => setTargetStart(e.target.value)} dir="ltr" />
        </Field>

        <Field
          label="دلیل این نیرو"
          hint="برای فرستادن به تأیید، دست‌کم ۲۰ نویسه. تأییدکننده همین را می‌خواند."
        >
          <TextArea
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="چه کاری امروز زمین مانده است؟ اگر این پست پر نشود چه اتفاقی می‌افتد؟"
          />
        </Field>
        <p className="-mt-1 text-[11px] text-ink-4 hv-num">{toPersianDigits(justification.trim().length)} نویسه</p>
      </div>
    </Modal>
  );
}

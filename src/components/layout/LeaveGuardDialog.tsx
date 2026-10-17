import React from 'react';
import { ConfirmDialog } from '../ui';
import { useLeavePrompt } from '../../lib/router';

/**
 * The one question behind `useLeaveGuard`: a page with unsaved edits is about
 * to be left (link, button, Back/Forward, sign-out). «انصراف» keeps the focus —
 * Enter must never throw edits away.
 */
export function LeaveGuardDialog() {
  const { open, stay, leave } = useLeavePrompt();
  return (
    <ConfirmDialog
      open={open}
      onClose={stay}
      onConfirm={leave}
      title="تغییرات ذخیره نشده است"
      description="اگر این صفحه را ترک کنید، تغییراتی که ذخیره نکرده‌اید از دست می‌رود."
      confirmLabel="ترک صفحه"
      tone="danger"
    />
  );
}

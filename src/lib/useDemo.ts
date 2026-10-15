import { useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { navigate } from './router';
import { toast } from '../components/ui/Toast';

/** «ورود به نسخه نمایشی» — creates a private, self-expiring demo workspace. */
export function useDemoLogin() {
  const { signIn } = useAuth();
  const [loading, setLoading] = useState(false);
  const start = async () => {
    setLoading(true);
    try {
      const payload = await api.auth.demo();
      signIn(payload);
      navigate('/app');
    } catch (e: any) {
      toast(e?.message || 'ساخت نسخه نمایشی ممکن نشد.', 'error');
    } finally {
      setLoading(false);
    }
  };
  return { start, loading };
}

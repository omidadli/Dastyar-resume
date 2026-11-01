import React, { useEffect, useState } from 'react';
import { AtSign, MessageSquareText, Send, Trash2 } from 'lucide-react';
import type { CandidateComment } from '../../types/pipeline';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, IconButton, Monogram, Spinner, TextArea, toast } from '../ui';

/**
 * «یادداشت تیمی» — the conversation about a candidate, kept on the candidate.
 * Typing «@» opens the team list; the mentioned colleague sees it in the feed.
 */
export function CommentsSection({ resumeId }: { resumeId: string }) {
  const { user } = useAuth();
  const [items, setItems] = useState<CandidateComment[]>([]);
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.comments
      .list(resumeId)
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setMembers(r.members);
      })
      .catch(() => alive && setItems([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [resumeId]);

  const suggestions =
    mentionQuery === null
      ? []
      : members.filter((m) => m.id !== user?.id && m.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 5);

  const onChange = (value: string) => {
    setBody(value);
    const match = /@([^\s@]*)$/.exec(value);
    setMentionQuery(match ? match[1] : null);
  };

  const insertMention = (name: string) => {
    setBody((prev) => prev.replace(/@([^\s@]*)$/, `@${name} `));
    setMentionQuery(null);
  };

  const send = async () => {
    if (body.trim().length < 2) return;
    setBusy(true);
    try {
      const r = await api.comments.add(resumeId, body.trim());
      setItems(r.items);
      setMembers(r.members);
      setBody('');
      toast('یادداشت ثبت شد.');
    } catch (err: any) {
      toast(err?.message || 'ثبت یادداشت ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const r = await api.comments.remove(id);
      setItems(r.items);
      toast('یادداشت پاک شد.', 'info');
    } catch (err: any) {
      toast(err?.message || 'پاک کردن ممکن نشد.', 'error');
    }
  };

  return (
    <section>
      <h3 className="text-[13px] font-bold text-ink flex items-center gap-2 mb-2.5">
        <MessageSquareText className="w-4 h-4 text-brand" strokeWidth={1.8} />
        یادداشت‌های تیم
        {items.length > 0 && <span className="text-[11.5px] text-ink-4 font-medium">({items.length})</span>}
      </h3>

      {loading ? (
        <div className="py-6 flex justify-center">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <p className="text-[12.5px] text-ink-3 leading-relaxed mb-3">
          هنوز یادداشتی ثبت نشده. تصمیم‌ها و نکته‌های مصاحبه را همین‌جا بنویسید تا برای بقیهٔ تیم بماند.
        </p>
      ) : (
        <ul className="flex flex-col gap-3 mb-3">
          {items.map((c) => (
            <li key={c.id} className="rounded-[12px] border border-line bg-canvas px-3.5 py-3">
              <div className="flex items-center gap-2 mb-1.5">
                <Monogram name={c.authorName} size={24} />
                <span className="text-[12.5px] font-semibold text-ink">{c.authorName}</span>
                <span className="text-[11.5px] text-ink-4">{c.atJalali}</span>
                {(c.authorId === user?.id || user?.role === 'owner' || user?.role === 'admin') && (
                  <span className="mr-auto">
                    <IconButton icon={Trash2} label="پاک کردن یادداشت" size="sm" onClick={() => void remove(c.id)} />
                  </span>
                )}
              </div>
              <p className="text-[13px] text-ink-2 leading-[1.9] whitespace-pre-line" dir="auto">
                {c.body}
              </p>
              {c.mentions.length > 0 && (
                <p className="text-[11.5px] text-brand-ink mt-1.5 inline-flex items-center gap-1">
                  <AtSign className="w-3.5 h-3.5" strokeWidth={2} />
                  {c.mentions.map((m) => m.name).join('، ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="relative">
        <TextArea
          label="یادداشت تازه"
          value={body}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          placeholder="مثلاً: @سارا محمدی لطفاً برای مصاحبهٔ فنی این هفته وقت بگذار."
          hint="با «@» نام همکار را صدا بزنید؛ در فعالیت‌های تیم می‌بیند."
        />
        {suggestions.length > 0 && (
          <div className="absolute z-10 mt-1 bg-surface border border-line rounded-[10px] shadow-lg overflow-hidden w-56">
            {suggestions.map((m) => (
              <button
                key={m.id}
                type="button"
                className="w-full text-right px-3 py-2 text-[12.5px] hover:bg-canvas"
                onClick={() => insertMention(m.name)}
              >
                {m.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="mt-2">
        <Button size="sm" icon={Send} onClick={() => void send()} loading={busy} disabled={busy || body.trim().length < 2}>
          ثبت یادداشت
        </Button>
      </div>
    </section>
  );
}

/**
 * «خلاصهٔ جلسه» — turning a transcript into something a busy manager reads.
 *
 * Two engines, one contract:
 *   • **AI** (when a key is configured) — reads the transcript and writes the
 *     summary, with a prompt that forbids anything not in the text.
 *   • **Local** (always available) — an extractive pass: it ranks the
 *     transcript's own sentences and quotes them. It never paraphrases, so it
 *     cannot invent; it is also not smart, and the UI says so.
 *
 * What neither engine does: score the person, recommend a hire, or describe a
 * personality. Those are decisions, and decisions belong to people with a name
 * attached — which is exactly what the scorecard and the activity log are for.
 */
import * as db from './db';
import { aiStatus, friendlyAiError, generate } from './ai/provider';
import { cleanAndParseJson } from './ai/screening';
import type { MeetingSummary, SummarySource } from '../src/types/summary';

export class SummaryError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'SUMMARY_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MIN_CHARS = 240;
const MAX_AI_CHARS = 14_000;

const STOPWORDS = new Set([
  'و', 'در', 'به', 'از', 'که', 'این', 'آن', 'را', 'با', 'برای', 'است', 'هست', 'بود', 'شد', 'می', 'شده', 'هم', 'یا',
  'تا', 'بر', 'یک', 'ما', 'شما', 'او', 'من', 'آنها', 'آن\u200cها', 'خود', 'خیلی', 'اگر', 'چون', 'ولی', 'اما', 'پس',
  'چه', 'چی', 'کجا', 'چطور', 'بله', 'نه', 'دیگه', 'دیگر', 'الان', 'بعد', 'قبل', 'رو', 'همین', 'همان', 'کرد', 'کردم',
  'کنم', 'کنیم', 'دارم', 'داریم', 'بوده', 'باشد', 'باشه', 'شود', 'بشه', 'یعنی', 'مثلا', 'مثلاً',
]);

/** Split on sentence enders while keeping the Persian question mark and ellipsis. */
export function splitSentences(text: string): string[] {
  return String(text || '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?؟…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

function words(sentence: string): string[] {
  return sentence
    .replace(/[.,!?؟…:؛«»"'()\[\]{}—–-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

const CONCERN = /(نمی‌?توانم|نمی‌?تونم|مشکل|نگران|نگرانی|ضعف|کمبود|ندارم|نبود|نمیدانم|نمی‌?دانم|دیر|سخت|محدودیت|ابهام|سؤال دارم|سوال دارم|مطمئن نیستم)/;
const NEXT = /(قرار است|قرار شد|قراره|هفتهٔ بعد|هفته بعد|فردا|تا (?:آخر|پایان)|می‌?فرستم|میفرستم|هماهنگ|تماس می‌?گیرم|پیگیری|بفرستید|ارسال کن|انجام می‌?دهم|انجام میدم|شروع می‌?کنم)/;

/**
 * The local engine. Every line it produces is a sentence that already exists in
 * the transcript — that is the whole point: no invention is possible.
 */
export function localSummary(text: string, title: string): Omit<MeetingSummary, 'id' | 'transcriptId' | 'resumeId' | 'jobId' | 'createdAtISO' | 'createdByName'> {
  const sentences = splitSentences(text);
  const freq = new Map<string, number>();
  for (const s of sentences) for (const w of words(s)) freq.set(w, (freq.get(w) || 0) + 1);

  const scored = sentences.map((s, i) => {
    const ws = words(s);
    const base = ws.reduce((sum, w) => sum + (freq.get(w) || 0), 0) / Math.max(1, Math.sqrt(ws.length || 1));
    // A sentence that names a number, a date or a commitment is usually the one
    // someone will need later.
    const bonus = /\d|[۰-۹]/.test(s) ? 1.2 : 0;
    return { s, i, score: base + bonus };
  });

  const pick = (pool: typeof scored, n: number) =>
    pool
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.s);

  // Concerns and commitments are read first, so a hesitation can never be
  // re-labelled as a highlight just because it scored well.
  const concerns = pick(scored.filter((x) => CONCERN.test(x.s)), 3);
  const nextSteps = pick(scored.filter((x) => NEXT.test(x.s) && !concerns.includes(x.s)), 3);
  const claimed = new Set([...concerns, ...nextSteps]);
  const highlights = pick(scored.filter((x) => !claimed.has(x.s)), Math.min(4, Math.max(1, Math.ceil(sentences.length / 8))));

  const used = new Set([...highlights, ...concerns, ...nextSteps]);
  const quotes = scored
    .filter((x) => !used.has(x.s) && x.s.length <= 260)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);

  const headline = (highlights[0] || sentences[0] || title).slice(0, 180);

  return {
    title,
    source: 'local',
    engineLabel: 'موتور محلی — جمله‌های خودِ رونویسی',
    headline,
    highlights,
    concerns,
    nextSteps,
    quotes,
    sentenceCount: sentences.length,
  };
}

function cleanList(value: unknown, max: number, maxLen = 260): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const s = v.replace(/\s+/g, ' ').trim();
    if (s.length < 8) continue;
    if (out.includes(s)) continue;
    out.push(s.slice(0, maxLen));
    if (out.length >= max) break;
  }
  return out;
}

function promptFor(title: string, text: string): { system: string; user: string } {
  const system = [
    'تو دستیار منابع انسانی هستی و فقط «خلاصهٔ یک رونویسی» می‌نویسی.',
    'قواعد سخت:',
    '۱) فقط چیزی را بنویس که در متن آمده است. هیچ حدس، تفسیر شخصیتی، نمره یا پیشنهاد استخدام نده.',
    '۲) اگر موضوعی در متن نیست، همان بخش را خالی بگذار؛ چیزی از خودت اضافه نکن.',
    '۳) زبان پاسخ فارسی روان و کوتاه است؛ جمله‌های طولانی را به دو جمله بشکن.',
    '۴) در «quotes» فقط جمله‌های عیناً موجود در متن را بگذار (کلمه‌به‌کلمه).',
    '۵) عدد، تاریخ و تعهدها را دقیقاً همان‌طور که گفته شده نقل کن.',
  ].join('\n');
  const user = [
    `عنوان گفت‌وگو: ${title}`,
    '',
    'متن رونویسی (ممکن است ناقص یا محاوره‌ای باشد):',
    '"""',
    text.slice(0, MAX_AI_CHARS),
    '"""',
    '',
    'فقط JSON معتبر با این ساختار بده:',
    '{"headline":"یک جمله که موضوع اصلی گفت‌وگو را می‌گوید","highlights":["۳ تا ۵ نکتهٔ مهم"],"concerns":["سؤال‌های باز، نگرانی‌ها یا ابهام‌ها؛ اگر نبود آرایهٔ خالی"],"nextSteps":["کارهای توافق‌شده و قدم بعدی؛ اگر نبود آرایهٔ خالی"],"quotes":["حداکثر ۲ جملهٔ عیناً نقل‌شده"]}',
  ].join('\n');
  return { system, user };
}

export interface SummaryResult {
  summary: db.SummaryRow;
  /** True when the AI was asked and could not answer, so the local engine wrote it. */
  fellBack: boolean;
  note: string | null;
}

export async function summarize(
  orgId: string,
  transcriptId: string,
  actorName: string | null
): Promise<SummaryResult> {
  const row = db.getTranscript(orgId, transcriptId);
  if (!row) throw new SummaryError('این رونویسی پیدا نشد.', 404, 'TRANSCRIPT_NOT_FOUND');
  if (row.status !== 'ready' || !row.text || row.text.trim().length < MIN_CHARS) {
    throw new SummaryError(
      'متن این رونویسی کوتاه‌تر از آن است که خلاصهٔ معناداری بدهد. اول متن را کامل کنید (دست‌کم چند جملهٔ گفت‌وگو).',
      409,
      'TEXT_TOO_SHORT'
    );
  }

  let payload: ReturnType<typeof localSummary> | null = null;
  let fellBack = false;
  let note: string | null = null;
  const ai = aiStatus();

  if (ai.available && !ai.coolingDown) {
    const { system, user } = promptFor(row.title || 'گفت‌وگو', row.text);
    try {
      const raw = await generate(user, {
        system,
        temperature: 0.2,
        timeoutMs: 30_000,
        deadlineMs: 55_000,
        purpose: 'other',
      });
      const parsed = cleanAndParseJson<any>(raw, null);
      const highlights = cleanList(parsed?.highlights, 5);
      const headline = typeof parsed?.headline === 'string' ? parsed.headline.trim().slice(0, 220) : '';
      if (headline && highlights.length) {
        payload = {
          title: row.title || 'گفت‌وگو',
          source: 'ai' as SummarySource,
          engineLabel: ai.label || 'هوش مصنوعی',
          headline,
          highlights,
          concerns: cleanList(parsed?.concerns, 4),
          nextSteps: cleanList(parsed?.nextSteps, 4),
          quotes: cleanList(parsed?.quotes, 2, 300),
          sentenceCount: splitSentences(row.text).length,
        };
      } else {
        fellBack = true;
        note = 'پاسخ هوش مصنوعی در قالب مورد نظر نبود؛ خلاصه با موتور محلی ساخته شد.';
      }
    } catch (err: any) {
      fellBack = true;
      note = `${friendlyAiError(err)} — خلاصه با موتور محلی ساخته شد.`;
    }
  } else {
    note = ai.reason || 'کلید هوش مصنوعی تنظیم نشده است؛ خلاصه با موتور محلی ساخته شد.';
  }

  const final = payload || localSummary(row.text, row.title || 'گفت‌وگو');
  const saved = db.saveSummary({
    id: db.uid('sum'),
    orgId,
    transcriptId: row.id,
    resumeId: row.resumeId,
    jobId: row.jobId,
    createdAtISO: new Date().toISOString(),
    createdByName: actorName,
    ...final,
  });

  db.logActivity(
    orgId,
    actorName ? { id: 'actor', name: actorName } : null,
    'summary.created',
    `خلاصهٔ گفت‌وگوی «${row.title}» را ساخت (${final.source === 'ai' ? 'هوش مصنوعی' : 'موتور محلی'})`,
    { jobId: row.jobId, resumeId: row.resumeId }
  );

  return { summary: saved, fellBack, note };
}

export function removeSummary(orgId: string, id: string): boolean {
  return db.deleteSummary(orgId, id);
}

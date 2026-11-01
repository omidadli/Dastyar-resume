/**
 * «عملکرد تیم» — who is actually doing the hiring work.
 *
 * Deliberately *not* a productivity score. It counts recorded work in this
 * workspace: decisions registered, scorecards written, notes written, interviews
 * held, offers sent, and how fast a candidate gets an answer. Nothing is derived
 * from keystrokes, and nothing is ranked — a member may be a hiring manager who
 * only joins interviews, and the table should show that instead of hiding them.
 */
import type { ReportRange, Role } from '../src/types/app';
import type { TeamMemberRow, TeamReport } from '../src/types/reports';

export interface TeamInput {
  range: ReportRange;
  nowISO: string;
  members: { id: string; name: string; role: Role; title: string }[];
  decisions: { resumeId: string; decidedBy: string | null; decidedAtISO: string; arrivedAtISO: string; approved: boolean }[];
  scorecards: { reviewerId: string; atISO: string }[];
  comments: { authorId: string; atISO: string }[];
  interviews: { interviewerIds: string[]; startsAtISO: string; status: string }[];
  offersSent: { userId: string | null; atISO: string }[];
  activity: { userId: string | null; atISO: string }[];
}

const HOURS = 3_600_000;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(raw * 10) / 10;
}

export function buildTeamReport(input: TeamInput): TeamReport {
  const { range, members } = input;
  const rows: TeamMemberRow[] = members.map((m) => {
    const mine = input.decisions.filter((d) => d.decidedBy === m.id);
    const decideHours = mine
      .map((d) => (new Date(d.decidedAtISO).getTime() - new Date(d.arrivedAtISO).getTime()) / HOURS)
      .filter((h) => Number.isFinite(h) && h >= 0);
    const interviews = input.interviews.filter((i) => i.interviewerIds.includes(m.id)).length;
    const scorecards = input.scorecards.filter((s) => s.reviewerId === m.id).length;
    const comments = input.comments.filter((c) => c.authorId === m.id).length;
    const offersSent = input.offersSent.filter((o) => o.userId === m.id).length;
    const stamps = [
      ...input.activity.filter((a) => a.userId === m.id).map((a) => a.atISO),
      ...mine.map((d) => d.decidedAtISO),
      ...input.scorecards.filter((s) => s.reviewerId === m.id).map((s) => s.atISO),
      ...input.comments.filter((c) => c.authorId === m.id).map((c) => c.atISO),
    ].sort();
    return {
      userId: m.id,
      name: m.name,
      role: m.role,
      title: m.title,
      decisions: mine.length,
      approved: mine.filter((d) => d.approved).length,
      rejected: mine.filter((d) => !d.approved).length,
      scorecards,
      comments,
      interviews,
      offersSent,
      totalActions: mine.length + scorecards + comments + interviews + offersSent,
      medianDecideHours: median(decideHours),
      lastActiveISO: stamps.length ? stamps[stamps.length - 1] : null,
    };
  });

  // Busiest first; a member with no recorded action still appears, at the end.
  rows.sort((a, b) => b.totalActions - a.totalActions || a.name.localeCompare(b.name, 'fa'));

  const totalOf = (pick: (r: TeamMemberRow) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const decisions = input.decisions.length;
  const busiest = rows.reduce((max, r) => Math.max(max, r.decisions), 0);
  const fast = input.decisions.filter((d) => {
    const h = (new Date(d.decidedAtISO).getTime() - new Date(d.arrivedAtISO).getTime()) / HOURS;
    return Number.isFinite(h) && h >= 0 && h <= 72;
  }).length;

  return {
    range,
    members: rows,
    totals: {
      decisions,
      approved: input.decisions.filter((d) => d.approved).length,
      rejected: input.decisions.filter((d) => !d.approved).length,
      scorecards: totalOf((r) => r.scorecards),
      comments: totalOf((r) => r.comments),
      interviews: totalOf((r) => r.interviews),
      offersSent: totalOf((r) => r.offersSent),
      activeMembers: rows.filter((r) => r.totalActions > 0).length,
      members: rows.length,
    },
    concentration: decisions ? Math.round((busiest / decisions) * 100) : null,
    fastShare: decisions ? Math.round((fast / decisions) * 100) : null,
  };
}

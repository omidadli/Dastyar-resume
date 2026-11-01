// ================================================================
// HOVIDA — «برابری فرصت‌ها» (EEO self-identification)
//
// A candidate may *voluntarily* say who they are; nobody in the workspace ever
// sees that answer next to a name. It exists only to answer one question —
// «آیا در هر مرحله، گروهی را بیشتر کنار می‌گذاریم؟» — and only in aggregate,
// with small groups suppressed so nobody can be re-identified.
// ================================================================

export type EeoGender = 'woman' | 'man' | 'other' | 'undisclosed';
export type EeoAgeBand = 'under25' | '25-34' | '35-44' | '45-54' | '55plus' | 'undisclosed';
export type EeoDisability = 'yes' | 'no' | 'undisclosed';

export interface EeoAnswer {
  gender: EeoGender;
  ageBand: EeoAgeBand;
  disability: EeoDisability;
}

export interface EeoConfig {
  /** Off by default: collecting this data is a deliberate decision, not a default. */
  enabled: boolean;
  /** Cells smaller than this are never shown. Five is the usual floor. */
  threshold: number;
}

export type EeoDimension = 'gender' | 'ageBand' | 'disability';

export interface EeoCell {
  key: string;
  label: string;
  applied: number;
  hired: number;
  /** True when the cell is smaller than the threshold — shown as «کمتر از ۵ نفر». */
  hidden: boolean;
  /** Applied → hired, in percent. Null when hidden or when nothing was hired. */
  hireRate: number | null;
}

export interface EeoReport {
  enabled: boolean;
  threshold: number;
  /** Applications in the period (all of them, disclosed or not). */
  total: number;
  /** How many said anything at all. */
  disclosed: number;
  /** Percent, 0 when there is nothing to compare. */
  disclosedRate: number;
  dimensions: { dimension: EeoDimension; title: string; note: string; cells: EeoCell[] }[];
  /** Hires per opening, in the same period. */
  byJob: { jobId: string; jobTitle: string; applied: number; hired: number; hidden: boolean }[];
  /** The honest sentence the page shows when the data is too thin to conclude anything. */
  note: string;
}

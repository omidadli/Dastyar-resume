/**
 * «بازارچهٔ آزمون» — tests that live outside HOVIDA.
 *
 * HOVIDA's own test bank (`assessment-bank.ts`) stays the default. This file is
 * about the other case: the workspace already pays for a test service (a
 * licensed personality inventory, a language exam, a proctored coding test) and
 * wants the invitation and the result to sit in the same candidate file.
 *
 * Two honest modes, because providers differ:
 *
 *   • `api`  — the provider speaks HTTP. HOVIDA opens a session
 *     (`POST {baseUrl}{sessionPath}`), receives the candidate's link, mails it
 *     from the workspace's own mailbox, and receives the result back through
 *     `POST /api/v1/results` (scope `assessments`).
 *   • `link` — the provider has no usable API (most Iranian test vendors). HR
 *     pastes the test link once; HOVIDA sends that link and, when the result
 *     arrives by e-mail or phone, HR records the score by hand. The record says
 *     `external` and names the provider.
 *
 * Nothing here is a claim of partnership: a provider is a row the customer
 * fills in. An unconnected workspace sees an empty state, not a fake catalogue.
 */
import type { AssessmentKind } from './assessment';

export type ProviderMode = 'api' | 'link';

/**
 * What the workspace can do with the connection right now.
 * `unchecked` is its own state on purpose: a URL and a key on file are not
 * evidence that anything answers, so nothing is «آماده» before a real check.
 */
export type ProviderState = 'ready' | 'unchecked' | 'unconfigured' | 'degraded';

export type ProviderCheckStatus = 'ok' | 'failed' | 'never';

export interface ProviderTest {
  /** Local id inside the provider row — stable across edits. */
  id: string;
  /** The provider's own test id, needed in `api` mode. */
  externalId: string | null;
  name: string;
  kind: AssessmentKind;
  durationMinutes: number;
  /** Dimension names, shown next to the result. May be empty. */
  dimensions: string[];
  /** `score` = one 0–100 number; `profile` = per-dimension numbers. */
  scoring: 'score' | 'profile';
  note: string | null;
}

export interface ProviderCheck {
  atISO: string;
  atJalali: string;
  ok: boolean;
  /** HTTP status, or null when the request never got an answer. */
  status: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface AssessmentProviderPublic {
  id: string;
  name: string;
  mode: ProviderMode;
  /** Host only — the path may itself be a secret. */
  endpointHost: string | null;
  sessionPath: string;
  checkPath: string;
  /** True only when a key is stored (encrypted). The key itself never leaves the server. */
  hasKey: boolean;
  /** Last four characters, so two keys are tellable apart. */
  keyHint: string | null;
  tests: ProviderTest[];
  state: ProviderState;
  /** Why the state is not `ready` — a sentence for the screen, not a code. */
  reason: string | null;
  lastCheck: ProviderCheck | null;
  createdAtISO: string;
  createdAtJalali: string;
  createdByName: string | null;
  updatedAtISO: string;
  updatedAtJalali: string;
  updatedByName: string | null;
  /** How many invitations this provider has carried, and how many came back. */
  invites: number;
  completed: number;
}

/** One provider as the send dialog sees it: its tests, and whether each can go out. */
export interface ProviderCatalog {
  id: string;
  name: string;
  mode: ProviderMode;
  state: ProviderState;
  reason: string | null;
  tests: Array<
    Pick<ProviderTest, 'id' | 'name' | 'kind' | 'durationMinutes' | 'dimensions' | 'scoring' | 'note'> & {
      ready: boolean;
      reason: string | null;
    }
  >;
}

export interface ProviderListPayload {
  items: AssessmentProviderPublic[];
  /** The contract HOVIDA speaks, printed on screen so a vendor can implement it. */
  contract: {
    check: string;
    session: string;
    result: string;
    scope: string;
  };
  summary: {
    total: number;
    ready: number;
    unchecked: number;
    unconfigured: number;
    degraded: number;
  };
}

/** What the workspace types in; the key is write-only. */
export interface ProviderInput {
  name: string;
  mode: ProviderMode;
  baseUrl: string;
  sessionPath?: string;
  checkPath?: string;
  /** Empty string on edit means «keep the stored key». */
  apiKey?: string;
  tests?: Array<{
    id?: string;
    externalId?: string | null;
    name: string;
    kind: AssessmentKind;
    durationMinutes?: number;
    dimensions?: string[] | string;
    scoring?: 'score' | 'profile';
    note?: string | null;
  }>;
}

export const PROVIDER_MODE_LABEL: Record<ProviderMode, string> = {
  api: 'API — خودِ هویدا جلسه می‌سازد',
  link: 'لینک — منابع انسانی نتیجه را ثبت می‌کند',
};

export const PROVIDER_STATE_LABEL: Record<ProviderState, string> = {
  ready: 'آماده',
  unchecked: 'بررسی‌نشده',
  unconfigured: 'تنظیم‌نشده',
  degraded: 'نیازمند بررسی',
};

/**
 * «توسعه‌دهندگان» — the public REST API and outbound webhooks.
 *
 * Two different doors for the same data: a key lets another system *pull*
 * (the customer's HRIS, their intranet, an internal dashboard), a webhook
 * *pushes* an event the moment it happens. Both belong to one workspace and
 * both can be revoked from the settings page in one click.
 */

/** Read-only keys can list; a write key may also record a decision. */
export type ApiScope = 'read' | 'write';

export interface ApiKeyPublic {
  id: string;
  name: string;
  /** `hvd_sk_1a2b3c4d` — enough to tell two keys apart, useless on its own. */
  prefix: string;
  scopes: ApiScope[];
  createdByName: string | null;
  createdAtISO: string;
  createdAtJalali: string;
  lastUsedAtISO: string | null;
  lastUsedAtJalali: string | null;
  /** How many calls this key has made — the honest answer to «کسی از آن استفاده می‌کند؟» */
  calls: number;
  revokedAtISO: string | null;
}

export interface CreatedApiKey {
  /** Shown exactly once, at creation time. Never stored in plain text. */
  key: string;
  record: ApiKeyPublic;
}

export interface WebhookEndpointPublic {
  id: string;
  /** «سامانهٔ منابع انسانی» — what this endpoint is for, in the team's words. */
  name: string;
  /** Host only: the path may itself be a secret (Slack-style endpoints). */
  urlHost: string;
  /** `https://example.com/hooks/••••` — recognisable, not reusable. */
  urlMasked: string;
  events: string[];
  active: boolean;
  createdAtISO: string;
  createdAtJalali: string;
  lastDeliveryAtISO: string | null;
  lastDeliveryAtJalali: string | null;
  lastStatus: number | null;
  lastOk: boolean | null;
  lastError: string | null;
  /** Consecutive failures; the settings page warns after a few. */
  failures: number;
  /** Last four characters of the signing secret, so two endpoints are distinguishable. */
  secretHint: string;
}

export interface WebhookDeliveryPublic {
  id: string;
  endpointId: string;
  event: string;
  atISO: string;
  atJalali: string;
  ok: boolean;
  status: number | null;
  durationMs: number;
  error: string | null;
}

export interface WebhookTestResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface DeveloperOverview {
  /** `https://<host>/api/v1` — the exact base address to paste into another system. */
  baseUrl: string;
  docsPath: string;
  keys: ApiKeyPublic[];
  webhooks: WebhookEndpointPublic[];
  deliveries: WebhookDeliveryPublic[];
  /** The events a webhook may subscribe to, with Persian labels. */
  events: { id: string; label: string }[];
  scopes: { id: ApiScope; label: string; hint: string }[];
}

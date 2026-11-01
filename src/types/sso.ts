/**
 * Public + workspace shapes for «ورود سازمانی (SSO)».
 *
 * The client secret, the raw token and the provider keys never reach the
 * browser: the admin sees whether the connection works, not how it is keyed.
 */
import type { Role } from './app';

export interface SsoStatus {
  /** A complete, enabled configuration exists. */
  enabled: boolean;
  issuer: string | null;
  clientId: string | null;
  /** Email domains allowed to sign in through this workspace. */
  domains: string[];
  /** Create a member on first successful login (otherwise people must be invited first). */
  autoJoin: boolean;
  /** Role given to a member created by auto-join. */
  defaultRole: Exclude<Role, 'owner'>;
  /** Refuse password login for these domains — SSO only. */
  requireSso: boolean;
  clientSecretSet: boolean;
  updatedAtISO: string | null;
  updatedByName: string | null;
  lastLoginAtISO: string | null;
  lastError: string | null;
  /** The exact redirect URI to paste into the provider's console. */
  redirectUri: string;
}

export interface SsoSaveInput {
  issuer: string;
  clientId: string;
  /** Omit to keep the stored secret. */
  clientSecret?: string;
  domains: string[];
  autoJoin?: boolean;
  defaultRole?: Exclude<Role, 'owner'>;
  requireSso?: boolean;
}

export interface SsoCheck {
  ok: boolean;
  issuer: string | null;
  message: string;
  authorizationEndpoint?: string | null;
  tokenEndpoint?: string | null;
  keys?: number;
}

/** What the login page may learn about one email domain. */
export interface SsoLookup {
  available: boolean;
  /** Workspace name — so the person sees whose door they are knocking on. */
  orgName: string | null;
  /** True when this domain may not use a password at all. */
  passwordBlocked: boolean;
}

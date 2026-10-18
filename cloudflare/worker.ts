/**
 * HOVIDA (هویدا) on Cloudflare — the Worker entry (see wrangler.jsonc).
 *
 *   browser ─► Worker ─┬─ static assets (dist/): pages, bundles, fonts
 *                      └─ /api/* ─► Durable Object «main» ─► container (Node server, Dockerfile)
 *                                                               │ http://storage.hovida
 *                                                               ▼
 *                                         outbound handler ─► D1 (data and resume files)
 *
 * One container instance holds the app (its data lives in memory and is saved
 * to D1 as it changes), so every request goes to the same Durable Object.
 * The container sleeps after CONTAINER_SLEEP_AFTER without traffic; the next
 * request wakes it in a few seconds and it loads its data back from R2.
 */
import { Container, ContainerProxy } from '@cloudflare/containers';
import { routeRequest, CLIENT_IP_HEADER } from './router';
import { handleD1StorageRequest } from './d1-storage-handler';

// Required for outbound interception (the container → R2 bridge).
export { ContainerProxy };

export interface Env {
  ASSETS: Fetcher;
  HOVIDA_SERVER: DurableObjectNamespace<HovidaServer>;
  DB: D1Database;
  /** How long the container stays up without requests (e.g. "30m", "2h"). */
  CONTAINER_SLEEP_AFTER?: string;
  APP_SECRET?: string;
  ADMIN_EMAILS?: string;
  AI_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  DISABLE_DEMO?: string;
  LEGACY_OWNER_EMAIL?: string;
}

/** Worker variables and secrets handed to the Node server as environment. */
export const PASS_THROUGH = [
  'APP_SECRET',
  'ADMIN_EMAILS',
  'AI_PROVIDER',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'DISABLE_DEMO',
  'LEGACY_OWNER_EMAIL',
] as const;

export const STORAGE_HOST = 'storage.hovida';
export const SERVER_PORT = 8080;
const DATA_PREFIX = 'data/';

export function containerEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: String(SERVER_PORT),
    HOVIDA_PLATFORM: 'cloudflare',
    STORAGE_DRIVER: 'remote',
    STORAGE_URL: `http://${STORAGE_HOST}`,
    CLIENT_IP_HEADER,
  };
  for (const key of PASS_THROUGH) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') out[key] = value;
  }
  return out;
}

/** Fingerprint of the settings the running container was started with. */
const SETTINGS_KEY = 'hovida:settings';

async function fingerprint(vars: Record<string, string>): Promise<string> {
  const text = JSON.stringify(Object.keys(vars).sort().map((k) => [k, vars[k]]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class HovidaServer extends Container<Env> {
  defaultPort = SERVER_PORT;
  sleepAfter: string | number = '30m';
  enableInternet = true; // the AI providers
  private restarting: Promise<void> | null = null;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.sleepAfter = env.CONTAINER_SLEEP_AFTER?.trim() || '30m';
    this.envVars = containerEnv(env);
  }

  override async fetch(request: Request): Promise<Response> {
    const wanted = await fingerprint(this.envVars ?? {});
    if (this.restarting) await this.restarting;
    let state = await this.getState();
    // A secret or variable changed (dashboard, `wrangler secret put`): the
    // server only reads its settings when it starts, so restart it now rather
    // than whenever it next falls asleep.
    if (state.status === 'healthy' || state.status === 'running') {
      const startedWith = await this.ctx.storage.get<string>(SETTINGS_KEY);
      if (startedWith && startedWith !== wanted) {
        this.restarting ??= this.restartForNewSettings().finally(() => {
          this.restarting = null;
        });
        await this.restarting;
        state = await this.getState();
      }
    }
    // A cold start boots Node and reads the data back from R2 — allow it more
    // time than the library's defaults.
    if (state.status !== 'healthy') {
      await this.ctx.storage.put(SETTINGS_KEY, wanted);
      try {
        await this.startAndWaitForPorts({
          ports: SERVER_PORT,
          cancellationOptions: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 150_000, waitInterval: 400, abort: request.signal },
        });
      } catch (err) {
        console.error('[hovida] the server container did not start:', (err as Error)?.message || err);
        return new Response('container did not start', { status: 503 });
      }
    }
    return this.containerFetch(request, SERVER_PORT);
  }

  /** SIGTERM: the server finishes open requests and saves its data to R2, then exits. */
  private async restartForNewSettings() {
    console.log('[hovida] settings changed — restarting the server container to apply them');
    await this.stop('SIGTERM');
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
      const s = await this.getState();
      if (s.status === 'stopped' || s.status === 'stopped_with_code') return;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });
    }
    console.warn('[hovida] the server container did not stop in time — stopping it hard');
    await this.destroy();
  }

  override onStart() {
    console.log('[hovida] server container started');
  }

  override onStop(params: { exitCode: number; reason: string }) {
    console.log(`[hovida] server container stopped (${params.reason}, exit ${params.exitCode})`);
  }

  override onError(error: unknown) {
    console.error('[hovida] server container error:', error);
    throw error;
  }
}

HovidaServer.outboundByHost = {
  [STORAGE_HOST]: (request: Request, env: Env) => handleD1StorageRequest(request, env.DB, { prefix: DATA_PREFIX }),
};

function server(env: Env) {
  // Western Europe: close to Iran's international routes, and inside the
  // regions where the Gemini API is available.
  return env.HOVIDA_SERVER.get(env.HOVIDA_SERVER.idFromName('main'), { locationHint: 'weur' });
}

export default {
  fetch(request, env) {
    return routeRequest(request, { assets: env.ASSETS, backend: (req) => server(env).fetch(req) });
  },
} satisfies ExportedHandler<Env>;

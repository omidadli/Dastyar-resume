/**
 * Test harness only (never deployed): the production edge router
 * (cloudflare/router.ts) with the real static-assets routing of wrangler.jsonc,
 * but /api/* proxied to a locally running Node server (BACKEND_URL) instead of
 * the container — Docker isn't needed to test the edge.
 */
import { routeRequest } from '../../cloudflare/router';

interface Env {
  ASSETS: Fetcher;
  BACKEND_URL: string;
}

export default {
  fetch(request, env) {
    return routeRequest(request, {
      assets: env.ASSETS,
      backend: (req) => {
        const url = new URL(req.url);
        return fetch(new Request(new URL(url.pathname + url.search, env.BACKEND_URL), req));
      },
    });
  },
} satisfies ExportedHandler<Env>;

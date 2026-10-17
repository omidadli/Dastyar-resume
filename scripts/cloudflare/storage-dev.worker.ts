/**
 * Test harness only (never deployed): serves cloudflare/storage-handler.ts over
 * plain HTTP with a local R2 bucket (wrangler dev / Miniflare), so the real
 * handler can be exercised by the Node server and scripts/cloudflare.test.ts.
 */
import { handleStorageRequest } from '../../cloudflare/storage-handler';

interface Env {
  DATA: R2Bucket;
}

export default {
  fetch(request, env) {
    return handleStorageRequest(request, env.DATA, { prefix: 'data/' });
  },
} satisfies ExportedHandler<Env>;

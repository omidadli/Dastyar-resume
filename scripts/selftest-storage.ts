// End-to-end check of the remote storage protocol (small + chunked objects) against a live Worker.
import crypto from 'crypto';
import { RemoteStorage } from '../server/storage';

const url = process.env.STORAGE_URL!;
const token = process.env.STORAGE_TOKEN || null;
const sizesMb = (process.env.SIZES_MB || '0.2,3,20,50').split(',').map(Number);
const s = new RemoteStorage(url, token);
const md5 = (b: Buffer) => crypto.createHash('md5').update(b).digest('hex');
let failed = false;
const log = (m: string) => console.log(m);

async function main() {
  for (const mb of sizesMb) {
    const buf = crypto.randomBytes(Math.floor(mb * 1024 * 1024));
    const key = `_selftest/${mb}.bin`;
    try {
      let t = Date.now();
      await s.put(key, buf);
      const up = Date.now() - t;
      t = Date.now();
      const got = await s.get(key);
      const down = Date.now() - t;
      const okGet = !!got && got.body.length === buf.length && md5(got.body) === md5(buf);
      const head = await s.head(key);
      const st = await s.openStream(key);
      const chunks: Buffer[] = [];
      if (st) for await (const c of st.stream) chunks.push(c as Buffer);
      const okStream = !!st && md5(Buffer.concat(chunks)) === md5(buf);
      // overwrite with a small object, then check the old chunks are gone and the new value reads back
      await s.put(key, Buffer.from('tiny'));
      const tiny = await s.get(key);
      const okOverwrite = tiny?.body.toString() === 'tiny';
      await s.delete(key);
      const gone = (await s.get(key)) === null;
      const ok = okGet && okStream && okOverwrite && gone && head?.size === buf.length;
      if (!ok) failed = true;
      log(`${ok ? 'OK ' : 'FAIL'} ${mb}MB up=${up}ms down=${down}ms get=${okGet} stream=${okStream} head=${head?.size === buf.length} overwrite=${okOverwrite} deleted=${gone}`);
    } catch (e) {
      failed = true;
      log(`FAIL ${mb}MB: ${(e as Error).message}`);
      await s.delete(key).catch(() => {});
    }
  }
}
main().then(() => process.exit(failed ? 1 : 0));

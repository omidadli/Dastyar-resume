/**
 * «SCIM 2.0» — provisioning from an identity provider, end to end.
 *
 * What an IT department will actually check before signing off:
 *   • a token is issued once, stored only as a hash, and 401s otherwise;
 *   • Okta's `userName eq "…"` filter works, an unsupported filter is refused;
 *   • POST creates a member, duplicates are refused with `uniqueness`;
 *   • PATCH `active:false` disables the account, ends its sessions and blocks
 *     login — and DELETE deactivates rather than erasing the person;
 *   • only an owner-issued token may grant admin, and nobody may touch the owner;
 *   • an admin can then give that provisioned member a password;
 *   • revoking the token locks the door immediately, and it all survives a restart.
 *
 * Run with: npm run build && npx tsx scripts/scim-api.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-scim-'));
  const PORT = 4400 + Math.floor(Math.random() * 150);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'scim-secret-0123456789',
    AI_PROVIDER: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['PUBLIC_URL', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ADMIN_EMAILS']) delete env[k];
  let child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const boot = async () => {
    log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const started = Date.now();
    while (!/آماده است/.test(log) && Date.now() - started < 25_000) await new Promise((r) => setTimeout(r, 150));
  };
  await boot();

  const call = async (method: string, url: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(BASE + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': url.startsWith('/scim') ? 'application/scim+json' : 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text, headers: res.headers };
  };

  try {
    // ------------------------------------------------------------ workspace ----
    const owner = await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت بزرگ',
      name: 'مالک',
      email: 'owner@example.com',
      password: 'Owner12345',
    });
    const A = owner.json.token as string;
    const admin = await call('POST', '/api/org/members', A, { name: 'مدیر دوم', email: 'admin2@example.com', title: 'مدیر', role: 'admin', password: 'Admin12345' });
    const AD = (await call('POST', '/api/auth/login', null, { email: 'admin2@example.com', password: 'Admin12345' })).json.token as string;
    assert(admin.status === 201 && Boolean(AD), 'a second admin exists');

    // ---------------------------------------------------------------- no token ----
    const noToken = await call('GET', '/scim/v2/Users');
    assert(noToken.status === 401, 'without a token SCIM answers 401', `${noToken.status}`);
    assert(noToken.json.scimType === 'invalidToken', 'with a SCIM error type', String(noToken.json.scimType));
    assert(String(noToken.headers.get('www-authenticate') || '').startsWith('Bearer'), 'and a Bearer challenge');

    const memberTry = await call('POST', '/api/developer/scim', AD);
    assert(memberTry.status === 201, 'an admin may issue a token', `${memberTry.status}`);
    const adminToken = memberTry.json.token as string;
    assert(/^hvd_scim_[a-f0-9]{12}_/.test(adminToken), 'the token has the documented shape');

    const ownerIssue = await call('POST', '/api/developer/scim', A);
    const TOKEN = ownerIssue.json.token as string;
    assert(ownerIssue.status === 201 && ownerIssue.json.scim.configured === true, 'the owner issues a token too (the previous one is replaced)');
    assert(!ownerIssue.text.includes('tokenHash'), 'the response never contains the stored hash');

    const oldStillWorks = await call('GET', '/scim/v2/Users', adminToken);
    assert(oldStillWorks.status === 401, 'issuing a new token revokes the old one', `${oldStillWorks.status}`);

    // ------------------------------------------------------------ discovery ----
    const spc = await call('GET', '/scim/v2/ServiceProviderConfig', TOKEN);
    assert(spc.status === 200 && spc.json.patch.supported === true, 'ServiceProviderConfig advertises PATCH', `${spc.status}`);
    assert(spc.json.filter.supported === true && spc.json.bulk.supported === false, 'and says honestly what it does not support');
    const types = await call('GET', '/scim/v2/ResourceTypes', TOKEN);
    assert(types.json.Resources.length === 2, 'two resource types');

    // --------------------------------------------------------------- create ----
    const created = await call('POST', '/scim/v2/Users', TOKEN, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'Sara@Example.com',
      name: { givenName: 'سارا', familyName: 'محمدی' },
      title: 'کارشناس جذب',
      roles: [{ value: 'member' }],
      active: true,
    });
    assert(created.status === 201, 'a member is provisioned', `${created.status}`);
    assert(created.json.userName === 'sara@example.com', 'the userName is normalised to lower case', created.json.userName);
    assert(created.json.displayName === 'سارا محمدی', 'the name is composed from given/family', created.json.displayName);
    assert(created.json.active === true && created.json.id, 'and the resource is active with an id');
    assert(String(created.headers.get('location') || '').includes(created.json.id), 'Location points at the new resource');
    const saraId = created.json.id as string;

    const dup = await call('POST', '/scim/v2/Users', TOKEN, { userName: 'sara@example.com', name: { formatted: 'سارا' } });
    assert(dup.status === 409 && dup.json.scimType === 'uniqueness', 'a duplicate userName is refused as unique', `${dup.status}`);

    const badEmail = await call('POST', '/scim/v2/Users', TOKEN, { userName: 'not-an-email' });
    assert(badEmail.status === 400, 'a non-email userName is refused', `${badEmail.status}`);

    const adminByOwnerToken = await call('POST', '/scim/v2/Users', TOKEN, { userName: 'boss@example.com', name: { formatted: 'رئیس' }, roles: [{ value: 'admin' }] });
    assert(adminByOwnerToken.status === 201 && adminByOwnerToken.json.roles[0].value === 'admin', 'an owner-issued token may grant admin', `${adminByOwnerToken.status}`);
    const ownerAttempt = await call('POST', '/scim/v2/Users', TOKEN, { userName: 'owner2@example.com', name: { formatted: 'مالک دوم' }, roles: [{ value: 'owner' }] });
    assert(ownerAttempt.status === 403, 'SCIM cannot create an owner', `${ownerAttempt.status}`);

    // ---------------------------------------------------------------- filter ----
    const filtered = await call('GET', `/scim/v2/Users?filter=${encodeURIComponent('userName eq "sara@example.com"')}`, TOKEN);
    assert(filtered.status === 200 && filtered.json.totalResults === 1, 'userName eq works', `${filtered.json.totalResults}`);
    assert(filtered.json.Resources[0].id === saraId, 'and returns the right person');
    const badFilter = await call('GET', `/scim/v2/Users?filter=${encodeURIComponent('displayName co "س"')}`, TOKEN);
    assert(badFilter.status === 400 && badFilter.json.scimType === 'invalidFilter', 'an unsupported filter is refused, not ignored', `${badFilter.status}`);

    // --------------------------------------------------- login before/after ----
    const beforeDisable = await call('POST', '/api/auth/login', null, { email: 'sara@example.com', password: 'whatever' });
    assert(beforeDisable.status === 401, 'the provisioned member has no usable password yet', `${beforeDisable.status}`);

    const pw = await call('POST', `/api/org/members/${saraId}/password`, A, { password: 'SaraPass12345' });
    assert(pw.status === 200 && !pw.json.password, 'an admin sets a password (nothing generated)');
    const saraSession = await call('POST', '/api/auth/login', null, { email: 'sara@example.com', password: 'SaraPass12345' });
    assert(saraSession.status === 200 && Boolean(saraSession.json.token), 'and she can sign in', `${saraSession.status}`);
    const S = saraSession.json.token as string;
    assert((await call('GET', '/api/jobs', S)).status === 200, 'with a working session');

    // ------------------------------------------------------------- deactivate ----
    const patched = await call('PATCH', `/scim/v2/Users/${saraId}`, TOKEN, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    assert(patched.status === 200 && patched.json.active === false, 'PATCH active:false deactivates', `${patched.status}`);
    assert((await call('GET', '/api/jobs', S)).status === 401, 'her session is ended immediately');
    assert((await call('POST', '/api/auth/login', null, { email: 'sara@example.com', password: 'SaraPass12345' })).status === 403, 'and login is refused as disabled');

    const reactivated = await call('PATCH', `/scim/v2/Users/${saraId}`, TOKEN, {
      Operations: [{ op: 'replace', path: 'active', value: true }],
    });
    assert(reactivated.json.active === true, 're-activation works');
    assert((await call('POST', '/api/auth/login', null, { email: 'sara@example.com', password: 'SaraPass12345' })).status === 200, 'and the old password works again');

    // -------------------------------------------------------------- names/roles ----
    const renamed = await call('PATCH', `/scim/v2/Users/${saraId}`, TOKEN, {
      Operations: [{ op: 'replace', path: 'name.givenName', value: 'سارا کوچک' }],
    });
    assert(renamed.json.displayName.startsWith('سارا کوچک'), 'name.givenName is applied', renamed.json.displayName);

    const badPath = await call('PATCH', `/scim/v2/Users/${saraId}`, TOKEN, { Operations: [{ op: 'replace', path: 'nickName', value: 'x' }] });
    assert(badPath.status === 400 && badPath.json.scimType === 'invalidPath', 'an unsupported path is refused', `${badPath.status}`);

    const ownerProtected = await call('PATCH', `/scim/v2/Users/${(await call('GET', '/api/org', A)).json.members.find((m: any) => m.role === 'owner').id}`, TOKEN, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    assert(ownerProtected.status === 403, 'the workspace owner cannot be switched off by SCIM', `${ownerProtected.status}`);

    // --------------------------------------------------------------- delete ----
    const del = await call('DELETE', `/scim/v2/Users/${saraId}`, TOKEN);
    assert(del.status === 204, 'DELETE answers 204', `${del.status}`);
    const afterDelete = await call('GET', `/scim/v2/Users/${saraId}`, TOKEN);
    assert(afterDelete.status === 200 && afterDelete.json.active === false, 'the person is kept, deactivated (history is not erased)');
    const team = await call('GET', '/api/org', A);
    const sara = team.json.members.find((m: any) => m.id === saraId);
    assert(Boolean(sara) && sara.disabled === true, 'and still a member of record, marked disabled');

    // -------------------------------------------------------------- groups ----
    const groups = await call('GET', '/scim/v2/Groups', TOKEN);
    assert(groups.json.totalResults === 3, 'owner/admin/member groups exist', `${groups.json.totalResults}`);
    const groupWrite = await call('POST', '/scim/v2/Groups', TOKEN, { displayName: 'x' });
    assert(groupWrite.status === 501 && groupWrite.json.scimType === 'notImplemented', 'writing a group is refused honestly', `${groupWrite.status}`);

    // ------------------------------------------------------------- revocation ----
    await call('DELETE', '/api/developer/scim', A);
    assert((await call('GET', '/scim/v2/Users', TOKEN)).status === 401, 'a revoked token stops working at once');

    // ------------------------------------------------------------ persistence ----
    const again = await call('POST', '/api/developer/scim', A);
    const T2 = again.json.token as string;
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 700));
    child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await boot();
    const afterRestart = await call('GET', '/scim/v2/Users', T2);
    assert(afterRestart.status === 200, 'the token and the provisioned people survive a restart', `${afterRestart.status}`);
    const saraAfter = afterRestart.json.Resources.find((u: any) => u.id === saraId);
    assert(Boolean(saraAfter) && saraAfter.active === false, 'including their deactivated state');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

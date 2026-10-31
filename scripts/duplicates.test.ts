/**
 * Duplicate detection («رزومهٔ تکراری») against a department's own history.
 * Run with: npx tsx scripts/duplicates.test.ts
 */
import { refreshDuplicates, resumeFileHash } from '../server/duplicates';
import type { ResumeRecord } from '../src/types/screening';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

let seq = 0;
function rec(over: Partial<ResumeRecord>): ResumeRecord {
  seq++;
  return {
    id: `res_${seq}`,
    jobId: 'job_1',
    orgId: 'org_1',
    uploadedBy: null,
    departmentId: 'sales',
    departmentName: 'فروش',
    roleTitle: 'کارشناس فروش',
    fileName: `resume-${seq}.pdf`,
    filePath: null,
    fileSize: 1000,
    extractedText: `متن رزومهٔ شمارهٔ ${seq} `.repeat(20),
    unjudgeableReason: null,
    errorMessage: null,
    candidateName: null,
    contact: { phone: null, email: null, city: null },
    facts: null,
    criterionScores: [],
    score: 60,
    confidence: 'medium',
    engine: 'ai',
    recommendation: 'REVIEW',
    summary: '',
    whyCategory: '',
    strengths: [],
    weaknesses: [],
    knockoutMisses: [],
    tags: [],
    bankSuggested: false,
    flags: null,
    deepFindings: null,
    category: 'REVIEW',
    rankInCategory: null,
    analysisHistory: [],
    inBank: false,
    bankDepartmentId: null,
    bankNote: null,
    bankTags: [],
    addedToBankAtJalali: null,
    addedToBankAtISO: null,
    messageStatus: 'none',
    lastMessagedAtJalali: null,
    decisionStatus: 'none',
    decidedAtJalali: null,
    decidedAtISO: null,
    decidedBy: null,
    decidedByName: null,
    decisionNote: null,
    deepAnalysisAtJalali: null,
    createdAtISO: `2026-01-0${Math.min(seq, 9)}T08:00:00.000Z`,
    createdAtJalali: '',
    updatedAtISO: '',
    ...over,
  } as ResumeRecord;
}

const file = (t: string) => resumeFileHash(Buffer.from(t).toString('base64'));

// ---- 1. an identical file re-uploaded in the same department is a duplicate ----
{
  const h = file('same-bytes');
  const a = rec({ fileHash: h });
  const b = rec({ fileHash: h, createdAtISO: '2026-01-02T09:00:00.000Z' });
  refreshDuplicates([a, b]);
  assert(a.novelty === 'new', 'the first screening of a department is «جدید»', a.novelty);
  assert(b.novelty === 'duplicate' && b.duplicateOf?.reason === 'file', 'the same file in the same department is «تکراری»', b.duplicateOf?.reason);
  assert(b.duplicateOf?.resumeId === a.id && b.duplicateOf?.jobId === a.jobId, 'the duplicate points at the earlier record and its opening');
}

// ---- 2. identical extracted text (a re-saved/renamed PDF) is a duplicate ----
{
  const text = 'علی رضایی — کارشناس فروش، ۵ سال سابقه، CRM و مذاکره. '.repeat(4);
  const a = rec({ extractedText: text });
  const b = rec({ extractedText: text.replace(/ي/g, 'ی').replace(/\s+/g, '  ').replace(/\u200c/g, ''), createdAtISO: '2026-02-01T09:00:00.000Z' });
  refreshDuplicates([a, b]);
  assert(b.novelty === 'duplicate' && b.duplicateOf?.reason === 'text', 'normalised identical text counts as a duplicate', b.duplicateOf?.reason);
}

// ---- 3. phone/email identity survives formatting ----
{
  const a = rec({ contact: { phone: '۰۹۱۲ ۳۴۵ ۶۷۸۹', email: 'Ali@Example.com', city: 'تهران' } });
  const b = rec({ contact: { phone: '+989123456789', email: null, city: null }, createdAtISO: '2026-03-01T09:00:00.000Z' });
  const c = rec({ contact: { phone: null, email: ' ali@example.COM ', city: null }, createdAtISO: '2026-03-02T09:00:00.000Z' });
  refreshDuplicates([a, b, c]);
  assert(b.novelty === 'duplicate' && b.duplicateOf?.reason === 'phone', 'the same phone number in another format is a duplicate');
  assert(c.novelty === 'duplicate' && c.duplicateOf?.reason === 'email', 'the same email in another case is a duplicate');
}

// ---- 4. scope: another department or another workspace is a fresh candidate ----
{
  const h = file('cross-scope');
  const a = rec({ fileHash: h });
  const otherDept = rec({ fileHash: h, departmentId: 'marketing', departmentName: 'بازاریابی' });
  const otherOrg = rec({ fileHash: h, orgId: 'org_2' });
  refreshDuplicates([a, otherDept, otherOrg]);
  assert(a.novelty === 'new', 'the original stays «جدید»');
  assert(otherDept.novelty === 'new', 'the same CV applied to another department is «جدید» there', otherDept.novelty);
  assert(otherOrg.novelty === 'new', 'another workspace never sees this history', otherOrg.novelty);
}

// ---- 5. a name or file name alone is not proof of a duplicate ----
{
  const a = rec({ candidateName: 'سارا محمدی', fileName: 'sara.pdf' });
  const b = rec({ candidateName: 'سارا محمدی', fileName: 'sara.pdf', createdAtISO: '2026-04-01T09:00:00.000Z' });
  refreshDuplicates([a, b]);
  assert(b.novelty === 'new', 'two different resumes with the same name are both «جدید»', b.novelty);
}

// ---- 6. no readable signal → neither label ----
{
  const a = rec({ extractedText: '', contact: null, fileHash: null });
  refreshDuplicates([a]);
  assert(a.novelty === 'unknown', 'an unreadable resume is «نامشخص»، not «جدید»', a.novelty);
}

// ---- 7. deleting the original promotes the next screening to «جدید» ----
{
  const h = file('deleted-original');
  const a = rec({ fileHash: h });
  const b = rec({ fileHash: h, createdAtISO: '2026-05-01T09:00:00.000Z' });
  const c = rec({ fileHash: h, createdAtISO: '2026-05-02T09:00:00.000Z' });
  refreshDuplicates([a, b, c]);
  assert(b.novelty === 'duplicate' && c.novelty === 'duplicate', 'both later uploads are duplicates while the original exists');
  refreshDuplicates([b, c]);
  assert(b.novelty === 'new' && c.novelty === 'duplicate' && c.duplicateOf?.resumeId === b.id, 'after deletion the earliest remaining record becomes the reference');
}

// ---- 8. rebuilding is stable (an idempotent flag, not a stored decision) ----
{
  const h = file('idempotent');
  const a = rec({ fileHash: h });
  const b = rec({ fileHash: h, createdAtISO: '2026-06-01T09:00:00.000Z' });
  refreshDuplicates([a, b]);
  const first = JSON.stringify(b.duplicateOf);
  refreshDuplicates([a, b]);
  assert(JSON.stringify(b.duplicateOf) === first && b.novelty === 'duplicate', 're-indexing does not drift');
}

if (failures > 0) {
  console.error(`\n${failures} duplicate-detection test(s) failed.`);
  process.exit(1);
}
console.log('\nAll duplicate-detection tests passed.');

// ================================================================
// HOVIDA («هویدا») — shared domain types for resume screening.
// Used by both the React client and the Express server.
// ================================================================

export type Recommendation = 'INTERVIEW' | 'REVIEW' | 'REJECT';
/**
 * Internal AI category codes. They are never shown raw in the UI: the client
 * maps them to match-level labels («تطابق بالا / نیازمند بررسی / تطابق پایین /
 * اطلاعات ناکافی») — the AI describes the match, a human makes the decision.
 */
export type ResumeCategory = 'INTERVIEW' | 'REVIEW' | 'REJECT' | 'UNJUDGEABLE' | 'ERROR';
export type Confidence = 'high' | 'medium' | 'low';
export type AnalysisEngine = 'ai' | 'local';

/** Human decision on a candidate. `none` = nobody has decided yet. */
export type DecisionStatus = 'none' | 'approved' | 'rejected' | 'review';
export type DecidedStatus = Exclude<DecisionStatus, 'none'>;

/** `standard` = fast screening pass, `deep` = user-requested evidence-by-evidence review. */
export type AnalysisMode = 'standard' | 'deep';

export interface Criterion {
  id: string;
  title: string;
  weight: number; // sums to 100 across criteria
  mustHave: boolean;
}

// ---------- Screening questionnaire ----------

export type QuestionKind = 'knockout' | 'bonus';

export interface BooleanQuestion {
  id: string;
  kind: QuestionKind;
  type: 'boolean';
  label: string;
  weight: number;
  defaultChecked: boolean;
}

export interface SingleChoiceQuestion {
  id: string;
  kind: QuestionKind;
  type: 'single';
  label: string;
  weight: number;
  options: { value: string; label: string }[];
  defaultValue: string;
}

export interface MultiChoiceQuestion {
  id: string;
  kind: QuestionKind;
  type: 'multi';
  label: string;
  weight: number;
  options: { value: string; label: string }[];
  defaultValues: string[];
}

export type ScreeningQuestion = BooleanQuestion | SingleChoiceQuestion | MultiChoiceQuestion;

/** Answers keyed by question id: boolean → boolean, single → string, multi → string[] */
export type ScreeningAnswers = Record<string, boolean | string | string[]>;

export interface Thresholds {
  interview: number; // 70-85
  review: number; // 45-60
}

export interface JobUnderstanding {
  department: string;
  departmentId: string;
  roleTitle: string;
  seniority: string;
  plainExplanation: string;
  thresholds: Thresholds;
  criteria: Criterion[];
  questions: ScreeningQuestion[];
}

/** Where a job's criteria came from — shown honestly in the UI. */
export type CriteriaSource = 'ai' | 'template';

// ---------- Resume evaluation ----------

export interface CandidateContact {
  phone: string | null;
  email: string | null;
  city: string | null;
}

export interface CandidateFacts {
  yearsExperience: number | null;
  education: string | null;
  lastRole: string | null;
  skills: string[];
  expectedSalary: string | null;
}

export interface CriterionScore {
  criterionId: string;
  title?: string;
  score: number; // 0-100
  rationale: string;
  evidence: string; // real quote from the resume
}

export interface EvidencePoint {
  point: string;
  evidence: string;
  severity?: 'knockout' | 'major' | 'minor';
}

export interface EvaluationFlags {
  irrelevant: boolean;
  insufficientInfo: boolean;
  scannedNoText: boolean;
  /** The file is not a resume (cover letter only, certificate, ID card, job ad…). */
  notResume?: boolean;
  /** The file holds more than one person's resume; the first/main one was evaluated. */
  multipleCandidates?: boolean;
  /** Parts of the document could not be read (blurry scan, cut pages…). */
  partiallyReadable?: boolean;
  /** Only the AI can read this file (scan, photo, audio…) and it was unavailable — re-run later. */
  needsAi?: boolean;
}

/** How a resume was read and judged — shown in the candidate panel and admin reports. */
export interface EvaluationMeta {
  /** Human label of the source format, e.g. «PDF اسکن‌شده», «پاورپوینت». */
  format: string | null;
  /** Industry guide applied by the behaviour system. */
  industry: string | null;
  behaviorVersion: number | null;
  /** resume | cover_letter | certificate | … (AI-detected). */
  documentType: string | null;
  language: string | null;
  warnings: string[];
}

/** Extra output of a user-requested deep review. Only filled by the AI engine. */
export interface DeepFindings {
  focusPoints: string[];
  interviewQuestions: string[];
  risks: string[];
}

export interface CandidateEvaluation {
  candidateName: string | null;
  contact: CandidateContact;
  facts: CandidateFacts;
  criterionScores: CriterionScore[];
  score: number;
  confidence: Confidence;
  engine: AnalysisEngine;
  recommendation: Recommendation;
  summary: string;
  whyCategory: string;
  strengths: EvidencePoint[];
  weaknesses: EvidencePoint[];
  knockoutMisses: string[];
  tags: string[];
  bankSuggested: boolean;
  flags: EvaluationFlags;
  deepFindings?: DeepFindings | null;
  meta?: EvaluationMeta;
}

// ---------- Jobs («فرصت شغلی») ----------

export type JobStatus = 'open' | 'paused' | 'closed';
export type AnalysisStatus = 'idle' | 'processing' | 'done' | 'cancelled';
export type EmploymentType = 'full-time' | 'part-time' | 'contract' | 'remote' | 'hybrid' | 'internship';

export interface JobStats {
  total: number;
  interview: number;
  review: number;
  reject: number;
  unjudgeable: number;
  error: number;
  /** Human decisions */
  approved: number;
  rejected: number;
  reviewDecision: number;
  /** Analysed candidates with no human decision yet (excludes errors). */
  undecided: number;
  avgScore: number;
}

export interface Job {
  id: string;
  orgId: string | null;
  createdBy: string | null;
  createdByName: string | null;
  departmentId: string;
  departmentName: string;
  roleTitle: string;
  extraNotes: string;
  location: string;
  employmentType: EmploymentType | null;
  understanding: JobUnderstanding;
  answers: ScreeningAnswers;
  criteriaSource: CriteriaSource;
  status: JobStatus;
  analysisStatus: AnalysisStatus;
  stats: JobStats;
  createdAtJalali: string;
  createdAtISO: string;
  updatedAtISO: string;
}

export type JobSummary = Omit<Job, 'understanding' | 'answers'> & {
  criteriaCount: number;
  thresholds: Thresholds;
};

// ---------- Candidates ----------

export interface AnalysisHistoryEntry {
  score: number;
  atJalali: string;
  atISO?: string;
  reason: 'initial' | 'rerun' | 'deep' | 'calibration';
  engine: AnalysisEngine;
  mode?: AnalysisMode;
}

/** Where a candidate came from — set for sourced profiles, null for uploads. */
export interface ResumeSource {
  kind: 'linkedin';
  profileUrl: string;
  headline: string;
  company: string | null;
  location: string;
  openToWork: boolean;
  /** The sourcing search that found this profile. */
  searchId: string | null;
}

export interface ResumeRecord {
  id: string;
  jobId: string;
  orgId: string | null;
  uploadedBy: string | null;
  departmentId: string;
  departmentName: string;
  roleTitle: string | null;
  fileName: string;
  /** SHA-256 of the uploaded file — one of the duplicate signals. */
  fileHash?: string | null;
  filePath: string | null;
  fileSize: number | null;
  extractedText: string;
  /** Present when the candidate was added from a sourcing search. */
  source?: ResumeSource | null;
  unjudgeableReason: string | null;
  errorMessage: string | null;

  candidateName: string | null;
  contact: CandidateContact | null;
  facts: CandidateFacts | null;
  criterionScores: CriterionScore[];
  score: number;
  confidence: Confidence | null;
  engine: AnalysisEngine | null;
  recommendation: Recommendation | null;
  summary: string;
  whyCategory: string;
  strengths: EvidencePoint[];
  weaknesses: EvidencePoint[];
  knockoutMisses: string[];
  tags: string[];
  bankSuggested: boolean;
  flags: EvaluationFlags | null;
  deepFindings: DeepFindings | null;
  analysisMeta?: EvaluationMeta | null;

  category: ResumeCategory;
  rankInCategory: number | null;
  analysisHistory: AnalysisHistoryEntry[];

  /**
   * Duplicate screening: compared only against earlier resumes of the same
   * workspace and department («اولین غربالگری»). `unknown` = no identifying
   * signal yet (e.g. unreadable file), so neither «تکراری» nor «جدید».
   */
  novelty?: ResumeNovelty;
  duplicateOf?: DuplicateLink | null;

  /** Talent pool («بانک استعداد») */
  inBank: boolean;
  bankDepartmentId: string | null;
  bankNote: string | null;
  bankTags: string[];
  addedToBankAtJalali: string | null;
  addedToBankAtISO: string | null;

  messageStatus: 'none' | 'sent';
  lastMessagedAtJalali: string | null;

  decisionStatus: DecisionStatus;
  decidedAtJalali: string | null;
  decidedAtISO: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  deepAnalysisAtJalali: string | null;

  createdAtISO: string;
  createdAtJalali: string;
  updatedAtISO: string;
}

/** Lightweight list shape: the extracted resume text stays on the server. */
export type ResumeListItem = Omit<ResumeRecord, 'extractedText'>;

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type ResumeNovelty = 'new' | 'duplicate' | 'unknown';
export type DuplicateReason = 'file' | 'text' | 'email' | 'phone';
export type NoveltyFilter = 'all' | 'new' | 'duplicate' | 'unknown';

export interface DuplicateLink {
  resumeId: string;
  jobId: string;
  roleTitle: string | null;
  createdAtISO: string;
  reason: DuplicateReason;
}

export type MatchFilter = 'all' | 'high' | 'review' | 'low' | 'insufficient';
export type DecisionFilter = 'all' | 'undecided' | 'pending' | 'approved' | 'rejected' | 'review';
export type ResumeSort = 'match' | 'newest' | 'oldest' | 'experience' | 'name' | 'decided';

export interface ResumeQuery {
  jobId?: string;
  match?: MatchFilter;
  decision?: DecisionFilter;
  q?: string;
  departmentId?: string;
  minScore?: number;
  minYears?: number;
  fromJalali?: string;
  toJalali?: string;
  sort?: ResumeSort;
  /** «جدید»، «تکراری» یا فاقد اطلاعات کافی برای تطبیق. */
  novelty?: NoveltyFilter;
  page?: number;
  pageSize?: number;
}

export interface ResumeCounts {
  all: number;
  novel: number;
  duplicate: number;
  unknownNovelty: number;
  high: number;
  review: number;
  low: number;
  insufficient: number;
  undecided: number;
  pending: number;
  approved: number;
  rejected: number;
  reviewDecision: number;
}

export interface ResumePage extends PagedResult<ResumeListItem> {
  counts: ResumeCounts;
}

// ---------- Client-side upload queue ----------

export type FileProcessingStatus =
  | 'idle'
  | 'extracting'
  | 'queued'
  | 'evaluating'
  | 'success'
  | 'error'
  | 'unjudgeable';

export interface ResumeFileItem {
  id: string;
  file?: File;
  name: string;
  size: number;
  extractedText?: string;
  unjudgeableReason?: string;
  status: FileProcessingStatus;
  errorMessage?: string;
  recordId?: string;
  category?: ResumeCategory;
  score?: number;
}

export interface ScreeningProgressUpdate {
  items: ResumeFileItem[];
  currentEvaluatingName?: string;
  activeEvaluatingNames?: string[];
  processedCount: number;
  totalCount: number;
  statusText: string;
  subStatusText?: string;
  phase?: 'extracting' | 'evaluating' | 'calibrating' | 'done';
  extractedCount?: number;
  estimatedSecondsRemaining?: number;
  speedPerMinute?: number;
  overallPercent?: number;
  warningText?: string;
}

// ---------- Messages ----------

export type MessageKind = 'INTERVIEW_INVITE' | 'INFO_REQUEST' | 'BANK_NOTICE' | 'REJECTION';

export interface DraftMessage {
  kind: MessageKind;
  subject: string;
  body: string;
  engine: AnalysisEngine;
}

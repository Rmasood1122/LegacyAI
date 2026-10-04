// A stand-in for the private AI service, for API tests that do not need the real one.
// It checks every service token the way the real service does (signature, issuer, audience,
// lifetime, the operation, the record) and answers each internal operation with a small, valid
// response. Tests can replace an answer, look at what was sent, or make a call fail.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jwtVerify } from 'jose';
import { INTERNAL_CONTRACT_PATH } from '../../src/modules/knowledge-gateway/index.ts';
import { testEnv } from './env.ts';

export interface StubCall {
  action: string;
  path: string;
  claims: Record<string, any>;
  body: any;
  bytes: number;
  contentType: string;
}

type Answer = (call: StubCall) => unknown | Promise<unknown>;

interface Op { method: string; pattern: RegExp; action: string; subject: string | null; template: string }

function loadOps(): Op[] {
  const doc = JSON.parse(readFileSync(INTERNAL_CONTRACT_PATH, 'utf8')) as { paths: Record<string, Record<string, { 'x-action'?: string; 'x-subject'?: string | null }>> };
  const ops: Op[] = [];
  for (const [template, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (typeof op['x-action'] !== 'string') continue;
      const names: string[] = [];
      const pattern = new RegExp(`^${template.replace(/\{([a-z_]+)\}/g, (_m, n: string) => { names.push(n); return '([^/]+)'; })}$`);
      ops.push({ method: method.toUpperCase(), pattern, action: op['x-action'], subject: op['x-subject'] ?? null, template });
    }
  }
  return ops;
}

const id = (): string => randomUUID();
const now = (): string => new Date().toISOString();

/** Default answers: the smallest valid response of each operation. */
const DEFAULTS: Record<string, Answer> = {
  'source.create': (c) => ({ id: id(), status: 'awaiting_content', title: c.body.title }),
  'source.content': () => ({ status: 'ready', failure_code: null, chunk_count: 3, pending_chunks: null, duplicate_of: null }),
  'source.continue': () => ({ status: 'ready', chunk_count: 3 }),
  'source.confirm': (c) => ({ id: c.claims.subject, status: 'awaiting_content' }),
  'source.withdraw': (c) => ({ id: c.claims.subject, status: 'withdrawn', items_withdrawn: 0, items_back_in_review: 0 }),
  'label.change': () => ({ rows: 1 }),
  'knowledge.candidates': () => ({ candidates: [] }),
  'knowledge.answer': () => ({
    outcome: 'dont_know', answer: null, reason: 'no_relevant_sources', confidence: null, contains_unverified_sources: false, citations: [], can_ask_expert: true,
    answer_id: id(), conflict_found_by: null, conflicts: [], conflict_check_partial: false,
  }),
  'answer.feedback': (c) => ({ id: id(), answer_id: c.claims.subject, verdict: c.body?.verdict ?? 'helpful', comment: c.body?.comment ?? null, question_shared: c.body?.share_question === true, question: null, created_at: now(), outcome: 'answered', reason: null, confidence: 'high', contains_unverified_sources: false }),
  'answer.feedback_read': (c) => ({ id: id(), answer_id: c.claims.subject, verdict: c.body?.verdict ?? 'helpful', comment: c.body?.comment ?? null, question_shared: c.body?.share_question === true, question: null, created_at: now(), outcome: 'answered', reason: null, confidence: 'high', contains_unverified_sources: false }),
  'answer.feedback_withdraw': (c) => ({ answer_id: c.claims.subject, withdrawn: true }),
  'quality.summary': () => ({ weeks: [], kept_for_days: 90, waiting_for_review: { item_conflicts: 0, stale_items: 0, answers_marked_wrong: 0 } }),
  'quality.feedback': () => ({ items: [], next_cursor: null }),
  'item.list': () => ({ items: [], next_cursor: null }),
  'item.read': (c) => ({
    id: c.claims.subject, title: 'Synthetic item', status: 'verified', origin: 'manual', ai_extracted: false, department_id: null, sensitivity: 1,
    owner_person_id: null, usage_count: 0, verified_at: now(), stale_after: null, updated_at: now(), body: 'Synthetic body.', self_verified: false,
    versions: [{ version_no: 1, change_kind: 'written', author_person_id: null, created_at: now(), erased_at: null, current: true }], provenance: [],
    conflicts: [],
  }),
  'item.write': () => ({ id: id(), status: 'candidate' }),
  'item.topics': (c) => ({
    id: c.claims.subject, topics: (c.body.topic_ids as string[]).map((t) => ({ topic_id: t, name: 'Synthetic topic', link_source: 'reviewer' })),
  }),
  'item.submit': (c) => ({ id: c.claims.subject, status: 'in_review' }),
  'item.verify': (c) => ({ id: c.claims.subject, status: 'verified' }),
  'item.reject': (c) => ({ id: c.claims.subject, status: 'rejected' }),
  'item.retire': (c) => ({ id: c.claims.subject, status: 'rejected' }),
  'item.reopen': (c) => ({ id: c.claims.subject, status: 'in_review' }),
  'item.propose': (c) => ({ id: c.claims.subject, status: 'in_review', version_no: 2 }),
  'item.restrict': (c) => ({ id: c.claims.subject, sensitivity: c.body.sensitivity }),
  'verification.revert': () => ({ count: 0 }),
  'interview.invite': () => ({ id: id(), status: 'invited' }),
  'interview.read': (c) => ({
    id: c.claims.subject, expert_person_id: id(), job_role: 'Synthetic role', status: 'active', turn_count: 0, max_turns: 30, created_at: now(),
    last_turn_at: null, completed_at: null, turns: [],
  }),
  'interview.accept': (c) => ({ interview_id: c.claims.subject, status: 'active', next_question: 'Tell me about it.', turn_count: 0, candidate_item_id: null }),
  'interview.turn': (c) => ({ interview_id: c.claims.subject, status: 'active', next_question: 'And then?', turn_count: 1, candidate_item_id: null }),
  'interview.status': (c) => ({ id: c.claims.subject, status: c.body.status }),
  'gap.report': (c) => ({ job_role: c.body.job_role, topics: [] }),
  'topic.embed': (c) => ({ id: c.claims.subject }),
  'topic.suggest': () => ({ proposed: [] }),
  'expert_question.create': () => ({ id: id(), status: 'open', expires_at: now() }),
  'expert_question.list': () => ({ items: [], next_cursor: null }),
  'expert_question.reply': (c) => ({ id: c.claims.subject, status: 'answered', answer_item_id: id() }),
  'expert_question.decline': (c) => ({ id: c.claims.subject, status: 'declined' }),
  'quiz.generate': () => ({ created: [id()], refused: [] }),
  'quiz.list': () => ({ items: [], next_cursor: null }),
  'quiz.edit': (c) => ({ id: c.claims.subject, status: 'draft' }),
  'quiz.status': (c) => ({ id: c.claims.subject, status: c.body.status }),
  'quiz.start': () => ({ id: id(), expires_at: now(), questions: [{ position: 1, kind: 'mcq', stem: 'Which?', options: ['a', 'b', 'c', 'd'] }] }),
  'quiz.attempt_read': (c) => ({
    id: c.claims.subject, learner_person_id: id(), job_role: 'Synthetic role', status: 'in_progress', started_at: now(), expires_at: now(),
    submitted_at: null, graded_at: null, bank_size: 1, questions: [],
  }),
  'quiz.answer': (c) => ({ id: c.claims.subject, position: c.body.position }),
  'quiz.submit': (c) => ({ id: c.claims.subject, status: 'graded' }),
  'quiz.override': () => ({ id: id(), status: 'graded' }),
  'quiz.report': (c) => ({
    attempt_id: c.claims.subject, learner_person_id: id(), job_role: 'Synthetic role', status: 'graded', started_at: now(), submitted_at: now(),
    graded_at: now(), bank_size: 1, statement: 'This report shows how one person answered one set of questions on one occasion.', topics: [], coverage_gaps: [],
  }),
  'consent.erase': (c) => ({ id: c.claims.subject, withdrawal_status: 'completed', sources_erased: 0, items_erased: 0, items_back_in_review: 0 }),
  'housekeeping.run': () => ({ done: {} }),
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of req) parts.push(p as Buffer);
  return Buffer.concat(parts);
}

export class AiStub {
  readonly calls: StubCall[] = [];
  readonly answers = new Map<string, Answer>();
  /** Runs while a call is being answered (e.g. to look at the database at that moment). */
  during: ((call: StubCall) => Promise<void>) | null = null;
  #server: Server | null = null;
  #ops = loadOps();
  #key = new TextEncoder().encode(testEnv().SERVICE_TOKEN_KEY as string);

  get url(): string {
    const port = (this.#server?.address() as AddressInfo | null)?.port;
    return `http://127.0.0.1:${port}`;
  }

  reset(): void {
    this.calls.length = 0;
    this.answers.clear();
    this.during = null;
  }

  ofAction(action: string): StubCall[] {
    return this.calls.filter((c) => c.action === action);
  }

  async start(): Promise<this> {
    this.#server = createServer((req, res) => {
      void (async () => {
        const send = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        try {
          const path = (req.url ?? '').split('?')[0] ?? '';
          const op = this.#ops.find((o) => o.method === req.method && o.pattern.test(path));
          if (!op) return send(404, { error: 'not_found' });
          const auth = req.headers.authorization ?? '';
          if (!auth.startsWith('Bearer ')) return send(401, { error: 'unauthorized' });
          let claims: Record<string, any>;
          try {
            const verified = await jwtVerify(auth.slice(7), this.#key, { issuer: 'legacyai-api', audience: 'legacyai-ai', algorithms: ['HS256'] });
            claims = verified.payload as Record<string, any>;
          } catch {
            return send(401, { error: 'unauthorized' });
          }
          if (claims.exp - claims.iat > 120 || claims.action !== op.action) return send(401, { error: 'unauthorized' });
          if (op.subject !== null) {
            const segment = path.split('/').find((s) => s === claims.subject);
            if (typeof claims.subject !== 'string' || segment === undefined) return send(401, { error: 'unauthorized' });
          }
          const raw = await readBody(req);
          const contentType = String(req.headers['content-type'] ?? '');
          const body = contentType.startsWith('application/json') && raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null;
          const call: StubCall = { action: op.action, path, claims, body, bytes: raw.length, contentType };
          this.calls.push(call);
          if (this.during) await this.during(call);
          const answer = this.answers.get(op.action) ?? DEFAULTS[op.action];
          if (!answer) return send(500, { error: 'no_stub_answer' });
          const result = await answer(call);
          if (result instanceof StubError) return send(result.status, { error: result.code });
          return send(200, result);
        } catch {
          return send(500, { error: 'stub_failure' });
        }
      })();
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }
}

/** Return this from an answer to make the stand-in fail with that status and error code. */
export class StubError {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    this.status = status;
    this.code = code;
  }
}

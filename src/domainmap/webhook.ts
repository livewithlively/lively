// HMAC fail-closed 웹훅 라우터 — 구 domain-map/server.mjs 의 handleWebhook 이식.
// POST /api/webhook/:provider (github|gitlab 외 404). bearer 인증 밖(자체 fail-closed 인증):
// 503(secret 미설정) → 401(서명 불일치) → ping 200 → 검증 후에만 JSON.parse → ignored 200 들
// → ensureClone(git execFile argv, 토큰/URL 절대 비로깅) → git diff 파싱 → core.refresh.
// raw bytes 가 HMAC 의 대상이므로 express.raw 를 이 라우터 안에서 마운트한다 — index.ts 는
// 이 라우터를 전역 express.json() '이전'에 mount 해야 한다(스트림 선소비 방지).
import { currentTenant } from "../org/tenant-context.js";
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { httpErr } from "./core/types.js";
import { findRepoByNames } from "./core/repos.js";
import { refresh } from "./core/refresh.js";
import { isAuthError, describeGitError, hostOf } from "../org/credentials/git-credential-store.js";
import { git as gitExec, ensureClone as ensureCloneRaw, sanitizeName, parseDiff, commitTime, isAncestorStrict, commitExists } from "./git-sync.js";
import { logger } from "../log.js";

// sanitizeName 은 구 webhook.ts 표면(테스트·소비자) — 구현은 git-sync 단일 출처, 여기선 재수출로 표면 유지.
export { sanitizeName };

const WEBHOOK_BODY_CAP = "2mb";               // 구 2MB cap → express.raw limit (초과 = 413)
const GIT_TIMEOUT_MS = 60_000;
const ZERO_SHA = /^0{40}$/;                   // git "all zeros" => no parent (new branch / first push)
const SHA_RE = /^[0-9a-f]{7,40}$/;
// The push's `before`, or null for a new branch / first push (all zeros) or garbage.
const usablePushBase = (v: unknown): string | null => {
  const s = String(v ?? "");
  return s && !ZERO_SHA.test(s) && SHA_RE.test(s) ? s : null;
};

// 웹훅 예산(60s)을 묶은 git 실행기 — 구 로컬 git() 과 동일 시그니처라 호출부 무변경.
const git = (args: string[], cwd?: string, extraEnv?: Record<string, string>) =>
  gitExec(args, cwd, extraEnv, { timeoutMs: GIT_TIMEOUT_MS });

// Constant-time compare of two utf8 strings (length-guarded so timingSafeEqual
// never throws on a length mismatch — and the guard itself doesn't early-return
// on a content difference).
function safeEqualStr(a: unknown, b: unknown): boolean {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Verify the request signature. Returns true/false; never throws, never logs
// secret material. Mismatch/missing => caller returns 401 with no detail.
export function verifyWebhook(provider: string, secret: string, rawBody: Buffer, headers: Record<string, unknown>): boolean {
  if (provider === "github") {
    const sig = (headers["x-hub-signature-256"] || "").toString();
    if (!sig.startsWith("sha256=")) return false;
    const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
    return safeEqualStr(sig, expected);
  }
  if (provider === "gitlab") {
    const token = (headers["x-gitlab-token"] || "").toString();
    if (!token) return false;
    // HMAC both sides → equal length always, removes the secret-length side channel.
    const h = (v: string) => createHmac("sha256", secret).update(v).digest("hex");
    return safeEqualStr(h(token), h(secret));
  }
  return false;
}

// Extract the branch from a ref like 'refs/heads/main' -> 'main'. Tags / other
// refs (refs/tags/*) yield null so they're treated as non-default-branch.
export function branchFromRef(ref: unknown): string | null {
  const m = /^refs\/heads\/(.+)$/.exec(String(ref ?? ""));
  return m ? m[1] : null;
}

// Normalize a push event across providers into {ref, before, after, names[]}.
// `names` lists candidate identifiers (full + short) to match a repo row by.
export function parsePushEvent(provider: string, body: any): { ref: unknown; before: unknown; after: unknown; names: string[] } {
  if (provider === "github") {
    const repo = body.repository ?? {};
    const names = [repo.full_name, repo.name].filter(Boolean).map(String);
    return { ref: body.ref, before: body.before, after: body.after, names };
  }
  // gitlab push hook
  const proj = body.project ?? {};
  const names = [proj.path_with_namespace, proj.name].filter(Boolean).map(String);
  return { ref: body.ref, before: body.before, after: body.after, names };
}

// 클론 보장 + **웹훅 고유 에러 번역** — 구현은 git-sync.ensureClone 단일 출처, 401/502 httpErr 번역만 여기 잔류
//  (호출부 의미 보존: 미검증/인증실패는 401 안내, 그 외 clone/fetch 실패는 502. git_url(토큰 포함 가능) 절대 비노출).
//  ⚠ 번역 스코프는 clone/fetch 만(onGitError) — 이름 검증 400 은 그 앞, prepareGitAuth 실패는 종전대로 raw 전파.
async function ensureClone(repoName: string, gitUrl: string): Promise<string> {
  if (!sanitizeName(repoName)) throw httpErr(400, "invalid repo name for clone dir");
  return ensureCloneRaw(repoName, gitUrl, {
    timeoutMs: GIT_TIMEOUT_MS,
    onGitError: (e) => {
      // Scrub: git errors can echo the remote URL (token) → git_url 절대 비노출. 인증계열은 401 안내로만 분류.
      if (isAuthError((e as { stderr?: unknown })?.stderr ?? (e as Error)?.message ?? e)) {
        throw httpErr(401, `git 인증 실패 — 호스트 '${hostOf(gitUrl) ?? "?"}' 게이트웨이 SSH 키 미등록/불일치(관리탭 ▸ 게이트웨이 git 계정)`);
      }
      throw httpErr(502, "git clone/fetch 실패: " + describeGitError(e, gitUrl));
    },
  });
}


/**
 * 이 워크스페이스의 웹훅 비밀(순수).
 *
 * ★★ 공유 게이트웨이에서 비밀을 **공유하면 교차 쓰기가 된다.** A 가 자기 비밀로 페이로드를 서명해
 *  B 의 웹훅 URL 로 보내면 B 의 데이터가 바뀐다 — 라우팅은 호스트명으로 갈리지만 서명은 안 갈리므로
 *  "남의 데이터가 보인다" 가 아니라 **"남의 데이터를 쓴다"** 다.
 *
 * 저장하지 않고 **유도**한다: 워크스페이스마다 서로 다른 값이 되면서 새 저장소·회전 절차가 필요 없다.
 *  컨텍스트가 없으면(단일 테넌트) 설정값 그대로 — 종전 동작이다.
 */
export function webhookSecretFor(base: string, tenantId: string | null): string {
  if (!base || !tenantId) return base;
  return createHmac("sha256", base).update(`webhook:${tenantId}`).digest("hex");
}

async function handleWebhook(req: express.Request, res: express.Response, provider: string): Promise<void> {
  if (provider !== "github" && provider !== "gitlab") { res.status(404).json({ error: "unknown provider" }); return; }

  // express.raw 가 채워준 raw bytes (HMAC 의 대상 — 전역 JSON 파서보다 먼저 마운트돼야 함).
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  // Secret required (fail-closed): unconfigured => 503, not 401.
  const secret = webhookSecretFor((process.env.WEBHOOK_SECRET || "").toString(), currentTenant()?.id ?? null);
  if (!secret) { res.status(503).json({ error: "webhook not configured" }); return; }

  // Verify signature/token (constant-time). Any failure => 401, no detail.
  if (!verifyWebhook(provider, secret, raw, req.headers as Record<string, unknown>)) {
    res.status(401).json({ error: "unauthorized" }); return;
  }

  // GitHub ping (and other non-push events) => ack without acting.
  const ghEvent = (req.headers["x-github-event"] || "").toString().toLowerCase();
  if (provider === "github" && ghEvent === "ping") { res.status(200).json({ ok: true }); return; }

  // Parse JSON only AFTER verification.
  let body: any;
  try { body = JSON.parse(raw.toString("utf8") || "{}"); }
  catch { res.status(400).json({ error: "invalid JSON body" }); return; }
  if (!body || typeof body !== "object" || Array.isArray(body)) { res.status(400).json({ error: "JSON body must be an object" }); return; }

  // GitHub sends events other than push to the same URL; only act on push.
  if (provider === "github" && ghEvent && ghEvent !== "push") { res.status(200).json({ ignored: "non-push event" }); return; }
  // GitLab object_kind guard (push / tag_push); ignore anything else.
  if (provider === "gitlab" && body.object_kind && body.object_kind !== "push") { res.status(200).json({ ignored: "non-push event" }); return; }

  const ev = parsePushEvent(provider, body);
  const branch = branchFromRef(ev.ref);
  if (!branch) { res.status(200).json({ ignored: "non-default branch" }); return; } // tags/other refs

  // Match a repo row by any candidate name (full + short).
  const repo = await findRepoByNames(ev.names);
  if (!repo) { res.status(200).json({ ignored: "unknown repo" }); return; }

  // Only act on the repo's default branch.
  const defaultBranch = repo.default_branch || "main";
  if (branch !== defaultBranch) { res.status(200).json({ ignored: "non-default branch" }); return; }

  if (!repo.git_url) { res.status(200).json({ ignored: "no git_url configured" }); return; }

  // Sync the local clone, then diff before..after.
  const cloneDir = await ensureClone(repo.name, repo.git_url);

  // Validate SHAs BEFORE handing to git (defense-in-depth; argv already prevents
  // shell injection, but garbage refs must not reach git as a range).
  const after = String(ev.after ?? "");
  if (!SHA_RE.test(after)) { res.status(400).json({ error: "invalid after sha" }); return; }

  const before = usablePushBase(ev.before);
  try {
    await decideAndApply(res, provider, repo, cloneDir, before, after, `origin/${defaultBranch}`);
  } catch (e) {
    if (!(e instanceof GitCheckFailed)) throw e;
    // Nothing was written: every git call that feeds a write runs before refresh(). Log the cause (op,
    // refs, exit code / signal — never stderr, which can echo the remote URL) and ack with 200.
    // Why not 5xx: GitHub does not redeliver a failed delivery by itself (only a manual redeliver),
    // and GitLab disables a hook after repeated failures, so a 5xx buys no retry and risks the hook.
    // Recovery is the next push (it diffs from the checkpoint) or refresh_all.
    logger.warn({ repo: repo.name, op: e.op, refs: e.refs, code: e.code, signal: e.signal }, "domainmap webhook: git check failed, skipped");
    res.status(200).json({ ignored: `git check failed (${e.op}), will resync`, head: after });
  }
}

// A git lookup the webhook needed for a decision failed (as opposed to answering "no").
class GitCheckFailed extends Error {
  readonly code: unknown;
  readonly signal: unknown;
  constructor(readonly op: string, readonly refs: string[], cause: unknown) {
    super(`git ${op} failed`);
    this.code = (cause as { code?: unknown })?.code ?? null;
    this.signal = (cause as { signal?: unknown })?.signal ?? null;
  }
}

async function decideAndApply(
  res: express.Response, provider: string, repo: any, cloneDir: string, before: string | null, after: string, tipRef: string,
): Promise<void> {
  const opts = { timeoutMs: GIT_TIMEOUT_MS };
  // Every lookup below decides whether (and from where) to write, so an error is never read as "no" —
  // it becomes GitCheckFailed and the handler acks without writing.
  const check = async <T>(op: string, refs: string[], fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) { throw new GitCheckFailed(op, refs, e); }
  };
  const exists = (sha: string) => check("rev-parse", [sha], () => commitExists(cloneDir, sha, opts));
  const ancestor = (a: string, d: string) => check("merge-base", [a, d], () => isAncestorStrict(cloneDir, a, d, opts));
  const isTip = (sha: string) => check("rev-parse", [tipRef],
    async () => (await git(["-C", cloneDir, "rev-parse", "--verify", `${tipRef}^{commit}`])).stdout.trim() === sha);

  type Outcome = { kind: "applied"; tally: unknown; changes: number } | { kind: "skipped"; checkpoint: string };
  // Diff `from..after` and refresh. With a base this is the checkpoint-guarded path; base null is a
  // re-baseline (refresh sets the checkpoint to `after` unconditionally).
  const apply = async (from: string, base: string | null): Promise<Outcome> => {
    const diffOut = (await check("diff", [from, after], () => git(["-C", cloneDir, "diff", "--name-status", "-M50", from, after]))).stdout || "";
    const changes = parseDiff(diffOut);
    const head_committed_at = await commitTime(cloneDir, after, opts);
    // granularity:'file' — git diff speaks FILE paths but our code_units are module-level; the store
    // aggregates them onto the existing units (longest-prefix ownership; dir-move = file-rename cluster →
    // module rename; new dir = candidate unit; add/modify/delete inside an existing module = structural
    // no-op that only moves its content_changed_at) BEFORE the deterministic refresh applies them.
    const r = await refresh(
      repo.name,
      { ...(base ? { base } : {}), head: after, head_committed_at, changes, granularity: "file" },
      { type: "agent", id: "webhook:" + provider },
    );
    return r.skipped ? { kind: "skipped", checkpoint: r.skipped.checkpoint } : { kind: "applied", tally: r.tally, changes: changes.length };
  };
  // note 가 undefined 면 JSON 직렬화에서 키 생략 — 구 응답과 동일.
  const done = (o: Outcome, base: string, note?: string): void => {
    if (o.kind === "applied") { res.status(200).json({ tally: o.tally, base, head: after, changes: o.changes, note }); return; }
    res.status(200).json({ ignored: "checkpoint moved concurrently, will resync", base, head: after, checkpoint: o.checkpoint });
  };

  // `after` not fetched yet (stale clone): ack, the next push / refresh_all reconciles. A failed lookup is
  // not "absent" — it goes to the GitCheckFailed path instead.
  if (!(await exists(after))) { res.status(200).json({ ignored: "sha not in clone yet, will resync", head: after }); return; }

  // Checkpoint the units cannot be diffed from: not a sha, or not a commit in the clone (history rewrite,
  // a sha set by hand). refresh() refuses any other base, and the scheduled refresh_all — the only other
  // path that re-baselines — may be disabled, so the webhook would stall for good. Re-baseline from the
  // push's own range instead; whatever happened between the checkpoint and `before` is lost either way.
  // Only for a push whose `after` is the fetched branch tip: a re-baseline writes unconditionally, so a
  // redelivered old push would otherwise move the units and the checkpoint backwards. A non-tip push is
  // acked with 200 and recovery waits for the next push at the tip or refresh_all (which re-baselines an
  // unusable checkpoint) — with refresh_all disabled and no further push the units stay behind.
  const rebaseline = async (why: string): Promise<void> => {
    if (!before) { res.status(200).json({ ignored: `${why} and no usable push base`, head: after }); return; }
    if (!(await isTip(after))) { res.status(200).json({ ignored: `${why} and push is not the branch tip, will resync`, head: after }); return; }
    if (!(await exists(before))) { res.status(200).json({ ignored: `${why} and push before not in clone yet, will resync`, head: after }); return; }
    done(await apply(before, null), before, `${why}; re-baselined from push before`);
  };
  const unusable = async (cp: string): Promise<string | null> =>
    !SHA_RE.test(cp) ? "checkpoint is not a sha" : !(await exists(cp)) ? "checkpoint not in clone" : null;

  const stored = typeof repo.last_refreshed_sha === "string" && repo.last_refreshed_sha !== "" ? repo.last_refreshed_sha : null;
  if (!stored) {
    if (!before) { res.status(200).json({ ignored: "no usable base sha (new branch / first push)", head: after }); return; }
    if (!(await exists(before))) { res.status(200).json({ ignored: "sha not in clone yet, will resync", base: before, head: after }); return; }
    done(await apply(before, before), before); return;
  }

  // Diff from the checkpoint, not the push's `before`: the stored units reflect the checkpoint, and any
  // earlier push this endpoint acked without applying (clone busy, sha not fetched yet) sits between the
  // two. A push at or behind a checkpoint that is still on the branch (out-of-order delivery, redelivery)
  // is already applied — diffing checkpoint..after would walk the units backwards. A checkpoint the
  // branch no longer contains means the branch was rewound or rewritten, and checkpoint..after is
  // exactly the change to apply (backwards included) — but only when `after` is the branch tip; otherwise
  // the target is a state the branch no longer has either, so it is acked and left to the next push at
  // the tip or refresh_all (same stall condition as above). If a concurrent refresh moves the checkpoint
  // (two pushes in quick succession), re-diff once from the checkpoint it left — that checkpoint gets the
  // same usability check; a second miss is left to the next push / refresh_all.
  let cp = stored;
  for (let attempt = 0; ; attempt++) {
    const why = await unusable(cp);
    if (why) { await rebaseline(why); return; }
    const cpOnBranch = await ancestor(cp, tipRef);
    if (cpOnBranch && await ancestor(after, cp)) {
      res.status(200).json({ ignored: "already applied (checkpoint at or past this push)", base: cp, head: after }); return;
    }
    if (!cpOnBranch && !(await isTip(after))) {
      res.status(200).json({ ignored: "checkpoint is off the branch and push is not the branch tip, will resync", base: cp, head: after }); return;
    }
    const o = await apply(cp, cp);
    if (o.kind === "skipped" && attempt === 0) { cp = o.checkpoint; continue; }
    const note = attempt > 0 ? "re-diffed from the checkpoint moved by a concurrent refresh"
      : before !== cp ? "diffed from last_refreshed_sha (push before differs)" : undefined;
    done(o, cp, note); return;
  }
}

export function domainmapWebhookRouter(): express.Router {
  const router = express.Router();
  // raw bytes 필수: HMAC 은 정확한 원문 바이트 대상. 초과(2MB)는 body-parser 가 413 throw.
  router.use(express.raw({ type: () => true, limit: WEBHOOK_BODY_CAP }));
  router.post("/:provider", (req, res, next) => {
    handleWebhook(req, res, req.params.provider).catch(next);
  });
  // 구 server.mjs 의 비매칭 응답 동결: GET /api/webhook/* ·다세그 POST 등은 게이트웨이 인증/404
  // 스택으로 흘리지 않고(이미 express.raw 가 body 를 소비한 뒤다) 구와 동일한 404 를 직접 반환.
  router.all("*", (_req, res) => { res.status(404).json({ error: "unknown endpoint" }); });
  // 에러 번역 — 구 server.mjs sendErr 와 동일 응답: {error: message} + e.status(기본 500).
  // body-parser 의 entity.too.large 는 구 readRawBody 의 413 'payload too large' 문구로 번역.
  router.use(((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    if (err?.type === "entity.too.large" || err?.status === 413) {
      res.status(413).json({ error: "payload too large" }); return;
    }
    res.status(err?.status ?? 500).json({ error: err?.message ?? String(err) });
  }) as express.ErrorRequestHandler);
  return router;
}

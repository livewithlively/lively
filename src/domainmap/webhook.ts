// HMAC fail-closed 웹훅 라우터 — 구 domain-map/server.mjs 의 handleWebhook 이식.
// POST /api/webhook/:provider (github|gitlab 외 404). bearer 인증 밖(자체 fail-closed 인증):
// 503(secret 미설정) → 401(서명 불일치) → ping 200 → 검증 후에만 JSON.parse → ignored 200 들
// → ensureClone(git execFile argv, 토큰/URL 절대 비로깅) → git diff 파싱 → core.refresh.
// raw bytes 가 HMAC 의 대상이므로 express.raw 를 이 라우터 안에서 마운트한다 — index.ts 는
// 이 라우터를 전역 express.json() '이전'에 mount 해야 한다(스트림 선소비 방지).
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { httpErr } from "./core/types.js";
import { findRepoByNames } from "./core/repos.js";
import { refresh } from "./core/refresh.js";
import { resolveGitSecret, hostOf, prepareGitAuth, isAuthError } from "../org/git-credential-store.js";

const execFileP = promisify(execFile);

const WEBHOOK_BODY_CAP = "2mb";               // 구 2MB cap → express.raw limit (초과 = 413)
const GIT_TIMEOUT_MS = 60_000;
const ZERO_SHA = /^0{40}$/;                   // git "all zeros" => no parent (new branch / first push)
const SHA_RE = /^[0-9a-f]{7,40}$/;

// 클론 캐시 디렉 — 구 '/repos'(도커 볼륨) 하드코딩은 macOS 호스트에서 생성 불가라
// env DOMAINMAP_REPOS_DIR(기본 var/repos, 게이트웨이 작업 디렉 기준)로 대체. .gitignore 등재.
// 구 repodata 볼륨은 마이그레이션하지 않는다 — git_url 이 repo 테이블에 있어 첫 웹훅 때 재클론.
function reposDir(): string {
  return resolve(process.env.DOMAINMAP_REPOS_DIR ?? "var/repos");
}

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
function verifyWebhook(provider: string, secret: string, rawBody: Buffer, headers: Record<string, unknown>): boolean {
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

// Sanitize a repo name to a safe single path segment for the clone dir. Strips
// any char outside [A-Za-z0-9._-]; an empty result is rejected by the caller.
function sanitizeName(name: unknown): string {
  return String(name ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
}

// Extract the branch from a ref like 'refs/heads/main' -> 'main'. Tags / other
// refs (refs/tags/*) yield null so they're treated as non-default-branch.
function branchFromRef(ref: unknown): string | null {
  const m = /^refs\/heads\/(.+)$/.exec(String(ref ?? ""));
  return m ? m[1] : null;
}

// Normalize a push event across providers into {ref, before, after, names[]}.
// `names` lists candidate identifiers (full + short) to match a repo row by.
function parsePushEvent(provider: string, body: any): { ref: unknown; before: unknown; after: unknown; names: string[] } {
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

// Run git with execFile (argv array — NEVER a shell string, no injection). SHAs
// are validated by the caller; paths in output come from git (trusted). A
// non-zero exit throws; we add a hard timeout to every git op.
//  extraEnv: 자격 주입(#606) — prepareGitAuth 의 GIT_SSH_COMMAND(키·accept-new)/GIT_ASKPASS. GIT_TERMINAL_PROMPT=0 항상(무한대기 방지).
async function git(args: string[], cwd?: string, extraEnv?: Record<string, string>) {
  return execFileP("git", args, {
    cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(extraEnv ?? {}) },
  });
}

// Ensure a local clone exists & is up to date. Clones from git_url if missing,
// else fetches. Returns the clone dir. NEVER includes git_url in thrown errors.
//  #606: provision 과 동일하게 게이트웨이 자격을 주입(SSH 키+accept-new). 웹훅도 무인 트리거라 멤버 없음 → resolveGitSecret(null, host)
//   = 게이트웨이 머신 자격. 자격 없으면 앰비언트 폴백. 예전엔 미주입이라 private SSH 레포에서 항상 실패했다.
async function ensureClone(repoName: string, gitUrl: string): Promise<string> {
  const safe = sanitizeName(repoName);
  if (!safe) throw httpErr(400, "invalid repo name for clone dir");
  const dir = reposDir();
  const cloneDir = join(dir, safe);
  const secret = await resolveGitSecret(null, hostOf(gitUrl) ?? "github.com").catch(() => null);
  const auth = await prepareGitAuth(secret);
  try {
    if (!existsSync(cloneDir)) {
      mkdirSync(dir, { recursive: true }); // 호스트 환경: 부모 디렉 보장(클론 자체엔 무영향)
      await git(["clone", gitUrl, cloneDir], undefined, auth.env);
    } else {
      await git(["-C", cloneDir, "fetch", "--prune", "--quiet"], undefined, auth.env);
    }
  } catch (e) {
    // Scrub: git errors can echo the remote URL (token) → git_url 절대 비노출. 인증계열은 401 안내로만 분류.
    if (isAuthError((e as { stderr?: unknown })?.stderr ?? (e as Error)?.message ?? e)) {
      throw httpErr(401, `git 인증 실패 — 호스트 '${hostOf(gitUrl) ?? "?"}' 게이트웨이 SSH 키 미등록/불일치(관리탭 ▸ 게이트웨이 git 계정)`);
    }
    throw httpErr(502, "git clone/fetch failed");
  } finally {
    await auth.cleanup();
  }
  return cloneDir;
}

// Parse `git diff --name-status -M50` output into the refresh() changes[] shape.
// Lines: 'R<score>\t<from>\t<to>' | 'C<score>\t<from>\t<to>' (add of <to>) |
// 'A\t<path>' | 'D\t<path>' | 'M\t<path>' | 'T\t<path>' (treat as modify).
function parseDiff(out: string): any[] {
  const changes: any[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    const letter = code[0];
    if (letter === "R") {
      if (!parts[1] || !parts[2]) continue;
      const score = Number(code.slice(1));
      changes.push({ status: "R", from: parts[1], to: parts[2], score: Number.isFinite(score) ? score : null });
    } else if (letter === "C") {
      if (!parts[2]) continue;
      // copy: the source is unchanged; treat the copy target as a fresh add.
      changes.push({ status: "A", path: parts[2] });
    } else if (letter === "A") {
      if (!parts[1]) continue;
      changes.push({ status: "A", path: parts[1] });
    } else if (letter === "D") {
      if (!parts[1]) continue;
      changes.push({ status: "D", path: parts[1] });
    } else if (letter === "M" || letter === "T") {
      if (!parts[1]) continue;
      changes.push({ status: "M", path: parts[1] });
    }
    // ignore U (unmerged) / X (unknown) — not reachable for a committed range.
  }
  return changes;
}

async function handleWebhook(req: express.Request, res: express.Response, provider: string): Promise<void> {
  if (provider !== "github" && provider !== "gitlab") { res.status(404).json({ error: "unknown provider" }); return; }

  // express.raw 가 채워준 raw bytes (HMAC 의 대상 — 전역 JSON 파서보다 먼저 마운트돼야 함).
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  // Secret required (fail-closed): unconfigured => 503, not 401.
  const secret = (process.env.WEBHOOK_SECRET || "").toString();
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

  let before = String(ev.before ?? "");
  let baseNote: string | undefined;
  if (!before || ZERO_SHA.test(before) || !SHA_RE.test(before)) {
    // New branch / first push (all-zeros) or garbage: fall back to the last
    // refreshed sha if we have one; else skip diffing against garbage.
    if (repo.last_refreshed_sha && SHA_RE.test(repo.last_refreshed_sha)) {
      before = repo.last_refreshed_sha;
      baseNote = "before was zero/invalid; fell back to last_refreshed_sha";
    } else {
      res.status(200).json({ ignored: "no usable base sha (new branch / first push)", head: after }); return;
    }
  }

  let diffOut: string;
  try {
    const r = await git(["-C", cloneDir, "diff", "--name-status", "-M50", before, after]);
    diffOut = r.stdout || "";
  } catch {
    // before/after may not be in the local clone yet (force-push / stale). Don't 502
    // (provider retry storms) — ack and let the next push / scheduled refresh reconcile.
    res.status(200).json({ ignored: "sha not in clone yet, will resync", base: before, head: after }); return;
  }

  const changes = parseDiff(diffOut);

  // Apply via the existing audited + transactional deterministic refresh.
  // granularity:'file' — git diff speaks FILE paths but our code_units are
  // module-level; the store aggregates these file changes onto the existing
  // code_unit granularity (longest-prefix ownership; dir-move = file-rename cluster
  // → module rename; new dir = candidate unit; add/modify/delete inside an existing
  // module = no-op) BEFORE the deterministic refresh applies them.
  const result = await refresh(
    repo.name,
    { base: before, head: after, changes, granularity: "file" },
    { type: "agent", id: "webhook:" + provider },
  );
  // note 가 undefined 면 JSON 직렬화에서 키 생략 — 구 응답과 동일.
  res.status(200).json({ tally: result.tally, base: before, head: after, changes: changes.length, note: baseNote });
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

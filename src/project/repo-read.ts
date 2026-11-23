// 등록 레포의 판(커밋) 읽기 — 머리 · 태그(repo_refs) · 두 판 사이 바뀐 파일(repo_diff) · 한 판의 파일(repo_file) · 한 판에서 찾기(repo_grep).
//
//  왜(앱 v2 #124): 앱 서버와 앱 AI 작업이 «배포된 코드» 를 근거로 쓰려면 등록 레포의 정해진 판을 읽어야 한다. 지금까지 코드는 사람 세션만
//   워크트리 · 핀으로 읽었고, 앱 서버와 내장 셸을 끈 앱 AI 작업(ai.mcp_only)에는 길이 없었다. 첫 쓰임: 카드 정책 앱이 정책 값의 «제품 코드» 근거
//   (레포 · 커밋 · 파일 · 줄)를 새 배포판과 견주고, 바뀐 근거만 AI 가 새 판을 다시 읽어 값을 고친다.
//
//  ── 무엇을 읽나 ──
//   게이트웨이의 공유 클론(이 워크스페이스의 repos/<이름> — 워크트리의 부모)의 **깃 객체만** 읽는다. 워킹트리 파일을 fs 로 읽지 않는다
//   (symlink 를 따라가고, 받아 둔 사본에 누가 손댄 변경이 섞인다). clone · fetch 는 하지 않는다 — 최신화는 정기 작업(refresh_bases · 30분)과
//   repo_refresh 의 몫이다(앱 호출이 원격 · git 자격을 쓰지 않게 · 느린 호출이 쌓이지 않게). 그래서 repo_refs 는 마지막으로 받은 시각
//   (fetched_at — FETCH_HEAD 의 시각)을 함께 준다: 사본이 손댄 채로 남으면 refresh_bases 가 fetch 를 건너뛰어(refreshSharedRepo «dirty») 조용히 낡는다.
//
//  ── 어떤 판만 읽나 ──
//   공유 클론엔 다른 프로젝트가 아직 올리지 않은 커밋도 있다(워크트리 브랜치 project/* · stage/* · wt/* 가 같은 객체 저장소를 쓴다). 그래서
//   **원격 브랜치(refs/remotes/origin/*)에서 닿는 커밋만** 읽는다 — 원격 브랜치 이름 · 태그 이름 · 커밋 해시로 받되, 태그와 해시는 그 커밋이
//   원격 브랜치에서 닿아야 한다. 태그만으로는 받지 않는다: refs/tags 는 모든 워크트리가 함께 쓰는 자리라 세션이 단 로컬 태그와 원격에서 받은 태그를
//   가를 수 없다(격리 리뷰 2026-11-22). 배포 태그는 보통 원격 기본 브랜치의 커밋에 달린다(한 고객사 레포 6개의 최근 태그 18개 모두 그랬다).
//   로컬 브랜치 이름은 받지 않는다. repo_refs 의 태그 목록도 원격 브랜치에서 닿는 태그만 싣는다.
//
//  ── 어느 레포만 읽나 ──
//   이 워크스페이스에 등록되고(활성) git 주소가 있는 레포의, **이 워크스페이스가 받아 둔** 클론(project-provision sharedRepoPath —
//   게이트웨이 하나가 여러 워크스페이스를 서비스하면 워크스페이스마다 자리가 다르다). 그 위에 클론의 원격 주소가 등록 주소와 같아야 읽는다
//   (주소를 바꿔 등록했는데 옛 클론이 남은 경우). 앱 토큰 요청은 그 앱이 매니페스트 context.repos 에 적은 레포만
//   (apps/app-context.ts assertAppRepoAllowed — 능력 handler 가 부른다).
//
//  ── git 을 부르는 법 ──
//   execFile(셸 없음) · 인자 앞에서 꼴 검사(판 이름은 선두 영숫자 · 경로는 . .. 마디 금지) · --end-of-options · 출력 상한 · 시간 상한 ·
//   게이트웨이 프로세스 안 동시 실행 상한. 공유 클론의 .git 은 구성원 그룹이 쓸 수 있다(umask 0002) — 설정으로 명령을 끼우는 길을 끈다:
//   시스템 설정 안 읽음 · fsmonitor 끔 · 바꿔치기 객체(refs/replace) 안 씀 · pathspec 은 글자 그대로 · diff 는 외부 diff · textconv 없이 plumbing 으로.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sharedRepoPath, registeredBranchOfRow } from "./project-provision.js";
import { getRepo } from "../domainmap/core/repos.js";
import { HttpError } from "../http-error.js";

export const REPO_READ_LIMITS = Object.freeze({
  /** 한 파일 상한(바이트) — 넘으면 413. app_project_files 의 읽기 상한과 같다. */
  fileBytes: 8 * 1024 * 1024,
  /** repo_file 한 번에 주는 줄 — 기본 · 최대. */
  linesDefault: 400,
  linesMax: 5000,
  /** repo_diff 파일 목록 · 한 파일 패치(바이트) 상한. */
  diffFiles: 3000,
  patchBytes: 512 * 1024,
  /** repo_grep 맞은 줄 — 기본 · 최대 · 한 줄 글자 상한 · 찾는 글 길이 상한. */
  grepDefault: 50,
  grepMax: 300,
  grepLineChars: 400,
  patternMax: 200,
  /** 찾기 출력 상한(바이트) — 넘으면 받은 데까지로 자른다(맞은 줄 상한이 300 이라 앞부분이면 된다). */
  grepOutBytes: 4 * 1024 * 1024,
  /** repo_refs 태그 — 기본 · 최대(최근 만든 순). */
  tagsDefault: 50,
  tagsMax: 500,
  /** git 한 번의 출력 상한(바이트) · 시간 상한 · 게이트웨이 프로세스 안 동시 실행. */
  outBytes: 32 * 1024 * 1024,
  timeoutMs: 20_000,
  concurrent: 4,
});

const REPO_NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;
const HASH_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REF_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/;

/** 판 이름으로 받는 글 — 브랜치 · 태그 이름 꼴만(선두 영숫자 · .. @{ // 금지 · / .lock 로 끝나지 않음 · 점으로 시작하는 마디 없음). */
export function isRefName(s: string): boolean {
  return REF_NAME_RE.test(s) && !s.includes("..") && !s.includes("@{") && !s.includes("//") && !s.endsWith("/") && !s.endsWith(".lock")
    && !s.split("/").some((seg) => seg.startsWith("."));
}

/** 레포 안 파일 경로 — 앞 / · \ · 제어 문자 · 빈 · . · .. 마디 금지. 점으로 시작하는 마디(.github)는 받는다. */
export function isRepoPath(p: string): boolean {
  if (!p || p.length > 1000 || p.startsWith("/") || p.includes("\\") || /[\x00-\x1f]/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * 원격 주소의 견줄 꼴 — 호스트(소문자) + 경로(앞뒤 / · 끝 .git 뺌 · 소문자). 자격 · 포트 · 꼴(https · ssh · scp)은 보지 않는다.
 *  호스트가 없는 주소(로컬 경로 · file://)는 글 그대로(끝 / · .git 만 뺀다) 견준다.
 */
export function remoteKey(url: string): string | null {
  const s = String(url ?? "").trim();
  if (!s) return null;
  const trim = (p: string) => p.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    if (!u.hostname) return `local:${trim(decodeURIComponent(u.pathname))}`;
    const p = trim(u.pathname);
    return p ? `${u.hostname.toLowerCase()}/${p.toLowerCase()}` : null;
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(s);
  if (scp) {
    const p = trim(scp[2]);
    return p ? `${scp[1].toLowerCase()}/${p.toLowerCase()}` : null;
  }
  return `local:${trim(s)}`;
}

// ── git 실행 ────────────────────────────────────────────

//  게이트웨이 프로세스 안 동시 실행 상한 — AI 작업이 찾기를 몰아 불러도 git 이 CPU 를 다 먹지 않게. 끝난 자리는 기다리던 다음에게 바로 넘긴다.
let running = 0;
const waiters: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= REPO_READ_LIMITS.concurrent) await new Promise<void>((ok) => waiters.push(ok));
  else running++;
  try { return await fn(); }
  finally {
    const next = waiters.shift();
    if (next) next(); else running--;
  }
}

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C",
};
const GIT_PRE = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

class GitFail extends Error {
  constructor(readonly code: number, readonly stderr: string) { super(`git 실패(${code})`); }
}

/** partial — 출력이 상한(maxBuffer)을 넘으면 413 대신 받은 데까지 돌려준다(truncated: 참 · 찾기처럼 앞부분만으로 쓸 수 있는 출력). */
function runGit(dir: string, args: string[], opts: { buffer?: boolean; okCodes?: number[]; maxBuffer?: number; partial?: boolean } = {}): Promise<{ code: number; out: string | Buffer; truncated?: boolean }> {
  return slot(() => new Promise((resolve, reject) => {
    execFile("git", [...GIT_PRE, ...args], {
      cwd: dir, timeout: REPO_READ_LIMITS.timeoutMs, maxBuffer: opts.maxBuffer ?? REPO_READ_LIMITS.outBytes, encoding: opts.buffer ? "buffer" : "utf8",
      env: { ...process.env, ...GIT_ENV },
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, out: stdout });
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null };
      const code = typeof e.code === "number" ? e.code : -1;
      if (opts.okCodes?.includes(code)) return resolve({ code, out: stdout });
      const overflow = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(String(e.message));
      if (overflow && opts.partial) return resolve({ code: -2, out: stdout, truncated: true });
      if (overflow) return reject(new HttpError(413, "결과가 너무 큽니다 — 범위(경로 · 줄)를 좁혀 주세요"));
      if (e.killed || e.signal) return reject(new HttpError(504, `git 이 ${REPO_READ_LIMITS.timeoutMs / 1000}초 안에 끝나지 않았습니다 — 범위를 좁혀 주세요`));
      reject(new GitFail(code, String(stderr ?? "")));
    });
  }));
}
const text = async (dir: string, args: string[], okCodes?: number[]) => String((await runGit(dir, args, { okCodes })).out);

// ── 레포 · 판 해소 ────────────────────────────────────────

/** 해소한 공유 클론 — 읽기 함수(…At)는 이것을 받는다(시험은 DB 없이 임시 저장소로 만든다). */
export interface Clone { name: string; dir: string; row: Record<string, unknown> }

/** 등록 레포 → 공유 클론. 등록 · 활성 · git 주소 · 받아 둔 사본 · 원격 주소가 맞아야 한다(머리말 «어느 레포만»). */
export async function cloneOf(name: string): Promise<Clone> {
  const repo = String(name ?? "").trim();
  if (!REPO_NAME_RE.test(repo)) throw new HttpError(400, "레포 이름 형식이 올바르지 않습니다(영문 · 숫자 · . _ - 100자 이하)");
  const row = await getRepo(repo).catch((e: { status?: number }) => { if (e?.status === 404) return null; throw e; });
  if (!row) throw new HttpError(404, `이 워크스페이스에 등록된 레포가 아닙니다: ${repo} (repo_list 로 이름을 확인하세요)`);
  if (row.state && row.state !== "active") throw new HttpError(409, `레포 '${repo}' 는 지금 쓰지 않는 상태(${row.state})라 읽지 않습니다`);
  const gitUrl = typeof row.git_url === "string" ? row.git_url.trim() : "";
  if (!gitUrl) throw new HttpError(409, `레포 '${repo}' 는 git 주소가 등록되지 않아 판을 읽을 수 없습니다(repo_set_source 로 주소를 등록하세요)`);
  const dir = sharedRepoPath(repo);
  if (!fs.existsSync(path.join(dir, ".git"))) throw new HttpError(409, `레포 '${repo}' 를 게이트웨이가 아직 받아 두지 않았습니다 — repo_refresh 나 이 레포를 쓰는 프로젝트의 provision 으로 먼저 받으세요`);
  const origin = (await text(dir, ["config", "--get", "remote.origin.url"], [1]).catch(() => "")).trim();
  const want = remoteKey(gitUrl);
  if (!want || remoteKey(origin) !== want) {
    throw new HttpError(409, `레포 '${repo}' 의 받아 둔 사본이 등록한 git 주소와 다른 원격을 가리킵니다 — 관리자에게 사본 정리를 요청하세요`);
  }
  return { name: repo, dir, row };
}

//  닿는가 기억 — 커밋은 바뀌지 않고, 원격 브랜치 · 태그에서 닿던 커밋이 닿지 않게 되는 일(강제 푸시 · 태그 삭제)은 드물다. 10분.
const REACH_TTL_MS = 10 * 60_000;
const REACH_MAX = 5000;
const reachCache = new Map<string, number>();

/**
 * 판 하나 → 커밋 해시. 받는 꼴: 커밋 해시(40 · 64자 — 원격 브랜치나 태그에서 닿아야 한다) · 원격 브랜치 이름(origin/<b> 또는 <b>) · 태그 이름.
 *  같은 이름의 브랜치와 태그가 있으면 브랜치. 로컬 브랜치(워크트리 project/* 등)는 읽지 않는다.
 */
export async function resolveCommit(c: Clone, rev: string): Promise<string> {
  const r = String(rev ?? "").trim();
  if (HASH_RE.test(r)) {
    const sha = (await text(c.dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${r}^{commit}`], [1]).catch(() => "")).trim();
    if (!sha) throw new HttpError(404, `커밋 ${r.slice(0, 12)} 이 받아 둔 사본에 없습니다(아직 받지 않았거나 없는 커밋)`);
    await assertReachable(c, sha, `커밋 ${sha.slice(0, 12)}`);
    return sha;
  }
  if (!isRefName(r)) throw new HttpError(400, "판은 커밋 해시(40자) · 원격 브랜치 이름 · 태그 이름 가운데 하나여야 합니다");
  const branch = r.startsWith("origin/") ? r.slice("origin/".length) : r;
  const peel = async (full: string) => (await text(c.dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${full}^{commit}`], [1]).catch(() => "")).trim();
  //  원격 브랜치 머리는 그 자체로 닿는다. 태그는 그 커밋이 원격 브랜치에서 닿아야 한다(머리말 «어떤 판만»).
  if (branch !== "HEAD") {
    const sha = await peel(`refs/remotes/origin/${branch}`);
    if (sha) return sha;
  }
  const tagged = await peel(`refs/tags/${r}`);
  if (tagged) {
    await assertReachable(c, tagged, `태그 '${r}' 의 커밋`);
    return tagged;
  }
  throw new HttpError(404, `'${r}' 라는 원격 브랜치나 태그가 받아 둔 사본에 없습니다`);
}

/** 원격 브랜치에서 닿는가(기억 10분) — 아니면 404. */
async function assertReachable(c: Clone, sha: string, what: string): Promise<void> {
  const key = `${c.dir}\0${sha}`;
  const at = reachCache.get(key);
  if (at != null && Date.now() - at <= REACH_TTL_MS) return;
  const hit = (await text(c.dir, ["for-each-ref", "--count=1", "--format=%(refname)", "--contains", sha, "refs/remotes/origin/"])).trim();
  if (!hit) throw new HttpError(404, `${what} 은 원격 브랜치에서 닿지 않아 읽지 않습니다(올라가지 않은 작업 커밋이거나 로컬 태그)`);
  if (reachCache.size >= REACH_MAX) reachCache.clear();
  reachCache.set(key, Date.now());
}

/** 등록한 기본 브랜치 — 등록값(git 소스를 등록한 레포만 · 판 이름 꼴일 때만) → 원격 기본(origin/HEAD) → main. */
async function defaultBranchOf(c: Clone): Promise<string> {
  //  등록값의 꼴 검사(registeredBranchOfRow — 선두 영숫자)는 «a..b» · «bad/» 같은 이름을 받는다 — 판 이름 꼴(isRefName)까지 봐서 틀리면 원격 기본으로.
  const reg = registeredBranchOfRow(c.row as { git_url?: unknown; default_branch?: unknown });
  if (reg && isRefName(reg)) return reg;
  const sym = (await text(c.dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], [1]).catch(() => "")).trim();
  const b = sym.startsWith("refs/remotes/origin/") ? sym.slice("refs/remotes/origin/".length) : "";
  return b && isRefName(b) ? b : "main";
}

// ── 읽기 ─────────────────────────────────────────────────

export interface RepoRefs {
  repo: string;
  default_branch: string;
  /** 기본 브랜치의 머리(원격) — 받아 둔 사본에 그 브랜치가 없으면 null. */
  head: { branch: string; commit: string; date: string; subject: string } | null;
  /** 태그 — 최근 만든 순. commit 은 태그가 가리키는 커밋(주석 태그는 벗긴 것) · date 는 그 커밋의 시각. */
  tags: Array<{ name: string; commit: string; date: string; tagged_at: string }>;
  tags_truncated: boolean;
  /** 이 사본이 원격에서 마지막으로 받은 시각(FETCH_HEAD) — 모르면 null. */
  fetched_at: string | null;
}

/** 머리 · 태그. */
export async function repoRefs(name: string, opts: { tags?: number } = {}): Promise<RepoRefs> {
  return repoRefsAt(await cloneOf(name), opts);
}
export async function repoRefsAt(c: Clone, opts: { tags?: number } = {}): Promise<RepoRefs> {
  const branch = await defaultBranchOf(c);
  const headLine = (await text(c.dir, ["for-each-ref", "--count=1", "--format=%(objectname)%00%(committerdate:iso-strict)%00%(contents:subject)", `refs/remotes/origin/${branch}`])).trim();
  const [hc, hd, hs] = headLine.split("\0");
  const head = hc && HASH_RE.test(hc) ? { branch, commit: hc, date: hd ?? "", subject: (hs ?? "").slice(0, 300) } : null;
  const limit = Math.min(Math.max(1, opts.tags ?? REPO_READ_LIMITS.tagsDefault), REPO_READ_LIMITS.tagsMax);
  //  태그가 가리키는 것: 주석 태그면 *objectname(벗긴 커밋), 아니면 objectname. 커밋이 아닌 것을 가리키는 태그는 버린다.
  //  원격 브랜치에서 닿는 태그만(머리말 «어떤 판만») — --merged 를 원격 브랜치마다 주면 그 가운데 하나에서 닿는 태그다(git 2.30+ 은 여럿을 «또는» 으로 본다).
  const fmt = "%(refname:strip=2)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(committerdate:iso-strict)%00%(*committerdate:iso-strict)%00%(creatordate:iso-strict)";
  const remotes = (await text(c.dir, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"])).split("\n").filter((x) => x && x !== "refs/remotes/origin/HEAD");
  const raw = remotes.length
    ? await text(c.dir, ["for-each-ref", "--sort=-creatordate", `--count=${limit + 1}`, `--format=${fmt}`, ...remotes.map((x) => `--merged=${x}`), "refs/tags/"])
    : "";
  const rows = raw.split("\n").filter(Boolean);
  const tags: RepoRefs["tags"] = [];
  for (const line of rows.slice(0, limit)) {
    const [tag, type, obj, ptype, pobj, cdate, pcdate, created] = line.split("\0");
    const commit = type === "commit" ? obj : ptype === "commit" ? pobj : "";
    if (!tag || !HASH_RE.test(commit ?? "")) continue;
    tags.push({ name: tag, commit, date: (type === "commit" ? cdate : pcdate) ?? "", tagged_at: created ?? "" });
  }
  let fetched: string | null = null;
  try { fetched = fs.statSync(path.join(c.dir, ".git", "FETCH_HEAD")).mtime.toISOString(); } catch { /* 받은 적 없음 */ }
  return { repo: c.name, default_branch: branch, head, tags, tags_truncated: rows.length > limit, fetched_at: fetched };
}

export interface RepoDiffFiles { repo: string; from: string; to: string; files: Array<{ status: string; path: string }>; truncated: boolean }
export interface RepoDiffPatch { repo: string; from: string; to: string; path: string; patch: string; truncated: boolean }

/** 두 판 사이 — path 가 없으면 바뀐 파일 목록(이름 바꿈은 지움 + 더함으로), 있으면 그 파일의 패치(앞뒤 3줄). */
export async function repoDiff(name: string, from: string, to: string, opts: { path?: string } = {}): Promise<RepoDiffFiles | RepoDiffPatch> {
  return repoDiffAt(await cloneOf(name), from, to, opts);
}
export async function repoDiffAt(c: Clone, from: string, to: string, opts: { path?: string } = {}): Promise<RepoDiffFiles | RepoDiffPatch> {
  const a = await resolveCommit(c, from);
  const b = await resolveCommit(c, to);
  if (opts.path == null || opts.path === "") {
    const raw = await text(c.dir, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", "--no-ext-diff", "--no-textconv", "--end-of-options", a, b]);
    const parts = raw.split("\0");
    const files: RepoDiffFiles["files"] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      if (!parts[i]) break;
      if (files.length >= REPO_READ_LIMITS.diffFiles) return { repo: c.name, from: a, to: b, files, truncated: true };
      files.push({ status: parts[i].slice(0, 1), path: parts[i + 1] });
    }
    return { repo: c.name, from: a, to: b, files, truncated: false };
  }
  const p = String(opts.path);
  if (!isRepoPath(p)) throw new HttpError(400, "path 는 레포 안의 파일 경로여야 합니다(앞에 / 없이 · . .. 마디 없이)");
  const buf = (await runGit(c.dir, ["diff-tree", "-p", "-r", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "-U3", "--end-of-options", a, b, "--", p], { buffer: true })).out as Buffer;
  const truncated = buf.length > REPO_READ_LIMITS.patchBytes;
  return { repo: c.name, from: a, to: b, path: p, patch: buf.subarray(0, REPO_READ_LIMITS.patchBytes).toString("utf8"), truncated };
}

export interface RepoFile {
  repo: string; commit: string; path: string; total_lines: number;
  range: { from: number; to: number; has_more: boolean };
  /** 고른 줄 — numbered 면 줄마다 «번호\t글»(cat -n 꼴), 아니면 글 그대로(줄바꿈으로 잇는다). */
  text: string;
}

/** 한 판의 파일 — 줄 범위(offset 1부터 · limit). 이진 파일 · 상한을 넘는 파일은 받지 않는다. */
export async function repoFile(name: string, rev: string, filePath: string, opts: { offset?: number; limit?: number; numbered?: boolean } = {}): Promise<RepoFile> {
  return repoFileAt(await cloneOf(name), rev, filePath, opts);
}
export async function repoFileAt(c: Clone, rev: string, filePath: string, opts: { offset?: number; limit?: number; numbered?: boolean } = {}): Promise<RepoFile> {
  const sha = await resolveCommit(c, rev);
  const p = String(filePath ?? "");
  if (!isRepoPath(p)) throw new HttpError(400, "path 는 레포 안의 파일 경로여야 합니다(앞에 / 없이 · . .. 마디 없이)");
  const spec = `${sha}:${p}`;
  const type = (await text(c.dir, ["cat-file", "-t", "--end-of-options", spec], [128]).catch(() => "")).trim();
  if (type !== "blob") throw new HttpError(404, type ? `'${p}' 는 그 판에서 파일이 아닙니다(${type})` : `'${p}' 는 그 판(${sha.slice(0, 12)})에 없습니다`);
  const size = Number((await text(c.dir, ["cat-file", "-s", "--end-of-options", spec])).trim());
  if (!Number.isFinite(size) || size > REPO_READ_LIMITS.fileBytes) throw new HttpError(413, `파일이 너무 큽니다(${size} 바이트 — ${REPO_READ_LIMITS.fileBytes} 바이트까지)`);
  const buf = (await runGit(c.dir, ["cat-file", "blob", "--end-of-options", spec], { buffer: true })).out as Buffer;
  if (buf.includes(0)) throw new HttpError(415, `'${p}' 는 이진 파일이라 글로 읽지 않습니다`);
  const all = buf.toString("utf8").split("\n");
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const total = buf.length === 0 ? 0 : all.length;
  const offset = Math.max(1, Math.floor(opts.offset ?? 1));
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? REPO_READ_LIMITS.linesDefault)), REPO_READ_LIMITS.linesMax);
  const picked = total ? all.slice(offset - 1, offset - 1 + limit) : [];
  const to = picked.length ? offset + picked.length - 1 : offset - 1;
  const numbered = opts.numbered !== false;
  return {
    repo: c.name, commit: sha, path: p, total_lines: total,
    range: { from: offset, to, has_more: to < total },
    text: numbered ? picked.map((l, i) => `${offset + i}\t${l}`).join("\n") : picked.join("\n"),
  };
}

export interface RepoGrep { repo: string; commit: string; pattern: string; hits: Array<{ path: string; line: number; text: string }>; truncated: boolean }

/** 한 판에서 글자 그대로 찾기(정규식 아님) — path 를 주면 그 경로(파일 · 폴더) 아래만. 이진 파일은 건너뛴다. */
export async function repoGrep(name: string, rev: string, pattern: string, opts: { path?: string; limit?: number; ignore_case?: boolean } = {}): Promise<RepoGrep> {
  return repoGrepAt(await cloneOf(name), rev, pattern, opts);
}
export async function repoGrepAt(c: Clone, rev: string, pattern: string, opts: { path?: string; limit?: number; ignore_case?: boolean } = {}): Promise<RepoGrep> {
  const sha = await resolveCommit(c, rev);
  const pat = String(pattern ?? "");
  if (!pat.trim() || pat.length > REPO_READ_LIMITS.patternMax || /[\x00\n\r]/.test(pat)) {
    throw new HttpError(400, `찾을 글(q)은 1~${REPO_READ_LIMITS.patternMax}자 한 줄이어야 합니다`);
  }
  const p = opts.path == null || opts.path === "" ? null : String(opts.path).replace(/\/+$/, "");
  if (p != null && !isRepoPath(p)) throw new HttpError(400, "path 는 레포 안의 경로여야 합니다(앞에 / 없이 · . .. 마디 없이)");
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? REPO_READ_LIMITS.grepDefault)), REPO_READ_LIMITS.grepMax);
  //  git grep 은 판 앞의 --end-of-options 를 받지 않는다(«must come before non-option arguments») — 판은 위에서 해시로 해소했고 찾을 글은 -e 로 넘긴다.
  //  -m: 파일마다 맞은 줄 상한(흔한 글자로 큰 레포를 찾을 때 출력이 커지지 않게) · 출력 상한을 넘으면 받은 데까지(partial).
  const args = ["grep", "-n", "-I", "-F", "-z", "--no-color", "--full-name", `--max-count=${limit + 1}`, ...(opts.ignore_case ? ["-i"] : []), "-e", pat, sha, ...(p ? ["--", p] : [])];
  const res = await runGit(c.dir, args, { okCodes: [1], maxBuffer: REPO_READ_LIMITS.grepOutBytes, partial: true });
  const all = parseGrepZ(String(res.out), sha);
  const hits = all.slice(0, limit).map((h) => ({ ...h, text: h.text.length > REPO_READ_LIMITS.grepLineChars ? `${h.text.slice(0, REPO_READ_LIMITS.grepLineChars)}…` : h.text }));
  return { repo: c.name, commit: sha, pattern: pat, hits, truncated: all.length > limit || res.truncated === true };
}

/**
 * git grep -z 출력 읽기 — 한 줄은 «판:경로\0줄 번호\0글\n». 경로에 줄바꿈이 들어도 깨지지 않게 줄로 먼저 나누지 않고 차례로 읽는다.
 *  끝이 잘린 마지막 줄(출력 상한)은 버린다.
 */
export function parseGrepZ(raw: string, sha: string): Array<{ path: string; line: number; text: string }> {
  const out: Array<{ path: string; line: number; text: string }> = [];
  let i = 0;
  while (i < raw.length) {
    const a = raw.indexOf("\0", i);
    if (a < 0) break;
    const b = raw.indexOf("\0", a + 1);
    if (b < 0) break;
    const e = raw.indexOf("\n", b + 1);
    if (e < 0) break;
    const where = raw.slice(i, a);
    const file = where.startsWith(`${sha}:`) ? where.slice(sha.length + 1) : where;
    const n = Number(raw.slice(a + 1, b));
    if (file && Number.isInteger(n) && n > 0) out.push({ path: file, line: n, text: raw.slice(b + 1, e) });
    i = e + 1;
  }
  return out;
}

// 커밋 작업 기록 → activity_touch 유도 워커.
//
//  작업 기록에 commit_sha·repo_id 가 있어도 touches 는 호출자가 넘길 때만 생겼다. 그래서 코드 단위와 지식을 잇는 경로
//  (domain-debt 의 active_commits, 이후 code_drift 후보)가 거의 비어 있었다. 이 워커가 서버의 도메인맵 클론에서 그 커밋의
//  변경 파일을 읽어(제공자 중립 · 자격은 클론이 이미 가진 것) 도메인맵과 같은 최장 접두 규칙(unitOwner)으로 code_unit 에
//  매핑해 채운다.
//
//  상태 표 activity_touch_derive 에 쓰는 것은 이 워커뿐이다. 작업 기록 테이블을 정본으로 보고 차이를 맞춘다.
//   S1 새 행   — 커밋이 있고 상태 행도 code_unit touch 도 없는 작업 기록 → repo_id 없으면 no_repo, 있으면 pending
//               (기록할 때 호출자가 code_unit 을 넘겼으면 유도하지 않는다. data_entity 만 넘긴 기록은 유도한다.
//                유도 뒤에 호출자가 넘긴 touch 는 유도분과 함께 남고 derived=false 라 S2 가 지우지 않는다)
//   S2 재동기  — 상태 행의 commit_sha·repo_id 가 작업 기록과 다르면(상태 무관, running 포함) 두 칸을 맞추고 pending(또는 no_repo),
//               enqueued_at=now(), 그 작업 기록의 유도 touch(derived=true)만 지운다
//   S3 첫 모듈 — no_units 행의 레포에 active code_unit 이 생기면 pending
//   S4 만료    — enqueued_at 이 30일을 넘긴 pending·failed·리스가 끝난 running → expired
//   A1 선점    — 30일 안의 pending·failed·리스가 끝난 running → running, attempted_at=now()(SKIP LOCKED)
//   A2 종료    — 한 트랜잭션: 작업 기록 행 확인 → 내 선점인지 확인(아니면 아무것도 안 씀) → sha·레포가 바뀌었으면 S2 와 같은 쓰기
//               → 아니면 유도 touch 를 넣고 ok·empty·no_units·failed, 클론 잠금을 못 얻었으면 pending, 레포 행이 지워졌거나
//               비활성(deprecated)이면 no_repo. 재시도해도 결과가 같은 실패(커밋 sha 꼴이 아님 · git 출력 상한 초과)는 failed 로
//               30일을 돌지 않고 바로 expired(error 에 까닭)
//  종착은 ok·empty·expired·no_repo 이고 S2 로만 다시 열린다(no_units 는 S3 로도). 미매칭 파일은 다시 유도하지 않는다 —
//  루트 파일처럼 영영 매칭되지 않는 경로를 매일 재처리하게 된다.
//
//  잠금 순서(교착 방지): 모든 쓰기 트랜잭션은 작업 기록 행을 FOR KEY SHARE 로 먼저 잡는다 — 작업 기록 갱신(FOR NO KEY UPDATE)과는
//   부딪치지 않고, 작업 기록 삭제(FOR UPDATE, 상태 행·touch CASCADE)와는 첫 줄에서 만나 한쪽이 기다린다. 그다음 상태 행, 그다음
//   touch 를 (target_kind, target_id) 순으로 — logActivity 의 호출자 touch INSERT 도 같은 순서다.
import type pg from "pg";
import { itemsPool, withTx } from "../db/client.js";
import { logger } from "../log.js";
import { existsSync } from "node:fs";
import { ensureClone, git, parseDiff, repoClonePath, CloneBusyError, GIT_MAX_BUFFER } from "../domainmap/git-sync.js";
import { unitOwner } from "../domainmap/core/aggregate.js";
import { describeGitError } from "../org/credentials/git-credential-store.js";

// 선점 리스는 잠금 대기 상한(10초)에 fetch 한 번과 git show 를 더한 시간보다 충분히 길어야 한다 — 짧으면 선점을 잃은 시도의 일이 버려진다.
export const DERIVE_LEASE = "15 minutes";
// 브랜치가 지워진 커밋은 클론에서 영영 못 잡는다 — 그 기간만큼 매일 재시도하고 닫는다.
export const DERIVE_WINDOW = "30 days";
const GIT_TIMEOUT_MS = 180_000;
/** 커밋 한 건의 변경 파일 목록(git show)을 받을 표준출력 상한 — 시험이 작게 바꿔 넘침을 재현한다. */
export const DERIVE_GIT_LIMITS = { maxBuffer: GIT_MAX_BUFFER };
const CLAIM_CHUNK = 200;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export type DeriveStatus = "pending" | "running" | "ok" | "empty" | "failed" | "expired" | "no_repo" | "no_units";

interface ActivityKey { commit_sha: string | null; repo_id: number | null }
interface Claimed extends ActivityKey { activity_id: number; attempted_at: string }

/** 시도 결과(트랜잭션 밖 git 작업의 산출). files 의 원소는 이름-상태 한 줄의 경로들이다. retry 는 클론 잠금 대기 상한 등 「다음에 다시」. */
export type DeriveOutcome =
  | { kind: "files"; files: string[][] }
  | { kind: "retry" }
  //  terminal — 재시도해도 결과가 같은 실패. failed 로 30일 매일 다시 잡지 않고 바로 종착(expired)으로 닫는다.
  | { kind: "error"; error: string; terminal?: boolean };

const lockActivity = async (c: pg.PoolClient, id: number): Promise<ActivityKey | null> =>
  ((await c.query(`SELECT NULLIF(commit_sha,'') AS commit_sha, repo_id FROM activity WHERE id=$1 FOR KEY SHARE`, [id])).rows[0] as ActivityKey | undefined) ?? null;

async function deleteDerivedTouches(c: pg.PoolClient, id: number): Promise<void> {
  await c.query(
    `SELECT id FROM activity_touch WHERE activity_id=$1 AND derived ORDER BY target_kind, target_id FOR UPDATE`, [id]);
  await c.query(`DELETE FROM activity_touch WHERE activity_id=$1 AND derived`, [id]);
}

/** S2 의 쓰기 — 상태 행을 작업 기록 값에 맞춰 다시 열고 유도 touch 를 지운다. 커밋이 빠진 기록이면 상태 행째 지운다. */
async function resyncIn(c: pg.PoolClient, id: number, a: ActivityKey): Promise<void> {
  if (!a.commit_sha) {
    await c.query(`DELETE FROM activity_touch_derive WHERE activity_id=$1`, [id]);
  } else {
    await c.query(
      `UPDATE activity_touch_derive
          SET commit_sha=$2, repo_id=$3, status=$4, enqueued_at=now(), attempted_at=NULL,
              changed_files=NULL, unmatched_files=NULL, error=NULL
        WHERE activity_id=$1`,
      [id, a.commit_sha, a.repo_id, a.repo_id == null ? "no_repo" : "pending"]);
  }
  await deleteDerivedTouches(c, id);
}

export interface ReconcileCounts { inserted: number; resynced: number; reopened: number; expired: number }

/** S1~S4. activityId 를 주면 그 작업 기록 한 건의 S1·S2 만 본다(기록 직후 시도). */
export async function reconcileDeriveRows(activityId?: number): Promise<ReconcileCounts> {
  const out: ReconcileCounts = { inserted: 0, resynced: 0, reopened: 0, expired: 0 };
  const one = activityId != null;
  const idCond = one ? "AND a.id = $1" : "";
  const idParams = one ? [activityId] : [];

  // S1 — 한 행씩 짧은 트랜잭션. touch 유무는 잠근 뒤 다시 본다(그 사이 호출자가 touches 를 넘겼을 수 있다).
  const fresh = (await itemsPool.query(
    `SELECT a.id FROM activity a
      WHERE NULLIF(a.commit_sha,'') IS NOT NULL ${idCond}
        AND NOT EXISTS (SELECT 1 FROM activity_touch_derive d WHERE d.activity_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM activity_touch t WHERE t.activity_id = a.id AND t.target_kind = 'code_unit')
      ORDER BY a.id`, idParams)).rows as { id: number }[];
  for (const { id } of fresh) {
    const done = await withTx(async (c) => {
      const a = await lockActivity(c, id);
      if (!a?.commit_sha) return false;
      if ((await c.query(`SELECT 1 FROM activity_touch WHERE activity_id=$1 AND target_kind='code_unit' LIMIT 1`, [id])).rowCount) return false;
      const r = await c.query(
        `INSERT INTO activity_touch_derive(activity_id, commit_sha, repo_id, status, enqueued_at)
         VALUES($1,$2,$3,$4,now()) ON CONFLICT (activity_id) DO NOTHING`,
        [id, a.commit_sha, a.repo_id, a.repo_id == null ? "no_repo" : "pending"]);
      return (r.rowCount ?? 0) > 0;
    });
    if (done) out.inserted++;
  }

  // S2 — 상태 행이 가리키는 sha·레포가 작업 기록과 다른 것.
  const drifted = (await itemsPool.query(
    `SELECT d.activity_id AS id FROM activity_touch_derive d JOIN activity a ON a.id = d.activity_id
      WHERE (d.commit_sha IS DISTINCT FROM NULLIF(a.commit_sha,'') OR d.repo_id IS DISTINCT FROM a.repo_id) ${idCond}
      ORDER BY d.activity_id`, idParams)).rows as { id: number }[];
  for (const { id } of drifted) {
    const done = await withTx(async (c) => {
      const a = await lockActivity(c, id);
      if (!a) return false;
      const d = (await c.query(
        `SELECT commit_sha, repo_id FROM activity_touch_derive WHERE activity_id=$1 FOR UPDATE`, [id])).rows[0] as ActivityKey | undefined;
      if (!d || (d.commit_sha === a.commit_sha && d.repo_id === a.repo_id)) return false;
      await resyncIn(c, id, a);
      return true;
    });
    if (done) out.resynced++;
  }
  if (one) return out;

  // S3·S4 — 상태 행만 바꾼다(작업 기록·touch 를 안 건드린다). 잡힌 행은 건너뛰어 다른 시도와 줄 서지 않는다.
  out.reopened = (await itemsPool.query(
    `UPDATE activity_touch_derive SET status='pending', enqueued_at=now()
      WHERE activity_id IN (
        SELECT d.activity_id FROM activity_touch_derive d
         WHERE d.status='no_units'
           AND EXISTS (SELECT 1 FROM code_unit cu WHERE cu.repo_id = d.repo_id AND COALESCE(cu.state,'active')='active')
         ORDER BY d.activity_id FOR UPDATE SKIP LOCKED)`)).rowCount ?? 0;
  out.expired = (await itemsPool.query(
    `UPDATE activity_touch_derive SET status='expired'
      WHERE activity_id IN (
        SELECT d.activity_id FROM activity_touch_derive d
         WHERE (d.status IN ('pending','failed') OR (d.status='running' AND d.attempted_at < now() - interval '${DERIVE_LEASE}'))
           AND d.enqueued_at < now() - interval '${DERIVE_WINDOW}'
         ORDER BY d.activity_id FOR UPDATE SKIP LOCKED)`)).rowCount ?? 0;
  return out;
}

/** A1 — 이번 실행이 시작된 뒤에 시도한 행은 다시 잡지 않는다(같은 실행 안에서 failed·잠금 대기 행을 맴돌지 않게). */
async function claim(runStartedAt: string, limit: number, activityId?: number): Promise<Claimed[]> {
  const params: unknown[] = [runStartedAt, limit];
  if (activityId != null) params.push(activityId);
  return (await itemsPool.query(
    `UPDATE activity_touch_derive d SET status='running', attempted_at=now()
      WHERE d.activity_id IN (
        SELECT x.activity_id FROM activity_touch_derive x
         WHERE (x.status IN ('pending','failed') OR (x.status='running' AND x.attempted_at < now() - interval '${DERIVE_LEASE}'))
           AND x.enqueued_at >= now() - interval '${DERIVE_WINDOW}'
           AND (x.attempted_at IS NULL OR x.attempted_at < $1::timestamptz)
           ${activityId != null ? "AND x.activity_id = $3" : ""}
         ORDER BY x.activity_id LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING d.activity_id, d.commit_sha, d.repo_id, d.attempted_at::text AS attempted_at`, params)).rows as Claimed[];
}

export type FinishResult = "ok" | "empty" | "no_units" | "no_repo" | "failed" | "expired" | "pending" | "lost" | "gone" | "resynced";

/** A2 — 선점(attempted_at)이 그대로일 때만 쓴다. 매핑은 이 트랜잭션에서 읽은 active code_unit 으로 한다. */
export async function finishDerive(cl: Claimed, outcome: DeriveOutcome): Promise<FinishResult> {
  return withTx(async (c) => {
    const a = await lockActivity(c, cl.activity_id);
    if (!a) return "gone";
    const mine = await c.query(
      `SELECT 1 FROM activity_touch_derive WHERE activity_id=$1 AND status='running' AND attempted_at=$2::timestamptz FOR UPDATE`,
      [cl.activity_id, cl.attempted_at]);
    if (!mine.rowCount) return "lost";
    if (a.commit_sha !== cl.commit_sha || a.repo_id !== cl.repo_id) {
      await resyncIn(c, cl.activity_id, a);
      return "resynced";
    }
    const set = async (status: DeriveStatus, changed: number | null, unmatched: number | null, error: string | null): Promise<void> => {
      await c.query(
        `UPDATE activity_touch_derive SET status=$2, changed_files=$3, unmatched_files=$4, error=$5 WHERE activity_id=$1`,
        [cl.activity_id, status, changed, unmatched, error]);
    };
    //  레포 행이 지워졌거나 비활성(deprecated)이면 다시 열 길이 S2(작업 기록의 레포 변경)뿐이다 — no_units 로 두면 남은 code_unit 행
    //   때문에 S3 가 헛돌 수 있다. 비활성 레포는 prepareRepo 가 fetch 하지 않는다(숨김 신호 — 도메인맵 갱신도 멈춘 레포다).
    if (!(await c.query(`SELECT 1 FROM repo WHERE id=$1 AND COALESCE(state,'active')='active'`, [cl.repo_id])).rowCount) {
      await set("no_repo", null, null, null);
      return "no_repo";
    }
    const units = (await c.query(
      `SELECT id, path FROM code_unit WHERE repo_id=$1 AND COALESCE(state,'active')='active'`, [cl.repo_id])).rows as { id: number; path: string }[];
    if (!units.length) { await set("no_units", null, null, null); return "no_units"; }
    if (outcome.kind === "retry") {
      await c.query(`UPDATE activity_touch_derive SET status='pending' WHERE activity_id=$1`, [cl.activity_id]);
      return "pending";
    }
    if (outcome.kind === "error") {
      const st = outcome.terminal ? "expired" : "failed";
      await set(st, null, null, outcome.error.slice(0, 500));
      return st;
    }
    if (!outcome.files.length) { await set("empty", 0, 0, null); return "empty"; }
    const idByPath = new Map(units.map((u) => [u.path, u.id]));
    const ownerPath = unitOwner([...idByPath.keys()]);
    const ownerId = (p: string): number | undefined => { const u = ownerPath(p); return u === null ? undefined : idByPath.get(u); };
    const ids = new Set<number>();
    let unmatched = 0;
    for (const paths of outcome.files) {
      const owned = paths.map(ownerId).filter((id): id is number => id !== undefined);
      if (!owned.length) { unmatched++; continue; }
      for (const id of owned) ids.add(id);
    }
    for (const id of [...ids].sort((x, y) => x - y)) {
      await c.query(
        `INSERT INTO activity_touch(activity_id, target_kind, target_id, created_at, derived)
         VALUES($1,'code_unit',$2,now(),true) ON CONFLICT (activity_id, target_kind, target_id) DO NOTHING`,
        [cl.activity_id, id]);
    }
    await set("ok", outcome.files.length, unmatched, null);
    return "ok";
  });
}

/**
 * 커밋 한 건의 변경 파일. 머지 커밋은 --diff-merges=first-parent 가 없으면 0줄이 나와 오류가 아니라 조용한 거짓 empty 가 된다.
 *  --no-renames 로 옮긴 파일은 옛 경로·새 경로를 각각 한 줄로 받는다(둘 다 매핑 대상이다).
 *  ^{commit} 으로 커밋만 받는다 — blob sha 는 그 경로 하나를 「바뀐 파일」 처럼, tree sha 는 0줄(거짓 empty)을 내기 때문이다.
 */
export async function changedFiles(cloneDir: string, sha: string): Promise<string[][]> {
  const out = (await git(
    ["-C", cloneDir, "-c", "core.quotePath=false", "show", "--diff-merges=first-parent", "--no-renames", "--name-status", "--format=", `${sha}^{commit}`],
    undefined, undefined, { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: DERIVE_GIT_LIMITS.maxBuffer })).stdout || "";
  return parseDiff(out).map((ch) => [ch.path ?? ch.to, ch.from].filter((p): p is string => typeof p === "string" && p !== ""));
}

interface RepoFetch { name: string; gitUrl?: string; cloneDir?: string; busy?: boolean; error?: string; noUnits?: boolean; noRepo?: boolean }

/** 커밋이 이미 클론에 있는가 — 기록 직후 시도가 기록마다 원격 fetch 를 하지 않게 먼저 본다. */
async function hasCommit(cloneDir: string, sha: string | null): Promise<boolean> {
  if (!sha || !SHA_RE.test(sha) || !existsSync(cloneDir)) return false;
  try { await git(["-C", cloneDir, "cat-file", "-e", `${sha}^{commit}`], undefined, undefined, { timeoutMs: GIT_TIMEOUT_MS }); return true; }
  catch { return false; }
}

async function prepareRepo(repoId: number | null, lockWaitMs?: number, probeSha?: string | null): Promise<RepoFetch> {
  const repo = repoId == null ? null
    : ((await itemsPool.query(`SELECT name, git_url, COALESCE(state,'active') AS state FROM repo WHERE id=$1`, [repoId])).rows[0] as
      { name: string; git_url: string | null; state: string } | undefined);
  //  지워진 레포는 fetch 실패가 아니다 — A2 가 no_repo 로 닫는다. 비활성(deprecated) 레포도 fetch 하지 않고 같은 길로 닫는다.
  if (!repo) return { name: String(repoId), noRepo: true };
  if (repo.state !== "active") return { name: repo.name, noRepo: true };
  //  모듈이 없는 레포는 fetch 하지 않는다 — 결과는 어차피 no_units 다(A2 가 다시 본다).
  const units = (await itemsPool.query(
    `SELECT 1 FROM code_unit WHERE repo_id=$1 AND COALESCE(state,'active')='active' LIMIT 1`, [repoId])).rowCount;
  if (!units) return { name: repo.name, noUnits: true };
  if (!repo.git_url) return { name: repo.name, error: "no git_url" };
  try {
    if (probeSha !== undefined) {
      const dir = repoClonePath(repo.name);
      if (await hasCommit(dir, probeSha)) return { name: repo.name, gitUrl: repo.git_url, cloneDir: dir };
    }
    return { name: repo.name, gitUrl: repo.git_url, cloneDir: await ensureClone(repo.name, repo.git_url, { timeoutMs: GIT_TIMEOUT_MS, lockWaitMs }) };
  } catch (e) {
    if (e instanceof CloneBusyError) return { name: repo.name, busy: true };
    return { name: repo.name, error: `git clone/fetch 실패: ${describeGitError(e, repo.git_url)}` };
  }
}

/** 커밋 sha 꼴이 아닌 기록 — 클론과 무관하게 실패가 정해져 있어(재시도해도 같다) fetch 전에 가려 바로 종착으로 닫는다. */
function invalidShaOutcome(sha: string | null): DeriveOutcome | null {
  return !sha || !SHA_RE.test(sha) ? { kind: "error", error: "invalid commit sha", terminal: true } : null;
}

async function attempt(rf: RepoFetch, sha: string): Promise<DeriveOutcome> {
  //  fetch 전에 모듈이 없던 레포 — A2 가 그때도 없으면 no_units, 그사이 생겼으면 pending 으로 다음 실행에 넘긴다.
  if (rf.noUnits || rf.busy || rf.noRepo) return { kind: "retry" };
  if (rf.error || !rf.cloneDir) return { kind: "error", error: rf.error ?? "clone unavailable" };
  try { return { kind: "files", files: await changedFiles(rf.cloneDir, sha) }; }
  catch (e) {
    //  변경 파일 목록이 출력 상한을 넘었다(거대한 커밋) — 같은 커밋은 매번 같은 크기라 재시도해도 같다.
    if ((e as NodeJS.ErrnoException)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { kind: "error", terminal: true, error: `변경 파일 목록이 git 출력 상한(${DERIVE_GIT_LIMITS.maxBuffer}바이트)을 넘는 커밋이라 유도하지 않는다` };
    }
    return { kind: "error", error: `git show 실패(클론에 없는 커밋일 수 있다): ${describeGitError(e, rf.gitUrl)}` };
  }
}

export interface DeriveRunSummary {
  reconcile: ReconcileCounts;
  claimed: number;
  results: Partial<Record<FinishResult, number>>;
  /** 이번 실행에서 클론을 쓴 레포(fetch 를 건너뛴 경우 포함). error 는 fetch 실패, busy 는 잠금 대기 상한. */
  repos: { repo: string; error?: string; busy?: true }[];
}

/**
 * S1~S4 를 맞춘 뒤 선점 가능한 행을 레포별로 처리한다. 레포마다 fetch 는 실행당 한 번이고 커밋마다 git show 만 한다.
 *  SQL 오류는 던진다 — 삼켜 빈 결과로 돌려주면 크론이 ok 로 기록해 유도가 조용히 멈춘다.
 */
export async function deriveActivityTouches(opts: { activityId?: number; maxRows?: number; lockWaitMs?: number } = {}): Promise<DeriveRunSummary> {
  const reconcile = await reconcileDeriveRows(opts.activityId);
  const runStartedAt = String((await itemsPool.query(`SELECT now()::text AS t`)).rows[0].t);
  const fetched = new Map<number | null, RepoFetch>();
  const results: Partial<Record<FinishResult, number>> = {};
  let claimed = 0;
  const max = opts.maxRows ?? 20_000;
  while (claimed < max) {
    const batch = await claim(runStartedAt, Math.min(CLAIM_CHUNK, max - claimed), opts.activityId);
    if (!batch.length) break;
    claimed += batch.length;
    for (const cl of batch) {
      //  sha 꼴이 틀린 기록은 레포를 준비(fetch)하지 않는다 — 결과가 이미 정해져 있다.
      let outcome = invalidShaOutcome(cl.commit_sha);
      if (!outcome) {
        let rf = fetched.get(cl.repo_id);
        //  기록 직후 시도(activityId)는 그 커밋이 클론에 이미 있으면 fetch 하지 않는다.
        if (!rf) { rf = await prepareRepo(cl.repo_id, opts.lockWaitMs, opts.activityId != null ? cl.commit_sha : undefined); fetched.set(cl.repo_id, rf); }
        outcome = await attempt(rf, cl.commit_sha as string);
      }
      const r = await finishDerive(cl, outcome);
      results[r] = (results[r] ?? 0) + 1;
    }
  }
  const repos = [...fetched.values()].filter((r) => !r.noUnits && !r.noRepo)
    .map((r) => ({ repo: r.name, ...(r.error ? { error: r.error } : {}), ...(r.busy ? { busy: true as const } : {}) }));
  return { reconcile, claimed, results, repos };
}

/**
 * 크론 상태 — fetch 실패는 warn 까지만 올린다. error 는 워커 SQL 오류(던져서 엔진이 기록)뿐이다.
 *  평시엔 이번 실행에 선점된 행이 재시도 중인 failed 행뿐이라, 고장 난 레포 하나가 「시도한 레포 전부」 가 되기 쉽다.
 *  그걸 error 로 올리면 연속 실패 브레이커(scheduler/engine.ts)가 잡을 꺼 다른 레포의 유도·만료까지 멈춘다.
 *  refresh_all 도 같은 fetch 실패를 ok 로 기록한다(scheduler/actions/repo-refresh.ts).
 */
export function statusForDerive(repos: DeriveRunSummary["repos"]): "ok" | "warn" {
  return repos.some((r) => r.error) ? "warn" : "ok";
}

export interface DeriveStats {
  by_status: Partial<Record<DeriveStatus, number>>;
  /** (ok + empty) / (ok + empty + failed + expired). no_repo·no_units·pending·running 은 분모에서 뺀다. 분모가 0 이면 null. */
  completion_rate: number | null;
  /** 변경 파일은 있는데 code_unit 에 하나도 안 걸린 ok — 모듈 지도가 낡았다는 신호. touch 수로는 셀 수 없다(호출자가 유도 행을 derived=false 로 바꿀 수 있다). */
  ok_zero_match: number;
  pending: number;
  oldest_pending_days: number | null;
}

export async function deriveStats(): Promise<DeriveStats> {
  const rows = (await itemsPool.query(
    `SELECT status, count(*)::int AS n,
            count(*) FILTER (WHERE status='ok' AND changed_files > 0 AND unmatched_files = changed_files)::int AS zero_match,
            EXTRACT(EPOCH FROM (now() - min(enqueued_at) FILTER (WHERE status='pending'))) / 86400 AS oldest_days
       FROM activity_touch_derive GROUP BY status`)).rows as { status: DeriveStatus; n: number; zero_match: number; oldest_days: string | null }[];
  const by: Partial<Record<DeriveStatus, number>> = {};
  let zero = 0;
  let oldest: number | null = null;
  for (const r of rows) {
    by[r.status] = r.n;
    zero += r.zero_match;
    if (r.oldest_days != null) oldest = Math.round(Number(r.oldest_days) * 10) / 10;
  }
  const n = (s: DeriveStatus): number => by[s] ?? 0;
  const done = n("ok") + n("empty");
  const denom = done + n("failed") + n("expired");
  return {
    by_status: by,
    completion_rate: denom ? Math.round((done / denom) * 1000) / 1000 : null,
    ok_zero_match: zero,
    pending: n("pending"),
    oldest_pending_days: oldest,
  };
}

// 기록 직후 시도의 클론 잠금 대기 — 웹훅(2.5초)보다 짧게 둔다. push 직후 같은 클론을 기다리는 웹훅에 양보하고,
//  못 얻으면 pending 으로 남겨 일일 액션에 맡긴다.
export const AFTER_LOG_LOCK_WAIT_MS = 300;

/** 기록 직후 시도 — 스위치가 꺼져 있으면 아무것도 안 한다. 실패는 로그만 남긴다(일일 액션이 메운다). */
export async function deriveAfterLog(activityId: number): Promise<void> {
  try {
    const { getRuntimeConfig } = await import("../org/store/runtime-config.js");
    if (!(await getRuntimeConfig()).ontology_loops.l3_derive) return;
    await deriveActivityTouches({ activityId, lockWaitMs: AFTER_LOG_LOCK_WAIT_MS });
  } catch (e) {
    logger.warn({ err: (e as Error)?.message, activity: activityId }, "작업 기록 touch 유도(기록 직후) 실패 — 일일 액션이 다시 본다");
  }
}

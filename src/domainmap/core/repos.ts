// repo 테이블 헬퍼 — writer 전원(ingest/refresh/sync/propose)과 webhook 이 공유하는
// 유일한 횡단 SQL. 한 곳에 두지 않으면 4중 복제된다(store-core.mjs 의 repo helpers 이식).
import type pg from "pg";
import { dmPool, one, type Db } from "../db.js";
import {
  httpErr, syncBlockedRepos, type Actor, type RepoCreateResult, type RepoRenameResult, type RepoStateResult,
} from "./types.js";
import { logChange } from "./changelog.js";

const now = () => new Date().toISOString();
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

export async function getRepo(name: string): Promise<any> {
  const r = await one(dmPool(), "SELECT * FROM repo WHERE name=$1", [name]);
  if (!r) throw httpErr(404, "no such repo: " + name);
  return r;
}

// Webhook repo matcher: a push event carries candidate names (e.g. github
// repository.full_name 'org/app' and the short repository.name 'app'). Stored repo
// rows may use either form, so try each candidate in order and return the first
// matching row (or null — the webhook treats unknown repos as an ignorable no-op,
// never a 500). Parameterized; never trusts the candidate as SQL.
export async function findRepoByNames(names: unknown[] | null | undefined): Promise<any | null> {
  for (const n of names ?? []) {
    if (n == null || n === "") continue;
    const r = await one(dmPool(), "SELECT * FROM repo WHERE name=$1", [String(n)]);
    if (r) return r;
  }
  return null;
}

// ingest 경로 전용 upsert(트랜잭션 client 위에서 호출됨) — store-core.upsertRepo verbatim.
export async function upsertRepo(
  client: Db, name: string, root_path: string | null | undefined, stack: unknown,
): Promise<number> {
  const ex = await one(client, "SELECT * FROM repo WHERE name=$1", [name]);
  if (!ex) {
    const r = await one(client,
      "INSERT INTO repo(name,root_path,detected_stack,created_at,last_scan_at) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [name, root_path ?? null, JSON.stringify(stack ?? {}), now(), now()]);
    return r.id;
  }
  await client.query("UPDATE repo SET root_path=$1,detected_stack=$2,last_scan_at=$3 WHERE id=$4",
    [root_path ?? ex.root_path, JSON.stringify(stack ?? ex.detected_stack ?? {}), now(), ex.id]);
  return ex.id;
}

// refresh 체크포인트 — head sha 기록(refresh 트랜잭션 내에서 호출).
export async function setLastRefreshedSha(client: pg.PoolClient, repoId: number, sha: string): Promise<void> {
  await client.query("UPDATE repo SET last_refreshed_sha=$1 WHERE id=$2", [sha, repoId]);
}

// ── P-V3-4a: repo CRUD(통제어휘 상위 계층). repo 는 domainmap 자기완결 엔티티(cross-DB cascade 없음 —
//  knowledge_unit 은 domain_key 슬러그만 약결합으로 들고, repo 직접참조 없음). 따라서 repo 쓰기는 단일
//  DB 안에서 안전. 보호 리포(SYNC_BLOCKED_REPOS, 기본 빈 set) 가드: rename/deprecate 만 적용한다
//  (create 는 신규 이름이므로 보호대상일 수 없음 — 단, 보호 리포 이름으로 만들려는 시도는 막는다).

// repo 생성 — 이름 형식·중복 검증. detected_stack 빈 객체로 초기화(ingest 가 추후 채움).
export async function createRepo(name: string, actor: Actor): Promise<RepoCreateResult> {
  const nm = (name ?? "").trim();
  if (!REPO_NAME_RE.test(nm) || nm.length > 100) throw httpErr(400, `bad repo name: '${nm}' (A-Za-z0-9._- , 1~100 chars)`);
  if (syncBlockedRepos().has(nm)) throw httpErr(403, `repo '${nm}' is reserved/write-protected (see SYNC_BLOCKED_REPOS)`);
  const pool = dmPool();
  const ex = await one(pool, "SELECT id FROM repo WHERE name=$1", [nm]);
  if (ex) throw httpErr(409, `repo already exists: ${nm} (#${ex.id})`);
  const row = await one(pool,
    "INSERT INTO repo(name,root_path,detected_stack,state,created_at,last_scan_at) VALUES($1,$2,$3,'active',$4,$4) RETURNING id",
    [nm, null, JSON.stringify({}), now()]);
  const cid = await logChange(pool, {
    repoId: row.id, entityType: "repo", entityId: row.id, op: "insert", actor,
    before: null, after: { name: nm, state: "active" }, note: "create repo",
  });
  return { id: row.id, name: nm, change_id: cid };
}

// repo 이름변경 — repo 는 도메인맵 자기완결이라 물리 이름변경 안전(soft-alias 불요 — knowledge_unit 은
//  domain_repo 슬러그를 들지만 그건 도메인 스코프 표기이고 repo 행 PK 참조가 아니다). 단 보호 리포는
//  rename 거부(불가침 이름 보존). agent 가 도메인맵에 originate 한 데이터를 사람이 큐레이션한 repo 라는
//  origin 축이 repo 엔 없으므로(repo 는 origin 컬럼 없음), repo rename/deprecate 의 agent-vs-human 규칙은
//  capability 화이트리스트(권한 M-마)에서 결정한다 — 코어는 보호 리포 가드만.
export async function renameRepo(name: string, newName: string, actor: Actor): Promise<RepoRenameResult> {
  const oldNm = (name ?? "").trim();
  const newNm = (newName ?? "").trim();
  if (!REPO_NAME_RE.test(newNm) || newNm.length > 100) throw httpErr(400, `bad new repo name: '${newNm}' (A-Za-z0-9._- , 1~100 chars)`);
  if (syncBlockedRepos().has(oldNm)) throw httpErr(403, `repo '${oldNm}' is write-protected (rename blocked; see SYNC_BLOCKED_REPOS)`);
  if (syncBlockedRepos().has(newNm)) throw httpErr(403, `cannot rename into reserved repo name '${newNm}' (see SYNC_BLOCKED_REPOS)`);
  const pool = dmPool();
  const ex = await one(pool, "SELECT id FROM repo WHERE name=$1", [oldNm]);
  if (!ex) throw httpErr(404, "no such repo: " + oldNm);
  if (oldNm === newNm) throw httpErr(400, "new repo name is identical to current");
  const clash = await one(pool, "SELECT id FROM repo WHERE name=$1", [newNm]);
  if (clash) throw httpErr(409, `repo name already exists: ${newNm} (#${clash.id})`);
  await pool.query("UPDATE repo SET name=$1 WHERE id=$2", [newNm, ex.id]);
  const cid = await logChange(pool, {
    repoId: ex.id, entityType: "repo", entityId: ex.id, op: "rename", actor,
    before: { name: oldNm }, after: { name: newNm }, note: `rename repo '${oldNm}'→'${newNm}'`,
  });
  return { id: ex.id, old_name: oldNm, new_name: newNm, change_id: cid };
}

// repo deprecate/undeprecate — 삭제가 아니라 숨김 신호(도메인/매핑 보존). 보호 리포 가드.
//  no-op(이미 같은 state)은 change_id 키 부재가 계약(setDomainState 와 동일 패턴).
export async function setRepoState(name: string, state: string, actor: Actor): Promise<RepoStateResult> {
  if (state !== "active" && state !== "deprecated") throw httpErr(400, `bad state: ${state} (allowed: active|deprecated)`);
  const nm = (name ?? "").trim();
  if (syncBlockedRepos().has(nm)) throw httpErr(403, `repo '${nm}' is write-protected (lifecycle change blocked; see SYNC_BLOCKED_REPOS)`);
  const pool = dmPool();
  const ex = await one(pool, "SELECT id,state FROM repo WHERE name=$1", [nm]);
  if (!ex) throw httpErr(404, "no such repo: " + nm);
  if ((ex.state ?? "active") === state) return { id: ex.id, name: nm, action: "unchanged", state };
  await pool.query("UPDATE repo SET state=$1 WHERE id=$2", [state, ex.id]);
  const cid = await logChange(pool, {
    repoId: ex.id, entityType: "repo", entityId: ex.id, op: "update", actor,
    before: { state: ex.state ?? "active" }, after: { state },
    note: state === "deprecated" ? "deprecate repo" : "undeprecate repo",
  });
  return { id: ex.id, name: nm, change_id: cid, state };
}

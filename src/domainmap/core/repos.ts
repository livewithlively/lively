// repo 테이블 헬퍼 — writer 전원(ingest/refresh/sync/propose)과 webhook 이 공유하는
// 유일한 횡단 SQL. 한 곳에 두지 않으면 4중 복제된다(store-core.mjs 의 repo helpers 이식).
import type pg from "pg";
import { dmPool, one, type Db } from "../db.js";
import { httpErr } from "./types.js";

const now = () => new Date().toISOString();

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

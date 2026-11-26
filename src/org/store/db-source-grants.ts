// DB 소스 지정 (#5799 새 권한 체계의 «대상 지정») — 이 DB 소스를 조회할 수 있는 사람 · 팀.
//  권한(«DB» — 조회할 자격)과 대상(어느 소스인가)은 따로 간다: 역할을 받은 구성원은 **둘 다 있어야** 그 소스를 조회한다.
//  기본은 불가다(결정 2026-11-25) — 소스를 등록한 관리자도 여기 적히지 않으면 조회하지 못한다.
//  옛 구성원(역할 없음)은 이 표를 보지 않는다. 종전 그대로 db scope 가 전 소스를 연다(context.ts canAccessDbSource).
//
//  팀으로 지정하면 팀 구성원 변경이 곧 접근권한 변경이다 — 팀 편집은 관리자 전용이 된다(v6/team-store.ts anyTeamGrant 가 이 표도 센다).
import { itemsPool } from "../../db/client.js";
import { canAccessDbSource, type LivelyUser } from "../../context.js";
import { SELF_SOURCE } from "../../db/self-source.js";
import { allows } from "../../auth/permissions.js";

export interface DbSourceSubject { kind: "member" | "team"; id: string }
export interface DbSourceGrantRow { source: string; subject_kind: "member" | "team"; subject_id: string; granted_at: string | null; granted_by: string | null }

/** 대상 목록 정리(순수 — 시험 대상) — 빈 id · 모르는 종류는 버리고, 같은 대상은 한 번만. 순서는 들어온 순서. */
export function normalizeSubjects(subjects: readonly { kind?: unknown; id?: unknown }[] | null | undefined): DbSourceSubject[] {
  const seen = new Set<string>();
  const out: DbSourceSubject[] = [];
  for (const s of subjects ?? []) {
    const kind = s?.kind === "member" || s?.kind === "team" ? s.kind : null;
    const id = typeof s?.id === "string" || typeof s?.id === "number" ? String(s.id).trim() : "";
    if (!kind || !id) continue;
    const k = `${kind}\u0000${id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind, id });
  }
  return out;
}

/** 지정 목록 — source 를 주면 그 소스만. */
export async function listDbSourceGrants(source?: string): Promise<DbSourceGrantRow[]> {
  const r = source === undefined
    ? await itemsPool.query(`SELECT source, subject_kind, subject_id, granted_at, granted_by FROM org_db_source_grant ORDER BY source, subject_kind, subject_id`)
    : await itemsPool.query(`SELECT source, subject_kind, subject_id, granted_at, granted_by FROM org_db_source_grant WHERE source=$1 ORDER BY subject_kind, subject_id`, [source]);
  return r.rows as DbSourceGrantRow[];
}

/**
 * 한 소스의 지정을 통째로 바꾼다 — 빠진 대상은 지우고 새 대상은 더한다(남는 대상의 granted_at · granted_by 는 그대로).
 *  한 문장이라 중간 상태(전부 지워진 순간)가 밖에서 보이지 않는다.
 */
export async function setDbSourceGrants(source: string, subjects: readonly DbSourceSubject[], actor: string | null): Promise<DbSourceGrantRow[]> {
  const clean = normalizeSubjects(subjects);
  await itemsPool.query(
    `WITH want AS (SELECT * FROM unnest($2::text[], $3::text[]) AS u(k, i)),
          gone AS (DELETE FROM org_db_source_grant g WHERE g.source=$1
                     AND NOT EXISTS(SELECT 1 FROM want w WHERE w.k = g.subject_kind AND w.i = g.subject_id) RETURNING 1)
     INSERT INTO org_db_source_grant(source, subject_kind, subject_id, granted_at, granted_by)
       SELECT $1, w.k, w.i, now(), $4 FROM want w
        WHERE NOT EXISTS(SELECT 1 FROM org_db_source_grant g WHERE g.source=$1 AND g.subject_kind=w.k AND g.subject_id=w.i)
     ON CONFLICT DO NOTHING`,
    [source, clean.map((s) => s.kind), clean.map((s) => s.id), actor]);
  return listDbSourceGrants(source);
}

/**
 * 한 소스의 지정에 구성원을 **더한다**(있는 지정은 그대로 · 이미 있으면 아무 일도 없다). 옛 방식 구성원을 역할로 옮길 때 조회가 끊기지 않게 쓴다.
 *  통째 교체(setDbSourceGrants)를 읽고-고쳐-쓰기로 부르면 그 사이의 다른 저장을 지울 수 있어 따로 둔다.
 */
export async function addDbSourceMembers(source: string, memberIds: readonly string[], actor: string | null): Promise<number> {
  const ids = [...new Set(memberIds.map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (!source || !ids.length) return 0;
  const r = await itemsPool.query(
    `INSERT INTO org_db_source_grant(source, subject_kind, subject_id, granted_at, granted_by)
       SELECT $1, 'member', i, now(), $3 FROM unnest($2::text[]) AS u(i)
        WHERE NOT EXISTS(SELECT 1 FROM org_db_source_grant g WHERE g.source=$1 AND g.subject_kind='member' AND g.subject_id=u.i)
     ON CONFLICT DO NOTHING`, [source, ids, actor]);
  return r.rowCount ?? 0;
}

/** 소스를 지울 때 그 소스의 지정도 지운다(이름을 다시 쓴 새 소스가 옛 지정을 물려받지 않게). */
export async function clearDbSourceGrants(source: string): Promise<void> {
  await itemsPool.query(`DELETE FROM org_db_source_grant WHERE source=$1`, [source]);
}

/** 이 구성원이 그 소스에 지정됐나 — 본인 지정이거나, 지정된 팀(보관되지 않은)의 구성원이다. */
export async function memberHasDbSource(memberId: string, source: string): Promise<boolean> {
  if (!memberId || !source) return false;
  const r = await itemsPool.query(
    `SELECT 1 FROM org_db_source_grant g
      WHERE g.source=$2
        AND ((g.subject_kind='member' AND g.subject_id=$1)
          OR (g.subject_kind='team' AND EXISTS(
                SELECT 1 FROM team_member tm JOIN team t ON t.id=tm.team_id
                 WHERE tm.member_id=$1 AND tm.team_id::text=g.subject_id AND t.state<>'archived')))
      LIMIT 1`, [memberId, source]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 이 주체가 그 DB 소스를 조회할 수 있나 — db_sources · db_schema · db_query 가 쓰는 한 판정.
 *  · 옛 구성원(새 권한이 실리지 않은 주체) → 종전 그대로(db scope = 전 소스 · db:<소스> · 내장 self 는 admin).
 *  · 역할을 받은 구성원 → 내장 self 는 종전처럼 관리자에게만. 그 밖의 소스는 «DB» 조회 자격 **그리고** 이 표의 지정.
 *    자격은 주체의 것이다(토큰 · 앱 동의로 좁아졌으면 없다). 지정은 그 사람의 것이다(주체가 누구 이름으로 도는가).
 *  조회가 실패하면 던진다 — 부르는 쪽에서 거절이 된다(닫힌 쪽).
 */
export async function dbSourceAllowed(user: LivelyUser, source: string): Promise<boolean> {
  if (!user.grants || source === SELF_SOURCE) return canAccessDbSource(user, source);
  //  소스 한정 토큰(db:<source>)은 역할을 받은 구성원에게도 그 소스만 연다(org/store/tokens.dbSourceCeilingOf 머리말).
  if (user.dbSourceCeiling && !user.dbSourceCeiling.includes(source)) return false;
  if (!allows(user.grants, { perm: "db", level: "read" })) return false;
  return memberHasDbSource(user.userId, source);
}

/** 거절이면 던진다 — 문구는 종전 requireDbSource 와 같다. */
export async function requireDbSourceAccess(user: LivelyUser, source: string): Promise<void> {
  if (!(await dbSourceAllowed(user, source))) {
    throw new Error(`Forbidden: user '${user.userId}' lacks db access to source '${source}'`);
  }
}

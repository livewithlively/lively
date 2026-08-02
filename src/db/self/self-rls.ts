// #1291 v3 — self 소스의 **행 단위** 공개범위(RLS). v2 의 "잠긴 맥락이 하나라도 있으면 self 를 통째로 닫는다"를 대체한다.
//
//  왜 바꾸나: 고객사 A에서 리스트 하나(#24)를 4명에게 잠근 순간 조직 전체(admin 포함)의 self 조회가 막혔다.
//   66명 중 61명이 db 스코프 보유 — 리스트 하나 잠근 대가로 전원이 SQL 직접 조회를 잃는 건 너무 거칠다.
//   제대로 된 답은 "잠긴 행만 빼고 나머지는 그대로"다.
//
//  ── 구조 (전부 실 Postgres 18.4 에서 실측하고 정한 것) ──
//  1) **롤 분리**: `lively_reader`(NOLOGIN, 콘텐츠 테이블 SELECT 만). 읽기전용 트랜잭션 안에서 `SET LOCAL ROLE`
//     로 내려간다. 소유자(게이트웨이 평상시 쿼리)는 정책을 **안 탄다** → 정상 동작 위험 0.
//     ⚠ `FORCE ROW LEVEL SECURITY` 를 쓰지 않는 이유가 이것이다. 그걸 켜면 게이트웨이 자기 쿼리까지 전부
//      정책을 타서, 정책 하나만 틀려도 제품이 통째로 멈춘다. 여기서 지키려는 건 admin 의 SQL 창 하나지
//      제품 전체가 아니다.
//  2) **가시 판정은 여기서 다시 짜지 않는다**: 재귀 조상 체인·grant 해소는 전부 `v6/visibility.ts`(술어 SoT)가
//     한다. 이 파일은 그 **결과(숨길 것들의 id 집합)** 를 스코프 테이블에 심고, 정책은 세미조인만 한다.
//     이 프로젝트는 술어를 손으로 옮겨 적어 세 번 사고를 냈다(v1 지식 1홉 · v2 ClickUp 반출 1홉 · OS 슬러그
//     3중 구현). RLS 정책은 SQL 이라 그 사본이 되기 가장 쉬운 자리라, 아예 판정을 안 하게 만들었다.
//  3) **전달 매체는 `pg_backend_pid()` 키 영구 테이블**이지 GUC 가 아니다.
//     GUC(`current_setting`)로 하면 **리더 롤이 `set_config` 로 자기 가시 집합을 덮어써 잠긴 행을 전부 볼 수
//     있다**(실측). 그러면 행 보안 전체가 SQL 방화벽 하나에 걸린다. PG18 의 `REVOKE SET ON PARAMETER` 로
//     막아 보려 했으나 **커스텀 placeholder GUC 엔 안 걸린다**(실측). 반면 이 테이블은 리더에게 SELECT 만 줘서
//     grant 차원 + 읽기전용 트랜잭션 차원 두 겹으로 확장이 막힌다(방화벽까지 방어선 3개).
//     (`pg_temp` 임시테이블도 검토했으나 **정책 생성 자체가 불가**하다 — 마이그레이션 시점엔 그 테이블이 없다.)
//  4) **fail-closed**: 정책은 `ready` 센티넬 행을 요구한다. 스코프를 안 심었거나 심다 실패하면 아무것도 안 보인다.
//     (RLS 를 켜고 정책이 0개여도 전부 차단된다 — 실측 확인.)
import type pg from "pg";
import { itemsPool } from "../client.js";
import { logger } from "../../log.js";
import { ITEMS_CONTENT_TABLES } from "./self-source.js";
import { visibleListIds, visibleFolderIds, listIdPredicate, type Viewer } from "../../v6/visibility.js";

export const SELF_RLS_ROLE = "lively_reader";
export const SCOPE_TABLE = "lively_vis_scope";

/** 한 번에 심을 수 있는 '숨길 행' 상한. 넘으면 self 를 닫는다(잠금이 광범위하면 v2 처럼 거절하는 게 정직하다). */
const MAX_SCOPE_ROWS = 20_000;

/** 정책을 걸 테이블 → 그 테이블에서 '숨김 판정'에 쓸 컬럼과 종류.
 *  ⚠ 여기 없는 콘텐츠 테이블은 **정책 없이** 리더에게 열린다(공개범위와 무관한 축 — 분류체계·도메인맵 등).
 *   가시성이 붙은 축만 적는다. 새 축이 생기면 여기에 한 줄 추가하는 게 전부여야 한다. */
const POLICIES: ReadonlyArray<{ table: string; col: string; kind: ScopeKind; nullable?: boolean }> = [
  // 프로젝트 계층 — project 는 프로젝트와 태스크를 함께 담는다(level·parent_id). 그래서 숨김 집합에
  //  **후손 행까지** 넣어 두고(아래 hiddenProjectRowIds) 여기선 평평한 id 비교만 한다.
  { table: "project", col: "id", kind: "proj" },
  { table: "project_list", col: "id", kind: "list" },
  { table: "project_folder", col: "id", kind: "fold" },
  // 프로젝트/태스크에 매달린 것들 — 부모가 안 보이면 이것들도 안 보여야 한다.
  //  (v1 e2e 가 잡은 누수가 정확히 이 계열이었다: 프로젝트는 404 인데 태스크 상세는 그대로 나갔다.)
  { table: "project_category", col: "project_id", kind: "proj" },
  { table: "project_knowledge", col: "project_id", kind: "proj" },
  { table: "project_member", col: "project_id", kind: "proj" },
  { table: "project_repo", col: "project_id", kind: "proj" },
  { table: "session_project", col: "project_id", kind: "proj" },
  { table: "task_assignee", col: "task_id", kind: "proj" },
  { table: "task_attachment", col: "task_id", kind: "proj" },
  { table: "task_checklist", col: "task_id", kind: "proj" },
  { table: "task_comment", col: "task_id", kind: "proj" },
  { table: "task_field_value", col: "task_id", kind: "proj" },
  { table: "task_tag_link", col: "task_id", kind: "proj" },
  { table: "task_time_entry", col: "task_id", kind: "proj" },
  // 지식·자료 — 자체 공개범위 축(이름/ id 로 숨김).
  { table: "knowledge", col: "name", kind: "know" },
  { table: "source", col: "id", kind: "src" },
  // 활동기록 — 프로젝트에 붙은 것만 그 프로젝트를 따른다(project_id NULL 이면 조직 공용).
  { table: "activity", col: "project_id", kind: "proj", nullable: true },
];

type ScopeKind = "proj" | "list" | "fold" | "know" | "src";

/**
 * 스키마 준비 — 롤·스코프 테이블·grant·정책. 멱등이고 **실패해도 부팅을 막지 않는다**
 * (권한이 모자란 배포에서 게이트웨이가 안 뜨면 그게 더 큰 사고다. 대신 self 는 안전한 쪽으로 닫힌다).
 * @returns RLS 를 실제로 쓸 수 있는가
 */
let rlsReady = false;
/** 부팅 때 정책 준비에 성공했나 — 실패한 배포에선 행 단위 필터를 못 쓰므로 v2 의 전면 차단으로 폴백한다. */
export function selfRlsReady(): boolean { return rlsReady; }

export async function ensureSelfRls(): Promise<boolean> {
  try {
    await itemsPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SELF_RLS_ROLE}') THEN
          CREATE ROLE ${SELF_RLS_ROLE} NOLOGIN;
        END IF;
      END $$;`);
    await itemsPool.query(`
      CREATE TABLE IF NOT EXISTS ${SCOPE_TABLE}(
        pid  int  NOT NULL,
        kind text NOT NULL,
        key  text NOT NULL,
        PRIMARY KEY (pid, kind, key)
      )`);
    // ⚠ CREATE TABLE IF NOT EXISTS 는 **모양이 다른 기존 테이블을 고치지 않는다** — 조용히 넘어가고
    //  그 뒤 정책 생성이 전부 "column does not exist" 로 죽는다(실제로 그렇게 당했다). 컬럼을 따로 메운다.
    await itemsPool.query(`ALTER TABLE ${SCOPE_TABLE} ADD COLUMN IF NOT EXISTS kind text`);
    await itemsPool.query(`ALTER TABLE ${SCOPE_TABLE} ADD COLUMN IF NOT EXISTS key text`);
    // 리더는 **읽기만** — 자기 스코프를 넓힐 수 없다. 이게 GUC 대신 테이블을 고른 이유다.
    await itemsPool.query(`GRANT SELECT ON ${SCOPE_TABLE} TO ${SELF_RLS_ROLE}`);

    // 콘텐츠 테이블 SELECT grant — allow-list 와 **같은 상수**에서 파생한다.
    //  어긋나면 사용자에겐 "권한 없음" 에러로 보이고 가시성 문제로 오진된다.
    for (const t of ITEMS_CONTENT_TABLES) {
      await itemsPool.query(`GRANT SELECT ON ${quoteIdent(t)} TO ${SELF_RLS_ROLE}`)
        .catch(() => { /* 그 테이블이 아직 없는 배포 — 정책도 아래서 건너뛴다 */ });
    }

    for (const p of POLICIES) {
      const nullOk = p.nullable ? `${quoteIdent(p.col)} IS NULL OR ` : "";
      // 정책 = ①스코프가 심겼는가(ready) ②이 행이 숨김 목록에 없는가. 그뿐이다 — 상속·grant 판정은 여기 없다.
      const using = `(
        EXISTS (SELECT 1 FROM ${SCOPE_TABLE} s WHERE s.pid = pg_backend_pid() AND s.kind = 'ready')
        AND (${nullOk}NOT EXISTS (
          SELECT 1 FROM ${SCOPE_TABLE} s2
           WHERE s2.pid = pg_backend_pid() AND s2.kind = '${p.kind}'
             AND s2.key = ${quoteIdent(p.col)}::text))
      )`;
      await itemsPool.query(`ALTER TABLE ${quoteIdent(p.table)} ENABLE ROW LEVEL SECURITY`)
        .catch(() => { /* 테이블 없음 */ });
      await itemsPool.query(`DROP POLICY IF EXISTS lively_vis ON ${quoteIdent(p.table)}`).catch(() => {});
      await itemsPool.query(
        `CREATE POLICY lively_vis ON ${quoteIdent(p.table)} FOR SELECT TO ${SELF_RLS_ROLE} USING ${using}`)
        .catch((e) => logger.warn({ table: p.table, err: (e as Error)?.message }, "[self-rls] 정책 생성 실패"));
    }
    // ⚠ **정책이 실제로 걸렸는지 확인하고서야 ready 다.** 개별 CREATE POLICY 를 catch 로 넘기면서
    //  ready=true 를 반환하면, v2 의 전면 차단은 풀리는데 필터는 없는 **완전 우회**가 된다(fail-open).
    //  실제로 스코프 테이블 모양이 어긋나 18개가 전부 실패했는데도 ready 였다. 세는 것으로 못박는다.
    const { rows } = await itemsPool.query(
      `SELECT count(*)::int AS n FROM pg_policy WHERE polname = 'lively_vis'`);
    const got = Number(rows[0]?.n ?? 0);
    if (got < POLICIES.length) {
      rlsReady = false;
      logger.error({ want: POLICIES.length, got },
        "[self-rls] 정책이 다 걸리지 않았다 — 행 단위 필터를 쓰지 않는다(v2 전면 차단으로 폴백)");
      return false;
    }
    rlsReady = true;
    logger.info({ tables: got }, "[self-rls] 행 단위 공개범위 준비됨");
    return true;
  } catch (e) {
    logger.warn({ err: (e as Error)?.message },
      "[self-rls] 준비 실패 — self 소스는 잠긴 맥락이 있으면 닫힌 채로 둔다(v2 동작으로 폴백)");
    rlsReady = false;
    return false;
  }
}

// 식별자는 상수 목록에서만 오지만, 문자열로 SQL 을 만드는 자리라 형식 검증을 남겨 둔다.
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`잘못된 식별자: ${name}`);
  return `"${name}"`;
}

/** 이 뷰어에게 숨길 것들 — 전부 술어 SoT 로 계산한다. 이 파일은 '무엇이 숨겨지나'를 스스로 판단하지 않는다. */
async function hiddenSets(viewer: Viewer): Promise<Array<{ kind: ScopeKind; key: string }>> {
  const out: Array<{ kind: ScopeKind; key: string }> = [];
  const visLists = await visibleListIds(viewer);
  if (visLists === null) return out;   // 특권 — 숨길 것 없음

  // 안 보이는 리스트·스페이스. ⚠ 술어는 컬럼마다 새로 만든다 — 생성된 SQL 을 정규식으로 고쳐 쓰면
  //  그 순간 사본이 생긴다(v2 에서 리비전 큐가 그렇게 깨질 뻔했다).
  for (const r of await itemsPool.query(
    `SELECT id FROM project_list WHERE NOT (${listIdPredicate("id", visLists)})`).then((x) => x.rows)) {
    out.push({ kind: "list", key: String(r.id) });
  }
  const visFolders = await visibleFolderIds(viewer);
  if (visFolders !== null) {
    for (const r of await itemsPool.query(
      `SELECT id FROM project_folder WHERE NOT (${listIdPredicate("id", visFolders)})`).then((x) => x.rows)) {
      out.push({ kind: "fold", key: String(r.id) });
    }
  }

  // 안 보이는 프로젝트 **+ 그 후손 행 전부**(project 테이블은 태스크·하위태스크를 같이 담는다).
  //  후손을 안 넣으면 task 행의 list_id 가 NULL 이라 그대로 열린다 — v1 에서 실제로 그랬던 결함이다.
  const projRows = await itemsPool.query(`
    WITH RECURSIVE hidden AS (
      SELECT id FROM project WHERE level='project' AND list_id IS NOT NULL
         AND NOT (${listIdPredicate("list_id", visLists)})
      UNION ALL
      SELECT c.id FROM project c JOIN hidden h ON c.parent_id = h.id
    )
    SELECT id FROM hidden`).then((x) => x.rows);
  for (const r of projRows) out.push({ kind: "proj", key: String(r.id) });

  // 지식·자료 — 잠긴 것만(대부분의 조직에서 0건이다).
  const { knowledgeVisWhere } = await import("../../v6/knowledge-store.js");
  const kParams: unknown[] = [];
  const kVis = await knowledgeVisWhere(viewer, kParams);
  if (kVis !== "TRUE") {
    for (const r of await itemsPool.query(
      `SELECT name FROM knowledge k WHERE NOT ${kVis}`, kParams).then((x) => x.rows)) {
      out.push({ kind: "know", key: String(r.name) });
    }
  }
  const { sourceVisWhere } = await import("../../v6/source-store.js");
  const sParams: unknown[] = [];
  const sVis = await sourceVisWhere(viewer, sParams);
  if (sVis !== "TRUE") {
    for (const r of await itemsPool.query(
      `SELECT id FROM source s WHERE NOT ${sVis}`, sParams).then((x) => x.rows)) {
      out.push({ kind: "src", key: String(r.id) });
    }
  }
  return out;
}

/**
 * 이 커넥션에 뷰어의 스코프를 심는다. **트랜잭션 밖에서** 불러야 한다(읽기전용 안에선 INSERT 가 막힌다).
 * @throws 상한을 넘거나 심기에 실패하면 — 호출부는 self 조회를 거절해야 한다(열어 두면 그게 유출이다).
 */
export async function plantScope(client: Pick<pg.PoolClient, "query">, viewer: Viewer): Promise<void> {
  await client.query(`DELETE FROM ${SCOPE_TABLE} WHERE pid = pg_backend_pid()`);
  const rows = await hiddenSets(viewer);
  if (rows.length > MAX_SCOPE_ROWS) {
    throw new Error(
      `공개범위가 지정된 항목이 너무 많아(${rows.length}건) self 소스를 이 방식으로 필터할 수 없습니다 — ` +
      "필요하면 긴급 열람(vis_break_glass_start)을 사유와 함께 여세요.");
  }
  if (rows.length) {
    // 한 방에 심는다 — 행마다 왕복하면 잠금이 늘수록 느려진다.
    await client.query(
      `INSERT INTO ${SCOPE_TABLE}(pid, kind, key)
       SELECT pg_backend_pid(), k, v FROM unnest($1::text[], $2::text[]) AS t(k, v)`,
      [rows.map((r) => r.kind), rows.map((r) => r.key)]);
  }
  // ready 센티넬은 **맨 마지막**에 — 중간에 실패하면 센티넬이 없어 정책이 전부 차단한다(fail-closed).
  await client.query(`INSERT INTO ${SCOPE_TABLE}(pid, kind, key) VALUES (pg_backend_pid(), 'ready', '1')`);
}

/** 커넥션을 풀에 돌려주기 전에 스코프를 지운다. 실패해도 다음 사용의 plantScope 가 DELETE 로 덮는다. */
export async function clearScope(client: Pick<pg.PoolClient, "query">): Promise<void> {
  await client.query(`DELETE FROM ${SCOPE_TABLE} WHERE pid = pg_backend_pid()`)
    .catch(() => { /* 다음 plantScope 가 정리한다 */ });
}

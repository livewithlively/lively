// 노션 후처리(#551/#586) — run-sync 가 적재 뒤 호출하는 set 기반 수렴 연산 + 델타 증분 원장 로더.
//  #1313 R20 으로 connector-mirror.ts 에서 verbatim 이관(connector-mirror.js 배럴이 그대로 재수출).
import type pg from "pg";

// ════════ #551 노션 무손실 싱크 — run-sync 후처리(set 기반, 멱등) ════════
//  적재(ingestItems) 뒤에 run-sync 가 호출한다. 전부 SQL set 연산이라 재실행·부분실행 안전(수렴형).
type PgRunner = pg.Pool | pg.PoolClient;

/** fields.notion.links → knowledge_link 물질화. 커넥터 origin 링크만 재작성(사람 링크 불가침).
 *  타깃이 아직 미적재면 그 엣지는 이번엔 생략 — 매 싱크 전체 재계산이라 다음 run 에 자동 수렴. */
export async function materializeNotionLinks(db: pg.Pool): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM knowledge_link WHERE origin='connector:notion'`);
    const r = await client.query(
    `INSERT INTO knowledge_link(from_name, to_name, relation, origin, created_at, updated_at)
     SELECT DISTINCT k.name, t.name, 'related', 'connector:notion', now(), now()
     FROM knowledge k
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.fields->'notion'->'links', '[]'::jsonb)) AS l(link)
     JOIN knowledge t
       ON t.external_system='notion'
      AND t.external_instance = k.external_instance
      AND t.external_id = l.link->>'target_external_id'
      AND t.name <> k.name
     WHERE k.external_system='notion'
     ON CONFLICT (from_name, to_name, relation) DO NOTHING`, // 같은 쌍의 사람(user) 링크가 이미 있으면 그대로 존중
    );
    await client.query("COMMIT");
    return r.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** 부모의 fields.notion.children_order → 자식 knowledge.sort 수렴.
 *  증분에서 부모만 변경돼도(자식 재정렬) 자식 행 재적재 없이 순서가 맞는다. updated_at 은 건드리지 않는다(노이즈 방지). */
export async function applyNotionChildrenOrder(db: PgRunner): Promise<number> {
  const r = await db.query(
    `UPDATE knowledge c SET sort = ord.idx
     FROM (
       SELECT p.name AS pname, p.external_instance AS inst, elem.value AS child_ext, (elem.ordinality - 1)::int AS idx
       FROM knowledge p,
            jsonb_array_elements_text(COALESCE(p.fields->'notion'->'children_order', '[]'::jsonb))
              WITH ORDINALITY AS elem(value, ordinality)
       WHERE p.external_system='notion' AND p.lifecycle='active'
     ) ord
     WHERE c.external_system='notion'
       AND c.external_instance = ord.inst
       AND c.external_id = ord.child_ext
       AND c.parent_name = ord.pname   -- 현재 부모의 순서만 — 이동 전 부모(스테일/아카이브)의 children_order 이중 매치 차단
       AND c.sort IS DISTINCT FROM ord.idx`,
  );
  return r.rowCount ?? 0;
}

/** full 싱크 스윕 — 이번 run(runStartIso 이후)에 관측되지 않은 notion 미러를 archived 로(원본 삭제/공유해제 전파).
 *  ⚠ 호출 조건: full 모드 + 커넥터 실패 0(부분 실패 run 에서 스윕하면 살아있는 페이지가 오탐 아카이브됨). */
export async function sweepNotionArchived(db: PgRunner, runStartIso: string): Promise<number> {
  const r = await db.query(
    `UPDATE knowledge SET lifecycle='archived', updated_at=now(), updated_by='connector:notion'
     WHERE external_system='notion' AND lifecycle='active'
       AND (last_synced_at IS NULL OR last_synced_at < $1::timestamptz)`,
    [runStartIso],
  );
  return r.rowCount ?? 0;
}

// ── notion 원장 스냅샷(#586 델타 증분) — 커넥터가 '이미 아는 것'과 대조해 변경분만 수집하게 한다. ──
//  원장 = knowledge.raw 의 last_edited_time 이 진실(노션 분 단위 절사 그대로 저장됨 — search 결과와 문자열 동등 비교 가능).
export interface NotionLedgerEntry {
  lastEdited: string | null;   // page/database 의 last_edited_time(ISO, 분 절사)
  /** 이 행을 마지막으로 적재한 시각 — 분 절사 동률 판정(같은 분 재편집 가시성)에 필요 */
  syncedAt: string | null;
  parentExt: string | null;    // 트리 부모 external id
  kind: string;                // page | db_row | database
  title: string;
  lifecycle: string;           // active | archived
  /** database 전용 — 저장된 data_sources 의 last_edited_time 최대값(스키마 변경 감지용) */
  dsEdited: string | null;
  /** database 전용 — linked 뷰 등 행 조회 미지원(가속 full 에서 무의미한 query 400 왕복 생략) */
  unsupported: boolean;
  /** body 가 참조하는 다운로드 자산 파일명들 — 가속 full 의 스킵 판정 시 디스크 존재 검사(자산 자가치유) */
  assets?: string[];
}
export interface NotionLedger {
  byId: Map<string, NotionLedgerEntry>;
  /** data_source id → 소유 database id (저장된 fields.notion.data_source_ids 역매핑) */
  dsToDb: Map<string, string>;
  /** 역링크: target ext id → 그걸 본문에서 참조하는 페이지들의 ext id — 개명 시 멘션 제목 캐시 재렌더용 */
  backlinks: Map<string, string[]>;
}

export async function loadNotionLedger(db: PgRunner): Promise<NotionLedger> {
  const r = await db.query(
    `SELECT external_id, title, lifecycle, parent_external_id, last_synced_at,
            fields->'notion'->>'kind' AS kind,
            fields->'notion'->>'unsupported' AS unsupported,
            COALESCE(raw->'page'->>'last_edited_time', raw->'database'->>'last_edited_time') AS last_edited,
            (SELECT max(ds->>'last_edited_time') FROM jsonb_array_elements(COALESCE(raw->'data_sources','[]'::jsonb)) AS ds) AS ds_edited,
            fields->'notion'->'data_source_ids' AS ds_ids
     FROM knowledge WHERE external_system='notion' AND external_id IS NOT NULL`);
  const byId = new Map<string, NotionLedgerEntry>();
  const dsToDb = new Map<string, string>();
  for (const row of r.rows as Array<Record<string, unknown>>) {
    const id = String(row.external_id);
    byId.set(id, {
      lastEdited: row.last_edited == null ? null : String(row.last_edited),
      syncedAt: row.last_synced_at == null ? null : new Date(row.last_synced_at as string | Date).toISOString(),
      parentExt: row.parent_external_id == null ? null : String(row.parent_external_id),
      kind: String(row.kind ?? "page"),
      title: String(row.title ?? ""),
      lifecycle: String(row.lifecycle ?? "active"),
      dsEdited: row.ds_edited == null ? null : String(row.ds_edited),
      unsupported: row.unsupported === "true",
    });
    if (Array.isArray(row.ds_ids)) {
      for (const ds of row.ds_ids as unknown[]) if (typeof ds === "string" && ds) dsToDb.set(ds, id);
    }
  }
  // body 가 참조하는 자산 파일명 — 가속 full 스킵 시 디스크 존재 검사용(없으면 그 페이지만 재수집해 자가치유).
  const ar = await db.query(
    `SELECT external_id, array_agg(DISTINCT m.f) AS files
     FROM knowledge, LATERAL (
       SELECT (regexp_matches(body_md, '/api/ui/notion-assets/([A-Za-z0-9._-]+)', 'g'))[1] AS f
     ) m
     WHERE external_system='notion' AND external_id IS NOT NULL AND body_md LIKE '%/api/ui/notion-assets/%'
     GROUP BY external_id`);
  for (const row of ar.rows as Array<{ external_id: string; files: string[] }>) {
    const led = byId.get(String(row.external_id));
    if (led && Array.isArray(row.files)) led.assets = row.files.map(String);
  }
  // 역링크 — 커넥터가 물질화한 링크만(본문에 실제 등장하는 참조 = 개명 시 재렌더 대상).
  const backlinks = new Map<string, string[]>();
  const bl = await db.query(
    `SELECT tk.external_id AS target_ext, fk.external_id AS from_ext
     FROM knowledge_link l
     JOIN knowledge fk ON fk.name = l.from_name AND fk.external_system='notion' AND fk.external_id IS NOT NULL
     JOIN knowledge tk ON tk.name = l.to_name AND tk.external_system='notion' AND tk.external_id IS NOT NULL
     WHERE l.origin = 'connector:notion'`);
  for (const row of bl.rows as Array<{ target_ext: string; from_ext: string }>) {
    const arr = backlinks.get(row.target_ext);
    if (arr) arr.push(row.from_ext); else backlinks.set(row.target_ext, [row.from_ext]);
  }
  return { byId, dsToDb, backlinks };
}

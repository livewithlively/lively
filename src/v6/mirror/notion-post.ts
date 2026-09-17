// 노션 후처리(#551/#586) — run-sync 가 적재 뒤 호출하는 set 기반 수렴 연산 + 델타 증분 원장 로더.
//  #1313 R20 으로 connector-mirror.ts 에서 verbatim 이관(connector-mirror.js 배럴이 그대로 재수출).
import type pg from "pg";
import { auditLifecycleSweep, claimSyncStateSql } from "./mirror-common.js";

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
     ON CONFLICT (tenant_id, from_name, to_name, relation) DO NOTHING`, // 같은 쌍의 사람(user) 링크가 이미 있으면 그대로 존중
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

// ════════ #4059 수집기 표식 — 한 워크스페이스를 수집기 여럿이 나눠 맡을 때의 전체 점검 스윕 ════════
//  사고(soltimal, 2026-09-17 02:59 KST): 오피서별 노션 수집기 4개가 **같은 워크스페이스 축**(external_instance)을
//   썼다. 8페이지만 맡은 수집기의 전체 점검이 «이번에 못 본 것 = 원본에서 사라진 것» 을 **축 전체**에 적용해
//   5,401건 중 5,385건을 아카이브했다(`pages: 8, emitted: 4 … archived: 5385`). #1881 N7 은 워크스페이스가
//   **여럿**인 경우만 갈랐고, 한 워크스페이스를 **나눠 맡는** 경우는 같은 축이라 그대로 남아 있었다.
//
//  그래서 «누가 이 행을 맡았나» 를 행에 남긴다(knowledge.sync_state — mirror-common.claimSyncStateSql):
//   · seen_by.<수집기>  — 그 수집기가 이 행을 마지막으로 본 시각. 적재(미러)·가속 full 관측이 박는다.
//   · unclaimed_since   — 마지막 표식이 떨어진 시각(아무도 안 맡게 된 때).
//  스윕은 두 단계다.
//   ① 떼기(releaseNotionClaims) — **내 표식만** 뗀다: 이번 전체 점검(시작 S) 전에 박힌 내 표식 = 이번에 못 본 행.
//   ② 보관(archive) — **아무 표식도 없는 행만**. 그리고 «아무도 안 맡는다» 가 증명될 때만:
//      같은 축의 다른 수집기 X 마다 «X 의 마지막 깨끗한 전체 점검이 그 행이 비게 된 뒤에 시작됐다» 가 성립해야 한다.
//      X 가 그 행을 맡았다면 그 점검에서 봤을 것이고 표식이 남았을 것이다 — 표식이 없으니 X 도 안 맡는다.
//      그 시각의 최솟값이 cutoff 다(notion/sweep-peers.ts 가 구한다). 준비 안 된 X 가 하나라도 있으면 보관하지 않는다.
//   예외: 같은 축에 다른 수집기가 **없으면**(가장 흔한 단일 수집기) 이번 run 에 내가 뗀 행도 곧바로 보관한다 —
//   종전과 같은 지연(하루)을 지킨다. 표식이 아예 없던 행(이 수정 전 적재분)은 created_at 을 «비게 된 때» 로 본다.
//  ⚠ 표식은 **그 수집기만** 뗀다. 수집기를 끄거나 지우면 그 표식은 아무도 안 떼므로 그 행은 스윕으로 보관되지 않는다
//   (모르면 지우지 않는다 — 단일 수집기를 지웠을 때 아무것도 안 내려가던 종전 동작과 같은 쪽). 지운 수집기의
//   자료를 내리려면 사람이 보관한다. 같은 instance_key 로 다시 만든 수집기는 표식을 이어받아 스스로 정리한다.
//  시각 비교는 전부 마이크로초다 — run 시작 시각을 JS Date 로 만들면 밀리초로 잘려 같은 밀리초 안의 앞뒤가 뒤집힌다.

/** 스윕 계획 — notion/sweep-peers.ts planNotionSweep 이 만든다. archive=false 면 떼기만 하고 보관은 보류한다. */
export type NotionSweepPlan =
  | { archive: false; reason: "self_changed" | "peers_not_ready" | "peers_unknown"; notReady?: string[] }
  | { archive: true; sole: boolean; cutoffIso: string };

export interface NotionSweepResult {
  /** 이번에 뗀 내 표식 수(이번 전체 점검에서 못 본 행) */
  released: number;
  /** 그중 마지막 표식이었던 행 수(이제 아무도 안 맡는다) */
  orphaned: number;
  archived: number;
  /** 보관을 보류한 이유(보류 안 했으면 null) */
  held: string | null;
}

/** ① 떼기 — 이 수집기의 표식 중 이번 run 시작 전에 박힌 것(= 이번 전체 점검에서 못 본 행)을 뗀다. */
export async function releaseNotionClaims(
  db: PgRunner, input: { runStartIso: string; instance: string; claimKey: string },
): Promise<{ released: number; orphanedNames: string[] }> {
  if (!input.instance) throw new Error("releaseNotionClaims: instance 가 비었습니다");
  if (!input.claimKey) throw new Error("releaseNotionClaims: claimKey 가 비었습니다");
  const r = await db.query(
    `UPDATE knowledge
        SET sync_state = CASE
              WHEN (sync_state->'seen_by') - $3::text = '{}'::jsonb
                THEN (sync_state - 'seen_by') || jsonb_build_object('unclaimed_since', now())
              ELSE jsonb_set(sync_state, '{seen_by}', (sync_state->'seen_by') - $3::text)
            END
      WHERE external_system='notion' AND external_instance=$2
        AND (sync_state->'seen_by'->>$3::text) IS NOT NULL
        AND (sync_state->'seen_by'->>$3::text)::timestamptz < $1::timestamptz
      RETURNING name, (sync_state->'seen_by') IS NULL AS orphaned`,
    [input.runStartIso, input.instance, input.claimKey],
  );
  const rows = r.rows as Array<{ name: string; orphaned: boolean }>;
  return { released: rows.length, orphanedNames: rows.filter((x) => x.orphaned).map((x) => x.name) };
}

/** full 싱크 스윕 — 이번 run 이 못 본 **내 몫**을 떼고, 아무도 안 맡는 활성 미러만 archived 로(원본 삭제/공유해제 전파).
 *  ⚠ 호출 조건: full 모드 + 커넥터 실패 0 + 미러 실패 0(부분 실패 run 에서 스윕하면 살아있는 페이지가 오탐 아카이브됨). */
//  #1561 감사: 아카이브된 행마다 op='set_lifecycle' 을 남긴다 — 여기서 안 남기면 '언제·왜 이 문서가
//   아카이브됐나'가 문서 이력 어디에도 없다(실측: 이 경로로 511건이 흔적 없이 아카이브돼 있었다).
//  ★ instance 필수(#1881 다중 워크스페이스): 워크스페이스 A 의 run 이 B 의 문서를 건드리지 않게 스탬프 축으로 좁힌다.
//  ★ claimKey 필수(#4059 한 워크스페이스 · 수집기 여럿): 같은 축 안에서도 **남이 맡은 행**은 건드리지 않는다(위 절).
export async function sweepNotionArchived(
  db: PgRunner,
  input: { runStartIso: string; instance: string; claimKey: string; plan: NotionSweepPlan },
): Promise<NotionSweepResult> {
  if (!input.instance) throw new Error("sweepNotionArchived: instance 가 비었습니다 — 범위 없는 스윕은 타 워크스페이스를 아카이브합니다");
  if (!input.claimKey) throw new Error("sweepNotionArchived: claimKey 가 비었습니다 — 표식 없는 스윕은 같은 워크스페이스의 다른 수집기 몫을 아카이브합니다");
  const rel = await releaseNotionClaims(db, input);
  const plan = input.plan;
  if (!plan.archive) {
    return { released: rel.released, orphaned: rel.orphanedNames.length, archived: 0, held: plan.reason };
  }
  // 이번에 뗀 마지막 표식은 **혼자일 때만** 곧바로 보관 대상이다 — 다른 수집기가 있으면 그들의 다음 점검이 증명한다.
  const justOrphaned = plan.sole ? rel.orphanedNames : [];
  const r = await db.query(
    `UPDATE knowledge SET lifecycle='archived', updated_at=now(), updated_by='connector:notion'
     WHERE external_system='notion' AND external_instance=$2 AND lifecycle='active'
       AND (last_synced_at IS NULL OR last_synced_at < $1::timestamptz)
       AND COALESCE(sync_state->'seen_by', '{}'::jsonb) = '{}'::jsonb
       AND (name = ANY($3::text[])
            OR COALESCE((sync_state->>'unclaimed_since')::timestamptz, created_at, '-infinity'::timestamptz)
               < $4::timestamptz)
     RETURNING name`,
    [input.runStartIso, input.instance, justOrphaned, plan.cutoffIso],
  );
  await auditLifecycleSweep(db, (r.rows as Array<{ name: string }>).map((x) => x.name),
    "connector:notion", "active", "archived");
  return { released: rel.released, orphaned: rel.orphanedNames.length, archived: r.rowCount ?? 0, held: null };
}

/** 가속 full 관측 — 원장 일치로 방출을 건너뛴 행에 «이번에 봤다» 를 남긴다(last_synced_at + 내 표식). */
export async function observeNotionRows(
  db: PgRunner, input: { instance: string; ids: string[]; claimKey: string },
): Promise<void> {
  for (let i = 0; i < input.ids.length; i += 5000) {
    await db.query(
      `UPDATE knowledge SET last_synced_at = now(),
              sync_state = ${claimSyncStateSql("sync_state", "$3")}
        WHERE external_system='notion' AND external_instance=$2 AND external_id = ANY($1::text[])`,
      [input.ids.slice(i, i + 5000), input.instance, input.claimKey]);
  }
}

/** 이번 run 에 **이 수집기가** 적재한 행 수 — 미러 대사(방출 수와 비교)용. 같은 축의 다른 수집기가 동시에 쓴 행은 안 센다. */
export async function countNotionClaimedSince(
  db: PgRunner, input: { instance: string; claimKey: string; sinceIso: string },
): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM knowledge
      WHERE external_system='notion' AND external_instance=$1
        AND (sync_state->'seen_by'->>$2::text)::timestamptz >= $3::timestamptz`,
    [input.instance, input.claimKey, input.sinceIso]);
  return Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
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
  /**
   * 이 수집기의 몫인가(#4059) — 내 표식이 있거나, 표식이 한 번도 없던 행(이 수정 전 적재분).
   *  델타의 범위 판정(scope.inScope)이 원장을 «내 범위의 증거» 로 쓸 때 이것만 믿는다 — 같은 워크스페이스의
   *  다른 수집기가 맡은 행을 증거로 쓰면 남의 페이지를 내 설정(분류·산출 방식)으로 적재한다.
   *  원장을 표식 없이 읽으면(claimKey 미지정) 전부 true — 종전 동작.
   */
  mine: boolean;
}
export interface NotionLedger {
  byId: Map<string, NotionLedgerEntry>;
  /** data_source id → 소유 database id (저장된 fields.notion.data_source_ids 역매핑) */
  dsToDb: Map<string, string>;
  /** 역링크: target ext id → 그걸 본문에서 참조하는 페이지들의 ext id — 개명 시 멘션 제목 캐시 재렌더용 */
  backlinks: Map<string, string[]>;
}

//  ★ instance 필수(#1881): 원장은 "커넥터가 이미 아는 것"의 스냅샷이다. 다른 워크스페이스의 페이지가 섞이면
//   ⓐ 델타가 남의 페이지를 '알고 있음'으로 읽어 판정이 틀어지고 ⓑ 가속 full 의 스킵/관측 판정이 남의 행을 건드린다.
//  claimKey(#4059): 주면 각 항목에 mine(이 수집기의 몫인가)을 싣는다. 원장 자체는 여전히 워크스페이스 전체다 —
//   «이 행이 최신인가»(스킵)·«자식이 누구인가»(가속 full 큐잉)·링크 제목은 누가 적재했든 같은 사실이라서다.
export async function loadNotionLedger(db: PgRunner, instance: string, claimKey?: string): Promise<NotionLedger> {
  if (!instance) throw new Error("loadNotionLedger: instance 가 비었습니다");
  const r = await db.query(
    `SELECT external_id, title, lifecycle, parent_external_id, last_synced_at,
            fields->'notion'->>'kind' AS kind,
            fields->'notion'->>'unsupported' AS unsupported,
            COALESCE(raw->'page'->>'last_edited_time', raw->'database'->>'last_edited_time') AS last_edited,
            (SELECT max(ds->>'last_edited_time') FROM jsonb_array_elements(COALESCE(raw->'data_sources','[]'::jsonb)) AS ds) AS ds_edited,
            fields->'notion'->'data_source_ids' AS ds_ids,
            ($2::text IS NULL
              OR (sync_state->'seen_by'->>$2::text) IS NOT NULL
              OR (sync_state->'seen_by' IS NULL AND sync_state->'unclaimed_since' IS NULL)) AS mine
     FROM knowledge WHERE external_system='notion' AND external_instance=$1 AND external_id IS NOT NULL`,
    [instance, claimKey ?? null]);
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
      mine: row.mine !== false,
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
     WHERE external_system='notion' AND external_instance=$1 AND external_id IS NOT NULL AND body_md LIKE '%/api/ui/notion-assets/%'
     GROUP BY external_id`, [instance]);
  for (const row of ar.rows as Array<{ external_id: string; files: string[] }>) {
    const led = byId.get(String(row.external_id));
    if (led && Array.isArray(row.files)) led.assets = row.files.map(String);
  }
  // 역링크 — 커넥터가 물질화한 링크만(본문에 실제 등장하는 참조 = 개명 시 재렌더 대상).
  const backlinks = new Map<string, string[]>();
  const bl = await db.query(
    `SELECT tk.external_id AS target_ext, fk.external_id AS from_ext
     FROM knowledge_link l
     JOIN knowledge fk ON fk.name = l.from_name AND fk.external_system='notion' AND fk.external_instance=$1 AND fk.external_id IS NOT NULL
     JOIN knowledge tk ON tk.name = l.to_name AND tk.external_system='notion' AND tk.external_instance=$1 AND tk.external_id IS NOT NULL
     WHERE l.origin = 'connector:notion'`, [instance]);
  for (const row of bl.rows as Array<{ target_ext: string; from_ext: string }>) {
    const arr = backlinks.get(row.target_ext);
    if (arr) arr.push(row.from_ext); else backlinks.set(row.target_ext, [row.from_ext]);
  }
  return { byId, dsToDb, backlinks };
}

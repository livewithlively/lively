// 앱 데이터 떠 두기·되돌리기 (#4226, 계획 지식 crm-dogfood-app-builder-plan-4200 §7-4).
//
// ── 왜 ───────────────────────────────────────────────────────────────────────────────────
//  자유 SQL 이 열리면 AI 한 줄로 행이 사라질 수 있다(조건 없는 UPDATE·DELETE 는 막지만 `WHERE stage='보류'` 는 막을 수 없다).
//  RDS 백업(7일)은 DB 전체 단위라 한 워크스페이스·한 앱만 되돌릴 수 없다. 그래서 (워크스페이스, 앱) 데이터를 따로 떠 둔다:
//   · 하루 한 번(daily) — 매니지드는 CP 하우스키핑 틱, 자가호스팅은 부팅 정비 타이머가 부른다
//   · 앱 제거 직전(before-remove) — 제거는 테이블을 지운다. 7일 안에 같은 앱을 다시 설치하면 되돌릴 수 있다
//   · 되돌리기 직전(before-restore) — 되돌리기도 되돌릴 수 있게
//   · 보관 표 비우기 직전(before-clear, #4733) — 보관 표는 «archive:<이름>» 으로 담긴다(앱 제거 때도 같은 묶음에). 되돌리기는 이것을
//     되살리지 않는다(상민 2026-10-15 — 보관 표는 원래 앱이 쓰지 않는 표다. 백업에만 남긴다 · app-archive.ts)
//  7일이 지나면 지운다. 기본 앱(여러 워크스페이스가 테이블을 나눠 쓰는 앱)은 뜨지 않는다 — 워크스페이스가 만든 앱만.
//
// ── 어떻게 ────────────────────────────────────────────────────────────────────────────────
//  떠 두기는 런타임 풀(itemsPool)로 한다 — 행 격리가 이 워크스페이스 행만 보여 준다. 데이터는 게이트웨이를 거치지 않는다:
//   `INSERT … SELECT jsonb_agg(to_jsonb(t))` 한 문장이 1,000행 묶음을 DB 안에서 옮긴다.
//  되돌리기는 소유자(앱 DDL) 연결로 한다 — 원래 id 를 그대로 넣고(OVERRIDING SYSTEM VALUE) id 시퀀스를 다시 맞추려면
//   테이블 주인이어야 한다. 묶음은 런타임 풀로 읽어 넘긴다(앱 DDL 역할은 본체 테이블 권한이 없다).
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { itemsPool, withTx } from "../db/client.js";
import { getApp, listApps } from "../org/store/apps.js";
import { isBuiltinSource, qualifiedAppTable, physicalTableName } from "./store-ddl.js";
import { appSchemaFor, withOwnerConn, inTx } from "./store-schema.js";
import { appSqlTenantId } from "./app-sql-exec.js";
import { liveTableNames } from "./app-view.js";
import { ARCHIVE_SNAPSHOT_PREFIX, isArchiveSnapshotTable } from "./archive-meta.js";

export type SnapshotReason = "daily" | "before-remove" | "before-restore" | "before-clear";
const CHUNK = 1000;

const num = (v: unknown, dflt: number): number => { const n = Number(String(v ?? "").trim()); return Number.isFinite(n) && n > 0 ? n : dflt; };
/** 보관 일수(기본 7). */
export const snapshotKeepDays = (env: NodeJS.ProcessEnv = process.env): number => num(env.LIVELY_APP_SNAPSHOT_DAYS, 7);
/** 이보다 큰 앱은 뜨지 않는다(기본 200MB) — 떠 두기가 DB 디스크를 7배로 불리지 않게. 건너뛰면 로그를 남긴다. */
export const snapshotMaxBytes = (env: NodeJS.ProcessEnv = process.env): number => num(env.LIVELY_APP_SNAPSHOT_MAX_BYTES, 200 * 1024 * 1024);
/** 하루 한 번 — 틱이 5분마다 와도 20시간 안에 뜬 게 있으면 건너뛴다. */
const DAILY_GAP_MS = 20 * 60 * 60 * 1000;


export interface SnapshotOutcome {
  app_id: string;
  taken_at: string | null;
  reason: SnapshotReason;
  tables: Array<{ table: string; rows: number }>;
  skipped?: string;
}

/** 이 워크스페이스에서 그 앱의 데이터를 떠 둔다. 테이블이 없으면 그 테이블은 건너뛴다(설치 때 실패했던 앱). */
export async function snapshotAppData(appId: string, reason: SnapshotReason, now: Date = new Date()): Promise<SnapshotOutcome> {
  const app = await getApp(appId);
  const out: SnapshotOutcome = { app_id: appId, taken_at: null, reason, tables: [] };
  if (!app) return { ...out, skipped: "앱 없음" };
  if (isBuiltinSource(app.source)) return { ...out, skipped: "기본 앱" };
  //  #4667 물리 표 전부 — 공개 앱에 초안이 걸려 있으면 초안이 뺀(공개 판이 아직 쓰는) 표도 떠 둔다(격리 리뷰 NB-7).
  const tables = await liveTableNames(app);
  if (!tables.length) return { ...out, skipped: "데이터 테이블 없음" };
  const schema = appSchemaFor(false);
  const rels = tables.map((t) => ({ table: t, rel: qualifiedAppTable(schema, appId, t) }));
  const present: typeof rels = [];
  let bytes = 0;
  for (const r of rels) {
    const row = (await itemsPool.query("SELECT pg_total_relation_size(to_regclass($1)) AS b", [r.rel])).rows[0];
    if (row?.b == null) continue;
    bytes += Number(row.b);
    present.push(r);
  }
  if (!present.length) return { ...out, skipped: "테이블이 아직 없음" };
  if (bytes > snapshotMaxBytes()) {
    logger.warn({ appId, bytes }, "앱 데이터가 커서 떠 두기를 건너뜁니다(LIVELY_APP_SNAPSHOT_MAX_BYTES)");
    return { ...out, skipped: `너무 큼(${Math.round(bytes / 1024 / 1024)}MB)` };
  }
  //  ★ 한 번 떠 두기 = 한 트랜잭션(격리 리뷰 2026-09-30). 묶음마다 따로 커밋하면 중간에 실패했을 때 앞 묶음만 남아
  //   «정상 떠 두기» 로 보이고, 그걸로 되돌리면 나머지 행이 지워진다(실측). 실패면 아무것도 남기지 않는다.
  //  #5172 한 시점(REPEATABLE READ) — 조각 사이에 앱이 쓰는 행에 흔들리지 않아 «담은 행 = 표의 행» 을 확인할 수 있고,
  //   표끼리도 같은 시점이라 외래키로 이어진 표를 함께 되돌릴 때 어긋나지 않는다.
  const counted = await withTx(async (client) => {
    const done: Array<{ table: string; rows: number }> = [];
    for (const { table, rel } of present) {
      done.push({ table, rows: await snapshotTable(client, appId, table, rel, reason, now) });
    }
    return done;
  }, { isolation: "repeatable read" });
  return { ...out, taken_at: now.toISOString(), tables: counted };
}

/** 테이블 하나를 1,000행 묶음으로 떠 둔다(주어진 트랜잭션 안에서). 반환 = 행 수.
 *  #5172 가장 작은 id 부터 넘긴다 — 원래 id 로 넣기가 열려 0·음수 id 도 생긴다(종전엔 id > 0 부터라 그 행이 빠졌고,
 *   그 사본으로 되돌리면 그 행이 지워졌다). 끝에 담은 행이 표의 행과 같은지 본다 — 같은 시점이라 정확히 같아야 한다. */
async function snapshotTable(client: { query: typeof itemsPool.query }, appId: string, table: string, rel: string, reason: SnapshotReason, now: Date): Promise<number> {
  let last: string | null = null, chunk = 0, rows = 0;
  for (;;) {
    const r: { rows: Array<{ last?: unknown; n?: unknown }> } = await client.query(
      `WITH t AS (SELECT * FROM ${rel} WHERE $1::bigint IS NULL OR id > $1::bigint ORDER BY id LIMIT ${CHUNK}),
            ins AS (
              INSERT INTO org_app_snapshot(app_id, taken_at, table_name, chunk, reason, row_count, rows)
              SELECT $2, $3, $4, $5, $6, (SELECT count(*) FROM t), (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb) FROM t)
               WHERE $5 = 0 OR EXISTS (SELECT 1 FROM t)
              RETURNING row_count)
       SELECT (SELECT max(id) FROM t)::text AS last, (SELECT row_count FROM ins) AS n`,
      [last, appId, now, table, chunk, reason]);
    const n = Number(r.rows[0]?.n ?? 0);
    rows += n;
    if (n < CHUNK) break;
    last = String(r.rows[0]?.last);
    chunk++;
  }
  const all = Number((await client.query(`SELECT count(*)::bigint AS n FROM ${rel}`)).rows[0]?.n ?? 0);
  if (all !== rows) throw new Error(`'${table}' 떠 둔 행(${rows})이 표의 행(${all})과 다릅니다 — 떠 두기를 취소했습니다`);
  return rows;
}

/** 오래된 것 지우기 — 보관 일수가 지난 묶음. 반환 = 지운 행 수. */
export async function pruneAppSnapshots(keepDays: number = snapshotKeepDays()): Promise<number> {
  const r = await itemsPool.query(`DELETE FROM org_app_snapshot WHERE taken_at < now() - make_interval(days => $1)`, [Math.floor(keepDays)]);
  return r.rowCount ?? 0;
}

/**
 * 하루 한 번 떠 두기 + 오래된 것 지우기 — 이 워크스페이스(요청·순회 컨텍스트)에서. 멱등(20시간 안에 뜬 앱은 건너뛴다).
 *  하우스키핑 틱(매니지드)·부팅 정비 타이머(자가호스팅)가 부른다. 앱 하나의 실패가 나머지를 막지 않는다.
 */
export async function runDailyAppSnapshots(now: Date = new Date()): Promise<{ taken: string[]; skipped: number; too_big: string[]; failed: string[]; pruned: number }> {
  const taken: string[] = [], failed: string[] = [], tooBig: string[] = [];
  let skipped = 0;
  const apps = (await listApps()).filter((a) => a.status === "active" && !isBuiltinSource(a.source));
  for (const app of apps) {
    if (!(await liveTableNames(app)).length) continue;
    try {
      const last = (await itemsPool.query(
        `SELECT max(taken_at) AS t FROM org_app_snapshot WHERE app_id=$1 AND reason='daily'`, [app.id])).rows[0]?.t as Date | null;
      if (last && now.getTime() - new Date(last).getTime() < DAILY_GAP_MS) { skipped++; continue; }
      const o = await snapshotAppData(app.id, "daily", now);
      if (o.taken_at) taken.push(app.id);
      else if (o.skipped?.startsWith("너무 큼")) tooBig.push(app.id);   // 틱 결과에 드러낸다(로그 한 줄로 묻히지 않게)
      else skipped++;
    } catch (err) {
      logger.warn({ err, app: app.id }, "앱 데이터 떠 두기 실패(비치명 — 다음 틱에 다시)");
      failed.push(app.id);
    }
  }
  const pruned = await pruneAppSnapshots().catch((err) => { logger.warn({ err }, "앱 데이터 묶음 정리 실패(비치명)"); return 0; });
  return { taken, skipped, too_big: tooBig, failed, pruned };
}

// ── 목록·되돌리기(관리자) ─────────────────────────────────────────────────────────────────

export interface SnapshotListing {
  app_id: string;
  taken_at: string;
  reason: string;
  /** archive = 보관 표(#4733 — «archive:<이름>», 되살리지 않는다). */
  tables: Array<{ table: string; rows: number; archive?: true }>;
}

export async function listAppSnapshots(appId?: string | null): Promise<SnapshotListing[]> {
  const r = await itemsPool.query(
    `SELECT app_id, taken_at, max(reason) AS reason, table_name, sum(row_count)::int AS rows
       FROM org_app_snapshot ${appId ? "WHERE app_id=$1" : ""}
      GROUP BY app_id, taken_at, table_name
      ORDER BY taken_at DESC, app_id, table_name`, appId ? [appId] : []);
  const by = new Map<string, SnapshotListing>();
  for (const row of r.rows) {
    const at = row.taken_at instanceof Date ? row.taken_at.toISOString() : String(row.taken_at);
    const k = `${row.app_id}\0${at}`;
    const cur: SnapshotListing = by.get(k) ?? { app_id: String(row.app_id), taken_at: at, reason: String(row.reason), tables: [] };
    const table = String(row.table_name);
    cur.tables.push({ table, rows: Number(row.rows), ...(isArchiveSnapshotTable(table) ? { archive: true as const } : {}) });
    by.set(k, cur);
  }
  return [...by.values()];
}

/** 이 앱의 표끼리 걸린 외래키(#4483) — 카탈로그에서 읽는다(선언이 아니라 지금 걸려 있는 것). 이름은 선언 표 이름. */
async function appForeignKeys(schema: string, appId: string, tables: string[]): Promise<Array<{ child: string; parent: string }>> {
  const byPhysical = new Map(tables.map((t) => [physicalTableName(appId, t), t]));
  if (!byPhysical.size) return [];
  const r = await itemsPool.query(
    `SELECT ch.relname AS child, pa.relname AS parent FROM pg_constraint con
       JOIN pg_class ch ON ch.oid = con.conrelid JOIN pg_class pa ON pa.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = ch.relnamespace JOIN pg_namespace pn ON pn.oid = pa.relnamespace
      WHERE con.contype = 'f' AND n.nspname = $1 AND pn.nspname = $1 AND ch.relname = ANY($2::text[]) AND pa.relname = ANY($2::text[])`,
    [schema, [...byPhysical.keys()]]);
  return r.rows.map((x) => ({ child: byPhysical.get(String(x.child))!, parent: byPhysical.get(String(x.parent))! }));
}

/** 가리키는 표(부모)가 먼저 오게 줄 세운다. 서로 가리키면(순환) null. 자기 자신을 가리키는 것은 순서와 상관없다. */
export function parentsFirst(tables: string[], fks: Array<{ child: string; parent: string }>): string[] | null {
  const edges = fks.filter((f) => f.child !== f.parent && tables.includes(f.child) && tables.includes(f.parent));
  const waiting = new Map(tables.map((t) => [t, new Set(edges.filter((f) => f.child === t).map((f) => f.parent))]));
  const out: string[] = [];
  while (waiting.size) {
    const ready = [...waiting.keys()].filter((t) => waiting.get(t)!.size === 0);
    if (!ready.length) return null;
    for (const t of ready) { out.push(t); waiting.delete(t); for (const deps of waiting.values()) deps.delete(t); }
  }
  return out;
}

/**
 * 떠 둔 묶음으로 그 앱의 테이블을 되돌린다 — 테이블의 이 워크스페이스 행을 **통째로 그 시점으로** 바꾼다.
 *  순서(격리 리뷰 2026-09-30 반영):
 *   ① 묶음을 먼저 읽는다 — 읽는 사이 정리돼 비었으면 멈춘다(빈 묶음으로 테이블을 비우지 않는다).
 *   ② 소유자 연결의 한 트랜잭션에서 대상 테이블을 SHARE 로 잠근다 — 쓰기는 막히고 읽기는 된다.
 *   ③ 그 상태에서 지금 데이터를 떠 둔다(before-restore). 못 뜨면(너무 큼 등) force 없이는 멈춘다 — 되돌리기를 되돌릴 수 없게 되므로.
 *   ④ 이 워크스페이스 행 삭제 → 묶음 행 삽입(원래 id) → 넣은 수가 떠 둔 수와 다르면 전부 취소 → id 시퀀스 맞추기 → 커밋.
 *  테이블 여럿이면 한 트랜잭션이다(전부 되거나 전부 안 된다). 떠 둔 뒤 매니페스트가 칸을 늘렸으면 새 칸은 NULL,
 *  없앤 칸의 값은 버린다(jsonb_populate_record 규칙).
 *  #4483 외래키 — 되돌리지 않는 표가 되돌릴 표를 가리키면 시작 전에 409(그 표의 행이 cascade 로 함께 지워지거나 삭제가 막힌다 —
 *  격리 리뷰 재현). 되돌릴 표끼리는 지우기는 가리키는 쪽(자식)부터, 넣기는 가리켜지는 쪽(부모)부터. 넣은 행이 가리킬 행이
 *  지금 없으면(23503) 전부 취소하고 409.
 */
export async function restoreAppSnapshot(appId: string, takenAt: string, onlyTable?: string | null, opts: { force?: boolean } = {}): Promise<{ restored: Array<{ table: string; rows: number }>; safety: SnapshotOutcome; archives_skipped: string[] }> {
  const app = await getApp(appId);
  if (!app) throw new HttpError(404, `앱 없음: ${appId} — 제거한 앱이면 같은 id 로 다시 설치한 뒤 되돌리세요`);
  if (isBuiltinSource(app.source)) throw new HttpError(400, "기본 앱은 되돌리기 대상이 아닙니다");
  const at = new Date(takenAt);
  if (Number.isNaN(at.getTime())) throw new HttpError(400, `taken_at 형식이 아닙니다: ${takenAt}`);
  const inBundle = (await itemsPool.query(
    `SELECT DISTINCT table_name FROM org_app_snapshot WHERE app_id=$1 AND taken_at=$2`, [appId, at])).rows.map((r) => String(r.table_name));
  if (!inBundle.length) throw new HttpError(404, `그 시각(${takenAt})에 떠 둔 '${appId}' 데이터가 없습니다 — app_data_snapshots 로 목록을 보세요`);
  //  #4733 보관 표(«archive:<이름>» — 앱 제거 · 보관 표 비우기 때 함께 담긴다)는 되살리지 않는다 — 묶음을 되살릴 땐 건너뛰고, 그것만 고르면 거절.
  const listed = inBundle.filter((t) => !isArchiveSnapshotTable(t));
  const archivesSkipped = onlyTable ? [] : inBundle.filter(isArchiveSnapshotTable).map((t) => t.slice(ARCHIVE_SNAPSHOT_PREFIX.length));
  if (onlyTable && isArchiveSnapshotTable(onlyTable)) {
    throw new HttpError(400, `보관 표(${onlyTable.slice(ARCHIVE_SNAPSHOT_PREFIX.length)})는 되살리지 않습니다 — 백업에만 남깁니다. 앱 표를 고르세요`);
  }
  if (!onlyTable && !listed.length) {
    throw new HttpError(409, `그 시각(${takenAt})의 묶음엔 보관 표만 담겨 있어 되살릴 앱 표가 없습니다 — 보관 표는 되살리지 않습니다. 아무것도 바꾸지 않았습니다`);
  }
  const targets = onlyTable ? [onlyTable] : listed;
  for (const t of targets) if (!listed.includes(t)) throw new HttpError(404, `그 묶음에 '${t}' 테이블이 없습니다`);
  const declared = new Set(await liveTableNames(app));
  const missing = targets.filter((t) => !declared.has(t));
  if (missing.length) throw new HttpError(409, `지금 앱에 선언되지 않은 테이블이라 되돌릴 자리가 없습니다: ${missing.join(", ")} — 매니페스트에 다시 선언한 뒤 되돌리세요`);

  // ① 묶음 읽기
  const data = new Map<string, { chunks: string[]; expected: number }>();
  for (const table of targets) {
    const rows = (await itemsPool.query(
      `SELECT rows::text AS rows, row_count FROM org_app_snapshot WHERE app_id=$1 AND taken_at=$2 AND table_name=$3 ORDER BY chunk`, [appId, at, table])).rows;
    if (!rows.length) throw new HttpError(409, `'${table}' 묶음이 사라졌습니다(보관 기간이 지나 정리됐을 수 있습니다) — 아무것도 바꾸지 않았습니다`);
    data.set(table, { chunks: rows.map((r) => String(r.rows)), expected: rows.reduce((n, r) => n + Number(r.row_count), 0) });
  }

  const schema = appSchemaFor(false);
  const tenant = appSqlTenantId();
  const fks = await appForeignKeys(schema, appId, [...declared]);
  const outside = fks.filter((f) => targets.includes(f.parent) && !targets.includes(f.child));
  if (outside.length) {
    const kids = [...new Set(outside.map((f) => f.child))].join(", "), parents = [...new Set(outside.map((f) => f.parent))].join(", ");
    throw new HttpError(409, `되돌리지 않는 표(${kids})가 되돌릴 표(${parents})를 외래키로 가리킵니다 — 이대로 되돌리면 그 표의 행이 함께 지워지거나 `
      + "되돌리기가 막힙니다. 표를 고르지 말고 묶음 전체를 되돌리세요(묶음에 없는 표가 가리키면 그 표도 함께 떠 둔 시점을 고르세요). 아무것도 바꾸지 않았습니다");
  }
  const order = parentsFirst(targets, fks);
  if (!order) throw new HttpError(409, `되돌릴 표들(${targets.join(", ")})이 서로를 외래키로 가리켜(순환) 지우고 넣는 순서를 정할 수 없습니다 — 아무것도 바꾸지 않았습니다`);
  return withOwnerConn((db) => inTx(db, async (c) => {
    // ② 쓰기 막기(읽기는 된다 — ③ 이 읽는다)
    for (const table of targets) await c.query(`LOCK TABLE ${qualifiedAppTable(schema, appId, table)} IN SHARE MODE`);
    // ③ 직전 상태
    const safety = await snapshotAppData(appId, "before-restore");
    if (!safety.taken_at && !opts.force) {
      throw new HttpError(409, `되돌리기 직전 상태를 떠 두지 못해(${safety.skipped ?? "까닭 모름"}) 멈췄습니다 — 이대로 되돌리면 되돌린 것을 다시 되돌릴 수 없습니다. 그래도 하려면 force 를 주세요`);
    }
    // ④ 바꾸기 — 지우기는 자식부터, 넣기는 부모부터(외래키)
    for (const table of [...order].reverse()) await c.query(`DELETE FROM ${qualifiedAppTable(schema, appId, table)} WHERE tenant_id = $1::uuid`, [tenant]);
    const restored: Array<{ table: string; rows: number }> = [];
    for (const table of order) {
      const rel = qualifiedAppTable(schema, appId, table);
      const { chunks, expected } = data.get(table)!;
      //  표 하나를 **한 문장**으로 넣는다 — 외래키 확인은 문장 끝에 하므로, 자기 자신을 가리키는 표에서 앞 조각 행이 뒤 조각 행을
      //   가리켜도 걸리지 않는다(종전엔 1,000행 조각마다 넣어 첫 조각에서 23503 — 재검토 4-2).
      let count = 0;
      try {
        const r = await c.query(
          `INSERT INTO ${rel} OVERRIDING SYSTEM VALUE
           SELECT (jsonb_populate_record(NULL::${rel}, e || jsonb_build_object('tenant_id', $2::text))).*
             FROM unnest($1::jsonb[]) AS chunk(rows), jsonb_array_elements(chunk.rows) e`, [chunks, tenant]);
        count = r.rowCount ?? 0;
      } catch (e) {
        if ((e as { code?: string })?.code !== "23503") throw e;
        throw new HttpError(409, `'${table}' 의 떠 둔 행이 가리키는 행이 지금 없습니다 — 가리키는 표까지 함께 되돌리세요(표를 고르지 말고 묶음 전체). `
          + "아무것도 바꾸지 않았습니다", { cause: e });
      }
      if (count !== expected) {
        throw new HttpError(500, `'${table}' 되돌리기에서 넣은 행(${count})이 떠 둔 행(${expected})과 달라 전부 취소했습니다 — 아무것도 바뀌지 않았습니다`);
      }
      await c.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM ${rel}), 1), (SELECT count(*) > 0 FROM ${rel}))`, [rel]);
      restored.push({ table, rows: count });
    }
    return { restored, safety, archives_skipped: archivesSkipped };
  }));
}

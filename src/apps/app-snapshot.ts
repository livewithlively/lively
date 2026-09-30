// 앱 데이터 떠 두기·되돌리기 (#4226, 계획 지식 crm-dogfood-app-builder-plan-4200 §7-4).
//
// ── 왜 ───────────────────────────────────────────────────────────────────────────────────
//  자유 SQL 이 열리면 AI 한 줄로 행이 사라질 수 있다(조건 없는 UPDATE·DELETE 는 막지만 `WHERE stage='보류'` 는 막을 수 없다).
//  RDS 백업(7일)은 DB 전체 단위라 한 워크스페이스·한 앱만 되돌릴 수 없다. 그래서 (워크스페이스, 앱) 데이터를 따로 떠 둔다:
//   · 하루 한 번(daily) — 매니지드는 CP 하우스키핑 틱, 자가호스팅은 부팅 정비 타이머가 부른다
//   · 앱 제거 직전(before-remove) — 제거는 테이블을 지운다. 7일 안에 같은 앱을 다시 설치하면 되돌릴 수 있다
//   · 되돌리기 직전(before-restore) — 되돌리기도 되돌릴 수 있게
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
import { getApp, listApps, type OrgApp } from "../org/store/apps.js";
import { isBuiltinSource, qualifiedAppTable } from "./store-ddl.js";
import { appSchemaFor, withOwnerConn, inTx } from "./store-schema.js";
import { appSqlTenantId } from "./app-sql-exec.js";

export type SnapshotReason = "daily" | "before-remove" | "before-restore";
const CHUNK = 1000;

const num = (v: unknown, dflt: number): number => { const n = Number(String(v ?? "").trim()); return Number.isFinite(n) && n > 0 ? n : dflt; };
/** 보관 일수(기본 7). */
export const snapshotKeepDays = (env: NodeJS.ProcessEnv = process.env): number => num(env.LIVELY_APP_SNAPSHOT_DAYS, 7);
/** 이보다 큰 앱은 뜨지 않는다(기본 200MB) — 떠 두기가 DB 디스크를 7배로 불리지 않게. 건너뛰면 로그를 남긴다. */
export const snapshotMaxBytes = (env: NodeJS.ProcessEnv = process.env): number => num(env.LIVELY_APP_SNAPSHOT_MAX_BYTES, 200 * 1024 * 1024);
/** 하루 한 번 — 틱이 5분마다 와도 20시간 안에 뜬 게 있으면 건너뛴다. */
const DAILY_GAP_MS = 20 * 60 * 60 * 1000;

function declaredTables(app: OrgApp): string[] {
  const t = (app.manifest as { data?: { tables?: Array<{ name?: unknown }> } } | null)?.data?.tables;
  return Array.isArray(t) ? t.map((x) => String(x?.name ?? "")).filter(Boolean) : [];
}

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
  const tables = declaredTables(app);
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
  const counted = await withTx(async (client) => {
    const done: Array<{ table: string; rows: number }> = [];
    for (const { table, rel } of present) {
      done.push({ table, rows: await snapshotTable(client, appId, table, rel, reason, now) });
    }
    return done;
  });
  return { ...out, taken_at: now.toISOString(), tables: counted };
}

/** 테이블 하나를 1,000행 묶음으로 떠 둔다(주어진 트랜잭션 안에서). 반환 = 행 수. */
async function snapshotTable(client: { query: typeof itemsPool.query }, appId: string, table: string, rel: string, reason: SnapshotReason, now: Date): Promise<number> {
  let last = 0n, chunk = 0, rows = 0;
  for (;;) {
    const r = await client.query(
      `WITH t AS (SELECT * FROM ${rel} WHERE id > $1 ORDER BY id LIMIT ${CHUNK}),
            ins AS (
              INSERT INTO org_app_snapshot(app_id, taken_at, table_name, chunk, reason, row_count, rows)
              SELECT $2, $3, $4, $5, $6, (SELECT count(*) FROM t), (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb) FROM t)
               WHERE $5 = 0 OR EXISTS (SELECT 1 FROM t)
              RETURNING row_count)
       SELECT (SELECT max(id) FROM t)::text AS last, (SELECT row_count FROM ins) AS n`,
      [last.toString(), appId, now, table, chunk, reason]);
    const n = Number(r.rows[0]?.n ?? 0);
    rows += n;
    if (n < CHUNK) break;
    last = BigInt(String(r.rows[0]?.last ?? "0"));
    chunk++;
  }
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
  const apps = (await listApps()).filter((a) => a.status === "active" && !isBuiltinSource(a.source) && declaredTables(a).length);
  for (const app of apps) {
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
  tables: Array<{ table: string; rows: number }>;
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
    cur.tables.push({ table: String(row.table_name), rows: Number(row.rows) });
    by.set(k, cur);
  }
  return [...by.values()];
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
 */
export async function restoreAppSnapshot(appId: string, takenAt: string, onlyTable?: string | null, opts: { force?: boolean } = {}): Promise<{ restored: Array<{ table: string; rows: number }>; safety: SnapshotOutcome }> {
  const app = await getApp(appId);
  if (!app) throw new HttpError(404, `앱 없음: ${appId} — 제거한 앱이면 같은 id 로 다시 설치한 뒤 되돌리세요`);
  if (isBuiltinSource(app.source)) throw new HttpError(400, "기본 앱은 되돌리기 대상이 아닙니다");
  const at = new Date(takenAt);
  if (Number.isNaN(at.getTime())) throw new HttpError(400, `taken_at 형식이 아닙니다: ${takenAt}`);
  const listed = (await itemsPool.query(
    `SELECT DISTINCT table_name FROM org_app_snapshot WHERE app_id=$1 AND taken_at=$2`, [appId, at])).rows.map((r) => String(r.table_name));
  if (!listed.length) throw new HttpError(404, `그 시각(${takenAt})에 떠 둔 '${appId}' 데이터가 없습니다 — app_data_snapshots 로 목록을 보세요`);
  const targets = onlyTable ? [onlyTable] : listed;
  for (const t of targets) if (!listed.includes(t)) throw new HttpError(404, `그 묶음에 '${t}' 테이블이 없습니다`);
  const declared = new Set(declaredTables(app));
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
  return withOwnerConn((db) => inTx(db, async (c) => {
    // ② 쓰기 막기(읽기는 된다 — ③ 이 읽는다)
    for (const table of targets) await c.query(`LOCK TABLE ${qualifiedAppTable(schema, appId, table)} IN SHARE MODE`);
    // ③ 직전 상태
    const safety = await snapshotAppData(appId, "before-restore");
    if (!safety.taken_at && !opts.force) {
      throw new HttpError(409, `되돌리기 직전 상태를 떠 두지 못해(${safety.skipped ?? "까닭 모름"}) 멈췄습니다 — 이대로 되돌리면 되돌린 것을 다시 되돌릴 수 없습니다. 그래도 하려면 force 를 주세요`);
    }
    // ④ 바꾸기
    const restored: Array<{ table: string; rows: number }> = [];
    for (const table of targets) {
      const rel = qualifiedAppTable(schema, appId, table);
      const { chunks, expected } = data.get(table)!;
      await c.query(`DELETE FROM ${rel} WHERE tenant_id = $1::uuid`, [tenant]);
      let count = 0;
      for (const rows of chunks) {
        const r = await c.query(
          `INSERT INTO ${rel} OVERRIDING SYSTEM VALUE
           SELECT (jsonb_populate_record(NULL::${rel}, e || jsonb_build_object('tenant_id', $2::text))).*
             FROM jsonb_array_elements($1::jsonb) e`, [rows, tenant]);
        count += r.rowCount ?? 0;
      }
      if (count !== expected) {
        throw new HttpError(500, `'${table}' 되돌리기에서 넣은 행(${count})이 떠 둔 행(${expected})과 달라 전부 취소했습니다 — 아무것도 바뀌지 않았습니다`);
      }
      await c.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM ${rel}), 1), (SELECT count(*) > 0 FROM ${rel}))`, [rel]);
      restored.push({ table, rows: count });
    }
    return { restored, safety };
  }));
}

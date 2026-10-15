// 앱 보관 표 — 목록 · 비우기 · 앱을 지울 때 함께 지우기(#4733).
//
// ── 왜 ───────────────────────────────────────────────────────────────────────────────────
//  앱 데이터를 말없이 잃지 않으려고 옮겨 둔 보관 표(archive-meta.ts 머리말)는 종전엔 앱을 지워도 남고 비울 도구가 없었다.
//  그런데 보관 표도 워크스페이스 표 개수 한도(store-schema 퓨즈 500)에 세어져, 한도에 걸리면 «쓰지 않는 앱을 제거하라» 는
//  안내를 따라도 풀리지 않았다. 그래서:
//   · 앱을 지우면 그 앱의 보관 표도 지우기 직전 백업(앱 데이터 백업 org_app_snapshot · 같은 묶음 · 7일)에 담고 지운다
//   · 관리자가 보관 표를 보고(app_archives) 비운다(app_archive_clear — 역시 백업 뒤)
//  되살리기(app_data_restore)는 보관 표를 되살리지 않는다(상민 2026-10-15 — 백업에만 남긴다 · app-snapshot.ts).
//  자동으로 지우는 기간은 두지 않는다(같은 결정 — 사람이 쓴 값을 모르는 사이에 지우지 않는다).
//
// ── 어디를 보나 ─────────────────────────────────────────────────────────────────────────────
//  이 워크스페이스가 만든 앱의 보관 자리 하나 — 매니지드 `app_<테넌트>_archive`, 단일 테넌트 `app_archive`.
//  기본 앱의 공유 보관 자리(매니지드 `app_archive` — 여러 워크스페이스의 행이 섞인다)는 보지도 지우지도 않는다.
//
// ── 어떻게 ────────────────────────────────────────────────────────────────────────────────
//  보관 표는 앱 DDL 역할(소유자)만 읽는다 — 런타임 역할의 권한은 보관할 때 걷었다(store-schema cleanupDroppedTables). 그래서
//   목록 · 행 읽기 · 지우기는 소유자 연결로, 백업 쓰기(org_app_snapshot — 본체 표)는 런타임 풀의 한 트랜잭션으로 한다
//   (되돌리기와 같은 나눔 — app-snapshot.ts 머리말). 백업이 끝까지 커밋된 뒤에만 지운다. 백업을 못 하면 지우지 않는다(force 제외).
//  지울 때 CASCADE 를 쓰지 않는다 — 지금 쓰는 표가 보관 표를 외래키로 가리키면 그 제약을 말없이 걷지 않고 «지우지 못함» 으로 남긴다.
import pg from "pg";
import { withTx } from "../db/client.js";
import { logger } from "../log.js";
import { archiveSchemaName } from "./store-ddl.js";
import { appSchemaFor, withOwnerConn } from "./store-schema.js";
import { snapshotMaxBytes, type SnapshotReason } from "./app-snapshot.js";
import { identifyArchive, archiveSnapshotTable, type ArchiveIdentity } from "./archive-meta.js";

type Q = pg.Pool | pg.PoolClient | pg.Client;
const qi = (n: string): string => { if (!/^[A-Za-z0-9_][A-Za-z0-9_$]*$/.test(n)) throw new Error(`unsafe ident: ${n}`); return `"${n}"`; };
const CHUNK = 1000;

export interface AppArchive extends ArchiveIdentity {
  /** 보관 자리 안의 표 이름(app_archive_clear 에 그대로 준다). */
  name: string;
  /** 표 크기(인덱스 · TOAST 포함). */
  bytes: number;
  columns: string[];
}

/** 이 워크스페이스의 보관 자리 — 워크스페이스가 만든 앱의 스키마 옆(기본 앱의 공유 자리가 아니다). */
export function workspaceArchiveSchema(): string {
  return archiveSchemaName(appSchemaFor(false));
}

/** 보관 자리의 표 전부 — 주인(기록 · 짐작 · 모름) · 종류 · 행 수 · 크기. 행 수는 기록이 있으면 기록(보관 표는 옮긴 뒤 아무도 안 쓴다), 없으면 센다. */
async function readArchives(db: Q, schema: string): Promise<AppArchive[]> {
  const r = await db.query(
    `SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment, pg_total_relation_size(c.oid)::bigint AS bytes,
            ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum) AS cols
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p')
      ORDER BY c.relname`, [schema]);
  const out: AppArchive[] = [];
  for (const row of r.rows) {
    const name = String(row.name);
    const columns = ((row.cols ?? []) as unknown[]).map(String);
    const id = identifyArchive(name, row.comment, columns);
    let rows = id.rows;
    if (rows == null) {
      rows = await db.query(`SELECT count(*)::bigint AS n FROM ${qi(schema)}.${qi(name)}`)
        .then((x) => Number(x.rows[0]?.n ?? 0))
        .catch((err) => { logger.warn({ err, schema, name }, "보관 표 행 수를 세지 못했다(목록엔 null)"); return null; });
    }
    out.push({ name, bytes: Number(row.bytes ?? 0), columns, ...id, rows });
  }
  return out;
}

/** 이 워크스페이스의 보관 표 목록. appId 를 주면 그 앱 것만(기록이 그 앱 · 기록이 없으면 이름 짐작이 그 앱). */
export async function listAppArchives(appId?: string | null): Promise<{ schema: string; archives: AppArchive[] }> {
  const schema = workspaceArchiveSchema();
  const archives = await withOwnerConn((db) => readArchives(db, schema));
  return { schema, archives: appId ? archives.filter((a) => a.app_id === appId) : archives };
}

export interface ClearArchivesOutcome {
  /** 지우기 직전 백업의 시각(app_data_snapshots 의 taken_at) — 백업 없이 지웠거나 아무것도 안 지웠으면 null. */
  taken_at: string | null;
  cleared: Array<{ name: string; app_id: string | null; rows: number | null }>;
  /** 지우지 않고 남긴 것과 그 까닭(백업 못 함 · 너무 큼 · 지우기 실패). */
  kept: Array<{ name: string; why: string }>;
  /** 보관 자리에 없는 이름 — 아무것도 하지 않았다. */
  missing: string[];
}

/**
 * 보관 표를 백업한 뒤 지운다. 보관 자리에 있는 이름만 — 목록을 카탈로그에서 다시 읽어 그 안에 있는 것만 지운다(지금 쓰는 표 ·
 *  다른 스키마의 표는 이름이 같아도 닿지 않는다). 백업은 한 트랜잭션(전부 담기거나 아무것도 안 담긴다) — 못 담으면 하나도 지우지 않는다.
 *  force 면 너무 크거나 백업이 실패해도 지운다(되살릴 길이 없다).
 */
export async function clearAppArchives(names: string[], opts: { reason: Extract<SnapshotReason, "before-remove" | "before-clear">; now?: Date; force?: boolean }): Promise<ClearArchivesOutcome> {
  const want = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  const out: ClearArchivesOutcome = { taken_at: null, cleared: [], kept: [], missing: [] };
  if (!want.length) return out;
  const schema = workspaceArchiveSchema();
  const now = opts.now ?? new Date();
  await withOwnerConn(async (db) => {
    const byName = new Map((await readArchives(db, schema)).map((a) => [a.name, a]));
    out.missing = want.filter((n) => !byName.has(n));
    const targets = want.filter((n) => byName.has(n)).map((n) => byName.get(n)!);
    if (!targets.length) return;
    const bytes = targets.reduce((n, a) => n + a.bytes, 0);
    const mb = (b: number): string => `${Math.round(b / 1024 / 1024)}MB`;
    let backupFailed: string | null = null;
    if (bytes > snapshotMaxBytes()) {
      backupFailed = `백업하기엔 너무 큽니다(${mb(bytes)} · 상한 ${mb(snapshotMaxBytes())}, LIVELY_APP_SNAPSHOT_MAX_BYTES)`;
    } else {
      try {
        await withTx(async (client) => { for (const a of targets) await backupArchive(db, client, schema, a, now, opts.reason); });
        out.taken_at = now.toISOString();
      } catch (err) {
        logger.warn({ err, schema, names: targets.map((a) => a.name) }, "보관 표 백업 실패 — 지우지 않는다");
        backupFailed = `백업하지 못했습니다(${(err as Error)?.message ?? err})`;
      }
    }
    if (backupFailed && !opts.force) {
      out.kept = targets.map((a) => ({ name: a.name, why: `${backupFailed} — 지우지 않았습니다(force 로 백업 없이 지울 수 있습니다)` }));
      return;
    }
    for (const a of targets) {
      try {
        await db.query(`DROP TABLE ${qi(schema)}.${qi(a.name)}`);
        out.cleared.push({ name: a.name, app_id: a.app_id, rows: a.rows });
      } catch (err) {
        logger.warn({ err, schema, name: a.name }, "보관 표를 지우지 못했다 — 그 자리에 둔다");
        out.kept.push({ name: a.name, why: `지우지 못했습니다 — ${(err as Error)?.message ?? err}` });
      }
    }
  });
  return out;
}

/** 보관 표 하나를 백업 묶음에 담는다(1,000행씩 — 읽기는 소유자 연결, 쓰기는 주어진 런타임 트랜잭션). 반환 = 담은 행 수. */
async function backupArchive(db: Q, client: pg.PoolClient, schema: string, a: AppArchive, now: Date, reason: SnapshotReason): Promise<number> {
  const rel = `${qi(schema)}.${qi(a.name)}`;
  const put = (chunk: number, n: number, rows: string): Promise<unknown> => client.query(
    `INSERT INTO org_app_snapshot(app_id, taken_at, table_name, chunk, reason, row_count, rows) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [a.app_id ?? "", now, archiveSnapshotTable(a.name), chunk, reason, n, rows]);
  //  id 가 없는 표(사람이 손으로 만든 것 등)는 한 묶음으로 — 크기는 위에서 상한을 봤다.
  if (!a.columns.includes("id")) {
    const r = (await db.query(`SELECT count(*)::int AS n, COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text AS rows FROM ${rel} t`)).rows[0];
    await put(0, Number(r?.n ?? 0), String(r?.rows ?? "[]"));
    return Number(r?.n ?? 0);
  }
  let last: string | null = null, chunk = 0, total = 0;
  for (;;) {
    const r: { last?: unknown; n?: unknown; rows?: unknown } | undefined = (await db.query(
      `WITH t AS (SELECT * FROM ${rel} WHERE $1::bigint IS NULL OR id > $1::bigint ORDER BY id LIMIT ${CHUNK})
       SELECT (SELECT max(id) FROM t)::text AS last, (SELECT count(*) FROM t)::int AS n,
              (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb) FROM t)::text AS rows`, [last])).rows[0];
    const n = Number(r?.n ?? 0);
    if (chunk === 0 || n > 0) await put(chunk, n, String(r?.rows ?? "[]"));
    total += n;
    if (n < CHUNK) break;
    last = String(r?.last);
    chunk++;
  }
  return total;
}

/**
 * 앱을 지울 때 — 그 앱의 보관 표를 지우기 직전 백업(앱 데이터 백업과 같은 시각 · 묶음)에 담고 지운다. 다른 앱 · 주인 모름은 그대로.
 *  기록이 있으면 기록을 따른다(이름이 이 앱처럼 보여도 기록이 다른 앱이면 닿지 않는다).
 */
export async function removeAppArchives(appId: string, now: Date): Promise<ClearArchivesOutcome> {
  const { archives } = await listAppArchives(appId);
  if (!archives.length) return { taken_at: null, cleared: [], kept: [], missing: [] };
  return clearAppArchives(archives.map((a) => a.name), { reason: "before-remove", now });
}

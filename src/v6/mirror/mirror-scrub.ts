// 미러 가림 배선(#5308) — 수집기 설정(org_collector.pii_scrub)을 미러 쓰기 · 소급 스윕 · 변경 이력에 잇는다.
//  규칙(무엇을 어떻게 가리나)은 org/ingest/content-scrub.ts 하나다. 이 파일은 «언제·어디에» 만 정한다.
//
//  ── 어디에 거나 ──
//   · 지식 미러(노션 등 · domain-wiki)와 자료 미러(슬랙 · 메일 · 리니어 …) — 읽기 전용 사본이다.
//   · ⚠ 클릭업 작업(project)·PM 계층에는 걸지 않는다. 그 미러는 **양방향**이다 — 사람이 라이블리에서 설명을 고치면
//     clickup-push 가 markdown_description 전문을 클릭업에 되쓴다. 가린 설명이 되쓰이면 **원본의 실제 연락처가 지워진다.**
//   · 미러 쓰기의 «원문» 은 원장(raw)까지다. 가림을 켜면 원장에서 내용 사본(노션 블록·댓글·속성 원문 · 슬랙 blocks)을 뺀다
//     — 조각으로 쪼개진 값은 글 단위로 못 가린다(content-scrub.minimizeRaw 주석).
//
//  ── 이미 모은 것(소급) ──
//   노션 «가속 전체 점검» 은 원장 시각이 같으면 페이지를 다시 내보내지 않는다(notion-post.observeNotionRows). 그래서 켜기만 해서는
//   바뀌지 않은 문서가 영영 그대로다. sweepScrubBacklog 가 DB 안에서 다시 가린다 — 외부 API 를 다시 부르지 않는다.
//   범위 = 이 수집기의 표식(sync_state.seen_by.<수집기>)이 있는 행 + 같은 외부 인스턴스에서 아무도 맡지 않은 행(수집 제외로 풀린 옛 행).
//   다른 수집기가 맡은 행은 건드리지 않는다(그 수집기의 설정이 있다).
//
//  ── 이력 ──
//   변경 이력(org_content_audit before/after)은 옛 본문 전문을 보여 주고 되돌리기까지 한다. 본문만 가리면 이력에서 값이 보이고
//   되돌리면 돌아온다. 그래서 가리지 않은 행을 처음 가릴 때 그 행의 이력 스냅샷도 같은 규칙으로 가린다(행·op·시각은 그대로).
//   ⚠ org_content_audit 를 UPDATE 하는 셋째 자리다(trash-store.purgeDeleted · session-footprint-store.blankAuditSnapshots 와 함께).
//    그 둘은 «내용을 비운다», 여기는 «내용을 가린 판으로 바꾼다» — 이력 화면이 그대로 읽힌다.
import type pg from "pg";
import { boundCollector } from "../../connectors/config.js";
import { redactDeep, redactString } from "../../org/ingest/redact.js";
import {
  CONTENT_SCRUB_VERSION, addScrubCounts, emptyScrubCounts, minimizeRaw, scrubDeep, scrubSnapshot, scrubText,
  totalScrubCounts, type ScrubCounts,
} from "../../org/ingest/content-scrub.js";
import { pgDeep, pgText } from "./mirror-common.js";

type PgRunner = pg.Pool | pg.PoolClient;

/** fields 에 남기는 가림 표시 — 값은 규칙 판. 소급 스윕이 «아직 이 판으로 안 가린 행» 을 이걸로 가른다. */
export const SCRUB_MARK_KEY = "_pii_scrub";
export const SCRUB_MARK = String(CONTENT_SCRUB_VERSION);

/** 지금 바인딩된 수집기가 가림을 켰나. 바인딩이 없으면(레거시 경로·수동 적재) 끔 — 종전 동작. */
export function scrubOn(): boolean {
  return boundCollector()?.piiScrub === true;
}

// ── 이번 프로세스(싱크 run 하나)에서 미러가 가린 건수 — run-sync 가 요약 줄에 싣는다. ──
//  제목·본문만 센다 — fields·raw 는 같은 값의 사본이라 세면 같은 비밀번호가 세 번 잡힌다.
const runMasks = emptyScrubCounts();
let runRows = 0;
export function mirrorScrubStats(): { rows: number; masks: ScrubCounts } {
  return { rows: runRows, masks: { ...runMasks } };
}

/** 미러 한 건의 가림 도구 — 켜짐 여부를 한 번 읽어 들고 다닌다(항목마다 설정이 바뀌지 않는다). */
export interface MirrorGuard {
  readonly on: boolean;
  /** 제목·본문 — redact(토큰 모양) 뒤에 가림. count=true 면 이번 run 건수에 센다. */
  text(s: string, count?: boolean): string;
  /** fields — 키를 보고 가린다. */
  deep<T>(v: T): T;
  /** raw — 내용 사본을 빼고 가린다. */
  raw(v: unknown): unknown;
  /** fields 에 덧붙일 표시({} 또는 {_pii_scrub}). */
  readonly mark: Record<string, string>;
  /** 직전 행의 글(감사 before 스냅샷용) — 켜졌으면 가린 판으로(새 이력 행이 옛 값을 다시 싣지 않게). */
  prev(s: string | null): string | null;
  /** 직전 행이 이 판으로 가려지지 않았나(그 행의 옛 이력도 가려야 하나). */
  prevUnscrubbed(prevMark: unknown): boolean;
  /** 항목 하나를 다 쓴 뒤 — 이번 항목에서 가린 게 있으면 run 건수에 더한다. */
  done(): void;
}

export function mirrorGuard(system: string): MirrorGuard {
  const on = scrubOn();
  const item = emptyScrubCounts();
  return {
    on,
    text: (s, count) => (on ? scrubText(redactString(s), count ? item : undefined) : redactString(s)),
    deep: <T>(v: T): T => (on ? scrubDeep(redactDeep(v)) : redactDeep(v)),
    raw: (v) => (on ? scrubDeep(minimizeRaw(system, redactDeep(v))) : redactDeep(v)),
    mark: on ? { [SCRUB_MARK_KEY]: SCRUB_MARK } : {},
    prev: (s) => (on && s ? scrubText(s) : s),
    prevUnscrubbed: (prevMark) => on && prevMark !== SCRUB_MARK,
    done: () => {
      if (!on || totalScrubCounts(item) === 0) return;
      runRows++;
      addScrubCounts(runMasks, item);
    },
  };
}

/**
 * 한 대상(지식 name · 자료 id)의 변경 이력 스냅샷을 같은 규칙으로 가린다. 바뀐 이력 행 수를 돌려준다.
 *  before/after 의 글 칸(title·body_md·description·summary)만 — op·시각·누가는 그대로다.
 */
export async function scrubAuditHistory(db: PgRunner, entity: "knowledge" | "source", keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  const r = await db.query(
    `SELECT id, before, after FROM org_content_audit
      WHERE entity = $1 AND entity_key = ANY($2::text[]) AND (before IS NOT NULL OR after IS NOT NULL)`,
    [entity, keys]);
  let n = 0;
  for (const row of r.rows as Array<{ id: string | number; before: unknown; after: unknown }>) {
    const b = scrubSnapshot(row.before), a = scrubSnapshot(row.after);
    if (!b.changed && !a.changed) continue;
    await db.query(
      `UPDATE org_content_audit SET before = $2::jsonb, after = $3::jsonb WHERE id = $1`,
      [row.id, b.value == null ? null : JSON.stringify(pgDeep(b.value)), a.value == null ? null : JSON.stringify(pgDeep(a.value))]);
    n++;
  }
  return n;
}

// ════════════════════════════════════════════════════════════════════════════
// ── 소급 스윕 — 이미 모은 행을 DB 안에서 다시 가린다 ──
// ════════════════════════════════════════════════════════════════════════════

export interface ScrubBacklogResult {
  knowledge: number;          // 이번에 가린(표시를 단) 지식 행
  source: number;             // 이번에 가린 자료 행
  audit: number;              // 가린 이력 행
  remaining: number;          // 아직 남은 행(시간 상한에 걸렸을 때 다음 run 이 잇는다)
  masks: ScrubCounts;         // 제목·본문에서 가린 건수
  stopped: "done" | "budget";
}

type Table = "knowledge" | "source";
const KEY_COL: Record<Table, string> = { knowledge: "name", source: "id" };

/** 이 수집기가 맡은 행이 있는 (외부 시스템, 인스턴스) 짝 — «같은 인스턴스의 주인 없는 행» 을 가르는 데 쓴다. */
async function claimedInstances(db: PgRunner, table: Table, claimKey: string): Promise<{ systems: string[]; instances: string[] }> {
  const r = await db.query(
    `SELECT DISTINCT external_system, external_instance FROM ${table}
      WHERE external_id IS NOT NULL AND (sync_state->'seen_by') ? $1::text`, [claimKey]);
  const rows = r.rows as Array<{ external_system: string; external_instance: string }>;
  return { systems: rows.map((x) => x.external_system), instances: rows.map((x) => x.external_instance) };
}

//  대상 행 — 외부 미러(observed · external_id)만. 사람이 쓴 지식·자료는 수집기의 것이 아니다.
function pendingWhere(table: Table): string {
  return `${table}.external_id IS NOT NULL AND ${table}.provenance = 'observed'
      AND (${table}.fields->>'${SCRUB_MARK_KEY}') IS DISTINCT FROM $1::text
      AND ((${table}.sync_state->'seen_by') ? $2::text
           OR (COALESCE(${table}.sync_state->'seen_by', '{}'::jsonb) = '{}'::jsonb
               AND (${table}.external_system, ${table}.external_instance) IN (SELECT * FROM unnest($3::text[], $4::text[]))))`;
}

async function countPending(db: PgRunner, table: Table, claimKey: string, inst: { systems: string[]; instances: string[] }): Promise<number> {
  if (!inst.systems.length) return 0;
  const r = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${pendingWhere(table)}`,
    [SCRUB_MARK, claimKey, inst.systems, inst.instances]);
  return Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
}

/**
 * 이 수집기(claimKey)가 맡은 행 중 아직 이 판으로 안 가린 것을 가린다. 시간 상한(budgetMs)까지만 — 남으면 다음 run 이 잇는다.
 *  묶음마다 한 트랜잭션(행 잠금 FOR UPDATE SKIP LOCKED — 같은 행을 동시에 쓰는 미러와 엇갈리지 않게).
 *  지식은 제목·본문이 바뀌면 임베딩을 비우고 updated_at 을 올린다(낱말 색인·조각이 다시 만든다 — 옛 본문의 조각이 남지 않게).
 *  자료는 updated_at 을 올리지 않는다 — 그건 증류 인박스의 «내용이 바뀌었다» 신호라(#1289), 올리면 전량을 다시 증류한다.
 */
export async function sweepScrubBacklog(
  pool: pg.Pool, opts: { claimKey: string; budgetMs?: number; batch?: number },
): Promise<ScrubBacklogResult> {
  const budgetMs = opts.budgetMs ?? 180_000;
  const batch = Math.max(1, Math.min(opts.batch ?? 200, 1000));
  const t0 = Date.now();
  const res: ScrubBacklogResult = { knowledge: 0, source: 0, audit: 0, remaining: 0, masks: emptyScrubCounts(), stopped: "done" };
  const insts: Partial<Record<Table, { systems: string[]; instances: string[] }>> = {};

  for (const table of ["knowledge", "source"] as const) {
    const inst = await claimedInstances(pool, table, opts.claimKey);
    insts[table] = inst;
    if (!inst.systems.length) continue;                    // 이 수집기가 이 표에 남긴 행이 아직 없다
    for (;;) {
      if (Date.now() - t0 >= budgetMs) { res.stopped = "budget"; break; }
      const client = await pool.connect();
      let n = 0;
      try {
        await client.query("BEGIN");
        const rows = (await client.query(
          `SELECT ${KEY_COL[table]}::text AS key, title, body_md, fields, raw, external_system FROM ${table}
            WHERE ${pendingWhere(table)} ORDER BY ${KEY_COL[table]} LIMIT $5 FOR UPDATE SKIP LOCKED`,
          [SCRUB_MARK, opts.claimKey, inst.systems, inst.instances, batch])).rows as Array<{
            key: string; title: string | null; body_md: string | null; fields: Record<string, unknown> | null;
            raw: unknown; external_system: string | null }>;
        n = rows.length;
        const keys: string[] = [];
        for (const row of rows) {
          const title = row.title == null ? null : pgText(scrubText(row.title, res.masks));
          const body = pgText(scrubText(row.body_md ?? "", res.masks));
          const fields = { ...(pgDeep(scrubDeep(row.fields ?? {})) as Record<string, unknown>), [SCRUB_MARK_KEY]: SCRUB_MARK };
          const raw = row.raw == null ? null : pgDeep(scrubDeep(minimizeRaw(String(row.external_system ?? ""), row.raw)));
          const textChanged = title !== row.title || body !== (row.body_md ?? "");
          if (table === "knowledge") {
            await client.query(
              `UPDATE knowledge SET title=$2, body_md=$3, fields=$4::jsonb, raw=$5::jsonb,
                      embedding_vector     = CASE WHEN $6::boolean THEN NULL ELSE embedding_vector END,
                      embedding_model      = CASE WHEN $6::boolean THEN NULL ELSE embedding_model END,
                      embedding_updated_at = CASE WHEN $6::boolean THEN NULL ELSE embedding_updated_at END,
                      updated_at = CASE WHEN $6::boolean THEN now() ELSE updated_at END,
                      version    = CASE WHEN $6::boolean THEN version + 1 ELSE version END
                WHERE name = $1`,
              [row.key, title, body, JSON.stringify(fields), raw == null ? null : JSON.stringify(raw), textChanged]);
            res.knowledge++;
          } else {
            await client.query(
              `UPDATE source SET title=$2, body_md=$3, fields=$4::jsonb, raw=$5::jsonb WHERE id = $1::int`,
              [row.key, title, body, JSON.stringify(fields), raw == null ? null : JSON.stringify(raw)]);
            res.source++;
          }
          keys.push(row.key);
        }
        res.audit += await scrubAuditHistory(client, table, keys);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      if (n < batch) break;                                // 마지막 묶음
    }
    if (res.stopped === "budget") break;
  }
  for (const table of ["knowledge", "source"] as const) {
    const inst = insts[table] ?? await claimedInstances(pool, table, opts.claimKey);
    res.remaining += await countPending(pool, table, opts.claimKey, inst);
  }
  return res;
}

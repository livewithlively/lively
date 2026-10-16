// 수집 실행의 저장 단계(#4213 T11) — 끝난 목록·수집 실행의 원문을 T10 수집 단위 표로 넣는다. 셈(풀기·나누기)은 collect-plan ·
//  connector-parse 가 하고, 여기는 T10 함수만 부른다(recordUnitListing · storeUnitItems · advanceUnitCursor).
//
//  · 목록 — 그 사람 커넥터가 돌려준 목록이라 verified:true(볼 수 있는 구성원이 된다). 새 단위는 «후보» 로 선다(모을지는 리브·사람이 정한다).
//  · 수집 — 단위마다 그 그릇의 항목만 넣고(요청 안 한 채널의 글은 버린다), 끝까지 읽은 단위만 읽은 위치를 옮긴다.
//    이 판이 아예 안 읽은 단위는 읽은 시각도 옮기지 않는다(다음 판이 다시 맡는다).
//  · 던지지 않는다 — 결과(무엇을 넣었나 · 왜 못 넣었나)를 돌려주고, 호출부가 실행 기록(collect_run.ingest)에 남긴다.
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import { readCapture, type Capture, type CaptureFile } from "./connector-parse.js";
import { CLAUDE_COLLECT_APPS, harvestListing, harvestUnits, type PlannedUnit } from "./collect-plan.js";
import { advanceUnitCursor, recordUnitListing, storeUnitItems } from "./unit-store.js";

export interface IngestPlan {
  mode: "listing" | "collect";
  /** 목록 실행의 앱(slack · notion · gmail). */
  app?: string;
  /** 수집 실행의 단위들. */
  units?: PlannedUnit[];
}

export interface IngestUnitResult {
  id: number; app: string; ref: string; reads: number; items: number;
  stored: number; inserted: number; conflicts: number; failed: number; unparsed: number;
  complete: boolean; cursor_moved: boolean; reason?: string;
}

export interface IngestResult {
  state: "done" | "failed";
  mode: "listing" | "collect";
  error?: string;
  /** 원문 파일 중 읽은 것 · 앞에서 잘렸나(읽기 상한). */
  captures: number; truncated: boolean;
  /** 목록: 올린 단위 수 · 새로 생긴 단위 수 · 전부였나. */
  listed?: number; created?: number; complete?: boolean; instance?: string;
  /** 수집: 단위별 결과와 합계. */
  units?: number; stored?: number; inserted?: number; stray?: number;
  per_unit?: IngestUnitResult[];
}

/**
 * 슬랙·노션 단위의 인스턴스(팀·워크스페이스) — claude.ai 커넥터 결과에는 팀 id 가 없다(맥 실측: 목록·채널·프로필 어디에도).
 *  기존 수집기·단위가 쓰는 값과 같아야 같은 글이 합쳐지므로, 이 워크스페이스가 이미 아는 값에서 고른다:
 *  ① 같은 ref 를 가진 기존 단위의 인스턴스(가장 많은 쪽) ② 그 앱의 인스턴스가 하나뿐이면 그것 ③ 모르면 빈 값.
 */
export async function resolveInstance(app: string, refs: readonly string[]): Promise<string> {
  if (app === "gmail") return "default";
  try {
    if (refs.length) {
      const r = await itemsPool.query(
        `SELECT instance, count(*)::int AS n FROM collect_unit WHERE app = $1 AND ref = ANY($2::text[]) AND instance <> ''
          GROUP BY instance ORDER BY n DESC LIMIT 1`, [app, [...refs].slice(0, 5000)]);
      if (r.rows[0]?.instance) return String(r.rows[0].instance);
    }
    const r2 = await itemsPool.query(
      `SELECT DISTINCT instance FROM (
         SELECT instance FROM collect_unit WHERE app = $1 AND instance <> ''
         UNION SELECT external_instance AS instance FROM source WHERE external_system = $1 AND COALESCE(external_instance, '') <> ''
       ) x LIMIT 3`, [app]);
    if (r2.rows.length === 1) return String(r2.rows[0].instance);
  } catch (e) {
    logger.warn({ app, err: (e as Error)?.message }, "[collect-ingest] 인스턴스를 못 정했다 — 빈 값으로");
  }
  return "";
}

const capturesOf = (files: readonly CaptureFile[]): Capture[] =>
  files.map((f) => readCapture(f)).filter((c): c is Capture => !!c);

/** 목록 실행 → recordUnitListing(verified:true). */
async function ingestListing(member: string, app: string, caps: Capture[]): Promise<Omit<IngestResult, "captures" | "truncated">> {
  const connector = CLAUDE_COLLECT_APPS[app];
  if (!connector) return { state: "failed", mode: "listing", error: `목록을 모르는 앱: ${app}` };
  const h = harvestListing(caps, app);
  if (!h.calls) return { state: "failed", mode: "listing", error: "목록 도구를 부르지 않았다" };
  if (!h.units.length) return { state: h.unparsed ? "failed" : "done", mode: "listing", listed: 0, created: 0, complete: false, ...(h.unparsed ? { error: "목록 결과를 풀지 못했다(형식이 바뀌었을 수 있다)" } : {}) };
  const instance = await resolveInstance(app, h.units.map((u) => u.ref));
  const r = await recordUnitListing({ member, app, connector, instance, items: h.units, complete: h.complete, verified: true }, { actor: member, source: "collect-run" });
  return { state: "done", mode: "listing", listed: h.units.length, created: r.created, complete: h.complete && !r.complete_ignored, instance };
}

/** 수집 실행 → 단위마다 storeUnitItems · advanceUnitCursor. */
async function ingestCollect(member: string, units: PlannedUnit[], caps: Capture[], now: number): Promise<Omit<IngestResult, "captures" | "truncated">> {
  if (!units.length) return { state: "failed", mode: "collect", error: "계획에 단위가 없다" };
  const { byUnit, stray } = harvestUnits(caps, units);
  const per: IngestUnitResult[] = [];
  let stored = 0, inserted = 0;
  for (const u of units) {
    const h = byUnit.get(u.id)!;
    const row: IngestUnitResult = {
      id: u.id, app: u.app, ref: u.ref, reads: h.reads, items: h.items.length,
      stored: 0, inserted: 0, conflicts: 0, failed: 0, unparsed: h.unparsed, complete: h.complete, cursor_moved: false,
    };
    if (!h.reads) { row.reason = "이 판이 읽지 않음"; per.push(row); continue; }
    try {
      if (h.items.length) {
        const r = await storeUnitItems(u.id, h.items, { member });
        row.stored = r.stored; row.inserted = r.inserted; row.conflicts = r.conflicts; row.failed = r.failed;
        stored += r.stored; inserted += r.inserted;
      }
      //  읽기는 했다 → 읽은 시각은 옮긴다. 위치는 끝까지 읽었고 새 것이 있을 때만(collect-plan 규칙). 담당이 바뀌었으면 거절된다(해 없음).
      const a = await advanceUnitCursor(u.id, { member }, { cursor: h.nextCursor, readAt: new Date(now), lastItemAt: h.lastItemAt });
      row.cursor_moved = a.ok && h.nextCursor != null;
      if (!a.ok) row.reason = a.reason;
    } catch (e) {
      row.reason = String((e as Error)?.message ?? e).slice(0, 200);
      logger.warn({ unitId: u.id, member, err: row.reason }, "[collect-ingest] 단위 저장 실패 — 다음 판이 같은 위치부터 다시 읽는다");
    }
    per.push(row);
  }
  const anyRead = per.some((p) => p.reads > 0);
  return {
    state: anyRead ? "done" : "failed", mode: "collect", units: units.length, stored, inserted, stray, per_unit: per,
    ...(anyRead ? {} : { error: "맡긴 단위를 하나도 읽지 않았다" }),
  };
}

/** 끝난 실행 하나의 저장 단계. 던지지 않는다. */
export async function ingestRun(input: {
  member: string; plan: IngestPlan; files: readonly CaptureFile[]; truncated?: boolean; now?: number;
}): Promise<IngestResult> {
  const caps = capturesOf(input.files);
  const base = { captures: caps.length, truncated: input.truncated === true };
  try {
    if (input.plan.mode === "listing") return { ...base, ...(await ingestListing(input.member, String(input.plan.app ?? ""), caps)) };
    return { ...base, ...(await ingestCollect(input.member, input.plan.units ?? [], caps, input.now ?? Date.now())) };
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 300);
    logger.warn({ member: input.member, mode: input.plan.mode, err: error }, "[collect-ingest] 저장 단계 실패");
    return { ...base, state: "failed", mode: input.plan.mode, error };
  }
}

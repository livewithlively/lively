// 슬랙 다리(#1782) — 행 읽고 쓰기만 한다. 판정은 plan.ts · 흐름은 manager.ts.
//  ⚠ 모든 조회는 요청 · 정비 컨텍스트(RLS)의 테넌트로 좁혀진다 — 연결의 이벤트 처리도 그 연결을 연 테넌트로 감싸서 부른다(manager.ts).
import { itemsPool } from "../../db/client.js";
import type { BridgeInput, BridgeRow, BridgeStatus, TokenRef } from "./plan.js";

import { HttpError } from "../../http-error.js";

const BASE_COLS = `id, app_id, route, enabled, app_token_ref, bot_token_ref, events, channels, bot_messages, bot_ids, run_as, react, note, status, created_at, updated_at, updated_by`;
//  run_as_human(#1792)은 뒤에 더한 칸이다. ★ 매니지드 롤은 새 게이트웨이를 먼저 띄우고 공용 DB 마이그레이션을 맨 끝에 돌린다
//   (roll-order-migrate-after-gw-swap-auth-outage-2026-10-20) — 그 몇 분(롤 창) 동안 이 칸은 아직 없다(42703). 칸 묶음에만 두면 그동안 다리
//   조회 · 맞추기(30초마다 · 워크스페이스마다)가 모두 실패해, 새 게이트웨이가 슬랙 연결을 하나도 붙이지 못한다. 그래서 칸이 없으면 없는 것(false)으로
//   읽고, 저장은 그 값이 false 일 때만 칸 없이 적는다 — 칸이 없으면 그 칸을 켠 행도 있을 수 없으니 그 답이 맞다(agent-jobs/store.ts SHARED_SEAT_COL 과 같은 까닭).
const COLS = `${BASE_COLS}, run_as_human`;
const undefinedColumn = (e: unknown): boolean => (e as { code?: string })?.code === "42703";
/** 다리 행 읽기 — run_as_human 칸이 아직 없으면(롤 창) 그 칸 없이 다시 읽는다(norm 이 false 로 채운다). */
async function readBridges(tail: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  try {
    return (await itemsPool.query(`SELECT ${COLS} FROM org_slack_bridge ${tail}`, params)).rows as Record<string, unknown>[];
  } catch (e) {
    if (!undefinedColumn(e)) throw e;
    return (await itemsPool.query(`SELECT ${BASE_COLS} FROM org_slack_bridge ${tail}`, params)).rows as Record<string, unknown>[];
  }
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);
const refOf = (v: unknown): TokenRef => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { owner: String(o.owner ?? "gateway"), kind: String(o.kind ?? ""), scope_key: String(o.scope_key ?? "") };
};
function norm(r: Record<string, unknown>): BridgeRow {
  return {
    id: String(r.id), app_id: String(r.app_id), route: String(r.route), enabled: r.enabled === true,
    app_token_ref: refOf(r.app_token_ref), bot_token_ref: refOf(r.bot_token_ref),
    events: Array.isArray(r.events) ? (r.events as unknown[]).map(String) : [],
    channels: Array.isArray(r.channels) ? (r.channels as unknown[]).map(String) : [],
    bot_messages: r.bot_messages === true, bot_ids: Array.isArray(r.bot_ids) ? (r.bot_ids as unknown[]).map(String) : [],
    run_as: (r.run_as as string | null) ?? null, run_as_human: r.run_as_human === true, react: (r.react as string | null) ?? null,
    note: (r.note as string | null) ?? null, status: (r.status && typeof r.status === "object" ? r.status : {}) as BridgeStatus,
    created_at: iso(r.created_at), updated_at: iso(r.updated_at), updated_by: (r.updated_by as string | null) ?? null,
  };
}

export async function listBridges(o: { enabledOnly?: boolean } = {}): Promise<BridgeRow[]> {
  return (await readBridges(`${o.enabledOnly ? "WHERE enabled" : ""} ORDER BY id`)).map(norm);
}

export async function getBridge(id: string): Promise<BridgeRow | null> {
  const row = (await readBridges(`WHERE id=$1`, [id]))[0];
  return row ? norm(row) : null;
}

/** 저장 — 있으면 고치고(상태는 그대로) 없으면 만든다. run_as_human 칸이 아직 없으면(롤 창 — 위 COLS 머리말) 그 값이 false 일 때만 칸 없이 적는다. */
export async function upsertBridge(b: BridgeInput, actor: string): Promise<BridgeRow> {
  const base = [b.id, b.app_id, b.route, b.enabled, JSON.stringify(b.app_token_ref), JSON.stringify(b.bot_token_ref), b.events, b.channels, b.bot_messages,
    b.bot_ids, b.run_as, b.react, b.note, actor];
  const sql = (human: boolean): string =>
    `INSERT INTO org_slack_bridge(id, app_id, route, enabled, app_token_ref, bot_token_ref, events, channels, bot_messages, bot_ids, run_as, react, note, updated_at, updated_by${human ? ", run_as_human" : ""})
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::text[],$8::text[],$9,$10::text[],$11,$12,$13,now(),$14${human ? ",$15" : ""})
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       app_id=EXCLUDED.app_id, route=EXCLUDED.route, enabled=EXCLUDED.enabled, app_token_ref=EXCLUDED.app_token_ref, bot_token_ref=EXCLUDED.bot_token_ref,
       events=EXCLUDED.events, channels=EXCLUDED.channels, bot_messages=EXCLUDED.bot_messages, bot_ids=EXCLUDED.bot_ids, run_as=EXCLUDED.run_as,
       ${human ? "run_as_human=EXCLUDED.run_as_human, " : ""}react=EXCLUDED.react, note=EXCLUDED.note, updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING ${human ? COLS : BASE_COLS}`;
  try {
    const r = await itemsPool.query(sql(true), [...base, b.run_as_human]);
    return norm(r.rows[0] as Record<string, unknown>);
  } catch (e) {
    if (!undefinedColumn(e)) throw e;
    //  켜려는 저장은 칸 없이 적으면 조용히 꺼진 채로 남는다 — 적지 않고 까닭을 말한다(마이그레이션이 끝나면 된다).
    if (b.run_as_human) throw new HttpError(503, "지금은 run_as_human 을 저장할 수 없습니다(배포 중 — 새 칸이 아직 없습니다). 몇 분 뒤 다시 저장하세요");
    const r = await itemsPool.query(sql(false), base);
    return norm(r.rows[0] as Record<string, unknown>);
  }
}

/** 지운다 — 한 번만 넘기기 열쇠도 함께(같은 id 로 새 다리를 만들면 처음부터 받는다). 호출 기록은 보존 기간까지 남긴다(누가 무엇을 불렀나). */
export async function removeBridge(id: string): Promise<boolean> {
  const r = await itemsPool.query(`DELETE FROM org_slack_bridge WHERE id=$1`, [id]);
  await itemsPool.query(`DELETE FROM org_slack_bridge_event WHERE bridge_id=$1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/** 연결 상태 — 연결을 쥔 게이트웨이가 적는다(그 다리가 그새 지워졌으면 아무것도 안 한다). */
export async function saveBridgeStatus(id: string, status: BridgeStatus): Promise<void> {
  await itemsPool.query(`UPDATE org_slack_bridge SET status=$2::jsonb WHERE id=$1`, [id, JSON.stringify(status)]);
}

/**
 * 한 번만 넘기기 — 이 열쇠를 처음 적은 쪽만 true. 같은 이벤트를 다시 받거나(슬랙 재전송 · 다시 연결) 게이트웨이 둘이 같은 다리를 쥐어도 작업은 하나다.
 */
export async function claimBridgeEvent(bridgeId: string, key: string, kind: string): Promise<boolean> {
  const r = await itemsPool.query(
    `INSERT INTO org_slack_bridge_event(bridge_id, event_key, kind) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, bridge_id, event_key) DO NOTHING RETURNING id`,
    [bridgeId, key, kind]);
  return (r.rowCount ?? 0) > 0;
}

/** 넘긴 결과(forwarded · filtered:<까닭> · failed:<까닭>)와 시작한 작업 번호를 그 열쇠에 남긴다. */
export async function markBridgeEvent(bridgeId: string, key: string, outcome: string, jobId: number | null = null): Promise<void> {
  await itemsPool.query(`UPDATE org_slack_bridge_event SET outcome=$3, job_id=$4 WHERE bridge_id=$1 AND event_key=$2`, [bridgeId, key, outcome.slice(0, 300), jobId]);
}

export interface BridgeCallRecord {
  bridge_id: string; app_id: string; member: string | null; job_id: number | null; method: string;
  channel: string | null; ts: string | null; ok: boolean; error: string | null;
}
/** 앱이 다리로 슬랙을 부른 기록 — 메서드 · 채널 · ts · 결과만(보낸 글은 적지 않는다). */
export async function logBridgeCall(c: BridgeCallRecord): Promise<void> {
  await itemsPool.query(
    `INSERT INTO org_slack_bridge_call(bridge_id, app_id, member, job_id, method, channel, ts, ok, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [c.bridge_id, c.app_id, c.member, c.job_id, c.method, c.channel, c.ts, c.ok, c.error ? c.error.slice(0, 300) : null]);
}

export async function recentBridgeCalls(bridgeId: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  const r = await itemsPool.query(
    `SELECT id, app_id, member, job_id, method, channel, ts, ok, error, at FROM org_slack_bridge_call WHERE bridge_id=$1 ORDER BY id DESC LIMIT $2`,
    [bridgeId, Math.max(1, Math.min(100, limit))]);
  return (r.rows as Record<string, unknown>[]).map((x) => ({ ...x, id: Number(x.id), job_id: x.job_id == null ? null : Number(x.job_id), at: iso(x.at) }));
}

/** 보존 — 한 번만 넘기기 열쇠는 7일(슬랙 재전송은 길어야 몇 분이다), 호출 기록은 30일. 지운 수. */
export async function pruneBridgeRecords(eventDays = 7, callDays = 30): Promise<{ events: number; calls: number }> {
  const e = await itemsPool.query(`DELETE FROM org_slack_bridge_event WHERE received_at < now() - make_interval(days => $1::int)`, [eventDays]);
  const c = await itemsPool.query(`DELETE FROM org_slack_bridge_call WHERE at < now() - make_interval(days => $1::int)`, [callDays]);
  return { events: e.rowCount ?? 0, calls: c.rowCount ?? 0 };
}

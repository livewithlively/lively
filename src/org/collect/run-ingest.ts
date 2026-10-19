// 수집 실행의 저장 단계(#4213 T11) — 끝난 목록·수집 실행의 원문을 T10 수집 단위 표로 넣는다. 셈(풀기·나누기·위치)은 collect-plan ·
//  connector-parse 가 하고, 여기는 T10 함수만 부른다(recordUnitListing · storeUnitItems · advanceUnitCursor).
//
//  · 목록 — 그 사람 커넥터가 돌려준 목록이라 verified:true(볼 수 있는 구성원이 된다). 새 단위는 «후보» 로 선다(모을지는 리브·사람이 정한다).
//    «전부» 는 그 사람의 via-listing 자리를 정리하므로 팀(인스턴스)을 확실히 알 때만 넘긴다.
//  · 수집 — 단위마다 그 그릇의 항목만 넣고(요청 안 한 채널의 글은 버린다), 위치는 collect-plan 이 정한 대로 옮긴다(«다 읽었다» 의 증거가
//    다 있을 때만 앞으로 · 못 다 읽었으면 시작점 그대로 + 구간 줄이기). 원문이 잘렸거나 항목 저장이 실패한 판은 위치를 아예 건드리지 않는다.
//    이 판이 아예 안 읽은 단위는 읽은 시각도 옮기지 않는다(다음 판이 다시 맡는다).
//  · 던지지 않는다 — 결과(무엇을 넣었나 · 왜 못 넣었나)를 돌려주고, 호출부가 실행 기록(collect_run.ingest)에 남긴다.
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import { redactString } from "../ingest/redact.js";
import { readCapture, type Capture, type CaptureFile } from "./connector-parse.js";
import {
  CLAUDE_COLLECT_APPS, harvestListing, harvestUnits, judgeProof, readNoteOf, validUnitRef, type CollectPlan, type PlannedLink, type PlannedUnit,
} from "./collect-plan.js";
import { canonicalCoord, normalizeListing } from "./unit-plan.js";
import { extractAppLinks, linkKey } from "./link-plan.js";
import { recordLinks, storeLinkedReads, type LinkedStoreResult } from "./link-store.js";
import { advanceUnitCursor, recordUnitListing, storeUnitItems } from "./unit-store.js";
import {
  dropStaleProofs, guardsByUnitId, recordProofResult, requestProof, storedBodies, unitGuards, verifyByProof, type ProofResult,
} from "./unit-proof.js";
import { noteUnitRead, type UnitReadBy } from "./unit-schedule.js";
import type { ReadNote } from "./schedule-plan.js";

/** #4744 단위 하나의 다음 확인을 적고 실행 기록에 남길 모양으로 — 지금 담당의 판만 쓴다 · 못 적었으면 null(던지지 않는다). */
async function scheduleNote(unitId: number, note: ReadNote, now: number, by: UnitReadBy): Promise<IngestUnitResult["next"]> {
  const r = await noteUnitRead(unitId, { ...note, now }, by);
  return r ? { at: r.next_at, why: r.why, interval_sec: r.interval_sec } : null;
}

export type IngestPlan = CollectPlan;

/** 실행 기록에서 읽은 계획 → 저장 단계의 계획(모양이 틀리면 null — 남의 칸을 믿지 않는다). */
export function toIngestPlan(mode: unknown, raw: unknown): IngestPlan | null {
  if (mode !== "listing" && mode !== "collect") return null;
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (mode === "listing") return typeof p.app === "string" && CLAUDE_COLLECT_APPS[p.app] ? { mode, app: p.app } : null;
  const units = Array.isArray(p.units) ? p.units.filter((u): u is PlannedUnit => {
    const x = u as Record<string, unknown>;
    return !!x && Number.isInteger(x.id) && typeof x.app === "string" && typeof x.ref === "string" && validUnitRef(x.app, x.ref)
      && typeof x.instance === "string" && (x.since == null || typeof x.since === "string");
  }).map((u) => ({ ...u, proof: (u as { proof?: unknown }).proof === true })) : [];
  //  #4744 이 판에 실은 링크 — 모양이 맞는 것만(노션 uuid · 슬랙 채널 + 스레드 ts).
  const links = Array.isArray(p.links) ? p.links.filter((l): l is PlannedLink => {
    const x = l as Record<string, unknown>;
    if (!x || !Number.isInteger(x.id) || typeof x.ref !== "string") return false;
    if (x.app === "notion") return /^[0-9a-f-]{36}$/.test(x.ref);
    return x.app === "slack" && typeof x.channel === "string" && typeof x.thread === "string";
  }) : [];
  return {
    mode, units, ...(typeof p.planned_at === "number" && Number.isFinite(p.planned_at) ? { planned_at: p.planned_at } : {}),
    ...(links.length ? { links } : {}),
  };
}

export interface IngestUnitResult {
  id: number; app: string; ref: string; reads: number; items: number;
  stored: number; inserted: number; conflicts: number; failed: number; unparsed: number;
  complete: boolean; cursor_moved: boolean; window_shrunk: boolean; stuck: boolean; reason?: string;
  /** #4744 다음 확인 — 언제 · 왜(interval 주기 뒤 · catchup 곧바로 · retry 물러섬) · 그때의 주기. 못 적었으면 없다. */
  next?: { at: string; why: string; interval_sec: number } | null;
  /** 확인 읽기 결과(확인 읽기 단위) · held = 확인 안 된 사람이 맡은 보호 단위라 넣지 않고 확인 대기만 걸었다. */
  proof?: ProofResult | "held";
}

export interface IngestResult {
  state: "done" | "failed";
  mode: "listing" | "collect";
  error?: string;
  /** 원문 파일 중 읽은 것 · 앞에서 잘렸나(읽기 상한). */
  captures: number; truncated: boolean;
  /** 목록: 올린 단위 수 · 새로 생긴 단위 수 · 받지 않은 수(남의 메일함 등) · 전부였나 · 인스턴스. */
  listed?: number; created?: number; refused?: number; complete?: boolean; instance?: string;
  /** 목록: 보호 단위라 확인 대기로 둔 수 · 수집: 확인 읽기 통과·실패 수 · 확인 대기로 미룬 맡은 단위 수. */
  proof_pending?: number; proof_passed?: number; proof_failed?: number; proof_held?: number;
  /** 수집: 단위별 결과와 합계. partial — 못 다 읽은 단위 · 못 푼 결과 · 저장 실패가 하나라도 있다(화면이 «확인 필요» 로 보인다). */
  units?: number; stored?: number; inserted?: number; stray?: number; unparsed?: number; failed?: number; incomplete?: number;
  /** 맡겼는데 이 판이 안 읽은 단위 · 구간을 더 줄일 수 없는데 못 다 읽은 단위(같은 자리에 머문다). */
  unread?: number; stuck?: number;
  partial?: boolean;
  per_unit?: IngestUnitResult[];
  /** #4744 링크 따라 읽기 — 저장한 글에서 찾아 적은 링크 수 · 링크로 읽은 문서(그 문서의 단위에 넣은 결과) · 받지 않은 링크 쪽 읽기(상한 넘음 등). */
  links?: { recorded: number; linked: LinkedStoreResult; stray: number };
}

/**
 * 슬랙·노션 단위의 인스턴스(팀·워크스페이스) — claude.ai 커넥터 결과에는 팀 id 가 없다(맥 실측: 목록·채널·프로필 어디에도).
 *  기존 수집기·단위가 쓰는 값과 같아야 같은 글이 합쳐지므로, 이 워크스페이스가 이미 아는 값에서 고른다:
 *  ① ref — 같은 ref 를 가진 기존 단위의 인스턴스(가장 많은 쪽) ② single — 그 앱의 인스턴스가 하나뿐이면 그것(추정) ③ none — 빈 값.
 *  via 가 single 이면 추정이라 목록의 «전부» 를 믿지 않는다(틀린 팀이면 그 팀의 via-listing 자리를 지우게 된다).
 */
export async function resolveInstance(app: string, refs: readonly string[]): Promise<{ instance: string; via: "fixed" | "ref" | "single" | "none" }> {
  if (app === "gmail") return { instance: "default", via: "fixed" };
  try {
    if (refs.length) {
      const r = await itemsPool.query(
        `SELECT instance, count(*)::int AS n FROM collect_unit WHERE app = $1 AND ref = ANY($2::text[]) AND instance <> ''
          GROUP BY instance ORDER BY n DESC LIMIT 1`, [app, [...refs].slice(0, 5000)]);
      if (r.rows[0]?.instance) return { instance: String(r.rows[0].instance), via: "ref" };
    }
    const r2 = await itemsPool.query(
      `SELECT DISTINCT instance FROM (
         SELECT instance FROM collect_unit WHERE app = $1 AND instance <> ''
         UNION SELECT external_instance AS instance FROM source WHERE external_system = $1 AND COALESCE(external_instance, '') <> ''
       ) x LIMIT 3`, [app]);
    if (r2.rows.length === 1) return { instance: String(r2.rows[0].instance), via: "single" };
  } catch (e) {
    logger.warn({ app, err: (e as Error)?.message }, "[collect-ingest] 인스턴스를 못 정했다 — 빈 값으로");
  }
  return { instance: "", via: "none" };
}

const capturesOf = (files: readonly CaptureFile[]): Capture[] =>
  files.map((f) => readCapture(f)).filter((c): c is Capture => !!c);

/** 목록 실행 → recordUnitListing(verified:true). */
async function ingestListing(member: string, app: string, caps: Capture[], truncated: boolean): Promise<Omit<IngestResult, "captures" | "truncated">> {
  const connector = CLAUDE_COLLECT_APPS[app];
  if (!connector) return { state: "failed", mode: "listing", error: `목록을 모르는 앱: ${app}` };
  const h = harvestListing(caps, app);
  if (!h.calls) return { state: "failed", mode: "listing", error: "목록 도구를 부르지 않았다" };
  if (!h.units.length) return { state: h.unparsed ? "failed" : "done", mode: "listing", listed: 0, created: 0, complete: false, ...(h.unparsed ? { error: "목록 결과를 풀지 못했다(형식이 바뀌었을 수 있다)" } : {}) };
  const { instance, via } = await resolveInstance(app, h.units.map((u) => u.ref));
  //  원문이 잘렸으면 뒤쪽 목록을 못 봤다 — «전부» 가 아니다.
  const complete = h.complete && via !== "single" && !truncated;
  const ctx = { actor: member, source: "collect-run" };
  //  보호 단위(이미 저장된 자료가 있고 «모두» 가 아닌 단위)에서 이 사람이 아직 확인되지 않았으면 목록으로는 확인 대기까지만 — 자료가 안 열린다.
  //   판정은 T10 이 실제로 받을 목록(정규화 · 상한 · 좌표 모양)으로 한다 — 판정하지 않은 ref(상한 너머 · 하이픈 없는 노션 id 등)가
  //   «열린 단위» 로 기록되는 우회로를 남기지 않게.
  const coordInst = canonicalCoord(app, instance, "x").instance;
  const items = normalizeListing(h.units).map((it) => ({ ...it, ref: canonicalCoord(app, coordInst, it.ref).ref }));
  const held = await unitGuards(member, app, coordInst, items.map((i) => i.ref));
  if (!held.size) {
    const r = await recordUnitListing({ member, app, connector, instance, items: h.units, complete, verified: true }, ctx);
    await dropStaleProofs(member).catch(() => 0);
    return { state: "done", mode: "listing", listed: h.units.length, created: r.created, refused: r.refused.length, complete: complete && !r.complete_ignored, instance, proof_pending: 0 };
  }
  //  열린 단위만 확인으로 올리고(새 단위는 여기서 종류별 기본 공개범위로 선다), 전체를 확인 표시 없이 한 번 더 — «전부» 정리는 이 한 번으로만
  //   (상한·빈 목록 판정이 원래 목록 길이로 되게 원래 목록을 넘긴다).
  const open = items.filter((i) => !held.has(i.ref));
  const r1 = open.length ? await recordUnitListing({ member, app, connector, instance, items: open, complete: false, verified: true }, ctx) : null;
  const r2 = await recordUnitListing({ member, app, connector, instance, items: h.units, complete, verified: false }, ctx);
  await requestProof(member, [...held.values()]);
  await dropStaleProofs(member).catch(() => 0);
  const refused = new Set([...(r1?.refused ?? []), ...r2.refused]);
  return {
    state: "done", mode: "listing", listed: h.units.length, created: (r1?.created ?? 0) + r2.created, refused: refused.size,
    complete: complete && !r2.complete_ignored, instance, proof_pending: held.size,
  };
}

const PROOF_REASON: Record<ProofResult, string> = {
  pass: "확인 읽기 통과", no_match: "확인 읽기 실패 — 저장된 글과 다름", empty: "확인 읽기 실패 — 맞춰 볼 글이 창 안에 없음",
  unprovable: "확인 읽기 불가 — 본문이 너무 짧음", not_member: "확인 읽기 — 이미 볼 수 있는 구성원이 아님(대기 지움)",
  unreadable: "확인 읽기 보류 — 결과를 못 풂(세 번 이어지면 시도 한 번으로 셈)",
};

/** 수집 실행 → 단위마다 storeUnitItems · advanceUnitCursor. */
async function ingestCollect(member: string, plan: IngestPlan, caps: Capture[], now: number, truncated: boolean, runId: string | null): Promise<Omit<IngestResult, "captures" | "truncated">> {
  const by: UnitReadBy = { member, runId };
  const units = plan.units ?? [];
  if (!units.length) return { state: "failed", mode: "collect", error: "계획에 단위가 없다" };
  const { byUnit, stray, linked, linkStray } = harvestUnits(caps, units, { plannedAt: plan.planned_at ?? null, links: plan.links ?? [] });
  const per: IngestUnitResult[] = [];
  let stored = 0, inserted = 0, unparsed = 0, failed = 0, incomplete = 0, unread = 0, stuck = 0, proofPassed = 0, proofFailed = 0, proofHeld = 0;
  //  이 사람 기준 보호 단위 — 확인되지 않은 사람의 판은 저장된 글과 맞춰 봐야 넣을 수 있다(가짜 글을 남의 비공개 대화에 끼워 넣지 못하게).
  const guard = await guardsByUnitId(member, units.map((u) => u.id));
  for (const u of units) {
    const h = byUnit.get(u.id)!;
    const row: IngestUnitResult = {
      id: u.id, app: u.app, ref: u.ref, reads: h.reads, items: h.items.length,
      stored: 0, inserted: 0, conflicts: 0, failed: 0, unparsed: h.unparsed, complete: h.complete, cursor_moved: false, window_shrunk: false, stuck: false,
    };
    unparsed += h.unparsed;
    if (!h.reads) {
      row.reason = "이 판이 읽지 않음"; per.push(row);
      //  확인 읽기 단위는 주기 단위가 아니다 — 다음 확인 시각·임대를 건드리지 않는다(안 읽었으면 다음 판이 다시 싣는다).
      if (u.proof) continue;
      unread++;
      //  #4744 맡겼는데 안 읽었다(턴이 모자람 등) — 물러섰다가 다시(곧바로 다시 띄우면 같은 판이 되풀이된다). 지금 담당이 아니면 임대만 푼다.
      row.next = await scheduleNote(u.id, readNoteOf(u, h, { blocked: false, nowMs: now }), now, by);
      continue;
    }
    if (u.proof) {
      //  확인 읽기 — 저장·위치 이동 없이 판정만. 단위별로 감싼다(한 단위의 오류가 같은 판의 다른 단위를 막지 않게).
      try {
        const j = judgeProof(u, h.items, await storedBodies(u.id, u.app, u.instance, h.items.map((i) => i.provenance.external_id)), redactString);
        //  못 푼 결과가 섞인 실패는 일시 오류일 수 있다 — 바로 시도로 세지 않는다(세 번 이어지면 한 번 — recordProofResult).
        let outcome: ProofResult = j.outcome !== "pass" && h.unparsed > 0 ? "unreadable" : j.outcome;
        if (outcome === "pass" && (await verifyByProof(member, u.id)) === "not_member") outcome = "not_member";
        await recordProofResult(member, u.id, outcome);
        row.proof = outcome;
        row.reason = PROOF_REASON[outcome];
        if (outcome === "pass") proofPassed++;
        else if (outcome !== "unreadable" && outcome !== "not_member") proofFailed++;
        //  #4744 확인 안 된 사람이 그 단위의 담당이면 단위를 «막힘» 으로 물러서게 한다 — 안 그러면 그 단위가 계속 때가 된 단위로 남아
        //   틱마다 같은 판이 뜬다. 담당이 아니면(대기자) noteUnitRead 가 아무것도 쓰지 않는다 — 담당의 수집은 늦어지지 않는다.
        if (outcome !== "pass") row.next = await scheduleNote(u.id, { outcome: "blocked" }, now, by);
      } catch (e) {
        failed++;
        row.failed = 1;
        row.reason = `확인 읽기 오류 — ${String((e as Error)?.message ?? e).slice(0, 160)}`;
        //  오류도 못 푼 결과로 남긴다 — 시도 시각이 남아야 1시간 간격이 걸린다(안 남기면 주기 판이 틱마다 같은 대기로 판을 띄운다).
        await recordProofResult(member, u.id, "unreadable");
        row.next = await scheduleNote(u.id, { outcome: "blocked" }, now, by);
      }
      per.push(row);
      continue;
    }
    if (guard.get(u.id) === true) {
      //  확인 안 된 사람이 보호 단위를 맡은 판(계획 뒤에 첫 자료가 생긴 경우 등) — 수집 창(읽은 위치 뒤)에는 맞춰 볼 저장된 글이 없어
      //   여기서는 판정하지 않는다. 넣지도 옮기지도 않고 확인 대기만 건다(다음 판의 확인 읽기가 판정한다).
      await requestProof(member, [u.id]).catch(() => 0);
      proofHeld++;
      row.proof = "held";
      row.reason = "확인 대기 — 저장하지 않음(먼저 확인 읽기)";
      per.push(row);
      //  #4744 이 단위는 확인 뒤에야 모은다 — 막힌 판처럼 물러서게 적는다(곧바로 다시 띄우면 같은 판이 되풀이된다).
      row.next = await scheduleNote(u.id, { outcome: "blocked" }, now, by);
      continue;
    }
    if (!h.complete) { incomplete++; row.reason = h.why ?? undefined; }
    try {
      if (h.items.length) {
        const r = await storeUnitItems(u.id, h.items, { member });
        row.stored = r.stored; row.inserted = r.inserted; row.conflicts = r.conflicts; row.failed = r.failed;
        stored += r.stored; inserted += r.inserted; failed += r.failed;
      }
      //  원문이 잘렸거나(뒤쪽 결과를 못 봤다) 저장이 하나라도 실패했으면 위치도 구간도 그대로 둔다 — 다음 판이 같은 자리부터 다시 읽는다.
      //   «마지막 글 시각» 도 그대로 둔다 — 수집기에서 넘어온 단위(위치 칸이 빔)는 그 시각이 곧 다음 시작점이다.
      const blocked = truncated ? "원문이 잘림" : row.failed ? `저장 실패 ${row.failed}건` : null;
      const a = await advanceUnitCursor(u.id, { member }, { cursor: blocked ? null : h.nextCursor, readAt: new Date(now), lastItemAt: blocked ? null : h.lastItemAt });
      if (!a.ok) row.reason = a.reason;
      else if (blocked) row.reason = blocked;
      row.cursor_moved = a.ok && !blocked && h.advanced;
      row.window_shrunk = a.ok && !blocked && !h.complete && h.nextCursor != null;
      row.stuck = row.window_shrunk && h.stuck;
      if (row.stuck) stuck++;
      //  #4744 다음 확인 시각 — 지금 담당의 판만 쓴다(noteUnitRead 가 다시 판정한다 — 담당이 바뀌었으면 이 판이 건 임대만 푼다).
      row.next = await scheduleNote(u.id, readNoteOf(u, h, { blocked: !!blocked, nowMs: now }), now, by);
    } catch (e) {
      row.reason = String((e as Error)?.message ?? e).slice(0, 200);
      row.failed = Math.max(row.failed, 1);
      failed += 1;
      logger.warn({ unitId: u.id, member, err: row.reason }, "[collect-ingest] 단위 저장 실패 — 다음 판이 같은 위치부터 다시 읽는다");
      row.next = await scheduleNote(u.id, { outcome: "blocked" }, now, by);
    }
    per.push(row);
  }
  //  #4744 링크 따라 읽기 — ① 링크로 읽은 문서를 그 문서의 단위에 넣고 ② 이 판에 넣은 글에서 링크를 찾아 적는다(① 에서 읽은 대상은 바로 «읽음»).
  //   링크가 있던 단위의 자료에는 넣지 않는다(공개 채널이 비공개 페이지를 링크해도 채널을 보는 사람에게 그 페이지가 열리지 않게).
  const ls = await storeLinkedReads(member, linked);
  let recorded = 0;
  for (const u of units) {
    const row = per.find((p) => p.id === u.id);
    if (!row || row.stored <= 0) continue;
    const links = byUnit.get(u.id)!.items.flatMap((it) => extractAppLinks(`${it.title ?? ""}\n${it.body ?? ""}`));
    const seen = new Set<string>();
    const uniq = links.filter((l) => !seen.has(linkKey(l)) && !!seen.add(linkKey(l)));
    recorded += (await recordLinks(member, u, uniq, { readTargets: ls.readTargets, tried: ls.tried })).recorded;
  }
  const { readTargets: _rt, tried: _tr, ...linkedRes } = ls;
  const anyRead = per.some((p) => p.reads > 0);
  return {
    links: { recorded, linked: linkedRes, stray: linkStray },
    state: anyRead ? "done" : "failed", mode: "collect", units: units.length, stored, inserted, stray, unparsed, failed, incomplete, unread, stuck,
    proof_passed: proofPassed, proof_failed: proofFailed, proof_held: proofHeld,
    //  확인이 필요한 판 — 못 다 읽음 · 못 풂 · 저장 실패 · 잘림 · 맡긴 단위를 안 읽음 · 요청 안 한 그릇을 읽음(모델이 지시를 벗어남).
    partial: incomplete > 0 || unparsed > 0 || failed > 0 || truncated || unread > 0 || stray > 0, per_unit: per,
    ...(anyRead ? {} : { error: "맡긴 단위를 하나도 읽지 않았다" }),
  };
}

/** 끝난 실행 하나의 저장 단계. 던지지 않는다. */
export async function ingestRun(input: {
  member: string; plan: IngestPlan; files: readonly CaptureFile[]; truncated?: boolean; now?: number;
  /** #4744 그 실행의 id — 이 판이 건 단위 임대를 알아본다(담당이 바뀐 뒤 늦게 끝난 판이 임대만 푼다). */
  runId?: string | null;
}): Promise<IngestResult> {
  const caps = capturesOf(input.files);
  const truncated = input.truncated === true;
  const base = { captures: caps.length, truncated };
  try {
    if (input.plan.mode === "listing") return { ...base, ...(await ingestListing(input.member, String(input.plan.app ?? ""), caps, truncated)) };
    return { ...base, ...(await ingestCollect(input.member, input.plan, caps, input.now ?? Date.now(), truncated, input.runId ?? null)) };
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 300);
    logger.warn({ member: input.member, mode: input.plan.mode, err: error }, "[collect-ingest] 저장 단계 실패");
    return { ...base, state: "failed", mode: input.plan.mode, error };
  }
}

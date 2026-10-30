// 세션 신원 어긋남 막기 (#4135, 2026-09-28) — **남의 세션에서, 그 세션을 연 사람이 아닌 로그인으로 쓰는 것**을 멈춘다.
//
// ── 원칙(원준 2026-09-28) ───────────────────────────────────────────────────
//  «어떤 컴퓨터를 쓰는지와 별개로 로그인한 사람을 기준으로 누가 일했나 판단한다.»
//  세션에서 한 일의 주인은 그 세션을 연 사람이다. 그 세션이 도는 컴퓨터를 누가 등록했는지는 근거가 아니다.
//
// ── 무엇이 고장나 있었나 ─────────────────────────────────────────────────────
//  세션 안의 MCP 프록시는 세션 신원(파일 → env)이 없으면 그 컴퓨터의 `~/.lively/token` 으로 떨어진다. 공용 컴퓨터에서는 그 파일이
//  **컴퓨터를 등록한 사람** 것이라, 다른 사람이 연 세션의 작업 기록·지식·태스크 변경이 등록한 사람 이름으로 남았다
//  (실측: 공용 맥미니의 원준 세션 — 프로젝트 4135 작업 기록 8건이 윤상민으로). 요청은 `x-lively-session` 으로 «어느 세션에서
//  왔는지» 를 말하고 있었는데, 게이트웨이는 그 세션의 주인과 토큰의 사람이 다르다는 것을 보고도 그대로 받았다.
//
// ── 무엇을 하나 ─────────────────────────────────────────────────────────────
//  쓰는 도구(capMutates)에 한해, 요청이 말한 세션의 주인(게이트웨이 자신의 기록)과 토큰의 사람이 다르면 **거절한다**(409).
//  세션 신원은 게이트웨이가 다시 실어 주므로(node-session-token-backfill — 노드가 «없다» 고 하면 다시 굽는다) 이 상태는
//  보통 몇 초다. 그 몇 초 동안 틀린 이름으로 기록이 남는 것보다, 잠깐 못 쓰는 쪽이 맞다.
//
// ── 하지 않는 것 ────────────────────────────────────────────────────────────
//  · 토큰의 사람을 세션 주인으로 **바꿔 주지 않는다.** 헤더는 자기주장이다 — 그걸 믿고 신원을 바꾸면 남의 이름으로 쓰는 길이 열린다.
//  · 읽기는 막지 않는다(보이는 범위는 토큰의 사람 것 그대로다).
//  · 게이트웨이가 주인을 확인한 적 없는 세션(그 컴퓨터에서 직접 띄운 것 = discovered)·기록에 없는 세션은 판정하지 않는다.
//  · 사람이 연 세션만 본다(위탁·상시·앱·로그인 세션은 제 신원 규칙이 따로 있다).
//  · 초대받아 그 세션에 들어온 사람이 자기 로그인으로 쓰는 것은 막지 않는다 — 그건 그 사람이 한 일이다.
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { normalizeSessionKind } from "./session-kind.js";
import { getSessionState, type SessionState } from "./session-state.js";

export type GuardRow = Pick<SessionState, "owner" | "invites" | "discovered" | "kind">;

/** 어긋났으면 그 세션의 주인, 아니면 null. 순수 — 판정은 여기 한 곳이다. */
export function sessionOwnerMismatch(tokenMember: string | null | undefined, row: GuardRow | null | undefined): string | null {
  if (!row) return null;
  if (row.discovered) return null;
  if (normalizeSessionKind(row.kind) !== "human") return null;
  const owner = String(row.owner ?? "").trim();
  const me = String(tokenMember ?? "").trim();
  if (!owner || !me || owner === me) return null;
  if (Array.isArray(row.invites) && row.invites.includes(me)) return null;
  return owner;
}

/** 거절 문장 — AI 가 읽고 그대로 사람에게 전할 수 있게, 무엇이 어긋났고 어떻게 하면 되는지를 말한다. 순수. */
export function mismatchMessage(sessionId: string, owner: string, tokenMember: string): string {
  return [
    `이 세션(${sessionId})은 ${owner} 님이 연 세션인데, 이 요청은 ${tokenMember} 님의 로그인으로 왔습니다.`,
    "기록의 주인은 세션을 연 사람이어야 하므로 쓰기를 멈췄습니다(읽기는 됩니다).",
    "세션 신원은 게이트웨이가 다시 보내는 중이며 보통 몇 초 안에 도착합니다 — 잠시 뒤 같은 요청을 다시 보내세요.",
    "몇 분이 지나도 같다면 이 사실을 사람에게 알리고, 이 세션을 복제하거나 새 세션을 열어 거기서 기록하세요. 다른 사람 이름으로는 기록하지 마세요.",
  ].join(" ");
}

// 같은 세션의 연속 호출이 매번 DB 를 읽지 않게 — 몇 초만 기억한다(주인·초대는 자주 안 바뀐다).
const CACHE_MS = 5_000;
const seen = new Map<string, { at: number; row: GuardRow | null }>();

export interface GuardDeps { load: (sessionId: string) => Promise<GuardRow | null | undefined>; now: () => number }
const liveDeps: GuardDeps = { load: (id) => getSessionState(id), now: Date.now };

/**
 * 쓰는 요청 앞에서 부른다. 어긋났으면 409 를 던진다.
 *  ⚠ 세션 기록을 **못 읽었으면 막지 않는다** — 판정할 근거가 없는데 막으면 DB 가 잠깐 흔들릴 때 모든 세션의 쓰기가 멈춘다.
 *   (그때는 쓰기 자체도 대개 실패한다.) 로그는 남긴다.
 */
export async function requireSessionWriter(tokenMember: string | null | undefined, sessionId: string | null | undefined, deps: GuardDeps = liveDeps): Promise<void> {
  const sid = String(sessionId ?? "").trim();
  const me = String(tokenMember ?? "").trim();
  if (!sid || !me) return;
  let row: GuardRow | null | undefined;
  const hit = seen.get(sid);
  if (hit && deps.now() - hit.at < CACHE_MS) row = hit.row;
  else {
    try { row = (await deps.load(sid)) ?? null; }
    catch (e) { logger.warn({ id: sid, err: (e as Error)?.message || String(e) }, "세션 신원 확인: 세션 기록을 못 읽었다 — 막지 않는다"); return; }
    seen.set(sid, { at: deps.now(), row: row ? { owner: row.owner, invites: row.invites, discovered: row.discovered, kind: row.kind } : null });
    if (seen.size > 2_000) for (const k of [...seen.keys()].slice(0, 500)) seen.delete(k);
  }
  const owner = sessionOwnerMismatch(me, row);
  if (!owner) return;
  logger.warn({ session: sid, owner, token_member: me }, "세션 신원 어긋남 — 쓰기를 거절했다(#4135 · 기록의 주인은 세션을 연 사람)");
  throw new HttpError(409, mismatchMessage(sid, owner, me));
}

/** 시험용 — 기억을 비운다. */
export function resetSessionIdentityGuardCache(): void { seen.clear(); }

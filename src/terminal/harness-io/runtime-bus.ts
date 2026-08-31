// 세션 런타임 버스 — 하네스 런타임이 화면과 말을 섞는 **공통 자리** (#2439).
//
//  ── 무엇을 공통으로 두나 ─────────────────────────────────────────────────────────
//  하네스마다 전송은 다르다(claude stream-json · codex app-server · grok ACP · opencode SSE).
//  그런데 그 위에서 하는 일은 **똑같다**:
//    ① 세션별로 이벤트를 흘린다(화면이 구독).
//    ② 에이전트가 우리에게 **묻는다**(승인·선택지) — 그 요청을 들고 있다가 사람의 답을 돌려준다.
//  ②를 하네스마다 각자 구현하면 반드시 한쪽이 규칙을 빠뜨린다. 그래서 여기 한 벌만 둔다.
//
//  ── ★ 이 파일이 지키는 불변식: 모든 요청은 반드시 한 번 답한다 ──────────────────
//  claude SDK 주석: *"accidental null means no control_response is sent and the tool stays blocked
//   indefinitely — **permission prompts have no park deadline**."*
//  codex 도 같다(#2055 §11 함정1): 서버→클라 요청에 답을 안 하면 **턴이 그 자리에서 선다.**
//  두 하네스가 같은 성질을 공유하므로 이건 어댑터 하나의 버그가 아니라 **층의 불변식**이다:
//    · 미응답 요청을 **추적**한다(무엇이 걸려 있는지 언제나 셀 수 있다).
//    · **타임아웃**이 있다 — 사람이 안 보고 있으면 영원히 서 있지 않는다.
//    · 런타임이 죽으면 **남은 요청을 전부 마감**한다(settleAll). 안 그러면 그 턴은 영영 안 끝난다.
//    · 기본 결말은 **거부**다 — 정책이 없거나 예외가 나면 «허용» 으로 새지 않는다(fail-closed).
//
//  ── 왜 codex 를 지금 이리로 옮기지 않나 ──────────────────────────────────────────
//  codex 런타임(codex-chat-runtime.ts)은 매니지드 프로덕션에서 돌고 있다. 새 코드를 먼저 이 위에서
//  세우고, codex 이관은 그 뒤에 별도로 한다 — 도는 것을 리팩터와 함께 흔들지 않는다.
import { logger } from "../../log.js";
import type { SessionEvent } from "./session-event.js";

type Listener = (e: SessionEvent) => void;

/** 사람에게 물어보는 요청 하나 — 답이 오거나, 시간이 다하거나, 런타임이 죽으면 마감된다. */
interface Pending<T> {
  id: string;
  /** 화면에 보여줄 것(어휘는 SessionEvent 쪽 타입을 그대로 쓴다 — 여기서 다시 정의하지 않는다). */
  ask: unknown;
  resolve: (v: T) => void;
  /** 답이 없을 때의 결말 — **거부**가 기본이다. */
  fallback: T;
  timer: NodeJS.Timeout;
}

/** 사람이 안 보고 있을 때 요청을 얼마나 들고 있나. 넘으면 fallback(거부)으로 마감한다. */
export const ASK_TTL_MS = 10 * 60_000;

const listeners = new Map<string, Set<Listener>>();
const pending = new Map<string, Map<string, Pending<unknown>>>();

/** 세션의 이벤트를 구독한다. 반환값을 부르면 해지. */
export function onSessionEvent(sessionId: string, fn: Listener): () => void {
  let set = listeners.get(sessionId);
  if (!set) { set = new Set(); listeners.set(sessionId, set); }
  set.add(fn);
  return () => {
    const s = listeners.get(sessionId);
    if (!s) return;
    s.delete(fn);
    if (!s.size) listeners.delete(sessionId);
  };
}

/**
 * 이벤트를 흘린다. **구독자가 던져도 다른 구독자에게 계속 간다** — 화면 하나의 버그가
 *  다른 화면(같은 세션을 보는 다른 탭)을 멈추게 하지 않는다.
 */
export function emitSessionEvent(sessionId: string, e: SessionEvent): void {
  const set = listeners.get(sessionId);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(e); }
    catch (err) { logger.warn({ sessionId, t: e.t, err: (err as Error)?.message }, "세션 이벤트 구독자가 던졌다 — 나머지는 계속 간다"); }
  }
}

/**
 * 에이전트의 물음을 등록하고 **답을 기다린다**.
 *  · 같은 id 가 다시 오면 앞의 것을 fallback 으로 마감한다(중복 배달·재연결).
 *  · TTL 이 지나면 fallback 으로 마감한다 — 영원히 서 있지 않는다.
 *  · 등록과 동시에 `permission.asked` 를 흘려 화면이 카드를 그린다.
 */
export function ask<T>(sessionId: string, id: string, askPayload: unknown, fallback: T, ttlMs = ASK_TTL_MS): Promise<T> {
  return new Promise<T>((resolve) => {
    let m = pending.get(sessionId);
    if (!m) { m = new Map(); pending.set(sessionId, m); }
    const prev = m.get(id);
    if (prev) { clearTimeout(prev.timer); prev.resolve(prev.fallback); }   // 앞의 것을 매달아 두지 않는다

    const timer = setTimeout(() => {
      const cur = pending.get(sessionId)?.get(id);
      if (!cur) return;
      pending.get(sessionId)?.delete(id);
      logger.warn({ sessionId, id }, "승인 요청이 시간 안에 답을 못 받아 기본값(거부)으로 마감한다");
      emitSessionEvent(sessionId, { t: "permission.resolved", id });
      cur.resolve(cur.fallback);
    }, ttlMs);
    //  ⚠ `timer.unref()` 를 하지 않는다. 처음엔 «이 타이머가 프로세스를 붙잡지 않게» 하려고 넣었는데,
    //   unref 된 타이머는 **다른 할 일이 없으면 아예 안 돈다** — 그러면 이 파일이 지키려는 바로 그 불변식
    //   («반드시 한 번 답한다»)이 깨진다. 마지막으로 남은 일이 «승인 마감» 인 상황이 정확히 그 경우다.
    //   정상 경로에서는 answer·settleAll 이 clearTimeout 하므로 붙잡고 있을 일이 없다.

    m.set(id, { id, ask: askPayload, resolve: resolve as (v: unknown) => void, fallback, timer });
    emitSessionEvent(sessionId, { t: "permission.asked", ask: askPayload as never });
  });
}

/** 사람이 답했다. 그런 요청이 없으면 false(이미 마감됐거나 남의 것) — 던지지 않는다. */
export function answer(sessionId: string, id: string, value: unknown): boolean {
  const m = pending.get(sessionId);
  const p = m?.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  m!.delete(id);
  if (!m!.size) pending.delete(sessionId);
  emitSessionEvent(sessionId, { t: "permission.resolved", id });
  p.resolve(value);
  return true;
}

/** 지금 이 세션에 걸려 있는 물음들 — 화면이 새로 붙었을 때 되그리는 재료. */
export function pendingAsks(sessionId: string): Array<{ id: string; ask: unknown }> {
  return [...(pending.get(sessionId)?.values() ?? [])].map((p) => ({ id: p.id, ask: p.ask }));
}

/**
 * ★ 런타임이 죽었다 — **남은 물음을 전부 마감한다.**
 *  이걸 안 하면 그 턴은 영영 안 끝나고, 화면엔 답할 수 없는 카드가 남는다.
 *  런타임 종료 경로(정상·비정상 모두)에서 반드시 부른다.
 */
export function settleAll(sessionId: string, reason: string): number {
  const m = pending.get(sessionId);
  if (!m || !m.size) return 0;
  const n = m.size;
  for (const p of [...m.values()]) {
    clearTimeout(p.timer);
    emitSessionEvent(sessionId, { t: "permission.resolved", id: p.id });
    p.resolve(p.fallback);
  }
  pending.delete(sessionId);
  logger.warn({ sessionId, n, reason }, "런타임이 끝나 남은 승인 요청을 기본값(거부)으로 마감했다");
  return n;
}

/** 테스트 seam — 세션 하나의 구독·대기를 통째로 비운다. */
export function resetSessionBus(sessionId: string): void {
  settleAll(sessionId, "reset");
  listeners.delete(sessionId);
}

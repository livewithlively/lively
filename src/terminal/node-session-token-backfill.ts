// terminal/node-session-token-backfill.ts — **게이트웨이 전용**: 노드가 보고한 살아 있는 세션 가운데 세션 토큰이 없는 것에
//  그 주인 앞으로 훅·MCP 토큰을 구워 노드에 심는다(sessionTokens op → session-token-file). (#4135)
//
//  ── 왜 ──
//  node-session-preissue 는 **새로** 뜨는 노드 세션에만 닿는다. 이 변경 전에 뜬 노드 세션(맥미니의 원준 세션들처럼 며칠씩 켜 두는
//  것)은 토큰 없이 돌고 있고, 살아 있는 프로세스의 env 는 못 바꾼다 — 훅·MCP 프록시가 매 호출 읽는 **파일**로만 닿는다.
//  노드는 3초마다 자기 세션 목록을 밀어 올린다(registry onNodeSessions). 그 스냅샷이 «어느 세션이 살아 있나» 의 정본이라 여기서 본다.
//
//  ── 규칙 ──
//  · 셀프 노드(게이트웨이 자신의 tmux)는 대상이 아니다 — 중앙 세션은 createSession 이 env 로 이미 실었다.
//  · op 를 선언하지 않은 노드(옛 번들)엔 보내지 않고 **기억도 안 한다** — 번들이 갱신돼 caps 가 바뀌면 다음 스냅샷에서 바로 심는다.
//  · «이미 실어 준 세션»(살아 있는 session-hooks 토큰이 있는 id — preissue 로 뜬 새 세션)은 건너뛴다. 스냅샷 한 판에 DB 는 한 번.
//  · 주인이 멤버 디렉터리에 없으면(에이전트 세션 등) 민팅이 null·null → 건너뛰고 기억한다.
//  · 노드가 op 를 거절하면(파일을 못 씀) 구운 토큰을 바로 거두고 10분 뒤 다시 시도한다 — 3초마다 굽고 거두지 않는다.
//  · 여기서 심은 세션이 스냅샷에서 사라지면 그 토큰을 거둔다(DELETE 를 안 거치고 tmux 가 끝난 세션). preissue 로 뜬 세션은
//    이 판정 밖에 둔다 — 스냅샷 한 판이 비는 사고에 살아 있는 세션의 env 토큰을 죽이지 않기 위해(그쪽은 DELETE 가 거둔다).
//    사라진 세션의 기억(처리·백오프)도 지운다 — 같은 id 가 다시 뜨면 다시 판정한다. 게이트웨이가 재시작되면 «여기서 심은» 기억은
//    사라진다(그 세션들은 이후 preissue 취급 — DELETE 가 거두고, 스스로 끝난 세션은 중앙 경로와 같은 갭).
//  · ★ **주인은 노드가 보고한 값을 믿지 않는다.** 노드 스냅샷의 owner 를 그대로 믿으면 노드(공유 PC)가 남의 이름을 보고해 그 멤버의
//    MCP 토큰(멤버 권한 폭 전체)을 받아 낼 수 있다(리뷰 지적). 주인은 **게이트웨이 자신의 기록**에서만 온다 — relay 로 만들 때
//    적은 desired-state 행(같은 노드 · discovered 아님 · 그때 인증된 소유자). 기록에 없는 세션(노드에서 사람이 직접 띄운 것)은
//    건너뛴다 — 그 세션의 훅은 어차피 그 PC 의 `~/.lively/token`(그 사람 것)으로 나간다.
//  · ★ **발급한 적이 있어도, 그 컴퓨터에 없다고 노드가 말하면 다시 굽는다** (2026-09-28). 종전엔 «발급한 적 있음» 만 보고 건너뛰어서,
//    노드에서 신원 파일이 사라진 세션은 영영 신원 없이 돌았다 — 그 세션의 훅·MCP 는 그 컴퓨터에 깔린 로그인(키트를 깐 사람)으로
//    나가고, 작업 기록·지식·파일의 작성자가 **세션을 연 사람이 아니라 컴퓨터를 등록한 사람**으로 남았다(실측: 공용 맥미니의 원준
//    세션 10개 — 토큰은 DB 에 살아 있는데 노드의 `session-tokens/` 는 비어 있었다 · 프로젝트 4135 작업 기록 8건이 윤상민으로).
//    원준의 원칙: «어떤 컴퓨터를 쓰는지와 별개로 로그인한 사람을 기준으로 누가 일했나 판단한다».
//    · 근거는 노드 스냅샷의 `hasSessionToken === false`(확답)뿐이다. 값이 없으면(옛 번들 · 아직 못 물어봄) 종전대로 건너뛴다.
//    · 다시 구우면 옛 토큰은 그 자리에서 죽는다(mint 가 같은 라벨의 옛 것을 거둔다) — 파일이 env 보다 앞이라 세션은 새 것을 쓴다.
//    · 세션 호스트 노드에는 하지 않는다: 그쪽 세션은 중앙 경로가 env 로 실었고 pane 의 HOME 이 달라 파일이 닿지 않는다 —
//      다시 구우면 살아 있는 env 토큰만 죽인다.
//    · 주인은 여전히 게이트웨이 기록에서만 온다(위 ★) — 노드의 말은 «없다» 는 사실까지만 믿는다.
//  · haveTokens 는 표 전체를 읽으므로 실패하면 60초 쉰다(3초마다 표를 다시 읽지 않는다).
//  ⚠ 이 모듈은 노드 에이전트 번들에 들어가면 안 된다(DB·registry 를 문다) — node-session-state 의 armNodeSessionDiscovery 가 건다.
import { isSelfNode, isSessionHostNode, nodeRpc, nodeSupports } from "../node/registry.js";
import { mintSessionHookToken, mintSessionMcpToken, revokeSessionHookToken, sessionHookTokenIds } from "./profiles.js";
import { getSessionStates } from "../sessions/session-state.js";
import { SESSION_ID_RE } from "../org/auth/agent-identity.js";
import type { SessionInfo } from "./catalog.js";
import { logger } from "../log.js";

export const BACKFILL_RETRY_AFTER_MS = 10 * 60_000;
export const BACKFILL_HAVE_RETRY_MS = 60_000;
/** «확인했다» 는 기억의 수명 — 지나면 다시 판정한다(리뷰 지적: relay 가 타임아웃으로 실패해 게이트웨이가 토큰을 거뒀는데 노드는 세션을
 *  띄운 경우, 스냅샷이 먼저 와 «실어 줬다» 로 기억되면 그 세션은 영영 죽은 env 토큰으로 남는다. 재판정이 그것을 다시 심는다). */
export const BACKFILL_RECHECK_MS = 10 * 60_000;
/** «다시 굽기» 가 심는 데 실패했을 때 다시 해 보는 간격 — 보통의 실패(10분)보다 짧다(리뷰 지적).
 *  다시 굽는 순간 옛 토큰은 죽는다(mint 가 같은 라벨의 옛 것을 거둔다). 노드의 «없다» 가 틀린 말이었다면(살아 있는 env 토큰이
 *  있었는데 못 본 경우) 그 세션은 심기가 성공할 때까지 신원이 없다 — 그 사이 쓰기는 session-identity-guard 가 막으므로 틀린 이름이
 *  남지는 않지만, 10분을 그렇게 두지 않는다. */
export const BACKFILL_REISSUE_RETRY_MS = 60_000;
/** 한 판이 이보다 오래 돌면 **끝나지 않는 판**으로 본다 — 기다리지 않고 새 판을 돈다(2026-09-28).
 *  한 판의 정상 상한은 세션 수 × (민팅 + 노드 RPC 상한)이라 분 단위를 넘지 않는다. 종전엔 앞 판이 도는 동안 뒤 판을 **무기한**
 *  건너뛰어서, 앞 판의 DB·RPC 약속 하나가 안 끝나면 그 노드의 되채우기가 재시작 전까지 멈췄다. */
export const BACKFILL_INFLIGHT_MAX_MS = 3 * 60_000;

/** 바깥 의존(테스트 주입용) — 판정·순서는 이 모듈이, DB·노드 RPC 는 이들이. */
export interface BackfillDeps {
  isSelf: (nodeId: string) => boolean;
  supports: (nodeId: string) => boolean;
  /** 이 노드의 세션에 «발급은 했는데 거기엔 없다» 면 다시 구워 보내도 되나 — 세션 호스트가 아니면 된다. 생략 = 안 한다(종전 동작). */
  canReissue?: (nodeId: string) => boolean;
  /** 살아 있는 세션 훅 토큰이 걸린 세션 id 들(한 판에 한 번). 훅·MCP 는 함께 굽고 함께 거두므로 훅 라벨 하나가 «실어 줬나» 의 표지다. */
  haveTokens: () => Promise<Set<string>>;
  /** 게이트웨이 기록에서 확인한 주인 — id → 멤버 id. 이 노드에서 relay 로 만든 세션만(discovered 아님). 없는 id 는 빠진다. */
  verifiedOwners: (nodeId: string, sessionIds: string[]) => Promise<Map<string, string>>;
  mint: (owner: string, sessionId: string) => Promise<{ hook: string | null; mcp: string | null }>;
  /** 노드에 파일로 심는다 — 거절·오프라인이면 던진다. */
  push: (nodeId: string, sessionId: string, tokens: { hook: string | null; mcp: string | null }) => Promise<unknown>;
  /** 그 세션 id 로 구운 훅·MCP 토큰 **둘 다** 거둔다(profiles.revokeSessionHookToken — 이름과 달리 둘을 본다). */
  revoke: (sessionId: string) => Promise<unknown>;
  now: () => number;
  retryAfterMs?: number;
  haveRetryMs?: number;
  recheckMs?: number;
  reissueRetryMs?: number;
  inflightMaxMs?: number;
}
export function defaultBackfillDeps(): BackfillDeps {
  return {
    isSelf: isSelfNode,
    supports: (nodeId) => nodeSupports(nodeId, "sessionTokens"),
    canReissue: (nodeId) => !isSessionHostNode(nodeId),
    haveTokens: sessionHookTokenIds,
    verifiedOwners: async (nodeId, ids) => {
      const rows = await getSessionStates(ids);
      const out = new Map<string, string>();
      for (const [id, r] of rows) if (r.node_id === nodeId && !r.discovered && r.owner) out.set(id, r.owner);
      return out;
    },
    //  삼키지 않는다(리뷰 지적) — DB 가 잠깐 죽은 것을 «멤버 아님(null·null)» 으로 읽어 영구 건너뛰면 그 세션은 재시작 전까지 토큰이 없다.
    //  던지면 run 이 실패로 세고 백오프 뒤 다시 온다. null 은 mint 함수 자신이 «멤버 디렉터리에 없다» 일 때만 돌려준다.
    mint: async (owner, id) => ({ hook: await mintSessionHookToken(owner, id), mcp: await mintSessionMcpToken(owner, id) }),
    push: (nodeId, id, t) => nodeRpc(nodeId, "sessionTokens", { id, hookToken: t.hook, mcpToken: t.mcp }),
    revoke: revokeSessionHookToken,
    now: Date.now,
  };
}

export interface BackfillResult { minted: number; skipped: number; revoked: number; failed: number }

/** 스냅샷 한 판을 처리하는 기계 — 프로세스에 하나(기억: 처리한 세션·실패 시각·여기서 심은 세션·직전 스냅샷). */
export function createNodeSessionTokenBackfill(deps: BackfillDeps = defaultBackfillDeps()) {
  const doneAt = new Map<string, number>();               // `${nodeId}|${id}` → 확인한 시각(실었거나 건너뛰었다) — recheckMs 뒤 다시 판정
  const failedAt = new Map<string, number>();             // 같은 키 — 마지막 실패 시각(백오프)
  const minted = new Map<string, Set<string>>();          // nodeId → 여기서 심은 세션 id 들(사라지면 거둔다)
  const lastSeen = new Map<string, Set<string>>();        // nodeId → 직전 스냅샷의 세션 id 들(사라진 것의 기억을 지운다)
  const haveFailedAt = new Map<string, number>();         // nodeId → haveTokens 실패 시각(표 전체 읽기 백오프)
  //  처리 중인 노드 → 그 판이 시작한 시각. 겹치면(첫 배포 때 세션 N 개 × DB·RPC) 같은 세션을 두 번 굽는다(리뷰 지적) — 그래서
  //   앞 판이 도는 동안 뒤 판은 건너뛴다. 단 BACKFILL_INFLIGHT_MAX_MS 를 넘긴 앞 판은 버린다(그 판은 아래 stale() 로 스스로 멈춘다).
  const inflight = new Map<string, number>();
  //  «확인했다» 고 기억할 때 그 세션이 신원을 갖고 있다고 했나(true) · 없다고 했나(false) · 말이 없었나(undefined).
  //   노드가 **그 뒤에** «없다» 고 말을 바꾸면 recheckMs 를 기다리지 않고 바로 다시 판정한다 — 새 번들로 갈아탄 노드는 첫 판에는
  //   아직 못 물어본 세션이 많아 말이 없고(그래서 건너뛰고 기억된다), 몇 초 뒤에야 «없다» 고 한다(2026-09-28 매니지드 실측:
  //   그 세션들이 10분을 기다렸다).
  const seenTok = new Map<string, boolean | undefined>();
  const lastNote = new Map<string, number>();            // nodeId → 마지막으로 판 요약을 적은 시각(노드당 1분에 한 줄)
  let runSeq = 0;                                         // 판 번호 — 버려진 판(stale)이 뒤늦게 굽거나 심지 않게 가른다
  const runOf = new Map<string, number>();                // nodeId → 지금 유효한 판 번호
  const key = (nodeId: string, id: string): string => `${nodeId}|${id}`;
  const retryAfter = deps.retryAfterMs ?? BACKFILL_RETRY_AFTER_MS;
  const haveRetry = deps.haveRetryMs ?? BACKFILL_HAVE_RETRY_MS;
  const recheck = deps.recheckMs ?? BACKFILL_RECHECK_MS;
  const inflightMax = deps.inflightMaxMs ?? BACKFILL_INFLIGHT_MAX_MS;

  /**
   * «신원이 없다» 고 보고된 세션이 있는데 이번 판이 **아무것도 심지 않고 끝났을 때** 그 자리(stage)를 적는다 — 노드당 1분에 한 줄.
   *  2026-09-28 매니지드 실측: 다시 굽기가 안 도는데 기록이 한 줄도 없어, 조용히 끝나는 여러 갈래 가운데 어디서 멈췄는지 가릴 수 없었다.
   *  ⚠ 세션 id·주인·토큰은 싣지 않는다 — 개수와 단계 이름만.
   */
  function note(nodeId: string, sessions: SessionInfo[], stage: string, extra?: Record<string, unknown>): void {
    const lost = sessions.filter((s) => s && s.hasSessionToken === false).length;
    if (!lost) return;
    const now = deps.now();
    if (now - (lastNote.get(nodeId) ?? -Infinity) <= 60_000) return;
    lastNote.set(nodeId, now);
    logger.info({ node: nodeId, stage, live: sessions.length, no_token: lost, ...extra },
      "세션 신원 되채우기 — «없다» 고 보고된 세션이 있는데 이번 판에 심지 못했다");
  }

  async function run(nodeId: string, sessions: SessionInfo[]): Promise<BackfillResult> {
    const out: BackfillResult = { minted: 0, skipped: 0, revoked: 0, failed: 0 };
    if (deps.isSelf(nodeId)) { note(nodeId, sessions, "self-node"); return out; }
    const started = inflight.get(nodeId);
    if (started !== undefined) {
      const age = deps.now() - started;
      //  이 노드의 앞 판이 아직 도는 중 — 이번 스냅샷은 건너뛴다(다음 판이 따라잡는다).
      if (age < inflightMax) { note(nodeId, sessions, "inflight", { inflight_ms: age }); return out; }
      logger.warn({ node: nodeId, inflight_ms: age }, "세션 신원 되채우기 — 앞 판이 끝나지 않는다. 그 판을 버리고 새 판을 돈다");
    }
    const seq = ++runSeq;
    runOf.set(nodeId, seq);
    inflight.set(nodeId, deps.now());
    try { return await runOnce(nodeId, sessions, out, () => runOf.get(nodeId) !== seq); }
    finally { if (runOf.get(nodeId) === seq) inflight.delete(nodeId); }
  }

  async function runOnce(nodeId: string, sessions: SessionInfo[], out: BackfillResult, stale: () => boolean): Promise<BackfillResult> {
    const live = sessions.filter((s) => s && typeof s.id === "string" && SESSION_ID_RE.test(s.id));
    const liveIds = new Set(live.map((s) => s.id));
    // ① 사라진 세션 — 여기서 심은 것은 거두고, 어느 쪽이든 기억은 지운다(같은 id 가 다시 뜨면 다시 판정).
    const mine = minted.get(nodeId);
    if (mine) {
      for (const id of [...mine]) {
        if (liveIds.has(id)) continue;
        mine.delete(id);
        try { await deps.revoke(id); out.revoked++; }
        catch (e) { logger.warn({ node: nodeId, id, err: (e as Error)?.message || String(e) }, "사라진 노드 세션의 토큰 회수 실패(비치명)"); }
      }
    }
    const prev = lastSeen.get(nodeId);
    if (prev) for (const id of prev) if (!liveIds.has(id)) { doneAt.delete(key(nodeId, id)); failedAt.delete(key(nodeId, id)); seenTok.delete(key(nodeId, id)); }
    lastSeen.set(nodeId, liveIds);
    // ② 아직 못 하는 노드 — 기억하지 않는다(번들이 갱신되면 다음 판에 심는다).
    if (!deps.supports(nodeId)) { note(nodeId, live, "unsupported-op"); return out; }
    const now = deps.now();
    const cands = live.filter((s) => {
      const k = key(nodeId, s.id);
      const d = doneAt.get(k);
      //  노드가 «없다» 고 **새로** 말했다(기억할 때는 그 말이 아니었다) — 기억을 접고 지금 다시 판정한다.
      const turnedLost = s.hasSessionToken === false && seenTok.has(k) && seenTok.get(k) !== false;
      if (d !== undefined && now - d < recheck && !turnedLost) return false;   // 확인한 지 얼마 안 됐다 — 수명이 지나면 다시 판정한다
      const f = failedAt.get(k);
      return !(f !== undefined && now - f < retryAfter);
    });
    //  노드가 이번에 한 말을 **모든** 세션에 대해 적어 둔다(후보가 아니어도) — «있다 → 없다» 로 바뀌는 순간(심어 준 파일이 그 컴퓨터에서
    //   사라진 때)도 다음 판이 바로 알아본다.
    for (const s of live) seenTok.set(key(nodeId, s.id), s.hasSessionToken);
    if (!cands.length) {
      const lost = live.filter((s) => s.hasSessionToken === false);
      note(nodeId, live, "no-candidates", {
        remembered: lost.filter((s) => doneAt.has(key(nodeId, s.id))).length,
        backoff: lost.filter((s) => failedAt.has(key(nodeId, s.id))).length,
      });
      return out;
    }
    const hf = haveFailedAt.get(nodeId);
    if (hf !== undefined && now - hf < haveRetry) { note(nodeId, live, "lookup-backoff"); return out; }   // 표 전체 읽기가 방금 실패했다 — 잠시 쉰다
    let have: Set<string>;
    try { have = await deps.haveTokens(); haveFailedAt.delete(nodeId); }
    catch (e) { haveFailedAt.set(nodeId, now); logger.warn({ node: nodeId, err: (e as Error)?.message || String(e) }, "세션 토큰 목록 조회 실패 — 잠시 뒤 다시"); return out; }
    // ③ 주인은 게이트웨이 기록에서만(머리말 ★) — 노드가 보고한 owner 는 쓰지 않는다.
    let owners: Map<string, string>;
    try { owners = await deps.verifiedOwners(nodeId, cands.map((s) => s.id)); }
    catch (e) { haveFailedAt.set(nodeId, now); logger.warn({ node: nodeId, err: (e as Error)?.message || String(e) }, "세션 주인 조회 실패 — 잠시 뒤 다시"); return out; }
    if (stale()) return out;                               // 이 판은 버려졌다(BACKFILL_INFLIGHT_MAX_MS) — 새 판이 맡는다
    for (const s of cands) {
      if (stale()) return out;
      const k = key(nodeId, s.id);
      //  실어 준 적 있는 세션(preissue 또는 앞 판의 되채우기) — env 나 파일에 이미 있다. 재판정 때도 토큰이 살아 있으면 그대로.
      //  ★ 단, 노드가 «이 세션엔 신원이 없다» 고 확답하면 다시 굽는다(머리말 ★ 2026-09-28).
      const lost = have.has(s.id) && s.hasSessionToken === false && deps.canReissue?.(nodeId) === true;
      if (have.has(s.id) && !lost) { doneAt.set(k, now); out.skipped++; continue; }
      const owner = String(owners.get(s.id) || "").trim();
      if (!owner) { doneAt.set(k, now); out.skipped++; continue; }           // 게이트웨이가 만든 세션이 아니다(또는 주인 미상) — 굽지 않는다
      let tokens: { hook: string | null; mcp: string | null };
      try { tokens = await deps.mint(owner, s.id); }
      catch (e) { failedAt.set(k, now); out.failed++; logger.warn({ node: nodeId, id: s.id, err: (e as Error)?.message || String(e) }, "노드 세션 토큰 민팅 실패"); continue; }
      if (!tokens.hook && !tokens.mcp) { doneAt.set(k, now); out.skipped++; continue; }   // 멤버 디렉터리에 없는 주인(에이전트 등) — 실을 것이 없다
      try {
        await deps.push(nodeId, s.id, tokens);
        doneAt.set(k, now); failedAt.delete(k);
        if (!minted.has(nodeId)) minted.set(nodeId, new Set());
        minted.get(nodeId)!.add(s.id);
        out.minted++;
        //  다시 구운 것도 결과에서는 minted 로 센다(결과 모양은 그대로 둔다) — 구분은 이 로그 한 줄이 한다.
        if (lost) { logger.info({ node: nodeId, id: s.id, owner }, "세션 신원을 다시 실었다 — 발급은 돼 있었는데 그 컴퓨터에 없었다(#4135)"); }
      } catch (e) {
        //  다시 굽던 중이면 백오프를 줄인다(BACKFILL_REISSUE_RETRY_MS 머리말) — 실패 시각을 앞당겨 적어 retryAfter 가 그만큼 일찍 찬다.
        failedAt.set(k, lost ? now - Math.max(0, retryAfter - (deps.reissueRetryMs ?? BACKFILL_REISSUE_RETRY_MS)) : now); out.failed++;
        try { await deps.revoke(s.id); } catch { /* 회수 실패는 다음 민팅이 옛 라벨을 죽인다 */ }
        logger.warn({ node: nodeId, id: s.id, err: (e as Error)?.message || String(e) }, "노드에 세션 토큰을 못 심었다 — 거두고 잠시 뒤 다시");
      }
    }
    if (out.minted) logger.info({ node: nodeId, ...out }, "살아 있는 노드 세션에 세션 토큰을 심었다(#4135 되채우기)");
    //  판 요약 — «신원 없다» 고 보고된 세션이 있는데 아무것도 못 심은 판은 그 이유가 로그에 있어야 한다(2026-09-28: 매니지드에서
    //   다시 굽기가 안 도는데 로그가 한 줄도 없어 어디서 멈췄는지 알 수 없었다). 노드당 1분에 한 줄.
    if (!out.minted) {
      note(nodeId, live, "judged", {
        cands: cands.length, have: cands.filter((s) => have.has(s.id)).length, owners: owners.size,
        can_reissue: deps.canReissue?.(nodeId) === true, ...out,
      });
    }
    return out;
  }

  return { run };
}

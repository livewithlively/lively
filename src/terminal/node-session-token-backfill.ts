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
//  ⚠ 이 모듈은 노드 에이전트 번들에 들어가면 안 된다(DB·registry 를 문다) — node-session-state 의 armNodeSessionDiscovery 가 건다.
import { isSelfNode, nodeRpc, nodeSupports } from "../node/registry.js";
import { mintSessionHookToken, mintSessionMcpToken, revokeSessionHookToken, sessionHookTokenIds } from "./profiles.js";
import { SESSION_ID_RE } from "../org/auth/agent-identity.js";
import type { SessionInfo } from "./catalog.js";
import { logger } from "../log.js";

export const BACKFILL_RETRY_AFTER_MS = 10 * 60_000;

/** 바깥 의존(테스트 주입용) — 판정·순서는 이 모듈이, DB·노드 RPC 는 이들이. */
export interface BackfillDeps {
  isSelf: (nodeId: string) => boolean;
  supports: (nodeId: string) => boolean;
  /** 살아 있는 세션 훅 토큰이 걸린 세션 id 들(한 판에 한 번). */
  haveTokens: () => Promise<Set<string>>;
  mint: (owner: string, sessionId: string) => Promise<{ hook: string | null; mcp: string | null }>;
  /** 노드에 파일로 심는다 — 거절·오프라인이면 던진다. */
  push: (nodeId: string, sessionId: string, tokens: { hook: string | null; mcp: string | null }) => Promise<unknown>;
  revoke: (sessionId: string) => Promise<unknown>;
  now: () => number;
  retryAfterMs?: number;
}
export function defaultBackfillDeps(): BackfillDeps {
  return {
    isSelf: isSelfNode,
    supports: (nodeId) => nodeSupports(nodeId, "sessionTokens"),
    haveTokens: sessionHookTokenIds,
    mint: async (owner, id) => ({ hook: await mintSessionHookToken(owner, id).catch(() => null), mcp: await mintSessionMcpToken(owner, id).catch(() => null) }),
    push: (nodeId, id, t) => nodeRpc(nodeId, "sessionTokens", { id, hookToken: t.hook, mcpToken: t.mcp }),
    revoke: revokeSessionHookToken,
    now: Date.now,
  };
}

export interface BackfillResult { minted: number; skipped: number; revoked: number; failed: number }

/** 스냅샷 한 판을 처리하는 기계 — 프로세스에 하나(기억: 처리한 세션·실패 시각·여기서 심은 세션). */
export function createNodeSessionTokenBackfill(deps: BackfillDeps = defaultBackfillDeps()) {
  const done = new Set<string>();                         // `${nodeId}|${id}` — 확인했다(실었거나 건너뛰었다)
  const failedAt = new Map<string, number>();             // 같은 키 — 마지막 실패 시각(백오프)
  const minted = new Map<string, Set<string>>();          // nodeId → 여기서 심은 세션 id 들(사라지면 거둔다)
  const key = (nodeId: string, id: string): string => `${nodeId}|${id}`;
  const retryAfter = deps.retryAfterMs ?? BACKFILL_RETRY_AFTER_MS;

  async function run(nodeId: string, sessions: SessionInfo[]): Promise<BackfillResult> {
    const out: BackfillResult = { minted: 0, skipped: 0, revoked: 0, failed: 0 };
    if (deps.isSelf(nodeId)) return out;
    const live = sessions.filter((s) => s && typeof s.id === "string" && SESSION_ID_RE.test(s.id));
    const liveIds = new Set(live.map((s) => s.id));
    // ① 여기서 심었는데 사라진 세션 — 거둔다(스냅샷은 그 노드의 전체 목록이다).
    const mine = minted.get(nodeId);
    if (mine) {
      for (const id of [...mine]) {
        if (liveIds.has(id)) continue;
        mine.delete(id); done.delete(key(nodeId, id));
        try { await deps.revoke(id); out.revoked++; }
        catch (e) { logger.warn({ node: nodeId, id, err: (e as Error)?.message || String(e) }, "사라진 노드 세션의 토큰 회수 실패(비치명)"); }
      }
    }
    // ② 아직 못 하는 노드 — 기억하지 않는다(번들이 갱신되면 다음 판에 심는다).
    if (!deps.supports(nodeId)) return out;
    const now = deps.now();
    const cands = live.filter((s) => {
      const k = key(nodeId, s.id);
      if (done.has(k)) return false;
      const f = failedAt.get(k);
      return !(f !== undefined && now - f < retryAfter);
    });
    if (!cands.length) return out;
    let have: Set<string>;
    try { have = await deps.haveTokens(); }
    catch (e) { logger.warn({ node: nodeId, err: (e as Error)?.message || String(e) }, "세션 토큰 목록 조회 실패 — 다음 스냅샷에 다시"); return out; }
    for (const s of cands) {
      const k = key(nodeId, s.id);
      if (have.has(s.id)) { done.add(k); out.skipped++; continue; }          // preissue 로 뜬 세션 — env 에 이미 있다
      const owner = String(s.owner || "").trim();
      if (!owner) { done.add(k); out.skipped++; continue; }                  // 주인을 모르면 누구 앞으로 구울지 없다
      let tokens: { hook: string | null; mcp: string | null };
      try { tokens = await deps.mint(owner, s.id); }
      catch (e) { failedAt.set(k, now); out.failed++; logger.warn({ node: nodeId, id: s.id, err: (e as Error)?.message || String(e) }, "노드 세션 토큰 민팅 실패"); continue; }
      if (!tokens.hook && !tokens.mcp) { done.add(k); out.skipped++; continue; }   // 멤버 디렉터리에 없는 주인(에이전트 등) — 실을 것이 없다
      try {
        await deps.push(nodeId, s.id, tokens);
        done.add(k); failedAt.delete(k);
        if (!minted.has(nodeId)) minted.set(nodeId, new Set());
        minted.get(nodeId)!.add(s.id);
        out.minted++;
      } catch (e) {
        failedAt.set(k, now); out.failed++;
        try { await deps.revoke(s.id); } catch { /* 회수 실패는 다음 민팅이 옛 라벨을 죽인다 */ }
        logger.warn({ node: nodeId, id: s.id, err: (e as Error)?.message || String(e) }, "노드에 세션 토큰을 못 심었다 — 거두고 잠시 뒤 다시");
      }
    }
    if (out.minted) logger.info({ node: nodeId, ...out }, "살아 있는 노드 세션에 세션 토큰을 심었다(#4135 되채우기)");
    return out;
  }

  return { run };
}

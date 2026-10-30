// terminal/node-session-preissue.ts — **게이트웨이 전용**: 노드에 create 를 relay 하기 **전에** 세션 id 를 정하고 그 id 로
//  훅·MCP 토큰을 구워 input 에 싣는다. (#4135)
//
//  ── 왜 ──
//  createSession(sessions.ts)은 id 를 정한 자리에서 mintSessionHookToken·mintSessionMcpToken 을 굽는다. 노드 세션은 그 코드가
//  **노드 에이전트에서** 돌아 DB 가 없다 → 둘 다 null → LIVELY_TOKEN·LIVELY_MCP_TOKEN 미주입. 그러면 훅은 `~/.lively/token`
//  (= 그 PC 에 키트를 깐 사람)으로 나가고, 게이트웨이의 owner 게이트(sessionProjectContext → executionSessionProject(id, me))가
//  그 세션을 «남의 것» 으로 보아 found:false 를 답한다 → project-push·pull·AGENTS 주입·세션 이름짓기가 **그 멤버의 노드 세션에선
//  전부** 안 된다. 키트를 깐 사람의 세션만 된다.
//  실측 2026-09-25(공유 맥미니 laibeulliui-macmini): 원준 세션 셋 모두 LIVELY_TOKEN 없음 · project-context found:false ·
//  상민(키트 설치자) 세션은 found:true. 훅을 프로필에 심어도(profile-kit-seed) 이 신원 때문에 자료 업싱크가 끝내 안 됐다.
//
//  ── 어떻게 ──
//  정책은 게이트웨이, 노드는 기계적 실행(catalog.ts hostProfile 과 같은 규약). 게이트웨이가 id 를 미리 정하고(sessionPrefix
//  규칙 그대로) 그 id 로 토큰을 구워 `input.preissued` 에 싣는다. 노드의 createSession 은 acceptPreissuedId 가 받아 주는 id 면
//  그 id·토큰을 그대로 쓴다(받아 주지 않으면 종전대로 — 무회귀). 회수는 게이트웨이가 그 세션을 죽일 때(routes DELETE)
//  revokeSessionHookToken 으로 한다 — 같은 id 로 다시 구우면 mint 가 옛것을 먼저 죽인다.
//  ── 노출면(리뷰 지적, 설계로 받아들인 것) ──
//  공유 노드(hostProfile=false)에선 요청자의 세션 토큰이 **남의 PC 의 pane env** 에 실린다 — 그 PC 주인은 프로세스 env 를 읽을 수
//  있다. 종전(요청자가 설치자 신원으로 오동작)보다 낫고, 노드 공유는 주인이 켜는 명시적 신뢰다(node-access 머리말 «공유를 켜고
//  쓰면 된다 — 배지·감사로 드러난다»). 훅 토큰은 세션 최소권한(위험 scope 제외), MCP 토큰은 멤버 추종·세션 라벨이라 회수된다.
//  relay 페이로드(nodeRpc)는 args 를 로그에 찍지 않는다(registry.ts nodeRpc — JSON 전송만) — 토큰은 로그에 남지 않는다.
//  ⚠ 이 모듈은 노드 에이전트 번들에 들어가면 안 된다(DB 를 문다) — routes·session-launch 만 부른다(node-session-state 와 같은 경계).
import crypto from "node:crypto";
import type { LivelyUser } from "../context.js";
import type { CreateInput, SessionInfo } from "./catalog.js";
import { sessionPrefix } from "./session-id.js";
import { mintSessionHookToken, mintSessionMcpToken, revokeSessionHookToken, ownerId } from "./profiles.js";
import { logger } from "../log.js";

/** 바깥 의존(테스트 주입용) — 민팅·회수는 DB 다. `sessionId` 는 곧 만들 세션의 id(토큰 라벨). */
export interface PreissueDeps {
  mintHook: (memberId: string, sessionId: string) => Promise<string | null>;
  mintMcp: (memberId: string, sessionId: string) => Promise<string | null>;
  /** 그 세션 id 로 구운 훅·MCP 토큰 **둘 다** 거둔다(profiles.revokeSessionHookToken — 이름과 달리 둘을 본다). */
  revoke: (sessionId: string) => Promise<unknown>;
}
const defaultDeps = (): PreissueDeps => ({ mintHook: mintSessionHookToken, mintMcp: mintSessionMcpToken, revoke: revokeSessionHookToken });

/**
 * relay 직전의 input → id·토큰이 실린 input. 민팅이 던지거나 null 이면 그 토큰만 null(세션은 뜬다 — 훅은 종전 신원으로 떨어진다).
 *  `user` 는 relay 에 실어 보내는 그 사용자 객체와 **같은 것**이어야 한다(`{ userId }`) — 접두어(sessionPrefix → userSlug)가
 *  양쪽에서 같은 재료로 나온다. 클라이언트 본문에서 온 preissued 는 여기서 **덮인다**(사람이 id·토큰을 고를 수 없다).
 */
export async function preissueNodeSession(user: LivelyUser, input: CreateInput, deps: PreissueDeps = defaultDeps()): Promise<CreateInput> {
  const id = `${sessionPrefix(user)}${crypto.randomBytes(4).toString("hex")}`;
  const member = ownerId(user);
  //  차례로 굽는다(중앙 경로 createSession 과 같은 순서) — 민터가 동기로 던지든 거부하든 그 토큰만 null.
  const mint = async (fn: PreissueDeps["mintHook"]): Promise<string | null> => { try { return await fn(member, id); } catch { return null; } };
  const hookToken = await mint(deps.mintHook);
  const mcpToken = await mint(deps.mintMcp);
  return { ...input, preissued: { id, hookToken, mcpToken } };
}

/**
 * preissue → relay → 정산, 한 벌. relay 가 실패하면(노드 오프라인·타임아웃·거절) 구운 토큰을 **바로 거둔다** — 세션이 없으니
 *  DELETE 가 거둘 기회도 없다. 노드가 id 를 안 받아 다른 id 로 띄웠으면(옛 노드 번들·접두어 불일치) 그 토큰은 쓸 데가 없으니
 *  역시 거둔다(세션은 종전 신원으로 뜬다 — 무회귀). 회수 실패는 비치명(로그).
 */
export async function withPreissuedIdentity(
  user: LivelyUser, input: CreateInput, relay: (created: CreateInput) => Promise<SessionInfo>, deps: PreissueDeps = defaultDeps(),
): Promise<SessionInfo> {
  const created = await preissueNodeSession(user, input, deps);
  const id = created.preissued!.id;
  const drop = async (why: string): Promise<void> => {
    try { await deps.revoke(id); } catch (e) { logger.warn({ id, why, err: (e as Error)?.message || String(e) }, "노드 세션 preissued 토큰 회수 실패(비치명)"); }
  };
  let session: SessionInfo;
  try { session = await relay(created); }
  catch (e) { await drop("relay 실패"); throw e; }
  if (session.id !== id) await drop(`노드가 다른 id 로 띄움(${session.id})`);
  return session;
}

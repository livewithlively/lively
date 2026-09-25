// session-creds.ts — 노드 세션의 «그 세션 주인» 신원 봉투(#4233).
//
//  ── 왜 ──────────────────────────────────────────────────────────────────────
//  공유 홈 박스에서 세션 pane 의 훅·MCP 는 env(LIVELY_TOKEN·LIVELY_MCP_TOKEN)가 없으면 공용 `~/.lively/token`
//   (= 키트를 깐 사람)으로 서버에 묻는다. 중앙 박스는 createSession 이 그 자리에서 세션 주인 토큰을 구워 실었다
//   (#1719 후속 · #2234 — profiles.mintSessionHookToken 머리말). 그런데 **노드 세션**은 createSession 이 노드에서
//   돌고 노드엔 DB 가 없어('DB 없음' 계약) 발급이 조용히 실패했고, pane 은 공용 토큰으로 떨어졌다.
//  실측(2026-09-25, 노드 laibeulliui-macmini · 매니지드 lively-46e3): `~/.lively/token` = yoon 인데 세션은
//   box-wonjoon-jang-*. 서버의 소속 조회(execution_session WHERE id AND owner)가 요청자=yoon 으로 걸러
//   `project-context` 가 found:false → 프로젝트 AGENTS.md 주입 없음 · «프로젝트에 안 붙어 있다» 오안내 ·
//   project-push/pull 무동작(세션이 만든 파일이 곁칸 [자료]에 영영 안 뜸) · session_rename 403 · MCP 는 남의 신원.
//   8/27 에 같은 박스에서 고친 증상(#2234)이 그 박스가 노드가 되면서 되살아난 것이다.
//
//  ── 어떻게 ──────────────────────────────────────────────────────────────────
//  **게이트웨이가** 세션 id 를 먼저 정하고, 그 id 로 세션 주인 토큰 둘을 구워 노드 릴레이 create 에 싣는다
//   (앱 세션 input.appSession 과 같은 수법 — 게이트웨이가 DB 로 준비하고 노드는 기계적으로 쓴다).
//   id 를 게이트웨이가 정하는 이유: 토큰 이름표가 세션 id(`session-hooks:<id>`)라서 kill 때 그 이름으로 회수한다.
//   노드가 id 를 정하면 발급 시점에 이름표를 못 붙인다.
//  무회귀: 봉투를 모르는 옛 노드는 필드를 무시하고 제 id 로 만든다 → 게이트웨이가 id 불일치를 보고 방금 구운
//   토큰을 즉시 회수한다(어느 pane 에도 안 실렸다) → 종전 동작(공용 토큰) 그대로.
//
//  ⚠ 이 모듈은 **순수**다 — 노드 에이전트 번들에도 실린다(scripts/node-agent-allowed-modules.json).
//   DB 를 타는 발급·회수는 호출자(session-launch.ts, 게이트웨이)가 deps 로 넣는다.
//  ⚠ 봉투는 HTTP body 에서 받지 않는다(sessionInputFromBody 는 이 필드를 읽지 않는다 — 시험이 소스로 잰다).
//   노드 릴레이(게이트웨이 → 노드, 인증된 노드 채널)로만 온다.
import { SESSION_ID_RE } from "../org/auth/agent-identity.js";
import type { CreateInput, SessionInfo } from "./catalog.js";

/** 게이트웨이가 준비한 노드 세션 신원 봉투. */
export interface PreparedSessionCreds {
  /** 게이트웨이가 정한 세션 id — 노드는 형식·주인 접두가 맞을 때만 이 id 로 만든다(presetSessionId). */
  id: string;
  /** 훅 신원(세션 최소권한 — admin/runtime 제외) → pane env LIVELY_TOKEN. 없으면 공용 토큰(종전). */
  hookToken?: string | null;
  /** MCP 신원(그 멤버 권한 추종) → pane env LIVELY_MCP_TOKEN. 없으면 공용 토큰(종전). */
  mcpToken?: string | null;
}

// 토큰은 org/store/tokens.mintToken 이 `lvk_` + base64url 로 굽는다. 그 문자만 받는다 —
//  tmux `-e NAME=값` 의 값에 개행·공백이 섞이면 env 한 줄이 둘로 갈리거나 잘린다.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,512}$/;
export const isSafeSessionToken = (t: unknown): t is string => typeof t === "string" && TOKEN_RE.test(t);

/**
 * 노드: 봉투의 id 를 이 세션 id 로 써도 되나 — 이 주인의 접두(`box-<slug>-`)와 세션 id 형식이 맞을 때만.
 *  맞지 않으면 null → 호출자가 종전대로 제 id 를 만든다(그러면 게이트웨이가 불일치를 보고 토큰을 회수한다).
 */
export function presetSessionId(prefix: string, creds: PreparedSessionCreds | null | undefined): string | null {
  const id = creds && typeof creds.id === "string" ? creds.id : "";
  if (!id || !prefix || !id.startsWith(prefix) || !SESSION_ID_RE.test(id)) return null;
  return id;
}

/** 노드: 이 세션(id)의 pane 에 실을 `-e` 인자. 봉투가 다른 세션 것이거나 값이 이상하면 그 값은 안 싣는다. */
export function sessionCredsEnvArgs(creds: PreparedSessionCreds | null | undefined, id: string): string[] {
  if (!creds || creds.id !== id) return [];
  const out: string[] = [];
  if (isSafeSessionToken(creds.hookToken)) out.push("-e", `LIVELY_TOKEN=${creds.hookToken}`);
  if (isSafeSessionToken(creds.mcpToken)) out.push("-e", `LIVELY_MCP_TOKEN=${creds.mcpToken}`);
  return out;
}

// ── 게이트웨이 쪽 — 봉투를 굽고, 노드에 create 를 릴레이하고, 결과를 맞춰 본다 ──────────────────────

/** DB·릴레이를 타는 부분 — 호출자(session-launch.ts)가 넣는다. 시험은 가짜를 넣는다. */
export interface NodeSessionCredsDeps {
  /** 새 세션 id(주인 접두 + 8 hex) — sessions.ts 가 노드에서 만들던 것과 같은 모양. */
  newId(ownerId: string): string;
  mintHook(ownerId: string, id: string): Promise<string | null>;
  mintMcp(ownerId: string, id: string): Promise<string | null>;
  /** 그 세션 id 이름표의 훅·MCP 토큰을 전부 회수한다(profiles.revokeSessionHookToken). */
  revoke(id: string): Promise<unknown>;
  relay(nodeId: string, op: string, args: Record<string, unknown>): Promise<SessionInfo>;
  warn(msg: string, meta: Record<string, unknown>): void;
}

/**
 * 게이트웨이: 이 노드 세션의 신원 봉투를 굽는다. 실을 것이 없으면 null(= 노드가 id 를 정하는 종전 경로).
 *  hostProfile(#1541) — 그 PC 주인이 자기 PC 에서 여는 세션이다. 그 PC 의 `~/.lively/token` 이 곧 본인 것이라
 *   덮을 이유가 없고, 덮으면 본인 토큰보다 좁은 세션 최소권한이 훅에 걸린다 → 굽지 않는다(종전 그대로).
 *  발급 실패는 삼킨다 — 세션 생성을 막지 않는다(best-effort, 중앙 경로와 같은 등급).
 */
export async function prepareNodeSessionCreds(
  ownerId: string, hostProfile: boolean, deps: NodeSessionCredsDeps,
): Promise<PreparedSessionCreds | null> {
  if (hostProfile || !ownerId) return null;
  const id = deps.newId(ownerId);
  const [hookToken, mcpToken] = await Promise.all([
    deps.mintHook(ownerId, id).catch(() => null),
    deps.mintMcp(ownerId, id).catch(() => null),
  ]);
  if (!hookToken && !mcpToken) return null;
  return { id, hookToken: hookToken || null, mcpToken: mcpToken || null };
}

/**
 * 게이트웨이: 노드에 세션 create 를 릴레이한다 — **노드 세션을 만드는 모든 입구(새 세션·하네스 전환·복원)의 한 길**.
 *  봉투를 싣고, 릴레이가 실패하거나 노드가 봉투의 id 를 안 썼으면(옛 노드) 방금 구운 토큰을 즉시 회수한다.
 *  ⚠ 입구마다 relayNodeOp(…"create"…) 를 따로 부르지 마라 — 한 입구만 봉투를 빠뜨리면 그 입구로 연 세션만
 *   조용히 남의 신원이 된다(시험이 routes.ts·session-launch.ts 소스에서 직접 릴레이를 잰다).
 */
export async function relayCreateNodeSession(
  nodeId: string, op: string, ownerId: string, input: CreateInput,
  extra: { hostProfile: boolean; invites: string[] }, deps: NodeSessionCredsDeps,
): Promise<SessionInfo> {
  const creds = await prepareNodeSessionCreds(ownerId, extra.hostProfile, deps);
  let session: SessionInfo;
  try {
    session = await deps.relay(nodeId, op, {
      user: { userId: ownerId },
      input: { ...input, invites: [], hostProfile: extra.hostProfile, ...(creds ? { sessionCreds: creds } : {}) },
      invites: extra.invites,
    });
  } catch (e) {
    if (creds) await deps.revoke(creds.id).catch(() => { /* 회수 실패 — 그 id 로 다시 구울 때 옛 것을 죽인다 */ });
    throw e;
  }
  if (creds && session.id !== creds.id) {
    //  옛 노드(봉투를 모른다) — 제 id 로 만들었고 토큰은 어느 pane 에도 안 실렸다. 살려 둘 이유가 없다.
    await deps.revoke(creds.id).catch(() => { /* 위와 같음 */ });
    deps.warn("노드가 세션 신원 봉투를 쓰지 않았다(옛 노드) — 구운 토큰을 회수하고 공용 토큰으로 둔다", { nodeId, preset: creds.id, id: session.id });
  }
  return session;
}

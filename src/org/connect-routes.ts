// 외부 앱 연결의 «길» 판정 — 순수(#4970). org_connect_status 가 앱마다 이 표를 돌린다.
//
//  결정(윤상민 2026-10-23): 앱마다 연결할 수 있는 길을 우선순위대로 —
//   A 이미 연결된 길(규칙) → B 라이블리 앱(app) → C 구성원 AI 커넥터(ai) → D 키·토큰(token) → F 밀어 넣기 → E 파일.
//   F·E 는 앱마다 같은 길이라 여기 없다(입구 스킬·화면이 «목록에 없는 앱» 에서 말한다).
//  분기는 배포 방식이 아니라 **길마다 지금 상태** 다. 배포 차이는 B 의 «앱을 누가 쥐나»(heldBy) 하나로만 들어온다 —
//   라이블리가 쥐면(매니지드) 미준비는 «준비 중», 회사가 쥐면(셀프호스트) 미준비는 «앱 등록»(관리자) · «관리자에게 요청».
//  화면과 스킬은 이 결과만 읽는다 — 같은 판정을 두 벌로 두면 한쪽만 고쳐져 갈린다(connect-next.ts 와 같은 이유).
import type { AiConnectorStatus } from "./store/member-ai-connectors.js";

export type RouteKind = "app" | "ai" | "token";
/**
 * 길의 지금 상태.
 *  app: collecting · set_scope · connect · register · ask_admin · preparing
 *  ai: connected · reconnect · connect · off
 *  token: collecting · set_scope · connect
 */
export type RouteState =
  | "collecting" | "set_scope" | "connect" | "register" | "ask_admin" | "preparing"
  | "connected" | "reconnect" | "off";

export interface ConnectRoute {
  kind: RouteKind;
  state: RouteState;
  /** ai 길일 때 그 Claude 커넥터의 앱 키(slack · gmail · notion) — 구글은 지메일만 모은다. */
  ai_app?: string;
  /**
   * 그 길을 시작하기 전에 먼저 할 일 — 화면이 첫 단추를 고르고 스킬이 첫 걸음을 고른다.
   *  claude_login = 서버가 이 사람의 Claude 로그인을 확인하지 못했다(마지막 확인이 not-logged-in · not-claude-ai-login).
   *   Claude 에 커넥터를 연결해도 서버의 수집 실행이 그 로그인으로 읽으므로, 로그인부터 해야 한다.
   */
  needs?: "claude_login";
}

export interface AppRouteFacts {
  /** B — 라이블리 앱(OAuth 앱으로 공식 API). 없는 앱은 생략. */
  app?: {
    /** 앱 등록이 끝났는가(매니지드 = 라이블리 클라우드가 쥔 앱 · 셀프호스트 = 금고에 회사 앱). */
    ready: boolean;
    /** 그 앱을 누가 쥐나 — lively(매니지드) | workspace(셀프호스트). 배포 차이는 여기 하나로만 들어온다. */
    heldBy: "lively" | "workspace";
    /** 이 사람이 회사 앱을 등록할 수 있는가. */
    canRegister: boolean;
    /** 이 사람이 수집을 켜고 범위를 정할 수 있는가. */
    canCollect: boolean;
    /** 이 사람이(그 앱이 워크스페이스 단위 연결이면 워크스페이스가) 이 길로 연결했는가. */
    meConnected: boolean;
    /** 이 길로 이미 모으고 있는가(누구의 연결이든). */
    collecting: boolean;
  };
  /** C — 구성원 Claude 커넥터(수집은 슬랙·지메일·노션만). 없는 앱은 생략. */
  ai?: {
    aiApp: string;
    /** 워크스페이스 정책 — allowed 가 아니면(못 읽음 포함) 쓰지 않는다(fail-closed, T6). */
    policy: "allowed" | "blocked" | "unknown";
    /** 이 사람의 그 커넥터 상태. 기록이 없거나 못 읽었으면 null. */
    mine: AiConnectorStatus | null;
    /** 서버에서 이 사람의 Claude 로그인 — 마지막 확인 기준. false = 로그인이 없다 · null = 모른다(확인한 적 없음 · 다른 사유로 실패). */
    login?: boolean | null;
  };
  /** D — 개인 토큰·API 키. 없는 앱은 생략. */
  token?: {
    canCollect: boolean;
    meConnected: boolean;
    collecting: boolean;
  };
}

export function appRouteState(f: NonNullable<AppRouteFacts["app"]>): RouteState {
  if (!f.ready) {
    if (f.heldBy === "lively") return "preparing";        // 앱 키는 라이블리 클라우드가 쥔다 — 구성원에게 «앱을 등록하세요» 를 내밀지 않는다
    return f.canRegister ? "register" : "ask_admin";
  }
  if (f.collecting) return "collecting";                  // 팀 수집기는 켠 한 사람의 연결로 돈다 — 다른 사람이 다시 연결할 필요가 없다
  if (!f.meConnected) return "connect";
  return f.canCollect ? "set_scope" : "ask_admin";
}

export function aiRouteState(f: NonNullable<AppRouteFacts["ai"]>): RouteState {
  if (f.policy !== "allowed") return "off";
  if (f.mine === "connected") return "connected";
  if (f.mine === "needs-auth" || f.mine === "failed") return "reconnect";
  return "connect";                                       // 없음 · 끊음 · 아직 모름 — 권해도 해롭지 않다(사람이 Claude 에서 연결하면 다음 확인에 보인다)
}

export function tokenRouteState(f: NonNullable<AppRouteFacts["token"]>): RouteState {
  if (f.collecting) return "collecting";
  if (!f.meConnected) return "connect";
  return f.canCollect ? "set_scope" : "ask_admin";
}

/** 막힌 길 — 이 사람이 지금 할 수 있는 일이 없는 상태(남이 해야 하거나 꺼져 있다). */
const BLOCKED: ReadonlySet<RouteState> = new Set(["ask_admin", "preparing", "off"]);
/** 이미 연결된 길 — 다시 연결하라고 하지 않는다(A 규칙). */
const LINKED: ReadonlySet<RouteState> = new Set(["connected", "set_scope", "reconnect"]);
/** 이 사람이 지금 할 수 있는 새 연결. */
const ACTIONABLE: ReadonlySet<RouteState> = new Set(["connect", "register"]);

export interface RoutesDecision {
  routes: ConnectRoute[];
  /** 권하는 길 — routes 의 자리. 길이 하나도 없으면 -1. */
  recommended: number;
  /** 권하는 길보다 앞에 있는 막힌 길들(자리) — «관리자에게 요청» · «라이블리가 준비 중» 을 함께 말하려고. */
  blocked_before: number[];
}

/**
 * 앱 하나의 길 목록과 권하는 길.
 *  1. 수집 중인 길(앞의 것) — 같은 자료를 두 길로 겹쳐 모으지 않는다(T9 수집 단위 표: 라이블리 수집기가 1순위).
 *  2. 이미 연결된 길(앞의 것) — A 규칙.
 *  3. 이 사람이 지금 할 수 있는 길(앞의 것).
 *  4. 모두 막혔으면 첫 길 — 막힌 사정을 말하려고.
 */
export function decideRoutes(f: AppRouteFacts): RoutesDecision {
  const routes: ConnectRoute[] = [];
  if (f.app) routes.push({ kind: "app", state: appRouteState(f.app) });
  if (f.ai) {
    const state = aiRouteState(f.ai);
    //  연결이 필요한 때만 로그인을 먼저 말한다 — 이미 «연결됨» 이면 그 기록이 앞선 확인이어도 사람에게 할 일을 늘리지 않는다.
    const needs = (state === "connect" || state === "reconnect") && f.ai.login === false ? { needs: "claude_login" as const } : {};
    routes.push({ kind: "ai", state, ai_app: f.ai.aiApp, ...needs });
  }
  if (f.token) routes.push({ kind: "token", state: tokenRouteState(f.token) });
  if (!routes.length) return { routes, recommended: -1, blocked_before: [] };
  const first = (pred: (r: ConnectRoute) => boolean): number => routes.findIndex(pred);
  let rec = first((r) => r.state === "collecting");
  if (rec < 0) rec = first((r) => LINKED.has(r.state));
  if (rec < 0) rec = first((r) => ACTIONABLE.has(r.state));
  if (rec < 0) rec = 0;
  const blocked_before = routes.slice(0, rec).map((r, i) => (BLOCKED.has(r.state) ? i : -1)).filter((i) => i >= 0);
  return { routes, recommended: rec, blocked_before };
}

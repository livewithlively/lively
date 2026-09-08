// 세션 생성의 **단일 관문**(#3626 후속, 2026-09-08) — 홈(POST /api/ui/terminal/sessions)과 프로젝트
//  (POST /api/ui/{v6/,}projects/:id/sessions)가 여기 한 곳을 지난다.
//
//  왜 한 곳인가 — 두 라우트가 «같은 일»을 각자 적어 두었고, 그 사본이 갈라진 자리에서 사고가 났다:
//   · 홈만 화면 테마(`x-lively-theme` 헤더)를 CreateInput.theme 으로 옮겼다. 그 값이 claude 의
//     `--settings {"theme":"dark"}` 인자가 되는데, 윈도우 노드의 psmux 는 따옴표가 든 토큰을 못 나른다
//     (catalog.ts psmuxUnsafeToken 머리말). 그래서 **홈에서 연 세션만** 그 PC 에서 즉사했고 프로젝트를 고르고 연
//     세션은 멀쩡했다(상민님 신고 2026-09-08 · hammurabi 실측: 같은 요청에 헤더만 붙이면 4410 session-gone, 떼면
//     정상). 인자 자체의 고침은 catalog.ts(harnessSettingsArgv) 에 있고, 여기서는 **두 입구가 같은 입력을 만들게**
//     해 다음 갈림을 막는다 — 한쪽에만 있는 필드가 곧 한쪽에서만 나는 사고다.
//   · 프로젝트 경로는 앱 인스턴스 등록(registerSessionInstance)·워크스페이스 맵(recordSessionTenant)을
//     아예 안 밟았고, 노드 갈래의 게이트(assertNodeUsable vs requireCreatableNode)·오류 문구·앱 세션 거절
//     (assertAppSessionPlacement — relay 계약이 생긴 뒤에도 남아 있던 옛 400)도 따로였다.
//   · 응답 모양도 달랐다(홈만 chat·runtimeMode 를 실었다 — 화면은 그 값으로 첫 화면을 고른다).
//  라우트에 남는 것은 **그 입구만의 것** — 홈은 껍데기 프로젝트 선생성·개인 루트·body.invites·로그인 세션,
//   프로젝트는 폴더 봉쇄·멤버 초대 스냅샷·projectId. 나머지(공통 입력·노드/중앙 분기·사후 등록·응답)는 여기다.
//
//  ⚠ 이 파일은 게이트웨이 전용이다(DB·레지스트리를 만진다) — 노드 번들에 싣지 않는다.
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { sessionKindFromRequest } from "../sessions/session-kind.js";
import { createSession, killSession, normalizeCap, type CreateInput, type SessionInfo } from "./terminal-sessions.js";
import { normalizeTheme } from "./catalog.js";
import { autoTrustWorkspace } from "./session-create-guards.js";
import { mirrorNodeSession } from "./node-session-state.js";   // #1791 — 노드 세션 desired-state(정본 = DB, 게이트웨이가 쓴다)
import { chatIoCaps } from "./harness-io/adapter.js";           // #1746 — 하네스별 대화창 능력(읽기·승인)
import { codexChatMode } from "./codex-chat-mode.js";           // #2055 — codex 대화 런타임 선택
import { sessionRuntimeMode } from "./session-runtime-mode.js"; // #2439 — 세션 런타임 모드(terminal|chat)
import { sessionTerminalOnlyAxes } from "./harness-io/coverage.js";   // #2439 — 웹에서 못 하는 축
import { getNode } from "../node/store.js";
import { nodeOpenTo, nodeHostProfile } from "../node/node-access.js";
import { nodeRpc, nodeSupports, nodeOnline, isSelfNode, nodeAgentStale } from "../node/registry.js";
import type { NodeOp } from "../node/protocol.js";
import { nodeOfflineNote } from "../node/offline-note.js";      // #1849 — 오프라인 원인 추정 한 문장
import { translateNodeRpcError } from "../node/rpc-error.js";
import { bindNodeSessionProjectOrKill, injectDeferredFirstPrompt, nodeProjectCreatePlan } from "../node/provision-remote.js";
import { createAppInstance } from "../org/store/app-instances.js";   // 세션의 앱 인스턴스 정체성(#1954)
import { currentTenant } from "../org/tenant-context.js";
import { PRIMARY_TENANT_ID, setSessionWorkspace } from "../org/tenancy/registry.js";   // #1750 후속 — 세션→워크스페이스 정본
import { mintAppToken } from "../apps/principal.js";
import { prepareAppAssets } from "../apps/session-assets-gateway.js";   // #2165 — DB 를 타는 조각
import { gatewayUrl } from "../gateway-url.js";

const idOf = (u: LivelyUser): string => u.userId || u.email || "";

/** #1683 — 요청을 보낸 화면의 테마(해석된 dark|light). 헤더가 정본이고 바디는 폴백, 그 외엔 미지정(종전 동작). */
export function themeOf(req: { headers: Record<string, unknown> }, b: Record<string, unknown>): "dark" | "light" | undefined {
  return normalizeTheme(req.headers["x-lively-theme"]) ?? normalizeTheme(b.theme);
}

/**
 * 두 입구가 **같은 표로** 읽는 생성 요청 필드 — CreateInput 의 공통 부분(순수).
 *
 *  종전엔 홈·프로젝트 라우트가 body 를 각자 읽었고, 그래서 한쪽에만 있는 필드가 생겼다(theme·runtime·kind — 파일 머리말).
 *  입구 고유 필드는 호출자가 이 위에 덧붙인다: 홈 = rootKey·subpath(개인 루트)·invites·loginFor·loginProfile,
 *  프로젝트 = projectId·projectSrc·restrictRead·봉쇄된 subpath·rootKey "shared".
 *
 *  · kind(#2162) — HTTP 요청을 kind 로 옮기는 **유일한 경계**. 이후 모든 판정은 kind 하나만 본다(loginFor/appId 되짚기 금지).
 *  · harness — 비우면 createSession 이 400 으로 거절한다. 종전 프로젝트 라우트는 «셸» 로 접었는데, 그러면 하네스를
 *    빠뜨린 요청이 셸 세션이 되어 첫 지시가 **소리 없이 버려진다**(셸 세션엔 initialPrompt 가 없다). 잘못된 요청은 400 이 맞다.
 *  · writeVis(#1291 v2) — 안 읽으면 폼이 조용히 무시되고 사용자는 고른 대로 됐다고 믿는다. normalizeCap 이 모르는 값을
 *    null 로 접어 미지정(폴더 파생)으로 되돌린다.
 *  · runtime(#2439) — 이 세션만 대화 런타임으로 열기(모르는 값은 무시 → 배포 기본을 따른다).
 *  · theme(#1683) — 헤더가 정본(api() 가 모든 요청에 싣는다), 바디는 헤더를 못 싣는 경로(노드 relay 재생성 등)용 폴백.
 *  · initialPrompt — 하네스 입력창이 뜬 뒤 주입된다. cwd 는 rootKey/subpath 좌표이며 프로젝트 소속과 독립이다.
 *  · appId(#1780 D4) — 앱 세션. 존재·활성·grant 검증은 createSession(mintAppToken)이 하고 404/409/403 을 던진다.
 */
export function sessionInputFromBody(headers: Record<string, unknown>, b: Record<string, unknown>): CreateInput {
  return {
    label: String(b.label ?? ""),
    rootKey: String(b.rootKey ?? ""), subpath: String(b.subpath ?? ""),
    harness: String(b.harness ?? ""),
    flags: (b.flags && typeof b.flags === "object") ? b.flags as Record<string, unknown> : {},
    kind: sessionKindFromRequest(b),
    autoApprove: !!b.autoApprove,
    readOnly: !!b.readOnly,     // #1007 — 이 세션만 읽기전용(컨텍스트 스토어 쓰기 소거). 노드 세션도 relay 가 input 스프레드로 전파.
    incognito: !!b.incognito,   // #1007+ — 이 세션만 인코그니토(lively 전체 차단 + 훅 off). readOnly 보다 우선.
    writeVis: normalizeCap(b.writeVis as string) ?? undefined,
    runtime: b.runtime === "chat" ? "chat" : b.runtime === "terminal" ? "terminal" : undefined,
    theme: themeOf({ headers }, b),
    initialPrompt: typeof b.initialPrompt === "string" && b.initialPrompt.trim() ? b.initialPrompt.slice(0, 20_000) : undefined,
    appId: String(b.appId ?? "").trim() || undefined,
  };
}

/**
 * 세션이 섰다 — 그 세션의 **앱 인스턴스**를 세운다(#1954 후속 · #1780 v2.2 §2.5: 일반 세션 = ai-session 앱의 인스턴스).
 *  종전엔 웹에서 그 세션을 처음 열 때만 만들어져(lazy), CLI 로 띄우고 웹에서 안 연 세션은 인스턴스가 없었다 —
 *  그래서 좌측 목록이 '돌고 있는 세션'을 따로 훑어 그 구멍을 메워야 했다. 정체성은 세션이 태어날 때 정해진다.
 *  ⚠ 이 등록은 **게이트웨이에만** 있다 — sessions.ts(createSession)는 노드 에이전트 번들에 실리고 노드엔 DB 가 없다
 *   ('DB 없음' 계약, scripts/build-node-agent.mjs 화이트리스트). 그래서 박스·노드·핸드오프·복원이 공유하는 이 관문 한 곳에 둔다.
 *  subject 로 멱등하다(store createAppInstance) — 복원처럼 같은 세션이 다시 와도 하나다. 실패해도 세션은 산다.
 *  (#1631) export — 리브 킥오프(org/liv/kickoff.ts)가 서버에서 세션을 열 때 **같은 등록·바인딩**을 밟는다. 관문 밖에서
 *   세션을 여는 길이 생기면 이 둘을 반드시 함께 부른다(안 부르면 목록에 안 뜨고 primary 로 취급된다).
 */
export const registerSessionInstance = async (sessionId: string, owner: string, opts: { appId?: string | null; projectId?: number | null; title?: string | null }): Promise<void> => {
  await createAppInstance({ appId: opts.appId || "ai-session", owner, projectId: opts.projectId ?? null,
    subjectKind: "session", subjectRef: sessionId, title: opts.title || null })
    .catch((e) => logger.warn({ err: e, sessionId }, "앱 인스턴스 등록 실패(비치명) — 세션은 살아 있다"));
};

// 세션 → 워크스페이스 정본 기록(#1750 후속) — 헤더를 못 싣는 표면(SSE·iframe·WS·훅·구 kit)이
//  이 맵(gw_session_map)으로 컨텍스트를 되찾는다. primary(무컨텍스트)는 행을 안 만든다(부재 = primary).
//  ⚠ 기록 실패는 **생성 실패로 승격**한다: 맵 없는 secondary 세션은 이후 헤더 없는 요청이 전부
//  primary 로 오귀속된다 — dev 실측('다온')이 정확히 그 사고라, 조용히 넘기지 않는다.
export const recordSessionTenant = async (sessionId: string, killOnFail?: () => Promise<unknown>): Promise<void> => {
  const t = currentTenant();
  if (!t || t.id === PRIMARY_TENANT_ID) return;
  try { await setSessionWorkspace(sessionId, t.id); }
  catch (e) {
    logger.error({ err: e, sessionId, ws: t.slug }, "세션 워크스페이스 맵 기록 실패 — 세션을 되물리고 생성을 실패시킨다");
    if (killOnFail) await killOnFail().catch(() => { /* 되물림 실패 — 세션이 남지만 다음 요청도 같은 DB 라 대개 함께 죽어 있다 */ });
    throw new HttpError(500, "세션의 워크스페이스 소속을 기록하지 못했습니다 — 다시 시도하세요");
  }
};

// 노드 op 실패를 사용자에게 그대로 보여준다 — 노드측 예외(예: tmux 미설치 → spawn ENOENT)가 generic 500("internal_error")
//  으로 묻히면 원인 진단이 불가능하다(#869 haru 사례: 세션 생성 500 의 진짜 원인이 로그에만 있고 응답엔 안 나왔다).
//  오프라인·타임아웃은 전용 상태코드로, 그 외 노드측 오류는 502 로 메시지를 붙여 표면화한다.
//  (#1313 R46) 분기 캐스케이드는 node/rpc-error 의 translateNodeRpcError 로 수렴 — 이 사이트의 offline 판정은
//  **msg 동등성만**이다(provision-remote 쪽의 `|| !nodeOnline(nodeId)` 추가조건 없음). 상태코드·문구는 원문 그대로.
export async function relayNodeOp<T>(nodeId: string, op: NodeOp, args: Record<string, unknown>): Promise<T> {
  try {
    return await nodeRpc<T>(nodeId, op, args);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    // 낡은 번들 힌트(#1541) — op 은 있는데(기준선 create 등) 구현이 새 규약을 몰라 낯선 오류를 던지는 케이스가 있다
    //  (실측: sessionDir 이전 번들이 rootKey 빈 값으로 "허용되지 않은 루트입니다"). caps(#905 C4)로는 못 잡는 축이라,
    //  실패 시점에 "이 노드가 서빙 번들보다 낡았나"를 확인해 **다음 행동**(노드 재시작 → #1713 자가 갱신 부트스트랩)을 붙인다.
    //  판정 실패(DB 등)는 힌트 없이 원문 그대로 — 거짓 힌트가 더 나쁘다.
    const stale = await nodeAgentStale(nodeId).catch(() => false);
    const staleHint = stale ? " (이 노드의 프로그램이 오래된 버전입니다 — 그 PC 에서 노드를 다시 시작하면 최신으로 갱신되고, 그 뒤로는 자동으로 유지됩니다.)" : "";
    throw translateNodeRpcError(msg, {
      offline: "노드가 오프라인입니다 — 그 PC 의 lively 노드 연결을 확인하세요.",
      timeout: "노드 응답 시간 초과",
      // 미지원(#905 C4) — **실행 실패가 아니다.** 502 "노드에서 실행 실패"로 뭉개면 사용자는 뭔가 터진 줄 알고
      //  재시도하는데, 실제로는 그 노드 에이전트가 낡아 그 기능 자체가 없는 것이다. 할 일이 완전히 다르다.
      unsupported: (unsupportedOp) => `이 노드의 에이전트가 낡아 '${unsupportedOp}' 를 지원하지 않습니다 — 그 PC 에서 노드를 다시 설치·업데이트하세요.`,
      failed: (m) => `노드에서 실행 실패: ${m}${staleHint}`,
    });
  }
}

// 노드 세션 생성 게이트(#869) — 노드 실재·활성·연결 + **소유 또는 관리자 지정 공유**(#1540, nodeOpenTo).
//  초대는 호출자가 구성원 디렉터리로 검증해 노드엔 '검증된 목록'만 넘긴다(노드는 DB 가 없어 스스로 검증 불가 —
//  F7 정책/실행 분리).
//  ⚠ admin 우회를 **제거했다**(종전엔 관리자가 남의 개인 PC 에 세션을 열 수 있었다). 이 정책이 지키려는 게
//   정확히 '남의 컴퓨터에서 코드가 도는 것'이고, 그럴 사람은 대개 관리자다. 관리자는 공유를 켜고 쓰면 된다 —
//   그 편이 배지·감사로 드러난다. (#3626 — 프로젝트 입구도 이제 이 한 게이트를 지난다.)
//   노드 **관리**(토글·회전·삭제)의 admin 권한은 그대로다 — 관리 ≠ 사용.
export async function requireCreatableNode(requesterId: string, nodeId: string): Promise<void> {
  const n = await getNode(nodeId);
  if (!n || !n.enabled) throw new HttpError(404, `노드 없음: ${nodeId}`);
  // #2108 — 이 노드가 게이트웨이 자신이면 거절한다(피커에선 이미 빠졌고, 여기는 옛 화면·북마크·API 용).
  //  ⚠ 조용히 '중앙'으로 옮기지 않는다 — 노드와 박스는 같은 머신이어도 워크스페이스 뿌리가 다를 수 있어,
  //   말없이 옮기면 사람이 고른 것과 **다른 폴더**에서 세션이 열린다(#2022 가 세운 원칙: 모르면 멈춘다).
  if (isSelfNode(nodeId)) {
    throw new HttpError(409, `노드 '${nodeId}' 는 이 게이트웨이가 도는 바로 그 컴퓨터입니다 — 목록에서 '중앙 컴퓨터(기본)'를 고르세요. (그 컴퓨터에서 \`lively node stop\` 으로 노드 연결을 내리면 목록에서도 사라집니다)`);
  }
  if (!nodeOpenTo(n, requesterId)) {
    throw new HttpError(403, "본인이 등록한 노드가 아니고 공유 노드도 아닙니다 — 관리자가 공유 노드로 지정한 노드만 함께 쓸 수 있습니다");
  }
  // #1849 — 새 세션을 못 여는 것도 같은 뿌리다(실측: 사용자는 "세션도 안 열림"으로 겪었다).
  //  왜 오프라인인지 추정이 서면 함께 말한다 — 이 자리가 사용자가 실제로 막히는 지점이다.
  if (!nodeOnline(nodeId)) {
    const extra = await nodeOfflineNote(nodeId).catch(() => null);
    throw new HttpError(409, "노드가 오프라인입니다(에이전트 연결 대기)" + (extra ? `\n\n${extra}` : ""));
  }
}

/** 원격 ExecutionHost에는 조직 DB가 없다. 게이트웨이가 앱 권한·토큰·자산을 확정해 내부 봉투로 넘긴다. */
export async function prepareRemoteAppSession(input: CreateInput, memberId: string): Promise<CreateInput> {
  if (!input.appId) return input;
  // 자산 무결성을 먼저 확인한 뒤 토큰을 굽는다. 자산 오류 때문에 사용되지 않는 자격이 생기는 시간을 줄인다.
  const [assets, gw] = await Promise.all([prepareAppAssets(input.appId), gatewayUrl()]);
  const { token } = await mintAppToken(memberId, input.appId, "app-spawn-remote");
  return { ...input, appSession: { appId: input.appId, token, gatewayUrl: gw, assets } };
}

// #2055 — 세션 행의 «대화» 두 값을 **한 곳에서** 만든다. 목록과 생성 응답이 갈리면 방금 만든 세션만
//  화면이 잘못 열린다(실측 2026-08-28 신고: codex 를 열면 터미널이 먼저 뜨고 몇 초 뒤 대화창으로 넘어갔다 —
//  생성 응답에 chatMode 가 없어 화면이 «모르면 터미널» 로 추정했다가, 목록 갱신이 오면 되돌린 것이다).
//  ⚠ 세션 단위 모드(@box_runtime)는 **행을 만들 때 이미 읽혀** 있어야 한다 — 여기서 tmux 를
//   다시 물으면 목록 한 번에 세션 수만큼 왕복한다. 지금은 배포 기본 + 하네스·자리로만 판정하고,
//   세션 단위 값은 배달(deliver-prompt)이 본다. 둘이 갈리면 화면이 «대화창» 이라 하고 배달은
//   터미널로 가므로, 그 갈림이 없도록 기본이 chat 일 때만 세션 단위로 끌 수 있게 뒀다.
export const chatFieldsOf = (harness: string, onNode = false, choice?: "chat" | "terminal"): {
  chat: ReturnType<typeof chatIoCaps>;
  chatMode: ReturnType<typeof codexChatMode>;
  runtimeMode: ReturnType<typeof sessionRuntimeMode>;
  terminalOnly: string[];
} => ({
  chat: chatIoCaps(harness),                       // #1746 하네스별 대화창 능력(읽기·승인)
  chatMode: codexChatMode({ harness }),            // 이 세션의 대화가 어디서 도나 — app-server 면 pane 이 셸이다
  //  #2439 — 하네스 **무관**한 런타임 모드. chat 이면 작업·승인·슬래시가 이벤트로 오므로 화면이
  //   상태 통로(SSE)를 연다. terminal 이면 열지 않는다 — 올 것이 없는 연결을 세션마다 만들지 않는다.
  runtimeMode: sessionRuntimeMode({ harness, onNode, choice }),
  //  ★ #2439 — **이 하네스가 웹에서 못 하는 것들.** 화면이 그 자리에서 «터미널에서 하세요» 를
  //   정확히 말하기 위한 재료다. 이걸 안 주면 사람은 없는 기능을 찾아 헤매다 포기한다(막다른 길).
  //   빈 배열 = 이 하네스는 웹만으로 전부 된다.
  //  ⚠ 하네스 축만으로는 부족하다 — **노드 세션**은 대화 런타임이 아예 안 돈다(coverage 머리말).
  //   그 사실을 안 실으면 화면이 «웹에서 다 됩니다» 라고 거짓말한다.
  terminalOnly: sessionTerminalOnlyAxes(harness, onNode),
});
//  ⚠ 단건 경로(생성·조회)는 **이 박스에서 만든 세션**이다 — 노드 세션은 릴레이가 따로 답한다.
//   그래서 onNode=false 다. «node 필드가 있으면 노드» 로 읽으면 게이트웨이 박스가 노드로도
//   등록된 배포에서 여기서 잘 도는 세션이 화면에서 terminal 로 보인다(routes.ts tagChat 주석).
export const withChatFields = <T extends { harness?: string; runtimeChoice?: unknown }>(s: T, onNode = false): T =>
  Object.assign(s, chatFieldsOf(String(s.harness || ""), onNode,
    s.runtimeChoice === "chat" ? "chat" : s.runtimeChoice === "terminal" ? "terminal" : undefined));

export interface LaunchOpts {
  /** 실행 노드(#1744). '' = 중앙 컴퓨터(기본). 노드면 그 PC 에서 세션이 뜨고 첫 지시는 노드가 로컬로 넣는다. */
  nodeId: string;
  /**
   * 노드 세션의 **검증된** 초대 스냅샷 — 홈은 body.invites 를, 프로젝트는 현재 멤버(생성자∪팀원)를 validateInvites 로
   *  거른 것. 노드는 프로젝트 무지(DB 없음)라 owner∪invites 로만 가시성을 판정하므로, 이 스냅샷이 다른 멤버의
   *  공동입장을 성립시킨다(멤버십 변경은 세션 재생성 전까지 미반영 — 중앙 세션은 동적. 알려진 한계).
   *  중앙 세션은 쓰지 않는다 — createSession 이 input.invites 를 스스로 검증한다.
   */
  invites: string[];
}

/** 생성 응답의 세션 한 장 — 노드 세션이면 그 좌표(node)가 붙는다. */
//  ⚠ 노드 좌표는 목록 행(SessionInfo.node — id·name·online)과 달리 **id·online 만** 싣는다(종전 생성 응답 그대로 —
//   화면은 created-cache 로 이 한 장을 첫 그림에 쓰고, 이름은 목록 갱신이 채운다).
export type LaunchedSession = Omit<SessionInfo, "node"> & { node?: { id: string; online: boolean } };

/**
 * 세션을 **만들고 등록한다** — 두 입구의 공통 뒷일. 입력은 호출자가 sessionInputFromBody 위에 입구 고유 필드를 얹어 준다.
 *
 *  노드 갈래(그 PC 에서 뜬다):
 *   ① 게이트(requireCreatableNode) ② hostProfile(#1541 — member 노드 && 생성자=주인이면 그 PC 의 네이티브 하네스 설정 그대로;
 *   조회 실패 = false, 주입 유지) ③ 앱 세션이면 토큰·자산 선계산(prepareRemoteAppSession) ④ 프로젝트 세션이면 첫 지시를
 *   create 에서 떼어 **DB 소속을 쓴 뒤** 넣는다(#1867 nodeProjectCreatePlan — 안 그러면 노드의 첫 훅이 아직 없는 소속을
 *   보고 또 프로젝트를 만든다; 소속 없는 세션은 종전대로 create 가 바로 넣는다) ⑤ relay create ⑥ 워크스페이스 맵·앱 인스턴스
 *   ⑦ 프로젝트 소속 확정(bindNodeSessionProjectOrKill — 실패면 방금 만든 세션을 죽이고 503) ⑧ desired-state 미러(#1791 —
 *   정본은 게이트웨이가 쓴다, 노드엔 DB 가 없다. 죽어도 '복원 가능(그 노드)'로 남는 근거) ⑨ 보류한 첫 지시 주입(신뢰 대화상자
 *   자동 수락은 라이블리가 만든 자리에서만 — autoTrustWorkspace).
 *  중앙 갈래: createSession → 워크스페이스 맵 → 앱 인스턴스.
 */
export async function launchSession(user: LivelyUser, input: CreateInput, opts: LaunchOpts): Promise<LaunchedSession> {
  const me = idOf(user);
  const nodeId = String(opts.nodeId || "").trim();
  if (nodeId) {
    await requireCreatableNode(me, nodeId);
    const hostProfile = await getNode(nodeId).then((n) => !!n && nodeHostProfile(n, me)).catch(() => false);
    const remoteInput = await prepareRemoteAppSession(input, me);
    const op: NodeOp = input.appId ? "createAppSession" : "create";
    const plan = nodeProjectCreatePlan(remoteInput, !!input.projectId && nodeSupports(nodeId, "injectFirstPrompt"));
    const session = await relayNodeOp<SessionInfo>(nodeId, op, { user: { userId: me }, input: { ...plan.createInput, invites: [], hostProfile }, invites: opts.invites });
    await recordSessionTenant(session.id, () => relayNodeOp(nodeId, "kill", { user: { userId: me }, id: session.id }));
    await registerSessionInstance(session.id, me, { appId: input.appId, projectId: input.projectId, title: session.label });
    if (input.projectId && input.projectSrc !== "org") {
      await bindNodeSessionProjectOrKill({
        nodeId, sessionId: session.id, requester: me, harness: session.harness || input.harness, projectId: input.projectId,
      });
    }
    await mirrorNodeSession({ ...session, invites: opts.invites }, nodeId, input, me);
    if (plan.deferredPrompt) {
      await injectDeferredFirstPrompt({
        nodeId, sessionId: session.id, harness: session.harness || input.harness, text: plan.deferredPrompt,
        trustOk: autoTrustWorkspace({ projectId: input.projectId, subpath: input.subpath }),
      });
    }
    //  ★ 이 갈래는 **노드에 만든 세션**이다 — 그 기계에 산다(onNode=true).
    return { ...withChatFields(session, true), node: { id: nodeId, online: true } };
  }
  const session = await createSession(user, input);
  await recordSessionTenant(session.id, () => killSession(user, session.id, {}));
  await registerSessionInstance(session.id, me, { appId: input.appId, projectId: input.projectId, title: session.label });
  return withChatFields(session);
}

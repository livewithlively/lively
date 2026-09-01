// 중앙 박스 — 터미널 세션 매니저 정문. ([[central-box-design]] 경로 D: ttyd 대신 xterm.js+node-pty 깊은 통합)
// REST(/api/ui/terminal/*, Bearer) = 세션 목록·생성·이름변경·삭제 + 설정(루트·하네스 카탈로그).
// WS(/terminal/ws, ticket 쿠키) = PTY 스트림(terminal-pty.ts). 브라우저는 Authorization 헤더를 WS/네비에
// 못 실으므로, Bearer 로 인증된 멤버에게 HttpOnly 티켓 쿠키(userId 보유)를 발급해 WS 소유권 판정에 쓴다.
import { normalizeSessionKind, sessionKindFromRequest } from "../sessions/session-kind.js";
import type express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { sessionOrBearer } from "../auth/http-auth.js";
import type { BearerVerifier } from "../auth/bearer.js";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../http/rest-util.js";
import { codexChatMode } from "./codex-chat-mode.js";   // #2055 codex 대화 런타임 선택
import { aiLoginStep, isAiLoginHarness, parseAiLogin, type AiLoginHarness } from "./ai-login-flow.js";   // #2055 터미널 없는 AI 로그인
import { cancelAiLogin, pasteAiLogin, readAiLogin, startAiLogin } from "./ai-login-run.js";
import { logger } from "../log.js";
import { closeSessionAppInstances, createAppInstance } from "../org/store/app-instances.js";   // 세션의 앱 인스턴스 정체성(#1954)
import { publishNotify, sessionEventKey } from "../v6/notify-bus.js";
import { roots, HARNESSES, listSessions, listRestorableSessions, listSessionsRaw, createSession, killSession, editSession, canAttach, markSessionActive, isReportedPhase, getSessionLabel, getSessionProject, sessionDir, sessionGone, profileStatus, profileStatusFor, provisionProfile, provisionMemberOs, memberOsStatus, aiAccountStatus, aiAccountLogout, aiLoginCheck, sessionOsUser, harnessHasCredential, validateInvites, type SessionInfo, type CreateInput, normalizeCap } from "./terminal-sessions.js";
import { locateTranscript } from "./harness-io/locate.js";              // #1437 ② — 복원 정밀재개의 대화 존재 확인을 소유자 실행환경(중계)에서
import { transcriptFsFor } from "./harness-io/transcript-fs.js";        //  하기 위한 파사드(chat-routes 대화창과 같은 관문)
import { resolveSessionDir } from "../sessions/session-desired.js";
import { getSessionState, deleteSessionState, setClaudeSessionId, markSessionExited, markSessionSuperseded, resolveSessionSuccessor } from "../sessions/session-state.js";   // #2231 — 복원된 옛 id 는 지우지 않고 이정표로 남긴다
import { convIdFromTranscriptPath, mayForgetOldState, mappingReportStatus } from "../sessions/conv-mapping.js";   // #2122 — 복원이 대화 매핑을 잃지 않게 하는 순수 규칙 · #2151 — 매핑 보고 응답 규약 // #1059 E — restorable 세션 복원(+정밀 UUID 매핑·정상종료 표시)
import { currentTenant } from "../org/tenant-context.js";
import { PRIMARY_TENANT_ID, setSessionWorkspace, clearSessionWorkspace, sessionWorkspaceIds, sessionInWorkspace } from "../org/tenancy/registry.js"; // #1750 후속 — 세션→워크스페이스 정본 / #1875 목록 격리
import { listManagedSessions } from "../sessions/managed-sessions.js"; // #1059 F — 관리탭 세션목록에서 managed 표시(회수 제외)
import { mergeSessionViews } from "../sessions/session-merge.js"; // #1716 — 출처가 겹쳐도 세션 카드는 1장
import { sessionPrompts, searchPrompts, searchPromptsHybrid } from "./terminal-transcript.js";
import { activeEmbeddingProvider } from "../v6/search-util.js";
import { setupPtyUpgrade } from "./terminal-pty-upgrade.js";   // #2165 — 테넌시를 아는 업그레이드 핸들러는 게이트웨이 전용 모듈
import { type TicketLookup } from "./terminal-pty.js";
import { registerTerminalFiles } from "./terminal-files.js";
import { listMembers, getRuntimeConfig } from "../org/store.js";
import { isProjectSessionDir } from "../project/project-fs.js";
// #2116 — 죽은 세션 메타의 '남에게도 보이나' 판정을 다른 게이트와 **같은 술어**로 맞춘다(cwd 축).
const sharedByFolder = (dir: string): boolean => isProjectSessionDir(dir);
// 분산 노드(#869) — 원격 노드 세션의 목록 병합·CRUD 위임. 정책(소유·초대 검증)은 여기, 실행은 노드(F7).
import { nodeSessionsFor, nodeRpc, nodeSupports, nodeCanAttach, nodeOnline, nodeSessionGone, isSelfNode, liveNodes, nodeOfSession, nodeSessionHarness, nodeAgentStale } from "../node/registry.js";
import type { NodeSessionInfo } from "../node/registry.js";
import type { NodeOp } from "../node/protocol.js";
import { normalizeTheme } from "./catalog.js"; // #1683 테마 값 정규화(순수 — catalog 가 소유)
import { getNode, listNodes } from "../node/store.js";
import { nodeOfflineNote } from "../node/offline-note.js";   // #1849 — 오프라인 원인 추정 한 문장
import { nodeHarnesses } from "../node/protocol.js";   // #1713 — 노드별 하네스 가용성(미보고 → 기준선)
import { nodeOpenTo, nodeHostProfile } from "../node/node-access.js";
import { translateNodeRpcError } from "../node/rpc-error.js";
import { bindNodeSessionProjectOrKill, injectDeferredFirstPrompt, nodeProjectCreatePlan } from "../node/provision-remote.js";
import { createShellProject, firstPromptProjectPlan } from "../project/first-prompt-project.js";
import { autoTrustWorkspace } from "./session-create-guards.js";
import { registerNodeRoutes } from "../node/routes.js";
import { registerSessionChatRoutes } from "./chat-routes.js";   // #1719 — 세션 대화창(트랜스크립트 창 읽기·Enter/Esc)
import { mirrorNodeSession, decorateNodeRows } from "./node-session-state.js";   // #1791 — 노드 세션 desired-state(정본 = DB, 게이트웨이가 쓴다)
import { claudeSessionIdsFor, setNodeSessionMap, nodeSessionMapFor, setLastPrompt, lastPromptsFor, claimSessionLabel, updateSessionStateMeta } from "../sessions/session-state.js";   // #1719 라이브 행에 대화 uuid · #1752 노드 세션 매핑 · #2197 마지막 말
import { cleanLastPrompt } from "./last-prompt.js";
import { chatIoCaps, harnessIo } from "./harness-io/adapter.js";
import { sessionRuntimeMode } from "./session-runtime-mode.js";   // #2439 — 세션 런타임 모드(terminal|chat)                 // #1746 — 행에 대화창 능력(읽기·승인)
import { sessionTerminalOnlyAxes } from "./harness-io/coverage.js";        // #2439 — 웹에서 못 하는 축(화면이 «터미널에서» 를 정확히 말한다)
import { getOpt } from "./tmux-exec.js";                             // #1758 — 세션 하네스 폴백(@box_harness)
import { deadSessionMeta, nodeSessionMetaMode, nodeMetaRestorable } from "./session-meta.js";  // #1820 죽은 세션 '복원 가능' 단일 판정 + #2111 생사 갈래 + #2108 확답 게이트
import { registerSessionTrashRoutes } from "../sessions/session-trash-routes.js";   // #1851 — 세션 휴지통
import { trashMapFor } from "../sessions/session-trash.js";                        // #1851 — 목록 행에 휴지통 표식
import { sessionHandoffInput } from "./session-handoff.js";
import { mintAppToken } from "../apps/principal.js";
import { prepareAppAssets } from "../apps/session-assets-gateway.js";   // #2165 — DB 를 타는 조각
import { gatewayUrl } from "../gateway-url.js";

import { sessionHarnessKey } from "./deliver-prompt.js";   // #1683 후속2 — 정의는 deliver-prompt.ts(#1631 이동)

// #1437 ② — 복원이 `--resume <uuid>` 로 **정밀 재개**해도 되는가(그 대화 파일이 소유자가 읽을 자리에 실제로 있나).
//  왜 transcriptExists(terminal-transcript) 를 안 쓰나: 그건 게이트웨이 **로컬 fs** 를 stat 한다. 중계 배포(중앙 게이트웨이·
//  파일시스템 마운트 0)에서는 대화 파일이 실행 노드의 멤버 홈에 있어 로컬 stat 이 **항상 false** → precise=false →
//  복원이 늘 picker 로 떨어졌다(상민님 실측 2026-08-26: 복원했더니 claude 세션 선택창). 대화창(chat-routes)이 이미
//  같은 문제를 transcriptFsFor+locateTranscript 로 풀었으므로 **같은 관문**을 쓴다: 소유자 osUser 로 멤버 중계 stat,
//  단일호스트·격리 박스는 로컬 fs(종전과 동일 — seam 교리). 0바이트 파일은 없는 것으로 본다(claude 가 못 읽는다).
async function transcriptResumable(id: string, st: { harness?: string | null; dir?: string | null; owner?: string | null; transcript_path?: string | null }, uuid: string): Promise<boolean> {
  const io = harnessIo(st.harness || "claude");
  if (!io) return false;
  const tfs = transcriptFsFor(await sessionOsUser(id).catch(() => null));
  const found = await locateTranscript(
    io,
    { cwd: st.dir || "", convId: uuid, owner: st.owner || "", reportedPath: st.transcript_path || null },
    tfs.stat,
  );
  return !!found && found.size > 0;
}

// ── #2122 복원이 대화 매핑을 **잃지 않게** 하는 두 장치 ───────────────────────────────────────────────
//  배경: 복원은 새 세션을 만들고 옛 desired-state 행을 지운다. 매핑(claude_session_id)은 그 사이 carry-forward
//   한 번으로만 옮겨지는데, 종전엔 그게 **가드+베스트에포트**였다 — 소스가 이미 null 이면 건너뛰고, 이관이
//   0행/throw 로 실패해도 삼킨 뒤 **옛 행은 무조건 지웠다**. 그러면 매핑이 어디에도 안 남아 그 뒤 복원이
//   영원히 picker 로 떨어진다(실측 2026-08-26: 9442ed3d.claude_session_id=null — 대화 01985b13 은 멀쩡한데 picker).
//   박스 세션엔 노드 세션의 org_node_session_map 같은 **내구 사이드테이블이 없어** 옛 행이 매핑의 유일한 사본이다.

/** 매핑 승계를 **권위화**한다(#2122 ①) — 성공 여부를 돌려주고 순간 실패는 짧게 재시도한다. 호출자는 이 값이
 *  false 면 **옛 행을 지우지 않는다**(그게 매핑의 마지막 사본이다). 0행도 실패로 친다: 새 세션의 desired-state
 *  미러가 아직/영영 없다는 뜻이라(createSession 의 upsert 는 best-effort), 그 상태에서 옛 행을 지우면 증발한다. */
async function carryConvMapping(newId: string, convId: string, st: { owner: string; transcript_path?: string | null }): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 120 * attempt));
    const ok = await setClaudeSessionId(newId, convId, st.owner, st.transcript_path ?? null).catch(() => false);
    if (ok) return true;
  }
  return false;
}

/** #1683 — 요청을 보낸 화면의 테마(해석된 dark|light). 헤더가 정본이고 바디는 폴백, 그 외엔 미지정(종전 동작). */
function themeOf(req: { headers: Record<string, unknown> }, b: Record<string, unknown>): "dark" | "light" | undefined {
  return normalizeTheme(req.headers["x-lively-theme"]) ?? normalizeTheme(b.theme);
}

/** 원격 ExecutionHost에는 조직 DB가 없다. 게이트웨이가 앱 권한·토큰·자산을 확정해 내부 봉투로 넘긴다. */
async function prepareRemoteAppSession(input: CreateInput, memberId: string): Promise<CreateInput> {
  if (!input.appId) return input;
  // 자산 무결성을 먼저 확인한 뒤 토큰을 굽는다. 자산 오류 때문에 사용되지 않는 자격이 생기는 시간을 줄인다.
  const [assets, gw] = await Promise.all([prepareAppAssets(input.appId), gatewayUrl()]);
  const { token } = await mintAppToken(memberId, input.appId, "app-spawn-remote");
  return { ...input, appSession: { appId: input.appId, token, gatewayUrl: gw, assets } };
}

// 노드 op 실패를 사용자에게 그대로 보여준다 — 노드측 예외(예: tmux 미설치 → spawn ENOENT)가 generic 500("internal_error")
//  으로 묻히면 원인 진단이 불가능하다(#869 haru 사례: 세션 생성 500 의 진짜 원인이 로그에만 있고 응답엔 안 나왔다).
//  오프라인·타임아웃은 전용 상태코드로, 그 외 노드측 오류는 502 로 메시지를 붙여 표면화한다.
//  (#1313 R46) 분기 캐스케이드는 node/rpc-error 의 translateNodeRpcError 로 수렴 — 이 사이트의 offline 판정은
//  **msg 동등성만**이다(provision-remote 쪽의 `|| !nodeOnline(nodeId)` 추가조건 없음). 상태코드·문구는 원문 그대로.
async function relayNodeOp<T>(nodeId: string, op: NodeOp, args: Record<string, unknown>): Promise<T> {
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

const COOKIE = "lively_term";
const PREFIX = "/terminal";
const TICKET_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// 인메모리 티켓 — 재기동 시 비워짐(도그푸드 OK). ticket -> { userId, exp(epoch ms) }.
const tickets = new Map<string, { userId: string; exp: number }>();
function issueTicket(userId: string): string {
  const t = crypto.randomBytes(18).toString("hex");
  tickets.set(t, { userId, exp: Date.now() + TICKET_TTL_MS });
  return t;
}
const lookupTicket: TicketLookup = (cookieHeader) => {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== COOKIE) continue;
    const key = part.slice(eq + 1).trim();
    const rec = tickets.get(key);
    if (rec && rec.exp > Date.now()) return { userId: rec.userId };
    if (rec) tickets.delete(key);
  }
  return null;
};

/**
 * 세션 스코프 거부 문구 — **존재를 확인해 주지 않는다**(#1876 S3 / D3 "링크만 알면 열리는 경로를 막는다").
 *
 * 종전 403 "세션에 접근할 수 없습니다" 는 *그 세션이 있다*는 사실을 알려 줬다. 세션이 프라이빗이면
 *  그 **존재와 제목**도 프라이빗이어야 하고(id 열거 방지), 없는 세션과 구분되지 않아야 한다.
 *  그래서 세션 스코프 라우트의 거부를 404 로 통일한다 — 화면 문구도 두 경우를 합쳐 말한다.
 *
 * ⚠ WS close 코드(4403 no-access / 4410 session-gone)는 **합치지 않았다.** 그 축의 4403 은
 *  "권한 없음"뿐 아니라 **판정 불가**(tmux 타임아웃 등)에도 쓰이고 클라이언트가 그때 재시도한다
 *  (terminal-pty.ts:163-169). 합치면 살아 있는 세션을 '종료됨'으로 오인해 재연결을 끊는다 —
 *  프라이버시 이득(닫힌 소켓의 코드 한 자리)보다 회귀 위험이 크다. 두 사유를 코드에서 가를 수 있게 된
 *  뒤에 다시 본다.
 */
const SESSION_NOT_FOUND = "없거나 접근할 수 없는 세션입니다";

const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";

export function registerTerminal(app: express.Express, server: Server, verifier: BearerVerifier): void {
  // 도그푸드: 인증만(authOnly) — 모든 멤버가 터미널 사용 가능. 정식화 시 'code'/'terminal' scope 게이트로 좁힌다.
  const auth = sessionOrBearer(verifier); // 세션 쿠키(웹 로그인) OR bearer(에이전트) — 둘 다 수용

  // #1313 R15 — 19개 라우트를 관심사 3그룹의 내부 함수로 나눠 등록한다(registerTerminalFiles 선례와 같은 꼴).
  //  ⚠ 등록 순서는 분할 전과 **동일**해야 한다(Express 는 등록순 매칭 — 특히 /sessions 와 /sessions/:id 계열이 겹친다).
  //   그래서 그룹은 '원래 등록 순서의 연속 구간'으로만 자른다 — transcript 검색(prompts*)이 세션 CRUD 사이에
  //   끼어 있던 원 배치 그대로 ② 그룹에 속한다(순서 보존이 의미 그룹핑보다 우선).
  registerTicketProfileRoutes(app, auth);
  registerSessionCrudRoutes(app, auth);
  registerRestoreReportRoutes(app, auth);
  registerSessionChatRoutes(app, auth);   // #1719 — /sessions/:id/transcript · /sessions/:id/keys · /sessions/:id/seen(#1954 3차) (CRUD 뒤 — 경로가 겹치지 않는다)
  registerSessionTrashRoutes(app, auth);  // #1851 — /session-trash (휴지통으로·되돌리기·완전 삭제·비우기)
  // #1719 세션 프로젝트 소속 바꾸기(POST /sessions/:id/project)는 capability session_set_project 가 서빙(#1798 후속 — capabilities/session-project.ts).

  registerTerminalFiles(app, verifier);
  registerNodeRoutes(app, verifier); // 분산 노드(#869) — /api/ui/nodes* (등록·회전·활성·삭제·현황)
  setupPtyUpgrade(server, lookupTicket);
  logger.info("terminal session manager mounted (/api/ui/terminal/*, ws /terminal/ws, files, nodes)");
}

// ── ① 티켓 발급 + 생성폼 설정 + AI 계정(#1085) + 프로필/OS 프로비저닝(#442·#524) ──
//  WS 자체(upgrade 핸들러)는 라우트가 아니라 setupPtyUpgrade(registerTerminal 말미)가 붙인다 — 여기는 그 티켓 발급만.
function registerTicketProfileRoutes(app: express.Express, auth: express.RequestHandler): void {
  // 티켓 발급 — WS 가 쓸 HttpOnly 쿠키(userId 바인딩).
  app.post("/api/ui/terminal/ticket", auth, (req, res) => {
    const uid = idOf(userOf(req));
    if (!uid) { res.status(403).json({ error: "no user identity" }); return; }
    const t = issueTicket(uid);
    res.setHeader("Set-Cookie", `${COOKIE}=${t}; HttpOnly; Path=${PREFIX}; SameSite=Lax; Max-Age=${Math.floor(TICKET_TTL_MS / 1000)}`);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });

  // 생성폼 설정 — 허용 루트 + 하네스/플래그 카탈로그 + 초대 후보(구성원 디렉터리).
  app.get("/api/ui/terminal/config", auth, wrap(async (req, res) => {
    // 초대 후보 = 활성 구성원(시스템 계정 제외). 세션 owner id = org_member.id 라 그대로 매칭됨.
    const members = (await listMembers().catch(() => []))
      .filter((m) => m.state !== "inactive" && m.kind !== "system")
      .map((m) => ({ id: m.id, name: m.display_name || m.id, kind: m.kind }));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      roots: roots().map((r) => ({ key: r.key, label: r.label })),
      // bin·autoApproveFlag 를 함께 준다(#1695) — 프로젝트 화면의 '내 컴퓨터에서 작업'이 자동승인 설명에 **그 하네스의
      //  실제 플래그**를 적기 위해서다. 종전엔 웹이 'claude --dangerously-skip-permissions / codex --yolo' 를 문장에
      //  하드코딩해, 하네스가 늘 때마다 그 문장이 조용히 틀려졌다. 둘 다 우리 상수라 노출에 위험이 없다.
      // provider — 화면이 '어느 회사 모델로 열까'로 묻고 그 답이 곧 하네스가 된다(#1758, catalog.ts HarnessProvider).
      // runtime — 이미 떠 있는 세션에서 그 축을 바꿀 수 있나(슬래시 명령이 있는 하네스만). 화면이 컨트롤 노출을 이걸로 정한다.
      harnesses: HARNESSES.map((h) => ({
        key: h.key, label: h.label, bin: h.bin, provider: h.provider,
        // login — 이 AI 에 '로그인' 개념이 있나(#1884, profiles.ts HARNESS_CRED 표). 세션 폼의 [내 계정 로그인]이
        //  이걸로 선택지를 만든다. 종전엔 그 버튼이 claude 고정이라 codex 사용자가 눌러도 claude 세션이 떴다.
        login: harnessHasCredential(h.key),
        hasAutoApprove: !!h.autoApproveFlag, autoApproveFlag: h.autoApproveFlag ?? "", flags: h.flags,
        effortsByModel: h.effortsByModel,
        runtime: { model: !!h.runtimeCmd?.model, effort: !!h.runtimeCmd?.effort },
      })),
      members,
      // 멀티프로필(#346): 이 세션이 '내 계정'(프로필 로그인됨)으로 뜰지, '공유 계정'으로 폴백할지 UI 표시.(레거시 폴백)
      profile: await profileStatus(userOf(req)),
      // 구성원 격리(#524): 이 세션이 '내 격리 OS 계정(box_)'으로 뜨는지 안내 — box_ 격리가 #346 프로필을 대체.
      //  {ready:인프라설치, provisioned:box_존재, osUser}. 미프로비저닝이어도 첫 세션에 자동 생성(lazy)됨.
      os: await memberOsStatus(userOf(req).userId),
      // 분산 노드(#869): 생성폼 실행 위치 피커 — **내가 등록한 노드 ∪ 관리자가 공유로 지정한 노드**(#1540).
      //  아래 requireCreatableNode 와 **같은 술어**를 쓴다 — 목록과 게이트가 갈리면 고른 뒤 403 이 난다.
      //  admin 예외는 두지 않는다(남의 개인 PC 가 관리자에게 선택지로 보이면 그게 이 정책의 구멍이다).
      //  online 이어야 실제 생성 가능(폼이 비활성 표시).
      nodes: await (async () => {
        const me = idOf(userOf(req));
        const live = new Map(liveNodes().map((n) => [n.id, n]));
        return (await listNodes().catch(() => []))
          // #2108 — 게이트웨이 자신이 노드로도 등록돼 있으면 여기서 뺀다. 같은 박스라 '중앙 컴퓨터(기본)'가
          //  이미 그 자리를 대표하고, 노드로 고르면 3초 스냅샷을 거치느라 새 세션이 복원으로 새 버린다(#2108).
          .filter((n) => n.enabled && nodeOpenTo(n, me) && !isSelfNode(n.id))
          // harnesses(#1713) — **그 PC 에서 실제로 띄울 수 있는 것**만 폼에 보여주기 위해 함께 준다.
          //  노드가 hello 로 보고한 값이고, 구 번들이라 미보고면 기준선(claude·codex·shell)이 온다.
          //  이게 없으면 사용자는 [생성하기]를 누른 뒤에야 안다 — 옛 번들은 502, 바이너리 부재는 세션 즉사.
          // mine·connectedAt(#2172) — 새 세션의 **기본 실행 노드**를 화면이 규칙으로 정하기 위한 두 값.
          //  규칙은 '내 켜져 있는 컴퓨터 > 공유 컴퓨터 > 중앙'이고, 동률이면 **가장 최근에 붙은 것**이다(web/v2/run-picker.ts).
          //  mine 없이 shared 만 보면 '내 노드인데 관리자가 공유로 지정한 것'을 남의 PC 로 오판한다(둘은 직교다).
          .map((n) => ({
            id: n.id, name: n.name, kind: n.kind, shared: n.shared, mine: n.owner_member === me,
            online: live.get(n.id)?.online ?? false, connectedAt: live.get(n.id)?.connectedAt ?? null,
            harnesses: nodeHarnesses(n.agent_harnesses),
          }));
      })(),
    });
  }));

  // ── 내 AI 계정(#1085) — 관리탭 [내 설정 ▸ 내 AI 계정] 카드가 읽고 쓴다. **본인 것만**: 경로에 멤버 id 가
  //  없고 principal(userOf) 로만 대상이 정해진다 → 남의 계정을 조회·로그아웃할 표면이 아예 없다(admin 도 마찬가지).
  app.get("/api/ui/me/ai-accounts", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ accounts: await aiAccountStatus(userOf(req)) });
  }));
  // ── AI 로그인을 **터미널 없이** (#2055 후속, 2026-08-28) ─────────────────────────────────
  //  종전엔 «로그인 전용 세션 + 그 터미널을 새 탭»(웹) / **새 창**(데스크톱 앱)이었다. 사람이 실제로 할 일은
  //  «주소를 열고 코드를 넣는 것» 뿐인데 그걸 하려고 터미널 화면을 통째로 봤다. 여기서는 그 두 값만 준다.
  //  하네스별 차이는 ai-login-flow.ts 머리말이 정본이다(codex=코드를 보여준다 · claude=코드를 되받는다).
  //  ⚠ 대상은 codex·claude 뿐이다. agy 는 로그인 서브커맨드가 없고 grok·opencode 는 비대화형 한 줄이
  //   아니라(catalog.harnessLoginArgv 머리말), 그 둘은 종전 안내(터미널)로 간다 — 지어내지 않는다.
  const loginSeat = async (req: express.Request): Promise<string | null> => {
    const { resolveMemberOsUser } = await import("./terminal-isolation.js");
    const { userSlug } = await import("./profiles.js");
    return resolveMemberOsUser(userSlug(userOf(req)));
  };
  const loginHarnessOf = (req: express.Request): AiLoginHarness => {
    const h = String(((req.body ?? {}) as Record<string, unknown>).harness ?? (req.query.harness ?? "")).trim();
    if (!isAiLoginHarness(h)) throw new HttpError(400, "이 AI 는 화면에서 바로 로그인할 수 없습니다 — 터미널 안내를 따라 주세요.");
    return h;
  };
  app.post("/api/ui/me/ai-login/start", auth, wrap(async (req, res) => {
    const h = loginHarnessOf(req);
    const seat = await loginSeat(req);
    //  ⚠ restart 가 필요한 이유(실측 2026-08-28): 사람이 브라우저에서 **막히는** 경우가 있다 — 예컨대 ChatGPT
    //   계정에 «Codex용 장치 코드 인증» 이 꺼져 있으면 그 코드가 거기서 죽는다(#2232 원준님 실측). 그런데 우리
    //   쪽 프로세스는 15분을 더 기다리므로, 사람이 설정을 켜고 [다시 시도] 를 눌러도 start 는 «이미 돌고 있다» 며
    //   **죽은 코드를 그대로 다시 보여 준다.** 그러면 몇 번을 눌러도 같은 벽이다. 다시 시도는 새로 띄워야 한다.
    if (((req.body ?? {}) as Record<string, unknown>).restart === true) await cancelAiLogin(seat, h);
    await startAiLogin(seat, h);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  }));
  //  화면이 폴링하는 자리 — 주소·코드·다음 단계. loggedIn 은 **자격 확인**이 정한다(프로세스가 끝난 것과 다르다).
  app.get("/api/ui/me/ai-login/state", auth, wrap(async (req, res) => {
    const h = loginHarnessOf(req);
    const seat = await loginSeat(req);
    const [raw, check] = await Promise.all([
      readAiLogin(seat, h),
      aiLoginCheck(userOf(req), h).catch(() => null),
    ]);
    const st = parseAiLogin(h, raw);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...st, loggedIn: check?.loggedIn ?? null, step: aiLoginStep(st, check?.loggedIn ?? null) });
  }));
  //  claude 전용 — 사람이 브라우저에서 받아 온 코드를 프로세스에 넣는다.
  app.post("/api/ui/me/ai-login/paste", auth, wrap(async (req, res) => {
    const h = loginHarnessOf(req);
    const code = String(((req.body ?? {}) as Record<string, unknown>).code ?? "");
    await pasteAiLogin(await loginSeat(req), h, code);
    res.json({ ok: true });
  }));
  app.post("/api/ui/me/ai-login/cancel", auth, wrap(async (req, res) => {
    await cancelAiLogin(await loginSeat(req), loginHarnessOf(req));
    res.json({ ok: true });
  }));

  // 로그아웃 = 내 자격증명 파일 삭제(재로그인으로 복구 가능). 공유 계정(비격리 codex 등)은 서비스가 409 로 막는다.
  app.post("/api/ui/me/ai-accounts/logout", auth, wrap(async (req, res) => {
    const harness = String(((req.body ?? {}) as Record<string, unknown>).harness ?? "").trim();
    if (!harness) throw new HttpError(400, "harness(AI 키)가 필요합니다");
    await aiAccountLogout(userOf(req), harness);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, accounts: await aiAccountStatus(userOf(req)) });
  }));
  // 고른 AI 하나를 판정한다(#1879) — 온보딩 «AI 잇기» 의 [로그인했어요] 가 누른 그 순간에만 부른다.
  //  ⚠ GET 이 아니라 POST 인 이유: antigravity 판정은 그 사람 자리에서 `agy models` 를 **실행**한다(실측 4.3초,
  //   네트워크). 캐시·프리페치가 붙으면 안 되는 부수효과 있는 조회라 GET 의 계약을 빌리지 않는다.
  //  others = 고른 것 말고 **이미 이어진** 헤드리스 하네스. 화면이 사람을 막지 않기 위해 쓴다 — 제미나이를 골랐어도
  //   claude 가 이어져 있으면 분석은 지금도 돌기 때문이다(welcome.analyze 가 resolveHeadlessHarness 로 그걸 고른다).
  app.post("/api/ui/me/ai-accounts/check", auth, wrap(async (req, res) => {
    const harness = String(((req.body ?? {}) as Record<string, unknown>).harness ?? "").trim();
    if (!harness) throw new HttpError(400, "harness(AI 키)가 필요합니다");
    const user = userOf(req);
    const [check, loggedIn] = await Promise.all([
      aiLoginCheck(user, harness),
      (async () => {
        const { memberLoggedInHarnessesAny } = await import("./profiles.js");
        const { HEADLESS_KEYS } = await import("../node/headless-harness.js");
        return (await memberLoggedInHarnessesAny(user.userId).catch(() => [] as string[]))
          .filter((k) => HEADLESS_KEYS.includes(k));
      })(),
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...check, others: loggedIn.filter((k) => k !== harness) });
  }));

  // ── 멀티프로필 프로비저닝(#442) — 관리탭 전용(admin scope). 로그인(OAuth)은 멤버가 웹터미널에서 셀프서비스. ──
  const requireAdmin = (req: express.Request): void => {
    if (!userOf(req).scopes?.includes("admin")) throw new HttpError(403, "admin 권한이 필요합니다");
  };
  // 멤버별 프로필 상태 목록 — 관리탭이 '누가 프로비저닝/로그인됐나' 표로 보여준다.
  app.get("/api/ui/terminal/profiles", auth, wrap(async (req, res) => {
    requireAdmin(req);
    const members = (await listMembers().catch(() => []))
      .filter((m) => m.state !== "inactive" && m.kind !== "system");
    const profiles = [];
    for (const m of members) profiles.push({ id: m.id, name: m.display_name || m.id, kind: m.kind, scopes: m.scopes || [], status: await profileStatusFor(m.id), os: await memberOsStatus(m.id) });
    res.setHeader("Cache-Control", "no-store");
    res.json({ profiles });
  }));
  // 프로필 프로비저닝 — dir + 키트(settings·MCP). 실재 구성원만. 로그인은 별도(응답의 loginHint 로 안내).
  app.post("/api/ui/terminal/profiles/provision", auth, wrap(async (req, res) => {
    requireAdmin(req);
    const member = String((req.body ?? {} as Record<string, unknown>).member ?? "").trim();
    if (!member) throw new HttpError(400, "member(구성원 id)가 필요합니다");
    if (!(await listMembers().catch(() => [])).some((m) => m.id === member)) throw new HttpError(400, "존재하지 않는 구성원입니다");
    // #2174 — 프로필 토큰은 **멤버 추종**으로 굽는다(세션 권한 = 멤버 권한). 종전의 includeControlPlane opt-in 은
    //  사라졌다 — 옛 화면이 그 필드를 계속 보내도 무시된다(무해).
    const { slug, dir } = await provisionProfile(member);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, member, slug, dir, status: await profileStatusFor(member),
      loginHint: `로그인(그 멤버 계정): 웹터미널에서 'CLAUDE_CONFIG_DIR=${dir} claude' 실행 후 /login` });
  }));
  // OS-유저 프로비저닝(#524) — 구성원별 OS 계정(box_<slug>) 생성(홈700·격리). root 스크립트를 잠긴 sudo 로.
  //  격리는 secure-by-default: 인프라 설치됨 + 이 멤버 provision 되면 자동 적용(별도 켜기 불요, =off 만 하드 비활성).
  app.post("/api/ui/terminal/members/provision-os", auth, wrap(async (req, res) => {
    requireAdmin(req);
    const member = String((req.body ?? {} as Record<string, unknown>).member ?? "").trim();
    if (!member) throw new HttpError(400, "member(구성원 id)가 필요합니다");
    if (!(await listMembers().catch(() => [])).some((m) => m.id === member)) throw new HttpError(400, "존재하지 않는 구성원입니다");
    const os = await memberOsStatus(member);
    if (!os.ready) throw new HttpError(409, "격리 인프라 미설치 — 박스에서 install-isolation.sh 를 먼저 실행하세요(box-spawn·sudoers·그룹).");
    // #2174 — 추종 토큰이라 opt-in 이 없다(위 provision 라우트와 같다). 옛 화면의 필드는 무시된다.
    const { slug, osUser } = await provisionMemberOs(member);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, member, slug, osUser, os: await memberOsStatus(member),
      loginHint: `이제 이 멤버가 자기 새 세션에서 'claude' → /login 하면 자격증명이 /home/${osUser}/.claude(700)에 격리 저장됩니다.` });
  }));
}

// ── ② 세션 목록·단건 조회 + '내 질문'(transcript) 검색(#745) + 생성·수정·삭제(CRUD) ──
//  prompts* 두 라우트가 CRUD 사이에 끼어 있는 건 원래 등록 순서다(위 registerTerminal 주석 — 순서 보존 우선).
// 세션 → 워크스페이스 정본 기록(#1750 후속) — 헤더를 못 싣는 표면(SSE·iframe·WS·훅·구 kit)이
//  이 맵(gw_session_map)으로 컨텍스트를 되찾는다. primary(무컨텍스트)는 행을 안 만든다(부재 = primary).
//  ⚠ 기록 실패는 **생성 실패로 승격**한다: 맵 없는 secondary 세션은 이후 헤더 없는 요청이 전부
//  primary 로 오귀속된다 — dev 실측('다온')이 정확히 그 사고라, 조용히 넘기지 않는다.
// (#1791 모듈 스코프로 올림 — 노드 세션 복원도 같은 기록을 해야 한다.)
/**
 * 세션이 섰다 — 그 세션의 **앱 인스턴스**를 세운다(#1954 후속 · #1780 v2.2 §2.5: 일반 세션 = ai-session 앱의 인스턴스).
 *  종전엔 웹에서 그 세션을 처음 열 때만 만들어져(lazy), CLI 로 띄우고 웹에서 안 연 세션은 인스턴스가 없었다 —
 *  그래서 좌측 목록이 '돌고 있는 세션'을 따로 훑어 그 구멍을 메워야 했다. 정체성은 세션이 태어날 때 정해진다.
 *  ⚠ 이 등록은 **게이트웨이에만** 있다 — sessions.ts(createSession)는 노드 에이전트 번들에 실리고 노드엔 DB 가 없다
 *   ('DB 없음' 계약, scripts/build-node-agent.mjs 화이트리스트). 그래서 박스·노드·핸드오프·복원이 공유하는
 *   이 라우트 층 한 곳에 둔다.
 *  subject 로 멱등하다(store createAppInstance) — 복원처럼 같은 세션이 다시 와도 하나다. 실패해도 세션은 산다.
 */
//  (#1631) export — 리브 킥오프(org/liv/kickoff.ts)가 서버에서 세션을 열 때 **같은 등록·바인딩**을 밟는다. 라우트 밖에서
//   세션을 여는 길이 생기면 이 둘을 반드시 함께 부른다(안 부르면 목록에 안 뜨고 primary 로 취급된다).
export const registerSessionInstance = async (sessionId: string, owner: string, opts: { appId?: string | null; projectId?: number | null; title?: string | null }): Promise<void> => {
  await createAppInstance({ appId: opts.appId || "ai-session", owner, projectId: opts.projectId ?? null,
    subjectKind: "session", subjectRef: sessionId, title: opts.title || null })
    .catch((e) => logger.warn({ err: e, sessionId }, "앱 인스턴스 등록 실패(비치명) — 세션은 살아 있다"));
};

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

function registerSessionCrudRoutes(app: express.Express, auth: express.RequestHandler): void {
  app.get("/api/ui/terminal/sessions", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // 프로젝트 폴더 세션은 '프로젝트 공동 세션'. 기본은 숨긴다 — 이 응답을 '내 세션'으로 쓰는 소비자
    //  (대시보드 '내 AI 세션' 위젯 등)가 남의 세션까지 떠안지 않도록. includeProjects=1 을 준 호출자
    //  (AI세션 탭)만 프로젝트 세션을 함께 받는다: 프로젝트 세션은 #452 로 로그인한 전원 공개라
    //  listSessions 가 이미 소유·초대 필터를 건너뛰고 전부 돌려준다(여기서 더 좁히지 않는다).
    //  includeProjects=owned(#1139) — '내가 만든 프로젝트 세션까지'(남의 것은 제외). 대시보드 '내 AI 세션'용:
    //   그 위젯은 지금까지 프로젝트별 /projects/:id/sessions 를 덧붙여 프로젝트 세션을 채웠는데, 그 대상이
    //   my_session_count(라이브 tmux 세션 수)>0 인 프로젝트뿐이라 **세션이 전부 복원 가능(tmux 죽음)인 프로젝트는
    //   통째로 빠졌다** → 대시보드에 복원 가능 세션이 안 보였다. 서버가 owned 필터로 한 번에 주면 그 구멍이 없다.
    const ipRaw = String(req.query.includeProjects ?? "").trim().toLowerCase();
    const includeProjects = ipRaw === "1" || ipRaw === "true";
    const ownedProjectsOnly = ipRaw === "owned" || ipRaw === "mine";
    const all = await listSessions(userOf(req));
    // 분산 노드(#869) — 원격 노드 세션 병합(node 필드로 구분). 가시성은 개인 세션 규칙(소유자+초대)로 게이트웨이가 판정.
    const remote = nodeSessionsFor(idOf(userOf(req)));
    // 복원 가능(#1059 E) — DB desired-state 에만 있고 지금 tmux 에 없는 세션(재부팅 사망·reaper 회수). 라이브 우선(이중표기 방지).
    //  #1791 — 노드 세션 행(node_id)도 여기 온다: 노드 스냅샷에 살아 있는 id 는 라이브가 SoT 라 뺀다(local ∪ remote).
    const restorable = await listRestorableSessions(userOf(req), new Set([...all, ...remote].map((s) => s.id)));
    const proj = (s: SessionInfo): boolean => isProjectSessionDir(s.dir);
    const keep = (s: SessionInfo): boolean => includeProjects || !proj(s) || (ownedProjectsOnly && !!s.owned);
    const local = all.filter(keep);
    const localRestorable = restorable.filter(keep);
    // #1791 — 복원 가능 노드 세션 행의 노드 이름·온라인 여부(listRestorableSessions 는 id 만 안다). 프론트가 &node= 로 릴레이한다.
    await decorateNodeRows(localRestorable);
    // #1719 — 라이브 행에 대화 uuid(claudeSessionId)를 싣는다. 새 셸의 세션 화면이 이 값으로 로컬 트랜스크립트를 잇고,
    //  중앙 세션 기록(v6/sessions — session_id 가 곧 이 uuid)과 같은 세션임을 알아 목록을 한 장으로 접는다.
    //  한 번의 일괄 조회(세션 수만큼 왕복하지 않는다). DB 가 죽어도 목록은 나간다(best-effort).
    //  #1791 — 노드 세션도 org_session_state 행이 생겼으므로(/claude-uuid 가 그 행을 갱신) 같은 조회로 remote 행까지 채운다.
    try {
      const map = await claudeSessionIdsFor([...local, ...remote].map((s) => s.id));
      for (const s of [...local, ...remote]) { const u = map.get(s.id); if (u) s.claudeSessionId = u; }
    } catch { /* 미러 조회 실패 — uuid 없이 나간다(화면은 '기록 없음'으로 다룬다) */ }
    // #2197 — 사람이 **마지막으로 시킨 말**(훅 UserPromptSubmit 보고 → org_session_state.last_prompt). 사이드바 둘째 줄의 정본 —
    //  종전엔 화면이 세션마다 대화 꼬리(48~240KB)를 받아 찾았고, 노드 세션은 기록이 턴 끝에만 올라와 실시간이 아니었다.
    //  박스·노드 세션 모두 같은 행에 있다(#1791). 없으면(옛 훅·코덱스·셸) 화면이 종전 꼬리 조회로 폴백한다.
    //  ⚠ 복원 가능 행(localRestorable)도 덮는다 — dev 실측 목록 350행 중 323행이 그 부류(tmux 가 죽은 지난 세션)라,
    //   라이브만 덮으면 사이드바 '지난 세션' 묶음이 통째로 꼬리 조회 폴백(권한 403 → 빈 줄)에 남는다.
    try {
      const rows = [...local, ...remote, ...localRestorable];
      const pm = await lastPromptsFor(rows.map((s) => s.id));
      for (const s of rows) { const p = pm.get(s.id); if (p) s.lastPrompt = p; }
    } catch { /* 조회 실패 — 값 없이 나간다(화면 폴백) */ }
    // #1752 갭2 — 노드 세션 행에도 대화 uuid 를 싣는다(org_node_session_map — /claude-uuid 노드 분기가 채움).
    //  이 값이 실려야 새 셸 채팅창이 노드 세션을 중앙 기록(v6/sessions/:uuid/log)으로 읽고, 같은 기록 행과 한 장으로 접힌다.
    //  매핑의 node_id 와 지금 행의 노드가 다르면 버린다(노드 재등록·이름 재사용으로 남은 낡은 매핑 오염 방지).
    try {
      const nmap = await nodeSessionMapFor(remote.filter((s) => !s.claudeSessionId).map((s) => s.id));   // #1791 — 행이 없는 옛 노드 세션의 폴백
      for (const s of remote) { const m = nmap.get(s.id); if (m && m.node_id === s.node.id) s.claudeSessionId = m.conv_uuid; }
    } catch { /* 조회 실패 — uuid 없이 나간다 */ }
    // #1746 — 하네스별 대화창 능력(읽기·승인)을 행에 싣는다. 화면이 없는 능력의 버튼을 두지 않게(정직한 표면).
    for (const s of [...local, ...localRestorable, ...remote]) Object.assign(s, chatFieldsOf(s.harness, !!(s as { node?: unknown }).node));
    // 같은 세션이 두 출처에 잡히면 카드 1장으로 접는다(#1716) — 인자 순서가 곧 우선순위(라이브 관측 > 기억).
    //  게이트웨이와 노드 에이전트가 같은 박스에서 돌면 **같은 tmux 서버**를 보므로 local 과 remote 에 같은 id 가
    //  동시에 잡힌다(실측: AI 세션 탭 카드가 전부 2장씩). liveIds 로 restorable 만 걸러선 이 짝을 못 막는다.
    // #1851 휴지통 — 내 표식을 행에 얹는다: 휴지통에 있으면 trashedAt(화면이 사이드바에서 빼고 휴지통 화면에 그린다),
    //  완전 삭제(purged)면 행 자체를 뺀다. 박스 id 와 대화 uuid 어느 이름으로든 표식이 있으면 그 세션의 것이다.
    //  DB 가 죽어도 목록은 나간다(best-effort — 표식 없이).
    let merged = mergeSessionViews(local, remote, localRestorable);
    try {
      const marks = await trashMapFor(idOf(userOf(req)));
      if (marks.size) {
        merged = merged.filter((s) => {
          const m = marks.get(s.id) || (s.claudeSessionId ? marks.get(s.claudeSessionId) : undefined);
          if (!m) return true;
          if (m.purged) return false;
          s.trashedAt = m.trashed_at;
          if (m.project_id != null) s.trashedWith = m.project_id;   // 프로젝트와 함께 버림(묶음) — 화면이 따로 버린 것과 가른다
          return true;
        });
      }
    } catch { /* 표식 조회 실패 — 휴지통 없이 나간다 */ }
    // #1875 — 라이브 목록도 **지금 워크스페이스**의 세션만. tmux/노드 목록은 owner 로만 걸러(전역 신원) 개인
    //  워크스페이스에 박스 전체 세션이 샜다(실측 신고). gw_session_map 부재/보관됨 = primary. 필터 실패는
    //  fail-closed 하지 않는다(격리는 v6/sessions SQL 필터가 이중으로 지킨다 — 여기서 막히면 목록이 통째로 빈다).
    try {
      const curWs = currentTenant()?.id ?? PRIMARY_TENANT_ID;
      const wsMap = await sessionWorkspaceIds(merged.map((s) => s.id));
      merged = merged.filter((s) => sessionInWorkspace(wsMap.get(s.id), curWs));
    } catch (e) { logger.warn({ err: e }, "세션 목록 워크스페이스 필터 실패 — 격리 없이 나간다(v6/sessions 가 이중 방어)"); }
    res.json({ sessions: merged });
  }));
  // 세션 종료 확인창이 '대화 기록이 남는지'를 **사실대로** 말하기 위한 최소 정책 조회(#1582).
  //  왜 필요한가: 종전 확인창은 전 화면에서 "되돌릴 수 없어요"라고 단언했지만, 종료(DELETE)는 tmux 를 죽이고
  //   desired-state 행을 지울 뿐 **작업 폴더도 대화록도 건드리지 않는다**. 반대로 "대화록은 남아요"라고 못 박아도
  //   조직이 세션 공유를 안 켰거나 그 하네스가 캡처 대상이 아니면 그건 거짓이 된다 — 어느 쪽으로도 단언하면 틀린다.
  //   그래서 프론트가 확인창을 그리기 직전에 이걸 한 번 물어보고 문구를 고른다.
  //  비밀 없음(캡처 on/off · 대상 하네스 · 보존일)이라 admin 게이트를 걸지 않는다 — 어차피 자기 세션을 종료하는
  //   모든 멤버가 알아야 할 사실이고, org_runtime_config 전량(work_roots 등)은 여기로 나가지 않는다.
  app.get("/api/ui/terminal/session-log-policy", auth, wrap(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const c = await getRuntimeConfig();
    res.json({
      enabled: c.session_share.enabled,
      harnesses: c.session_share.harnesses,
      retentionDays: c.session_share.retention_days,   // 0 = 무제한
    });
  }));
  // 단일 세션의 현재 이름 — 단독 터미널 페이지가 id 로 조회(프로젝트 세션은 목록에서 빠져 ?label= 폴백만 됐던 문제 해결).
  //  접근통제: canAttach(소유자·초대된 멤버, 프로젝트 세션은 전원 #452) — 입장 가능한 사람만 이름을 읽는다.
  app.get("/api/ui/terminal/sessions/:id", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    const isAdmin = !!userOf(req).scopes?.includes("admin");
    const id = req.params.id;
    res.setHeader("Cache-Control", "no-store");
    // 노드 세션(#869) — 마지막 상태 스냅샷에서 가시성 판정 후 라벨 반환(노드 오프라인이어도 표시 가능).
    const nodeId = String(req.query.node ?? "").trim();
    // 🔴 #2108 — 이 메타는 **부팅 게이트(maybeRestoreOnOpen)의 유일한 입력**이다. 여기서 restorable 을 한 번
    //  잘못 내면 화면은 WS 도 안 붙이고 곧장 복원으로 간다 — 그래서 '모름'을 '죽음'으로 접으면 안 된다.
    if (nodeId) {
      const s = nodeSessionsFor(uid).find((x) => x.node.id === nodeId && x.id === id);
      if (s) { res.json({ id: s.id, label: s.label, projectId: s.projectId || 0 }); return; }
      // #1791 — 스냅샷에 없다 = 그 노드에서 죽었다(또는 노드가 스냅샷을 아직 안 올렸다). 아래 desired-state 경로로 떨어져
      //  '복원 가능'을 알린다(종전엔 여기서 403 — 노드 세션은 desired-state 가 없어 알릴 것이 없었다).
      // ⚠ #2108 — 괄호 안의 두 번째 경우가 실제로 났다. 상태 push 는 3초 주기라 **방금 만든 살아있는 세션**이
      //  그 창 동안 스냅샷에서 빠지는데, 종전엔 그걸 그대로 '복원 가능'으로 냈다. 그래서 아래 갈래는 스냅샷
      //  부재를 dead 로 접지 않고 **ask** 로 보내 노드에 확답을 구한다(nodeSessionMetaMode 머리말).
    }
    // 복원 판정에 쓸 desired-state 는 한 번만 읽어 아래 세 갈래(노드·박스 사망·권한없음)가 나눠 쓴다.
    const st = await getSessionState(id);
    // #1791 — 노드 세션의 desired-state(node_id) — 라이브 스냅샷에 없으면 죽은 것이다. 게이트웨이 tmux 를 묻지 않는다
    //  (그 id 는 여기 tmux 에 없고, canAttach 가 DB owner 로 통과해 빈 라벨을 돌려주는 오답을 막는다).
    if (st?.node_id) {
      const ln = liveNodes().find((n) => n.id === st.node_id);
      const nodeBadge = { id: st.node_id, name: ln?.name || st.node_id, online: !!ln?.online };
      // ★ 좌표(?node=)를 못 받은 호출도 **여기서 생사를 확인한다** — 판정표는 session-meta.ts nodeSessionMetaMode.
      //  스냅샷은 메모리 레지스트리라 새 왕복이 없다.
      let alive: NodeSessionInfo | undefined;
      const mode = nodeSessionMetaMode(nodeId, st.node_id, (nid) => {
        alive = nodeSessionsFor(uid).find((x) => x.node.id === nid && x.id === id);
        return !!alive;
      });
      if (mode === "alive" && alive) { res.json({ id: alive.id, label: alive.label, projectId: alive.projectId || 0, node: nodeBadge }); return; }
      const dead = deadSessionMeta(id, st, uid, isAdmin, sharedByFolder);
      // #2231 — 이미 이어진 id 다. 되살리라고 하지 말고 **이어진 세션을 알려 준다**(화면이 그리로 옮긴다).
      if (dead.kind === "moved") { res.json({ id, movedTo: (await resolveSessionSuccessor(id).catch(() => null)) ?? dead.to, node: nodeBadge }); return; }
      if (dead.kind !== "ok") throw new HttpError(404, SESSION_NOT_FOUND);
      // 🔴 #2108 — 스냅샷이 모르는 자리(ask)는 **노드에 확답을 구한다**(#835 '확답 only'). 부재는 죽음의 근거가
      //  아니다 — 상태 push 3초 주기 때문에 방금 만든 살아있는 세션이 그 창 동안 목록에서 빠진다.
      //  확답을 못 받으면(null: 오프라인·무응답) 종전대로 '복원 가능'이다 — 그 경우 복원 라우트가 다시 gone 을
      //  물어 409("노드가 응답하지 않아…")로 정직하게 멈춘다. 조용한 빈 피커 대신 읽을 수 있는 이유가 남는다.
      //  ⚠ 확답은 **desired-state 가 아는 노드**(st.node_id)에 구한다 — 좌표 없이 온 호출도 여기로 오기 때문이다.
      //  ⚠ 접근통제(deadSessionMeta)를 통과한 뒤에만 묻는다 — 남의 세션 id 로 노드에 왕복을 시키지 않는다.
      const nodeGone = mode === "ask" ? await nodeSessionGone(st.node_id, id) : null;
      const body = nodeMetaRestorable({ mode, nodeGone })
        ? dead.body
        : { id: dead.body.id, label: dead.body.label, projectId: dead.body.projectId };
      res.json({ ...body, node: nodeBadge });
      return;
    }
    // ★ #1820 — 박스 세션이 tmux 에 없으면 **여기서** '복원 가능'을 알린다. canAttach 뒤로 미루면 안 된다:
    //  ownerMeta 가 desired(DB) 우선이 되면서(#109 3be85ae, 2026-08-14) **죽은 세션도 canAttach 를 통과**해
    //  아래 라벨 조회(tmux)로 흘렀고, 그 결과 `{label:"", projectId:0}` 만 나가 restorable 신호가 통째로 빠졌다.
    //  화면은 그걸 '그냥 끝난 세션'으로 읽어(goneMode 'end') **모든 진입점에서 복원이 죽었다**(실측 dev 2026-08-20:
    //  내 세션 219건 중 198건이 이 상태 — 세션을 여는 일의 대부분이 막다른 길이었다).
    //  ⚠ sessionGone 은 tmux 가 "그런 세션 없다"고 **확답**할 때만 true 다(소켓 불통·타임아웃은 false) — 모르면
    //   종전 경로로 흘러 살아 있는 세션을 죽었다고 오판하지 않는다(#835 '확답 only').
    if (await sessionGone(id)) {
      const dead = deadSessionMeta(id, st, uid, isAdmin, sharedByFolder);
      if (dead.kind === "ok") { res.json(dead.body); return; }
      // #2231 — 이 id 는 이미 새 세션으로 이어졌다. '중단된 세션'이라고 말하면 화면이 복원을 약속했다가 404 를 받는다.
      if (dead.kind === "moved") { res.json({ id, movedTo: (await resolveSessionSuccessor(id).catch(() => null)) ?? dead.to }); return; }
      if (dead.kind === "forbidden") throw new HttpError(404, SESSION_NOT_FOUND);
      // kind === "none" — 행이 없다. 종전엔 곧장 종전 흐름(→ 403/빈 라벨)으로 흘러 화면이 막다른 길이었다.
      //  #2231 — 그 전에 **대화로 한 번 더 찾아본다**: 같은 대화를 들고 있는 내 최신 세션이 있으면 그리로 안내한다.
      //  (이정표가 없는 옛 id — 이 변경 이전에 복원됐거나, 사람이 지웠거나, 워크스페이스 회수로 사라진 행.)
      const moved = await resolveSessionSuccessor(id).catch(() => null);
      const movedSt = moved ? await getSessionState(moved).catch(() => undefined) : undefined;
      if (moved && movedSt && (movedSt.owner === uid || isAdmin)) { res.json({ id, movedTo: moved }); return; }
    }
    if (!(await canAttach(id, uid))) {
      // #1059 E — tmux 에 없어도(재부팅·회수·정상종료) desired-state 가 남아 있으면 '복원 가능'으로 알린다.
      //  위 게이트가 tmux 확답을 못 받았을 때의 폴백이다(공유 게이트웨이가 그 세션의 tmux 서버 문맥 밖에 있는 경우 등).
      //  노출 범위는 복원 권한과 같게: 소유자·admin 만 desired-state 를 보고 되살릴 수 있고(canRestore),
      //  프로젝트 세션은 #452 로 전원 공개라 라벨까지는 보이되 복원은 소유자 몫으로 둔다.
      const dead = deadSessionMeta(id, st, uid, isAdmin, sharedByFolder);
      if (dead.kind === "ok") { res.json(dead.body); return; }
      throw new HttpError(404, SESSION_NOT_FOUND);
    }
    // 라벨 + 프로젝트 id 를 함께 반환 — 프로젝트 세션이면 프론트가 상단 '프로젝트 페이지 열기' 버튼을 켠다(개인 세션은 0 → 숨김).
    const [label, projectId] = await Promise.all([
      getSessionLabel(req.params.id),
      getSessionProject(req.params.id),
    ]);
    res.json({ id: req.params.id, label, projectId });
  }));
  // 이 세션에서 사용자가 클로드에게 보낸 질문(프롬프트)만 모아 시간순 반환(#745 카드 '내 질문' 팝아웃).
  //  접근통제: canAttach(입장 가능한 사람 = 대화도 볼 수 있음, 프로젝트 세션은 전원 #452). 대화 기록 = ~/.claude 트랜스크립트.
  app.get("/api/ui/terminal/sessions/:id/prompts", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    const nodeId = String(req.query.node ?? "").trim();
    if (nodeId) { // 노드 세션(#875 ③) — 인가(nodeCanAttach) 후 노드 트랜스크립트 릴레이.
      const v = await nodeCanAttach(nodeId, req.params.id, uid);
      if (!v.ok) throw new HttpError(v.code === 4410 ? 404 : v.code === 4462 ? 503 : 403, v.reason);
      const out = await relayNodeOp(nodeId, "prompts", { id: req.params.id, user: { userId: uid } });
      res.setHeader("Cache-Control", "no-store"); res.json(out); return;
    }
    if (!(await canAttach(req.params.id, uid))) throw new HttpError(404, SESSION_NOT_FOUND);
    const out = await sessionPrompts(await resolveSessionDir(req.params.id, () => sessionDir(req.params.id)));
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
  }));
  // 이 세션의 AI 에게 프롬프트를 보낸다(#1664) — 사람이 웹터미널에 붙어 타이핑하는 것과 같은 일을 화면이 대신한다.
  //  리브(#1631)가 "홈에서 열면 바로 진단이 시작된다"를 만드는 통로이자, 화면에서 세션에 일을 시키는 일반 경로다.
  //  ⚠ 인가는 **canAttach 와 동급**이다 — 입장할 수 있는 사람은 어차피 터미널에서 직접 칠 수 있으므로 더 좁힐 이유가
  //   없고, 더 넓히면 남의 AI 에게 명령하는 통로가 된다. 노드 세션은 nodeCanAttach(정책=게이트웨이).
  //  실행은 node/session-inject 가 로컬/원격을 갈라 맡는다 — 크론 주입과 **같은 경로**다(두 벌 두면 한쪽만 고쳐진다).
  // 열려 있는 탭의 테마를 지금 바꾼다(#1683 후속2) — 화면의 '현재 열린 탭 모두 적용' 이 켜진 상태에서
  //  사람이 테마를 바꾼 순간에만 불린다(자동 주입 금지 — send-keys.applyLiveTheme 주석).
  //  ⚠ 한 세션이라도 실패하면 **그 사실을 그대로 돌려준다** — 화면이 "3개 바꿨어요 · 1개는 지원 안 해요" 를
  //   말해야 하기 때문이다. 조용히 성공으로 접으면 사용자는 왜 한 탭만 다른지 알 길이 없다.
  app.post("/api/ui/terminal/sessions/theme", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    const b = (req.body ?? {}) as Record<string, unknown>;
    const theme = normalizeTheme(b.theme);
    if (!theme) throw new HttpError(400, "테마 값이 dark|light 가 아닙니다");
    const ids = Array.isArray(b.ids) ? b.ids.map((x) => String(x)).filter(Boolean).slice(0, 40) : [];
    if (!ids.length) throw new HttpError(400, "대상 세션이 없습니다");
    const { applyLiveTheme } = await import("./send-keys.js");
    const { nodeOfSession } = await import("../node/registry.js");
    const results: Array<{ id: string; status: string; detail?: string; harness?: string }> = [];
    for (const id of ids) {
      if (!(await canAttach(id, uid))) { results.push({ id, status: "error", detail: SESSION_NOT_FOUND }); continue; }
      const harness = await sessionHarnessKey(id);
      const r = await applyLiveTheme(id, harness, theme);
      // ⚠ 노드(멤버 PC) 세션 판정은 **라이브 관측 뒤에** 한다(#1716 과 같은 함정): 게이트웨이 박스가 노드로도
      //  등록돼 있으면 그 박스의 로컬 세션이 노드 스냅샷에도 잡혀, 먼저 물어보면 로컬 세션까지 '노드'로 접힌다.
      //  applyLiveTheme 이 로컬 tmux 에서 못 찾았을 때만(gone) 노드인지 되짚어 사유를 정확히 바꿔 준다.
      if (r.status === "gone" && nodeOfSession(id)) {
        results.push({ id, harness, status: "unsupported", detail: "노드 세션은 아직 지원하지 않습니다" });
        continue;
      }
      results.push({ id, harness, ...r });
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ results, applied: results.filter((r) => r.status === "applied").length });
  }));

  // ── codex 대화창 실시간 통로(#2055) — 글자 조각·승인 요청·상태를 SSE 로 민다. ──
  //  왜 SSE 인가: rollout 파일은 **턴이 끝나야** 답을 담는다. 파일만 보면 화면은 그동안 빈 채로 있고, 무엇보다
  //  **승인 요청**을 사람에게 전할 길이 없다 — 그러면 기본값(거부)으로 닫혀 codex 가 아무 명령도 못 돌린다.
  //  폴링으로도 못 한다(승인은 '지금 답해야 진행되는' 요청이라 왕복 지연이 곧 멈춤이다).
  app.get("/api/ui/terminal/sessions/:id/codex-chat/events", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    if (!(await canAttach(req.params.id, uid))) throw new HttpError(404, SESSION_NOT_FOUND);
    const { onChatEvent, pendingApprovals, codexChatStatus } = await import("./harness-io/codex-chat-runtime.js");
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",              // 프록시 버퍼링 금지 — 조각이 뭉쳐 오면 스트리밍이 아니다
    });
    const send = (e: unknown): void => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* 이미 닫힘 */ } };
    // 붙자마자 지금 상태를 준다 — 새로고침에 승인이 사라지면 그 턴은 영영 선다(TTL 까지 기다렸다 거부된다).
    // running 은 **지금 턴이 도나**다 — 런타임이 있나(alive)가 아니다. 섞으면 조용한 세션이 영영 '작업 중'이 된다.
    send({ kind: "hello", running: !!codexChatStatus(req.params.id)?.running });
    for (const a of pendingApprovals(req.params.id)) send({ kind: "approval", ...a });
    const off = onChatEvent(req.params.id, send);
    const beat = setInterval(() => { try { res.write(": beat\n\n"); } catch { /* */ } }, 25_000);
    req.on("close", () => { off(); clearInterval(beat); });
  }));

  // ── 세션 상태 통로(#2439) — 하네스 **무관**. 작업(백그라운드 셸·서브에이전트)·승인·슬래시·사용량이 여기로 온다.
  //  왜 codex 것(위)과 따로 두나: 저건 codex app-server 의 낱말(approval·delta)을 그대로 나르는 전용 통로이고,
  //   이건 [[harness-io/session-event.ts]] 의 **우리 어휘**를 나른다. codex 는 프로덕션에서 도는 중이라
  //   지금 이리로 옮기지 않는다 — 도는 것을 리팩터와 함께 흔들지 않는다(이관은 별도).
  //  ⚠ 대화 파일에는 이 정보가 **아예 없다**(실측: transcript 26줄에 task 이벤트 0건). 폴링으로 대체할 수 없다.
  app.get("/api/ui/terminal/sessions/:id/events", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    if (!(await canAttach(req.params.id, uid))) throw new HttpError(404, SESSION_NOT_FOUND);
    const { onSessionEvent, pendingAsks } = await import("./harness-io/runtime-bus.js");
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",              // 프록시 버퍼링 금지 — 조각이 뭉쳐 오면 스트리밍이 아니다
    });
    const send = (e: unknown): void => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* 이미 닫힘 */ } };
    //  붙자마자 **걸려 있는 물음**을 다시 준다 — 새로고침에 승인 카드가 사라지면 그 턴은 TTL 까지 선다.
    for (const a of pendingAsks(req.params.id)) send({ t: "permission.asked", ask: a.ask });
    const off = onSessionEvent(req.params.id, send);
    const beat = setInterval(() => { try { res.write(": beat\n\n"); } catch { /* */ } }, 25_000);
    req.on("close", () => { off(); clearInterval(beat); });
  }));

  // 세션 상태 통로의 승인 답하기(#2439) — 화면이 카드에서 고른 값을 돌려준다.
  //  ⚠ 값은 **우리 어휘**(PermissionAnswer)다 — 하네스 낱말로 번역하는 것은 어댑터의 `respond` 다.
  //   여기서 하네스 값을 그대로 받으면 화면이 하네스를 알아야 하고, 그러면 하네스마다 화면이 갈린다.
  //  ⚠ 모양을 확인하되 **넓게 여는 쪽을 기본값으로 두지 않는다**: allow 가 불리언이 아니면 거부로 친다.
  app.post("/api/ui/terminal/sessions/:id/events/answer", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    if (!(await canAttach(req.params.id, uid))) throw new HttpError(404, SESSION_NOT_FOUND);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = String(b.id ?? "");
    if (!id) throw new HttpError(400, "요청 id 가 필요합니다");
    const raw = (b.value ?? {}) as Record<string, unknown>;
    //  ⚠ answers 는 **키가 질문 전문**이라 길다 — 모양만 좁히고 내용은 해석하지 않는다(번역은 어댑터 몫).
    const rawAnswers = (raw.answers && typeof raw.answers === "object" && !Array.isArray(raw.answers))
      ? raw.answers as Record<string, unknown> : null;
    const answers: Record<string, string | string[]> = {};
    if (rawAnswers) {
      for (const [k, v] of Object.entries(rawAnswers).slice(0, 8)) {
        if (typeof k !== "string" || !k || k.length > 2000) continue;
        if (typeof v === "string") answers[k] = v.slice(0, 2000);
        else if (Array.isArray(v)) answers[k] = v.filter((x) => typeof x === "string").slice(0, 16).map((x) => String(x).slice(0, 2000));
      }
    }
    const value = {
      allow: raw.allow === true,
      scope: raw.scope === "always" ? "always" as const : "once" as const,
      ...(typeof raw.optionId === "string" && raw.optionId ? { optionId: raw.optionId } : {}),
      ...(Object.keys(answers).length ? { answers } : {}),
    };
    //  ★ #2439 — **노드 세션의 물음은 그 노드의 버스에 걸려 있다.** 게이트웨이 버스에 답하면
    //   아무 데도 안 간다(카드는 접히는데 그 턴은 계속 선다). 노드로 릴레이한다.
    //   ⚠ 구 노드는 `node-unsupported-op:` 로 던진다 → stale 로 답해 화면이 사실대로 말한다.
    const nid = nodeOfSession(req.params.id);
    if (nid) {
      let relayed = false;
      try {
        const { nodeRpc } = await import("../node/registry.js");
        const r = await nodeRpc<{ ok?: boolean }>(nid, "chatAnswer", { id: req.params.id, askId: id, value });
        relayed = !!r?.ok;
      } catch { /* 오프라인·구버전 — 아래에서 사실대로 답한다 */ }
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: relayed, stale: !relayed });
      return;
    }
    const { answer } = await import("./harness-io/runtime-bus.js");
    const ok = answer(req.params.id, id, value);
    res.setHeader("Cache-Control", "no-store");
    //  없는 id = 이미 처리됐거나 만료. 실패로 던지지 않고 사실대로 알린다(화면이 카드를 접으면 된다).
    res.json({ ok, stale: !ok });
  }));

  // 돌던 턴 멈추기(#2439) — 하네스 **무관**. 터미널의 Esc 한 번에 해당한다.
  //  ⚠ 못 멈추는 하네스는 `interrupted:false` 를 준다 — 화면이 그 사실로 «터미널에서 Esc» 안내를 가른다.
  //   여기서 true 로 접으면 사람은 멈춘 줄 알고 기다리다 결과를 보고 놀란다.
  app.post("/api/ui/terminal/sessions/:id/events/interrupt", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    if (!(await canAttach(req.params.id, uid))) throw new HttpError(404, SESSION_NOT_FOUND);
    const { interruptChat } = await import("./harness-io/claude-chat-runtime.js");
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, interrupted: interruptChat(req.params.id) });
  }));

  // 승인 답하기 — 화면의 [허용]·[이번만]·[거부] 가 부른다.
  app.post("/api/ui/terminal/sessions/:id/codex-chat/approve", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    if (!(await canAttach(req.params.id, uid))) throw new HttpError(404, SESSION_NOT_FOUND);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = String(b.id ?? "");
    const decision = String(b.decision ?? "");
    // 스키마에 없는 값을 그대로 흘리지 않는다 — codex 는 모르는 값을 fail-closed 로 처리하지만, 우리가 먼저 막는다.
    if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) throw new HttpError(400, "허용되지 않은 결정값입니다");
    if (!id) throw new HttpError(400, "승인 id 가 필요합니다");
    const { answerApproval } = await import("./harness-io/codex-chat-runtime.js");
    const ok = answerApproval(req.params.id, id, decision as never);
    res.setHeader("Cache-Control", "no-store");
    // 없는 id = 이미 처리됐거나 만료. 실패로 던지지 않고 사실대로 알린다(화면이 카드를 접으면 된다).
    res.json({ ok: true, applied: ok });
  }));

  // 돌던 턴 멈추기 — 대화창의 [멈춤]. 런타임이 없으면 false(화면이 종전 Esc 경로로 간다).
  app.post("/api/ui/terminal/sessions/:id/codex-chat/interrupt", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    if (!(await canAttach(req.params.id, uid))) throw new HttpError(404, SESSION_NOT_FOUND);
    const { interruptCodexChat } = await import("./harness-io/codex-chat-runtime.js");
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, interrupted: await interruptCodexChat(req.params.id) });
  }));

  // 대화를 **터미널로 넘긴다**(#2055) — app-server 가 쥔 스레드를 놓아 주고, 사람이 pane 에서 이어가게 한다.
  //  왜 이 통로가 필요한가: codex 는 스레드당 writer 가 하나라, 우리 대화창이 쥔 대화는 pane 의 `codex resume` 이
  //  못 연다(active writer). 놓아 주는 유일한 방법이 **프로세스 종료**다(thread/unsubscribe 로는 안 풀린다 — 실측).
  //  돌려주는 thread_id 로 화면이 `codex resume <id>` 를 안내하면 대화가 안 끊긴다.
  app.post("/api/ui/terminal/sessions/:id/codex-chat/release", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    if (!(await canAttach(req.params.id, uid))) throw new HttpError(404, SESSION_NOT_FOUND);
    const { releaseCodexChat } = await import("./harness-io/codex-chat-runtime.js");
    const r = releaseCodexChat(req.params.id);
    res.setHeader("Cache-Control", "no-store");
    // 런타임이 없으면(이미 넘겼거나 tmux 모드) 그것도 정상 응답이다 — 화면이 '넘길 게 없다'를 구분할 수 있게 released 로 알린다.
    res.json({ ok: true, released: !!r, thread_id: r?.threadId ?? null });
  }));

  app.post("/api/ui/terminal/sessions/:id/prompt", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    const text = String(((req.body ?? {}) as Record<string, unknown>).text ?? "");
    if (!text.trim()) throw new HttpError(400, "보낼 내용이 없습니다");
    const { nodeOfSession } = await import("../node/registry.js");
    const nodeId = nodeOfSession(req.params.id);
    if (nodeId) {
      const v = await nodeCanAttach(nodeId, req.params.id, uid);
      if (!v.ok) throw new HttpError(v.code === 4410 ? 404 : v.code === 4462 ? 503 : 403, v.reason);
    } else if (!(await canAttach(req.params.id, uid))) {
      throw new HttpError(404, SESSION_NOT_FOUND);
    }
    // 배달 본체는 deliver-prompt.ts(#1631 — 리브 2턴이 같은 통로를 탄다). 접근 판정은 위에서 끝났다.
    const { deliverPrompt } = await import("./deliver-prompt.js");
    res.json(await deliverPrompt(req.params.id, text, { owner: uid, nodeId }));
  }));
  // 이미 떠 있는 세션의 **모델·추론강도**를 바꾼다(#1758) — 대화창 입력칸 아래 드롭다운이 부른다.
  //  세션은 이미 argv 로 떠 있어 플래그로는 못 바꾼다. 사람이 터미널에서 치는 것과 **같은 슬래시 명령**을 넣는 수밖에 없고,
  //  그 통로는 프롬프트와 **같은 아웃박스**다(#1753) — 직접 send-keys 하면 배달자가 프롬프트를 넣는 중간에 끼어들어
  //  둘 다 깨진다. 큐가 세션당 직렬이라 순서(모델 먼저, 그 다음 프롬프트)도 큐가 지킨다.
  //  제공자는 여기서 못 바꾼다 — 다른 CLI 를 띄우는 일이라 새 세션의 몫이다.
  //  ⚠ 하네스는 **서버가 해소한다**(desired-state → 노드 스냅샷 → tmux 옵션). 화면이 보낸 값을 믿으면 남의 하네스
  //   명령을 대신 치게 하는 통로가 된다. 값도 그 하네스 카탈로그의 선택지로 화이트리스트한다.
  app.post("/api/ui/terminal/sessions/:id/runtime", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    const b = (req.body ?? {}) as Record<string, unknown>;
    const AXES: ReadonlyArray<{ axis: "model" | "effort"; ko: string; flag: string }> = [
      { axis: "model", ko: "모델", flag: "--model" },
      { axis: "effort", ko: "추론강도", flag: "--effort" },
    ];
    const want = AXES.map((a) => ({ ...a, v: String(b[a.axis] ?? "").trim() })).filter((a) => a.v);
    if (!want.length) throw new HttpError(400, "바꿀 값이 없습니다");
    const nodeId = nodeOfSession(req.params.id);
    if (nodeId) {
      const v = await nodeCanAttach(nodeId, req.params.id, uid);
      if (!v.ok) throw new HttpError(v.code === 4410 ? 404 : v.code === 4462 ? 503 : 403, v.reason);
    } else if (!(await canAttach(req.params.id, uid))) {
      throw new HttpError(404, SESSION_NOT_FOUND);
    }
    const st = await getSessionState(req.params.id);
    const key = (nodeId ? nodeSessionHarness(nodeId, req.params.id) : "")
      || st?.harness
      || (await getOpt(req.params.id, "@box_harness").catch(() => ""))
      || "";
    const h = HARNESSES.find((x) => x.key === key);
    if (!h) throw new HttpError(409, "이 세션이 어떤 AI 로 떴는지 알 수 없어 여기서는 못 바꿉니다 — 터미널에서 바꿔 주세요.");
    const cmds: string[] = [];
    for (const w of want) {
      const make = h.runtimeCmd?.[w.axis];
      if (!make) throw new HttpError(409, `${h.label} 세션은 여기서 ${w.ko}를 바꿀 수 없습니다 — 터미널에서 바꿔 주세요.`);
      const choices = (h.flags.find((f) => f.name === w.flag)?.choices ?? []).filter(Boolean);
      if (!choices.includes(w.v)) throw new HttpError(400, `${h.label} 가 아는 ${w.ko}가 아닙니다: ${w.v}`);
      cmds.push(make(w.v));
    }
    res.setHeader("Cache-Control", "no-store");

    //  ★ #2439 — **대화 런타임 세션은 pane 이 셸이다.** 그 tmux 에 `/model …` 을 타이핑하면
    //   하네스가 아니라 **bash 가 받는다**(`/model: command not found`). 사람 눈엔 «바꿨다는데 안 바뀜» 이다.
    //   그래서 chat 모드면 프롬프트와 **같은 통로**(대화 런타임)로 보낸다 — claude·grok 은 슬래시를
    //   그 통로에서 처리한다(실측: stream-json 안에서 is_meta 로 돌고 API 비용 0).
    const { sessionRuntimeMode } = await import("./session-runtime-mode.js");
    if (sessionRuntimeMode({ harness: h.key }) === "chat") {
      const { deliverPrompt } = await import("./deliver-prompt.js");
      for (const c of cmds) await deliverPrompt(req.params.id, c, { owner: uid, nodeId });
      res.json({ ok: true, harness: h.key, sent: cmds, via: "chat" });
      return;
    }

    if (nodeId) {
      // 노드 세션은 아웃박스 배달자가 닿지 않는다(tmux 가 그 컴퓨터에 있다) — 프롬프트와 같은 릴레이 경로.
      const { injectPrompt } = await import("../node/session-inject.js");
      for (const c of cmds) {
        try { await injectPrompt(req.params.id, c); }
        catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          if (msg === "node-offline") throw new HttpError(503, "그 컴퓨터가 지금 연결돼 있지 않습니다.");
          if (msg.startsWith("node-unsupported-op:")) throw new HttpError(409, "그 컴퓨터의 라이블리가 오래돼 받지 못합니다. 업데이트가 필요합니다.");
          if (msg === "node-rpc-timeout") throw new HttpError(504, "그 컴퓨터가 응답하지 않습니다.");
          throw e;
        }
      }
      res.json({ ok: true, harness: h.key, sent: cmds });
      return;
    }
    const { enqueuePrompt, waitOutboxSettled } = await import("../sessions/session-outbox.js");
    const ids: number[] = [];
    for (const c of cmds) ids.push((await enqueuePrompt(req.params.id, c, { kind: "control" })).id);
    // 큐에 넣고 끝내지 않고 **잠깐 결말을 본다** — 입력창이 떠 있는 보통의 경우 몇 초 안에 끝나고, 그때 화면이
    //  '바꿨다/못 바꿨다'를 그 자리에서 말할 수 있다. 아직 대기 중이면 그 사실 그대로(pending) 돌려준다 —
    //  로그인 화면에 멈춘 세션은 뜨는 즉시 배달자가 넣는다(아웃박스가 들고 있다).
    const done = await waitOutboxSettled(ids, 8_000);
    if (done.failed) throw new HttpError(409, `바꾸지 못했어요 — ${done.failed}`);
    res.json({ ok: true, harness: h.key, sent: cmds, pending: !done.settled });
  }));
  // 여러 세션 통합 '내 질문' 검색(#745) — 내가 접근 가능한 세션(개인 소유/초대 + 내 프로젝트 세션)의 질문을 grep, 어느 세션인지와 함께.
  app.get("/api/ui/terminal/prompts/search", auth, wrap(async (req, res) => {
    const q = String((req.query.q ?? "") as string);
    const all = await listSessions(userOf(req));
    //  #1876 S2 — 여기 별도 필터를 두지 않는다. 종전엔 목록이 프로젝트 세션을 **전원에게** 주는 바람에
    //   `!isProjectSessionDir || s.owned` 로 급히 좁혀 놨는데, 그 표현은 두 가지를 동시에 틀렸다:
    //   남의 프로젝트 세션 질문이 새는 걸 막지 못하는 경우가 있었고(#1876 설계 §4-2), 반대로
    //   **내가 초대받은** 프로젝트 세션은 검색에서 빠졌다. 이제 listSessions 자체가 소유·초대로 걸러지므로
    //   그 결과를 그대로 쓰는 것이 정확하다 — 술어를 두 벌로 두지 않는다.
    const sessions = all
      .map((s) => ({ id: s.id, label: s.label, dir: s.dir, projectId: s.projectId }));
    // 임베딩 provider 켜져 있으면 의미(하이브리드) 검색, 아니면 렉시컬(토큰 AND+랭킹). 하이브리드 실패 시 렉시컬 폴백.
    const provider = await activeEmbeddingProvider().catch(() => null);
    let out;
    if (provider) { try { out = await searchPromptsHybrid(sessions, q, provider); } catch { out = await searchPrompts(sessions, q); } }
    else out = await searchPrompts(sessions, q);
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
  }));
  // 노드 세션 생성 게이트(#869) — 노드 실재·활성·연결 + **소유 또는 관리자 지정 공유**(#1540, nodeOpenTo).
  //  초대는 여기서 구성원 디렉터리로 검증해 노드엔 '검증된 목록'만 넘긴다(노드는 DB 가 없어 스스로 검증 불가 —
  //  F7 정책/실행 분리).
  //  ⚠ admin 우회를 **제거했다**(종전엔 관리자가 남의 개인 PC 에 세션을 열 수 있었다). 이 정책이 지키려는 게
  //   정확히 '남의 컴퓨터에서 코드가 도는 것'이고, 그럴 사람은 대개 관리자다. 관리자는 공유를 켜고 쓰면 된다 —
  //   그 편이 배지·감사로 드러난다. 프로젝트 경로(assertNodeUsable)엔 애초에 우회가 없어 이제 두 경로가 일치한다.
  //   노드 **관리**(토글·회전·삭제)의 admin 권한은 그대로다 — 관리 ≠ 사용.
  const requireCreatableNode = async (req: express.Request, nodeId: string): Promise<void> => {
    const n = await getNode(nodeId);
    if (!n || !n.enabled) throw new HttpError(404, `노드 없음: ${nodeId}`);
    // #2108 — 이 노드가 게이트웨이 자신이면 거절한다(피커에선 이미 빠졌고, 여기는 옛 화면·북마크·API 용).
    //  ⚠ 조용히 '중앙'으로 옮기지 않는다 — 노드와 박스는 같은 머신이어도 워크스페이스 뿌리가 다를 수 있어,
    //   말없이 옮기면 사람이 고른 것과 **다른 폴더**에서 세션이 열린다(#2022 가 세운 원칙: 모르면 멈춘다).
    if (isSelfNode(nodeId)) {
      throw new HttpError(409, `노드 '${nodeId}' 는 이 게이트웨이가 도는 바로 그 컴퓨터입니다 — 목록에서 '중앙 컴퓨터(기본)'를 고르세요. (그 컴퓨터에서 \`lively node stop\` 으로 노드 연결을 내리면 목록에서도 사라집니다)`);
    }
    if (!nodeOpenTo(n, idOf(userOf(req)))) {
      throw new HttpError(403, "본인이 등록한 노드가 아니고 공유 노드도 아닙니다 — 관리자가 공유 노드로 지정한 노드만 함께 쓸 수 있습니다");
    }
    // #1849 — 새 세션을 못 여는 것도 같은 뿌리다(실측: 사용자는 "세션도 안 열림"으로 겪었다).
    //  왜 오프라인인지 추정이 서면 함께 말한다 — 이 자리가 사용자가 실제로 막히는 지점이다.
    if (!nodeOnline(nodeId)) {
      const extra = await nodeOfflineNote(nodeId).catch(() => null);
      throw new HttpError(409, "노드가 오프라인입니다(에이전트 연결 대기)" + (extra ? `\n\n${extra}` : ""));
    }
  };

  app.post("/api/ui/terminal/sessions", auth, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const input: CreateInput = {
      label: String(b.label ?? ""), rootKey: String(b.rootKey ?? ""), subpath: String(b.subpath ?? ""),
      harness: String(b.harness ?? ""), flags: (b.flags && typeof b.flags === "object") ? b.flags as Record<string, unknown> : {},
      // #2162 — HTTP 요청을 kind 로 옮기는 **유일한 경계**. 여기 말고 다른 데서 loginFor/appId 로
      //  종류를 되짚지 마라(그게 갈라진 신호의 시작이었다). 이후 모든 판정은 kind 하나만 본다.
      kind: sessionKindFromRequest(b),
      autoApprove: !!b.autoApprove, invites: b.invites, loginProfile: !!b.loginProfile,
      readOnly: !!b.readOnly, // #1007 — 이 세션만 읽기전용(컨텍스트 스토어 쓰기 소거). 노드 세션도 아래 relay 가 input 스프레드로 전파.
      incognito: !!b.incognito, // #1007+ — 이 세션만 인코그니토(lively 전체 차단 + 훅 off). readOnly 보다 우선.
      // #1291 v2 — 새 세션 폼의 '기록 범위'. 안 읽으면 폼이 조용히 무시되고 사용자는 고른 대로 됐다고 믿는다.
      //  normalizeCap 이 모르는 값을 null 로 접어 미지정(폴더 파생)으로 되돌린다.
      writeVis: normalizeCap(b.writeVis as string) ?? undefined,
      // #1516 — 로그인 전용 세션(관리탭 [연결된 AI 계정] ▸ 로그인). 값 검증은 harnessLoginArgv 가 한다
      //  (아는 하네스만 로그인 argv 를 내주고, 모르는 값은 평범한 셸 세션으로 접힌다 — 임의 문자열이 명령이 되지 않는다).
      loginFor: String(b.loginFor ?? "") || undefined,
      // 첫 지시(하네스 입력창이 뜬 뒤 주입). cwd는 rootKey/subpath workspace 좌표이며 프로젝트 소속과 독립이다.
      // #1683 — 세션을 만든 브라우저 화면의 테마. 헤더가 정본이다(api() 가 모든 요청에 싣는다 — 호출부마다
      //  payload 를 고치지 않아도 전 경로가 덮인다). 바디는 헤더를 못 싣는 경로(노드 relay 재생성 등)용 폴백.
      theme: themeOf(req, b),
      initialPrompt: typeof b.initialPrompt === "string" && b.initialPrompt.trim() ? b.initialPrompt.slice(0, 20_000) : undefined,
      // #1780 D4 — 앱 세션. appId 를 주면 createSession 이 grant 검사·앱 토큰 발급·세션폴더 앱 홈/자산 물질화를 한다
      //  (없으면 일반 세션, 종전 경로 무변경). 존재·활성·grant 검증은 createSession(mintAppToken)이 하고 404/409/403 을 던진다.
      appId: String(b.appId ?? "").trim() || undefined,
    };
    // 홈 컴포저(첫 지시를 이미 들고 여는 미소속 세션)는 **프로젝트를 먼저 만들고 그 폴더에서** 연다(#1867).
    //  종전엔 개인 루트에서 열고 훅이 뒤늦게 소속만 붙여, 그 세션의 파일·워크트리가 개인 루트에 흩어졌다.
    //  실패하면 그냥 종전 경로(개인 루트) — 세션 생성을 막지 않는다. 빈 세션·앱·로그인·읽기전용은 대상이 아니다(순수 판정).
    const shellSpec = firstPromptProjectPlan(input);
    if (shellSpec) {
      const made = await createShellProject(shellSpec, idOf(userOf(req)));
      if (made) { input.projectId = made.id; input.projectSrc = "v6"; input.rootKey = "shared"; input.subpath = made.folder; }
    }
    const nodeId = String(b.node ?? "").trim();
    res.setHeader("Cache-Control", "no-store");
    if (nodeId) {
      await requireCreatableNode(req, nodeId);
      const me = idOf(userOf(req));
      const invites = await validateInvites(b.invites, me);
      // #1541 hostProfile — member 노드 && 생성자=주인이면 그 PC 의 네이티브 하네스 설정 그대로(CreateInput 주석). 조회 실패 = false(주입 유지).
      const hostProfile = await getNode(nodeId).then((n) => !!n && nodeHostProfile(n, me)).catch(() => false);
      const remoteInput = await prepareRemoteAppSession(input, me);
      const op: NodeOp = input.appId ? "createAppSession" : "create";
      // 프로젝트 세션이면 첫 지시를 create 에서 떼어 **DB 소속을 쓴 뒤** 넣는다(#1867) — 안 그러면 노드의 첫 훅이
      //  아직 없는 소속을 보고 또 프로젝트를 만든다. 소속 없는 세션은 종전대로 create 가 바로 넣는다(무회귀).
      const plan = nodeProjectCreatePlan(remoteInput, !!input.projectId && nodeSupports(nodeId, "injectFirstPrompt"));
      const session = await relayNodeOp<SessionInfo>(nodeId, op, { user: { userId: me }, input: { ...plan.createInput, invites: [], hostProfile }, invites });
      await recordSessionTenant(session.id, () => relayNodeOp(nodeId, "kill", { user: { userId: me }, id: session.id }));
      await registerSessionInstance(session.id, me, { appId: input.appId, projectId: input.projectId, title: session.label });
      if (input.projectId && input.projectSrc !== "org") {
        await bindNodeSessionProjectOrKill({
          nodeId, sessionId: session.id, requester: me, harness: session.harness || input.harness, projectId: input.projectId,
        });
      }
      // #1791 — desired-state 정본은 게이트웨이가 쓴다(노드엔 DB 가 없다). 죽어도 '복원 가능(그 노드)'로 남는 근거.
      await mirrorNodeSession({ ...session, invites }, nodeId, input, me);
      if (plan.deferredPrompt) {
        await injectDeferredFirstPrompt({
          nodeId, sessionId: session.id, harness: session.harness || input.harness, text: plan.deferredPrompt,
          trustOk: autoTrustWorkspace({ projectId: input.projectId, subpath: input.subpath }),
        });
      }
      res.json({ session: { ...withChatFields(session), node: { id: nodeId, online: true } } });
      return;
    }
    const session = await createSession(userOf(req), input);
    await recordSessionTenant(session.id, () => killSession(userOf(req), session.id, {}));
    await registerSessionInstance(session.id, idOf(userOf(req)), { appId: input.appId, projectId: input.projectId, title: session.label });
    res.json({ session: withChatFields(session) });
  }));
  // 실행 중 세션의 하네스·모델·추론강도를 한 번에 바꾸는 **겉보기 전환**.
  // CLI마다 런타임 설정 수단이 다르고(Codex는 /model 피커, Antigravity는 launch flag),
  // 같은 프로세스 안에서 정직하게 통일할 수 없다. 대신 같은 작업 폴더·프로젝트·권한으로 새 세션을 띄우고,
  // 화면이 보내 준 최근 공통 ChatLine 요약을 첫 지시로 주입한다. 사용자는 새 세션으로 곧바로 이동하고 계속 입력한다.
  // 원 세션은 건드리지 않는다 — 새 세션 생성이나 첫 지시가 실패해도 진행 중 작업을 잃지 않는 안전망이다.
  // #2055 — 세션 행의 «대화» 두 값을 **한 곳에서** 만든다. 목록과 생성 응답이 갈리면 방금 만든 세션만
  //  화면이 잘못 열린다(실측 2026-08-28 신고: codex 를 열면 터미널이 먼저 뜨고 몇 초 뒤 대화창으로 넘어갔다 —
  //  생성 응답에 chatMode 가 없어 화면이 «모르면 터미널» 로 추정했다가, 목록 갱신이 오면 되돌린 것이다).
  const chatFieldsOf = (harness: string, onNode = false): {
    chat: ReturnType<typeof chatIoCaps>;
    chatMode: ReturnType<typeof codexChatMode>;
    runtimeMode: ReturnType<typeof sessionRuntimeMode>;
    terminalOnly: string[];
  } => ({
    chat: chatIoCaps(harness),                       // #1746 하네스별 대화창 능력(읽기·승인)
    chatMode: codexChatMode({ harness }),            // 이 세션의 대화가 어디서 도나 — app-server 면 pane 이 셸이다
    //  #2439 — 하네스 **무관**한 런타임 모드. chat 이면 작업·승인·슬래시가 이벤트로 오므로 화면이
    //   상태 통로(SSE)를 연다. terminal 이면 열지 않는다 — 올 것이 없는 연결을 세션마다 만들지 않는다.
    runtimeMode: sessionRuntimeMode({ harness }),
    //  ★ #2439 — **이 하네스가 웹에서 못 하는 것들.** 화면이 그 자리에서 «터미널에서 하세요» 를
    //   정확히 말하기 위한 재료다. 이걸 안 주면 사람은 없는 기능을 찾아 헤매다 포기한다(막다른 길).
    //   빈 배열 = 이 하네스는 웹만으로 전부 된다.
    //  ⚠ 하네스 축만으로는 부족하다 — **노드 세션**은 대화 런타임이 아예 안 돈다(coverage 머리말).
    //   그 사실을 안 실으면 화면이 «웹에서 다 됩니다» 라고 거짓말한다.
    terminalOnly: sessionTerminalOnlyAxes(harness, onNode),
  });
  const withChatFields = <T extends { harness?: string; node?: unknown }>(s: T): T =>
    Object.assign(s, chatFieldsOf(String(s.harness || ""), !!s.node));

  app.post("/api/ui/terminal/sessions/:id/handoff", auth, wrap(async (req, res) => {
    const id = String(req.params.id || "");
    const me = idOf(userOf(req));
    const st = await getSessionState(id);
    if (!st) throw new HttpError(409, "이 세션의 실행 설정을 찾지 못해 전환할 수 없습니다 — 새 세션으로 열어 주세요.");
    if (st.owner !== me) throw new HttpError(403, "본인이 만든 세션만 다른 AI로 전환할 수 있습니다.");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const harness = String(b.harness ?? st.harness ?? "").trim();
    if (!HARNESSES.some((h) => h.key === harness && h.key !== "shell")) throw new HttpError(400, "전환할 AI가 올바르지 않습니다.");
    const flags = (b.flags && typeof b.flags === "object" && !Array.isArray(b.flags)) ? b.flags as Record<string, unknown> : {};
    const input = sessionHandoffInput(st, harness, flags, b.context);
    input.theme = themeOf(req, b);
    res.setHeader("Cache-Control", "no-store");
    const nodeId = st.node_id || nodeOfSession(id) || "";
    if (nodeId) {
      await requireCreatableNode(req, nodeId);
      const hostProfile = await getNode(nodeId).then((n) => !!n && nodeHostProfile(n, me)).catch(() => false);
      const session = await relayNodeOp<SessionInfo>(nodeId, "create", { user: { userId: me }, input: { ...input, invites: [], hostProfile }, invites: st.invites });
      await recordSessionTenant(session.id, () => relayNodeOp(nodeId, "kill", { user: { userId: me }, id: session.id }));
      await registerSessionInstance(session.id, me, { appId: input.appId, projectId: input.projectId, title: session.label });
      await mirrorNodeSession({ ...session, invites: st.invites }, nodeId, input, me);
      res.json({ ok: true, from: id, session: { ...session, node: { id: nodeId, online: true } } });
      return;
    }
    if (!(await canAttach(id, me))) throw new HttpError(409, "원래 세션이 이미 닫혀 전환할 수 없습니다 — 이어서 열기를 사용해 주세요.");
    const session = await createSession(userOf(req), input);
    await recordSessionTenant(session.id, () => killSession(userOf(req), session.id, {}));
    await registerSessionInstance(session.id, idOf(userOf(req)), { appId: input.appId, projectId: input.projectId, title: session.label });
    res.json({ ok: true, from: id, session });
  }));
  // 세션 수정 — 이름·초대 멤버 변경. 소유자만(서버가 강제 — 노드 세션은 노드측 assertManage 가 같은 규칙으로 강제).
  app.post("/api/ui/terminal/sessions/:id", auth, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const nodeId = String(b.node ?? req.query.node ?? "").trim();
    if (nodeId) {
      const me = idOf(userOf(req));
      const invites = b.invites !== undefined ? await validateInvites(b.invites, me) : undefined;
      await relayNodeOp(nodeId, "edit", {
        user: { userId: me }, id: req.params.id,
        patch: { label: b.label !== undefined ? String(b.label) : undefined },
        ...(invites !== undefined ? { invites } : {}),
      });
      // ★ **게이트웨이 DB 에도 남긴다**(#2251 · 원준 신고 2026-08-28: "이름을 수도 없이 고쳤는데 계속 되돌아간다").
      //  종전엔 여기서 그냥 return 해서, 노드 세션의 사람 이름이 **그 노드의 tmux `@box_label` 에만** 적혔다.
      //  노드는 DB 가 없어(#1791 ON_NODE) 노드측 editSession 의 미러도 통째로 no-op 이다. 그래서:
      //   ① 화면이 tmux 스냅샷 대신 DB 로 그리는 순간(노드 오프라인·tmux 종료·**복원**) 이름이 옛 자동 이름으로 스냅백.
      //      복원은 `label: st.label || id`(위 restore 분기)로 새 세션을 만들므로 되돌아간 이름이 그대로 굳는다.
      //   ② 더 나쁜 것 — **사람 이름 걸쇠가 안 걸린다.** label_source 가 'rule' 에 머무니
      //      `session_rename`(agent, RANK 3 > rule 2)이 claimSessionLabel 을 **이기고** 노드 tmux 까지 덮어쓴다
      //      (session-relabel.ts). 사람이 고친 이름을 에이전트가 조용히 되돌리는 그림이 이것이다.
      //      ※ #2234(PR #537)가 공유 홈 노드에서 session_rename 을 실제로 동작하게 만들면서 ②가 자주 터지게 됐다.
      //  ⚠ 순서는 **릴레이 뒤**다 — 노드의 assertManage 가 소유자를 강제하므로, 거기서 거부된 요청이 DB 에 먼저
      //   닿는 일이 없다(setSessionProject·relabelSession 과 같은 원칙: 남의 세션을 DB 에 먼저 claim 하지 않는다).
      //  ⚠ best-effort — 미러 행이 없는 옛 노드 세션(#1791 이전)은 그냥 종전대로 tmux 만 바뀐다(무회귀).
      if (b.label !== undefined) {
        const clean = String(b.label).replace(/[\t\n\r]/g, " ").trim().slice(0, 80);
        if (clean) {
          await claimSessionLabel(req.params.id, clean, "human", me)
            .catch((e) => { console.warn(`[terminal] 노드 세션 이름 DB 반영 실패(${req.params.id}):`, (e as Error)?.message ?? e); return false; });
        }
      }
      // 초대도 같은 이유로 미러한다 — 복원은 `invites: st.invites`(위 restore 분기)를 쓰므로, 여기서 안 남기면
      //  노드 세션은 복원 한 번에 초대가 사라진다.
      if (invites !== undefined) {
        await updateSessionStateMeta(req.params.id, { invites })
          .catch((e) => console.warn(`[terminal] 노드 세션 초대 DB 반영 실패(${req.params.id}):`, (e as Error)?.message ?? e));
      }
      res.json({ ok: true });
      return;
    }
    await editSession(userOf(req), req.params.id, {
      label: b.label !== undefined ? String(b.label) : undefined,
      invites: b.invites,
    });
    res.json({ ok: true });
  }));
  app.delete("/api/ui/terminal/sessions/:id", auth, wrap(async (req, res) => {
    const nodeId = String(req.query.node ?? "").trim();
    // 회수(보관) 여부는 **노드 분기보다 먼저** 읽는다 — 종전엔 아래(박스 분기)에서만 읽어, 노드 세션은
    //  reclaim=1 을 줘도 desired-state 를 지워 '보관'이 곧 '완전 삭제'가 됐다(#1719 원준의 세션 보관함).
    const reclaimQ = req.query.reclaim === "1" || req.query.reclaim === "true";
    // 맵 정리는 best-effort — 남은 행은 무해하다(세션 id 는 무작위라 재사용되지 않고, 죽은 세션은 참조되지 않는다).
    const forgetTenantMap = (): void => { void clearSessionWorkspace(req.params.id!).catch(() => { /* 비치명 */ }); };
    if (nodeId) {
      const me = idOf(userOf(req));
      const id = req.params.id;
      // #1791 — 노드 세션 종료 = 그 노드의 tmux 를 죽이고 desired-state 행을 지운다('복원 안 함'). 살아 있는지의 판정은
      //  **스냅샷이 아니라 노드에 묻는다**(gone op — nodeCanAttach 의 '확답 only' #835 와 같은 원칙): 스냅샷은 게이트웨이
      //  재시작 직후·생성 직후 3초 동안 비어 있고 뷰어별 가시성 필터라(admin 이 남의 세션을 지울 때) 살아 있는 세션을
      //  '죽었다'고 오판해 **행만 지우고 tmux 는 남기는** 고아를 만든다 — 그게 이 과업이 없애려던 사고 그 자체다.
      const st = await getSessionState(id);
      const snap = nodeSessionsFor(me).find((x) => x.node.id === nodeId && x.id === id);
      if (!st && !snap) throw new HttpError(404, "그 노드에 이 세션이 없습니다");
      // 행이 있으면 그 행의 노드여야 한다 — 박스 세션(node_id NULL)에 ?node= 를 붙여 오면 엉뚱한 노드가 '없다'고 답해
      //  kill 없이 행만 지워지는 구멍이 된다(리뷰 지적). 행이 없는 옛 노드 세션(#1791 이전 생성)만 스냅샷으로 진행.
      if (st && st.node_id !== nodeId) throw new HttpError(404, "그 노드에 이 세션이 없습니다");
      const admin = !!userOf(req).scopes?.includes("admin");
      if (st && st.owner !== me && !admin) throw new HttpError(403, "본인 세션이 아닙니다");
      let killed = false;
      if (nodeOnline(nodeId)) {
        // 노드가 답해서 '없다'고 할 때만 kill 을 건너뛴다. 못 물으면(타임아웃) 살아 있다고 보고 kill 을 보낸다 — kill 이
        //  '그런 세션 없음'으로 실패하면 한 번 더 물어 정말 없을 때만 행 삭제로 진행한다(모르면 파괴적 정리를 안 한다).
        //  3값: true=노드가 '없다'고 답함 · false=살아 있음 · null=못 물음(타임아웃). false 와 null 은 둘 다 kill 로 간다 —
        //  모르면 살아 있다고 보는 게 안전측이고, kill 이 '없음'으로 실패하면 아래 재확인이 정말 없을 때만 삭제로 잇는다.
        const gone: boolean | null = await nodeRpc<boolean>(nodeId, "gone", { id }).catch(() => null);
        if (gone !== true) {
          try { await relayNodeOp(nodeId, "kill", { user: { userId: me }, id }); killed = true; }
          catch (e) {
            const goneNow = await nodeRpc<boolean>(nodeId, "gone", { id }).catch(() => null);
            if (goneNow !== true) throw e;
          }
        }
      }
      // 보관(reclaim=1)이면 **행을 남긴다** — tmux 만 내리고 좌표·대화 id 는 DB 에 그대로 두어 restorable 로 남는다.
      //  복원 경로(POST …/restore)가 st.node_id 를 보고 그 노드에 다시 create 를 릴레이하므로 노드 세션도 되살아난다.
      //  기본(완전 삭제)은 종전과 같다: 노드가 꺼져 있어 tmux 를 못 건드려도 사용자가 '복원 안 함'을 명시했으니 행은 지운다.
      if (reclaimQ) {
        // ⚠ 노드가 꺼져 있으면 **아무것도 못 했으면서 ok 를 주지 않는다**(상민님 2026-08-21 "여전히 X 안 된다").
        //  종전엔 kill 을 건너뛰고 {ok:true} 를 돌려줘, 화면은 "지난 세션으로 보냈어요" 를 띄우는데 목록은 그대로였다
        //  — 사용자에겐 '눌러도 안 없어지는 ×' 였다. 그 PC 가 켜져야 그 세션을 멈출 수 있다는 게 사실이므로 그대로 말한다.
        if (!killed && !nodeOnline(nodeId)) {
          throw new HttpError(503, "그 컴퓨터(" + nodeId + ")가 지금 연결돼 있지 않아 이 세션을 멈출 수 없어요 — 켜지면 다시 시도해 주세요");
        }
        res.json({ ok: true, reclaimed: true, killed });
        return;
      }
      await deleteSessionState(id).catch((e) => logger.warn({ err: e, id }, "노드 세션 desired-state 삭제 실패(비치명)"));
      //  이 경로는 노드에 kill 을 **릴레이**하므로 게이트웨이 killSession 을 안 거친다 — 인스턴스는 여기서 닫는다(#1954 후속).
      await closeSessionAppInstances(id).catch((e) => logger.warn({ err: e, id }, "앱 인스턴스 닫기 실패(비치명)"));
      forgetTenantMap();
      res.json({ ok: true, forgot: !killed });
      return;
    }
    // #1059 F — 회수(reclaim=1): desired-state 를 보존해 restorable 로 남긴다(vs 기본 = 완전 삭제·복원 안 함).
    //  admin bypass 는 **회수에만** 허용한다(복원 가능한 안전 동작) — 남의 세션을 파괴적으로 삭제하는 건 admin 도 못 하고 소유자만.
    const u = userOf(req);
    const reclaim = reclaimQ;
    // #1059 E — restorable(이미 tmux 에서 죽은) 세션의 '삭제' = desired-state 레코드 제거(복원 목록에서 지움).
    //  killSession 의 assertManage 는 tmux @box_owner 메타를 읽는데 세션이 gone 이면 그 메타가 없어 403 이 된다.
    //  그래서 gone + DB 레코드 존재 시엔 DB 레코드의 owner 로 권한을 확인하고 레코드만 지운다(멱등).
    if (!reclaim && await sessionGone(req.params.id)) {
      const st = await getSessionState(req.params.id);
      if (st) {
        if (st.owner !== idOf(u) && !u.scopes?.includes("admin")) throw new HttpError(403, "본인 세션이 아닙니다");
        await deleteSessionState(req.params.id);
        await closeSessionAppInstances(req.params.id).catch((e) => logger.warn({ err: e, id: req.params.id }, "앱 인스턴스 닫기 실패(비치명)"));
        forgetTenantMap();
        res.json({ ok: true, forgot: true });
        return;
      }
    }
    // ⚠ admin 회수는 reaper 와 달리 attached/busy/waiting 를 검사하지 않는다 — **의도된 긴급 override**(break-glass):
    //  #1059 OOM 위기처럼 박스가 위태로우면 관리자가 작업 중·접속 중 세션도 즉시 회수해 메모리를 되찾아야 한다.
    //  파괴적이지 않다 — preserveState 로 desired-state 를 남겨 restorable 로 복원 가능(자동 reaper 가 정당세션을 보호하는 것과 역할 분담).
    const admin = reclaim && !!u.scopes?.includes("admin");
    await killSession(u, req.params.id, { admin, preserveState: reclaim });
    if (!reclaim) forgetTenantMap(); // 회수(복원 가능)는 소속을 남긴다 — 복원 세션이 제 워크스페이스로 돌아가야 한다
    res.json({ ok: true });
  }));
}

// ── ③ 복원(#1059 E) + 하네스 훅 보고(active·claude-uuid·exited, #1221) + 관리자 전 세션 메타뷰(#1059 F) ──
function registerRestoreReportRoutes(app: express.Express, auth: express.RequestHandler): void {
  // 복원(#1059 E) — restorable(재부팅/reaper 로 tmux 에서 사라졌으나 desired-state 가 DB 에 남은) 세션을 lazy 재생성한다.
  //  저장된 desired-state(rootKey·subpath·harness·flags·invites·mode)로 createSession 하고, claude 하네스는 resume=<옛 id>
  //  로 대화를 잇는다 — 로컬 트랜스크립트(~/.claude/…/<id>.jsonl)는 재부팅에도 디스크에 살아남아 claude --resume 이 찾는다
  //  (전부 자동 spawn 이 아니라 '열 때만' 재생성 = 재부팅 직후 OOM 재현 방지, #1059 E). 소유자 또는 admin 만.
  //  원 소유자 신원으로 재생성해야 격리(box_owner)·CLAUDE_CONFIG_DIR·git 자격이 원 세션과 같다. 새 tmux id 를 얻으므로
  //  옛 desired-state 레코드는 지운다(새 세션이 자기 레코드를 가짐 → restorable 카드가 라이브 세션으로 교체된다).
  app.post("/api/ui/terminal/sessions/:id/restore", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const id = req.params.id;
    const st = await getSessionState(id);
    // #2231 — 이 id 는 **이미 이어졌다**(다른 탭·다른 칸이 먼저 눌렀거나, 이 화면이 그 전에 열린 낡은 화면이다).
    //  종전엔 옛 행을 지워 404 였고, 사용자는 대화가 멀쩡히 도는데도 `복원할 세션 상태가 없습니다` 앞에서 멈췄다.
    //  이제는 두 번째 사람에게 **이어진 세션을 돌려준다** — 화면이 그리로 옮겨 가면 끝이다(경합이 곧 정답이 된다).
    if (st?.superseded_by) {
      if (st.owner !== idOf(userOf(req)) && !userOf(req).scopes?.includes("admin")) throw new HttpError(403, "이 세션을 복원할 수 없습니다(소유자만 가능).");
      const to = (await resolveSessionSuccessor(id).catch(() => null)) ?? st.superseded_by;
      res.json({ ok: true, already: true, id: to, movedTo: to });
      return;
    }
    // 행이 아예 없는 옛 세션(이정표가 생기기 전에 복원된 것·사람이 완전 삭제한 것·워크스페이스 회수).
    //  그래도 포기하지 않는다 — **대화로 되찾는다**(resolveSessionSuccessor → successorByConversation).
    //  ⚠ 안내는 **행이 있고 내 것인** 세션으로만 한다(남의 세션으로 보내지 않는다).
    if (!st) {
      const to = await resolveSessionSuccessor(id).catch(() => null);
      const toSt = to ? await getSessionState(to).catch(() => undefined) : undefined;
      const uid = idOf(userOf(req));
      if (to && toSt && (toSt.owner === uid || userOf(req).scopes?.includes("admin"))) {
        logger.info({ id, movedTo: to }, "restore: 행이 없는 옛 id — 같은 대화의 최신 세션으로 안내(#2231)");
        res.json({ ok: true, already: true, id: to, movedTo: to });
        return;
      }
      // 🔴 4xx 는 wrap() 이 로그를 안 남긴다(rest-util) — 이 404 가 어떤 id 였는지 흔적이 0건이라
      //  2026-08-27 신고 재구성에 로그 대신 DB·tmux·트랜스크립트를 맞춰 봐야 했다. 여기만은 남긴다.
      logger.warn({ id, requester: uid }, "restore: 되살릴 desired-state 가 없다(#2231 — 대화로도 못 찾음)");
      throw new HttpError(404, "이 세션은 이미 이어졌거나 정리돼 되살릴 것이 없습니다 — 목록을 새로고침하면 이어진 세션이 보입니다.");
    }
    const u = userOf(req);
    const me = idOf(u);
    if (st.owner !== me && !u.scopes?.includes("admin")) throw new HttpError(403, "이 세션을 복원할 수 없습니다(소유자만 가능).");
    // #1791 — **노드 세션**의 복원: 그 노드에 create 를 다시 릴레이한다(좌표·하네스·모드·초대는 desired-state 그대로).
    //  박스 복원과 같은 원칙(원 소유자 신원·새 id·옛 행 삭제·대화 id 승계). 다른 점 둘 — ① 라이브 경합은 게이트웨이 tmux 가
    //  아니라 노드 스냅샷으로 본다 ② 이어받을 대화 파일이 노드에 있어 여기서 존재 확인(transcriptExists)을 못 한다: 훅이
    //  보고한 대화 id 가 있으면 그대로 시도하고, 없으면 picker. 없는 id 로 열려도 #1516 런처(POSIX)가 세션을 살려 두고,
    //  윈도우(psmux)는 원문 에러가 화면에 남는다 — 어느 쪽도 조용한 루프는 아니다(restored=1 게이트가 한 번 더 막는다).
    if (st.node_id) {
      const nodeId = st.node_id;
      if (nodeSessionsFor(me).some((x) => x.node.id === nodeId && x.id === id)) { res.json({ ok: true, already: true, id, node: { id: nodeId } }); return; }
      // #1849 — "연결돼 있지 않습니다"에서 끝내지 않는다: 게이트웨이는 그 노드의 연결 이력을 갖고 있으므로
      //  **왜 그런지(잠자기 추정)와 무엇을 하면 되는지**까지 말할 수 있다. 진단 조회가 실패해도 원래 문구는 나간다.
      if (!nodeOnline(nodeId)) {
        const extra = await nodeOfflineNote(nodeId).catch(() => null);
        throw new HttpError(409, "그 세션이 있던 컴퓨터(노드)가 지금 연결돼 있지 않아 복원할 수 없습니다. 노드가 켜지면 다시 시도하세요."
          + (extra ? `\n\n${extra}` : ""));
      }
      // 라이브 경합은 **노드에 묻는다**(gone op) — 스냅샷은 재시작 직후·생성 직후 비어 있고 뷰어별 필터라(admin) 살아 있는 세션을
      //  놓칠 수 있다. 확답을 못 받으면 복원하지 않는다(모르면 같은 세션을 둘로 만들지 않는다 — #835 '확답 only').
      const gone = await nodeRpc<boolean>(nodeId, "gone", { id }).catch(() => null);
      if (gone === false) { res.json({ ok: true, already: true, id, node: { id: nodeId } }); return; }
      if (gone === null) throw new HttpError(409, "그 컴퓨터(노드)가 응답하지 않아 세션 상태를 확인하지 못했습니다 — 잠시 후 다시 시도하세요.");
      // #2022 — 게이트웨이가 **노드 스냅샷에서 발견한** 행은 workspace 좌표를 모른다(그 컴퓨터에서 직접 띄운 세션).
      //  아래 폴백(root_key || "shared")이 그걸 추측하면 그 세션이 **엉뚱한 폴더에서** 되살아난다 —
      //  AI 가 다른 프로젝트의 파일을 자기 작업 폴더로 알고 만지게 된다. 모르면 모른다고 말하고 멈춘다.
      if (st.discovered && !st.root_key) {
        throw new HttpError(409, "이 세션은 그 컴퓨터에서 직접 만들어진 것이라 되살릴 작업 폴더 좌표를 모릅니다 — 그 컴퓨터에서 이어서 시작해 주세요.");
      }
      // #2122 — 매핑 소스를 셋으로 넓힌다(종전엔 desired-state 행 하나뿐이라, 그 컬럼이 한 번 null 이 되면 영영 picker).
      //  ① desired-state 행 ② 노드 세션 **내구 맵**(org_node_session_map — 세션 수명과 무관하게 남는 표, #1752)
      //  ③ 저장된 대화 파일 경로에서 재독(convIdFromTranscriptPath). ②③ 은 ①이 비었을 때만 본다(=null 전파 자가치유).
      const durableMap = st.claude_session_id ? null : (await nodeSessionMapFor([id]).catch(() => null))?.get(id) ?? null;
      const resumeId = st.claude_session_id || durableMap?.conv_uuid || convIdFromTranscriptPath(st.harness, st.transcript_path);
      const input: CreateInput = {
        // #2162 — 복원은 **원래 종류를 되살린다**. human 으로 굳히면 앱 세션이 복원될 때 종류를 잃는다.
        kind: normalizeSessionKind(st.kind),
        label: st.label || id, rootKey: st.root_key || "shared", subpath: st.subpath || "",
        harness: st.harness || "claude", flags: st.flags || {}, autoApprove: st.auto_approve,
        projectId: st.project_id || undefined, projectSrc: st.project_src === "org" ? "org" : "v6",
        readOnly: st.read_only, incognito: st.incognito,
        writeVis: st.write_vis ?? undefined, restrictRead: !!st.restrict_read,
        appId: st.app_id || undefined,
        ...(resumeId ? { resume: resumeId } : { resumePick: true }),
      };
      const owner = st.owner;
      // #1541 hostProfile — 원 소유자 기준(생성 때와 같은 판정). 조회 실패 = false(주입 유지).
      const hostProfile = await getNode(nodeId).then((n) => !!n && nodeHostProfile(n, owner)).catch(() => false);
      const invites = Array.isArray(st.invites) ? st.invites : [];
      const remoteInput = await prepareRemoteAppSession(input, owner);
      const op: NodeOp = input.appId ? "createAppSession" : "create";
      const session = await relayNodeOp<SessionInfo>(nodeId, op, { user: { userId: owner }, input: { ...remoteInput, invites: [], hostProfile }, invites });
      await recordSessionTenant(session.id, () => relayNodeOp(nodeId, "kill", { user: { userId: owner }, id: session.id }));
      await registerSessionInstance(session.id, owner, { appId: input.appId, projectId: input.projectId, title: session.label });
      await mirrorNodeSession({ ...session, invites }, nodeId, input, owner);
      // #2122 ① — 승계를 **권위화**한다: 결과를 보고, 실패하면 옛 행을 지우지 않는다(아래). 노드 세션은 내구 맵에도
      //  쓴다 — 그 표는 INSERT ON CONFLICT 라 desired-state 행이 아직 없어도(미러 실패) 매핑이 남는다.
      const inRow = resumeId ? await carryConvMapping(session.id, resumeId, { owner, transcript_path: st.transcript_path }) : false;
      const inMap = resumeId
        ? await setNodeSessionMap(session.id, nodeId, resumeId, owner, st.transcript_path)
            .catch((e) => { logger.warn({ err: e, id: session.id }, "restore(node): 내구 맵 승계 실패"); return false; })
        : false;
      const carried = mayForgetOldState(resumeId, inRow, inMap);   // 둘 중 하나라도 남았으면 매핑은 살아 있다
      if (!carried) logger.error({ id, newId: session.id, convId: resumeId }, "restore(node): 대화 id 승계가 어디에도 안 남았다 — 옛 desired-state 를 보존한다(#2122)");
      //  ⚠ 옛 행은 **승계가 확인됐을 때만** 지운다. 종전엔 무조건 지워서, 승계가 조용히 실패하면 매핑의 마지막
      //   사본이 함께 사라졌다(그 뒤 복원은 영구 picker). 남겨두면 복원 목록에 옛 카드가 한 장 남지만(눈에 보이고
      //   사용자가 지울 수 있다) 대화를 잃지는 않는다 — 다음 복원이 그 행에서 매핑을 다시 이관한다(자가치유).
      //  #2231 — 지우지 않고 **이어진 곳을 적는다**(옛 id 를 든 화면·링크가 새 세션으로 이어지도록). 목록에서 빠지는 건 같다.
      if (carried) await markSessionSuperseded(id, session.id).catch((e) => logger.warn({ err: e, id }, "restore(node): 옛 desired-state 이정표 기록 실패(비치명)"));
      const ln = liveNodes().find((n) => n.id === nodeId);
      res.json({ ok: true, session: { ...session, node: { id: nodeId, name: ln?.name || nodeId, online: true } } });
      return;
    }
    // 라이브 경합 방어 — 그새 다시 떠 있으면 복원 대신 그대로 안내(라이브가 SoT).
    if (!(await sessionGone(id))) { res.json({ ok: true, already: true, id }); return; }
    const owner = { userId: st.owner } as LivelyUser;
    // 이어받을 대화 UUID — **훅이 보고한 매핑만** 쓴다(그 대화 파일이 그 소유자 홈에 실제로 있을 때만).
    //  없으면 인자 없는 --resume = 후보 picker 로, **사용자가 눈으로 고른다.**
    //  ⚠ '그 폴더의 가장 최근 대화'를 추측하는 폴백을 넣었다가 뺐다(2026-07-28): ① 격리(#524)에서는 멤버마다
    //   홈이 따로라 남의 홈 대화를 집을 수 있고, 그러면 그 세션은 못 읽어 claude 가 "No conversation found" 로
    //   즉시 죽는다(마이크 실측 사고) ② 소유자로 스코프해도 **같은 폴더의 다른 대화**를 '최신'이라며 집을 수 있다
    //   — 그럴싸하게 틀리는 쪽이 picker 한 번 고르는 것보다 나쁘다(상민님 판단). 추측하지 않는다.
    //  ⚠ #1711 — 종전엔 여기에 `st.harness === "claude"` 가 걸려 있어 **claude 세션만** 정밀 복원됐다. 그래서
    //   antigravity·codex·opencode 세션은 '이어서 열기'를 해도 늘 새 대화로 열렸다(상민님 신고). 매핑 컬럼
    //   claude_session_id 는 이름만 claude 일 뿐 값은 **그 하네스의 대화 id** 다 — work-flag 훅이 하네스와 무관하게
    //   보고하고(어댑터가 conversationId·sessionID 를 session_id 로 넘긴다), 이어받기 argv 는 카탈로그가 만든다.
    //  ⚠ 대화 존재 확인(transcriptResumable)은 claude 의 `~/.claude/projects` 규약 전용이라 claude 에서만 한다.
    //   다른 하네스는 저장 위치 규약을 실측하기 전까지 검사 없이 시도한다 — 없는 id 로 시작해도 #1516 런처가
    //   세션을 살려 두고 하네스의 원문 에러를 화면에 남기므로, 종전의 '복원 루프'(즉사→재복원)는 구조적으로 끊겨 있다.
    //  ⚠ #1437 ② — 그 확인은 **소유자 실행환경**에서 한다(transcriptResumable). 종전 transcriptExists 는 게이트웨이
    //   로컬 fs 만 봐서, 중계 배포(대화 파일이 노드 멤버 홈)에선 항상 false → **늘 picker**였다(정밀 복원이 죽어 있었다).
    //  ⚠ #2122 — DB 매핑이 **비어 있어도** 저장된 대화 파일 경로가 남아 있으면 거기서 대화 id 를 재독한다(추측 아님 —
    //   훅 보고 때 경로·id 일치를 강제했고, 여기선 그 하네스의 id 규약으로 한 번 더 거른다). 종전엔 컬럼이 한 번
    //   null 이 되면 그 세션은 **영구 picker** 였다(매핑을 되찾을 길이 없었다).
    const mappedId = st.claude_session_id || convIdFromTranscriptPath(st.harness, st.transcript_path);
    const resumeUuid = mappedId
      && (st.harness !== "claude" || await transcriptResumable(id, st, mappedId).catch(() => false))
      ? mappedId : null;
    const precise = !!resumeUuid;
    const session = await createSession(owner, {
      kind: normalizeSessionKind(st.kind),   // #2162 — 복원은 원래 종류를 되살린다
      label: st.label || id, rootKey: st.root_key || "shared", subpath: st.subpath || "",
      harness: st.harness || "claude", flags: st.flags || {}, autoApprove: st.auto_approve,
      invites: st.invites, projectId: st.project_id || undefined,
      projectSrc: st.project_src === "org" ? "org" : "v6",
      readOnly: st.read_only, incognito: st.incognito,
      // #1780 D3-4 — 앱 세션 복원은 **D4 전체를 재실행**한다: appId 를 넘기면 createSession 이 grant 재검사·앱 토큰
      //  재발급·앱 홈/자산 재물질화를 다시 돈다(reaper 가 보존한 옛 토큰은 죽은 토큰이라 새 id 로 새로 굽는다).
      //  app_id 는 일반 세션에선 null 이라 무회귀. grant 가 회수됐으면 여기서 403 = 복원 거부(설계 의도).
      appId: st.app_id || undefined,
      // #1059 정밀 복원 — work-flag 훅이 보고한 claude UUID 가 있고 **그 대화 기록이 실제로 있으면** 그걸로 정확히
      //  이어받는다(--resume <uuid>). 없으면(셸·코덱스·미보고·기록 없음) 인자 없는 --resume(후보 picker)로 폴백한다.
      //  ⚠ 기록 확인이 필수다: 없는 UUID 로 resume 하면 claude 가 즉시 종료되고 box-spawn 이 exec 라 tmux 세션도
      //   사라져 웹터미널이 4410 → 자동 복원 → 또 즉사 로 **복원 루프**를 돈다(실측 신고). 매핑이 있어도 대화가
      //   없을 수 있다 — SessionStart 훅은 한 줄도 쌓이기 전에 UUID 를 보고한다.
      //  createSession 이 claude 하네스에서만 적용(resume 우선 · 없으면 resumePick).
      ...(precise ? { resume: resumeUuid as string } : { resumePick: true }),
    });
    // #1059 — 매핑 승계: 새 세션 레코드에 옛 claude UUID 를 물려준다. 이 대화를 `--resume <uuid>` 로 이어받았으니 같은
    //  UUID 를 계속 쓰는데, 새 레코드는 훅이 보고할 때까지 비어 있어 **그 사이에 또 복원하면 picker 로 떨어졌다**
    //  (2026-07-28 상민님 신고 — 정밀 복원이 한 번만 되는 증상의 절반. 나머지 절반은 훅 dedup 키에 box-id 부재였다).
    //  훅이 새 UUID 를 보고하면 last-write-wins 로 갱신되므로 이 승계는 '보고 전 공백'만 메운다.
    //  ⚠ #2122 — 이 승계는 더 이상 best-effort 가 아니다. 박스 세션엔 노드 세션의 org_node_session_map 같은 내구
    //   사이드테이블이 없어, 옛 행이 매핑의 **유일한 사본**이다: 승계가 조용히 실패한 채 옛 행을 지우면 그 대화는
    //   영영 못 찾는다(그 뒤 복원은 전부 picker). 그래서 결과를 확인하고, 실패하면 아래에서 옛 행을 지우지 않는다.
    const inRow = mappedId
      ? await carryConvMapping(session.id, mappedId, { owner: st.owner, transcript_path: st.transcript_path })   // #1746 대화 파일 경로도 승계(같은 대화 = 같은 파일)
      : false;
    //  박스 세션엔 내구 맵이 없다(노드 세션의 org_node_session_map 은 노드 전용) → 세 번째 인자는 늘 false.
    const carried = mayForgetOldState(mappedId, inRow, false);
    if (!carried) logger.error({ id, newId: session.id, convId: mappedId }, "restore: 대화 id 승계 실패 — 옛 desired-state 를 보존한다(#2122)");
    // #2154 ② — **아직 배달 안 된 지시**를 새 세션으로 승계한다. 큐의 라우팅 키가 session_id 라, 안 옮기면
    //  세션이 죽어 있는 동안 큐가 들고 있던 첫 지시가 죽은 id 에 묶여 영영 못 나간다(그러면 '보존'이 말뿐이다).
    //  이미 배달된(delivered·sent) 것은 안 옮긴다 — 옮기면 같은 지시가 두 번 실행된다(carryOutbox 머리말).
    try {
      const { carryOutbox } = await import("../sessions/session-outbox.js");
      const moved = await carryOutbox(id, session.id);
      if (moved) logger.info({ id, newId: session.id, moved }, "restore: 미배달 지시 승계");
    } catch (e) { logger.warn({ err: e, id, newId: session.id }, "restore: 미배달 지시 승계 실패(비치명 — 옛 행은 남는다)"); }
    //  복원도 세션 생성이다 — 새 id 로 인스턴스를 세운다(옛 세션의 인스턴스는 아래 옛 행 정리와 함께 닫힌다).
    await registerSessionInstance(session.id, st.owner, { appId: st.app_id, projectId: st.project_id, title: st.label || session.label });
    await closeSessionAppInstances(id).catch((e) => logger.warn({ err: e, id }, "restore: 옛 앱 인스턴스 닫기 실패(비치명)"));
    //  ⚠ #2122 — 옛 행은 **승계가 확인됐을 때만** 지운다(위). 남겨두면 복원 목록에 옛 카드가 한 장 남지만(눈에
    //   보이고 사용자가 지울 수 있다) 대화를 잃지는 않는다 — 다음 복원이 그 행에서 매핑을 다시 이관한다(자가치유).
    //  #2231 — 지우지 않고 **이어진 곳을 적는다**(옛 id 를 든 화면·링크가 새 세션으로 이어지도록). 목록에서 빠지는 건 같다.
    if (carried) await markSessionSuperseded(id, session.id).catch((e) => logger.warn({ err: e, id }, "restore: 옛 desired-state 이정표 기록 실패(비치명)"));
    res.json({ ok: true, session });
  }));

  // #1059 — 하네스 훅(work-flag)이 **"이 세션 지금 활동했다"**를 보고한다. 회수(F)가 이 시각을 본다.
  //  왜: 종전 활동 관측은 게이트웨이가 5분마다 pane 제목 스피너를 훔쳐보는 방식이라 tick 사이에 짧게 끝나는
  //   작업을 놓쳤고(그 세션이 회수될 수 있었다), 화면 스크래핑이라 UI 변경에 깨진다. 훅은 툴 사용마다 실제로
  //   실행되므로 추측이 아니다. 훅이 60초 스로틀을 걸어 핫패스 부담을 억제한다.
  //  owner-gated: setClaudeSessionId 와 동형 — desired-state 레코드가 있고 그 소유자일 때만(남의 세션 시각을
  //   조작하면 회수 판정을 흔들 수 있다). 레코드가 없으면 404 — 백필이 곧 만든다.
  //  #1221 — 같은 경로로 **실행 단계**(state: busy·waiting·idle)까지 받는다. 새 엔드포인트를 따로 두지 않은 이유는
  //   훅과 게이트웨이가 **따로 업데이트되기 때문**이다: 새 훅 + 구 게이트웨이는 모르는 필드를 무시하고 활동 보고만
  //   되고(무회귀), 구 훅 + 새 게이트웨이는 state 없이 종전대로 동작한다. 새 경로였다면 앞 조합이 404 로 죽는다.
  // 전이 하나를 그 세션 주인에게 민다(#1842). **무엇이 알림인지는 여기서 정하지 않는다** — 앱이 해석한다.
  //  이름은 지금 하는 일(pane 제목)이 있으면 그걸, 없으면 세션 라벨을 준다(앱이 다시 폴백한다).
  const notifyPhaseChange = async (id: string, owner: string, change: { prev: string | null; phase: string; at: number }, nameHint?: string): Promise<void> => {
    try {
      // 노드 세션의 tmux 는 그 PC 에 있어 getSessionLabel(로컬 tmux)이 못 읽는다 → 호출자가 아는 이름을 준다.
      publishNotify(owner, {
        type: "session", id, name: nameHint || (await getSessionLabel(id).catch(() => "")) || "",
        prev: change.prev, phase: change.phase,
        key: sessionEventKey(id, change.phase, change.at), ts: change.at,
      });
    } catch (e) { logger.warn({ err: e, id }, "알림 전달 실패(비치명)"); }
  };

  app.post("/api/ui/terminal/sessions/:id/active", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const id = req.params.id;
    const raw = ((req.body ?? {}) as Record<string, unknown>).state;
    const phase = isReportedPhase(raw) ? raw : undefined;   // 모르는 값은 조용히 무시(활동 보고만) — 훅이 앞서갈 수 있다
    const me = idOf(userOf(req));
    const st = await getSessionState(id);
    // #1791 — 노드 세션도 이제 행이 있다(node_id). 그 세션의 tmux 는 노드에 있으니 아래 릴레이 분기로(여기서 로컬 tmux 를 만지면 안 된다).
    if (st && !st.node_id) {
      if (st.owner !== me) throw new HttpError(403, "이 세션의 소유자만 보고할 수 있습니다");
      const change = await markSessionActive(id, phase).catch((e) => { logger.warn({ err: e, id }, "활동 시각 기록 실패(비치명)"); return null; });
      // #1842 — 단계가 **바뀐** 순간 그 자리에서 앱으로 민다. 폴링이 30초 뒤에 같은 사실을 다시 발견하는 대신,
      //  "AI 를 여러 개 돌리다 끝나는 것마다 바로 받는다"가 여기서 성립한다. 구독자가 없으면 아무 일도 안 한다.
      if (change) void notifyPhaseChange(id, me, change);   // 응답을 막지 않는다 — 훅은 핫패스다
      res.json({ ok: true });
      return;
    }
    if (st && st.node_id && st.owner !== me) throw new HttpError(403, "이 세션의 소유자만 보고할 수 있습니다");
    // 노드 세션(#869) — 중앙 DB 에 desired-state 가 없다(노드엔 DB 가 없어 레코드를 안 만든다). 그 세션의 tmux 는
    //  멤버 PC 에 있어 게이트웨이가 직접 못 쓰므로 **소유자 확인 후 노드로 릴레이**한다(정책=게이트웨이, 실행=노드 F7).
    //  이게 없으면 노드 세션은 훅을 배선해도 영영 404 라 화면 스크래핑에 묶인다 — 하네스 보고가 중앙에서만 되면
    //  같은 세션이 어디서 도느냐에 따라 상태 품질이 갈린다.
    const ns = nodeSessionsFor(me).find((x) => x.id === id);
    if (!ns) throw new HttpError(404, "세션 상태 기록이 없습니다");
    if (ns.owner !== me) throw new HttpError(403, "이 세션의 소유자만 보고할 수 있습니다");
    // 구 노드(caps 미선언)는 이 op 를 모른다 → 보내지 않는다. 그 노드 세션은 종전대로 자기 tmux 스크래핑으로 판정된다(무회귀).
    if (nodeSupports(ns.node.id, "markActive")) {
      const relay = await nodeRpc(ns.node.id, "markActive", { id, state: phase })
        .catch((e) => { logger.warn({ err: e, id }, "노드 활동 보고 릴레이 실패(비치명)"); return null; });
      // #1842 — 노드가 돌려준 전이를 그대로 민다. 구 노드는 change 를 안 보내므로 undefined → 폴링이 커버한다(무회귀).
      const change = (relay as { change?: { prev: string | null; phase: string; at: number } | null } | null)?.change;
      if (change) void notifyPhaseChange(id, me, change, ns.label);
    }
    res.json({ ok: true });
  }));

  // #2197 — **사람이 방금 시킨 말** 보고(work-flag 훅 UserPromptSubmit). 사이드바 세션 행 둘째 줄의 정본이다 — 종전엔 화면이
  //  대화 꼬리를 세션마다 받아 찾았고, 노드 세션은 기록이 턴 끝(Stop 캡처)에만 중앙에 올라와 '방금 친 말'이 턴이 끝나야 보였다.
  //  박스·노드 세션 모두 org_session_state 행(#1791)에 쓴다 — 노드로 릴레이하지 않는다(소비자가 중앙 목록뿐이라 중앙이 정본).
  //  owner-gated(남의 세션 오염 차단) · 본문은 서버가 다듬는다(cleanLastPrompt — 제어문자 제거·공백 접기·300자). best-effort — 훅은 fire-and-forget.
  app.post("/api/ui/terminal/sessions/:id/last-prompt", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const id = String(req.params.id ?? "");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new HttpError(400, "세션 id 형식 오류");
    const prompt = cleanLastPrompt(((req.body ?? {}) as Record<string, unknown>).prompt);
    if (!prompt) throw new HttpError(400, "prompt 가 비어 있습니다");
    const me = idOf(userOf(req));
    const st = await getSessionState(id);
    if (!st) throw new HttpError(404, "세션 상태 기록이 없습니다");
    if (st.owner !== me) throw new HttpError(403, "이 세션의 소유자만 보고할 수 있습니다");
    await setLastPrompt(id, prompt, me);
    res.json({ ok: true });
  }));

  // #1059 F(b) — 관리자 전용 **전 세션 메타뷰**. 뷰어 필터 없이 이 박스의 모든 중앙 세션(listSessionsRaw)을 반환한다
  //  (owner·dir·harness·lastActive·attached·agentState·projectId — 대화 내용은 없음). 운영자가 '무엇이 떠 있나'를 보고
  //  수동 회수(F(c): DELETE ?reclaim=1)의 대상을 고른다. 노드 세션은 멤버 자기 PC 라 중앙 박스 회수 범위 밖(제외 — reaper 와 동일).
  //  managed(상시)·attached·busy·waiting 는 회수해도 무의미/부적절 → 각 항목에 managed/attached/agentState 를 실어 프론트가 회수 버튼을 게이트한다.
  app.get("/api/ui/terminal/admin/sessions", auth, wrap(async (req, res) => {
    if (!userOf(req).scopes?.includes("admin")) throw new HttpError(403, "admin 권한이 필요합니다");
    res.setHeader("Cache-Control", "no-store");
    const [central, managed] = await Promise.all([
      listSessionsRaw(),
      listManagedSessions().catch(() => [] as Array<{ session_id: string | null }>),
    ]);
    const managedIds = new Set(managed.map((m) => m.session_id).filter((x): x is string => !!x));
    res.json({ sessions: central.map((s) => ({ ...s, managed: managedIds.has(s.id) })) });
  }));

  // #1059 정밀 복원 — work-flag 훅이 세션 활동 시 (box-id, **claude 자신의 세션 UUID**)를 보고한다. box-id ≠ claude UUID
  //  라(claude 는 자체 UUID 생성) restore 가 --resume 에 box-id 를 주면 "검색 결과 없음"이 됐다(사용자 신고). 이 매핑으로
  //  restore 가 정확한 UUID 로 이어받는다. 한 box 안에서 branch·resume·/clear 로 UUID 가 바뀌므로 매 보고가 최신으로 덮는다(last-write-wins).
  //  owner-gated: setClaudeSessionId 가 org_session_state.owner==호출자일 때만 갱신(남의 세션 오염 차단). best-effort — 훅은 fire-and-forget.
  //  #1746 — 훅이 함께 보내는 transcript_path(그 대화 파일의 절대경로)도 받는다. 대화창이 하네스 무관하게 파일을 찾는 근거
  //  (harness-io/locate.ts — 읽을 때 소유자 뿌리 안인지 검증). 형식만 여기서 거른다(절대경로·길이·NUL 없음) — 존재·소속 판정은 읽는 쪽.
  app.post("/api/ui/terminal/sessions/:id/claude-uuid", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const uuid = String(body.uuid ?? "").trim();
    // claude 세션 UUID 형식(표준 uuid 또는 안전 문자셋) — 경로/주입 방어.
    if (!uuid || uuid.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(uuid)) throw new HttpError(400, "uuid 형식 오류");
    const tp = typeof body.transcript_path === "string" ? body.transcript_path.trim() : "";
    const transcriptPath = tp && tp.length <= 1024 && !tp.includes("\0") && (tp.startsWith("/") || /^[A-Za-z]:[\\/]/.test(tp)) ? tp : null;
    // ⚠ 소유자 불일치를 **200 으로 답하지 않는다**(2026-08-18 실측) — 훅은 응답 본문이 아니라 HTTP 상태(`r.ok`)로
    //  성공을 판정해 dedup 플래그(`<box>.<uuid>.mapped`)를 쓴다. 그래서 종전의 `200 {ok:false}` 는 **거부를 성공으로
    //  기록**해 그 세션을 영구 무매핑으로 굳혔다(재시도 없음 → 대화창이 영영 "기록 없음"). /active 와 동형으로 403.
    //  레코드 없음은 여기서 안 막는다 — 그건 거부가 아니라 '박스 행이 없다'이고, 바로 아래 노드 경로가 받는다.
    // 보고한 대화 id 와 대화 파일 경로가 **서로 어긋나면 받지 않는다**(2026-08-18 실측 — 이 자리를 통해 살아 있는
    //  세션의 매핑이 `s7` 로 덮였다). 세션 안에서 도는 무엇이든 이 경로를 칠 수 있고 저장은 last-write-wins 라,
    //  한 번의 엉뚱한 보고가 정본을 지운다. 두 값이 같은 대화를 가리키는지는 하네스를 몰라도 볼 수 있다 —
    //  claude 는 `<uuid>.jsonl`, grok 은 `<convId>/updates.jsonl` 처럼 **id 가 경로 안에 들어 있다**.
    //  경로를 안 보낸 구 훅은 종전대로 통과(무회귀) — 그건 어긋남이 아니라 '모름'이다.
    if (transcriptPath && !transcriptPath.includes(uuid)) throw new HttpError(400, "대화 id 와 대화 파일 경로가 어긋납니다");
    const st0 = await getSessionState(req.params.id);
    //  경로를 안 보냈다면 대조할 짝이 없다 — 그 땐 **그 하네스의 대화 id 꼴**인지라도 본다(claude=UUID).
    //  둘을 합치면 "짝이 맞거나, 아니면 규약에 맞거나" 여야 통과다. 규약을 모르는 하네스(convIdOk=null)는 종전대로.
    if (!transcriptPath) {
      const io0 = st0?.harness ? harnessIo(st0.harness) : null;   // 하네스를 모르면(미러 없음) 판단 보류
      if (io0?.convIdOk && !io0.convIdOk(uuid)) throw new HttpError(400, `${io0.label} 의 대화 id 형식이 아닙니다`);
    }
    if (st0 && st0.owner !== idOf(userOf(req))) throw new HttpError(403, "이 세션의 소유자만 보고할 수 있습니다");
    const rowOk = await setClaudeSessionId(req.params.id, uuid, idOf(userOf(req)), transcriptPath);
    // #1752 갭2 — 노드 세션의 전용 매핑(org_node_session_map): 이 uuid 가 곧 중앙 세션 기록(session_log)의 키라, 매핑이 있어야
    //  채팅창이 노드 오프라인에도 기록을 읽는다. #1791 뒤 노드 세션도 org_session_state 행이 있어 위 UPDATE 가 성공하지만,
    //  기록 열쇠는 세션 수명과 무관하게 남아야 하므로(행은 삭제·복원으로 사라진다) **둘 다** 쓴다. 행이 없는 옛 노드 세션은
    //  종전대로 매핑만. 노드 미확인(스냅샷 지연·게이트웨이 재시작 직후)이면 매핑은 다음 보고로(훅이 매 턴 다시 보고한다).
    let mapOk = false;
    {
      const nodeId = nodeOfSession(req.params.id);
      if (nodeId) mapOk = await setNodeSessionMap(req.params.id, nodeId, uuid, idOf(userOf(req)), transcriptPath).catch(() => false);
    }
    // ⚠ #2151 — 못 적었으면 **200 으로 답하지 않는다.** 훅은 응답 본문이 아니라 HTTP 상태(`r.ok`)만 보고
    //  1회성 dedup 플래그(`<box>.<uuid>.mapped`)를 쓴다. 종전의 `200 {ok:false}` 는 그래서 **실패를 성공으로
    //  기록**해, 그 (box, uuid) 조합을 영원히 다시 보고하지 않게 만들었다 = 그 세션은 영구 무매핑 →
    //  복원이 늘 후보 picker(2026-08-27 실측: 이 계정의 복원 가능 claude 세션 124개 중 51개가 이 상태였다).
    //  '박스 행이 없다'는 거부가 아니라 **아직 없다**이다 — 노드 세션은 게이트웨이가 create 를 릴레이한 뒤
    //  mirrorNodeSession 으로 행을 적는데, 노드의 pane 은 그보다 먼저 떠서 SessionStart 훅이 1초 안에 보고한다.
    //  그 창에 걸리면 박스 행도 노드 스냅샷도 아직 없다. 그러니 재시도 가능한 상태로 답한다 —
    //  훅이 60초 쿨다운 뒤 다음 툴 사용에 다시 보고하고, 그때는 행이 있다(/active 와 같은 규약).
    //  판정 규칙은 sessions/conv-mapping.ts 가 쥔다(#2122 의 매핑 유실 규칙과 같은 자리 — 표로 못박혀 있다).
    if (mappingReportStatus(rowOk, mapOk) !== 200) throw new HttpError(404, "이 세션의 상태 기록이 아직 없습니다 — 잠시 뒤 다시 보고하세요");
    res.json({ ok: true });
  }));

  // #1059 — claude SessionEnd 훅이 **사용자 정상 종료**(/exit·Ctrl-D=prompt_input_exit, logout)를 보고한다. 이 표시가 찍힌
  //  세션은 tmux 에서 사라진 뒤 복원목록에서 '종료됨(대화 이어보기)'으로 뜬다(재부팅·강제kill·reaper 회수는 훅이 프로세스
  //  사망으로 못 떠 표시 없음 → '복원 가능·중단됨'). owner-gated(markSessionExited) — 남의 세션엔 못 찍는다. best-effort(fire-and-forget).
  app.post("/api/ui/terminal/sessions/:id/exited", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const reason = String(((req.body ?? {}) as Record<string, unknown>).reason ?? "").trim().slice(0, 64);
    const ok = await markSessionExited(req.params.id, idOf(userOf(req)), reason);
    res.json({ ok }); // ok=false: 그 box 의 소유자가 아니거나 desired-state 레코드 없음(무해)
  }));
}

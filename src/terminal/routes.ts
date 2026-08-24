// 중앙 박스 — 터미널 세션 매니저 정문. ([[central-box-design]] 경로 D: ttyd 대신 xterm.js+node-pty 깊은 통합)
// REST(/api/ui/terminal/*, Bearer) = 세션 목록·생성·이름변경·삭제 + 설정(루트·하네스 카탈로그).
// WS(/terminal/ws, ticket 쿠키) = PTY 스트림(terminal-pty.ts). 브라우저는 Authorization 헤더를 WS/네비에
// 못 실으므로, Bearer 로 인증된 멤버에게 HttpOnly 티켓 쿠키(userId 보유)를 발급해 WS 소유권 판정에 쓴다.
import type express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { sessionOrBearer } from "../auth/http-auth.js";
import type { BearerVerifier } from "../auth/bearer.js";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../http/rest-util.js";
import { assertAppSessionPlacement } from "./session-create-guards.js";
import { logger } from "../log.js";
import { roots, HARNESSES, listSessions, listRestorableSessions, listSessionsRaw, createSession, killSession, editSession, canAttach, markSessionActive, isReportedPhase, getSessionLabel, getSessionProject, sessionDir, sessionGone, profileStatus, profileStatusFor, provisionProfile, provisionMemberOs, memberOsStatus, aiAccountStatus, aiAccountLogout, validateInvites, type SessionInfo, type CreateInput, normalizeCap } from "./terminal-sessions.js";
import { resolveSessionDir } from "../sessions/session-desired.js";
import { getSessionState, deleteSessionState, setClaudeSessionId, markSessionExited } from "../sessions/session-state.js"; // #1059 E — restorable 세션 복원(+정밀 UUID 매핑·정상종료 표시)
import { currentTenant } from "../org/tenant-context.js";
import { PRIMARY_TENANT_ID, setSessionWorkspace, clearSessionWorkspace } from "../org/tenancy/registry.js"; // #1750 후속 — 세션→워크스페이스 정본
import { listManagedSessions } from "../sessions/managed-sessions.js"; // #1059 F — 관리탭 세션목록에서 managed 표시(회수 제외)
import { mergeSessionViews } from "../sessions/session-merge.js"; // #1716 — 출처가 겹쳐도 세션 카드는 1장
import { sessionPrompts, searchPrompts, searchPromptsHybrid, transcriptExists } from "./terminal-transcript.js";
import { activeEmbeddingProvider } from "../v6/search-util.js";
import { setupPtyUpgrade, type TicketLookup } from "./terminal-pty.js";
import { registerTerminalFiles } from "./terminal-files.js";
import { listMembers, getRuntimeConfig } from "../org/store.js";
import { isProjectSessionDir } from "../project/project-fs.js";
// 분산 노드(#869) — 원격 노드 세션의 목록 병합·CRUD 위임. 정책(소유·초대 검증)은 여기, 실행은 노드(F7).
import { nodeSessionsFor, nodeRpc, nodeSupports, nodeCanAttach, nodeOnline, liveNodes, nodeOfSession, nodeSessionHarness, nodeAgentStale } from "../node/registry.js";
import type { NodeOp } from "../node/protocol.js";
import { normalizeTheme } from "./catalog.js"; // #1683 테마 값 정규화(순수 — catalog 가 소유)
import { getNode, listNodes } from "../node/store.js";
import { nodeHarnesses } from "../node/protocol.js";   // #1713 — 노드별 하네스 가용성(미보고 → 기준선)
import { nodeOpenTo, nodeHostProfile } from "../node/node-access.js";
import { translateNodeRpcError } from "../node/rpc-error.js";
import { registerNodeRoutes } from "../node/routes.js";
import { registerSessionChatRoutes } from "./chat-routes.js";   // #1719 — 세션 대화창(트랜스크립트 창 읽기·Enter/Esc)
import { mirrorNodeSession, decorateNodeRows } from "./node-session-state.js";   // #1791 — 노드 세션 desired-state(정본 = DB, 게이트웨이가 쓴다)
import { claudeSessionIdsFor, setNodeSessionMap, nodeSessionMapFor } from "../sessions/session-state.js";   // #1719 라이브 행에 대화 uuid · #1752 노드 세션 매핑
import { chatIoCaps, harnessIo } from "./harness-io/adapter.js";                 // #1746 — 행에 대화창 능력(읽기·승인)
import { getOpt } from "./tmux-exec.js";                             // #1758 — 세션 하네스 폴백(@box_harness)
import { deadSessionMeta } from "./session-meta.js";                 // #1820 — 죽은 세션이 '복원 가능'을 말하는 단일 판정

/** #1683 후속2 — 그 세션이 어느 하네스로 떴나(tmux 세션 옵션 @box_harness). 모르면 빈 문자열. */
async function sessionHarnessKey(id: string): Promise<string> {
  try { const { getOpt } = await import("./tmux-exec.js"); return String((await getOpt(id, "@box_harness")) || ""); }
  catch { return ""; }
}

/** #1683 — 요청을 보낸 화면의 테마(해석된 dark|light). 헤더가 정본이고 바디는 폴백, 그 외엔 미지정(종전 동작). */
function themeOf(req: { headers: Record<string, unknown> }, b: Record<string, unknown>): "dark" | "light" | undefined {
  return normalizeTheme(req.headers["x-lively-theme"]) ?? normalizeTheme(b.theme);
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
  registerSessionChatRoutes(app, auth);   // #1719 — /sessions/:id/transcript · /sessions/:id/keys (CRUD 뒤 — 경로가 겹치지 않는다)
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
        hasAutoApprove: !!h.autoApproveFlag, autoApproveFlag: h.autoApproveFlag ?? "", flags: h.flags,
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
        const live = new Map(liveNodes().map((n) => [n.id, n.online]));
        return (await listNodes().catch(() => []))
          .filter((n) => n.enabled && nodeOpenTo(n, me))
          // harnesses(#1713) — **그 PC 에서 실제로 띄울 수 있는 것**만 폼에 보여주기 위해 함께 준다.
          //  노드가 hello 로 보고한 값이고, 구 번들이라 미보고면 기준선(claude·codex·shell)이 온다.
          //  이게 없으면 사용자는 [생성하기]를 누른 뒤에야 안다 — 옛 번들은 502, 바이너리 부재는 세션 즉사.
          .map((n) => ({ id: n.id, name: n.name, kind: n.kind, shared: n.shared, online: live.get(n.id) ?? false, harnesses: nodeHarnesses(n.agent_harnesses) }));
      })(),
    });
  }));

  // ── 내 AI 계정(#1085) — 관리탭 [내 설정 ▸ 내 AI 설정] 상단 카드가 읽고 쓴다. **본인 것만**: 경로에 멤버 id 가
  //  없고 principal(userOf) 로만 대상이 정해진다 → 남의 계정을 조회·로그아웃할 표면이 아예 없다(admin 도 마찬가지).
  app.get("/api/ui/me/ai-accounts", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ accounts: await aiAccountStatus(userOf(req)) });
  }));
  // 로그아웃 = 내 자격증명 파일 삭제(재로그인으로 복구 가능). 공유 계정(비격리 codex 등)은 서비스가 409 로 막는다.
  app.post("/api/ui/me/ai-accounts/logout", auth, wrap(async (req, res) => {
    const harness = String(((req.body ?? {}) as Record<string, unknown>).harness ?? "").trim();
    if (!harness) throw new HttpError(400, "harness(AI 키)가 필요합니다");
    await aiAccountLogout(userOf(req), harness);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, accounts: await aiAccountStatus(userOf(req)) });
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
    // #549 후속: admin 이 명시 opt-in(includeControlPlane) 하면 관리 권한(admin/runtime)도 프로필 토큰에 싣는다(멤버 scope 가 상한).
    const includeControlPlane = !!((req.body ?? {}) as Record<string, unknown>).includeControlPlane;
    const { slug, dir } = await provisionProfile(member, { includeControlPlane });
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
    const includeControlPlane = !!((req.body ?? {}) as Record<string, unknown>).includeControlPlane;
    const { slug, osUser } = await provisionMemberOs(member, { includeControlPlane });
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
const recordSessionTenant = async (sessionId: string, killOnFail?: () => Promise<unknown>): Promise<void> => {
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
    // #1752 갭2 — 노드 세션 행에도 대화 uuid 를 싣는다(org_node_session_map — /claude-uuid 노드 분기가 채움).
    //  이 값이 실려야 새 셸 채팅창이 노드 세션을 중앙 기록(v6/sessions/:uuid/log)으로 읽고, 같은 기록 행과 한 장으로 접힌다.
    //  매핑의 node_id 와 지금 행의 노드가 다르면 버린다(노드 재등록·이름 재사용으로 남은 낡은 매핑 오염 방지).
    try {
      const nmap = await nodeSessionMapFor(remote.filter((s) => !s.claudeSessionId).map((s) => s.id));   // #1791 — 행이 없는 옛 노드 세션의 폴백
      for (const s of remote) { const m = nmap.get(s.id); if (m && m.node_id === s.node.id) s.claudeSessionId = m.conv_uuid; }
    } catch { /* 조회 실패 — uuid 없이 나간다 */ }
    // #1746 — 하네스별 대화창 능력(읽기·승인)을 행에 싣는다. 화면이 없는 능력의 버튼을 두지 않게(정직한 표면).
    for (const s of [...local, ...localRestorable, ...remote]) s.chat = chatIoCaps(s.harness);
    // 같은 세션이 두 출처에 잡히면 카드 1장으로 접는다(#1716) — 인자 순서가 곧 우선순위(라이브 관측 > 기억).
    //  게이트웨이와 노드 에이전트가 같은 박스에서 돌면 **같은 tmux 서버**를 보므로 local 과 remote 에 같은 id 가
    //  동시에 잡힌다(실측: AI 세션 탭 카드가 전부 2장씩). liveIds 로 restorable 만 걸러선 이 짝을 못 막는다.
    res.json({ sessions: mergeSessionViews(local, remote, localRestorable) });
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
    if (nodeId) {
      const s = nodeSessionsFor(uid).find((x) => x.node.id === nodeId && x.id === id);
      if (s) { res.json({ id: s.id, label: s.label, projectId: s.projectId || 0 }); return; }
      // #1791 — 스냅샷에 없다 = 그 노드에서 죽었다(또는 노드가 스냅샷을 아직 안 올렸다). 아래 desired-state 경로로 떨어져
      //  '복원 가능'을 알린다(종전엔 여기서 403 — 노드 세션은 desired-state 가 없어 알릴 것이 없었다).
    }
    // 복원 판정에 쓸 desired-state 는 한 번만 읽어 아래 세 갈래(노드·박스 사망·권한없음)가 나눠 쓴다.
    const st = await getSessionState(id);
    // #1791 — 노드 세션의 desired-state(node_id) — 라이브 스냅샷에 없으면 죽은 것이다. 게이트웨이 tmux 를 묻지 않는다
    //  (그 id 는 여기 tmux 에 없고, canAttach 가 DB owner 로 통과해 빈 라벨을 돌려주는 오답을 막는다).
    if (st?.node_id) {
      const dead = deadSessionMeta(id, st, uid, isAdmin);
      if (dead.kind !== "ok") throw new HttpError(403, "세션에 접근할 수 없습니다");
      const ln = liveNodes().find((n) => n.id === st.node_id);
      res.json({ ...dead.body, node: { id: st.node_id, name: ln?.name || st.node_id, online: !!ln?.online } });
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
      const dead = deadSessionMeta(id, st, uid, isAdmin);
      if (dead.kind === "ok") { res.json(dead.body); return; }
      if (dead.kind === "forbidden") throw new HttpError(403, "세션에 접근할 수 없습니다");
      // kind === "none" — 되살릴 근거(desired-state)가 없는 진짜 끝난 세션. 종전 흐름이 답한다.
    }
    if (!(await canAttach(id, uid))) {
      // #1059 E — tmux 에 없어도(재부팅·회수·정상종료) desired-state 가 남아 있으면 '복원 가능'으로 알린다.
      //  위 게이트가 tmux 확답을 못 받았을 때의 폴백이다(공유 게이트웨이가 그 세션의 tmux 서버 문맥 밖에 있는 경우 등).
      //  노출 범위는 복원 권한과 같게: 소유자·admin 만 desired-state 를 보고 되살릴 수 있고(canRestore),
      //  프로젝트 세션은 #452 로 전원 공개라 라벨까지는 보이되 복원은 소유자 몫으로 둔다.
      const dead = deadSessionMeta(id, st, uid, isAdmin);
      if (dead.kind === "ok") { res.json(dead.body); return; }
      throw new HttpError(403, "세션에 접근할 수 없습니다");
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
    if (!(await canAttach(req.params.id, uid))) throw new HttpError(403, "세션에 접근할 수 없습니다");
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
      // 노드(멤버 PC) 세션은 이 게이트웨이의 tmux 에 없다 — 아직 이 통로가 없어 정직하게 미지원으로 돌려준다.
      if (nodeOfSession(id)) { results.push({ id, status: "unsupported", detail: "노드 세션은 아직 지원하지 않습니다" }); continue; }
      if (!(await canAttach(id, uid))) { results.push({ id, status: "error", detail: "접근할 수 없는 세션입니다" }); continue; }
      const harness = await sessionHarnessKey(id);
      const r = await applyLiveTheme(id, harness, theme);
      results.push({ id, harness, ...r });
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ results, applied: results.filter((r) => r.status === "applied").length });
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
      throw new HttpError(403, "세션에 접근할 수 없습니다");
    }
    if (!nodeId) {
      // 이 박스 세션 — 아웃박스(#1753)로. 곧바로 send-keys 하지 않는다: 로그인·대화상자에 멈춘 세션이면 글자가 조용히
      //  사라진다(실측). 배달자가 입력창을 확인하고 넣고, 트랜스크립트 에코로 delivered 를 확정한다. 화면은 seq 로 상태를 따라간다.
      const { enqueuePrompt } = await import("../sessions/session-outbox.js");
      const q = await enqueuePrompt(req.params.id, text);
      res.json({ ok: true, queued: true, outbox_id: q.id, seq: q.seq });
      return;
    }
    // 노드(멤버 PC) 세션 — 파일·tmux 가 그 컴퓨터에 있어 아웃박스 배달자가 닿지 않는다. 종전 릴레이 그대로(후속 #1753 P2).
    const { injectPrompt } = await import("../node/session-inject.js");
    try { await injectPrompt(req.params.id, text); }
    catch (e) {
      // 노드가 꺼졌거나 구버전이면 nodeRpc 가 고정 문자열로 던진다 — 사람 말로 옮긴다(그냥 500 이면 원인을 모른다).
      const msg = (e as Error)?.message ?? String(e);
      if (msg === "node-offline") throw new HttpError(503, "그 컴퓨터가 지금 연결돼 있지 않습니다.");
      if (msg.startsWith("node-unsupported-op:")) throw new HttpError(409, "그 컴퓨터의 라이블리가 오래돼 프롬프트를 받지 못합니다. 업데이트가 필요합니다.");
      if (msg === "node-rpc-timeout") throw new HttpError(504, "그 컴퓨터가 응답하지 않습니다.");
      throw e;
    }
    res.json({ ok: true });
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
      throw new HttpError(403, "세션에 접근할 수 없습니다");
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
    const sessions = all
      .filter((s) => !isProjectSessionDir(s.dir) || s.owned)   // 개인(소유/초대) + 내가 만든 프로젝트 세션만(남의 비공개 미검색)
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
    if (!nodeOpenTo(n, idOf(userOf(req)))) {
      throw new HttpError(403, "본인이 등록한 노드가 아니고 공유 노드도 아닙니다 — 관리자가 공유 노드로 지정한 노드만 함께 쓸 수 있습니다");
    }
    if (!nodeOnline(nodeId)) throw new HttpError(409, "노드가 오프라인입니다(에이전트 연결 대기)");
  };

  app.post("/api/ui/terminal/sessions", auth, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const input: CreateInput = {
      label: String(b.label ?? ""), rootKey: String(b.rootKey ?? ""), subpath: String(b.subpath ?? ""),
      harness: String(b.harness ?? ""), flags: (b.flags && typeof b.flags === "object") ? b.flags as Record<string, unknown> : {},
      autoApprove: !!b.autoApprove, invites: b.invites, loginProfile: !!b.loginProfile,
      readOnly: !!b.readOnly, // #1007 — 이 세션만 읽기전용(컨텍스트 스토어 쓰기 소거). 노드 세션도 아래 relay 가 input 스프레드로 전파.
      incognito: !!b.incognito, // #1007+ — 이 세션만 인코그니토(lively 전체 차단 + 훅 off). readOnly 보다 우선.
      // #1291 v2 — 새 세션 폼의 '기록 범위'. 안 읽으면 폼이 조용히 무시되고 사용자는 고른 대로 됐다고 믿는다.
      //  normalizeCap 이 모르는 값을 null 로 접어 미지정(폴더 파생)으로 되돌린다.
      writeVis: normalizeCap(b.writeVis as string) ?? undefined,
      // #1516 — 로그인 전용 세션(관리탭 [연결된 AI 계정] ▸ 로그인). 값 검증은 harnessLoginArgv 가 한다
      //  (아는 하네스만 로그인 argv 를 내주고, 모르는 값은 평범한 셸 세션으로 접힌다 — 임의 문자열이 명령이 되지 않는다).
      loginFor: String(b.loginFor ?? "") || undefined,
      // #1719 홈 입력창 — 세션 전용 폴더(폴더를 안 고른다) + 첫 지시(하네스 입력창이 뜬 뒤 주입). 노드 세션도 input 스프레드로 그대로 전파.
      // #1683 — 세션을 만든 브라우저 화면의 테마. 헤더가 정본이다(api() 가 모든 요청에 싣는다 — 호출부마다
      //  payload 를 고치지 않아도 전 경로가 덮인다). 바디는 헤더를 못 싣는 경로(노드 relay 재생성 등)용 폴백.
      theme: themeOf(req, b),
      sessionDir: b.sessionDir === true,
      initialPrompt: typeof b.initialPrompt === "string" && b.initialPrompt.trim() ? b.initialPrompt.slice(0, 20_000) : undefined,
      // #1780 D4 — 앱 세션. appId 를 주면 createSession 이 grant 검사·앱 토큰 발급·세션폴더 앱 홈/자산 물질화를 한다
      //  (없으면 일반 세션, 종전 경로 무변경). 존재·활성·grant 검증은 createSession(mintAppToken)이 하고 404/409/403 을 던진다.
      appId: String(b.appId ?? "").trim() || undefined,
    };
    const nodeId = String(b.node ?? "").trim();
    res.setHeader("Cache-Control", "no-store");
    if (nodeId) {
      assertAppSessionPlacement(input, nodeId); // #1780 v2 §7-1 — 앱 세션은 노드에 못 싣는다(relay 전에 400)
      await requireCreatableNode(req, nodeId);
      const me = idOf(userOf(req));
      const invites = await validateInvites(b.invites, me);
      // #1541 hostProfile — member 노드 && 생성자=주인이면 그 PC 의 네이티브 하네스 설정 그대로(CreateInput 주석). 조회 실패 = false(주입 유지).
      const hostProfile = await getNode(nodeId).then((n) => !!n && nodeHostProfile(n, me)).catch(() => false);
      const session = await relayNodeOp<SessionInfo>(nodeId, "create", { user: { userId: me }, input: { ...input, invites: [], hostProfile }, invites });
      await recordSessionTenant(session.id, () => relayNodeOp(nodeId, "kill", { user: { userId: me }, id: session.id }));
      // #1791 — desired-state 정본은 게이트웨이가 쓴다(노드엔 DB 가 없다). 죽어도 '복원 가능(그 노드)'로 남는 근거.
      await mirrorNodeSession({ ...session, invites }, nodeId, input, me);
      res.json({ session: { ...session, node: { id: nodeId, online: true } } });
      return;
    }
    const session = await createSession(userOf(req), input);
    await recordSessionTenant(session.id, () => killSession(userOf(req), session.id, {}));
    res.json({ session });
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
    if (!st) throw new HttpError(404, "복원할 세션 상태가 없습니다");
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
      if (!nodeOnline(nodeId)) throw new HttpError(409, "그 세션이 있던 컴퓨터(노드)가 지금 연결돼 있지 않아 복원할 수 없습니다. 노드가 켜지면 다시 시도하세요.");
      // 라이브 경합은 **노드에 묻는다**(gone op) — 스냅샷은 재시작 직후·생성 직후 비어 있고 뷰어별 필터라(admin) 살아 있는 세션을
      //  놓칠 수 있다. 확답을 못 받으면 복원하지 않는다(모르면 같은 세션을 둘로 만들지 않는다 — #835 '확답 only').
      const gone = await nodeRpc<boolean>(nodeId, "gone", { id }).catch(() => null);
      if (gone === false) { res.json({ ok: true, already: true, id, node: { id: nodeId } }); return; }
      if (gone === null) throw new HttpError(409, "그 컴퓨터(노드)가 응답하지 않아 세션 상태를 확인하지 못했습니다 — 잠시 후 다시 시도하세요.");
      const resumeId = st.claude_session_id || null;
      const input: CreateInput = {
        label: st.label || id, rootKey: st.root_key || "shared", subpath: st.subpath || "",
        harness: st.harness || "claude", flags: st.flags || {}, autoApprove: st.auto_approve,
        projectId: st.project_id || undefined, projectSrc: st.project_src === "org" ? "org" : "v6",
        readOnly: st.read_only, incognito: st.incognito,
        writeVis: st.write_vis ?? undefined, restrictRead: !!st.restrict_read,
        ...(resumeId ? { resume: resumeId } : { resumePick: true }),
      };
      const owner = st.owner;
      // #1541 hostProfile — 원 소유자 기준(생성 때와 같은 판정). 조회 실패 = false(주입 유지).
      const hostProfile = await getNode(nodeId).then((n) => !!n && nodeHostProfile(n, owner)).catch(() => false);
      const invites = Array.isArray(st.invites) ? st.invites : [];
      const session = await relayNodeOp<SessionInfo>(nodeId, "create", { user: { userId: owner }, input: { ...input, invites: [], hostProfile }, invites });
      await recordSessionTenant(session.id, () => relayNodeOp(nodeId, "kill", { user: { userId: owner }, id: session.id }));
      await mirrorNodeSession({ ...session, invites }, nodeId, input, owner);
      if (st.claude_session_id) {
        await setClaudeSessionId(session.id, st.claude_session_id, owner, st.transcript_path)
          .catch((e) => logger.warn({ err: e, id: session.id }, "restore(node): 대화 id 승계 실패(비치명 — 다음 복원은 picker)"));
      }
      await deleteSessionState(id).catch((e) => logger.warn({ err: e, id }, "restore(node): 옛 desired-state 정리 실패(비치명)"));
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
    //  ⚠ 대화 존재 확인(transcriptExists)은 claude 의 `~/.claude/projects` 규약 전용이라 claude 에서만 한다.
    //   다른 하네스는 저장 위치 규약을 실측하기 전까지 검사 없이 시도한다 — 없는 id 로 시작해도 #1516 런처가
    //   세션을 살려 두고 하네스의 원문 에러를 화면에 남기므로, 종전의 '복원 루프'(즉사→재복원)는 구조적으로 끊겨 있다.
    const mappedId = st.claude_session_id || null;
    const resumeUuid = mappedId
      && (st.harness !== "claude" || await transcriptExists(st.dir || "", mappedId, st.owner).catch(() => false))
      ? mappedId : null;
    const precise = !!resumeUuid;
    const session = await createSession(owner, {
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
    //  훅이 새 UUID 를 보고하면 last-write-wins 로 갱신되므로 이 승계는 '보고 전 공백'만 메운다. best-effort.
    if (st.claude_session_id) {
      await setClaudeSessionId(session.id, st.claude_session_id, st.owner, st.transcript_path)   // #1746 대화 파일 경로도 승계(같은 대화 = 같은 파일)
        .catch((e) => logger.warn({ err: e, id: session.id }, "restore: claude UUID 승계 실패(비치명 — 다음 복원은 picker)"));
    }
    await deleteSessionState(id).catch((e) => logger.warn({ err: e, id }, "restore: 옛 desired-state 정리 실패(비치명)"));
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
      await markSessionActive(id, phase).catch((e) => logger.warn({ err: e, id }, "활동 시각 기록 실패(비치명)"));
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
      await nodeRpc(ns.node.id, "markActive", { id, state: phase })
        .catch((e) => logger.warn({ err: e, id }, "노드 활동 보고 릴레이 실패(비치명)"));
    }
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
    let ok = await setClaudeSessionId(req.params.id, uuid, idOf(userOf(req)), transcriptPath);
    // #1752 갭2 — 노드 세션의 전용 매핑(org_node_session_map): 이 uuid 가 곧 중앙 세션 기록(session_log)의 키라, 매핑이 있어야
    //  채팅창이 노드 오프라인에도 기록을 읽는다. #1791 뒤 노드 세션도 org_session_state 행이 있어 위 UPDATE 가 성공하지만,
    //  기록 열쇠는 세션 수명과 무관하게 남아야 하므로(행은 삭제·복원으로 사라진다) **둘 다** 쓴다. 행이 없는 옛 노드 세션은
    //  종전대로 매핑만. 노드 미확인(스냅샷 지연·게이트웨이 재시작 직후)이면 매핑은 다음 보고로(훅이 매 턴 다시 보고한다).
    {
      const nodeId = nodeOfSession(req.params.id);
      if (nodeId) {
        const mapped = await setNodeSessionMap(req.params.id, nodeId, uuid, idOf(userOf(req)), transcriptPath).catch(() => false);
        ok = ok || mapped;
      }
    }
    res.json({ ok }); // ok=false: 그 box 의 소유자가 아니거나, 박스 레코드도 노드 스냅샷도 없음(무해 — 다음 보고가 잇는다)
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

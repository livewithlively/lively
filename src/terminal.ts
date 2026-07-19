// 중앙 박스 — 터미널 세션 매니저 정문. ([[central-box-design]] 경로 D: ttyd 대신 xterm.js+node-pty 깊은 통합)
// REST(/api/ui/terminal/*, Bearer) = 세션 목록·생성·이름변경·삭제 + 설정(루트·하네스 카탈로그).
// WS(/terminal/ws, ticket 쿠키) = PTY 스트림(terminal-pty.ts). 브라우저는 Authorization 헤더를 WS/네비에
// 못 실으므로, Bearer 로 인증된 멤버에게 HttpOnly 티켓 쿠키(userId 보유)를 발급해 WS 소유권 판정에 쓴다.
import type express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { sessionOrBearer } from "./auth/http-auth.js";
import type { BearerVerifier } from "./auth/bearer.js";
import type { LivelyUser } from "./context.js";
import { wrap, HttpError } from "./capabilities/rest-util.js";
import { logger } from "./log.js";
import { ROOTS, HARNESSES, listSessions, createSession, killSession, editSession, canAttach, getSessionLabel, sessionDir, profileStatus, profileStatusFor, provisionProfile, provisionMemberOs, memberOsStatus, validateInvites, type SessionInfo, type CreateInput } from "./terminal-sessions.js";
import { sessionPrompts, searchPrompts, searchPromptsHybrid } from "./terminal-transcript.js";
import { activeEmbeddingProvider } from "./v6/search-util.js";
import { setupPtyUpgrade, type TicketLookup } from "./terminal-pty.js";
import { registerTerminalFiles } from "./terminal-files.js";
import { listMembers } from "./org/store.js";
import { isProjectSessionDir } from "./project-fs.js";
// 분산 노드(#869) — 원격 노드 세션의 목록 병합·CRUD 위임. 정책(소유·초대 검증)은 여기, 실행은 노드(F7).
import { nodeSessionsFor, nodeRpc, nodeCanAttach, nodeOnline, liveNodes } from "./node/registry.js";
import type { NodeOp } from "./node/protocol.js";
import { getNode, listNodes } from "./node/store.js";
import { registerNodeRoutes } from "./node/routes.js";

// 노드 op 실패를 사용자에게 그대로 보여준다 — 노드측 예외(예: tmux 미설치 → spawn ENOENT)가 generic 500("internal_error")
//  으로 묻히면 원인 진단이 불가능하다(#869 haru 사례: 세션 생성 500 의 진짜 원인이 로그에만 있고 응답엔 안 나왔다).
//  오프라인·타임아웃은 전용 상태코드로, 그 외 노드측 오류는 502 로 메시지를 붙여 표면화한다.
async function relayNodeOp<T>(nodeId: string, op: NodeOp, args: Record<string, unknown>): Promise<T> {
  try {
    return await nodeRpc<T>(nodeId, op, args);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg === "node-offline") throw new HttpError(409, "노드가 오프라인입니다 — 그 PC 의 lively 노드 연결을 확인하세요.");
    if (msg === "node-rpc-timeout") throw new HttpError(504, "노드 응답 시간 초과");
    // 미지원(#905 C4) — **실행 실패가 아니다.** 502 "노드에서 실행 실패"로 뭉개면 사용자는 뭔가 터진 줄 알고
    //  재시도하는데, 실제로는 그 노드 에이전트가 낡아 그 기능 자체가 없는 것이다. 할 일이 완전히 다르다.
    if (msg.startsWith("node-unsupported-op:")) {
      throw new HttpError(409, `이 노드의 에이전트가 낡아 '${msg.slice("node-unsupported-op:".length)}' 를 지원하지 않습니다 — 그 PC 에서 노드를 다시 설치·업데이트하세요.`);
    }
    throw new HttpError(502, `노드에서 실행 실패: ${msg}`);
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
      roots: ROOTS.map((r) => ({ key: r.key, label: r.label })),
      harnesses: HARNESSES.map((h) => ({ key: h.key, label: h.label, hasAutoApprove: !!h.autoApproveFlag, flags: h.flags })),
      members,
      // 멀티프로필(#346): 이 세션이 '내 계정'(프로필 로그인됨)으로 뜰지, '공유 계정'으로 폴백할지 UI 표시.(레거시 폴백)
      profile: await profileStatus(userOf(req)),
      // 구성원 격리(#524): 이 세션이 '내 격리 OS 계정(box_)'으로 뜨는지 안내 — box_ 격리가 #346 프로필을 대체.
      //  {ready:인프라설치, provisioned:box_존재, osUser}. 미프로비저닝이어도 첫 세션에 자동 생성(lazy)됨.
      os: await memberOsStatus(userOf(req).userId),
      // 분산 노드(#869): 생성폼 실행 위치 피커 — 내 노드(admin 은 전체)만. online 이어야 생성 가능(폼이 비활성 표시).
      nodes: await (async () => {
        const me = idOf(userOf(req));
        const admin = !!userOf(req).scopes?.includes("admin");
        const live = new Map(liveNodes().map((n) => [n.id, n.online]));
        return (await listNodes().catch(() => []))
          .filter((n) => n.enabled && (admin || n.owner_member === me))
          .map((n) => ({ id: n.id, name: n.name, kind: n.kind, online: live.get(n.id) ?? false }));
      })(),
    });
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

  app.get("/api/ui/terminal/sessions", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // 프로젝트 폴더 세션은 '프로젝트 공동 세션' — 터미널 탭에선 숨기고 프로젝트 페이지에서만 관리(팀원 전용).
    const all = await listSessions(userOf(req));
    // 분산 노드(#869) — 원격 노드 세션 병합(node 필드로 구분). 가시성은 개인 세션 규칙(소유자+초대)로 게이트웨이가 판정.
    const remote = nodeSessionsFor(idOf(userOf(req)));
    res.json({ sessions: [...all.filter((s) => !isProjectSessionDir(s.dir)), ...remote] });
  }));
  // 단일 세션의 현재 이름 — 단독 터미널 페이지가 id 로 조회(프로젝트 세션은 목록에서 빠져 ?label= 폴백만 됐던 문제 해결).
  //  접근통제: canAttach(소유자·초대된 멤버, 프로젝트 세션은 전원 #452) — 입장 가능한 사람만 이름을 읽는다.
  app.get("/api/ui/terminal/sessions/:id", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    res.setHeader("Cache-Control", "no-store");
    // 노드 세션(#869) — 마지막 상태 스냅샷에서 가시성 판정 후 라벨 반환(노드 오프라인이어도 표시 가능).
    const nodeId = String(req.query.node ?? "").trim();
    if (nodeId) {
      const s = nodeSessionsFor(uid).find((x) => x.node.id === nodeId && x.id === req.params.id);
      if (!s) throw new HttpError(403, "세션에 접근할 수 없습니다");
      res.json({ id: s.id, label: s.label });
      return;
    }
    if (!(await canAttach(req.params.id, uid))) throw new HttpError(403, "세션에 접근할 수 없습니다");
    res.json({ id: req.params.id, label: await getSessionLabel(req.params.id) });
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
    const out = await sessionPrompts(await sessionDir(req.params.id));
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
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
  // 노드 세션 생성 게이트(#869) — 노드 실재·활성·연결 + 소유자(또는 admin)만. 초대는 여기서 구성원 디렉터리로
  //  검증해 노드엔 '검증된 목록'만 넘긴다(노드는 DB 가 없어 스스로 검증 불가 — F7 정책/실행 분리).
  const requireCreatableNode = async (req: express.Request, nodeId: string): Promise<void> => {
    const n = await getNode(nodeId);
    if (!n || !n.enabled) throw new HttpError(404, `노드 없음: ${nodeId}`);
    const u = userOf(req);
    if (n.owner_member !== idOf(u) && !u.scopes?.includes("admin")) throw new HttpError(403, "본인 노드가 아닙니다");
    if (!nodeOnline(nodeId)) throw new HttpError(409, "노드가 오프라인입니다(에이전트 연결 대기)");
  };

  app.post("/api/ui/terminal/sessions", auth, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const input: CreateInput = {
      label: String(b.label ?? ""), rootKey: String(b.rootKey ?? ""), subpath: String(b.subpath ?? ""),
      harness: String(b.harness ?? ""), flags: (b.flags && typeof b.flags === "object") ? b.flags as Record<string, unknown> : {},
      autoApprove: !!b.autoApprove, invites: b.invites, loginProfile: !!b.loginProfile,
    };
    const nodeId = String(b.node ?? "").trim();
    res.setHeader("Cache-Control", "no-store");
    if (nodeId) {
      await requireCreatableNode(req, nodeId);
      const me = idOf(userOf(req));
      const invites = await validateInvites(b.invites, me);
      const session = await relayNodeOp<SessionInfo>(nodeId, "create", { user: { userId: me }, input: { ...input, invites: [] }, invites });
      res.json({ session: { ...session, node: { id: nodeId, online: true } } });
      return;
    }
    const session = await createSession(userOf(req), input);
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
    if (nodeId) {
      await relayNodeOp(nodeId, "kill", { user: { userId: idOf(userOf(req)) }, id: req.params.id });
      res.json({ ok: true });
      return;
    }
    await killSession(userOf(req), req.params.id);
    res.json({ ok: true });
  }));

  registerTerminalFiles(app, verifier);
  registerNodeRoutes(app, verifier); // 분산 노드(#869) — /api/ui/nodes* (등록·회전·활성·삭제·현황)
  setupPtyUpgrade(server, lookupTicket);
  logger.info("terminal session manager mounted (/api/ui/terminal/*, ws /terminal/ws, files, nodes)");
}

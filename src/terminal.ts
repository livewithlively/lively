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
import { ROOTS, HARNESSES, listSessions, createSession, killSession, editSession, canAttach, getSessionLabel, profileStatus, profileStatusFor, provisionProfile, provisionMemberOs, memberOsStatus } from "./terminal-sessions.js";
import { setupPtyUpgrade, type TicketLookup } from "./terminal-pty.js";
import { registerTerminalFiles } from "./terminal-files.js";
import { listMembers } from "./org/store.js";
import { isProjectSessionDir } from "./project-fs.js";

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
      // 멀티프로필(#346): 이 세션이 '내 계정'(프로필 로그인됨)으로 뜰지, '공유 계정'으로 폴백할지 UI 표시.
      profile: await profileStatus(userOf(req)),
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
    for (const m of members) profiles.push({ id: m.id, name: m.display_name || m.id, status: await profileStatusFor(m.id), os: await memberOsStatus(m.id) });
    res.setHeader("Cache-Control", "no-store");
    res.json({ profiles });
  }));
  // 프로필 프로비저닝 — dir + 키트(settings·MCP). 실재 구성원만. 로그인은 별도(응답의 loginHint 로 안내).
  app.post("/api/ui/terminal/profiles/provision", auth, wrap(async (req, res) => {
    requireAdmin(req);
    const member = String((req.body ?? {} as Record<string, unknown>).member ?? "").trim();
    if (!member) throw new HttpError(400, "member(구성원 id)가 필요합니다");
    if (!(await listMembers().catch(() => [])).some((m) => m.id === member)) throw new HttpError(400, "존재하지 않는 구성원입니다");
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
    const { slug, osUser } = await provisionMemberOs(member);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, member, slug, osUser, os: await memberOsStatus(member),
      loginHint: `이제 이 멤버가 자기 새 세션에서 'claude' → /login 하면 자격증명이 /home/${osUser}/.claude(700)에 격리 저장됩니다.` });
  }));

  app.get("/api/ui/terminal/sessions", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // 프로젝트 폴더 세션은 '프로젝트 공동 세션' — 터미널 탭에선 숨기고 프로젝트 페이지에서만 관리(팀원 전용).
    const all = await listSessions(userOf(req));
    res.json({ sessions: all.filter((s) => !isProjectSessionDir(s.dir)) });
  }));
  // 단일 세션의 현재 이름 — 단독 터미널 페이지가 id 로 조회(프로젝트 세션은 목록에서 빠져 ?label= 폴백만 됐던 문제 해결).
  //  접근통제: canAttach(소유자·초대된 멤버, 프로젝트 세션은 전원 #452) — 입장 가능한 사람만 이름을 읽는다.
  app.get("/api/ui/terminal/sessions/:id", auth, wrap(async (req, res) => {
    const uid = idOf(userOf(req));
    if (!(await canAttach(req.params.id, uid))) throw new HttpError(403, "세션에 접근할 수 없습니다");
    res.setHeader("Cache-Control", "no-store");
    res.json({ id: req.params.id, label: await getSessionLabel(req.params.id) });
  }));
  app.post("/api/ui/terminal/sessions", auth, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const session = await createSession(userOf(req), {
      label: String(b.label ?? ""), rootKey: String(b.rootKey ?? ""), subpath: String(b.subpath ?? ""),
      harness: String(b.harness ?? ""), flags: (b.flags && typeof b.flags === "object") ? b.flags as Record<string, unknown> : {},
      autoApprove: !!b.autoApprove, invites: b.invites, loginProfile: !!b.loginProfile,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ session });
  }));
  // 세션 수정 — 이름·초대 멤버 변경. 소유자만(서버가 강제).
  app.post("/api/ui/terminal/sessions/:id", auth, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    await editSession(userOf(req), req.params.id, {
      label: b.label !== undefined ? String(b.label) : undefined,
      invites: b.invites,
    });
    res.json({ ok: true });
  }));
  app.delete("/api/ui/terminal/sessions/:id", auth, wrap(async (req, res) => {
    await killSession(userOf(req), req.params.id);
    res.json({ ok: true });
  }));

  registerTerminalFiles(app, verifier);
  setupPtyUpgrade(server, lookupTicket);
  logger.info("terminal session manager mounted (/api/ui/terminal/*, ws /terminal/ws, files)");
}

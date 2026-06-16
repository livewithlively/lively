// delivery(전달/관리) capabilities — workflow-std 흡수의 게이트웨이 표면.
// 비개발자 관리자가 org-content(강제규칙·회사맥락·메모리·구성원·게이트웨이주소)를 웹에서 편집/발행하고
// 구성원 토큰을 발급한다. 전부 admin scope + REST 전용(expose.mcp=false — 에이전트가 정책을 못 바꾸게).
// 모든 응답에 '구성원에게 미치는 효과'(meaning) 가이드를 함께 실어 UI 가 의미를 인지시킨다.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import type { LivelyUser } from "../context.js";
import { MEANING, PUBLISH_MEANING } from "../org/meaning.js";
import { previewMemberContext, runPublish } from "../org/publish.js";
import {
  getOrgProfile, updateOrgProfile, listSections, updateSection,
  listMembers, getMember, upsertMember, removeMember, listMemory, upsertMemory, removeMemory,
  mintToken, listTokens, revokeToken, memberHasActiveToken,
  getRuntimeConfig, updateRuntimeConfig, listMcpServers, upsertMcpServer, removeMcpServer,
  type MemberIdentity,
} from "../org/store.js";

const actorOf = (u: LivelyUser): string => u?.email || u?.userId || "unknown";

// REST 전용 capability 의 MCP 필드 기본값(input 미사용).
const restOnly = (name: string, title: string, description: string,
  rest: Capability["expose"]["rest"], handler: Capability["handler"]): Capability =>
  ({ name, title, description, scope: "admin", input: {}, expose: { mcp: false, rest }, handler });

// 읽기 전용(read) — scope null = 인증만. 비-admin 구성원도 공유 컨텍스트를 읽을 수 있게(핸들러가 admin 여부로 민감 필드 redact).
const restRead = (name: string, title: string, description: string,
  rest: Capability["expose"]["rest"], handler: Capability["handler"]): Capability =>
  ({ name, title, description, scope: null, input: {}, expose: { mcp: false, rest }, handler });

const SCOPES_ALLOWED = new Set(["items", "context", "admin", "db", "memory", "code"]);

function parseIdentities(raw: unknown): MemberIdentity[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "identities 는 배열이어야 합니다");
  return raw.map((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    if (typeof o.system !== "string" || !o.system.trim()) throw new HttpError(400, `identities[${i}].system 필수`);
    if (typeof o.external_id !== "string" || !o.external_id.trim()) throw new HttpError(400, `identities[${i}].external_id 필수`);
    const idn: MemberIdentity = { system: o.system.trim(), external_id: o.external_id.trim() };
    if (typeof o.email === "string" && o.email.trim()) idn.email = o.email.trim();
    if (typeof o.instance === "string" && o.instance.trim()) idn.instance = o.instance.trim();
    if (typeof o.display_name === "string" && o.display_name.trim()) idn.display_name = o.display_name.trim();
    return idn;
  });
}

const str = (v: unknown, name: string, max = 20000): string => {
  if (typeof v !== "string") throw new HttpError(400, `${name} 은(는) 문자열 필수`);
  if (v.length > max) throw new HttpError(400, `${name} 은(는) ${max}자 이하여야 합니다`);
  return v;
};
const slug = (v: unknown, name: string): string => {
  const s = str(v, name, 100).trim();
  if (!s) throw new HttpError(400, `${name} 필수`);
  if (!/^[A-Za-z0-9가-힣_-]+$/.test(s)) throw new HttpError(400, `${name} 은 영문/숫자/한글/_/- 만 허용됩니다`);
  return s;
};

export const deliveryCapabilities: Capability[] = [
  // ── 단일 로드: 관리 화면 전체 상태 + 의미 가이드 ──
  restRead("org_overview", "조직 전달 개요",
    "org-content(프로필·섹션·구성원·메모리) + '구성원에게 미치는 효과' 가이드를 로드. admin 은 토큰·구성원 상세까지, 비-admin 은 읽기 전용(민감 필드 redact).",
    [{ method: "GET", paths: ["/api/ui/org"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const isAdmin = !!(user?.scopes && user.scopes.includes("admin"));
      const [profile, sections, members, memory] = await Promise.all([
        getOrgProfile(), listSections(), listMembers(), listMemory(),
      ]);
      const sectionMap: Record<string, { body_md: string; version: number; updated_at: string | null; updated_by: string | null }> = {};
      for (const s of sections) sectionMap[s.section] = { body_md: s.body_md, version: s.version, updated_at: s.updated_at, updated_by: s.updated_by };
      // 비-admin: 구성원은 이름/종류/상태만(이메일·신원·개인레이어 redact), 토큰 목록은 비노출.
      const memberRows = isAdmin
        ? await Promise.all(members.map(async (m) => ({ ...m, hasToken: await memberHasActiveToken(m.id) })))
        : members.map((m) => ({ id: m.id, kind: m.kind, display_name: m.display_name, email: null, identities: [], body_md: "", state: m.state, scopes: [] }));
      // admin 에겐 전체 token_hash 노출 — 회수 핸들로 필요. 해시는 비가역(평문 토큰 복원 불가)이라 안전.
      const tokens = isAdmin ? await listTokens() : [];
      const runtimeConfig = isAdmin ? await getRuntimeConfig() : null;
      const mcpServers = isAdmin ? await listMcpServers() : [];
      return {
        profile, sections: sectionMap, members: memberRows, memory, tokens, runtimeConfig, mcpServers,
        meaning: MEANING, publishMeaning: PUBLISH_MEANING, canEdit: isAdmin,
      };
    }),

  // ── 멤버 컨텍스트 미리보기(WYSIWYG: 구성원 AI 가 실제 읽는 정적 컨텍스트) ──
  restRead("org_preview", "멤버 컨텍스트 미리보기",
    "구성원의 AI 가 매 세션 첫머리에 실제로 읽는 정적 컨텍스트를 렌더한다(공유 맥락 — 비-admin 도 열람).",
    [{ method: "GET", paths: ["/api/ui/org/preview"], parse: () => ({}) }],
    async () => {
      const p = await getOrgProfile();
      const name = p.display_name?.trim() || p.name?.trim() || "조직";
      return { context: await previewMemberContext(name) };
    }),

  // ── 프로필(표시명·게이트웨이 주소) ──
  restOnly("org_update_profile", "조직 프로필 수정",
    "조직 표시명/게이트웨이 주소를 수정한다.",
    [{ method: "POST", paths: ["/api/ui/org/profile"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const patch: { name?: string; display_name?: string; gateway_url?: string } = {};
      if (input.name !== undefined) patch.name = str(input.name, "name", 200).trim();
      if (input.display_name !== undefined) patch.display_name = str(input.display_name, "display_name", 200).trim();
      if (input.gateway_url !== undefined) patch.gateway_url = str(input.gateway_url, "gateway_url", 500).trim();
      return { profile: await updateOrgProfile(patch, actorOf(user), "web") };
    }),

  // ── 섹션(강제규칙·회사맥락) markdown 편집 ──
  restOnly("org_update_section", "조직 섹션 수정",
    "강제규칙(managed-policy)·회사맥락(org-defaults) markdown 을 저장한다.",
    [{ method: "POST", paths: ["/api/ui/org/section"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const section = str(input.section, "section", 50);
      if (section !== "managed-policy" && section !== "org-defaults") {
        throw new HttpError(400, "section 은 managed-policy|org-defaults 만 허용됩니다");
      }
      const body = str(input.body_md ?? "", "body_md", 60000);
      // managed-policy 는 32KiB 한도(Codex) — 합성 문서 머리에 항상 실리므로 길면 경고가 아니라 차단.
      if (section === "managed-policy" && Buffer.byteLength(body, "utf8") > 16 * 1024) {
        throw new HttpError(400, "강제 규칙이 너무 깁니다(16KiB 초과) — 짧고 절대적인 규칙만 두세요");
      }
      return { section: await updateSection(section, body, actorOf(user), "web") };
    }),

  // ── 구성원 upsert/remove ──
  restOnly("org_member_upsert", "구성원 추가·수정",
    "구성원 신원(표시명·이메일·외부계정 연결·개인레이어)을 저장한다. person/person_identity 로도 동기화.",
    [{ method: "POST", paths: ["/api/ui/org/member"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = slug(input.id, "id");
      const kind = input.kind === undefined ? undefined : str(input.kind, "kind", 10) as "human" | "agent" | "system";
      if (kind && !["human", "agent", "system"].includes(kind)) throw new HttpError(400, "kind 는 human|agent|system");
      let scopes: string[] | undefined;
      if (input.scopes !== undefined) {
        if (!Array.isArray(input.scopes)) throw new HttpError(400, "scopes 는 배열이어야 합니다");
        scopes = input.scopes.map((s) => str(s, "scopes[]", 20));
        for (const s of scopes) if (!SCOPES_ALLOWED.has(s)) throw new HttpError(400, `허용되지 않은 scope: ${s}`);
      }
      const member = await upsertMember({
        id, kind,
        display_name: input.display_name === undefined ? undefined : str(input.display_name, "display_name", 200).trim(),
        email: input.email === undefined ? undefined : str(input.email, "email", 200).trim(),
        identities: input.identities === undefined ? undefined : parseIdentities(input.identities),
        body_md: input.body_md === undefined ? undefined : str(input.body_md, "body_md", 20000),
        state: input.state === undefined ? undefined : (str(input.state, "state", 10) as "active" | "inactive"),
        scopes,
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      }, actorOf(user), "web");
      return { member };
    }),
  restOnly("org_member_remove", "구성원 제거",
    "org_member 에서 구성원을 제거한다(person 행은 참조무결성 위해 보존).",
    [{ method: "POST", paths: ["/api/ui/org/member/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      await removeMember(slug(input.id, "id"), actorOf(user), "web");
      return { ok: true };
    }),

  // ── 메모리 upsert/remove ──
  restOnly("org_memory_upsert", "메모리 추가·수정",
    "정설 메모리 문서를 저장한다(in_index=true 면 MEMORY.md 인덱스에 노출).",
    [{ method: "POST", paths: ["/api/ui/org/memory"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const memory = await upsertMemory({
        name: slug(input.name, "name"),
        title: input.title === undefined ? undefined : str(input.title, "title", 200).trim(),
        body_md: input.body_md === undefined ? undefined : str(input.body_md, "body_md", 40000),
        in_index: input.in_index === undefined ? undefined : Boolean(input.in_index),
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      }, actorOf(user), "web");
      return { memory };
    }),
  restOnly("org_memory_remove", "메모리 제거",
    "정설 메모리 문서를 제거한다.",
    [{ method: "POST", paths: ["/api/ui/org/memory/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      await removeMemory(slug(input.name, "name"), actorOf(user), "web");
      return { ok: true };
    }),

  // ── 토큰 발급/회수 ──
  restOnly("org_token_mint", "구성원 토큰 발급",
    "구성원용 bearer 토큰을 발급한다(평문은 1회만 반환). curl 설치 한 줄에 이 토큰을 박는다.",
    [{ method: "POST", paths: ["/api/ui/org/token"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = slug(input.userId ?? input.memberId, "userId");
      const memberId = input.memberId === undefined ? userId : slug(input.memberId, "memberId");
      // scope 미지정 시 구성원에 설정된 권한을 기본값으로(구성원 메뉴의 권한이 토큰 권한의 진실원천).
      let rawScopes: unknown[];
      if (Array.isArray(input.scopes) && input.scopes.length) rawScopes = input.scopes;
      else { const mem = await getMember(memberId); rawScopes = mem?.scopes?.length ? mem.scopes : ["items", "context"]; }
      const scopes = rawScopes.map((s) => str(s, "scopes[]", 20));
      for (const s of scopes) if (!SCOPES_ALLOWED.has(s)) throw new HttpError(400, `허용되지 않은 scope: ${s}`);
      const { token, tokenHash } = await mintToken({
        userId,
        scopes,
        label: input.label === undefined ? null : str(input.label, "label", 200).trim(),
        memberId,
      }, actorOf(user), "web");
      return { token, tokenHash: tokenHash.slice(0, 12), userId, scopes }; // 평문 token 은 이 응답에서만
    }),

  // ── 본인 토큰 자가발급(설치 탭) — 인증된 구성원이 자기 토큰을 만든다. admin 불요. ──
  // userId 는 principal 에서 강제(타인 발급 불가), scope 는 본인 member.scopes(없으면 현재 scope) — 상승 불가.
  restRead("org_token_mint_self", "본인 토큰 발급",
    "현재 로그인한 구성원이 본인 설치 토큰을 발급한다(설치/재설치용). userId·scope 는 principal 로 고정.",
    [{ method: "POST", paths: ["/api/ui/org/token/self"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const mem = await getMember(userId);
      const base = mem?.scopes?.length ? mem.scopes : (Array.isArray(user.scopes) ? user.scopes : ["items", "context"]);
      const scopes = base.filter((s) => SCOPES_ALLOWED.has(s));
      const { token } = await mintToken(
        { userId, scopes, label: (mem?.display_name || userId) + " (self)", memberId: userId },
        actorOf(user), "web-self");
      return { token, scopes, userId };
    }),

  restOnly("org_token_revoke", "토큰 회수",
    "토큰을 즉시 무효화한다(게이트웨이 재시작 불요).",
    [{ method: "POST", paths: ["/api/ui/org/token/revoke"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      // 전체 해시를 받는다(목록은 prefix 만 노출하므로 회수는 발급 시 받은 전체 해시 또는 별도 조회 필요).
      const hash = str(input.tokenHash, "tokenHash", 64).trim();
      await revokeToken(hash, actorOf(user), "web");
      return { ok: true };
    }),

  // ── 발행(검증 + 산출 확인) ──
  restOnly("org_publish_run", "발행 실행",
    "DB→임시디렉토리 materialize→generator 로 발행 아티팩트를 만들어 검증한다(구성원은 curl /install 로 받는다).",
    [{ method: "POST", paths: ["/api/ui/org/publish"], parse: (req) => req.body ?? {} }],
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "lively-pubcheck-"));
      try {
        const res = await runPublish(dir, "claude");
        return {
          ok: res.ok,
          artifactBytes: res.artifactBytes,
          warning: res.warning ?? null,
          meaning: PUBLISH_MEANING,
        };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => { /* 임시디렉토리 정리 실패 무시 */ });
      }
    }),

  // ── 런타임 설정(훅 on/off · work-roots · 너지) ──
  restRead("org_runtime_config", "런타임 설정 조회",
    "훅 on/off·work-roots·writeback 너지문구 — 세션 훅이 동적 fetch(scope null, 멤버 토큰 OK).",
    [{ method: "GET", paths: ["/api/ui/org/runtime-config"], parse: () => ({}) }],
    async () => {
      const c = await getRuntimeConfig();
      return { hooks: c.hooks, work_roots: c.work_roots, writeback_notice: c.writeback_notice };
    }),
  restOnly("org_runtime_update", "런타임 설정 수정",
    "훅 활성/비활성·work-roots 목록·writeback 너지문구를 저장한다.",
    [{ method: "POST", paths: ["/api/ui/org/runtime-config"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const patch: { hooks?: Record<string, boolean>; writeback_notice?: string | null; work_roots?: string[] } = {};
      if (input.hooks !== undefined) {
        const h = input.hooks;
        if (typeof h !== "object" || h === null || Array.isArray(h)) throw new HttpError(400, "hooks 는 객체여야 합니다");
        patch.hooks = {};
        for (const k of ["session_preload", "work_flag", "stop_writeback_gate"]) {
          if (k in (h as Record<string, unknown>)) patch.hooks[k] = Boolean((h as Record<string, unknown>)[k]);
        }
      }
      if (input.writeback_notice !== undefined) {
        patch.writeback_notice = (input.writeback_notice === null || input.writeback_notice === "")
          ? null : str(input.writeback_notice, "writeback_notice", 2000);
      }
      if (input.work_roots !== undefined) {
        if (!Array.isArray(input.work_roots)) throw new HttpError(400, "work_roots 는 배열이어야 합니다");
        patch.work_roots = input.work_roots.map((r) => str(r, "work_roots[]", 500).trim()).filter(Boolean);
      }
      return { runtimeConfig: await updateRuntimeConfig(patch, actorOf(user), "web") };
    }),

  // ── MCP 서버 레지스트리 ──
  restRead("org_mcp_servers", "MCP 서버 목록 조회",
    "활성 MCP 서버 목록 — register-clients/세션훅이 fetch해 멤버 하네스에 등록(scope null). 시크릿 없음(auth_env=변수명).",
    [{ method: "GET", paths: ["/api/ui/org/mcp-servers"], parse: () => ({}) }],
    async () => {
      const all = await listMcpServers();
      return { servers: all.filter((s) => s.enabled).map((s) => ({
        name: s.name, transport: s.transport, url: s.url, command: s.command, auth_env: s.auth_env, enabled: s.enabled,
      })) };
    }),
  restOnly("org_mcp_upsert", "MCP 서버 추가·수정",
    "조직 MCP 서버를 저장한다. transport http(url)|stdio(command). 인증은 auth_env(환경변수 이름만 — 시크릿 금지).",
    [{ method: "POST", paths: ["/api/ui/org/mcp-server"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const name = slug(input.name, "name");
      let transport: "http" | "stdio" | undefined;
      if (input.transport !== undefined) {
        const t = str(input.transport, "transport", 10);
        if (t !== "http" && t !== "stdio") throw new HttpError(400, "transport 는 http|stdio 만 허용됩니다");
        transport = t;
      }
      let authEnv: string | null | undefined;
      if (input.auth_env !== undefined) {
        if (input.auth_env === null || input.auth_env === "") authEnv = null;
        else {
          authEnv = str(input.auth_env, "auth_env", 100).trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authEnv)) throw new HttpError(400, "auth_env 는 환경변수 이름 형식이어야 합니다(시크릿 값 금지)");
        }
      }
      const server = await upsertMcpServer({
        name, transport,
        url: input.url === undefined ? undefined : (input.url === null || input.url === "" ? null : str(input.url, "url", 1000).trim()),
        command: input.command === undefined ? undefined : (input.command === null || input.command === "" ? null : str(input.command, "command", 2000).trim()),
        auth_env: authEnv,
        note: input.note === undefined ? undefined : str(input.note, "note", 500),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      }, actorOf(user), "web");
      return { server };
    }),
  restOnly("org_mcp_remove", "MCP 서버 제거",
    "조직 MCP 서버를 제거한다.",
    [{ method: "POST", paths: ["/api/ui/org/mcp-server/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      await removeMcpServer(slug(input.name, "name"), actorOf(user), "web");
      return { ok: true };
    }),
];

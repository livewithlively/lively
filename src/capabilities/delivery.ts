// delivery(전달/관리) capabilities — workflow-std 흡수의 게이트웨이 표면.
// 비개발자 관리자가 org-content(강제규칙·회사맥락·메모리·구성원·게이트웨이주소)를 웹에서 편집/발행하고
// 구성원 토큰을 발급한다. 전부 admin scope + REST 전용(expose.mcp=false — 에이전트가 정책을 못 바꾸게).
// 모든 응답에 '구성원에게 미치는 효과'(meaning) 가이드를 함께 실어 UI 가 의미를 인지시킨다.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, CapabilityCtx } from "./types.js";
import { HttpError } from "./rest-util.js";
import { SCOPES_ALLOWED, DANGEROUS_SCOPES, type Scope } from "./scopes.js";
import { assertSafeJsonSchema } from "./dynamic-tools.js";
import type { LivelyUser } from "../context.js";
import { MEANING, PUBLISH_MEANING } from "../org/meaning.js";
import { previewMemberContext, runPublish } from "../org/publish.js";
import { GUIDE_SECTION_DEFAULTS } from "../org/materialize.js";
import { DEFAULT_WRITEBACK_NOTICE } from "../org/hook-defaults.js";
import { assertHookId } from "../org/identity.js";
import { isBuiltinToolName, toolCandidates } from "./mcp-surface.js";
import { assertNoHardSecrets } from "../org/redact.js";
import {
  getOrgProfile, updateOrgProfile, listSections, updateSection,
  listMembers, getMember, memberIdByEmail, upsertMember, removeMember, listMemory, upsertMemory, removeMemory,
  mintToken, listTokens, revokeToken, memberHasActiveToken,
  getRuntimeConfig, updateRuntimeConfig, listMcpServers, upsertMcpServer, removeMcpServer,
  listOrgHooks, listEnabledHooks, upsertOrgHook, removeOrgHook,
  listTools, upsertTool, removeTool, listAutoApproveTools,
  listDbSources, upsertDbSource, removeDbSource,
  type MemberIdentity, type WriteCtx, type HookHarness, type ToolKind, type OrgToolInput,
  type DbSourceInput, type DbSourceRow,
} from "../org/store.js";
import { learnGroundTruth } from "../org/knowledge.js";
import { previewHooks } from "../org/hooks-preview.js";
import { hostOfUrl, isHostBlocked, isSecretRefAllowed, inspectConnString } from "../db/source-guard.js";
import { invalidatePool } from "../db/pool.js";
import { refreshSources, listSourceConfigs } from "../db/sources.js";
import { generateInitialPassword, setMemberPassword, hasCredential, membersWithCredentials } from "../auth/local-accounts.js";

// 감사 actor 는 안정 식별자(userId) 우선 — email 은 변동/위조 가능(B23).
const actorOf = (u: LivelyUser): string => u?.userId || u?.email || "unknown";

// REST 전용 capability 의 MCP 필드 기본값(input 미사용).
const restOnly = (name: string, title: string, description: string,
  rest: Capability["expose"]["rest"], handler: Capability["handler"]): Capability =>
  ({ name, title, description, scope: "admin", input: {}, expose: { mcp: false, rest }, handler });

// 읽기 전용(read) — scope null = 인증만. 비-admin 구성원도 공유 컨텍스트를 읽을 수 있게(핸들러가 admin 여부로 민감 필드 redact).
const restRead = (name: string, title: string, description: string,
  rest: Capability["expose"]["rest"], handler: Capability["handler"]): Capability =>
  ({ name, title, description, scope: null, input: {}, expose: { mcp: false, rest }, handler });

// runtime 권한 — 멤버 머신에서 실행되는 것(커스텀 훅·MCP 툴)을 정의. admin 과 분리(admin ⊉ runtime).
//  expose.mcp=false: 에이전트가 스스로 훅/툴을 만들지 못하게(웹 REST 전용).
const restRuntime = (name: string, title: string, description: string,
  rest: Capability["expose"]["rest"], handler: Capability["handler"]): Capability =>
  ({ name, title, description, scope: "runtime", input: {}, expose: { mcp: false, rest }, handler });

// 쓰기 감사 맥락 — actor(userId)·토큰해시·IP 를 store 로 전달(B23).
const wctx = (u: LivelyUser, ctx?: CapabilityCtx): WriteCtx =>
  ({ actor: actorOf(u), source: ctx?.source ?? "web", tokenHashPrefix: ctx?.tokenHashPrefix ?? null, ip: ctx?.ip ?? null });

// 커스텀 훅(org_hook)이 붙을 수 있는 이벤트 — DB 제약(org_hook_event_chk)·run-custom 배선(runnerHooksBlock)과 일치 유지.
//  Claude 31개 이벤트 중 저빈도·유용한 라이프사이클만 노출(MessageDisplay 등 상시발화는 perf 위해 제외). Codex 는 SessionStart/PostToolUse/Stop 만 지원.
const HOOK_EVENTS = new Set(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "Notification", "PreCompact", "PostCompact"]);
const HOOK_HARNESSES = new Set(["claude", "codex", "openclaw", "all"]);
const TOOL_SCOPES = new Set(["items", "context", "db", "memory", "code"]); // http_proxy 호출 권한(admin·null 불가)
const TOOL_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

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
// 이메일 형식 검증 — 이메일이 곧 로그인 아이디라, 생성 시점에 막아 로그인 매칭과 일관성을 맞춘다(실용적 미니 체크).
const assertEmail = (v: string): void => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, "이메일 형식이 올바르지 않습니다");
};
// 멤버 아이디 = **불변 내부키**(auth_token·web_session·member_credential·project_member·activity·person·터미널세션·감사가
//  전부 참조). 이메일은 가변(변경 시 전 참조 깨짐)·agent/system 은 null → 내부키로 부적합. 그래서 별도 surrogate.
//  단 관리자가 직접 만들 필요는 없으므로 신규는 이메일 로컬파트(없으면 표시이름)에서 자동·유니크 생성한다.
const slugifyId = (s: string): string =>
  (s || "").toLowerCase().replace(/[^a-z0-9가-힣_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "member";
async function uniqueMemberId(base: string): Promise<string> {
  const b = slugifyId(base);
  if (!(await getMember(b))) return b;
  for (let i = 2; i < 1000; i++) { const c = `${b}-${i}`; if (!(await getMember(c))) return c; } // 충돌 시 -2,-3…
  return `${b}-${Math.floor(performance.now())}`;
}

// DB 소스 응답 마스킹 — url 원문은 노출하지 않는다(host·user·db명·잠재 시크릿). host 만 파생 노출,
//  auth_ref 는 이름(시크릿 값 아님)만. 편집 시 url 은 변경할 때만 재입력(빈칸=미변경).
const maskDbSource = (s: DbSourceRow): Record<string, unknown> => ({
  name: s.name, driver: s.driver, host: s.url ? (hostOfUrl(s.url) ?? null) : null,
  auth_mode: s.auth_mode, auth_ref: s.auth_ref, rls: s.rls, max_rows: s.max_rows, timeout_ms: s.timeout_ms,
  note: s.note, enabled: s.enabled, sort: s.sort, version: s.version, updated_at: s.updated_at, updated_by: s.updated_by,
});

export const deliveryCapabilities: Capability[] = [
  // ── 단일 로드: 관리 화면 전체 상태 + 의미 가이드 ──
  restRead("org_overview", "조직 전달 개요",
    "org-content(프로필·섹션·구성원·메모리) + '구성원에게 미치는 효과' 가이드를 로드. admin 은 토큰·구성원 상세까지, 비-admin 은 읽기 전용(민감 필드 redact).",
    [{ method: "GET", paths: ["/api/ui/org"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const isAdmin = !!(user?.scopes && user.scopes.includes("admin"));
      const isRuntime = !!(user?.scopes && user.scopes.includes("runtime")); // 훅·툴 관리 권한(admin 과 분리)
      const [profile, sections, members, memory] = await Promise.all([
        getOrgProfile(), listSections(), listMembers(), listMemory(),
      ]);
      const sectionMap: Record<string, { body_md: string; version: number; updated_at: string | null; updated_by: string | null }> = {};
      for (const s of sections) sectionMap[s.section] = { body_md: s.body_md, version: s.version, updated_at: s.updated_at, updated_by: s.updated_by };
      // 컨텍스트 온톨로지 가이드 섹션 — DB 행이 없으면(편집 전) 코드 기본 템플릿을 채워 편집기가 '현재 유효 텍스트'를 보여준다(version:0=미저장).
      //  buildKnowledgeIndex 도 같은 기본값으로 폴백하므로 화면=실주입 일치. sectionDefaults 는 '기본값 되돌리기' 버튼용.
      for (const [k, def] of Object.entries(GUIDE_SECTION_DEFAULTS)) {
        if (!sectionMap[k]) sectionMap[k] = { body_md: def, version: 0, updated_at: null, updated_by: null };
      }
      // 비-admin: 구성원은 이름/종류/상태만(이메일·신원·개인레이어 redact), 토큰 목록은 비노출.
      const credSet = isAdmin ? await membersWithCredentials() : new Set<string>();
      const memberRows = isAdmin
        ? await Promise.all(members.map(async (m) => ({ ...m, hasToken: await memberHasActiveToken(m.id), hasAccount: credSet.has(m.id) })))
        : members.map((m) => ({ id: m.id, kind: m.kind, display_name: m.display_name, email: null, identities: [], body_md: "", state: m.state, scopes: [] }));
      // admin 에겐 전체 token_hash 노출 — 회수 핸들로 필요. 해시는 비가역(평문 토큰 복원 불가)이라 안전.
      const tokens = isAdmin ? await listTokens() : [];
      const runtimeConfig = isAdmin ? await getRuntimeConfig() : null;
      const mcpServers = isAdmin ? await listMcpServers() : [];
      const dbSources = isAdmin ? await listDbSources() : [];
      if (isAdmin) await refreshSources();
      const dbNames = new Set(dbSources.map((s) => s.name));
      const envSources = isAdmin
        ? listSourceConfigs().filter((s) => s.origin === "env" && !dbNames.has(s.name)).map((s) => ({ name: s.name, host: s.url ? (hostOfUrl(s.url) ?? null) : null, rls: s.rls }))
        : [];
      // runtime 권한자: 커스텀 훅·툴 목록 + 빌트인 목록 + 툴 정책(allowlist — 시크릿 아님).
      const orgHooks = isRuntime ? await listOrgHooks() : [];
      const tools = isRuntime ? await listTools() : [];
      const rc = isRuntime ? (runtimeConfig ?? await getRuntimeConfig()) : null;
      const toolPolicy = isRuntime ? { allowed_auth_envs: rc!.allowed_auth_envs, url_allowlist: rc!.url_allowlist } : null;
      // 메모리는 단일 공유 풀 — 전 구성원이 읽는 조직 지식이므로 비-admin 에도 그대로 노출(member/internal 격리 폐기).
      return {
        profile, sections: sectionMap, sectionDefaults: GUIDE_SECTION_DEFAULTS,
        writebackNoticeDefault: DEFAULT_WRITEBACK_NOTICE, // 세션종료 너지 기본값 — 웹 편집기가 표시·되돌리기에 사용
        members: memberRows, memory, tokens, runtimeConfig, mcpServers,
        dbSources: dbSources.map(maskDbSource), envSources,
        orgHooks, tools, builtins: isRuntime ? toolCandidates() : [], toolPolicy,
        meaning: MEANING, publishMeaning: PUBLISH_MEANING, canEdit: isAdmin, canRuntime: isRuntime,
      };
    }),

  // ── 멤버 컨텍스트 미리보기(WYSIWYG: 구성원 AI 가 실제 읽는 정적 컨텍스트) ──
  restRead("org_preview", "멤버 컨텍스트 미리보기",
    "구성원의 AI 가 매 세션 첫머리에 실제로 읽는 정적 컨텍스트를 렌더한다(공유 맥락 — 비-admin 도 열람).",
    [{ method: "GET", paths: ["/api/ui/org/preview"], parse: () => ({}) }],
    async (_input, user) => {
      const p = await getOrgProfile();
      const name = p.display_name?.trim() || p.name?.trim() || "조직";
      // 팀-스코프 주입: bearer principal(=org_member.id)로 '우리 팀' 카테고리를 상단 정렬·프리앰블. 익명/미소속이면 org-wide.
      const memberId = (user as { userId?: string } | undefined)?.userId || undefined;
      return { context: await previewMemberContext(name, memberId) };
    }),

  // ── 컨텍스트 온톨로지 가이드 미리보기 — '이 편집 부분만'(Knowledge Index) 을 렌더한다. ──
  //  body_md(미저장 편집값)를 받아 ${rules}/${area} 를 라이브 데이터로 채워 실제 주입 모습을 보여준다(WYSIWYG, 편집 즉시).
  //  body_md 생략/공백이면 buildKnowledgeIndex 가 코드 기본 템플릿으로 폴백. 공유 맥락 미리보기라 scope null(인증만).
  {
    name: "org_guide_preview", title: "컨텍스트 온톨로지 가이드 미리보기",
    description: "컨텍스트 온톨로지 가이드 템플릿(편집값)에 카테고리·강제규칙을 채워 실제 주입되는 Knowledge Index 만 렌더한다(전체 맥락 아님).",
    scope: null, input: {}, expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/org/guide-preview"], parse: (req) => req.body ?? {} }] },
    handler: async (input: Record<string, unknown>) => {
      const bodyMd = typeof input?.body_md === "string" ? input.body_md : undefined;
      const { buildKnowledgeIndex, categoryMapForIndex, wikiCategoryMap } = await import("../org/materialize.js");
      const { listKnowledge } = await import("../v6/knowledge-store.js");
      const [knowledge, categoryMap, wikiCats] = await Promise.all([listKnowledge({ lifecycle: "active", limit: 500 }), categoryMapForIndex(), wikiCategoryMap()]);
      return { context: buildKnowledgeIndex(knowledge, categoryMap, bodyMd, wikiCats) };
    },
  },

  // ── 지식유형/수집 ground-truth(#/learn) — kind_registry + data_source 를 그대로 렌더(비개발자 학습 화면). ──
  //  D-GT: 분류기준·저장방식·전달방식·소스별 수집방식의 단일 출처. 읽기전용(scope null = 인증만), REST 전용.
  //  런북(build-classify-runbook.mjs)과 동일 데이터(learnGroundTruth) → 양 표면 non-stale 일관.
  restRead("learn", "지식유형/수집 안내",
    "통합 지식스토어가 분류하는 12개 지식 종류(정의·분류기준·저장방식·전달방식)와 데이터소스별 수집방식을 ground-truth(kind_registry·data_source)에서 그대로 반환한다(비개발자 학습 화면 #/learn).",
    [{ method: "GET", paths: ["/api/ui/learn"], parse: () => ({}) }],
    async () => learnGroundTruth()),

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

  // ── 섹션 markdown 편집 — 강제규칙·회사맥락 + 컨텍스트 온톨로지 가이드(Knowledge Index 전체 템플릿). ──
  restOnly("org_update_section", "조직 섹션 수정",
    "강제규칙(managed-policy)·회사맥락(org-defaults)·컨텍스트 온톨로지 가이드(context-ontology-guide) markdown 을 저장한다.",
    [{ method: "POST", paths: ["/api/ui/org/section"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const section = str(input.section, "section", 50);
      // 허용 섹션 = 코어 2개 + 가이드 1개(GUIDE_SECTION_DEFAULTS 키). 그 외는 거부(임의 R ku 우회 차단).
      const isGuide = Object.prototype.hasOwnProperty.call(GUIDE_SECTION_DEFAULTS, section);
      if (section !== "managed-policy" && section !== "org-defaults" && !isGuide) {
        throw new HttpError(400, "허용되지 않은 섹션입니다(managed-policy|org-defaults|context-ontology-guide)");
      }
      const body = str(input.body_md ?? "", "body_md", 60000);
      // managed-policy 는 32KiB 한도(Codex) — 합성 문서 머리에 항상 실리므로 길면 경고가 아니라 차단.
      if (section === "managed-policy" && Buffer.byteLength(body, "utf8") > 16 * 1024) {
        throw new HttpError(400, "강제 규칙이 너무 깁니다(16KiB 초과) — 짧고 절대적인 규칙만 두세요");
      }
      // 가이드 템플릿은 인덱스 골격이라 길지 않아야 한다 — 16KiB 초과 차단(과편집·본문 오입력 방지).
      if (isGuide && Buffer.byteLength(body, "utf8") > 16 * 1024) {
        throw new HttpError(400, "가이드가 너무 깁니다(16KiB 초과) — 인덱스 골격 안내만 두세요");
      }
      assertNoHardSecrets(body, "body_md"); // P8: 가이드/규칙/맥락은 합성 컨텍스트에 항상 실린다 — 평문 시크릿 hard-block(ctx_save 와 동일 choke-point)
      return { section: await updateSection(section, body, actorOf(user), "web") };
    }),

  // ── 구성원 upsert/remove ──
  restOnly("org_member_upsert", "구성원 추가·수정",
    "구성원 신원(표시명·이메일·외부계정 연결·개인레이어)을 저장한다. person/person_identity 로도 동기화.",
    [{ method: "POST", paths: ["/api/ui/org/member"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const kind = input.kind === undefined ? undefined : str(input.kind, "kind", 10) as "human" | "agent" | "system";
      if (kind && !["human", "agent", "system"].includes(kind)) throw new HttpError(400, "kind 는 human|agent|system");
      const displayName = input.display_name === undefined ? undefined : str(input.display_name, "display_name", 200).trim();
      // 이메일 = 로그인 아이디 → 형식 검증(생성·로그인 일관). 빈 값은 허용(로그인 불요 멤버 — 계정 미발급).
      const email = input.email === undefined ? undefined : str(input.email, "email", 200).trim();
      if (email) assertEmail(email);
      // 아이디: 명시되면 그대로(편집·고급), 없으면 신규 생성 → 이메일/표시이름에서 자동·유니크(관리자 비관여, 불변 내부키).
      const hasExplicitId = input.id !== undefined && String(input.id).trim() !== "";
      const id = hasExplicitId ? slug(input.id, "id") : await uniqueMemberId(email ? email.split("@")[0] : (displayName || "member"));
      const existed = hasExplicitId ? await getMember(id) : null; // 자동 id 는 항상 신규
      // 이메일 = 로그인 키 → 유일해야 한다(다른 멤버가 같은 이메일이면 거부, 대소문자 무시). 본인(편집)은 허용.
      if (email) {
        const taken = await memberIdByEmail(email);
        if (taken && taken !== id) throw new HttpError(400, "이미 사용 중인 이메일입니다 — 다른 이메일을 쓰세요");
      }
      let scopes: string[] | undefined;
      if (input.scopes !== undefined) {
        if (!Array.isArray(input.scopes)) throw new HttpError(400, "scopes 는 배열이어야 합니다");
        scopes = input.scopes.map((s) => str(s, "scopes[]", 20));
        for (const s of scopes) if (!SCOPES_ALLOWED.has(s)) throw new HttpError(400, `허용되지 않은 scope: ${s}`);
      }
      // 개인레이어 본문(body_md)은 합성 컨텍스트에 실리는 자유텍스트 — 평문 시크릿 hard-block(ctx_save 와 동일 choke-point).
      const memberBody = input.body_md === undefined ? undefined : str(input.body_md, "body_md", 20000);
      if (memberBody !== undefined) assertNoHardSecrets(memberBody, "body_md"); // P8
      const member = await upsertMember({
        id, kind,
        display_name: displayName,
        email,
        identities: input.identities === undefined ? undefined : parseIdentities(input.identities),
        body_md: memberBody,
        state: input.state === undefined ? undefined : (str(input.state, "state", 10) as "active" | "inactive"),
        scopes,
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      }, actorOf(user), "web");
      // 신규 human 멤버 → 로컬 로그인 계정 자동 발급(초기 비번 1회 반환 — 관리자가 멤버에게 전달).
      //  로그인이 이메일 기준이라 **유효 이메일이 있을 때만** 발급(없으면 못 쓰는 계정 → 발급 안 함).
      //  agent/system·기존 멤버·이미 계정 있음도 제외.
      let initialPassword: string | undefined;
      if (!existed && member.kind === "human" && member.email && !(await hasCredential(id))) {
        initialPassword = generateInitialPassword();
        await setMemberPassword(id, initialPassword, { mustChange: true, actor: actorOf(user) });
      }
      return { member, initialPassword };
    }),
  // ── 구성원 비밀번호 재설정 — 임시 비번 1회 반환(관리자가 멤버에게 전달). 첫 로그인 후 변경 권장(must_change). ──
  restOnly("org_member_reset_password", "구성원 비밀번호 재설정",
    "구성원의 로컬 로그인 비밀번호를 임시 비번으로 재설정한다(1회 반환). 멤버는 이 비번으로 로그인 후 변경한다.",
    [{ method: "POST", paths: ["/api/ui/org/member/reset-password"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = slug(input.id, "id");
      const m = await getMember(id);
      if (!m) throw new HttpError(404, "구성원을 찾을 수 없습니다");
      if (m.kind !== "human") throw new HttpError(400, "사람(human) 구성원만 로그인 계정을 가질 수 있습니다");
      if (!m.email) throw new HttpError(400, "이메일이 없어 로그인 계정을 만들 수 없습니다 — 먼저 구성원에 이메일을 설정하세요");
      const password = generateInitialPassword();
      await setMemberPassword(id, password, { mustChange: true, actor: actorOf(user) });
      return { id, password };
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
    "조직 공유 메모리를 저장한다(제목·요약은 인덱스로 공유, 본문은 memory_search). domain 으로 귀속.",
    [{ method: "POST", paths: ["/api/ui/org/memory"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      // domain_key: 빈 문자열/null → 귀속 해제(null). 미전송(undefined) → 기존 보존.
      // V5 탈-repo: 도메인 귀속은 key 만(repo-비의존) — domain_repo 는 항상 null(귀속 변경 시) / 보존(미전송 시).
      const domainKey = input.domain_key === undefined ? undefined : (String(input.domain_key).trim() || null);
      const domainRepo = domainKey === undefined ? undefined : null;
      // 공유 메모리 본문(body_md)은 에이전트/사람이 읽는 자유텍스트 — 평문 시크릿 hard-block(ctx_save 와 동일 choke-point).
      const memoryBody = input.body_md === undefined ? undefined : str(input.body_md, "body_md", 40000);
      if (memoryBody !== undefined) assertNoHardSecrets(memoryBody, "body_md"); // P8
      const memory = await upsertMemory({
        name: slug(input.name, "name"),
        title: input.title === undefined ? undefined : str(input.title, "title", 200).trim(),
        // 카드 표시용 '쉬운 한 줄' — 빈 문자열은 클리어(null → title 폴백), 미전송은 보존(undefined).
        summary: input.summary === undefined ? undefined : (str(input.summary, "summary", 200).trim() || null),
        body_md: memoryBody,
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
        domain_key: domainKey,
        domain_repo: domainRepo,
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
      else { const mem = await getMember(memberId); rawScopes = mem?.scopes?.length ? mem.scopes : ["items", "context", "memory"]; }
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
      // 자가발급은 회수 가능한 DB 토큰만 만든다 — 회수 불가한 정적 토큰으로는 금지(킬스위치 세탁 방지).
      //  (scope-null capability 라 web.ts 의 B3/B5 게이트가 안 걸린다 → 여기서 직접 차단.)
      if (user.tokenSource === "static") throw new HttpError(403, "정적 토큰으로는 자가발급할 수 없습니다 — 관리자에게 발급을 요청하세요");
      const mem = await getMember(userId);
      const presented = Array.isArray(user.scopes) ? user.scopes : [];
      const base = mem?.scopes?.length ? mem.scopes : presented;
      // 설치용 토큰 — fleet 제어(admin/runtime)는 자가발급 불가 + 제시한 토큰의 권한을 초과 불가(scope 증폭 차단).
      const scopes = base.filter((s) => SCOPES_ALLOWED.has(s) && !DANGEROUS_SCOPES.has(s as Scope) && presented.includes(s));
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
      // 훅이 동적으로 필요한 것만(비밀 아님): hooks 토글 + 너지문구. work_roots(디렉토리 경로)는
      //  비-admin 에게 노출 안 함 — 설치 번들(.lively/work-roots, 멤버 본인 설치 경로)로만 전달.
      const c = await getRuntimeConfig();
      // write_tools(기록 인정 툴)·auto_approve(자동승인 툴 'mcp__lively__<tool>')도 훅이 동적으로 읽음(B) —
      //  툴 '이름'뿐이라 비밀 아님(work_roots 와 달리 노출 OK). 훅이 매 세션 settings.json permissions.allow 에 reconcile.
      const autoApprove = (await listAutoApproveTools()).map((t) => `mcp__lively__${t.name}`);
      return { hooks: c.hooks, writeback_notice: c.writeback_notice, write_tools: c.write_tools, auto_approve: autoApprove };
    }),
  restOnly("org_runtime_update", "런타임 설정 수정",
    "훅 활성/비활성·work-roots·writeback 너지 + 안전 화이트리스트(allowed_auth_envs·url_allowlist·allowed_db_hosts)를 저장한다.",
    [{ method: "POST", paths: ["/api/ui/org/runtime-config"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const patch: {
        hooks?: Record<string, boolean>; writeback_notice?: string | null; work_roots?: string[];
        allowed_auth_envs?: string[]; url_allowlist?: string[]; allowed_db_hosts?: string[]; write_tools?: string[];
      } = {};
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
      if (input.allowed_auth_envs !== undefined) {
        if (!Array.isArray(input.allowed_auth_envs)) throw new HttpError(400, "allowed_auth_envs 는 배열이어야 합니다");
        patch.allowed_auth_envs = input.allowed_auth_envs.map((e) => str(e, "allowed_auth_envs[]", 100).trim()).filter(Boolean);
        for (const e of patch.allowed_auth_envs) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)) throw new HttpError(400, `allowed_auth_envs 항목 '${e}' 는 환경변수 이름 형식이어야 합니다`);
        }
      }
      if (input.url_allowlist !== undefined) {
        if (!Array.isArray(input.url_allowlist)) throw new HttpError(400, "url_allowlist 는 배열이어야 합니다");
        patch.url_allowlist = input.url_allowlist.map((u) => str(u, "url_allowlist[]", 200).trim().toLowerCase()).filter(Boolean);
      }
      if (input.allowed_db_hosts !== undefined) {
        if (!Array.isArray(input.allowed_db_hosts)) throw new HttpError(400, "allowed_db_hosts 는 배열이어야 합니다");
        patch.allowed_db_hosts = input.allowed_db_hosts.map((h) => str(h, "allowed_db_hosts[]", 200).trim().toLowerCase()).filter(Boolean);
      }
      if (input.write_tools !== undefined) {
        if (!Array.isArray(input.write_tools)) throw new HttpError(400, "write_tools 는 배열이어야 합니다");
        // 비우면 훅 내장 기본목록 사용(오버라이드 해제). 각 항목은 lively MCP 툴 '이름' 형식(접두사 mcp__lively__ 없이).
        patch.write_tools = input.write_tools.map((t) => str(t, "write_tools[]", 100).trim()).filter(Boolean);
        for (const t of patch.write_tools) {
          if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(t)) throw new HttpError(400, `write_tools 항목 '${t}' 는 툴 이름 형식이어야 합니다(영문/숫자/_)`);
        }
        if (patch.write_tools.length > 100) throw new HttpError(400, "write_tools 가 너무 많습니다(100개 이하)");
      }
      return { runtimeConfig: await updateRuntimeConfig(patch, actorOf(user), ctx?.source ?? "web",
        { tokenHashPrefix: ctx?.tokenHashPrefix ?? null, ip: ctx?.ip ?? null }) };
    }),

  // ── MCP 서버 레지스트리 ──
  restRead("org_mcp_servers", "MCP 서버 목록 조회",
    "활성 MCP 서버 목록 — register-clients/세션훅이 fetch해 멤버 하네스에 등록(scope null). 시크릿 없음(auth_env=변수명).",
    [{ method: "GET", paths: ["/api/ui/org/mcp-servers"], parse: () => ({}) }],
    async () => {
      const all = await listMcpServers();
      return { servers: all.filter((s) => s.enabled && (s.transport === "stdio" ? !!s.command : !!s.url)).map((s) => ({
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

  // ════════ 커스텀 훅 CRUD (runtime 권한) ════════
  restRuntime("org_hooks", "커스텀 훅 목록",
    "조직 커스텀 훅 전체(소스 포함) — runtime 권한 전용. 멤버 런너 fetch 는 org_runner_hooks(별도).",
    [{ method: "GET", paths: ["/api/ui/org/hooks"], parse: () => ({}) }],
    async () => ({ hooks: await listOrgHooks(), meaning: MEANING["custom-hook"] })),
  restRuntime("org_hook_upsert", "커스텀 훅 추가·수정",
    "구성원 머신에서 실행되는 커스텀 훅을 저장한다(runtime). 본문은 멤버 디스크에 굳히지 않고 런너가 매 세션 fetch.",
    [{ method: "POST", paths: ["/api/ui/org/hook"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const id = assertHookId(input.id);
      const event = str(input.event, "event", 40);
      if (!HOOK_EVENTS.has(event)) throw new HttpError(400, `event 는 ${[...HOOK_EVENTS].join("|")} 만 허용됩니다`);
      const harness = input.harness === undefined ? "all" : str(input.harness, "harness", 12);
      if (!HOOK_HARNESSES.has(harness)) throw new HttpError(400, "harness 는 claude|codex|openclaw|all");
      const sourceCode = str(input.source_code ?? "", "source_code", 16384);
      assertNoHardSecrets(sourceCode, "source_code"); // B20: 평문 시크릿 hard-block
      const matcher = (input.matcher === undefined || input.matcher === null || input.matcher === "")
        ? null : str(input.matcher, "matcher", 500);
      const timeout = input.timeout_sec === undefined ? 10 : Number(input.timeout_sec);
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) throw new HttpError(400, "timeout_sec 은 1~120 사이 정수여야 합니다");
      const hook = await upsertOrgHook({
        id,
        label: input.label === undefined ? undefined : str(input.label, "label", 200).trim(),
        harness: harness as HookHarness, event, matcher, source_code: sourceCode, timeout_sec: Math.floor(timeout),
        note: input.note === undefined ? undefined : str(input.note, "note", 500),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      }, wctx(user, ctx));
      return { hook };
    }),
  restRuntime("org_hook_remove", "커스텀 훅 제거",
    "커스텀 훅을 제거한다 — 다음 세션부터 런너가 더는 fetch/실행하지 않는다(미접속 머신은 직전 상태 유지).",
    [{ method: "POST", paths: ["/api/ui/org/hook/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      await removeOrgHook(assertHookId(input.id), wctx(user, ctx));
      return { ok: true };
    }),

  // ── 훅 주입 가시화(J절) — 설치된 세션 훅이 각자 실제로 무엇을 주입하는지 최종 메시지 미리보기. ──
  //  읽기 전용(scope null = 인증만 — 공유 컨텍스트 가시화, org_preview/learn 과 동일 평면). 게이트웨이가 소스인
  //  부분은 previewMemberContext 단일 함수, 훅-로컬 템플릿은 설치 파일에서 추출(드리프트 0). redact choke-point 통과.
  restRead("org_hooks_preview", "훅 주입 미리보기",
    "설치된 세션 훅(session-preload·work-flag·stop-writeback-gate)이 각자 세션 컨텍스트에 실제로 주입하는 최종 메시지를 충실도(exact/approximate)와 함께 반환한다.",
    [{ method: "GET", paths: ["/api/ui/org/hooks/preview"], parse: () => ({}) }],
    async () => previewHooks()),

  // ── 런너 fetch — 멤버 런너(run-custom.mjs)가 매 세션 호출. 인증된 멤버면 OK(scope null). ──
  // 멤버 머신이 그 훅을 '실행'하므로 source 를 받는 게 정상(관리 목록 org_hooks 와 달리 redact 안 함).
  restRead("org_runner_hooks", "런너 훅 fetch",
    "멤버 런너가 현재 활성 커스텀 훅(소스+content_hash)을 받아 실행한다. harness/event 로 필터.",
    [{ method: "GET", paths: ["/api/ui/org/runner/hooks"],
      parse: (req) => ({ harness: req.query.harness, event: req.query.event }) }],
    async (input: Record<string, unknown>) => {
      const harness = typeof input.harness === "string" && input.harness ? input.harness : undefined;
      const event = typeof input.event === "string" && input.event ? input.event : undefined;
      let hooks = await listEnabledHooks(harness);
      if (event) hooks = hooks.filter((h) => h.event === event);
      return { hooks: hooks.map((h) => ({
        id: h.id, event: h.event, matcher: h.matcher, source_code: h.source_code,
        content_hash: h.content_hash, timeout_sec: h.timeout_sec,
      })) };
    }),

  // ════════ MCP 툴 CRUD (runtime 권한) ════════
  restRuntime("org_tools", "AI 도구(툴) 목록",
    "조직 정의 MCP 툴(http_proxy) + 빌트인 토글 상태 + 툴 정책(allowlist) — runtime 권한 전용.",
    [{ method: "GET", paths: ["/api/ui/org/tools"], parse: () => ({}) }],
    async () => {
      const cfg = await getRuntimeConfig();
      return {
        tools: await listTools(), builtins: toolCandidates(),
        toolPolicy: { allowed_auth_envs: cfg.allowed_auth_envs, url_allowlist: cfg.url_allowlist },
        meaning: MEANING["tool"],
      };
    }),
  restRuntime("org_tool_upsert", "AI 도구 추가·수정",
    "조직 MCP 툴을 저장한다(runtime). http_proxy=사내 API 래핑(게이트웨이가 즉시 노출), builtin=빌트인 on/off·auto_approve.",
    [{ method: "POST", paths: ["/api/ui/org/tool"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const kind = input.kind === undefined ? "http_proxy" : str(input.kind, "kind", 12);
      if (kind !== "http_proxy" && kind !== "builtin") throw new HttpError(400, "kind 는 http_proxy|builtin 만 허용됩니다(prompt 미지원)");
      const rawName = str(input.name, "name", 64).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(rawName)) throw new HttpError(400, "name 은 소문자 영숫자/_/- 1~64자(소문자·숫자로 시작)여야 합니다");
      if (kind === "http_proxy" && isBuiltinToolName(rawName)) throw new HttpError(400, `name '${rawName}' 는 빌트인 도구와 충돌합니다`);
      if (kind === "builtin" && !isBuiltinToolName(rawName)) throw new HttpError(400, `'${rawName}' 는 빌트인 도구가 아닙니다(kind=builtin 은 빌트인 토글 전용)`);
      const base: OrgToolInput = {
        name: rawName, kind: kind as ToolKind,
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        auto_approve: input.auto_approve === undefined ? undefined : Boolean(input.auto_approve),
        // 주입모드(#187): undefined=유지, null=코드기본 복귀, true=항상 주입, false=deferred. 빌트인 토글 전용(Claude Code _meta).
        always_load: input.always_load === undefined ? undefined : (input.always_load === null ? null : Boolean(input.always_load)),
        title: input.title === undefined ? undefined : str(input.title, "title", 200).trim(),
        description: input.description === undefined ? undefined : str(input.description, "description", 2000),
        note: input.note === undefined ? undefined : str(input.note, "note", 500),
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      };
      if (kind === "http_proxy") {
        const scope = str(input.scope ?? "items", "scope", 12);
        if (!TOOL_SCOPES.has(scope)) throw new HttpError(400, `scope 는 ${[...TOOL_SCOPES].join("|")} 만 허용됩니다(admin·null 불가)`);
        const method = (input.method === undefined ? "GET" : str(input.method, "method", 8)).toUpperCase();
        if (!TOOL_METHODS.has(method)) throw new HttpError(400, "method 는 GET|POST|PUT|PATCH|DELETE");
        const url = str(input.url, "url", 1000).trim();
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new HttpError(400, "url 은 절대 URL 이어야 합니다"); }
        if (parsed.protocol !== "https:") throw new HttpError(400, "url 은 https 여야 합니다");
        assertNoHardSecrets(url, "url");
        if (input.input_schema !== undefined && input.input_schema !== null) assertSafeJsonSchema(input.input_schema);
        let authEnv: string | null = null;
        if (input.auth_env !== undefined && input.auth_env !== null && input.auth_env !== "") {
          authEnv = str(input.auth_env, "auth_env", 100).trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authEnv)) throw new HttpError(400, "auth_env 는 환경변수 이름 형식이어야 합니다(시크릿 값 금지)");
          const cfg = await getRuntimeConfig();
          if (!cfg.allowed_auth_envs.includes(authEnv)) {
            throw new HttpError(400, `auth_env '${authEnv}' 는 허용 목록(allowed_auth_envs)에 없습니다 — 런타임 설정에 먼저 추가하세요`);
          }
        }
        base.scope = scope;
        base.method = method;
        base.url = url;
        base.auth_env = authEnv;
        base.input_schema = input.input_schema ?? undefined;
      }
      return { tool: await upsertTool(base, wctx(user, ctx)) };
    }),
  restRuntime("org_tool_remove", "AI 도구 제거",
    "조직 MCP 툴을 제거한다(http_proxy=즉시 노출 중단, builtin 게이팅 행 제거=기본값 복귀).",
    [{ method: "POST", paths: ["/api/ui/org/tool/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const name = str(input.name, "name", 64).trim().toLowerCase();
      await removeTool(name, wctx(user, ctx));
      return { ok: true };
    }),

  // ════════ DB 데이터소스 레지스트리 (admin 권한) ════════
  // db_query/db_schema 가 읽는 외부 운영 DB. 시크릿 미저장: url=비번 없는 접속문자열, 인증은 auth_mode+auth_ref(참조).
  restOnly("org_db_sources", "DB 데이터소스 목록",
    "관리자용 DB 소스 목록 — 접속 url(비번 가능)은 host 만, auth_ref 는 이름만 노출. allowedSecretRefs=참조 가능한 env 화이트리스트.",
    [{ method: "GET", paths: ["/api/ui/org/db-sources"], parse: () => ({}) }],
    async (_input: Record<string, unknown>, user: LivelyUser) => {
      const all = await listDbSources();
      const cfg = await getRuntimeConfig();
      return { sources: all.map(maskDbSource), allowedSecretRefs: cfg.allowed_db_secret_refs, meaning: MEANING["db-source"] };
    }),
  restOnly("org_db_source_upsert", "DB 데이터소스 추가·수정",
    "db_query 가 읽을 외부 데이터소스를 저장한다(admin). url 은 비번 없는 접속문자열, 인증은 auth_mode + auth_ref(참조 — 시크릿 값 금지). 1차 password 만. 저장 즉시 반영(풀 회수).",
    [{ method: "POST", paths: ["/api/ui/org/db-source"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const cfg = await getRuntimeConfig(); // host·auth_ref 화이트리스트 검증 공용(운영자 통제 경계)
      const name = slug(input.name, "name");
      const driver = input.driver === undefined ? "postgres" : str(input.driver, "driver", 20);
      if (driver !== "postgres") throw new HttpError(400, "driver 는 postgres 만 지원합니다(1차 pg-only)");
      const authMode = input.auth_mode === undefined ? "password" : str(input.auth_mode, "auth_mode", 12);
      if (!["password", "iam", "mtls", "vault"].includes(authMode)) throw new HttpError(400, "auth_mode 는 password|iam|mtls|vault");
      if (authMode !== "password") throw new HttpError(400, `auth_mode '${authMode}' 는 아직 지원되지 않습니다(1차 password 만 — iam/mtls/vault 후속)`);

      // url — 비번 인라인 hard-block + SSRF(외부 host 만 — 사설/메타데이터 IP 차단).
      let url: string | null | undefined;
      if (input.url !== undefined) {
        if (input.url === null || input.url === "") url = null;
        else {
          url = str(input.url, "url", 1000).trim();
          assertNoHardSecrets(url, "url");
          // pg 파서 기준 검사(검증=접속 일치) — new URL 이 못 보는 ?host=/?password=/?hostaddr= 쿼리파라미터 우회 차단.
          const ins = inspectConnString(url);
          if (ins.hasPassword) throw new HttpError(400, "url 에 비밀번호를 넣지 마세요(?password= 포함) — auth_ref(환경변수 이름)로 참조하세요");
          if (ins.hasHostAddr) throw new HttpError(400, "url 에 hostaddr 파라미터는 허용되지 않습니다");
          if (!ins.host) throw new HttpError(400, "url 이 올바른 접속문자열이 아닙니다(host 없음)");
          if (await isHostBlocked(ins.host, cfg.allowed_db_hosts)) throw new HttpError(400, `차단된 host(사설/메타데이터 IP): ${ins.host} — 외부 DB host 만 허용됩니다(사설/localhost 는 런타임설정 allowed_db_hosts 에 먼저 등록하세요)`);
        }
      }
      // auth_ref — 환경변수 이름 형식 + 화이트리스트(인프라 시크릿 차단).
      let authRef: string | null | undefined;
      if (input.auth_ref !== undefined) {
        if (input.auth_ref === null || input.auth_ref === "") authRef = null;
        else {
          authRef = str(input.auth_ref, "auth_ref", 100).trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authRef)) throw new HttpError(400, "auth_ref 는 환경변수 이름 형식이어야 합니다(시크릿 값 금지)");
          if (!isSecretRefAllowed(authRef, cfg.allowed_db_secret_refs)) {
            throw new HttpError(400, `auth_ref '${authRef}' 는 허용목록(allowed_db_secret_refs)에 없습니다 — 런타임 설정에 먼저 추가하세요`);
          }
        }
      }
      let rls: string | null | undefined;
      if (input.rls !== undefined) rls = (input.rls === null || input.rls === "") ? null : str(input.rls, "rls", 200).trim();
      const posIntOpt = (v: unknown, label: string): number | null | undefined => {
        if (v === undefined) return undefined;
        if (v === null || v === "") return null;
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} 는 양의 정수여야 합니다`);
        return n;
      };
      const payload: DbSourceInput = {
        name, driver, auth_mode: authMode as DbSourceInput["auth_mode"], url, auth_ref: authRef, rls,
        max_rows: posIntOpt(input.max_rows, "max_rows"),
        timeout_ms: posIntOpt(input.timeout_ms, "timeout_ms"),
        note: input.note === undefined ? undefined : str(input.note, "note", 500),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      };
      const src = await upsertDbSource(payload, actorOf(user), "web");
      invalidatePool(name);
      await refreshSources(true); // 무재시작 반영
      return { source: maskDbSource(src) };
    }),
  restOnly("org_db_source_remove", "DB 데이터소스 제거",
    "DB 데이터소스를 제거한다(db_query 즉시 반영 — 풀 회수).",
    [{ method: "POST", paths: ["/api/ui/org/db-source/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const name = slug(input.name, "name");
      await removeDbSource(name, actorOf(user), "web");
      invalidatePool(name);
      await refreshSources(true);
      return { ok: true };
    }),
];

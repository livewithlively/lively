// delivery(전달/관리) capabilities — workflow-std 흡수의 게이트웨이 표면.
// 비개발자 관리자가 org-content(강제규칙·회사맥락·메모리·구성원·게이트웨이주소)를 웹에서 편집/발행하고
// 구성원 토큰을 발급한다. admin/runtime scope — REST(웹) + MCP(에이전트) 양쪽 노출(#549).
//  과거엔 expose.mcp=false 로 에이전트를 원천 차단했으나(정책 변경 금지), 에이전트가 관리탭 기능을 직접
//  다뤄야 하는 상황이 실제로 생겨 MCP 로도 연다(#549). 안전판은 유지된다:
//   ① 회수 가능한 DB 토큰만(B5: 정적 토큰은 admin/runtime 거부 — web.ts:85, MCP 는 sanitize 로 admin scope 자체 제거),
//   ② 유효 scope = intersection(토큰, 멤버 LIVE) — 강등·퇴사 즉시 무효(store.ts computeEffectiveScopes),
//   ③ 모든 쓰기는 org_content_audit 에 누가(actor_kind: 사람/AI)·경로(channel: mcp/web)·before/after 감사(조회: org_audit_list).
// 모든 응답에 '구성원에게 미치는 효과'(meaning) 가이드를 함께 실어 UI 가 의미를 인지시킨다.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, CapabilityCtx } from "./types.js";
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import { SCOPES_ALLOWED, DANGEROUS_SCOPES, type Scope } from "./scopes.js";
import { assertSafeJsonSchema } from "./dynamic-tools.js";
import { refreshProxySnapshot } from "./mcp-proxy.js";
import { broadcastToolListChanged } from "../mcp-sessions.js";
import type { LivelyUser } from "../context.js";
import { MEANING, PUBLISH_MEANING } from "../org/meaning.js";
// 저장소·로그(#813) — 관리탭이 박스 디스크·로그를 보는 창구(고객 박스엔 우리가 SSH 로 못 들어간다).
import { checkDisks } from "../health.js";
import { listLogs } from "../log-janitor.js";
import { stateRoot, logRoot } from "../state-dir.js";
import { ROOTS as TERMINAL_ROOTS, SHARED_ROOT as TERMINAL_SHARED_ROOT } from "../terminal-sessions.js";
import { normalizeStoragePolicy, type StoragePolicyPatch } from "../org/storage-policy.js";
import { sharedCacheRoot, sessionCacheEnv, dirSize } from "../session-cache.js";
// 경보 알림(#813) — 웹훅 URL 은 시크릿이라 값이 응답·감사에 절대 나가지 않는다(alerts.ts 머리주석 참조).
import { loadAlertChannel, saveAlertChannel, removeAlertChannel, sendTestAlert } from "../alerts.js";
// 워크스페이스 사용량(#813 T3-2 백스톱) — 프로젝트별로 얼마나 쌓였나. 회수 실행은 workspace_reclaim 이 한다.
import fsp from "node:fs/promises";
import path from "node:path";
import { PROJECT_SHARED_BASE, PROJECT_SUBDIR, LEGACY_SUBDIR, projectAbsPath } from "../project-fs.js";
import { dirSizesFast, isInside, reposIn, planReclaim, applyReclaim, baseRepoOf } from "../workspace-reclaim.js";
import { listSessions } from "../terminal-sessions.js";
import { isValidTimezone, DEFAULT_TZ } from "../org/timezone.js"; // #778 조직 시간대 검증·기본값
import { previewMemberContext, runPublish, kitVersion } from "../org/publish.js";
import { GUIDE_SECTION_DEFAULTS } from "../org/materialize.js";
import { DEFAULT_WRITEBACK_NOTICE } from "../org/hook-defaults.js";
import { DEFAULT_SKILLS } from "../org/default-content.js"; // #878 시딩 스킬 편집 경고(seed_warning)
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { assertHookId, assertAssetId } from "../org/identity.js";
import { isBuiltinToolName, toolCandidates } from "./mcp-surface.js";
import { assertNoHardSecrets } from "../org/redact.js";
import {
  getOrgProfile, updateOrgProfile, listSections, updateSection, deleteSection, setSectionsOrder, sectionNameInUse,
  listMembers, getMember, memberIdByEmail, upsertMember, removeMember, listMemory,
  mintToken, listTokens, revokeToken, memberHasActiveToken,
  listContentAudit, ADMIN_AUDIT_ENTITIES,
  getRuntimeConfig, updateRuntimeConfig, getEmbeddingConfigSource, getStoragePolicySource, listMcpServers, upsertMcpServer, removeMcpServer,
  listOrgHooks, listEnabledHooks, upsertOrgHook, removeOrgHook,
  listOrgHarnessAssets, listEnabledAssets, upsertOrgHarnessAsset, removeOrgHarnessAsset,
  listAssetPrefs, setAssetPref, clearAssetPref, getOrgHook, getOrgHarnessAsset, type AssetPrefKind,
  listTools, upsertTool, removeTool, listAutoApproveTools,
  listDbSources, getDbSource, upsertDbSource, removeDbSource,
  listConnectors, upsertConnector, removeConnector,
  listIngestPolicies, upsertIngestPolicy, removeIngestPolicy, ingestObservability,
  upsertTablePolicy, removeTablePolicy, upsertColumnMask, removeColumnMask,
  type MemberIdentity, type WriteCtx, type HookHarness, type ToolKind, type OrgToolInput, type AssetKind,
  type DbSourceInput, type DbSourceRow,
} from "../org/store.js";
import { MCP_SERVER_PRESETS } from "../org/mcp-server-presets.js";
import { learnGroundTruth } from "../org/knowledge.js";
import { previewHooks } from "../org/hooks-preview.js";
import { effectiveVisible, targetsMember } from "../org/asset-visibility.js"; // #699 per-member 유효 가시성 규칙(SoT)
// ClickUp 멤버 매핑 패널(#541) — 팀 멤버 나열(getTeam) + person_identity 기반 매핑 상태 계산.
import { connectors } from "../connectors/index.js";
import type { ConnectorUser } from "../connectors/types.js";
import { resetConnectorConfigCache } from "../connectors/config.js";
import { itemsPool } from "../items/store.js";
import { hostOfUrl, isHostBlocked, isSecretRefAllowed, inspectConnString, inspectMysqlUrl } from "../db/source-guard.js";
import { invalidatePool } from "../db/pool.js";
import { listTableNames, listColumnsMeta } from "../db/catalog.js";
import { refreshSources, listSourceConfigs } from "../db/sources.js";
import { refreshPolicy, getSourcePolicy, getMaskStyleMap } from "../db/policy.js";
import { isSystemDeniedTable } from "../db/firewall.js";
import { generateInitialPassword, setMemberPassword, hasCredential, membersWithCredentials, verifyOwnPassword } from "../auth/local-accounts.js";
import { lookupDeviceAuth, approveDeviceAuth, denyDeviceAuth, checkDeviceRate } from "../org/device-auth.js";
// 임베딩(벡터검색 #172) — 런타임 토글(embedding_config)은 updateRuntimeConfig 로, 기존 지식 백필은 공유 코어로.
import { startBackfillJob, getBackfillJob, countEmbeddingBacklog, runAutoBackfillSweep, PROJECT_TARGET, type BackfillMode } from "../v6/embedding-backfill.js";
import type { EmbeddingConfigPatch } from "../v6/embedding-provider.js";
import {
  DEFAULT_EMBEDDING_BATCH_SIZE, DEFAULT_EMBEDDING_TIMEOUT_MS,
  EMBEDDING_BATCH_MIN, EMBEDDING_BATCH_MAX, EMBEDDING_TIMEOUT_MIN_MS, EMBEDDING_TIMEOUT_MAX_MS,
} from "../v6/embedding-provider.js";
import {
  GATEWAY_OWNER, memberOwner, listGitCredentialsPublic, setSshCredential, setHttpsCredential,
  deleteGitCredential, generateSshKeypair, type GitCredentialPublic,
} from "../org/git-credential-store.js";
import { secretsEnabled } from "../org/secret-box.js";
// #586 커넥터 UX — 비동기 실행(run 엔티티)·스코프 발견.
import { startConnectorRun, listConnectorRuns, getConnectorRun, cancelConnectorRun } from "../connectors/run-tracker.js";
import { discoverConnectorScope } from "../connectors/discover.js";
// #697 매핑 소급 — 관리탭 멤버 매핑(person_identity) 변경을 이미 미러된 데이터에 즉시 재해소.
import { reresolveMirrorMembers } from "../v6/connector-mirror.js";
import { logger } from "../log.js";

// 감사 actor 는 안정 식별자(userId) 우선 — email 은 변동/위조 가능(B23).
const actorOf = (u: LivelyUser): string => u?.userId || u?.email || "unknown";

// admin capability 공통 팩토리 — REST + MCP 양쪽 노출(#549: mcp=true). scope=admin.
//  input:{} — 파라미터 스키마는 비어 있고(REST parse/handler 가 검증), 에이전트는 description 으로 인자를 판단한다.
const restOnly = (name: string, title: string, description: string,
  rest: Capability["expose"]["rest"], handler: Capability["handler"], input: Capability["input"] = {}): Capability =>
  ({ name, title, description, scope: "admin", input, expose: { mcp: true, rest }, handler });

// 읽기 전용(read) — scope null = 인증만. 비-admin 구성원도 공유 컨텍스트를 읽을 수 있게(핸들러가 admin 여부로 민감 필드 redact).
//  mcp 기본 false(공유 읽기는 웹/REST 표면) — 관리 대시보드 조회(org_overview)만 mcp=true 로 열어 에이전트가 상태를 본다(#549).
const restRead = (name: string, title: string, description: string,
  rest: Capability["expose"]["rest"], handler: Capability["handler"], mcp = false, input: Capability["input"] = {}): Capability =>
  ({ name, title, description, scope: null, input, expose: { mcp, rest }, handler });

// runtime 권한 — 멤버 머신에서 실행되는 것(커스텀 훅·MCP 툴)을 정의. admin 과 분리(admin ⊉ runtime).
//  #549: REST + MCP 양쪽 노출(과거 mcp=false 로 에이전트가 스스로 훅/툴을 못 만들게 했으나, 이제 에이전트도 다룰 수 있게).
//  안전판: 회수 가능한 DB 토큰 + runtime scope(멤버 LIVE 교집합) 필요 — 정적 토큰·미보유자는 거부.
const restRuntime = (name: string, title: string, description: string,
  rest: Capability["expose"]["rest"], handler: Capability["handler"], input: Capability["input"] = {}): Capability =>
  ({ name, title, description, scope: "runtime", input, expose: { mcp: true, rest }, handler });

// 쓰기 감사 맥락 — actor(userId)·토큰해시·IP 를 store 로 전달(B23).
const wctx = (u: LivelyUser, ctx?: CapabilityCtx): WriteCtx =>
  ({ actor: actorOf(u), source: ctx?.source ?? "web", tokenHashPrefix: ctx?.tokenHashPrefix ?? null, ip: ctx?.ip ?? null });

// 커스텀 훅(org_hook)이 붙을 수 있는 이벤트 — DB 제약(org_hook_event_chk)·run-custom 배선(runnerHooksBlock)과 일치 유지.
//  Claude 31개 이벤트 중 저빈도·유용한 라이프사이클만 노출(MessageDisplay 등 상시발화는 perf 위해 제외). Codex 는 SessionStart/PostToolUse/Stop 만 지원.
const HOOK_EVENTS = new Set(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "Notification", "PreCompact", "PostCompact"]);
const HOOK_HARNESSES = new Set(["claude", "codex", "openclaw", "all"]);
const HARNESS_ASSET_KINDS = new Set(["skill", "subagent", "command"]); // 하네스 자산 종류(스킬·서브에이전트·슬래시커맨드)

// ── 시딩 스킬 편집 경고(#878) — 지식 seedSyncWarning(knowledge.ts)과 대칭. 시딩되는 스킬(org_harness_asset)을
//  이 게이트웨이에서 고치면, 고객이 받는 본문의 SoT 는 이 DB 가 아니라 src/org/default-content.ts(capture 스냅샷)다.
//  시딩이 "손 안 댄 것 갱신"(#878)이라 canonical 에서 capture 후 릴리스하면 고객에 전파되지만, capture 를 빠뜨리면
//  반영되지 않는다 → 그 리마인더. 경고는 seed 소스(src/)가 있는 canonical 체크아웃에서만 뜬다(고객 릴리스 번들엔
//  src/ 없음 — 내부 경로 노출 방지, 지식 경고와 동일 스코핑).
const SEEDED_SKILL_IDS = new Set(DEFAULT_SKILLS.map((s) => s.id));
const SEED_ASSET_SOURCE_PRESENT = fs.existsSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "org", "default-content.ts"));
function seedAssetSyncWarning(id: string | null | undefined): { seed_warning?: string } {
  if (!SEED_ASSET_SOURCE_PRESENT || !id || !SEEDED_SKILL_IDS.has(id)) return {};
  return { seed_warning: `⚠ '${id}' 은 신규 고객 게이트웨이에 시딩되는 스킬입니다(#713). 고객이 받는 본문의 SoT 는 이 게이트웨이 DB 가 아니라 src/org/default-content.ts(capture 스냅샷)입니다 — 이 편집을 고객 배포에 반영하려면 canonical 게이트웨이에서 \`node --env-file=.env scripts/capture-default-content.mjs\` 로 default-content.ts 를 재생성·릴리스하세요(내부 [[링크]]·이슈번호·사내 명칭·타 고객사명은 빼고 고객 맥락으로 — CI 가드가 잡습니다). 미갱신 시 신규 고객은 옛 본문을 받습니다.` };
}
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
  note: s.note, enabled: s.enabled, table_default: s.table_default, sort: s.sort, version: s.version, updated_at: s.updated_at, updated_by: s.updated_by,
});

// git 자격 등록(#540) 입력 파싱·적용 — self(me/*)·gateway(org/*) 공용. SSH 는 박스가 키페어 생성(개인키 박스밖 유출 없음),
//  HTTPS 는 토큰. 시크릿은 secret-box 봉투 암호화로 DB 저장(secretsEnabled 아니면 503 — 평문 저장 금지).
const GIT_HOST_RE = /^[a-z0-9.-]{1,253}$/;
function parseGitHost(input: Record<string, unknown>): string {
  const raw = (input.host === undefined || input.host === null || String(input.host).trim() === "") ? "github.com" : String(input.host).trim().toLowerCase();
  if (!GIT_HOST_RE.test(raw)) throw new HttpError(400, "git 호스트명 형식이 올바르지 않습니다 (예: github.com)");
  return raw;
}
async function applyGitCredential(owner: string, input: Record<string, unknown>, actor: string): Promise<{ credential: GitCredentialPublic; public_key?: string }> {
  if (!secretsEnabled()) throw new HttpError(503, "CONNECTOR_SECRET_KEY 가 설정되지 않아 자격을 저장할 수 없습니다 — 관리자에게 게이트웨이 env(CONNECTOR_SECRET_KEY) 설정을 요청하세요.");
  const host = parseGitHost(input);
  const kind = str(input.kind, "kind", 10).trim();
  const label = input.label === undefined || input.label === null ? null : str(input.label, "label", 200).trim();
  if (kind === "ssh") {
    // SSH: 박스가 ed25519 키페어 생성 — 개인키는 DB(암호화)에만, 공개키만 반환·저장(사용자가 GitHub 에 등록).
    const kp = await generateSshKeypair(`${owner}@lively-box`);
    const credential = await setSshCredential(owner, host, { publicKey: kp.publicKey, privateKey: kp.privateKey, label }, actor);
    return { credential, public_key: kp.publicKey };
  }
  if (kind === "https") {
    const token = str(input.token, "token", 4000);
    if (!token.trim()) throw new HttpError(400, "HTTPS 토큰이 필요합니다");
    const username = input.username === undefined || input.username === null ? null : str(input.username, "username", 200).trim();
    const credential = await setHttpsCredential(owner, host, { username, token, label }, actor);
    return { credential };
  }
  throw new HttpError(400, "kind 는 ssh|https 여야 합니다");
}

// 하네스 자산 target_members — null/빈=전원, 배열=그 멤버 id 만(per-member 타깃팅). 멤버 id 슬러그 검증.
function parseTargetMembers(raw: unknown): string[] | null | undefined {
  if (raw === undefined) return undefined; // 미지정 = 변경 없음(store 가 기존 유지)
  if (raw === null || raw === "") return null; // 명시 null/빈문자 = 전원
  if (!Array.isArray(raw)) throw new HttpError(400, "target_members 는 배열(멤버 id) 또는 null(전원)이어야 합니다");
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") throw new HttpError(400, "target_members 항목은 문자열(멤버 id)이어야 합니다");
    const s = v.trim().toLowerCase();
    if (s && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) throw new HttpError(400, `target_members 항목 '${v}' 가 멤버 id 형식이 아닙니다`);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.length ? out : null; // 빈 배열 = 전원(null)
}

// #699: 개인 오버라이드 대상 종류 검증(harness_asset|org_hook).
function assertPrefKind(raw: unknown): AssetPrefKind {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s !== "harness_asset" && s !== "org_hook") throw new HttpError(400, "target_kind 는 harness_asset|org_hook 이어야 합니다");
  return s;
}

// 자산 frontmatter — 평탄 키:값 맵만(스킬/에이전트/커맨드 YAML frontmatter 로 materialize). 값=문자열·불리언·숫자·문자열배열.
//  중첩객체 금지(YAML 주입·복잡도 차단). 키 32개·키길이 64 상한. description 은 별도 컬럼이므로 여기선 부가필드(when_to_use·tools·model·allowed-tools·argument-hint 등)용.
function parseAssetFrontmatter(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "frontmatter 는 객체(키:값)여야 합니다");
  const src = raw as Record<string, unknown>;
  const keys = Object.keys(src);
  if (keys.length > 32) throw new HttpError(400, "frontmatter 키는 32개 이하여야 합니다");
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k)) throw new HttpError(400, `frontmatter 키 '${k}' 형식 오류(영문 시작, 영숫자/_/- 64자)`);
    const v = src[k];
    if (typeof v === "string") { if (v.length > 4000) throw new HttpError(400, `frontmatter '${k}' 값이 너무 깁니다`); out[k] = v; }
    else if (typeof v === "boolean" || typeof v === "number") out[k] = v;
    else if (Array.isArray(v)) {
      if (v.length > 64) throw new HttpError(400, `frontmatter '${k}' 배열이 너무 깁니다`);
      out[k] = v.map((e) => {
        if (typeof e !== "string") throw new HttpError(400, `frontmatter '${k}' 는 문자열 배열만 허용됩니다`);
        if (e.length > 500) throw new HttpError(400, `frontmatter '${k}' 항목이 너무 깁니다`);
        return e;
      });
    } else throw new HttpError(400, `frontmatter '${k}' 값 타입 불허(문자열·불리언·숫자·문자열배열만)`);
  }
  return out;
}

// 워크스페이스에서 **주소의 단위는 폴더다 — 프로젝트 id 가 아니다.**
//
//  ⚠ 이걸 id 로 잡으면 두 부류가 통째로 사라진다(#845 에서 실제로 겪음):
//   ① **이름 기반 폴더**(2026-06-25 이전 규칙): `project/라이블리 웹사이트 빌드-4` 처럼 폴더명이 **프로젝트 이름**이다.
//      dev 박스에 74개(136MB) 있고 그중 **12개는 지금도 살아있는 프로젝트**다. 폴더명이 숫자가 아니라는 이유로
//      DB 조회를 건너뛰면 **살아있는 프로젝트를 '고아'로 오분류**하고, id 로 주소를 잡는 API 는 아예 못 건드린다.
//   ② **고아 폴더**: 프로젝트를 지워도 폴더는 안 지워진다. id 로 DB 를 먼저 조회하는 API 는 404 로 죽는다.
//
//  → 폴더(`project/<x>` · `legacy-project/<x>`)를 그대로 받고, **프로젝트는 폴더로 역조회**한다(있으면 라벨, 없으면 고아).
//  경로 안전은 projectAbsPath 가 강제한다(범위 이탈·`..` 탈출 차단). 여기에 **한 세그먼트**만 허용을 더 건다.
const FOLDER_RE = new RegExp(`^(?:${PROJECT_SUBDIR}|${LEGACY_SUBDIR})/[^/\\\\]+$`);

interface FolderProject { id: number; name: string; status: string | null }

// 폴더 → 프로젝트. **한 방 쿼리**다 — 예전엔 폴더마다 getV6Project 를 불러 300번씩 왕복했다(관리탭이 느렸던 이유).
async function projectsByFolder(): Promise<Map<string, FolderProject>> {
  const r = await itemsPool.query<{ id: number; name: string; status: string | null; folder: string }>(
    "SELECT id, name, status, folder FROM project WHERE folder IS NOT NULL");
  const m = new Map<string, FolderProject>();
  for (const row of r.rows) m.set(row.folder.replace(/^[/\\]+/, ""), { id: row.id, name: row.name, status: row.status });
  return m;
}

// 회수 대상 폴더 목록을 받아 계획(또는 적용)한다. analyze/reclaim 이 같은 코드를 쓰므로 **본 것과 지우는 것이 갈리지 않는다.**
async function planOrApply(
  folders: string[], user: LivelyUser, opts: { apply: boolean; removeWorktree: boolean },
): Promise<{ projects: unknown[]; total_reclaimable_bytes: number; total_freed_bytes: number }> {
  if (!Array.isArray(folders) || !folders.length) throw new HttpError(400, "folders 가 필요합니다");
  if (folders.length > 40) throw new HttpError(400, "한 번에 최대 40개까지 — 나눠서 호출하세요(오래 걸리면 프록시가 끊습니다)");
  for (const f of folders) {
    if (typeof f !== "string" || !FOLDER_RE.test(f)) {
      throw new HttpError(400, `잘못된 folder: ${String(f)} — '${PROJECT_SUBDIR}/<이름>' 또는 '${LEGACY_SUBDIR}/<이름>' 한 단계만 허용됩니다`);
    }
  }

  // 활성 세션 조회 실패 시 **회수를 중단**한다 — '활성 없음'으로 낙관하면 빌드 중인 워크트리를 깨뜨린다.
  //  (분석[dry-run]은 아무것도 안 지우므로 빈 목록으로 계속해도 안전하다.)
  let activeSessionDirs: string[] = [];
  try {
    activeSessionDirs = (await listSessions(user)).map((s) => s.dir).filter(Boolean) as string[];
  } catch {
    if (opts.apply) throw new HttpError(503, "세션 목록을 확인할 수 없어 회수를 중단합니다(작업 중인 세션을 덮어쓸 위험)");
  }

  const pmap = await projectsByFolder();
  const projects: unknown[] = [];
  let totalReclaimable = 0;
  let totalFreed = 0;
  for (const folder of folders) {
    const dir = projectAbsPath(folder); // 범위 이탈이면 여기서 400
    const p = pmap.get(folder) ?? null;
    const label = { folder, project_id: p?.id ?? null, name: p?.name ?? folder.split("/").pop(), orphan: !p, dir };
    if (!await fsp.stat(dir).then((s) => s.isDirectory()).catch(() => false)) {
      projects.push({ ...label, skipped: "워크스페이스 폴더가 없습니다" });
      continue;
    }
    const repos = await reposIn(dir);
    if (!repos.length) { projects.push({ ...label, repos: 0, reclaimable_bytes: 0, freed_bytes: 0, results: [] }); continue; }

    const results = [];
    let reclaimable = 0;
    let freed = 0;
    for (const wt of repos) {
      const plan = await planReclaim(wt, { activeSessionDirs });
      const applied = opts.apply
        ? await applyReclaim(plan, { removeWorktree: opts.removeWorktree, repoRoot: await baseRepoOf(wt) })
        : null;
      reclaimable += plan.reclaimableBytes;
      freed += applied?.freedBytes ?? 0;
      results.push({
        worktree: wt,
        reclaimable_bytes: plan.reclaimableBytes,
        derived: plan.entries.filter((e) => e.kind === "derived").map((e) => ({ path: e.rel, bytes: e.bytes })),
        active_session: plan.active_session,
        worktree_removable: plan.worktree_check.removable,
        worktree_reason: plan.worktree_check.reason,
        applied,
      });
    }
    totalReclaimable += reclaimable;
    totalFreed += freed;
    projects.push({ ...label, repos: repos.length, reclaimable_bytes: reclaimable, freed_bytes: freed, results });
  }
  return { projects, total_reclaimable_bytes: totalReclaimable, total_freed_bytes: totalFreed };
}

const FOLDERS_IN = z.array(z.string().min(1).max(300)).min(1).max(40)
  .describe("워크스페이스 폴더 (예 'project/845'·'legacy-project/612'·'project/라이블리 웹사이트 빌드-4'). 최대 40개 — GET /api/ui/org/workspace 의 folder 값을 그대로 쓴다");

const workspaceBatchCapabilities = (): Capability[] => [
  restOnly("org_workspace_analyze", "워크스페이스 일괄 분석(dry-run)",
    "주어진 폴더들의 회수 가능량을 한 번에 계산한다 — **아무것도 지우지 않는다.** " +
    "**프로젝트 id 가 아니라 폴더**로 지정하므로, DB 에서 삭제된 고아 폴더와 이름 기반 옛 폴더도 다룬다(프로젝트별 REST 는 404 로 죽는다). " +
    "⚠ 한 번에 최대 40개 — 더 많으면 나눠서 호출한다(du 가 오래 걸리면 프록시가 끊는다). admin 전용.",
    [{ method: "POST", paths: ["/api/ui/org/workspace/analyze"], parse: (req) => ({ ...(req.body ?? {}) }) }],
    async (input: { folders: string[] }, user: LivelyUser) =>
      ({ dry_run: true, ...await planOrApply(input.folders, user, { apply: false, removeWorktree: false }) }),
    { folders: FOLDERS_IN }),

  restOnly("org_workspace_reclaim", "워크스페이스 일괄 회수",
    "주어진 폴더들에서 **재생성 가능한 파생물만** 실제로 지운다(node_modules·build·target·.gradle…). " +
    "소스·커밋·.env·data/ 는 절대 지우지 않고, 활성 세션이 붙어 있으면 그 폴더는 건너뛴다. " +
    "remove_worktree=true 여도 **푸시 완료 + 더티 없음**인 워크트리만 제거한다(아니면 이유를 남기고 유지). " +
    "고아 폴더·이름 기반 옛 폴더도 회수한다. ⚠ 한 번에 최대 40개. admin 전용.",
    [{ method: "POST", paths: ["/api/ui/org/workspace/reclaim"], parse: (req) => ({ ...(req.body ?? {}) }) }],
    async (input: { folders: string[]; remove_worktree?: boolean }, user: LivelyUser) =>
      ({ dry_run: false, ...await planOrApply(input.folders, user, { apply: true, removeWorktree: !!input.remove_worktree }) }),
    {
      folders: FOLDERS_IN,
      remove_worktree: z.boolean().optional().describe("워크트리까지 제거(푸시 완료·클린일 때만 — 아니면 유지하고 이유를 남긴다)"),
    }),
];

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
      const sectionMap: Record<string, { body_md: string; version: number; sort: number; updated_at: string | null; updated_by: string | null }> = {};
      for (const s of sections) sectionMap[s.section] = { body_md: s.body_md, version: s.version, sort: s.sort, updated_at: s.updated_at, updated_by: s.updated_by };
      // 컨텍스트 온톨로지 가이드 섹션 — DB 행이 없으면(편집 전) 코드 기본 템플릿을 채워 편집기가 '현재 유효 텍스트'를 보여준다(version:0=미저장).
      //  buildKnowledgeIndex 도 같은 기본값으로 폴백하므로 화면=실주입 일치. sectionDefaults 는 '기본값 되돌리기' 버튼용.
      for (const [k, def] of Object.entries(GUIDE_SECTION_DEFAULTS)) {
        if (!sectionMap[k]) sectionMap[k] = { body_md: def, version: 0, sort: 99, updated_at: null, updated_by: null };
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
      const connectors = isAdmin ? await listConnectors() : [];
      const dbSources = isAdmin ? await listDbSources() : [];
      if (isAdmin) await refreshSources();
      const dbNames = new Set(dbSources.map((s) => s.name));
      const envSources = isAdmin
        ? listSourceConfigs().filter((s) => s.origin === "env" && !dbNames.has(s.name)).map((s) => ({ name: s.name, host: s.url ? (hostOfUrl(s.url) ?? null) : null, rls: s.rls }))
        : [];
      // runtime 권한자: 커스텀 훅·툴 목록 + 빌트인 목록 + 툴 정책(allowlist — 시크릿 아님).
      const orgHooks = isRuntime ? await listOrgHooks() : [];
      const orgHarnessAssets = isRuntime ? await listOrgHarnessAssets() : [];
      const orgAssetPrefs = isRuntime ? await listAssetPrefs() : []; // #699: 멤버 개인 오버라이드(관리탭 '일괄 조회')
      const tools = isRuntime ? await listTools() : [];
      const rc = isRuntime ? (runtimeConfig ?? await getRuntimeConfig()) : null;
      const toolPolicy = isRuntime ? { allowed_auth_envs: rc!.allowed_auth_envs, url_allowlist: rc!.url_allowlist } : null;
      // 메모리는 단일 공유 풀 — 전 구성원이 읽는 조직 지식이므로 비-admin 에도 그대로 노출(member/internal 격리 폐기).
      return {
        profile, sections: sectionMap, sectionDefaults: GUIDE_SECTION_DEFAULTS,
        writebackNoticeDefault: DEFAULT_WRITEBACK_NOTICE, // 세션종료 너지 기본값 — 웹 편집기가 표시·되돌리기에 사용
        members: memberRows, memory, tokens, runtimeConfig, mcpServers, connectors,
        dbSources: dbSources.map(maskDbSource), envSources,
        orgHooks, orgHarnessAssets, orgAssetPrefs, tools, builtins: isRuntime ? toolCandidates() : [], toolPolicy,
        meaning: MEANING, publishMeaning: PUBLISH_MEANING, canEdit: isAdmin, canRuntime: isRuntime,
      };
    }, true),

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

  // ── 온보딩 진행상황(SoT) — 웹 '온보딩' 페이지와 하네스 주입(previewMemberContext)이 같은 소스를 소비. ──
  restRead("org_onboarding", "온보딩 진행상황",
    "조직 셋업 단계별 완료 여부(회사·페르소나/카테고리/지식/구성원/데이터소스)를 라이브 계산해 반환한다(공유 — 비-admin 도 열람).",
    [{ method: "GET", paths: ["/api/ui/org/onboarding"], parse: () => ({}) }],
    async () => {
      const { computeOnboardingStatus } = await import("../org/onboarding.js");
      return await computeOnboardingStatus();
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

  // ── 프로필(표시명·게이트웨이 주소·시간대) ──
  restOnly("org_update_profile", "조직 프로필 수정",
    "조직 표시명/게이트웨이 주소/시간대를 수정한다. timezone 은 IANA 존(예 Asia/Seoul) — 스케줄러 cron 의 벽시계 기준이자 웹터미널 세션의 TZ.",
    [{ method: "POST", paths: ["/api/ui/org/profile"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const patch: { name?: string; display_name?: string; gateway_url?: string; timezone?: string } = {};
      if (input.name !== undefined) patch.name = str(input.name, "name", 200).trim();
      if (input.display_name !== undefined) patch.display_name = str(input.display_name, "display_name", 200).trim();
      if (input.gateway_url !== undefined) patch.gateway_url = str(input.gateway_url, "gateway_url", 500).trim();
      // 시간대(#778) — 저장 전 IANA 검증. 빈 값 = 기본값(DEFAULT_TZ)으로 되돌림.
      //  이 값은 cron 해석·일자 집계·세션 pane TZ 로 흘러가므로 여기가 유일한 진입 게이트다.
      if (input.timezone !== undefined) {
        const tz = str(input.timezone, "timezone", 64).trim();
        if (tz && !isValidTimezone(tz)) throw new HttpError(400, `알 수 없는 시간대입니다: '${tz}' (IANA 존 — 예: Asia/Seoul, UTC)`);
        patch.timezone = tz || DEFAULT_TZ;
      }
      return { profile: await updateOrgProfile(patch, actorOf(user), "web") };
    }),

  // ── 항상-주입 섹션(injection='always' 문서) 관리 — N개 생성/편집/삭제/재정렬 (#335). ──
  //  매 세션 컨텍스트에 sort 순으로 조립된다. 죽은 ${rules}(지식-always)·고정 3섹션 화이트리스트 폐기.
  restOnly("org_update_section", "조직 섹션 저장",
    "항상-주입 섹션(injection='always' markdown 문서)을 생성/편집한다. 신규는 sort 말미. 본문에 ${team}/${categories}/${wiki} 치환됨.",
    [{ method: "POST", paths: ["/api/ui/org/section"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const section = str(input.section, "section", 64).trim().toLowerCase();
      // 섹션 키 = knowledge.name(PK) — 슬러그(소문자·숫자·하이픈, 2–64자)만 허용.
      if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(section)) {
        throw new HttpError(400, "섹션 키는 소문자·숫자·하이픈만(2–64자) 허용됩니다");
      }
      // 이름 충돌 차단 — 같은 name 의 '일반 지식'(injection!=always)을 섹션화(덮어쓰기) 금지. 기존 섹션 편집은 OK.
      if (await sectionNameInUse(section) === "knowledge") {
        throw new HttpError(409, `'${section}' 은 이미 일반 지식 이름입니다 — 다른 섹션 키를 쓰세요`);
      }
      const body = str(input.body_md ?? "", "body_md", 60000);
      // 항상-주입 비용 가드 — 섹션은 매 세션 전문이 실린다. 32KiB 초과 차단(과편집·본문 오입력 방지).
      if (Buffer.byteLength(body, "utf8") > 32 * 1024) {
        throw new HttpError(400, "섹션이 너무 깁니다(32KiB 초과) — 항상-주입 문서는 짧게 유지하세요");
      }
      assertNoHardSecrets(body, "body_md"); // P8: 섹션은 합성 컨텍스트에 항상 실린다 — 평문 시크릿 hard-block(ctx_save 와 동일 choke-point)
      return { section: await updateSection(section, body, actorOf(user), "web") };
    }),

  // ── 섹션 삭제 — 감사 스냅샷 보존(복원가능). 기본 문서(context-ontology-guide 등)도 삭제 가능 — UI 가 경고/확인. ──
  restOnly("org_delete_section", "조직 섹션 삭제",
    "항상-주입 섹션을 삭제한다(감사 스냅샷으로 보존 — content_restore 복원가능).",
    [{ method: "POST", paths: ["/api/ui/org/section/delete"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const section = str(input.section, "section", 64);
      return { deleted: await deleteSection(section, actorOf(user), "web") };
    }),

  // ── 섹션 주입 순서 — sort 일괄 설정(orderedNames 순서 = 조립 순서). ──
  restOnly("org_reorder_sections", "조직 섹션 순서",
    "항상-주입 섹션의 주입 순서(sort)를 일괄 설정한다(order 배열 순서대로).",
    [{ method: "POST", paths: ["/api/ui/org/sections/order"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const order = Array.isArray(input.order) ? input.order.map((x) => String(x)) : [];
      if (!order.length) throw new HttpError(400, "order 배열이 필요합니다");
      await setSectionsOrder(order, actorOf(user), "web");
      return { ok: true };
    }),

  // ── 구성원 upsert/remove ──
  restOnly("org_member_upsert", "구성원 추가·수정",
    "구성원 신원(표시명·이메일·외부계정 연결·개인레이어)을 저장한다. person/person_identity 로도 동기화.",
    [{ method: "POST", paths: ["/api/ui/org/member"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const kind = input.kind == null ? undefined : str(input.kind, "kind", 10) as "human" | "agent" | "system";
      if (kind && !["human", "agent", "system"].includes(kind)) throw new HttpError(400, "kind 는 human|agent|system");
      const displayName = input.display_name == null ? undefined : str(input.display_name, "display_name", 200).trim();
      // 이메일 = 로그인 아이디 → 형식 검증(생성·로그인 일관). 빈 값은 허용(로그인 불요 멤버 — 계정 미발급).
      const email = input.email == null ? undefined : str(input.email, "email", 200).trim();
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
      const memberBody = input.body_md == null ? undefined : str(input.body_md, "body_md", 20000);
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
      // 신원 '해제' 동기(#541) — identities 에서 뺀 행은 person_identity 에서도 지워야 커넥터 액터/어사이니
      //  해소(person_identity JOIN org_member)에 실제 반영된다(syncMemberToPerson 은 upsert-only 라 잔존).
      //  가드: 이 멤버 소유(person_id=id) + origin IN (manual, email-join) — 수동 매핑과 그로부터 파생된 이메일
      //  자동조인 행까지 함께 제거(email-join 잔존 시 해제가 무효 — 다음 싱크가 재매핑). observed 신원은 보존.
      if (existed && input.identities !== undefined) {
        const keep = new Set(member.identities.map((i) => `${i.system}\u0000${i.external_id}`));
        for (const prev of existed.identities) {
          if (keep.has(`${prev.system}\u0000${prev.external_id}`)) continue;
          const del = await itemsPool.query(
            `DELETE FROM person_identity WHERE system=$1 AND external_id=$2 AND person_id=$3 AND origin IN ('manual','email-join')`,
            [prev.system, prev.external_id, id]);
          if ((del.rowCount ?? 0) > 0) {
            await itemsPool.query(
              `INSERT INTO person_identity_audit(action, person_id, system, external_id, detail, source)
               VALUES('identity-unbound',$1,$2,$3,$4::jsonb,'web')`,
              [id, prev.system, prev.external_id, JSON.stringify({ email: prev.email ?? null, actor: actorOf(user) })]);
          }
        }
      }
      // #697 매핑 소급 — clickup 신원 매핑(person_identity)이 **실제로 바뀌었을 때만**, 이미 미러된 데이터(어사이니/
      //  작성자/멤버)의 raw 값을 방금 갱신된 매핑으로 재해소한다(관리탭 매핑을 과거 미러에 즉시 반영 — 증분 싱크가
      //  미변경 태스크를 재수집 안 해 생기던 소급 누락 수정). 가드가 '변경 시에만'이라 display_name/scopes 만 바꾼
      //  저장에는 안 돈다(full sweep 비용 회피). 재해소는 raw→member_id 단방향이라 해제 시 기존 치환을 되돌리진
      //  않는다(다음 미러가 raw 재도입, 다음 싱크가 수렴). best-effort — 실패해도 매핑 저장은 성립(healPmMirror 가
      //  동일 함수로 수렴). PM 미러 대상 = 현재 clickup 만.
      const cuKey = (idns: MemberIdentity[]): string =>
        idns.filter((i) => i.system === "clickup").map((i) => `${i.external_id}|${i.email ?? ""}`).sort().join(",");
      if (input.identities !== undefined && cuKey(member.identities) !== cuKey(existed?.identities ?? [])) {
        const rc = await itemsPool.connect();
        try {
          const rr = await reresolveMirrorMembers(rc, "clickup");
          if (rr.assignee || rr.surfaces) logger.info({ member: id, ...rr }, "#697 매핑 소급 재해소");
        } catch (e) {
          logger.warn({ err: (e as Error)?.message ?? String(e) }, "#697 재해소 실패(무시 — 다음 싱크 수렴)");
        } finally { rc.release(); }
      }
      // 신규 human 멤버 → 로컬 로그인 계정 자동 발급(초기 비번 1회 반환 — 관리자가 멤버에게 전달).
      //  로그인이 이메일 기준이라 **유효 이메일이 있을 때만** 발급(없으면 못 쓰는 계정 → 발급 안 함).
      //  agent/system·기존 멤버·이미 계정 있음도 제외.
      let initialPassword: string | undefined;
      if (!existed && member.kind === "human" && member.email && !(await hasCredential(id))) {
        initialPassword = generateInitialPassword();
        await setMemberPassword(id, initialPassword, { mustChange: true, actor: actorOf(user) });
      }
      return { member, initialPassword };
    }, {
      id: z.string().optional().describe("멤버 id(불변 내부키) — 생략 시 이메일 로컬파트에서 자동 생성"),
      kind: z.enum(["human", "agent", "system"]).optional().describe("멤버 종류(기본 human)"),
      display_name: z.string().optional().describe("표시 이름"),
      email: z.string().optional().describe("이메일=로그인 아이디. 신규 human 이면 초기 비번 자동 발급(initialPassword 1회 반환)"),
      identities: z.array(z.object({ system: z.string(), external_id: z.string(), email: z.string().optional(), instance: z.string().optional(), display_name: z.string().optional() })).optional().describe("외부 계정 연결(slack/clickup 등)"),
      body_md: z.string().optional().describe("개인 레이어(세션 컨텍스트에 실림)"),
      state: z.enum(["active", "inactive"]).optional(),
      scopes: z.array(z.string()).optional().describe("권한 scope: items|context|memory|db|code|admin|runtime"),
      sort: z.number().optional(),
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

  // (레거시 org_memory 쓰기 엔드포인트 org_memory_upsert/org_memory_remove 는 #536 에서 제거 —
  //  knowledge_* 로 대체된 죽은 표면. 읽기(listMemory→org_overview)와 store.upsertMemory(migrate 임포트)는 유지.)

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
    }, {
      userId: z.string().optional().describe("토큰 주인 멤버 id(생략 시 memberId)"),
      memberId: z.string().optional().describe("연결할 멤버 id — 유효권한=intersection(토큰scope, 멤버 LIVE scope)"),
      scopes: z.array(z.string()).optional().describe("토큰 scope(생략 시 멤버 scope): items|context|memory|db|code|admin|runtime"),
      label: z.string().optional().describe("토큰 라벨(용도 메모)"),
    }),

  // ── 본인 토큰 자가발급(설치 탭) — 인증된 구성원이 자기 토큰을 만든다. admin 불요. ──
  // userId 는 principal 에서 강제(타인 발급 불가), scope 는 본인 member.scopes(없으면 현재 scope) — 상승 불가.
  restRead("org_token_mint_self", "본인 토큰 발급",
    "현재 로그인한 구성원이 본인 설치 토큰을 발급한다(설치/재설치용). userId·scope 는 principal 로 고정. includeControlPlane=true 면 관리 권한(admin/runtime)도 싣는다 — 상한은 멤버 LIVE scope ∩ 제시 토큰(증폭 불가).",
    [{ method: "POST", paths: ["/api/ui/org/token/self"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      // 자가발급은 회수 가능한 DB 토큰만 만든다 — 회수 불가한 정적 토큰으로는 금지(킬스위치 세탁 방지).
      //  (scope-null capability 라 web.ts 의 B3/B5 게이트가 안 걸린다 → 여기서 직접 차단.)
      if (user.tokenSource === "static") throw new HttpError(403, "정적 토큰으로는 자가발급할 수 없습니다 — 관리자에게 발급을 요청하세요");
      const mem = await getMember(userId);
      const presented = Array.isArray(user.scopes) ? user.scopes : [];
      const base = mem?.scopes?.length ? mem.scopes : presented;
      // 설치용 토큰 — 기본은 admin/runtime 제외(최소권한). #632: 로컬 세션 에이전트가 관리 기능(MCP org_*)을 쓰려면
      //  includeControlPlane opt-in 시 admin/runtime 도 싣는다 — 중앙박스 프로비저닝 opt-in(#549)의 self-mint 대응.
      //  상한은 언제나 멤버 LIVE scope ∩ 제시 토큰(presented): 둘 다 가진 scope 만 실려 증폭 불가.
      //  멤버 강등 시 verifyDbToken 이 매 호출 intersection 으로 즉시 무효(회수의 진짜 지점 = 멤버 scope). 발급은 감사에 남는다.
      const includeControlPlane = input?.includeControlPlane === true;
      const scopes = base.filter((s) => SCOPES_ALLOWED.has(s) && presented.includes(s)
        && (includeControlPlane || !DANGEROUS_SCOPES.has(s as Scope)));
      const withControlPlane = scopes.some((s) => DANGEROUS_SCOPES.has(s as Scope));
      const { token } = await mintToken(
        { userId, scopes, label: (mem?.display_name || userId) + (withControlPlane ? " (self +admin)" : " (self)"), memberId: userId },
        actorOf(user), "web-self");
      return { token, scopes, userId };
    }),

  // ── 본인 프로필 셀프 편집(우측 상단 '내 프로필') — 인증된 구성원이 자기 표시이름·개인레이어를 직접 수정. admin 불요. ──
  //  id 는 principal 에서 강제(타인 편집 불가). 표시이름·개인레이어(body_md)만 — 권한·이메일·상태·신원·kind 는 admin 전용(불변).
  restRead("me_profile_get", "내 프로필 조회",
    "현재 로그인한 구성원의 본인 프로필(표시이름·이메일·개인레이어)을 반환한다 — 우측 상단 '내 프로필' 모달용.",
    [{ method: "GET", paths: ["/api/ui/me/profile"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const m = await getMember(userId);
      // 이메일은 표시 전용(읽기) — 셀프 편집 대상 아님. 멤버행이 없어도 모달은 열리게 안전 폴백.
      return { id: userId, display_name: m?.display_name ?? null, email: m?.email ?? user.email ?? null, body_md: m?.body_md ?? "", avatar: m?.avatar ?? null, avatar_char: m?.avatar_char ?? null, avatar_color: m?.avatar_color ?? null };
    }),

  restRead("me_profile_update", "내 프로필 수정",
    "현재 로그인한 구성원이 본인 표시이름·개인레이어(body_md)를 직접 수정한다. id 는 principal 강제, 권한·이메일·상태·신원·kind 는 불변(admin 전용).",
    [{ method: "POST", paths: ["/api/ui/me/profile"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      // 셀프 편집은 기존 구성원행만 수정 — 없으면 생성하지 않는다(기본권한 멤버 자가생성 차단).
      const existing = await getMember(userId);
      if (!existing) throw new HttpError(404, "구성원 정보를 찾을 수 없습니다 — 관리자에게 문의하세요");
      // 표시이름: 미전송이면 보존(undefined), 빈 문자열이면 비우기.
      const displayName = input.display_name == null ? undefined : str(input.display_name, "display_name", 200).trim();
      // 개인레이어(body_md)는 합성 컨텍스트에 실리는 자유텍스트 — 평문 시크릿 hard-block(ctx_save 와 동일 choke-point).
      const memberBody = input.body_md == null ? undefined : str(input.body_md, "body_md", 20000);
      if (memberBody !== undefined) assertNoHardSecrets(memberBody, "body_md"); // P8
      // 아바타 — data:image data URL(클라이언트 128px 리사이즈). undefined=보존, null/''=이니셜로 되돌림.
      let avatar: string | null | undefined;
      if (input.avatar !== undefined) {
        const raw = input.avatar === null ? "" : str(input.avatar, "avatar", 300000).trim();
        if (raw && !/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(raw)) {
          throw new HttpError(400, "이미지 형식이 올바르지 않습니다 (png·jpg·webp·gif)");
        }
        if (raw.length > 256 * 1024) throw new HttpError(400, "이미지가 너무 큽니다 — 더 작게 잘라 올려주세요");
        avatar = raw || null;
      }
      // 커스텀 글자·배경색(이미지 없을 때 폴백). undefined=보존, null/''=자동으로 되돌림. 값 정규화(글자 3자·색 #rrggbb만)는 upsertMember 가 담당.
      const avatarChar = input.avatar_char === undefined ? undefined : (input.avatar_char === null ? null : str(input.avatar_char, "avatar_char", 8).trim());
      const avatarColor = input.avatar_color === undefined ? undefined : (input.avatar_color === null ? null : str(input.avatar_color, "avatar_color", 32).trim());
      // id 만 principal 로 강제 — 그 외(권한·이메일·상태·신원·kind)는 넘기지 않아 upsertMember 가 전부 보존.
      const member = await upsertMember({ id: userId, display_name: displayName, body_md: memberBody, avatar, avatar_char: avatarChar, avatar_color: avatarColor }, actorOf(user), "web-self");
      return { member: { id: member.id, display_name: member.display_name, email: member.email, body_md: member.body_md, avatar: member.avatar, avatar_char: member.avatar_char, avatar_color: member.avatar_color } };
    }),

  // ── CLI 디바이스 로그인 승인 (#880) — 브라우저에서 CLI 를 승인한다. lookup/approve/deny. ──
  //  ⚠ 정적 토큰 금지(회수불가 → self-mint 세탁 방지, delivery token/self 와 동형). 세션·회수가능 db 토큰만.
  //  scope-null capability 라 web.ts B3/B5 게이트가 안 걸린다 → 여기서 tokenSource·rate-limit 직접 강제.
  restRead("device_lookup", "디바이스 승인 대기 조회",
    "user_code 로 승인 대기 중인 CLI 로그인 요청을 조회한다(승인 화면 표시용). pending·미만료만.",
    [{ method: "GET", paths: ["/api/ui/cli/device/lookup"], parse: (req) => ({ code: (req.query?.code ?? "") }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
      if (user.tokenSource === "static") throw new HttpError(403, "정적 토큰으로는 승인할 수 없습니다");
      if (!checkDeviceRate(user.userId)) throw new HttpError(429, "요청이 너무 잦습니다 — 잠시 후 다시 시도하세요");
      const r = await lookupDeviceAuth(String(input.code ?? ""));
      if (!r) throw new HttpError(404, "해당 코드의 대기 중인 로그인이 없습니다(만료됐거나 잘못된 코드).");
      return r;
    }),

  restRead("device_approve", "디바이스 로그인 승인",
    "브라우저에서 CLI 로그인을 승인한다. member_id·scope 는 principal 강제. include_control_plane=true(관리권한 포함)는 비밀번호 재확인(step-up) 필요.",
    [{ method: "POST", paths: ["/api/ui/cli/device/approve"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
      if (user.tokenSource === "static") throw new HttpError(403, "정적 토큰으로는 승인할 수 없습니다");
      if (!checkDeviceRate(user.userId)) throw new HttpError(429, "요청이 너무 잦습니다 — 잠시 후 다시 시도하세요");
      const userCode = str(input.user_code, "user_code", 20);
      const includeControlPlane = input.include_control_plane === true;
      // step-up: control-plane 을 실제로 실을 수 있는 멤버(위험 scope 보유)만 비밀번호 재확인. 비번 없는 멤버
      //  (프로비저닝·향후 SSO)는 세션 자체가 신선도 증거 → 통과(비번을 유일 게이트로 두면 잠김, 설계 R2-F3).
      const memberScopes = Array.isArray(user.scopes) ? user.scopes : [];
      const hasDangerous = memberScopes.some((s) => DANGEROUS_SCOPES.has(s as Scope));
      if (includeControlPlane && hasDangerous && await hasCredential(user.userId)) {
        const pw = typeof input.password === "string" ? input.password : "";
        if (!pw || !(await verifyOwnPassword(user.userId, pw))) {
          throw new HttpError(403, "관리 권한 포함 승인은 비밀번호 재확인이 필요합니다.");
        }
      }
      const ok = await approveDeviceAuth(userCode, user.userId, memberScopes, includeControlPlane);
      if (!ok) throw new HttpError(410, "이미 처리됐거나 만료된 코드입니다.");
      return { ok: true };
    }),

  restRead("device_deny", "디바이스 로그인 거부",
    "브라우저에서 CLI 로그인 요청을 거부한다.",
    [{ method: "POST", paths: ["/api/ui/cli/device/deny"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
      if (user.tokenSource === "static") throw new HttpError(403, "정적 토큰으로는 거부할 수 없습니다");
      if (!checkDeviceRate(user.userId)) throw new HttpError(429, "요청이 너무 잦습니다 — 잠시 후 다시 시도하세요");
      await denyDeviceAuth(str(input.user_code, "user_code", 20));
      return { ok: true };
    }),

  // ── 내 온보딩 현황 (#846/850) — 웹 #/start 페이지와 AI 스킬이 **같은 함수**를 읽는다(드리프트 0). ──
  //  ⚠ 상태의 SoT 는 computeMemberOnboarding 이지 화면이 아니다. 화면은 진입·완주 표면일 뿐.
  //  자동 판정(MCP 호출 이력·자격·레포)은 조회 시점 라이브 계산 — 보고로 거짓 완료를 만들 수 없다.
  restRead("me_onboarding_get", "내 온보딩 현황 조회",
    "현재 로그인한 구성원의 온보딩 진행 상태를 반환한다 — 스텝별 done/todo/skipped + 필수 여부 + 자동판정 여부 + 딥링크. 웹 온보딩 페이지와 AI 온보딩 스킬이 이 하나를 함께 읽는다.",
    [{ method: "GET", paths: ["/api/ui/me/onboarding"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { computeMemberOnboarding } = await import("../org/onboarding.js");
      return { status: await computeMemberOnboarding(userId) };
    }),

  restRead("me_onboarding_set", "내 온보딩 스텝 보고",
    "온보딩 스텝의 상태를 보고한다. **주 사용자는 AI 온보딩 스킬**이다 — 서버가 볼 수 없는 로컬 작업(예: 예전 AI 환경 이관)을 마치면 done 으로, 이관할 게 없으면 skipped 로 보고한다. 사용자가 웹에서 의도적으로 마킹할 때도 같은 경로를 쓴다. state: done|skipped|reset(reset=보고 취소 → 자동 판정으로 복귀). ⚠ 자동 판정되는 스텝은 실제 신호가 이기므로 보고로 거짓 완료를 만들 수 없다.",
    [{ method: "POST", paths: ["/api/ui/me/onboarding"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { isMemberStep, MEMBER_STEPS, computeMemberOnboarding } = await import("../org/onboarding.js");
      const step = str(input.step, "step", 32).trim();
      if (!isMemberStep(step)) throw new HttpError(400, `step 은 ${MEMBER_STEPS.join("|")} 중 하나여야 합니다`);
      const state = str(input.state, "state", 12).trim();
      if (!["done", "skipped", "reset"].includes(state)) throw new HttpError(400, "state 는 done|skipped|reset 만 허용됩니다");
      const note = input.note == null ? undefined : (str(input.note, "note", 500).trim() || undefined);
      if (note) assertNoHardSecrets(note, "note"); // 보고 메모도 멤버 레코드에 남으므로 평문 시크릿 차단
      // by 는 표시용(누가 채웠는지) — 위조해도 무해하다. 기본은 self, 스킬이 ai 로 보낸다.
      const by = input.by === "ai" ? "ai" as const : "self" as const;
      const { setMemberOnboardingStep } = await import("../org/store.js");
      await setMemberOnboardingStep(userId, step,
        state === "reset" ? null : { state: state as "done" | "skipped", at: new Date().toISOString(), by, note });
      return { status: await computeMemberOnboarding(userId) }; // 갱신된 현황을 바로 돌려준다(왕복 1회)
    }),

  // ── 내 스킬·훅 셀프 설정 (#699) — 인증된 멤버가 본인에게 배포되는 스킬·훅을 보고 본인 것만 opt-in/out. admin 불요(principal 강제). ──
  //  관리자 정책(enabled+target_members)이 기본값, 멤버는 본인 오버라이드로 조정. 자산은 시크릿이 아니라 발견/배포 대상 — 본인 opt-in 은 자기 세션에만 영향(안전).
  restRead("me_assets_get", "내 스킬·훅 조회",
    "현재 로그인한 구성원에게 배포되는 스킬·훅 목록과, 관리자 기본값 대비 본인 오버라이드 상태(effective/override/byDefault)를 반환한다 — 멤버 셀프 설정 화면용.",
    [{ method: "GET", paths: ["/api/ui/me/assets"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const [assets, hooks, prefs] = await Promise.all([listOrgHarnessAssets(), listOrgHooks(), listAssetPrefs({ member_id: userId })]);
      const prefMap = new Map(prefs.map((p) => [`${p.target_kind}:${p.ref_id}`, p.state]));
      const meta = (kind: AssetPrefKind, id: string, targetMembers: string[] | null) => {
        const key = `${kind}:${id}`;
        const override = prefMap.has(key) ? (prefMap.get(key) as boolean) : null; // null=오버라이드 없음(관리자 기본값)
        const byDefault = targetsMember(targetMembers, userId);
        // enabled 은 이미 필터됨(아래 .filter) → 유효성 = 오버라이드 우선, 없으면 기본값. store SQL CASE 와 동일 규칙.
        return { override, byDefault, effective: effectiveVisible({ enabled: true, targetMembers, memberId: userId, override }) };
      };
      return {
        skills: assets.filter((a) => a.enabled).map((a) => ({ id: a.id, kind: a.kind, label: a.label, description: a.description, harness: a.harness, paired_hook_id: a.paired_hook_id, ...meta("harness_asset", a.id, a.target_members) })),
        hooks: hooks.filter((h) => h.enabled).map((h) => ({ id: h.id, label: h.label, event: h.event, matcher: h.matcher, note: h.note, harness: h.harness, ...meta("org_hook", h.id, h.target_members) })),
      };
    }),
  restRead("me_asset_pref_set", "내 스킬·훅 설정",
    "현재 로그인한 구성원이 본인의 스킬/훅 개인 오버라이드를 on/off(state) 하거나 해제(clear=true=관리자 기본값 복귀)한다. member_id 는 principal 강제(타인 설정 불가). 없는/비활성 자산엔 불가(고아 방지).",
    [{ method: "POST", paths: ["/api/ui/me/asset-pref"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      if (user.tokenSource === "static") throw new HttpError(403, "정적 토큰으로는 설정할 수 없습니다 — 관리자에게 문의하세요");
      const targetKind = assertPrefKind(input.target_kind);
      const refId = targetKind === "org_hook" ? assertHookId(input.ref_id) : assertAssetId(input.ref_id);
      const exists = targetKind === "org_hook" ? await getOrgHook(refId) : await getOrgHarnessAsset(refId);
      if (!exists || exists.enabled === false) throw new HttpError(404, "대상 스킬/훅이 없거나 비활성입니다");
      const wc = { actor: actorOf(user), source: "web-self" };
      if (input.clear === true) { await clearAssetPref(targetKind, refId, userId, wc); return { ok: true, cleared: true }; }
      const pref = await setAssetPref(targetKind, refId, userId, Boolean(input.state), wc);
      return { pref };
    }),

  // ── 로컬 하네스 관측(#891 온보딩 C) — 세션훅 채널로 로컬↔라이블리 하네스를 웹에서 한눈에. 노드 불요. ──
  //  ⚠ 인벤토리는 **메타만**(id·kind·managed) — 스킬 본문·메모리는 서버로 안 온다(사생활·용량). 관측이지 보고 아님.
  restRead("me_harness_report", "로컬 하네스 인벤토리 보고(세션훅)",
    "멤버 세션훅(session-preload)이 매 세션 로컬 하네스 자산 메타(id·kind·managed 여부)를 push 한다. 서버는 마지막 관측만 보관하고 웹이 라이블리 자산과 대조한다. 스킬 본문·메모리 내용은 담지 않는다(hard).",
    [{ method: "POST", paths: ["/api/ui/me/harness-report"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const rawAssets = Array.isArray(input.assets) ? input.assets : [];
      if (rawAssets.length > 500) throw new HttpError(400, "자산이 너무 많습니다(500 초과)"); // 스캐너 폭주 가드
      const KINDS = new Set(["skill", "subagent", "command", "hook"]);
      const seen = new Set<string>();
      const assets = [] as { id: string; kind: string; managed: boolean }[];
      for (const a of rawAssets as Record<string, unknown>[]) {
        const id = str(a?.id ?? "", "asset.id", 64).trim();
        const kind = str(a?.kind ?? "", "asset.kind", 12).trim();
        if (!id || !KINDS.has(kind)) continue;                 // 모르는 종류·빈 id 는 조용히 스킵(관측이라 관대)
        const key = `${kind}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        assets.push({ id, kind, managed: Boolean(a?.managed) });
      }
      const snap = {
        at: new Date().toISOString(),
        host: input.host == null ? undefined : str(input.host, "host", 200).trim() || undefined,
        harness: input.harness === "codex" ? "codex" : "claude",
        assets,
      };
      const { setHarnessSnapshot } = await import("../org/store.js");
      await setHarnessSnapshot(userId, snap);
      return { ok: true, count: assets.length };
    }),

  restRead("me_harness_get", "내 하네스 한눈에(로컬+라이블리)",
    "라이블리가 배포하는 하네스 자산(me_assets)과 이 멤버 노트북의 로컬 관측 스냅샷을 함께 반환하고, 겹치는 것을 대조한다 — 웹 '내 하네스' 화면용. overlap: managed(라이블리가 깐 것) · shadow(로컬 동명 파일이 라이블리 자산을 가림).",
    [{ method: "GET", paths: ["/api/ui/me/harness"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { getHarnessSnapshot } = await import("../org/store.js");
      const [assets, hooks, prefs, snap] = await Promise.all([
        listOrgHarnessAssets(), listOrgHooks(), listAssetPrefs({ member_id: userId }), getHarnessSnapshot(userId),
      ]);
      const prefMap = new Map(prefs.map((p) => [`${p.target_kind}:${p.ref_id}`, p.state]));
      const meta = (kind: AssetPrefKind, id: string, targetMembers: string[] | null) => {
        const override = prefMap.has(`${kind}:${id}`) ? (prefMap.get(`${kind}:${id}`) as boolean) : null;
        return { override, effective: effectiveVisible({ enabled: true, targetMembers, memberId: userId, override }) };
      };
      // 라이블리가 이 멤버에게 배포하는(effective) 자산 id 집합 — 로컬 대조의 기준.
      const lively = {
        skills: assets.filter((a) => a.enabled).map((a) => ({ id: a.id, kind: a.kind, label: a.label, description: a.description, harness: a.harness, ...meta("harness_asset", a.id, a.target_members) })),
        hooks: hooks.filter((h) => h.enabled).map((h) => ({ id: h.id, label: h.label, harness: h.harness, ...meta("org_hook", h.id, h.target_members) })),
      };
      const livelyIds = new Set<string>([...lively.skills, ...lively.hooks].map((x) => x.id));
      // 로컬 관측과 대조: 같은 id 가 라이블리에도 있으면 겹침 — managed 면 정상(라이블리가 깐 것), non-managed 면 shadow(가림).
      const local = (snap?.assets ?? []).map((a) => {
        const overlapLively = livelyIds.has(a.id);
        return { ...a, overlap: overlapLively ? (a.managed ? "managed" : "shadow") : "local-only" };
      });
      return {
        lively,
        local: { assets: local, at: snap?.at ?? null, host: snap?.host ?? null, harness: snap?.harness ?? null, observed: !!snap },
      };
    }),

  // ── git 자격(#540) — 레포 클론·세션 git 용 SSH/HTTPS 자격. 본인 자가등록(me/*, 인증만) + 게이트웨이 머신계정(org/*, admin). ──
  //  provision 클론은 요청 멤버 자격(없으면 gateway)을 주입, 세션 안 git 은 멤버 자격을 멤버 홈에 materialize(Slice 2).
  restRead("me_git_credential_get", "내 git 인증 조회",
    "현재 로그인한 구성원의 등록된 git 자격(호스트·종류·SSH 공개키·존재 플래그)을 반환한다 — 시크릿(개인키·토큰)은 절대 반환하지 않는다.",
    [{ method: "GET", paths: ["/api/ui/me/git-credential"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      return { credentials: await listGitCredentialsPublic(memberOwner(userId)), encryption_ready: secretsEnabled() };
    }),
  restRead("me_git_credential_set", "내 git 인증 등록",
    "본인 git 자격을 등록한다. kind=ssh 면 박스가 키페어를 생성해 공개키를 반환(개인키는 박스밖 유출 없음), kind=https 면 토큰을 저장. host 기본 github.com.",
    [{ method: "POST", paths: ["/api/ui/me/git-credential"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      return applyGitCredential(memberOwner(userId), input, actorOf(user));
    }),
  restRead("me_git_credential_delete", "내 git 인증 삭제",
    "본인 git 자격을 삭제한다(host 지정, 기본 github.com).",
    [{ method: "POST", paths: ["/api/ui/me/git-credential/delete"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      return { deleted: await deleteGitCredential(memberOwner(userId), parseGitHost(input)) };
    }),
  restOnly("org_git_credential_get", "게이트웨이 git 계정 조회",
    "게이트웨이(조직 머신 계정) git 자격을 조회한다 — provision 클론에서 멤버 자격이 없을 때 폴백으로 쓰인다. 시크릿은 반환하지 않는다.",
    [{ method: "GET", paths: ["/api/ui/org/git-credential"], parse: () => ({}) }],
    async (_input: unknown, _user: LivelyUser) => ({ credentials: await listGitCredentialsPublic(GATEWAY_OWNER), encryption_ready: secretsEnabled() })),
  restOnly("org_git_credential_set", "게이트웨이 git 계정 등록",
    "게이트웨이(조직 머신 계정) git 자격을 등록한다. kind=ssh 면 박스가 키페어 생성·공개키 반환, kind=https 면 토큰 저장.",
    [{ method: "POST", paths: ["/api/ui/org/git-credential"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => applyGitCredential(GATEWAY_OWNER, input, actorOf(user))),
  restOnly("org_git_credential_delete", "게이트웨이 git 계정 삭제",
    "게이트웨이 git 자격을 삭제한다(host 지정, 기본 github.com).",
    [{ method: "POST", paths: ["/api/ui/org/git-credential/delete"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, _user: LivelyUser) => ({ deleted: await deleteGitCredential(GATEWAY_OWNER, parseGitHost(input)) })),

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
      // kit_version(#858) — 현재 서빙 중인 설치 번들의 지문. session-preload 가 로컬 ~/.lively/kit-version 과
      //  비교해 다르면 백그라운드 재설치를 띄운다(키트 코드·배선 자동 갱신 — 멤버 수동 업데이트 폐지).
      //  이미 매 세션 오는 응답에 얹으므로 왕복이 늘지 않는다. 계산 실패 시 null → 멤버는 아무것도 안 한다(fail-safe).
      const kv = await kitVersion();
      // 너지 '유효값' 서빙(#270): 어드민 오버라이드가 없으면 서버 단일소스 DEFAULT_WRITEBACK_NOTICE 를 fold 해 준다.
      //  → session-preload 가 이 값을 매 세션 ~/.lively/hooks-config.json 에 기록 → 게이트가 라이브로 사용
      //  (설치 .mjs 의 REASON 은 게이트웨이 영영 불가 시의 last-resort 스텁일 뿐). 재설치 없이 너지가 갱신된다.
      //  주의: 이 fold 는 '훅 서빙' 응답에만 적용 — 어드민 편집기는 data.runtimeConfig(원본 override, null=미설정)
      //  + writebackNoticeDefault 를 별도로 받으므로 override↔default 구분이 깨지지 않는다.
      return { hooks: c.hooks, writeback_notice: c.writeback_notice || DEFAULT_WRITEBACK_NOTICE, write_tools: c.write_tools, auto_approve: autoApprove, kit_version: kv };
    }),
  restOnly("org_runtime_update", "런타임 설정 수정",
    "훅 활성/비활성·work-roots·writeback 너지 + 안전 화이트리스트(allowed_auth_envs·url_allowlist·allowed_db_hosts·allowed_db_secret_refs)를 저장한다.",
    [{ method: "POST", paths: ["/api/ui/org/runtime-config"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const patch: {
        hooks?: Record<string, boolean>; writeback_notice?: string | null; work_roots?: string[];
        allowed_auth_envs?: string[]; url_allowlist?: string[]; allowed_db_hosts?: string[];
        allowed_internal_hosts?: string[];
        allowed_db_secret_refs?: string[]; write_tools?: string[];
        embedding_config?: EmbeddingConfigPatch;
        storage_policy?: StoragePolicyPatch;
      } = {};
      // 저장소 정책(#813) — 로그 상한·디스크 임계치. 잡값·뒤집힌 임계치(경고≥위험)는 normalize 가 잡는다.
      //  고객 박스는 .env 를 못 고치므로 **여기(관리탭)가 유일한 조절 창구**다.
      if (input.storage_policy !== undefined) {
        const raw = input.storage_policy;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "storage_policy 는 객체여야 합니다");
        const s = raw as Record<string, unknown>;
        const num = (v: unknown, field: string, min: number, max: number): number => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `storage_policy.${field} 는 ${min}~${max} 정수여야 합니다`);
          return Math.floor(n);
        };
        const patchIn: StoragePolicyPatch = {};
        if (s.log_max_mb !== undefined) patchIn.log_max_mb = num(s.log_max_mb, "log_max_mb", 0, 10_000);
        if (s.log_keep !== undefined) patchIn.log_keep = num(s.log_keep, "log_keep", 0, 50);
        if (s.disk_warn_pct !== undefined) patchIn.disk_warn_pct = num(s.disk_warn_pct, "disk_warn_pct", 1, 99);
        if (s.disk_critical_pct !== undefined) patchIn.disk_critical_pct = num(s.disk_critical_pct, "disk_critical_pct", 1, 100);
        if (s.shared_cache_enabled !== undefined) patchIn.shared_cache_enabled = Boolean(s.shared_cache_enabled);
        if (s.shared_cache_relocate_home !== undefined) patchIn.shared_cache_relocate_home = Boolean(s.shared_cache_relocate_home);
        // 경고 ≥ 위험은 사용자가 의도한 설정일 리 없다 — 조용히 고치지 말고 왜 안 되는지 알려준다.
        const merged = normalizeStoragePolicy({ ...(await getRuntimeConfig()).storage_policy, ...patchIn });
        if (patchIn.disk_warn_pct !== undefined && patchIn.disk_warn_pct >= merged.disk_critical_pct) {
          throw new HttpError(400, `경고 임계치(${patchIn.disk_warn_pct}%)는 위험 임계치(${merged.disk_critical_pct}%)보다 낮아야 합니다`);
        }
        patch.storage_policy = patchIn;
      }
      if (input.hooks !== undefined) {
        const h = input.hooks;
        if (typeof h !== "object" || h === null || Array.isArray(h)) throw new HttpError(400, "hooks 는 객체여야 합니다");
        patch.hooks = {};
        for (const k of ["session_preload", "work_flag", "stop_writeback_gate", "self_update"]) {
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
      // MCP 프록시가 접속 가능한 내부(사설/localhost) host 화이트리스트(#746 T1) — 기본 deny-all, 여기 명시한 host 만 SSRF 면제.
      if (input.allowed_internal_hosts !== undefined) {
        if (!Array.isArray(input.allowed_internal_hosts)) throw new HttpError(400, "allowed_internal_hosts 는 배열이어야 합니다");
        patch.allowed_internal_hosts = input.allowed_internal_hosts.map((h) => str(h, "allowed_internal_hosts[]", 200).trim().toLowerCase()).filter(Boolean);
      }
      // db 소스 auth_ref 가 참조할 수 있는 비번 env '이름' 화이트리스트(#715 배선 — store 엔 있었으나 REST 입력이 없어
      //  외부(비번 필요) 소스 등록이 불가능했다). allowed_auth_envs 와 동일한 env 이름 형식 검증. 값이 아니라 이름만.
      if (input.allowed_db_secret_refs !== undefined) {
        if (!Array.isArray(input.allowed_db_secret_refs)) throw new HttpError(400, "allowed_db_secret_refs 는 배열이어야 합니다");
        patch.allowed_db_secret_refs = input.allowed_db_secret_refs.map((e) => str(e, "allowed_db_secret_refs[]", 100).trim()).filter(Boolean);
        for (const e of patch.allowed_db_secret_refs) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)) throw new HttpError(400, `allowed_db_secret_refs 항목 '${e}' 는 환경변수 이름 형식이어야 합니다(시크릿 값 금지)`);
        }
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
      // 임베딩(벡터검색 #172) 런타임 토글 — provider off|http, 시크릿 금지(auth_env_ref=환경변수 이름만). store 가 다시 normalize.
      if (input.embedding_config !== undefined) {
        const raw = input.embedding_config;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "embedding_config 는 객체여야 합니다");
        const e = raw as Record<string, unknown>;
        const provider = String(e.provider ?? "off").toLowerCase();
        if (provider !== "off" && provider !== "http") throw new HttpError(400, "embedding_config.provider 는 off|http 만 허용됩니다");
        let authRef: string | null = null;
        if (e.auth_env_ref !== undefined && e.auth_env_ref !== null && e.auth_env_ref !== "") {
          authRef = str(e.auth_env_ref, "embedding_config.auth_env_ref", 100).trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authRef)) throw new HttpError(400, "auth_env_ref 는 환경변수 이름 형식이어야 합니다(시크릿 값 금지)");
        }
        let dimensions = 1024;
        if (e.dimensions !== undefined && e.dimensions !== null && e.dimensions !== "") {
          dimensions = Number(e.dimensions);
          if (!Number.isFinite(dimensions) || dimensions < 1 || dimensions > 16000) throw new HttpError(400, "embedding_config.dimensions 는 1~16000 정수여야 합니다");
          dimensions = Math.floor(dimensions);
        }
        // 성능 튜닝(#602) — 느린/CPU 백엔드 대응. 비우면 기본값(배치 8·타임아웃 300초). store 가 다시 normalize(클램프).
        let batchSize = DEFAULT_EMBEDDING_BATCH_SIZE;
        if (e.batch_size !== undefined && e.batch_size !== null && e.batch_size !== "") {
          batchSize = Number(e.batch_size);
          if (!Number.isFinite(batchSize) || batchSize < EMBEDDING_BATCH_MIN || batchSize > EMBEDDING_BATCH_MAX) throw new HttpError(400, `embedding_config.batch_size 는 ${EMBEDDING_BATCH_MIN}~${EMBEDDING_BATCH_MAX} 정수여야 합니다`);
          batchSize = Math.floor(batchSize);
        }
        let timeoutMs = DEFAULT_EMBEDDING_TIMEOUT_MS;
        if (e.request_timeout_ms !== undefined && e.request_timeout_ms !== null && e.request_timeout_ms !== "") {
          timeoutMs = Number(e.request_timeout_ms);
          if (!Number.isFinite(timeoutMs) || timeoutMs < EMBEDDING_TIMEOUT_MIN_MS || timeoutMs > EMBEDDING_TIMEOUT_MAX_MS) throw new HttpError(400, `embedding_config.request_timeout_ms 는 ${EMBEDDING_TIMEOUT_MIN_MS}~${EMBEDDING_TIMEOUT_MAX_MS}(ms) 정수여야 합니다`);
          timeoutMs = Math.floor(timeoutMs);
        }
        // #688 관리탭에서 끄기 저장 = '명시적 off' 마커 — .env(EMBEDDINGS_*) 시드로 부활하지 않는다(관리탭 > env).
        patch.embedding_config = provider === "off" ? { provider: "off", explicit: true } : {
          provider: "http",
          base_url: (e.base_url === undefined || e.base_url === null || e.base_url === "") ? null : str(e.base_url, "embedding_config.base_url", 500).trim(),
          model: (e.model === undefined || e.model === null || e.model === "") ? null : str(e.model, "embedding_config.model", 200).trim(),
          dimensions,
          auth_env_ref: authRef,
          batch_size: batchSize,
          request_timeout_ms: timeoutMs,
        };
      }
      return { runtimeConfig: await updateRuntimeConfig(patch, actorOf(user), ctx?.source ?? "web",
        { tokenHashPrefix: ctx?.tokenHashPrefix ?? null, ip: ctx?.ip ?? null }) };
    }, {
      hooks: z.object({ session_preload: z.boolean(), work_flag: z.boolean(), stop_writeback_gate: z.boolean(), self_update: z.boolean() }).partial().optional().describe("세션 훅 on/off (self_update=키트 자동 업데이트)"),
      writeback_notice: z.string().nullable().optional().describe("세션종료 너지 문구(null=기본값)"),
      work_roots: z.array(z.string()).optional().describe("작업 루트 디렉토리"),
      allowed_auth_envs: z.array(z.string()).optional().describe("http_proxy 참조 가능 env 이름 화이트리스트"),
      url_allowlist: z.array(z.string()).optional().describe("http_proxy 허용 호스트"),
      allowed_db_hosts: z.array(z.string()).optional().describe("db 소스 허용 host"),
      allowed_internal_hosts: z.array(z.string()).optional().describe("MCP 프록시 허용 내부(사설/localhost) host — SSRF 면제(#746)"),
      allowed_db_secret_refs: z.array(z.string()).optional().describe("db 소스 auth_ref 가 참조 가능한 비번 env 이름 화이트리스트(값 아님)"),
      write_tools: z.array(z.string()).optional().describe("writeback 인정 툴 이름"),
    }),

  // ── 저장소·로그(#813) 상태 — 박스 디스크 사용률 + 로그 크기 + 유효 정책·출처. ──
  //  왜 필요한가: 고객 박스는 우리가 SSH 로 못 들어간다. 디스크가 차면 Postgres 가 죽고 전 기능이 500 이 되는데
  //  (2026-07-13 사고) 그걸 볼 창구가 없었다. 관리탭이 그 창구다.
  // ── 경보 알림 채널(#813) — 박스가 위험해졌을 때 **사람에게 실제로 닿는** 경로. ──
  //  T5 로 가드는 넣었지만 그 사실을 아무도 모른다(로그는 안 보고, 관리탭·/readyz 는 가서 봐야 안다).
  //  ⚠ 웹훅 URL 은 시크릿이다 — **값을 응답에 절대 싣지 않는다**(configured 불리언만). 저장은 암호화(alerts.ts).
  restOnly("org_alert_status", "경보 알림 설정",
    "박스 경보(디스크 위험·DB 다운)를 보낼 웹훅 설정 상태. **URL 값은 반환하지 않는다**(설정 여부만). admin 전용.",
    [{ method: "GET", paths: ["/api/ui/org/alert"], parse: () => ({}) }],
    async () => loadAlertChannel()),

  restOnly("org_alert_set", "경보 알림 설정 저장",
    "경보 웹훅을 등록/변경한다(슬랙·디스코드 incoming webhook 또는 임의 JSON 웹훅). url 을 비워 보내면 **미변경**(기존 유지). min_severity=warn|critical. admin 전용.",
    [{ method: "POST", paths: ["/api/ui/org/alert"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      // ⚠ url 은 감사·로그에 남기지 않는다(시크릿). redactDeep 은 URL 패턴을 안 잡으므로 감사 스냅샷에 넣으면 그대로 샌다.
      const url = input.url === undefined || input.url === null ? "" : str(input.url, "url", 2000);
      const label = input.label === undefined || input.label === null ? null : str(input.label, "label", 100);
      try {
        return { alert: await saveAlertChannel({ url, min_severity: input.min_severity, label }, user.userId) };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : "경보 설정을 저장하지 못했습니다");
      }
    }),

  restOnly("org_alert_delete", "경보 알림 해제",
    "등록된 경보 웹훅을 삭제한다. admin 전용.",
    [{ method: "POST", paths: ["/api/ui/org/alert/delete"], parse: () => ({}) }],
    async () => ({ removed: await removeAlertChannel(), alert: await loadAlertChannel() })),

  restOnly("org_alert_test", "경보 알림 테스트 전송",
    "지금 등록된 웹훅으로 테스트 경보를 1건 보낸다. **설정이 실제로 닿는지 확인하는 유일한 방법** — 저장만 하고 안 보내보면 정작 장애 때 안 온다. admin 전용.",
    [{ method: "POST", paths: ["/api/ui/org/alert/test"], parse: () => ({}) }],
    async () => {
      const ch = await loadAlertChannel();
      if (!ch.configured) throw new HttpError(400, "웹훅이 등록돼 있지 않습니다");
      // min_severity 게이트를 우회해 **무조건** 보낸다 — 테스트인데 임계 때문에 안 가면 확인이 안 된다.
      const r = await sendTestAlert({
        severity: "ok",
        title: "테스트 경보 — 라이블리 게이트웨이",
        text: "이 메시지가 보이면 경보 채널이 정상입니다. 실제 경보는 디스크 위험·DB 다운 등 상태가 바뀔 때만 옵니다(같은 상태를 반복 발송하지 않습니다).",
        detail: { test: true },
      });
      if (!r.sent) throw new HttpError(502, `전송 실패 — ${r.reason ?? "알 수 없는 오류"}`);
      return { sent: true };
    }),

  restOnly("org_storage_status", "저장소·로그 상태",
    "박스 디스크 사용률(경고/위험 판정 포함) + 로그 파일 크기 + 저장소 정책(로그 상한·디스크 임계치)과 그 출처. admin 전용.",
    [{ method: "GET", paths: ["/api/ui/org/storage"], parse: () => ({}) }],
    async () => {
      const cfg = await getRuntimeConfig();
      const p = cfg.storage_policy;
      const disks = await checkDisks(
        [stateRoot(), logRoot(), ...TERMINAL_ROOTS.map((r) => r.base)],
        { warnPct: p.disk_warn_pct, criticalPct: p.disk_critical_pct },
      );
      const files = await listLogs(logRoot());
      // 공유 빌드 캐시(#813 T3) — 지금 얼마나 쌓였나 + 어떤 env 를 세션에 주입 중인가(관리자가 눈으로 확인).
      const cacheOpts = { enabled: p.shared_cache_enabled, relocateHome: p.shared_cache_relocate_home };
      const cacheRoot = sharedCacheRoot(TERMINAL_SHARED_ROOT.base);
      return {
        policy: p,
        policy_source: await getStoragePolicySource(), // db(관리탭) · env(.env 시드) · default(코드 기본값)
        disks,
        logs: {
          dir: logRoot(),
          files,
          totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
          // 정책상 로그가 최대 얼마까지 자랄 수 있나 — '설정이 뭘 뜻하는지'를 UI 가 계산 없이 그대로 보여줄 수 있게.
          capBytes: p.log_max_mb * 1024 * 1024 * (p.log_keep + 1),
        },
        cache: {
          root: cacheRoot,
          // 세션에 실제로 주입되는 변수 이름들(값=경로는 안 민감하지만 이름만으로 충분히 설명된다).
          vars: Object.keys(sessionCacheEnv(TERMINAL_SHARED_ROOT.base, cacheOpts)).sort(),
          bytes: await dirSize(cacheRoot),
        },
      };
    }),

  // ── 워크스페이스 사용량(#813 T3-2) — **백스톱**. ──
  //  close-out 루틴(project-closeout 스킬)이 회수를 하지만 그건 best-effort 다: 에이전트가 스텝을 건너뛰거나,
  //  사람이 웹 UI 에서 바로 done 처리하거나, 프로젝트가 방치되면 아무도 안 치운다 — 그리고 **쌓이는 건 바로 그런 것들**이다.
  //  그래서 관리자가 '무엇이 얼마나 쌓였나'를 보고 **수동으로** 회수할 창구가 필요하다.
  //  ⚠ 무인 자동 삭제는 **없다**(설계 결정) — 이 화면은 보여주기만 하고, 지우는 건 사람이 버튼을 눌러야 한다.
  //  회수 실행은 기존 workspace_reclaim(POST /api/ui/v6/projects/:id/reclaim) 을 그대로 쓴다(안전선 재구현 금지).
  restOnly("org_workspace_status", "워크스페이스 사용량",
    "프로젝트별 워크스페이스 폴더 크기·마지막 사용·활성 세션 여부. 회수 가능량은 프로젝트별 dry-run(POST /api/ui/v6/projects/:id/reclaim)으로 확인한다. admin 전용.",
    [{ method: "GET", paths: ["/api/ui/org/workspace"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      // 진행 중(project/) + 완료 보관(legacy-project/) 둘 다 — done 처리는 폴더를 **이동**할 뿐 지우지 않는다.
      const roots = [
        { kind: "active", sub: PROJECT_SUBDIR, dir: path.join(PROJECT_SHARED_BASE, PROJECT_SUBDIR) },
        { kind: "archived", sub: LEGACY_SUBDIR, dir: path.join(PROJECT_SHARED_BASE, LEGACY_SUBDIR) },
      ];
      let sessionDirs: string[] = [];
      try { sessionDirs = (await listSessions(user)).map((s) => s.dir).filter(Boolean); } catch { /* 세션 조회 실패 → 활성표시만 비움 */ }

      interface WsItem {
        folder: string; project_id: number | null; name: string; status: string | null; kind: string;
        dir: string; bytes: number | null; last_used: number; active_session: boolean;
        repos: number; orphan: boolean;
      }
      // 후보 디렉터리를 먼저 모아 **du 를 한 번만** 부른다(프로젝트가 수백 개라 개별 호출하면 페이지가 몇 초 멈춘다).
      const found: { dir: string; name: string; sub: string; kind: string; mtimeMs: number }[] = [];
      for (const root of roots) {
        for (const name of await fsp.readdir(root.dir).catch(() => [] as string[])) {
          const dir = path.join(root.dir, name);
          const st = await fsp.stat(dir).catch(() => null);
          if (!st?.isDirectory()) continue;
          found.push({ dir, name, sub: root.sub, kind: root.kind, mtimeMs: st.mtimeMs });
        }
      }
      const sizes = await dirSizesFast(found.map((f) => f.dir));
      // ⚠ 프로젝트는 **폴더로** 역조회한다(id 로 하지 않는다). 폴더명이 숫자라는 보장이 없다 — 2026-06-25 이전
      //  규칙은 폴더명이 **프로젝트 이름**이고(dev 박스 74개), 그중 12개는 지금도 살아있다. 숫자만 조회하면
      //  그 12개를 '고아'로 오분류하고 목록에서 놓친다. 한 방 쿼리라 폴더마다 왕복하던 것보다 빠르기도 하다.
      const pmap = await projectsByFolder();

      const items: WsItem[] = [];
      for (const f of found) {
        const folder = `${f.sub}/${f.name}`;
        const project = pmap.get(folder) ?? null;
        items.push({
          folder, // ← 회수 API 의 주소. project_id 는 라벨일 뿐이다(없을 수도 있다).
          project_id: project?.id ?? null,
          name: project?.name ?? f.name,
          status: project?.status ?? null,
          kind: f.kind,
          dir: f.dir,
          bytes: sizes.get(f.dir) ?? null,
          last_used: Math.round(f.mtimeMs / 1000), // 마지막으로 무언가 쓰인 시각(오래된 것부터 정리 판단)
          active_session: sessionDirs.some((d) => isInside(d, f.dir)),
          // ⚠ 아래 두 필드가 없으면 UI 가 **회수할 게 없는 폴더에도 [분석] 버튼**을 달고, 누르면 에러가 난다(#845).
          //  실측(dev 박스): 308개 중 191개가 레포 없는 껍데기. 목록의 다수가 '눌러봐야 에러'였다.
          repos: (await reposIn(f.dir)).length, // 0 = 회수할 파생물이 없다(정상 — provision 안 한 프로젝트)
          orphan: !project, // DB 에 프로젝트가 없다(삭제됨) — 폴더만 남았다. 폴더 기준 API 만이 이걸 회수할 수 있다.
        });
      }
      items.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
      const total = items.reduce((sum, i) => sum + (i.bytes ?? 0), 0);
      return { root: PROJECT_SHARED_BASE, total_bytes: total, projects: items };
    }),

  // ── 워크스페이스 일괄 분석·회수 (#845) ─────────────────────────────────────────────
  //
  //  왜 프로젝트별 REST(POST /v6/projects/:id/reclaim) 로 안 되나 — 두 가지 때문이다:
  //   ① **고아 폴더.** 프로젝트를 지워도 워크스페이스 폴더는 안 지워진다. 그 REST 는 DB 프로젝트를 먼저 조회해
  //      404 로 죽으므로 **영영 회수할 수 없는 사각지대**가 된다(dev 박스 실측: 고아 57개, 그중 8개가 워크트리 보유).
  //      여기(admin)는 **폴더를 기준**으로 풀기 때문에 고아도 다룬다. 고아는 프로젝트 멤버십을 물을 수 없으니
  //      **admin scope 가 유일하게 옳은 자리**다(restOnly = admin).
  //   ② **일괄.** 8GB 가 어디 있는지 알려고 123번 클릭할 수는 없다.
  //
  //  ⚠ **한 요청에 전부 넣지 마라.** du 가 수 GB 를 훑느라 수십 초가 걸리면 프록시가 504 로 끊는다(#600 에서 겪음).
  //   그래서 이 API 는 **호출자가 준 id 목록만** 처리하고, 웹 UI 가 청크로 끊어 부르며 진행률을 보여준다.
  //   서버에 잡 상태를 두지 않으므로 중단·재시도가 그냥 된다.
  //
  //  안전선은 프로젝트별 회수와 **완전히 동일**하다(같은 planReclaim/applyReclaim 을 쓴다):
  //   gitignored ∩ 알려진 파생물만 · .env·data/·소스 보호 · 심링크 미회수 · 활성 세션이면 거부 ·
  //   워크트리 제거는 **푸시 완료 + 더티 없음**일 때만. 일괄이라고 안전선을 낮추지 않는다.
  ...workspaceBatchCapabilities(),

  // ── 임베딩(벡터검색 #172) 상태 + 기존 지식 백필 ──
  restOnly("org_embeddings_status", "임베딩(벡터검색) 상태",
    "임베딩 설정(embedding_config) + 기존 지식 백로그(미임베딩 수) + 진행 중 백필 잡 상태. admin 전용.",
    [{ method: "GET", paths: ["/api/ui/org/embeddings"], parse: () => ({}) }],
    async () => {
      const cfg = await getRuntimeConfig();
      const backlog = await countEmbeddingBacklog();
      // config_source(#688): db(관리탭)·db-off(명시적 끄기)·env(.env 시드)·off — UI 가 설정 출처를 안내.
      return { config: cfg.embedding_config, config_source: await getEmbeddingConfigSource(), backlog, job: getBackfillJob() };
    }),
  restOnly("org_embeddings_backfill", "기존 지식 임베딩(백필) 실행",
    "이미 저장된 지식을 배치로 임베딩(뒤늦게 켠 경우). mode=pending(기본)|model-changed|all. 인프로세스 잡 — 진행은 GET /api/ui/org/embeddings 폴링. 이미 실행 중이면 409.",
    [{ method: "POST", paths: ["/api/ui/org/embeddings/backfill"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>) => {
      const mode = String(input.mode ?? "pending");
      if (mode !== "pending" && mode !== "model-changed" && mode !== "all") throw new HttpError(400, "mode 는 pending|model-changed|all 만 허용됩니다");
      // provider off 면 백필 무의미 — 조기 400(코어도 off 면 no-op 이지만 잡을 만들지 않아 UX 명확).
      const cfg = await getRuntimeConfig();
      if (cfg.embedding_config.provider === "off") throw new HttpError(400, "임베딩이 꺼져 있습니다 — 먼저 provider 를 http 로 저장한 뒤 백필하세요.");
      const { started, job } = startBackfillJob(mode as BackfillMode);
      if (!started) throw new HttpError(409, "이미 백필이 실행 중입니다.");
      return { started, job };
    }),

  // ── 프로젝트 임베딩(검색 #631) 상태 + 백필 — knowledge 엔드포인트와 동형(타깃=project). embedding_config 는 공유. ──
  restOnly("org_project_embeddings_status", "프로젝트 임베딩 상태",
    "임베딩 설정(embedding_config, knowledge 와 공유) + 프로젝트(project·task·subtask) 백로그(미임베딩 수) + 진행 중 프로젝트 백필 잡 상태. admin 전용.",
    [{ method: "GET", paths: ["/api/ui/org/project-embeddings"], parse: () => ({}) }],
    async () => {
      const cfg = await getRuntimeConfig();
      const backlog = await countEmbeddingBacklog(PROJECT_TARGET);
      return { config: cfg.embedding_config, config_source: await getEmbeddingConfigSource(), backlog, job: getBackfillJob(PROJECT_TARGET) };
    }),
  restOnly("org_project_embeddings_backfill", "프로젝트 임베딩(백필) 실행",
    "프로젝트·태스크·서브태스크를 배치로 임베딩(검색 #631). mode=pending(기본)|model-changed|all. 인프로세스 잡 — 진행은 GET /api/ui/org/project-embeddings 폴링. 이미 실행 중이면 409. knowledge 백필과 독립(동시 실행 가능).",
    [{ method: "POST", paths: ["/api/ui/org/project-embeddings/backfill"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>) => {
      const mode = String(input.mode ?? "pending");
      if (mode !== "pending" && mode !== "model-changed" && mode !== "all") throw new HttpError(400, "mode 는 pending|model-changed|all 만 허용됩니다");
      // provider off 면 백필 무의미 — 조기 400(코어도 off 면 no-op 이지만 잡을 만들지 않아 UX 명확).
      const cfg = await getRuntimeConfig();
      if (cfg.embedding_config.provider === "off") throw new HttpError(400, "임베딩이 꺼져 있습니다 — 먼저 provider 를 http 로 저장한 뒤 백필하세요.");
      const { started, job } = startBackfillJob(mode as BackfillMode, PROJECT_TARGET);
      if (!started) throw new HttpError(409, "이미 프로젝트 백필이 실행 중입니다.");
      return { started, job };
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
  // 외부 도구 서버(MCP) 기본 프리셋. 구 이름 org_connector_catalog / /org/connector-catalog 는 **오해를 부르는
  //  이름이었다**(#837) — 담긴 건 org_connector(패시브 미러)가 아니라 org_mcp_server 다. 개명하되 **구 REST 경로는
  //  별칭으로 남긴다**(이미 배포된 클라이언트 보호). MCP 툴 이름은 세션마다 tools/list 로 새로 발견되므로 개명해도 안전.
  restOnly("org_mcp_server_presets", "외부 도구 서버(MCP) 기본 프리셋",
    "관리탭 [AI 도구 ▸ 외부 도구 서버] 추가 시 프리셋으로 채우는 기본 MCP 서버 정본(호스팅 OAuth). 코드 SoT(mcp-server-presets.ts). 시크릿 없음. ※ 외부 자료 수집(org_connector 미러)과는 무관하다 — 구 이름 org_connector_catalog.",
    [{ method: "GET", paths: ["/api/ui/org/mcp-server-presets", "/api/ui/org/connector-catalog"], parse: () => ({}) }],
    async () => ({ catalog: MCP_SERVER_PRESETS })),
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
      // A-어댑터(#746 T1) proxy 필드 — mode=proxy 면 게이트웨이가 상류 MCP 를 프록시(통제·재노출). auth_kind=per-member vault 인증.
      let level: "L0" | "L1" | "L2" | null | undefined;
      if (input.level !== undefined) {
        const lv = input.level === null ? null : str(input.level, "level", 2).toUpperCase();
        if (lv !== null && lv !== "L0" && lv !== "L1" && lv !== "L2") throw new HttpError(400, "level 은 L0|L1|L2");
        level = lv as "L0" | "L1" | "L2" | null;
      }
      let authKind: string | null | undefined;
      if (input.auth_kind !== undefined) {
        if (input.auth_kind === null || input.auth_kind === "") authKind = null;
        else {
          authKind = str(input.auth_kind, "auth_kind", 40).trim().toLowerCase();
          if (!/^[a-z0-9_]{1,40}$/.test(authKind)) throw new HttpError(400, "auth_kind 는 소문자·숫자·_ 1~40자");
        }
      }
      const server = await upsertMcpServer({
        name, transport,
        url: input.url === undefined ? undefined : (input.url === null || input.url === "" ? null : str(input.url, "url", 1000).trim()),
        command: input.command === undefined ? undefined : (input.command === null || input.command === "" ? null : str(input.command, "command", 2000).trim()),
        auth_env: authEnv,
        note: input.note == null ? undefined : str(input.note, "note", 500),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
        mode: input.mode === undefined ? undefined : (str(input.mode, "mode", 10) === "proxy" ? "proxy" : "client"),
        scope: input.scope === undefined ? undefined : (input.scope === null || input.scope === "" ? null : str(input.scope, "scope", 20)),
        level,
        pii_scrub: input.pii_scrub === undefined ? undefined : Boolean(input.pii_scrub),
        auth_kind: authKind,
        auth_scope_key: input.auth_scope_key === undefined ? undefined : (input.auth_scope_key === null || input.auth_scope_key === "" ? null : str(input.auth_scope_key, "auth_scope_key", 120).trim()),
        auth_mode: input.auth_mode === undefined ? undefined : ((): "bearer" | "oauth" | "sigv4" | null => {
          if (input.auth_mode === null || input.auth_mode === "") return null;
          const v = str(input.auth_mode, "auth_mode", 10);
          if (v !== "bearer" && v !== "oauth" && v !== "sigv4") throw new HttpError(400, "auth_mode 는 bearer|oauth|sigv4 만 허용됩니다");
          return v;
        })(),
      }, actorOf(user), "web");
      return { server };
    }, {
      name: z.string().describe("MCP 서버 이름(slug)"),
      transport: z.enum(["http", "stdio"]).optional(),
      url: z.string().nullable().optional().describe("http transport URL"),
      command: z.string().nullable().optional().describe("stdio transport 실행 커맨드"),
      auth_env: z.string().nullable().optional().describe("인증 env 변수 이름(시크릿 값 금지)"),
      note: z.string().optional(),
      enabled: z.boolean().optional(),
      sort: z.number().optional(),
      mode: z.enum(["client", "proxy"]).optional().describe("client=멤버 클라 직접등록(기존) / proxy=게이트웨이 프록시(통제·재노출, #746)"),
      scope: z.string().nullable().optional().describe("proxy 툴 접근 scope(items|context|db|memory|code)"),
      level: z.enum(["L0", "L1", "L2"]).nullable().optional(),
      pii_scrub: z.boolean().optional(),
      auth_kind: z.string().nullable().optional().describe("proxy per-member vault 인증 kind"),
      auth_scope_key: z.string().nullable().optional(),
      auth_mode: z.enum(["bearer", "oauth", "sigv4"]).nullable().optional().describe("bearer=정적토큰(기본) / oauth=per-member OAuth(T2) / sigv4=AWS 요청서명(#746)"),
    }),
  restOnly("org_mcp_refresh", "MCP 프록시 스냅샷 새로고침(발행)",
    "proxy 모드 MCP 서버의 상류 tools/list 를 다시 캡처해 스냅샷(핀)으로 저장한다 — 버전업/새 툴 반영. 다음 세션부터 구성원에 전파(재설치 0).",
    [{ method: "POST", paths: ["/api/ui/org/mcp-server/refresh"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const r = await refreshProxySnapshot(slug(input.name, "name"), actorOf(user));
      // in-session push(#746 T5) — sessioned 클라들에 tools/list_changed 즉시 전파(무상태면 no-op). 발행=라이브 반영.
      const pushed = broadcastToolListChanged();
      return { ok: true, tool_count: r.count, live_pushed_sessions: pushed };
    }),
  restOnly("org_mcp_remove", "MCP 서버 제거",
    "조직 MCP 서버를 제거한다.",
    [{ method: "POST", paths: ["/api/ui/org/mcp-server/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      await removeMcpServer(slug(input.name, "name"), actorOf(user), "web");
      return { ok: true };
    }),

  // ── 커넥터 설정/토큰 (프로젝트 #541) — config=평문, secrets=암호화(secret-box) ──
  restOnly("org_connector_upsert", "커넥터 설정·토큰 저장",
    "커넥터(slack/notion/clickup/…)의 설정(config, 평문)과 토큰(secrets, 암호화 저장)을 저장한다. secrets 는 값이 오면 갱신·빈값/미전송이면 유지. 시크릿 저장엔 게이트웨이 CONNECTOR_SECRET_KEY 필요.",
    [{ method: "POST", paths: ["/api/ui/org/connector"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const system = str(input.system, "system", 40).trim();
      const asStrMap = (v: unknown): Record<string, string> | undefined => {
        if (v == null || typeof v !== "object") return undefined;
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = val == null ? "" : String(val);
        return out;
      };
      const connector = await upsertConnector({
        system,
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        config: asStrMap(input.config),
        secrets: asStrMap(input.secrets),
        note: input.note === undefined ? undefined : (input.note === null || input.note === "" ? null : str(input.note, "note", 500)),
      }, actorOf(user), "web");
      // 게이트웨이 인프로세스 해소 캐시 무효화(#541) — 아래 clickup 멤버 조회 등이 새 토큰을 즉시 쓰게
      //  (캐시는 원래 짧게 사는 싱크 서브프로세스 전제 — 장수 게이트웨이에선 쓰기 시점에 리셋).
      resetConnectorConfigCache();
      return { connector };
    }, {
      system: z.string().describe("커넥터 시스템: slack|notion|clickup|gmail|drive 등"),
      enabled: z.boolean().optional(),
      config: z.record(z.string()).optional().describe("평문 설정값(secret=false 필드)"),
      secrets: z.record(z.string()).optional().describe("시크릿(암호화 저장 — 값=갱신, 빈값/미전송=유지)"),
      note: z.string().nullable().optional(),
    }),
  // ── #586 커넥터 실행(run) — 비동기 "지금 싱크" + 실행 이력/로그(폴링). ──
  restOnly("org_connector_sync_run", "커넥터 지금 싱크(비동기)",
    "커넥터 싱크를 백그라운드로 시작하고 run_id 를 즉시 반환한다(긴 full 백필도 HTTP 타임아웃 없음). 로그·상태는 runs API 로 폴링.",
    [{ method: "POST", paths: ["/api/ui/org/connector/sync"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const system = str(input.system, "system", 40).trim();
      const run = await startConnectorRun(system, { full: Boolean(input.full), trigger: "manual", startedBy: actorOf(user) });
      // #669 sync 완료 후 임베딩 잔량 스윕(백그라운드) — 미러가 남긴 pending(신규·제목/본문 변경 리셋)을 곧바로 흡수.
      if (!run.alreadyRunning) void run.done.then(() => runAutoBackfillSweep()).catch(() => {});
      return { run_id: run.runId, already_running: run.alreadyRunning }; // done 은 await 하지 않는다(비동기)
    }),
  restOnly("org_connector_runs", "커넥터 실행 이력",
    "커넥터 실행(connector_run) 목록 — 상태·모드·트리거·소요. 로그는 개별 run 조회로. limit(≤100, 기본 20)·offset 으로 과거 이력 페이지네이션(#709).",
    [{ method: "GET", paths: ["/api/ui/org/connector/runs"], parse: (req) => ({
      system: req.query?.system ? String(req.query.system) : undefined,
      limit: req.query?.limit ? Number(req.query.limit) : undefined,
      offset: req.query?.offset ? Number(req.query.offset) : undefined,
    }) }],
    async (input: Record<string, unknown>) => {
      const limit = Number.isFinite(Number(input.limit)) && Number(input.limit) > 0 ? Number(input.limit) : 20;
      const offset = Number.isFinite(Number(input.offset)) && Number(input.offset) > 0 ? Number(input.offset) : 0;
      return { runs: await listConnectorRuns(input.system ? String(input.system) : undefined, limit, offset) };
    }, {
      system: z.string().optional().describe("커넥터 시스템(예: clickup)으로 필터"),
      limit: z.number().int().min(1).max(100).optional().describe("페이지 크기(≤100, 기본 20)"),
      offset: z.number().int().min(0).optional().describe("페이지 오프셋(기본 0) — 최신 N건 너머 과거 이력(#709)"),
    }),
  restOnly("org_connector_run_log", "커넥터 실행 로그",
    "실행 1건의 메타 + 로그 청크(offset 이후) — 웹이 폴링으로 이어붙여 진행상황을 본다.",
    [{ method: "GET", paths: ["/api/ui/org/connector/runs/:id"], parse: (req) => ({
      id: Number(req.params?.id), offset: req.query?.offset ? Number(req.query.offset) : 0,
    }) }],
    async (input: Record<string, unknown>) => {
      const id = Number(input.id);
      if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "run id 필요");
      const off = Number.isFinite(Number(input.offset)) && Number(input.offset) > 0 ? Number(input.offset) : 0;
      const run = await getConnectorRun(id, off);
      if (!run) throw new HttpError(404, "run 없음");
      return run;
    }),
  restOnly("org_connector_run_cancel", "커넥터 실행 중지",
    "진행 중인 실행을 중지한다(자식 프로세스 kill + canceled 기록). 커서 미전진이라 데이터 손실 없음 — 다음 run 이 재수집.",
    [{ method: "POST", paths: ["/api/ui/org/connector/runs/:id/cancel"], parse: (req) => ({ id: Number(req.params?.id) }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = Number(input.id);
      if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "run id 필요");
      return await cancelConnectorRun(id, actorOf(user));
    }),
  restOnly("org_connector_discover", "커넥터 스코프 목록 조회",
    "저장된 토큰으로 소스의 선택지(노션 공유 페이지/DB, 클릭업 리스트)를 조회한다 — 관리탭 픽커용.",
    [{ method: "POST", paths: ["/api/ui/org/connector/discover"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>) => {
      const system = str(input.system, "system", 40).trim();
      const { resetConnectorConfigCache } = await import("../connectors/config.js");
      resetConnectorConfigCache(); // 방금 저장한 토큰 즉시 반영
      return await discoverConnectorScope(system);
    }),

  restOnly("org_connector_remove", "커넥터 설정 제거",
    "커넥터 설정/토큰 행을 제거한다(env 폴백으로 복귀).",
    [{ method: "POST", paths: ["/api/ui/org/connector/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      await removeConnector(str(input.system, "system", 40).trim(), actorOf(user), "web");
      resetConnectorConfigCache(); // env 폴백 복귀도 즉시 반영
      return { ok: true };
    }),

  // ── 인입 허용선 정책 (#638, #783) — 지식이 라이브에 박히기 전 게이트. 오너가 관리탭에서 조절(디폴트 auto=현행 무변). ──
  //  #783: 축에 작성자(ai/human)·하네스·page-type 이 추가되고, 액션이 [신규(action)]·[수정(action_update)] 2축이 됐다.
  restOnly("org_ingest_policy_list", "인입 허용선 정책 목록",
    "인입 허용선 정책 규칙 목록 — priority 내림차순. 규칙 0개면 디폴트 auto(현행 무변).",
    [{ method: "GET", paths: ["/api/ui/org/ingest-policy"], parse: () => ({}) }],
    async () => ({ policies: await listIngestPolicies() })),
  restOnly("org_ingest_policy_upsert", "인입 허용선 정책 저장",
    "인입 정책 규칙 저장(id 있으면 수정 · preset 키가 있으면 그 프리셋 행을 갱신 · 둘 다 없으면 신규). " +
    "match_*(카테고리·시스템·채널·provenance·민감라벨·작성자(ai|human)·하네스·page-type)는 빈값=any. " +
    "action=auto|confirm|drop(신규 저장) · action_update=auto|review|stage|drop(기존 지식 수정). " +
    "여러 규칙 매치 시 축별 가장 보수적(신규 drop>confirm>auto · 수정 drop>stage>review>auto). is_exception=true 면 그 규칙이 확정(carve-out).",
    [{ method: "POST", paths: ["/api/ui/org/ingest-policy"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const nStr = (v: unknown): string | null | undefined => v === undefined ? undefined : (v === null || v === "" ? null : String(v));
      const policy = await upsertIngestPolicy({
        id: input.id === undefined ? undefined : Number(input.id),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        match_category: nStr(input.match_category),
        match_system: nStr(input.match_system),
        match_channel: nStr(input.match_channel),
        match_provenance: nStr(input.match_provenance),
        match_sensitive: nStr(input.match_sensitive),
        match_actor_kind: nStr(input.match_actor_kind),
        match_agent: nStr(input.match_agent),
        match_type: nStr(input.match_type),
        action: input.action === undefined ? undefined : String(input.action),
        action_update: input.action_update === undefined ? undefined : String(input.action_update),
        is_exception: input.is_exception === undefined ? undefined : Boolean(input.is_exception),
        preset: nStr(input.preset),
        priority: input.priority === undefined ? undefined : Number(input.priority),
        note: input.note === undefined ? undefined : (input.note === null || input.note === "" ? null : String(input.note)),
      }, actorOf(user), "web");
      return { policy };
    }, {
      id: z.number().optional(),
      enabled: z.boolean().optional(),
      match_category: z.string().nullable().optional(),
      match_system: z.string().nullable().optional(),
      match_channel: z.string().nullable().optional(),
      match_provenance: z.string().nullable().optional(),
      match_sensitive: z.string().nullable().optional(),
      match_actor_kind: z.enum(["ai", "human"]).nullable().optional(),
      match_agent: z.string().nullable().optional(),
      match_type: z.string().nullable().optional(),
      action: z.enum(["auto", "confirm", "drop"]).optional(),
      action_update: z.enum(["auto", "review", "stage", "drop"]).optional(),
      is_exception: z.boolean().optional(),
      preset: z.string().nullable().optional(),
      priority: z.number().optional(),
      note: z.string().nullable().optional(),
    }),
  restOnly("org_ingest_policy_remove", "인입 허용선 정책 삭제",
    "인입 정책 규칙 1개 삭제(id).",
    [{ method: "POST", paths: ["/api/ui/org/ingest-policy/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = Number(input.id);
      if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "id 필요");
      await removeIngestPolicy(id, actorOf(user), "web");
      return { ok: true };
    }),
  restOnly("org_ingest_observability", "인입 게이트 관측",
    "자동 인입 게이트 집계(기간 일수) — mirror auto·pending 생성·승인·반려·현재 대기. 검토 대시(파일럿 1순위 지표: 오너가 어디까지 자동 허용하나).",
    [{ method: "GET", paths: ["/api/ui/org/ingest-observability"], parse: (req) => ({ days: req.query?.days ? Number(req.query.days) : 30 }) }],
    async (input: Record<string, unknown>) => await ingestObservability(Number(input.days) || 30)),
  // ── ClickUp 멤버 매핑 조회(#541) — 관리탭 커넥터 패널용. 팀 멤버 나열 + 매핑 상태 계산.
  //  '효과적 매핑'은 미러(connector-mirror resolveMemberId)와 동일 순서로 판정:
  //   ① person_identity(system='clickup', external_id∈{이메일 소문자, 숫자 id}) JOIN org_member(실재 확인)
  //   ② org_member.email 소문자 직접 매치.
  //  응답 users[]: { clickup, mapped_member_id(①??②), mapped_via('identity'|'email'|null), suggested_member_id }
  //   — mapped_via='identity' 만 UI 에서 '해제' 가능(②는 이메일에서 오는 암묵 매핑 — 드롭다운 미리선택으로 확정 유도).
  //  ClickUp 토큰 미설정/호출 실패는 { error } 폴백(500 금지 — 패널이 우아하게 안내).
  // ── 사람 매핑 목록(#837) — 커넥터 **일반**. 구 org_connector_clickup_members 를 대체한다(구 경로는 별칭 유지). ──
  //  왜 커넥터 쪽이 편집 SoT 인가: 매핑은 "외부 시스템의 사람 ↔ 우리 구성원"인데, 구성원 화면은 외부 목록을
  //  안 가져오므로 관리자가 외부 id(ClickUp 숫자 id 등)를 **손으로 타이핑**해야 했다 — 어디서 찾는지도 모르고
  //  오타는 조용히 매칭 실패로 끝난다. 여기선 커넥터가 실제 목록을 주므로 드롭다운으로 고르기만 하면 된다.
  //  listUsers 를 안 다는 커넥터(gmail·gdrive — 개인 OAuth 라 '멤버' 개념이 없다)는 supported:false 로 답한다.
  restOnly("org_connector_members", "커넥터 사람 매핑 목록",
    "커넥터(clickup·slack·notion)의 사용자 목록과 각자의 org_member 매핑 상태를 계산해 반환한다 — 관리탭 [외부 자료 수집 ▸ 멤버 매핑] 패널용. 구 이름 org_connector_clickup_members.",
    [{ method: "GET", paths: ["/api/ui/org/connector/:system/members", "/api/ui/org/connector/clickup/members"],
       parse: (req) => ({ system: String((req.params as Record<string, string>)?.system ?? "clickup") }) }],
    async (input: { system: string }) => {
      const system = String(input.system || "clickup");
      const conn = connectors[system];
      if (!conn) throw new HttpError(404, `알 수 없는 커넥터: ${system}`);
      if (!conn.listUsers) return { system, supported: false, users: [] };

      let users: ConnectorUser[];
      try { users = await conn.listUsers(); }
      catch (e) { return { system, supported: true, error: `${system} 사용자 목록 조회 실패: ${e instanceof Error ? e.message : String(e)}`, users: [] }; }

      const members = await listMembers();
      // org_member.email(소문자) → id — 효과적 매핑 ② 겸 자동매치 제안 공용.
      const emailToMember = new Map<string, string>();
      for (const m of members) {
        const k = (m.email ?? "").trim().toLowerCase();
        if (k && !emailToMember.has(k)) emailToMember.set(k, m.id);
      }
      // ① person_identity 배치 조회 — 유저별 후보 external_id(외부 id · 소문자 이메일)를 한 번에.
      //   (이메일도 후보인 이유: 관리탭 매핑은 external_id=외부 id 로 저장하지만, 미러가 raw 이메일로 굳혀 둔
      //    과거 데이터가 있다 — #697 clickup-mirror-member-remap-retroactive 참조.)
      const extIds: string[] = [];
      for (const u of users) {
        extIds.push(String(u.id));
        const em = (u.email ?? "").trim().toLowerCase();
        if (em) extIds.push(em);
      }
      const identityMap = new Map<string, string>(); // external_id → org_member.id
      if (extIds.length) {
        const r = await itemsPool.query(
          `SELECT pi.external_id, pi.person_id FROM person_identity pi
             JOIN org_member om ON om.id = pi.person_id
            WHERE pi.system=$2 AND pi.external_id = ANY($1::text[])`, [extIds, system]);
        for (const row of r.rows as Array<{ external_id: string; person_id: string }>) {
          identityMap.set(row.external_id, row.person_id);
        }
      }
      const rows = users.map((u) => {
        const em = (u.email ?? "").trim().toLowerCase();
        const viaIdentity = identityMap.get(String(u.id)) ?? (em ? identityMap.get(em) : undefined) ?? null;
        const viaEmail = em ? (emailToMember.get(em) ?? null) : null;
        return {
          user: u,
          mapped_member_id: viaIdentity ?? viaEmail,
          mapped_via: viaIdentity ? "identity" : (viaEmail ? "email" : null),
          suggested_member_id: viaIdentity ? null : viaEmail,
        };
      });
      return { system, supported: true, instance: users[0]?.instance ?? null, users: rows };
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
      const targetMembers = parseTargetMembers(input.target_members); // #699: null/빈=전원, 배열=지정, undefined=보존
      const hook = await upsertOrgHook({
        id,
        label: input.label == null ? undefined : str(input.label, "label", 200).trim(),
        harness: harness as HookHarness, event, matcher, source_code: sourceCode, timeout_sec: Math.floor(timeout),
        note: input.note == null ? undefined : str(input.note, "note", 500),
        target_members: targetMembers,
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
    "멤버 런너가 현재 활성 커스텀 훅(소스+content_hash)을 받아 실행한다. harness/event 로 필터. #699: user.userId 로 per-member 유효성(개인 오버라이드·target_members) 적용.",
    [{ method: "GET", paths: ["/api/ui/org/runner/hooks"],
      parse: (req) => ({ harness: req.query.harness, event: req.query.event }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const harness = typeof input.harness === "string" && input.harness ? input.harness : undefined;
      const event = typeof input.event === "string" && input.event ? input.event : undefined;
      let hooks = await listEnabledHooks(harness, user?.userId || null);
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
        title: input.title == null ? undefined : str(input.title, "title", 200).trim(),
        description: input.description == null ? undefined : str(input.description, "description", 2000),
        note: input.note == null ? undefined : str(input.note, "note", 500),
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
        // P2(#746) 등급 — L0/L1/L2. L2 는 auto_approve 강제 제외(집행은 하네스 컨펌).
        if (input.level !== undefined) {
          const lvl = input.level === null ? null : str(input.level, "level", 2).toUpperCase();
          if (lvl !== null && lvl !== "L0" && lvl !== "L1" && lvl !== "L2") throw new HttpError(400, "level 은 L0|L1|L2");
          base.level = lvl as "L0" | "L1" | "L2" | null;
        }
        // P1(#746) per-user vault 인증 — auth_kind 설정 시 auth_env 대신 member_secret 로 해소(요청자 개인 자격 우선).
        //  auth_env 와 동시 지정 금지(인증 출처 하나만). auth_kind 형식은 member_secret_store 와 동일 정규식.
        if (input.auth_kind !== undefined && input.auth_kind !== null && input.auth_kind !== "") {
          const ak = str(input.auth_kind, "auth_kind", 40).trim().toLowerCase();
          if (!/^[a-z0-9_]{1,40}$/.test(ak)) throw new HttpError(400, "auth_kind 는 소문자·숫자·_ 1~40자여야 합니다");
          if (authEnv) throw new HttpError(400, "auth_env 와 auth_kind 는 동시에 쓸 수 없습니다(인증 출처 하나만)");
          base.auth_kind = ak;
          if (input.auth_scope_key !== undefined && input.auth_scope_key !== null && input.auth_scope_key !== "") {
            const sk = str(input.auth_scope_key, "auth_scope_key", 120).trim();
            if (!/^[A-Za-z0-9._:-]{0,120}$/.test(sk)) throw new HttpError(400, "auth_scope_key 형식 오류");
            base.auth_scope_key = sk;
          } else base.auth_scope_key = null;
        } else if (input.auth_kind === null || input.auth_kind === "") {
          base.auth_kind = null; base.auth_scope_key = null;
        }
        if (input.pii_scrub !== undefined) base.pii_scrub = Boolean(input.pii_scrub);
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

  // ════════ 하네스 자산 CRUD (스킬·서브에이전트·슬래시커맨드 — runtime 권한) ════════
  //  훅과 같은 runtime 자산군이나 멤버 디스크에 파일로 materialize(하네스가 스캔해야 발견). 회수=fail-OPEN(capability —
  //  게이트웨이 블립에 스킬 상실 방지), 위험 enforcement 는 paired_hook(fail-CLOSED 런너)이 담당. 멤버 fetch=org_runner_assets(별도).
  restRuntime("org_harness_assets", "하네스 자산 목록",
    "조직 스킬·서브에이전트·슬래시커맨드 전체(본문 포함) — runtime 권한 전용. 멤버 materializer fetch 는 org_runner_assets(별도).",
    [{ method: "GET", paths: ["/api/ui/org/harness-assets"], parse: () => ({}) }],
    async () => ({ assets: await listOrgHarnessAssets(), meaning: MEANING["harness-asset"] })),
  restRuntime("org_harness_asset_upsert", "하네스 자산 추가·수정",
    "구성원 하네스에 배포되는 스킬/서브에이전트/커맨드를 저장한다(runtime). 본문은 멤버 디스크에 materialize 되며 스킬은 도구·셸 실행권한을 가질 수 있다(위험 통제=짝훅).",
    [{ method: "POST", paths: ["/api/ui/org/harness-asset"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const id = assertAssetId(input.id);
      const kind = str(input.kind ?? "skill", "kind", 12);
      if (!HARNESS_ASSET_KINDS.has(kind)) throw new HttpError(400, `kind 는 ${[...HARNESS_ASSET_KINDS].join("|")} 만 허용됩니다`);
      const harness = input.harness === undefined ? "all" : str(input.harness, "harness", 12);
      if (!HOOK_HARNESSES.has(harness)) throw new HttpError(400, "harness 는 claude|codex|openclaw|all");
      const description = str(input.description ?? "", "description", 2000);
      const body = str(input.body ?? "", "body", 262144);
      const frontmatter = parseAssetFrontmatter(input.frontmatter);
      assertNoHardSecrets(description, "description");
      assertNoHardSecrets(body, "body"); // 자산 본문도 멤버 디스크로 나가므로 평문 시크릿 hard-block
      assertNoHardSecrets(JSON.stringify(frontmatter), "frontmatter");
      const targetMembers = parseTargetMembers(input.target_members);
      const pairedHookId = (input.paired_hook_id === undefined || input.paired_hook_id === null || input.paired_hook_id === "")
        ? null : assertHookId(input.paired_hook_id);
      const asset = await upsertOrgHarnessAsset({
        id, kind: kind as AssetKind,
        label: input.label == null ? undefined : str(input.label, "label", 200).trim(),
        harness: harness as HookHarness, description, body, frontmatter,
        target_members: targetMembers, paired_hook_id: pairedHookId,
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      }, wctx(user, ctx));
      return { asset, ...seedAssetSyncWarning(id) };
    }),
  restRuntime("org_harness_asset_remove", "하네스 자산 제거",
    "하네스 자산을 제거한다 — 다음 세션부터 materializer 가 멤버 디스크에서 제거한다(미접속 머신은 직전 상태 유지).",
    [{ method: "POST", paths: ["/api/ui/org/harness-asset/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      await removeOrgHarnessAsset(assertAssetId(input.id), wctx(user, ctx));
      return { ok: true };
    }),

  // ── materializer fetch — 멤버 세션훅(session-preload)이 매 세션 호출. 인증된 멤버면 OK(scope null). ──
  //  멤버 머신이 파일로 materialize 하므로 body/frontmatter 를 받는다(관리 목록과 달리 redact 안 함). user.userId 로 per-member 타깃팅.
  restRead("org_runner_assets", "하네스 자산 fetch(materializer)",
    "멤버 materializer 가 현재 활성 하네스 자산(본문+frontmatter+content_hash)을 받아 디스크에 동기화한다. harness/kind 필터, 멤버별 타깃팅.",
    [{ method: "GET", paths: ["/api/ui/org/runner/assets"],
      parse: (req) => ({ harness: req.query.harness, kind: req.query.kind }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const harness = typeof input.harness === "string" && input.harness ? input.harness : undefined;
      const kind = typeof input.kind === "string" && input.kind ? input.kind : undefined;
      const memberId = user?.userId || null;
      const assets = await listEnabledAssets(harness, kind, memberId);
      return { assets: assets.map((a) => ({
        id: a.id, kind: a.kind, harness: a.harness, description: a.description,
        body: a.body, frontmatter: a.frontmatter, content_hash: a.content_hash, paired_hook_id: a.paired_hook_id,
      })) };
    }),

  // ── per-member 개인 오버라이드 (#699) — 관리자 일괄 조회·변경(runtime). 유효성=정책(enabled+target_members) 위 오버라이드. ──
  //  관리자는 대량 배포를 target_members(자산/훅 편집)로, 개별 예외/멤버 opt-in-out 은 아래 오버라이드로. 멤버 본인은 me/asset-pref.
  restRuntime("org_asset_prefs", "자산 개인 오버라이드 목록",
    "하네스 자산·훅의 멤버별 개인 오버라이드(on/off) 전체 — 관리탭 일괄 조회용. target_kind/ref_id/member_id 로 필터.",
    [{ method: "GET", paths: ["/api/ui/org/asset-prefs"],
      parse: (req) => ({ target_kind: req.query.target_kind, ref_id: req.query.ref_id, member_id: req.query.member_id }) }],
    async (input: Record<string, unknown>) => {
      const filter: { target_kind?: AssetPrefKind; ref_id?: string; member_id?: string } = {};
      if (typeof input.target_kind === "string" && input.target_kind) filter.target_kind = assertPrefKind(input.target_kind);
      if (typeof input.ref_id === "string" && input.ref_id) filter.ref_id = input.ref_id.trim();
      if (typeof input.member_id === "string" && input.member_id) filter.member_id = input.member_id.trim().toLowerCase();
      return { prefs: await listAssetPrefs(filter) };
    }),
  restRuntime("org_asset_pref_set", "자산 개인 오버라이드 설정",
    "특정 멤버의 자산/훅 개인 오버라이드를 설정(state=true=강제 on/false=강제 off)하거나 해제(clear=true=관리자 정책 기본값 복귀)한다.",
    [{ method: "POST", paths: ["/api/ui/org/asset-pref"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const targetKind = assertPrefKind(input.target_kind);
      const refId = targetKind === "org_hook" ? assertHookId(input.ref_id) : assertAssetId(input.ref_id);
      const memberId = slug(input.member_id, "member_id");
      if (input.clear === true) { await clearAssetPref(targetKind, refId, memberId, wctx(user, ctx)); return { ok: true, cleared: true }; }
      const pref = await setAssetPref(targetKind, refId, memberId, Boolean(input.state), wctx(user, ctx));
      return { pref };
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
      // driver — 미전송 시 기존 소스 값 유지(수정 시 mysql 소스가 postgres 로 뒤집히지 않게, #715).
      const existing = await getDbSource(name);
      let driver: "postgres" | "mysql";
      if (input.driver === undefined) {
        driver = existing?.driver === "mysql" ? "mysql" : "postgres";
      } else {
        const d = str(input.driver, "driver", 20);
        if (d !== "postgres" && d !== "mysql") throw new HttpError(400, "driver 는 postgres|mysql (#715)");
        driver = d;
      }
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
          let host: string;
          if (driver === "mysql") {
            // mysql url(#715) — 엄격 화이트리스트 검사(스킴·비번 금지·database 필수·파라미터는 ssl 만).
            const mi = inspectMysqlUrl(url);
            if (!mi.ok || !mi.host) throw new HttpError(400, `mysql url 불량: ${mi.error ?? "host 없음"}`);
            host = mi.host;
          } else {
            // pg 파서 기준 검사(검증=접속 일치) — new URL 이 못 보는 ?host=/?password=/?hostaddr= 쿼리파라미터 우회 차단.
            const ins = inspectConnString(url);
            if (ins.hasPassword) throw new HttpError(400, "url 에 비밀번호를 넣지 마세요(?password= 포함) — auth_ref(환경변수 이름)로 참조하세요");
            if (ins.hasHostAddr) throw new HttpError(400, "url 에 hostaddr 파라미터는 허용되지 않습니다");
            if (!ins.host) throw new HttpError(400, "url 이 올바른 접속문자열이 아닙니다(host 없음)");
            host = ins.host;
          }
          if (await isHostBlocked(host, cfg.allowed_db_hosts)) throw new HttpError(400, `차단된 host(사설/메타데이터 IP): ${host} — 외부 DB host 만 허용됩니다(사설/localhost 는 런타임설정 allowed_db_hosts 에 먼저 등록하세요)`);
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
      // mysql 은 RLS(GUC set_config) 등가가 없다(#715) — 유효값(rls 미전송이면 기존값)이 남으면 명시적으로 거부.
      if (driver === "mysql") {
        const effectiveRls = rls !== undefined ? rls : (existing?.rls ?? null);
        if (effectiveRls) throw new HttpError(400, "mysql 소스는 rls(행수준 격리)를 지원하지 않습니다 — rls 를 비워두세요");
      }
      const posIntOpt = (v: unknown, label: string): number | null | undefined => {
        if (v === undefined) return undefined;
        if (v === null || v === "") return null;
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} 는 양의 정수여야 합니다`);
        return n;
      };
      let tableDefault: "allow" | "deny" | undefined;
      if (input.table_default !== undefined) {
        const td = str(input.table_default, "table_default", 8);
        if (td !== "allow" && td !== "deny") throw new HttpError(400, "table_default 는 allow|deny");
        tableDefault = td;
      }
      const payload: DbSourceInput = {
        name, driver, auth_mode: authMode as DbSourceInput["auth_mode"], url, auth_ref: authRef, rls,
        max_rows: posIntOpt(input.max_rows, "max_rows"),
        timeout_ms: posIntOpt(input.timeout_ms, "timeout_ms"),
        note: input.note == null ? undefined : str(input.note, "note", 500),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        table_default: tableDefault,
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

  // ── db_query 테이블 정책 · 컬럼 마스킹 (admin, #186) — 라이브 스키마 위 오버레이 편집 ──
  restOnly("org_db_source_schema", "DB 소스 스키마 오버레이(테이블 정책·컬럼 마스킹)",
    "라이브 스키마(information_schema) 위에 저장 정책을 얹어 돌려준다 — 테이블별 effective allow/deny·마스킹 컬럼 수, table 지정 시 컬럼별 마스킹 스타일. 웹 편집 UI 용.",
    [{ method: "GET", paths: ["/api/ui/org/db-source/schema"],
       parse: (req) => ({ source: req.query?.source ? String(req.query.source) : undefined, table: req.query?.table ? String(req.query.table) : undefined }) }],
    async (input: Record<string, unknown>, _user: LivelyUser) => {
      const src = slug(input.source, "source");
      await refreshSources();
      await refreshPolicy();
      if (!listSourceConfigs().some((s) => s.name === src)) throw new HttpError(404, `db source '${src}' 없음(먼저 등록·활성화)`);
      const policy = getSourcePolicy(src);
      const masks = getMaskStyleMap(src);
      // 카탈로그 조회는 엔진 공통 모듈(db/catalog.ts) — pg='public' / mysql=소스 스키마(DATABASE()) (#715).
      const names = await listTableNames(src);
      const tables = names.map((name) => {
        // 게이트웨이 내부 테이블(B18 절대 deny) — 웹 정책 무관하게 항상 차단. 편집 불가로 정직하게 표시.
        if (isSystemDeniedTable(name)) return { name, mode: "deny", explicit: true, system: true, maskedCount: 0 };
        const explicit = policy.tableMode.get(name.toLowerCase());
        const maskedCount = [...masks.keys()].filter((k) => k.startsWith(name.toLowerCase() + ".")).length;
        return { name, mode: explicit ?? policy.tableDefault, explicit: explicit !== undefined, system: false, maskedCount };
      });
      let columns: Array<Record<string, unknown>> | undefined;
      if (input.table !== undefined && input.table !== "") {
        const table = str(input.table, "table", 200);
        const cols = await listColumnsMeta(src, table);
        columns = cols.map((r) => ({
          column_name: r.column_name, data_type: r.data_type,
          masked: masks.get(`${table.toLowerCase()}.${r.column_name.toLowerCase()}`) ?? null,
        }));
      }
      return { source: src, table_default: policy.tableDefault, tables, columns, meaning: MEANING["db-source"] };
    }),
  restOnly("org_db_table_policy_set", "테이블 조회 정책 저장/삭제",
    "db_query 소스의 테이블별 조회 허용/차단(allow|deny)을 저장한다. remove=true 면 정책행 삭제(기본자세로 복귀). 즉시 반영.",
    [{ method: "POST", paths: ["/api/ui/org/db-source/table-policy"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const source = slug(input.source, "source");
      const table = str(input.table, "table", 200).trim();
      if (!table) throw new HttpError(400, "table 필수");
      if (isSystemDeniedTable(table)) throw new HttpError(400, "게이트웨이 내부 테이블은 항상 차단(시스템)이라 정책 대상이 아닙니다");
      if (input.remove) {
        await removeTablePolicy(source, table, actorOf(user));
      } else {
        const mode = str(input.mode, "mode", 8);
        if (mode !== "allow" && mode !== "deny") throw new HttpError(400, "mode 는 allow|deny");
        await upsertTablePolicy({ source, table_name: table, mode, note: input.note == null ? undefined : str(input.note, "note", 500) }, actorOf(user));
      }
      await refreshPolicy(true);
      return { ok: true };
    }),
  restOnly("org_db_column_mask_set", "컬럼 마스킹 정책 저장/삭제",
    "db_query 소스의 컬럼 마스킹(full|partial|email|hash|null)을 저장한다. remove=true 면 마스킹 해제. 게이트웨이가 결정론적으로 집행(고객 DB 무수정). 즉시 반영.",
    [{ method: "POST", paths: ["/api/ui/org/db-source/column-mask"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const source = slug(input.source, "source");
      const table = str(input.table, "table", 200).trim();
      const column = str(input.column, "column", 200).trim();
      if (!table || !column) throw new HttpError(400, "table·column 필수");
      if (isSystemDeniedTable(table)) throw new HttpError(400, "게이트웨이 내부 테이블은 항상 차단(시스템)이라 마스킹 대상이 아닙니다");
      if (input.remove) {
        await removeColumnMask(source, table, column, actorOf(user));
      } else {
        const style = str(input.style, "style", 12);
        if (!["full", "partial", "email", "hash", "null"].includes(style)) throw new HttpError(400, "style 는 full|partial|email|hash|null");
        await upsertColumnMask({ source, table_name: table, column_name: column, style: style as "full" | "partial" | "email" | "hash" | "null", note: input.note == null ? undefined : str(input.note, "note", 500) }, actorOf(user));
      }
      await refreshPolicy(true);
      return { ok: true };
    }),

  // ── org 관리 변경 감사 조회(#549) — 누가(사람/AI)·언제·무엇을·어디서(mcp/web) 바꿨는지 + before/after. ──
  //  에이전트가 MCP 로 관리기능을 만지게 열렸으므로(restOnly mcp=true), 그 변경 이력을 admin 이 조회하는 표면.
  restOnly("org_audit_list", "조직 변경 감사 조회",
    "org-content 관리 변경(구성원·토큰·런타임·커넥터·DB소스·훅·툴 등)의 감사 로그를 최신순으로 조회한다. " +
    "필터: entity·actor·actor_kind(human/ai/system)·channel(mcp/web/…)·op·기간(since/until ISO8601)·페이징(limit≤500·offset). " +
    "기본은 민감 관리 엔티티만 — scope='all' 이면 지식·프로젝트 등 전체 포함. before/after 는 저장 시 시크릿이 마스킹된 스냅샷.",
    [{ method: "GET", paths: ["/api/ui/org/audit"], parse: (req) => ({
        entity: req.query?.entity, scope: req.query?.scope, entity_key: req.query?.entity_key,
        actor: req.query?.actor, actor_kind: req.query?.actor_kind, channel: req.query?.channel,
        op: req.query?.op, since: req.query?.since, until: req.query?.until,
        limit: req.query?.limit, offset: req.query?.offset,
      }) }],
    async (input: Record<string, unknown>) => {
      const i = input ?? {};
      const s = (v: unknown): string => (v == null ? "" : String(v).trim());
      const entity = s(i.entity);
      const scopeMode = s(i.scope); // ''|'admin'=민감 기본, 'all'=전체
      const entities = entity ? [entity] : (scopeMode === "all" ? null : [...ADMIN_AUDIT_ENTITIES]);
      const offset = Math.min(Math.max(Number(i.offset) || 0, 0), 1_000_000);
      const limN = Number(i.limit);
      const limit = Number.isFinite(limN) && limN > 0 ? Math.min(Math.floor(limN), 500) : 50;
      const opt = (v: unknown): string | null => s(v) || null;
      const { rows, total } = await listContentAudit({
        entities, entity_key: opt(i.entity_key), actor: opt(i.actor), actor_kind: opt(i.actor_kind),
        channel: opt(i.channel), op: opt(i.op), since: opt(i.since), until: opt(i.until), limit, offset,
      });
      return {
        rows, total, limit, offset,
        filters: { entity: entity || null, scope: scopeMode || "admin", actor: opt(i.actor),
                   actor_kind: opt(i.actor_kind), channel: opt(i.channel), op: opt(i.op) },
        // 드롭다운 옵션(고정 어휘) — entity 는 민감 관리 목록, 나머지는 감사 enum.
        entityOptions: [...ADMIN_AUDIT_ENTITIES],
        channelOptions: ["mcp", "web", "connector", "cli", "migration", "unknown"],
        actorKindOptions: ["human", "ai", "connector", "system", "unknown"],
        opOptions: ["insert", "update", "delete", "revoke", "mint", "reorder"],
      };
    }, {
      entity: z.string().optional().describe("특정 엔티티만(org_member|auth_token|org_runtime_config|org_connector|org_db_source|org_hook|org_tool 등)"),
      scope: z.enum(["admin", "all"]).optional().describe("admin(기본, 민감 관리 엔티티만)|all(지식·프로젝트 등 전체)"),
      entity_key: z.string().optional().describe("특정 엔티티 키(예: 멤버 id)"),
      actor: z.string().optional().describe("변경 주체 멤버 id"),
      actor_kind: z.enum(["human", "ai", "connector", "system", "unknown"]).optional().describe("누가(사람/AI/시스템)"),
      channel: z.enum(["mcp", "web", "connector", "cli", "migration", "unknown"]).optional().describe("경로(mcp/web/…)"),
      op: z.string().optional().describe("작업: insert|update|delete|revoke|mint|reorder"),
      since: z.string().optional().describe("시작 시각 ISO8601"),
      until: z.string().optional().describe("끝 시각 ISO8601"),
      limit: z.number().optional().describe("페이지 크기(≤500, 기본 50)"),
      offset: z.number().optional().describe("페이지 오프셋"),
    }),
];

// 라이블리 앱 매니페스트 — 계약(#1780). "앱 = 매니페스트로 묶인 구성요소 번들"의 정본 스키마.
//  발주(윤상민 2026-08-19): OS/앱 계층 분리 — 앱은 하네스 설정(스킬·훅·서브에이전트) + MCP/도구 + UI +
//  스케줄 잡 + 데이터를 선언하는 응용프로그램. 형식은 발명하지 않고 **Claude Code 플러그인 상위호환**으로 둔다
//  (plugin.json 은 그 파일이 담당, 이 파일은 라이블리 확장: permissions·ui·jobs·data·sections).
//
// 설계 근거: 지식 lively-os-app-layer-analysis-2026-08 · 설계문서 project/1780/design-v1.md (R1·R2 적대검증 반영).
// 핵심 불변식:
//  - permissions 는 **상한 선언**이다(설치 시 사람이 보고 동의, 실행 시 이 범위로 축소). admin·runtime scope 선언은 거부.
//  - id 는 워크스페이스 유일·32자 상한(자산 id 합성 `app-<hash10>-<slug>` 이 64자 STRICT_SLUG 를 넘지 않게 — design R1-F4).
//  - 검증은 **순수**(DB·FS 무접근). 설치 파이프라인(별도)이 이 파서를 먼저 태운 뒤 전개한다.
import { z } from "zod";
import { createHash } from "node:crypto";
import { HttpError } from "../http-error.js";
import { SCOPES_ALLOWED } from "../auth/scopes.js";
import { STRICT_SLUG, assertAssetId } from "../org/asset-id.js";

// ── 상수 ──────────────────────────────────────────────────────────────────────

// 앱 id: STRICT_SLUG 와 같은 charset 이되 **32자 상한**(자산 id 합성 여유).
//  appAssetId = `app-<sha256(id).slice(0,10)>-<자산슬러그>` → 4+3+10+1+최대? ; 앱 id 자체는 해시로 접히므로
//  실제 상한 압박은 자산 슬러그 쪽이지만, 매니페스트 id 를 짧게 강제해 두면 사람이 읽는 식별자가 안정적이다.
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

// 앱이 **선언조차 할 수 없는** scope — 관리면·런타임 노브는 앱의 몫이 아니다(design D3 불변식).
export const APP_FORBIDDEN_SCOPES: ReadonlySet<string> = new Set(["admin", "runtime"]);

// UI 표시 모드(MCP Apps 차용 — design D5-2). 발명하지 않는다.
export const APP_DISPLAY_MODES = ["inline", "fullscreen", "pip"] as const;

// 위젯이 붙을 수 있는 셸 표면(design D5-1).
export const APP_WIDGET_SURFACES = ["home", "aside", "launchpad"] as const;

// 잡 실행 종류(design D4 — v1 은 headless 만 실효, inject/managed 는 스펙 예약).
export const APP_JOB_KINDS = ["headless", "inject"] as const;

// ── zod 스키마 ────────────────────────────────────────────────────────────────

const idSchema = z.string().regex(APP_ID_RE, "id 는 소문자 영숫자/- 2~32자(소문자·숫자로 시작)여야 합니다");

// semver(major.minor.patch[-prerelease][+build]) — 느슨하지만 3-파트는 강제.
const semverSchema = z.string().regex(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  "version 은 semver(예: 1.2.0)여야 합니다",
);

// 자산 슬러그(스킬/에이전트/커맨드/위젯/페이지 key) — STRICT_SLUG 그대로.
const slugSchema = z.string().regex(STRICT_SLUG, "key/name 은 소문자 영숫자/_/- 1~64자여야 합니다");

// 호스트: 외부 백엔드·프록시 도구가 나갈 수 있는 호스트(url_allowlist 에 등록될 값). 소문자, 스킴 없음.
const hostSchema = z.string().regex(/^[a-z0-9.-]+(?::\d+)?$/, "host 는 호스트[:포트] 형식(스킴 없이)이어야 합니다");

// 도구 이름 또는 글롭(예: "knowledge_search", "ext__slack__*").
const toolGlobSchema = z.string().min(1).max(128).regex(/^[a-z0-9_*]+$/i, "tool 이름/글롭 형식이 아닙니다");

const permissionsSchema = z.object({
  scopes: z.array(z.string()).default([]),
  tools: z.array(toolGlobSchema).default([]),        // lively 능력(빌트인) allowlist. 빈 배열 = lively 툴 0
  ext_tools: z.array(toolGlobSchema).default([]),    // 프록시(ext__*)·HTTP 도구 allowlist(글롭)
  hosts: z.array(hostSchema).default([]),            // 자체 백엔드 — 설치 시 url_allowlist 병합
  db_sources: z.array(z.string().min(1).max(128)).default([]), // 읽을 소스 뷰(src.*)
}).strict();

const uiPageSchema = z.object({
  key: slugSchema,
  title: z.string().min(1).max(200),
  entry: z.string().min(1).max(512),                 // 패키지 내 상대경로(예: ui/index.html) — 검증 단계가 탈출 거부
  display: z.array(z.enum(APP_DISPLAY_MODES)).default(["inline"]),
}).strict();

const uiWidgetSchema = z.object({
  key: slugSchema,
  title: z.string().min(1).max(200),
  entry: z.string().min(1).max(512),
  surfaces: z.array(z.enum(APP_WIDGET_SURFACES)).default(["launchpad"]),
}).strict();

const uiSchema = z.object({
  pages: z.array(uiPageSchema).default([]),
  widgets: z.array(uiWidgetSchema).default([]),
}).strict();

const jobSchema = z.object({
  key: slugSchema,
  schedule: z.string().min(1).max(120),              // cron 식 — 스케줄러가 재검증
  run: z.object({
    kind: z.enum(APP_JOB_KINDS),
    prompt_asset: z.string().min(1).max(512).optional(), // 패키지 내 프롬프트 파일 상대경로
    prompt: z.string().max(20000).optional(),
  }).strict(),
}).strict();

const dataColumnSchema = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, "컬럼명은 소문자 영숫자/_(소문자·_로 시작)"),
  type: z.string().min(1).max(64),                   // 선언형 — DDL 생성기가 화이트리스트 검증(별도)
}).strict();

const dataTableSchema = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, "테이블명은 소문자 영숫자/_(소문자·_로 시작)"),
  columns: z.array(dataColumnSchema).min(1),
}).strict();

const sectionSchema = z.object({
  key: slugSchema,
  file: z.string().min(1).max(512),                  // 패키지 내 상대경로(예: persona.md)
}).strict();

// 매니페스트 전체.
export const appManifestSchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(200),
  version: semverSchema,
  publisher: z.object({
    name: z.string().min(1).max(200),
    url: z.string().url().max(500).optional(),
  }).strict().optional(),
  min_core: semverSchema.optional(),                 // 최소 코어(build-info.version) — 설치가 대조
  harness: z.object({
    plugin: z.string().min(1).max(512).default("./"), // Claude 플러그인 루트(상대경로)
  }).strict().optional(),
  permissions: permissionsSchema.default({}),
  tools: z.object({
    mcp_servers: z.array(z.record(z.unknown())).default([]), // org_mcp_server 프리셋 형식(설치가 재검증)
    http_tools: z.array(z.record(z.unknown())).default([]),  // org_tool 프리셋 형식(설치가 재검증)
  }).strict().default({}),
  ui: uiSchema.default({}),
  jobs: z.array(jobSchema).default([]),
  data: z.object({ tables: z.array(dataTableSchema).default([]) }).strict().default({}),
  sections: z.array(sectionSchema).default([]),
}).strict();

export type LivelyAppManifest = z.infer<typeof appManifestSchema>;

// ── 파서 ─────────────────────────────────────────────────────────────────────

/**
 * 원시 매니페스트(파싱된 JSON)를 검증해 정규 매니페스트를 돌려준다. 순수(DB·FS 무접근).
 *  실패는 HttpError(400) — 설치 파이프라인이 그대로 사용자에게 전달한다.
 *  scope 상한(admin·runtime 거부, 알 수 없는 scope 거부)은 zod 밖에서 명시적으로(더 나은 메시지).
 */
export function parseAppManifest(raw: unknown): LivelyAppManifest {
  const parsed = appManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") || "(root)";
    throw new HttpError(400, `매니페스트 오류 [${path}]: ${first?.message ?? "형식이 올바르지 않습니다"}`);
  }
  const m = parsed.data;

  // scope 상한 — 허용 scope 안이면서 앱 금지 scope(admin·runtime)가 아니어야 한다.
  for (const s of m.permissions.scopes) {
    if (!SCOPES_ALLOWED.has(s)) throw new HttpError(400, `매니페스트 오류 [permissions.scopes]: 알 수 없는 scope '${s}'`);
    if (APP_FORBIDDEN_SCOPES.has(s)) throw new HttpError(400, `매니페스트 오류 [permissions.scopes]: '${s}' 는 앱이 요청할 수 없는 scope 입니다(관리·런타임)`);
  }

  // UI/잡/자산 key 중복 거부(같은 표면 안에서).
  assertUniqueKeys("ui.pages", m.ui.pages.map((p) => p.key));
  assertUniqueKeys("ui.widgets", m.ui.widgets.map((w) => w.key));
  assertUniqueKeys("jobs", m.jobs.map((j) => j.key));
  assertUniqueKeys("data.tables", m.data.tables.map((t) => t.name));
  assertUniqueKeys("sections", m.sections.map((s) => s.key));

  // 잡 run 은 prompt_asset 또는 prompt 중 하나가 있어야 한다.
  for (const j of m.jobs) {
    if (!j.run.prompt_asset && !j.run.prompt) {
      throw new HttpError(400, `매니페스트 오류 [jobs.${j.key}.run]: prompt_asset 또는 prompt 가 필요합니다`);
    }
  }
  return m;
}

function assertUniqueKeys(where: string, keys: string[]): void {
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) throw new HttpError(400, `매니페스트 오류 [${where}]: key '${k}' 가 중복입니다`);
    seen.add(k);
  }
}

// ── 자산 id 합성 (design D1/R1-F4) ────────────────────────────────────────────

/**
 * 앱 자산의 물질화 id — `app-<sha256(appId).slice(0,10)>-<slug>`.
 *  draftAssetId(#990) 와 동형: 하이픈 구분자 모호성 제거(앱id는 고정 10hex로 접힘) + STRICT_SLUG(≤64·ASCII) 보장.
 *  원 슬러그(앱 번들 내 이름)는 org_app_component.orig_name 이 보존 → 세션 물질화 시 원명으로 복원(앱 내부 상호참조 유지).
 */
export function appAssetId(appId: string, slug: string): string {
  if (!APP_ID_RE.test(appId)) throw new HttpError(400, `앱 id 형식 오류: '${appId}'`);
  const h = createHash("sha256").update(appId).digest("hex").slice(0, 10);
  return assertAssetId(`app-${h}-${slug}`); // 총길이(≤64)·charset 최종 검증(방어적)
}

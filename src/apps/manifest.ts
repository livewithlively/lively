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
import { parseColumnType, defaultLiteralText, DEFAULT_EXPRS } from "./store-ddl.js";

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

// 앱 **실행 인스턴스**가 프로젝트 맥락을 갖는 방식(#1780 v2.1).
//  package 설치와 instance 실행은 다른 축이다: 같은 package 에서 프로젝트가 다른 인스턴스가 여러 개 열릴 수 있다.
export const APP_PROJECT_AFFINITIES = ["global", "optional", "required"] as const;
export const APP_INSTANCE_MULTIPLICITIES = ["single", "multiple"] as const;

// OS가 직접 그리는 builtin 전용 renderer. 매니페스트에는 기록되지만, 소비자는 source.kind='builtin' 일 때만 신뢰한다.
//  외부 앱이 같은 문자열을 선언해도 generic opaque iframe 경로를 벗어나지 못한다.
export const APP_SYSTEM_RENDERERS = ["session", "browser", "classic", "inbox", "sources", "taxonomy", "learn", "builder"] as const;   // builder = 앱빌더(#4632)
/** #1891 — 알림 권한이 함의하는 능력 이름. 이 이름이 바뀌면 파생도 같이 바뀌어야 한다. */
export const NOTIFY_TOOL = "app_notify";
/** #4594 — 「세션에 글 보내기」 권한(permissions.chat_send)이 함의하는 능력 이름. 앱 화면의 lively.chat.send 가 이 도구를 grant 에서 찾는다. */
export const CHAT_SEND_TOOL = "app_chat_send";
/** #4482 앱 주소 iframe 에 선언으로만 위임하는 장치 권한(권한 정책 이름 그대로). */
export const APP_DEVICES = ["microphone", "camera", "clipboard-read", "geolocation"] as const;
export type AppDevice = (typeof APP_DEVICES)[number];
/** #4592 — 「붙은 세션의 프로젝트 자료에서 파일 읽기」 권한(permissions.project_files)이 함의하는 능력 이름. 앱 화면의 lively.files 가 이 도구를 grant 에서 찾는다. */
export const PROJECT_FILES_TOOL = "app_project_files";
/** #4629 — 「전체 자료에서 파일 읽기」 권한(permissions.workspace_files)이 함의하는 능력 이름. lively.files 의 scope 'all' 이 이 도구를 grant 에서 찾는다. */
export const WORKSPACE_FILES_TOOL = "app_workspace_files";
/** #4673 — 「이 앱의 앱 폴더에 파일을 올리고 받기」 권한(permissions.app_folder)이 함의하는 능력 이름. 앱 주체가 file_url 로 제 앱 폴더(apps/<앱>/…)의 서명 주소를 받는다. */
export const FILE_URL_TOOL = "file_url";

// ── zod 스키마 ────────────────────────────────────────────────────────────────

const idSchema = z.string().regex(APP_ID_RE, "id 는 소문자 영숫자/- 2~32자(소문자·숫자로 시작)여야 합니다");

// semver(major.minor.patch[-prerelease][+build]) — 느슨하지만 3-파트는 강제.
const semverSchema = z.string().regex(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  "version 은 semver(예: 1.2.0)여야 합니다",
);

// 자산 슬러그(스킬/에이전트/커맨드/위젯/페이지 key) — STRICT_SLUG 그대로.
const slugSchema = z.string().regex(STRICT_SLUG, "key/name 은 소문자 영숫자/_/- 1~64자여야 합니다");

// 호스트: 외부 백엔드·프록시 도구가 나갈 수 있는 호스트(url_allowlist 에 등록될 값). 스킴 없음.
//  대소문자 관대 입력 + **소문자 정규화**(url_allowlist·SSRF 는 소문자 비교라 저장은 소문자로 굳힌다).
const hostSchema = z.string().regex(/^[A-Za-z0-9.-]+(?::\d+)?$/, "host 는 호스트[:포트] 형식(스킴 없이)이어야 합니다")
  .transform((s) => s.toLowerCase());

// 도구 이름 또는 글롭(예: "knowledge_search", "ext__slack__*").
const toolGlobSchema = z.string().min(1).max(128).regex(/^[a-z0-9_*]+$/i, "tool 이름/글롭 형식이 아닙니다");

const permissionsSchema = z.object({
  scopes: z.array(z.string()).default([]),
  tools: z.array(toolGlobSchema).default([]),        // lively 능력(빌트인) allowlist. 빈 배열 = lively 툴 0
  ext_tools: z.array(toolGlobSchema).default([]),    // 프록시(ext__*)·HTTP 도구 allowlist(글롭)
  hosts: z.array(hostSchema).default([]),            // 자체 백엔드 — 설치 시 url_allowlist 병합
  db_sources: z.array(z.string().min(1).max(128)).default([]), // 읽을 소스 뷰(src.*)
  // #1891 — 이 앱이 사용자에게 알림을 보낼 수 있나. 기본 false(fail-closed): 선언하지 않은 앱은 못 쏜다.
  //  선언만으로도 부족하고 그 멤버의 활성 grant 가 함께 있어야 한다(src/apps/notify-policy.ts).
  notifications: z.boolean().default(false),
  // #4594 — 이 앱 화면이 **붙은 세션에 글을 바로 보낼** 수 있나(lively.chat.send). 기본 false(fail-closed). 그 사람의 AI 세션에 말이
  //  들어가는 능력이라 동의 항목이다 — 선언만으로 부족하고 그 멤버의 활성 grant 에 app_chat_send 가 있어야 한다(apps/app-chat-send.ts).
  chat_send: z.boolean().default(false),
  // #4592 — 이 앱 화면이 **붙은 세션의 프로젝트 자료(공유 폴더)** 에서 읽을 수 있는 파일 확장자(점 없이 · 소문자). 빈 배열 = 못 읽는다(fail-closed).
  //  목록(최신순)과 내용 읽기뿐이고 쓰기는 없다(lively.files.list / .read). 그 사람이 볼 수 있는 프로젝트의 파일이 앱으로 들어오는 능력이라
  //  동의 항목이다 — 선언만으로 부족하고 그 멤버의 활성 grant 에 app_project_files 가 있어야 한다(apps/app-project-files.ts).
  project_files: z.array(z.string().regex(/^[a-z0-9]{1,8}$/, "확장자는 점 없이 소문자·숫자 1~8자")).max(8).default([]),
  // #4629 — 이 앱 화면이 **그 사람이 볼 수 있는 모든 프로젝트의 자료**에서 읽을 수 있는 파일 확장자(lively.files 의 scope 'all').
  //  project_files 보다 넓은 능력이라 **따로** 선언하고 따로 동의받는다(app_workspace_files) — 붙은 세션의 프로젝트 밖 파일이 앱으로 들어온다.
  //  읽기뿐이고, 여전히 세션에 붙은 앱 화면에서만 · 프로젝트 공개 범위 안에서만 닿는다(apps/app-project-files.ts).
  workspace_files: z.array(z.string().regex(/^[a-z0-9]{1,8}$/, "확장자는 점 없이 소문자·숫자 1~8자")).max(8).default([]),
  // #4673 — 이 앱(화면 · 서버)이 **제 앱 폴더**(워크스페이스 apps/<앱>/)에 파일을 올리고 받을 수 있나. 기본 false(fail-closed).
  //  그 사람 이름으로 워크스페이스 저장소에 쓰는 능력이라 동의 항목이다 — 선언만으로 부족하고 그 멤버의 활성 grant 에 file_url 이 있어야 한다
  //  (files/file-access.ts). 남의 앱 폴더 · 공유 폴더는 이 선언으로 열리지 않는다(프로젝트 파일 읽기는 project_files 그대로).
  app_folder: z.boolean().default(false),
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

// ── CSP 선언 (MCP Apps `csp{connectDomains,resourceDomains,frameDomains}` 채택 — 발명하지 않는다) ──
//  앱 UI 의 기본값은 **네트워크 0 · 프레임 0** 이다(app-ui.ts 가 srcdoc 에 CSP meta 를 박는다).
//  그보다 넓은 것이 필요하면 매니페스트에 적어 **설치(관리자)·동의(사용자) 때 사람이 보게** 한다.
//   · frame_domains   — 이 앱 화면 안에 실을 사이트(브라우저형 앱). `*` 허용 = https 전체.
//     남의 페이지는 **불투명 오리진**으로 실려 우리 오리진·토큰엔 닿지 못하고, 앱도 그 안을 읽지 못한다(교차출처).
//   · connect_domains — 앱 UI 가 직접 fetch 할 곳. ⚠ `*` **금지** — 그 하나가 곧 데이터 유출 통로다(명시 호스트만).
//   · resource_domains — 이미지·폰트·미디어 출처.
const cspHostSchema = z.string().min(1).max(253)
  .regex(/^(\*|\*\.[a-z0-9-]+(\.[a-z0-9-]+)+|[a-z0-9-]+(\.[a-z0-9-]+)+|localhost)$/i,
    "csp 도메인은 호스트·*.호스트·* 형식이어야 합니다");
const cspSchema = z.object({
  connect_domains: z.array(cspHostSchema).default([]),
  resource_domains: z.array(cspHostSchema).default([]),
  frame_domains: z.array(cspHostSchema).default([]),
}).strict().default({});

const uiSchema = z.object({
  pages: z.array(uiPageSchema).default([]),
  widgets: z.array(uiWidgetSchema).default([]),
}).strict();

const instancesSchema = z.object({
  project: z.enum(APP_PROJECT_AFFINITIES).default("optional"),
  multiplicity: z.enum(APP_INSTANCE_MULTIPLICITIES).default("multiple"),
}).strict().default({});

const systemSchema = z.object({
  renderer: z.enum(APP_SYSTEM_RENDERERS),
  route: z.string().max(512).optional(),
  home: z.string().url().max(2000).optional(),
}).strict().optional();

// 서버측 앱 코드는 worker 한 종류만(v2.1). external은 후속으로 미뤘으므로 어휘에도 넣지 않는다.
// runtime 부재는 "실행 코드 없음"이 아니라 별도 서버 worker 없음(UI/system renderer만 실행 가능)을 뜻한다.
const runtimeEntrySchema = z.string().min(1).max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:m?js)$/, "entry 는 패키지 안의 .js/.mjs 상대경로여야 합니다")
  .refine((entry) => !entry.split("/").includes(".."), "entry 에 '..' 경로를 쓸 수 없습니다");
const runtimeSchema = z.object({
  kind: z.literal("worker").default("worker"),
  entry: runtimeEntrySchema,
  placement: z.enum(["any", "central", "remote"]).default("any"),
  idle_timeout_sec: z.number().int().min(30).max(3600).default(300),
  memory_mb: z.number().int().min(64).max(512).default(256),
}).strict().optional();

const jobSchema = z.object({
  key: slugSchema,
  schedule: z.string().min(1).max(120),              // cron 식 — 스케줄러가 재검증
  run: z.object({
    kind: z.enum(APP_JOB_KINDS),
    prompt_asset: z.string().min(1).max(512).optional(), // 패키지 내 프롬프트 파일 상대경로
    prompt: z.string().max(20000).optional(),
  }).strict(),
}).strict();

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
// #4483 칸 제약·구조 변경 — 전부 선택. 값 정합성은 DB 가 지킨다(앱 코드·AI 가 틀린 값을 넣어도 거부된다).
const dataColumnSchema = z.object({
  name: z.string().regex(IDENT_RE, "컬럼명은 소문자 영숫자/_(소문자·_로 시작)"),
  type: z.string().min(1).max(64),                   // 선언형 — DDL 생성기가 화이트리스트 검증(store-ddl.parseColumnType)
  not_null: z.boolean().optional(),
  default: z.unknown().optional(),                   // 값 기본값(JSON) — 형에 맞는 리터럴로(store-ddl.defaultLiteralText)
  default_expr: z.string().max(40).optional(),       // 식 기본값 — store-ddl.DEFAULT_EXPRS 만
  unique: z.boolean().optional(),
  check: z.string().min(1).max(1000).optional(),     // 검사 식 — 설치 때 검사기가 해석한다(그 표의 칸만 · 위험 함수 거부)
  references: z.object({
    table: z.string().regex(IDENT_RE, "references.table 은 같은 앱의 테이블 이름"),
    on_delete: z.enum(["cascade", "set null", "restrict", "no action"]).optional(),
  }).strict().optional(),
  values: z.array(z.string().min(1).max(200)).min(1).max(200).optional(),   // type: enum 의 값
  renamed_from: z.string().regex(IDENT_RE, "renamed_from 은 옛 칸 이름").optional(),
}).strict();

// #4226 인덱스 선언 — 테이블이 커지면 인덱스 없는 조회가 전체 훑기가 되어 자유 SQL 의 문장 시간 상한(5초)에 걸린다.
//  칸은 선언한 칸 또는 시스템 칸(id·created_at)만(parseAppManifest 가 대조). unique 는 같은 값 두 번을 막는다.
const dataIndexSchema = z.object({
  columns: z.array(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, "인덱스 칸 이름은 소문자 영숫자/_")).min(1).max(8),
  unique: z.boolean().default(false),
}).strict();

const dataTableSchema = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, "테이블명은 소문자 영숫자/_(소문자·_로 시작)"),
  columns: z.array(dataColumnSchema).min(1),
  indexes: z.array(dataIndexSchema).max(20).default([]),
  // #4483 여러 칸에 걸친 검사(예 `starts_at < ends_at`) · 지울 칸(데이터가 있으면 보관 스키마로 옮긴 뒤 지운다).
  checks: z.array(z.string().min(1).max(1000)).max(20).default([]),
  drop_columns: z.array(z.string().regex(IDENT_RE, "drop_columns 는 칸 이름")).max(100).default([]),
}).strict();

const sectionSchema = z.object({
  key: slugSchema,
  file: z.string().min(1).max(512),                  // 패키지 내 상대경로(예: persona.md)
}).strict();

// #4595 — 앱이 **세션에 붙었을 때 그 세션의 AI 에게 실리는 지침**. 사람이 읽는 설명이 아니라 AI 의 행동 규칙이다
//  («HTML 을 만들면 이 앱에 올려라» · «이런 글이 오면 표를 읽어 답을 적어라»). 붙은 앱 목록(session_apps)에 그대로 실리고,
//  시드 훅 session-apps-inject 가 테이블 안내 뒤에 붙인다. 없던 때는 AI 가 테이블 이름만 보고 앱의 목적을 짐작해야 했다.
//  reinject_every — 대화가 길어져 하네스가 앞부분을 요약하면 한 번 실린 안내가 흐려진다. 이 턴 수마다 같은 목록이어도
//   다시 알린다(붙은 앱이 여럿이면 가장 작은 값). 4000자 상한은 매 턴 맥락에 들어가는 글이라 짧게 두라는 뜻이다.
//  구성원 앱(app_save)도 가질 수 있다 — 지침은 그 세션 안에서만 읽히는 글이라 다른 사람에게 새는 것이 없다(member-app.ts 위반 아님).
const agentSchema = z.object({
  instructions: z.string().min(1).max(4000),
  reinject_every: z.number().int().min(5).max(500).default(40),
}).strict().optional();

// 이 코어가 **설치**할 줄 아는 매니페스트 스키마 버전. 파싱은 어떤 버전이든 받는다(아래 주석) — 설치만 이 값으로 게이트.
export const SUPPORTED_MANIFEST_SCHEMA = 1;

// 매니페스트 전체.
//  ★ 최상위는 **passthrough**(미지 키 통과), 중첩은 strict — #1780 v2 §7-1 전방호환(설계 R2-C4).
//   v2 코어가 `runtime`·`triggers`·`config` 같은 최상위 키를 더한 매니페스트를 설치한 뒤 이 코어로 **롤백**하면
//   저장된 매니페스트가 grant 시점에 다시 파싱된다(capabilities/apps.ts) — strict 면 거기서 400 → 동의 불가·
//   빌트인 앱 failed. 최상위 미지 키는 "이 코어가 모르는 선언" 일 뿐 위험이 아니므로 통과시키고, 중첩(permissions 등)
//   은 오타가 곧 권한 오해라 종전대로 거부한다. 미지 키는 값 그대로 보존된다(재저장 시 유실 없음).
export const appManifestSchema = z.object({
  // 편집기 자동완성용 관례 키 — 값은 쓰지 않는다.
  //  앱 개발자가 "$schema": "<게이트웨이>/ui/lively-app.schema.json" 를 적으면 VS Code 등이 그 자리에서 검증해 준다.
  $schema: z.string().max(500).optional(),
  // 매니페스트 스키마 버전 — 없으면 1. 파싱은 어떤 정수든 받고(롤백 재파싱 안전), 설치는 assertInstallableManifest 가
  //  SUPPORTED_MANIFEST_SCHEMA 초과를 거부한다("이 코어가 모르는 버전" 을 절반만 전개하지 않게).
  schema_version: z.number().int().min(1).default(1),
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
  //  #4481 앱 v2-2 — 여러 파일 앱의 화면 폴더(web.root — 패키지 안 상대경로 · 예: "dist" · 패키지 맨 위면 "."). 주면 그 폴더의 파일 **전부**를
  //   앱 주소(<앱>-<워크스페이스>.lvly.app)에서 그 경로 그대로 낸다(빌드 산출물 · 이미지 · 폰트). 화면 entry 는 이 폴더 안이어야 한다.
  //   없으면 종전(v1) — 화면은 entry HTML 한 장이고 앱 주소 맨 앞(/) 에만 선다. 판정은 webRootOf.
  //   ★ 최상위 칸에 둔다(ui 안이 아니라) — ui 는 strict 라, 이 칸을 모르는 옛 코어로 되돌리면 여러 파일 앱의 매니페스트를 아예 못 읽는다.
  //    최상위는 passthrough 라 옛 코어는 이 칸을 모르는 채 무시한다(그 앱을 화면 한 장 앱으로 본다 — 격리 리뷰 롤백 메모).
  //    web 안도 같은 까닭으로 passthrough — 다음 단계(v2-5 서버 등)가 web 에 칸을 더한 뒤 이 코어로 되돌려도 읽힌다.
  //  #4482 앱 v2-3 — 앱 주소 iframe 에 넘길 장치 권한(web.devices). 선언한 앱의 iframe 에만 `allow` 로 위임한다(상민님 2026-10-16 «선언한 앱만»):
  //   크롬 · 파이어폭스는 iframe 의 권한을 **맨 위 사이트(워크스페이스 주소) 이름**으로 받고 한 번 허용하면 같은 워크스페이스의 다른 앱 iframe 도
  //   다시 묻지 않고 쓴다 — 늘 위임하면 한 앱에 준 마이크를 다른 앱이 몰래 쓴다. 클립보드 쓰기 · 전체 화면 · 공유는 늘 위임한다(사람이 누를 때만 돈다).
  //   permissions(strict)가 아니라 web(passthrough)에 두는 까닭은 web.root 와 같다 — 이 칸을 모르는 옛 코어로 되돌려도 매니페스트가 읽힌다.
  web: z.object({
    root: z.string().min(1).max(512).optional(),
    devices: z.array(z.enum(APP_DEVICES)).max(APP_DEVICES.length).optional(),
  }).passthrough().optional(),
  // 실행 인스턴스 정책. 기존 v1 앱은 optional+multiple 로 해석해 무회귀.
  instances: instancesSchema,
  // builtin/system app 만 소비하는 셸 renderer 선언. 설치 파서는 보존하고 실행 경계가 source.kind 로 제한한다.
  system: systemSchema,
  runtime: runtimeSchema,
  csp: cspSchema,
  jobs: z.array(jobSchema).default([]),
  data: z.object({ tables: z.array(dataTableSchema).default([]) }).strict().default({}),
  sections: z.array(sectionSchema).default([]),
  agent: agentSchema,
}).passthrough();

export type LivelyAppManifest = z.infer<typeof appManifestSchema>;

/** 선언한 장치 권한(중복 · 모르는 값은 버린다). 저장된 매니페스트를 읽는 자리라 던지지 않는다. */
export function webDevicesOf(manifest: unknown): AppDevice[] {
  const raw = (manifest as { web?: { devices?: unknown } } | null)?.web?.devices;
  if (!Array.isArray(raw)) return [];
  return APP_DEVICES.filter((d) => raw.includes(d));
}

/**
 * #4481 여러 파일 앱의 화면 폴더 — 패키지 기준 정규 상대경로(맨 위면 ""). v1 앱(web.root 없음)이면 null. 모양이 틀리면 null(설치 관문은
 *  loader 가 400 으로 막는다 — 여기는 저장된 매니페스트를 읽는 자리라 던지지 않는다).
 */
export function webRootOf(manifest: unknown): string | null {
  const raw = (manifest as { web?: { root?: unknown } } | null)?.web?.root;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  if (s.includes("\\") || s.includes("\0") || s.startsWith("/")) return null;
  const parts = s.split("/").filter((x) => x !== "" && x !== ".");
  if (parts.some((x) => x === ".." || x.startsWith("."))) return null;
  return parts.join("/");
}

/**
 * 설치 게이트 — 파싱은 통과했지만 이 코어가 **설치**하기엔 너무 새로운 매니페스트를 거부한다(400).
 *  재파싱(grant·표시)은 이걸 부르지 않는다: 이미 설치된 것은 버전과 무관하게 계속 읽혀야 한다(롤백 안전).
 */
export function assertInstallableManifest(m: LivelyAppManifest): void {
  if (m.schema_version > SUPPORTED_MANIFEST_SCHEMA) {
    throw new HttpError(400,
      `매니페스트 오류 [schema_version]: ${m.schema_version} 은 이 코어가 지원하지 않는 버전입니다(지원: ≤${SUPPORTED_MANIFEST_SCHEMA}) — 코어를 업데이트하세요`);
  }
}

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

  // #1891 — `notifications: true` 는 `app_notify` 도구를 **함의한다**.
  //  앱 토큰의 도구 allowlist(permissions.tools)가 비면 lively 툴이 0개라, 알림 권한만 선언한 앱은
  //  정작 app_notify 를 못 부른다(dev 실측: 403 "앱 권한 밖"). 개발자가 같은 뜻을 두 군데 적게 하는 대신
  //  여기서 파생한다 — 사람에게 보이는 권한은 '알림'이고, 도구 이름은 배관이다.
  if (m.permissions.notifications && !m.permissions.tools.includes(NOTIFY_TOOL)) {
    m.permissions.tools = [...m.permissions.tools, NOTIFY_TOOL];
  }
  // #4594 — `chat_send: true` 는 `app_chat_send` 도구를 함의한다(알림과 같은 규약 — 사람에게 보이는 권한은 「세션에 글 보내기」, 도구 이름은 배관).
  if (m.permissions.chat_send && !m.permissions.tools.includes(CHAT_SEND_TOOL)) {
    m.permissions.tools = [...m.permissions.tools, CHAT_SEND_TOOL];
  }
  // #4592 — `project_files: ["html"]` 은 `app_project_files` 도구를 함의한다(같은 규약 — 사람에게 보이는 권한은 「프로젝트 자료에서 파일 읽기」).
  if (m.permissions.project_files.length && !m.permissions.tools.includes(PROJECT_FILES_TOOL)) {
    m.permissions.tools = [...m.permissions.tools, PROJECT_FILES_TOOL];
  }
  // #4629 — `workspace_files: ["html"]` 은 `app_workspace_files` 도구를 함의한다(같은 규약 — 사람에게 보이는 권한은 「전체 자료에서 파일 읽기」).
  if (m.permissions.workspace_files.length && !m.permissions.tools.includes(WORKSPACE_FILES_TOOL)) {
    m.permissions.tools = [...m.permissions.tools, WORKSPACE_FILES_TOOL];
  }
  // #4673 — `app_folder: true` 는 `file_url` 도구를 함의한다(같은 규약 — 사람에게 보이는 권한은 「앱 폴더에 파일을 올리고 받기」).
  if (m.permissions.app_folder && !m.permissions.tools.includes(FILE_URL_TOOL)) {
    m.permissions.tools = [...m.permissions.tools, FILE_URL_TOOL];
  }

  // scope 상한 — 허용 scope 안이면서 앱 금지 scope(admin·runtime)가 아니어야 한다.
  for (const s of m.permissions.scopes) {
    if (!SCOPES_ALLOWED.has(s)) throw new HttpError(400, `매니페스트 오류 [permissions.scopes]: 알 수 없는 scope '${s}'`);
    if (APP_FORBIDDEN_SCOPES.has(s)) throw new HttpError(400, `매니페스트 오류 [permissions.scopes]: '${s}' 는 앱이 요청할 수 없는 scope 입니다(관리·런타임)`);
  }

  // connect_domains 의 `*` 는 거부한다 — 프레임(남의 페이지를 보여줌)과 달리 connect 는 **우리 안의 데이터를
  //  임의 서버로 보내는 통로**다. 넓게 열고 싶다는 선언을 그대로 받아 주면 동의 화면이 의미를 잃는다.
  if (m.csp.connect_domains.includes("*")) {
    throw new HttpError(400, "매니페스트 오류 [csp.connect_domains]: '*' 는 허용되지 않습니다 — 연결할 호스트를 명시하세요");
  }

  // UI/잡/자산 key 중복 거부(같은 표면 안에서).
  assertUniqueKeys("ui.pages", m.ui.pages.map((p) => p.key));
  assertUniqueKeys("ui.widgets", m.ui.widgets.map((w) => w.key));
  assertUniqueKeys("jobs", m.jobs.map((j) => j.key));
  assertUniqueKeys("data.tables", m.data.tables.map((t) => t.name));
  // #4226 인덱스 칸은 그 테이블의 칸이어야 한다 — 없는 칸이면 설치 때 DDL 이 실패해 원인이 흐려진다.
  // #4483 칸 타입·제약·구조 변경 — 모양만 여기서(DB 없이). 검사 식의 뜻(칸·함수)은 설치 때 검사기가 본다.
  const tableNames = new Set(m.data.tables.map((t) => t.name));
  for (const t of m.data.tables) {
    const where = (c: string) => `매니페스트 오류 [data.tables.${t.name}.columns.${c}]`;
    const names = new Set<string>();
    for (const c of t.columns) {
      if (names.has(c.name)) throw new HttpError(400, `${where(c.name)}: 같은 칸 이름이 두 번 있습니다`);
      names.add(c.name);
      const ty = parseColumnType(c.type);                                   // 400 — 허용 밖 타입·범위
      if (ty.enum !== (c.values !== undefined)) throw new HttpError(400, `${where(c.name)}: enum 타입에는 values 를, values 는 enum 에만 씁니다`);
      if (c.values && new Set(c.values).size !== c.values.length) throw new HttpError(400, `${where(c.name)}: values 에 같은 값이 두 번 있습니다`);
      if (c.default !== undefined && c.default_expr !== undefined) throw new HttpError(400, `${where(c.name)}: default 와 default_expr 은 함께 쓸 수 없습니다`);
      if (c.default_expr !== undefined && !Object.hasOwn(DEFAULT_EXPRS, c.default_expr.toLowerCase())) {
        throw new HttpError(400, `${where(c.name)}: default_expr 은 ${Object.keys(DEFAULT_EXPRS).join(" · ")} 중 하나입니다(값은 default 에 JSON 으로)`);
      }
      if (c.default !== undefined) defaultLiteralText(c.default, ty);      // 400 — 형과 맞지 않는 기본값 모양
      if (c.values && c.default !== undefined && c.default !== null && !c.values.includes(String(c.default))) {
        throw new HttpError(400, `${where(c.name)}: default '${String(c.default)}' 가 values 에 없습니다`);
      }
      if (c.references) {
        if (!tableNames.has(c.references.table)) throw new HttpError(400, `${where(c.name)}: references.table '${c.references.table}' 는 이 앱이 선언한 테이블이 아닙니다`);
        if (!ty.integer) throw new HttpError(400, `${where(c.name)}: references 칸은 정수형(int · bigint · int4 · smallint)이어야 합니다 — 가리키는 표의 id 와 맞춥니다`);
        if (c.references.on_delete === "set null" && c.not_null) throw new HttpError(400, `${where(c.name)}: on_delete 'set null' 과 not_null 은 함께 쓸 수 없습니다`);
      }
      if (c.renamed_from !== undefined && (c.renamed_from === c.name || t.columns.some((o) => o.name === c.renamed_from))) {
        throw new HttpError(400, `${where(c.name)}: renamed_from '${c.renamed_from}' 는 지금 선언한 다른 칸과 겹칩니다`);
      }
      if (c.check !== undefined && /;/.test(c.check)) throw new HttpError(400, `${where(c.name)}: check 는 식 하나입니다(세미콜론 없이)`);
    }
    for (const d of t.drop_columns) {
      if (names.has(d)) throw new HttpError(400, `매니페스트 오류 [data.tables.${t.name}.drop_columns]: '${d}' 는 지금 선언한 칸입니다 — 지울 칸만 적으세요`);
      if (["id", "created_at", "tenant_id"].includes(d)) throw new HttpError(400, `매니페스트 오류 [data.tables.${t.name}.drop_columns]: 시스템 칸 '${d}' 는 지울 수 없습니다`);
    }
    for (const ck of t.checks) if (/;/.test(ck)) throw new HttpError(400, `매니페스트 오류 [data.tables.${t.name}.checks]: 식 하나씩(세미콜론 없이)`);
  }
  for (const t of m.data.tables) {
    const cols = new Set(["id", "created_at", ...t.columns.map((c) => c.name)]);
    const seen = new Set<string>();
    for (const ix of t.indexes) {
      for (const c of ix.columns) {
        if (!cols.has(c)) throw new HttpError(400, `매니페스트 오류 [data.tables.${t.name}.indexes]: '${c}' 는 이 테이블의 칸이 아닙니다`);
      }
      if (new Set(ix.columns).size !== ix.columns.length) throw new HttpError(400, `매니페스트 오류 [data.tables.${t.name}.indexes]: 같은 칸을 두 번 적었습니다(${ix.columns.join(", ")})`);
      const key = `${ix.unique ? "u" : "i"}:${ix.columns.join(",")}`;
      if (seen.has(key)) throw new HttpError(400, `매니페스트 오류 [data.tables.${t.name}.indexes]: 같은 인덱스가 두 번 있습니다(${ix.columns.join(", ")})`);
      seen.add(key);
    }
  }
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

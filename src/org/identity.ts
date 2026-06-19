// 훅 id / 툴 name 식별자 — 단일 엄격 검증 + 예약어/빌트인 충돌 거부 (B6/B7).
// 이 식별자는 멤버 머신의 settings.json 마커 · codex TOML 키 · `claude mcp` 인자로 흐른다.
// 따라서 ASCII·길이상한을 강제하고(파일경로/키 주입 차단), 내장 훅/빌트인 툴 이름과의 충돌을 거부한다.
import { HttpError } from "../capabilities/rest-util.js";

// 소문자 영숫자로 시작, 영숫자/_/- 1~64자. 한글·대문자·공백·점 불가.
export const STRICT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// 내장 훅 3종(런타임 토글로 별도 관리) + 런너 자체 — 커스텀 훅 id 로 못 쓴다(마커/언인스톨 충돌 방지).
export const RESERVED_HOOK_IDS: ReadonlySet<string> = new Set([
  "session-preload", "work-flag", "stop-writeback-gate",
  "session_preload", "work_flag", "stop_writeback_gate", "run-custom",
]);

// 게이트웨이가 노출하는 빌트인 MCP 툴 이름 — 동적 org_tool(http_proxy) 이름이 이들을 섀도잉하지 못하게.
// (org_tool kind='builtin' 게이팅 행은 이 이름을 '참조'하는 것이라 예외 — store.upsertTool 에서 분기.)
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "me",
  // search_items/get_item 폐기(item 흡수 → ctx_ls/ctx_grep/ctx_cat). 매핑 큐레이션 3종은 유지.
  "list_unmapped", "mapping_candidates", "curate_item_mapping",
  "domain_list", "domain_get", "domain_deprecate", "project_list", "repo_list", "debt_list",
  "db_query", "db_schema", "context_overview", "propose_domain",
  "pm_task_create", "pm_task_update_status", "pm_task_assign", "pm_task_comment", "pm_task_link", "pm_task_archive",
  "memory_save", "memory_search", "memory_get",
]);

export function assertHookId(id: unknown): string {
  if (typeof id !== "string") throw new HttpError(400, "id 는 문자열이어야 합니다");
  const s = id.trim().toLowerCase();
  if (!STRICT_SLUG.test(s)) throw new HttpError(400, "id 는 소문자 영숫자/_/- 1~64자(소문자·숫자로 시작)여야 합니다");
  if (RESERVED_HOOK_IDS.has(s)) throw new HttpError(400, `id '${s}' 는 예약어입니다(내장 훅과 충돌)`);
  return s;
}

// kind='builtin' 게이팅 행은 빌트인 이름을 참조하므로 충돌 검사를 건너뛴다.
export function assertToolName(name: unknown, kind: string): string {
  if (typeof name !== "string") throw new HttpError(400, "name 은 문자열이어야 합니다");
  const s = name.trim().toLowerCase();
  if (!STRICT_SLUG.test(s)) throw new HttpError(400, "name 은 소문자 영숫자/_/- 1~64자(소문자·숫자로 시작)여야 합니다");
  if (kind !== "builtin" && RESERVED_TOOL_NAMES.has(s)) {
    throw new HttpError(400, `name '${s}' 는 빌트인 도구와 충돌합니다 — 다른 이름을 쓰세요`);
  }
  if (kind === "builtin" && !RESERVED_TOOL_NAMES.has(s)) {
    throw new HttpError(400, `'${s}' 는 빌트인 도구가 아닙니다(kind=builtin 은 빌트인 토글 전용)`);
  }
  return s;
}

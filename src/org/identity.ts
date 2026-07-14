// 훅 id / 툴 name 식별자 — 단일 엄격 검증 + 예약어/빌트인 충돌 거부 (B6/B7).
// 이 식별자는 멤버 머신의 settings.json 마커 · codex TOML 키 · `claude mcp` 인자로 흐른다.
// 따라서 ASCII·길이상한을 강제하고(파일경로/키 주입 차단), 내장 훅/빌트인 툴 이름과의 충돌을 거부한다.
import { HttpError } from "../capabilities/rest-util.js";
import { isBuiltinToolName } from "../capabilities/mcp-surface.js";

// 소문자 영숫자로 시작, 영숫자/_/- 1~64자. 한글·대문자·공백·점 불가.
export const STRICT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// 내장 훅(런타임 토글로 별도 관리) + 런너·업데이터 자체 — 커스텀 훅 id 로 못 쓴다(마커/언인스톨 충돌 방지).
export const RESERVED_HOOK_IDS: ReadonlySet<string> = new Set([
  "session-preload", "work-flag", "stop-writeback-gate",
  "session_preload", "work_flag", "stop_writeback_gate", "run-custom",
  "self-update", "self_update", "sync-harness-assets", "sync_harness_assets",
]);

// 게이트웨이 빌트인 MCP 툴 이름은 부팅 시 mcp-surface(registry capability + db 직접등록)에 주입된다 — isBuiltinToolName 으로 조회.
// (하드코딩 RESERVED_TOOL_NAMES 폐기 2026-06-24: 실제 MCP 표면과 어긋나 stale 였음. http_proxy 이름이 빌트인을 섀도잉
//  못하게 차단 + kind='builtin' 게이팅 행은 빌트인 이름을 '참조'하는 것이라 존재해야 함을 검증.)

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
  if (kind !== "builtin" && isBuiltinToolName(s)) {
    throw new HttpError(400, `name '${s}' 는 빌트인 도구와 충돌합니다 — 다른 이름을 쓰세요`);
  }
  if (kind === "builtin" && !isBuiltinToolName(s)) {
    throw new HttpError(400, `'${s}' 는 빌트인 도구가 아닙니다(kind=builtin 은 빌트인 토글 전용)`);
  }
  return s;
}

// 하네스 자산 id(스킬/서브에이전트/커맨드) — 멤버 디스크에 디렉터리/파일명으로 흐른다
//  (~/.claude/skills/<id>/SKILL.md · ~/.claude/agents/<id>.md · ~/.claude/commands/<id>.md).
//  STRICT_SLUG 가 `/`·`.`·`..`·절대경로·공백을 원천 차단 → materializer 경로 traversal 방어의 1차선(클라가 2차 재검증).
export function assertAssetId(id: unknown): string {
  if (typeof id !== "string") throw new HttpError(400, "id 는 문자열이어야 합니다");
  const s = id.trim().toLowerCase();
  if (!STRICT_SLUG.test(s)) throw new HttpError(400, "id 는 소문자 영숫자/_/- 1~64자(소문자·숫자로 시작)여야 합니다");
  return s;
}

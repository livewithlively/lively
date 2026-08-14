// delivery ▸ shared — 도메인 파일들이 공유하는 로컬 팩토리(restOnly/restWork/restRead/restRuntime)와
//  입력 검증 헬퍼. delivery.ts 에서 verbatim 이동(#1313 R26) — 인자 순서·기본값은 원문 그대로다.
import type { Capability, CapabilityCtx } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import type { AssetPrefKind, WriteCtx } from "../../org/store.js";

// 감사 actor 는 안정 식별자(userId) 우선 — email 은 변동/위조 가능(B23).
export const actorOf = (u: LivelyUser): string => u?.userId || u?.email || "unknown";

// admin capability 공통 팩토리 — REST + MCP 양쪽 노출(#549: mcp=true). scope=admin.
//  input:{} — 파라미터 스키마는 비어 있고(REST parse/handler 가 검증), 에이전트는 description 으로 인자를 판단한다.
export const restOnly = (name: string, title: string, description: string,
  rest: Capability["expose"]["rest"], handler: Capability["handler"], input: Capability["input"] = {}): Capability =>
  ({ name, title, description, scope: "admin", input, expose: { mcp: true, rest }, handler });

// 워킹레벨(memory) — 조직 '정책'이 아니라 팀이 일상적으로 굴리는 설정. admin 을 요구하면 실무자가 자기 팀
//  채널의 증류 기준 하나 못 고치고 관리자를 기다려야 한다(#1289 요구: "누구나 관리"). 파괴 반경도 조직 단위가
//  아니다 — 잘못 만들어도 지식이 검토 게이트(#638)를 거치고, 산출은 자료 링크로 추적·되돌리기가 된다.
//  mutates: capMutates 는 REST 에 POST 가 있으면 쓰기로 파생한다. 몸통이 커서(수천 자 draft) GET 쿼리로는
//   못 보내는 **읽기 전용** op 은 여기서 false 를 명시한다 — 안 하면 읽기전용 세션이 조회조차 못 한다.
export const restWork = (name: string, title: string, description: string,
  rest: Capability["expose"]["rest"], handler: Capability["handler"], input: Capability["input"] = {},
  mutates?: boolean): Capability =>
  ({ name, title, description, scope: "memory", input, expose: { mcp: true, rest }, handler,
    ...(mutates === undefined ? {} : { mutates }) });

// 읽기 전용(read) — scope null = 인증만. 비-admin 구성원도 공유 컨텍스트를 읽을 수 있게(핸들러가 admin 여부로 민감 필드 redact).
//  mcp 기본 false(공유 읽기는 웹/REST 표면) — 관리 대시보드 조회(org_overview)만 mcp=true 로 열어 에이전트가 상태를 본다(#549).
export const restRead = (name: string, title: string, description: string,
  rest: Capability["expose"]["rest"], handler: Capability["handler"], mcp = false, input: Capability["input"] = {}): Capability =>
  ({ name, title, description, scope: null, input, expose: { mcp, rest }, handler });

// runtime 권한 — 멤버 머신에서 실행되는 것(커스텀 훅·MCP 툴)을 정의. admin 과 분리(admin ⊉ runtime).
//  #549: REST + MCP 양쪽 노출(과거 mcp=false 로 에이전트가 스스로 훅/툴을 못 만들게 했으나, 이제 에이전트도 다룰 수 있게).
//  안전판: 회수 가능한 DB 토큰 + runtime scope(멤버 LIVE 교집합) 필요 — 정적 토큰·미보유자는 거부.
export const restRuntime = (name: string, title: string, description: string,
  rest: Capability["expose"]["rest"], handler: Capability["handler"], input: Capability["input"] = {}): Capability =>
  ({ name, title, description, scope: "runtime", input, expose: { mcp: true, rest }, handler });

// 쓰기 감사 맥락 — actor(userId)·토큰해시·IP 를 store 로 전달(B23).
export const wctx = (u: LivelyUser, ctx?: CapabilityCtx): WriteCtx =>
  ({ actor: actorOf(u), source: ctx?.source ?? "web", tokenHashPrefix: ctx?.tokenHashPrefix ?? null, ip: ctx?.ip ?? null });

// 훅·자산의 타깃 하네스. ⚠ **세 곳이 한 목록을 공유한다** — 여기 · DB CHECK 제약(org/schema/mcp-tools.ts 의
//  org_hook_harness_chk · org_harness_asset_harness_chk) · kit 의 harness-registry.mjs(HARNESS_IDS).
//  하나만 늘리면 조용히 어긋난다: enum 만 늘리면 DB 가 400 대신 23514 로 거절하고, DB 만 늘리면 API 가 막는다.
//  (`all` 은 하네스가 아니라 '전 하네스' 와일드카드라 kit 목록엔 없다.)
export const HOOK_HARNESSES = new Set(["claude", "codex", "openclaw", "opencode", "antigravity", "all"]);
// 에러 문구는 목록에서 파생한다 — 종전엔 세 파일에 "claude|codex|openclaw|all" 이 하드코딩돼 있어,
//  값을 늘려도 사용자는 옛 목록을 안내받았다(무엇이 허용되는지 화면이 거짓말하는 상태).
export const HOOK_HARNESSES_MSG = `harness 는 ${[...HOOK_HARNESSES].join("|")}`;
export const HARNESS_ASSET_KINDS = new Set(["skill", "subagent", "command"]); // 하네스 자산 종류(스킬·서브에이전트·슬래시커맨드)

// str·slug·assertEmail 은 http/rest-util 로 승격(#1313 R46) — delivery 밖(capabilities/*)에서도 같은 검증이
//  필요해 복붙이 번지던 것을 단일 정의로 수렴했다. 여기선 재수출만 남긴다(delivery 도메인 파일들 import 무수정).
export { str, slug, assertEmail } from "../rest-util.js";

// 하네스 자산 target_members — null/빈=전원, 배열=그 멤버 id 만(per-member 타깃팅). 멤버 id 슬러그 검증.
export function parseTargetMembers(raw: unknown): string[] | null | undefined {
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
export function assertPrefKind(raw: unknown): AssetPrefKind {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s !== "harness_asset" && s !== "org_hook") throw new HttpError(400, "target_kind 는 harness_asset|org_hook 이어야 합니다");
  return s;
}

// 자산 frontmatter — 평탄 키:값 맵만(스킬/에이전트/커맨드 YAML frontmatter 로 materialize). 값=문자열·불리언·숫자·문자열배열.
//  중첩객체 금지(YAML 주입·복잡도 차단). 키 32개·키길이 64 상한. description 은 별도 컬럼이므로 여기선 부가필드(when_to_use·tools·model·allowed-tools·argument-hint 등)용.
export function parseAssetFrontmatter(raw: unknown): Record<string, unknown> {
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

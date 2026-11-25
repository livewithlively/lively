// MCP 툴 표면 후보 — 부팅 시 registry(capabilities/index) + db 직접등록(tools/db)에서 추출해 주입한다.
// identity/delivery 가 registry 를 직접 import 하면 순환(capabilities/index → delivery·identity)이라,
// registry 를 import 하지 않는 경량 보관소로 분리해 주입(setToolCandidates)받는다.
//
// expose 결정 모델(단일 SoT 위의 운영자 override):
//  - defaultExposed = 코드 기본값(capability.expose.mcp; db 직접등록은 항상 true).
//  - 최종 노출 = org_tool(kind='builtin') 행이 있으면 그 enabled, 없으면 defaultExposed.
//  - 즉 운영자가 웹에서 미노출(false)을 켜거나(true) 노출을 끌 수 있다(양방향).
export interface ToolCandidate {
  name: string;
  title: string;
  description: string;     // MCP description — 하네스(에이전트)가 tools/list 에서 보는 설명(언제 이 도구를 쓸지 판단하는 근거).
  defaultExposed: boolean; // 코드 기본값(expose.mcp). 운영자 override(org_tool)가 최종 결정.
  kind: "capability" | "db";
  inputSchema?: unknown;   // MCP inputSchema(JSON Schema) — 하네스가 보는 입력 필드/타입. zod→JSON Schema 변환(SDK 와 동일 표면).
  alwaysLoadDefault?: boolean; // 코드 기본 주입모드(cap.meta 의 anthropic/alwaysLoad). 운영자 override(org_tool.always_load)가 최종 결정. 웹 토글의 '기본' 표시용(#187).
  autoApproveDefault?: boolean; // 행이 없을 때의 자동승인 기본값(builtinAutoApproveDefault). 웹 토글의 초기값 — 저장하면 이 값이 행에 실린다.
}

// 행이 없을 때도 자동승인하지 않는 builtin — NAS 파일을 지우거나 덮는 도구(FTP 에는 휴지통이 없다).
//  이 판정의 출처는 여기 하나다. 자동승인 목록(org/delivery/auto-approve.ts)·행 저장 기본값(org/store/tools.ts upsertTool)·
//  관리 화면 초기값(후보의 autoApproveDefault)이 같이 쓴다 — 한 곳이라도 따로 true 를 기본으로 두면, 노출만 바꾼 저장이 자동승인 행을 만든다.
//  운영자가 org_tool 행의 auto_approve 를 명시로 켜면 그 값을 따른다.
export const CONFIRM_BY_DEFAULT_BUILTINS: ReadonlySet<string> = new Set(["nas_manage"]);
export function builtinAutoApproveDefault(name: string): boolean {
  return !CONFIRM_BY_DEFAULT_BUILTINS.has(name);
}

let _candidates: ToolCandidate[] = [];

// 부팅 시 1회 주입(src/index.ts). registry 는 정적이라 import 시점에 확정된다.
export function setToolCandidates(candidates: ToolCandidate[]): void {
  _candidates = candidates;
}

// 웹(org_tools)·검증(org_tool_upsert)이 참조하는 전체 후보 목록.
export function toolCandidates(): ToolCandidate[] {
  return _candidates;
}

// 이 이름이 게이트웨이 빌트인 MCP 툴인가 — http_proxy 섀도잉 차단 + builtin 토글 대상 검증.
export function isBuiltinToolName(name: string): boolean {
  return _candidates.some((c) => c.name === name);
}

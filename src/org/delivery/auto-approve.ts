// 라이블리가 직접 제공하는 MCP 도구의 하네스 자동승인 목록.
//
// lively 본체는 capability registry(toolCandidates)가 현재 제공 도구의 단일 출처다. org_tool 행은
// 운영자 override 이므로, 행이 없으면 src/mcp/mcp-surface.ts 의 builtinAutoApproveDefault 를 따르고 명시 행은 그대로 존중한다.
// lively-local 은 게이트웨이 registry 밖의 별도 stdio 서버라 여기서 이름을 함께 관리한다. 아래 목록과
// kit/cli/lively-mcp-local.mjs 의 TOOLS 배열이 어긋나지 않는지는 계약 테스트가 막는다.
import { toolCandidates, builtinAutoApproveDefault, type ToolCandidate } from "../../mcp/mcp-surface.js";
import { listTools, type OrgTool } from "../store.js";

export const LIVELY_LOCAL_TOOL_NAMES = [
  "lively_local_nas_pull",
  "lively_local_nas_push",
  "lively_local_project_init",
  "lively_local_repo_list",
  "lively_local_repo_pin",
  "lively_local_repo_pin_remove",
  "lively_local_repo_worktree",
  "lively_local_repo_worktree_remove",
] as const;

// 사람 확인을 받는 도구 — 위 목록(=TOOLS 계약)에는 남기고 자동승인에서만 뺀다. 로컬 파일을 밖(NAS)으로 내보내는 도구라,
//  NAS 문서나 웹 페이지에 심은 지시가 ~/.ssh·~/.aws 같은 파일을 승인 없이 올리게 하지 못하게 한다(nas-push-core.mjs 의 경로 경계와 겹으로).
export const LIVELY_LOCAL_CONFIRM_TOOL_NAMES: ReadonlySet<string> = new Set(["lively_local_nas_push"]);

// 행이 없을 때 자동승인하지 않는 builtin 은 mcp-surface.ts 의 builtinAutoApproveDefault 가 정한다(행 저장 기본값·관리 화면과 같은 출처).
export { CONFIRM_BY_DEFAULT_BUILTINS } from "../../mcp/mcp-surface.js";

type AutoApproveRow = Pick<OrgTool, "name" | "kind" | "enabled" | "auto_approve" | "level">;
type AutoApproveCandidate = Pick<ToolCandidate, "name" | "defaultExposed">;

export function resolveAutoApproveToolIds(
  candidates: readonly AutoApproveCandidate[],
  rows: readonly AutoApproveRow[],
): string[] {
  const allow = new Set<string>();
  const builtinOverrides = new Map(rows.filter((row) => row.kind === "builtin").map((row) => [row.name, row]));

  // 조직 정의 HTTP 프록시와 명시된 builtin override 는 기존 정책을 그대로 따른다.
  for (const row of rows) {
    if (row.enabled && row.auto_approve && row.level !== "L2") allow.add(`mcp__lively__${row.name}`);
  }

  // 새로 추가된 Lively builtin 은 별도 DB 시드 행을 기다리지 않고 곧바로 기본 자동승인된다.
  // 운영자가 한번이라도 토글해 행이 생겼다면 위의 명시값이 이 기본값을 이긴다.
  for (const candidate of candidates) {
    if (!builtinOverrides.has(candidate.name) && candidate.defaultExposed && builtinAutoApproveDefault(candidate.name)) {
      allow.add(`mcp__lively__${candidate.name}`);
    }
  }

  // 로컬 서버는 게이트웨이 DB와 무관하게 설치되는 Lively 제공 표면이므로 사람 확인 도구만 빼고 기본 승인한다.
  for (const name of LIVELY_LOCAL_TOOL_NAMES) if (!LIVELY_LOCAL_CONFIRM_TOOL_NAMES.has(name)) allow.add(`mcp__lively-local__${name}`);

  return [...allow].sort();
}

export async function listAutoApproveToolIds(): Promise<string[]> {
  return resolveAutoApproveToolIds(toolCandidates(), await listTools());
}

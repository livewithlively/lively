// 작업별 «라이블리 MCP 만»(ai.mcp_only) — 매니페스트에 적힌 작업 이름을 «부른 사람의 판» 에서 읽어, 그 이름으로 도는 에이전트 작업의 내장 도구를 끈다.
//
//  왜 필요한가: 에이전트 작업은 권한 묻기 없이 하네스 내장 도구(셸 · 파일 · 웹)를 다 쥐고 돈다(runner.claudeJobArgv). 앱 토큰은 라이블리 MCP 만 좁히고
//   박스의 파일은 좁히지 않아, 실행 계정이 읽을 수 있는 다른 프로젝트 · 앱 폴더까지 닿는다. 앱이 준 도구만 써야 하는 작업은 내장 도구를 꺼야 한다.
//  어느 판: 앱 판 지시(app-job-instructions)와 같은 규칙(app-view.viewAppFor) — 초안을 고친 사람은 초안 · 나머지는 공개 판 · 앱 주소 · 앱 서버로 들어온
//   호출은 그 주소의 판. 부르는 쪽(ai-runs/service.submitRun)이 **접수 때 한 번** 읽어 작업 행에 적는다(agent-jobs store mcp_only) — 접수 뒤 판이
//   바뀌어도 그 실행은 접수 때의 값으로 돈다(형식 재시도는 앞 작업 행의 값 · 이어받기는 앞 작업 행이나 지금 판 중 하나라도 MCP 만이면 MCP 만).
//  앱을 볼 수 없으면 던진다 — 값을 모른 채 돌리지 않는다(닫힌 쪽). 이름이 선언한 작업인지는 설치 · 판 저장 때 loader(checkAiMcpOnly)가 본다.
import { HttpError } from "../http-error.js";
import type { OrgApp } from "../org/store/apps.js";
import { hasPendingDraft, type Viewer } from "./visibility.js";

/** (순수) 그 작업 이름이 ai.mcp_only 에 있나. 저장된 매니페스트를 읽는 자리라 던지지 않는다. */
export function mcpOnlyOf(manifest: unknown, job: string | null | undefined): boolean {
  if (!job) return false;
  const list = (manifest as { ai?: { mcp_only?: unknown } } | null)?.ai?.mcp_only;
  return Array.isArray(list) && list.includes(job);
}

/** 읽기에 쓰는 바깥 일 — 시험이 바꿔 끼운다. */
export interface McpOnlyDeps {
  viewAppFor(app: OrgApp, who: Viewer): Promise<{ view: string; app: OrgApp }>;
}

/**
 * 그 사람(주소)의 판에서 그 작업이 «라이블리 MCP 만» 인지 읽는다 — 앱을 볼 수 없으면 404.
 *  설치된 매니페스트가 선언하지 않았고 따로 볼 초안도 없는 앱은 판을 읽지 않는다(그 사람이 볼 판도 같은 매니페스트다 · app-job-instructions 와 같다).
 */
export async function resolveJobMcpOnly(app: OrgApp, who: Viewer, job: string | null | undefined, deps?: McpOnlyDeps): Promise<boolean> {
  if (!job) return false;
  if (!mcpOnlyOf(app.manifest, job) && !hasPendingDraft(app)) return false;
  const d = deps ?? { viewAppFor: (await import("./app-view.js")).viewAppFor };
  const { view, app: shown } = await d.viewAppFor(app, who);
  if (view === "none") throw new HttpError(404, `앱 없음: ${app.id}`);
  return mcpOnlyOf(shown.manifest, job);
}

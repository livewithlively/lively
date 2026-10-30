// 작업별 라이블리 도구 허용 목록(ai.tools) — 매니페스트에 적힌 목록을 «부른 사람의 판» 에서 읽어, 그 이름으로 도는 에이전트 작업의
//  라이블리 신원(작업 토큰)에 도구 상한으로 싣는다.
//
//  왜 필요한가: 앱 AI 작업의 라이블리 MCP 토큰은 앱 토큰이라 도구가 그 앱의 동의 목록 전체다(agent-jobs/live.mintMcpToken → principal.mintAppToken).
//   앱 서버가 쓰려고 동의에 넣은 도구(앱 표 SQL 등)를 에이전트도 쓸 수 있어, 질문에 숨긴 지시로 앱의 데이터가 바뀔 수 있다. 내장 도구를 꺼도
//   (ai.mcp_only) 라이블리 MCP 도구는 남는다. 그래서 작업마다 «이 작업의 에이전트가 쓸 도구»를 허용 목록으로 좁힌다.
//  어느 판: 앱 판 지시 · ai.mcp_only 와 같은 규칙(app-view.viewAppFor). 부르는 쪽(ai-runs/service.submitRun)이 **접수 때 한 번** 읽어 작업 행에 적는다
//   (agent-jobs store tool_allowlist) — 접수 뒤 판이 바뀌어도 그 실행은 접수 때의 목록으로 돈다(형식 재시도는 앞 작업 행의 목록 · 이어받기는
//   앞 작업 행과 지금 판의 목록이 둘 다 있으면 겹치는 것만 — narrowAllowlist).
//  앱을 볼 수 없으면 던진다 — 목록을 모른 채 돌리지 않는다(닫힌 쪽). 이름 · 도구가 맞는지는 설치 · 판 저장 때 loader(checkAiTools)가 본다.
import { HttpError } from "../http-error.js";
import type { OrgApp } from "../org/store/apps.js";
import { hasPendingDraft, type Viewer } from "./visibility.js";

/**
 * (순수) 그 작업 이름의 허용 목록 — 없으면 null(좁히지 않음). 빈 배열은 «도구 없음»이라는 뜻이 있다.
 *  저장된 매니페스트를 읽는 자리라 던지지 않는다 — 그 작업의 목록 모양이 틀리면(배열이 아님 · 글이 아닌 원소) 빈 목록(아무것도 허락하지 않음)으로 닫는다.
 *  ai.tools 자체가 객체가 아니면(이 칸이 생기기 전 passthrough 로 저장된 다른 뜻의 값) 선언이 없는 것으로 본다(종전) — 지금은 매니페스트 읽기가
 *  그런 값을 받지 않는다(manifest.aiSchema).
 */
export function toolsOf(manifest: unknown, job: string | null | undefined): string[] | null {
  if (!job) return null;
  const map = (manifest as { ai?: { tools?: unknown } } | null)?.ai?.tools;
  if (!map || typeof map !== "object" || Array.isArray(map) || !Object.prototype.hasOwnProperty.call(map, job)) return null;
  const list = (map as Record<string, unknown>)[job];
  if (!Array.isArray(list) || list.some((t) => typeof t !== "string")) return [];
  return [...new Set(list as string[])];
}

/**
 * (순수) 두 허용 목록을 조이는 쪽으로 합친다 — 이어받기에서 앞 작업 행의 목록과 지금 판의 목록. 둘 다 있으면 겹치는 것만,
 *  하나만 있으면 그것, 둘 다 없으면 null(좁히지 않음).
 */
export function narrowAllowlist(a: readonly string[] | null, b: readonly string[] | null): string[] | null {
  if (a == null) return b == null ? null : [...b];
  if (b == null) return [...a];
  const keep = new Set(b);
  return a.filter((t) => keep.has(t));
}

/** 읽기에 쓰는 바깥 일 — 시험이 바꿔 끼운다. */
export interface JobToolsDeps {
  viewAppFor(app: OrgApp, who: Viewer): Promise<{ view: string; app: OrgApp }>;
}

/**
 * 그 사람(주소)이 보는 앱 판에서 그 작업의 허용 목록을 읽는다 — 판을 읽었는데 그 사람이 앱을 볼 수 없으면 404.
 *  설치된 매니페스트에 그 작업의 목록이 없고 따로 볼 초안도 없는 앱은 판을 읽지 않고 null 이다(그 사람이 볼 판도 같은 매니페스트다 ·
 *  app-job-mcp-only 와 같다). 볼 수 있는지는 접수(ai-runs/service.submitRun)가 앞에서 이미 본다.
 */
export async function resolveJobTools(app: OrgApp, who: Viewer, job: string | null | undefined, deps?: JobToolsDeps): Promise<string[] | null> {
  if (!job) return null;
  if (toolsOf(app.manifest, job) === null && !hasPendingDraft(app)) return null;
  const d = deps ?? { viewAppFor: (await import("./app-view.js")).viewAppFor };
  const { view, app: shown } = await d.viewAppFor(app, who);
  if (view === "none") throw new HttpError(404, `앱 없음: ${app.id}`);
  return toolsOf(shown.manifest, job);
}

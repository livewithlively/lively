// 크론 액션: 일반 에이전트 태스크(agent_inject·agent_headless) — R16 원문 이동.
import { resolveSessionTmux, injectToSession, headlessRequester, HEADLESS_REQUESTER_MISSING, headlessFlags, enqueueHeadlessTask } from "./_headless.js";

// 일반 에이전트 태스크 — (세션=환경·맥락) × (params.prompt=작업)을 그대로 세션에 주입. 인박스 체크 없음(스케줄될 때마다 수행).
//  (세션=격리 워크스페이스·계정·하네스 = 작업 환경) × (prompt=작업 지시) → 잡마다 완전히 다른 recurring 에이전트 태스크.
//  세션의 claude 가 자기 워크스페이스 맥락 + lively MCP 로 비동기 수행. fire-and-forget(주입까지가 잡 책임).
export async function runAgentInject(params: Record<string, unknown>): Promise<{ status: string; summary: unknown }> {
  const sessionRef = params.session ? String(params.session) : "";
  if (!sessionRef) return { status: "error", summary: { error: "타깃 상시 세션 미설정 — 관리탭 스케줄러에서 상시 세션을 선택하세요." } };
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!prompt) return { status: "error", summary: { error: "params.prompt 미설정 — 잡 입력값에 작업 지시(프롬프트)가 필요합니다.", session: sessionRef } };

  let tmuxSession: string;
  try { tmuxSession = await resolveSessionTmux(sessionRef); }
  catch (e) { return { status: "error", summary: { error: (e as Error)?.message ?? String(e), session: sessionRef } }; }

  try { await injectToSession(tmuxSession, prompt); }
  catch (e) { return { status: "error", summary: { error: "세션 주입 실패(" + tmuxSession + "): " + ((e as Error)?.message ?? String(e)), session: sessionRef, tmux: tmuxSession } }; }
  return { status: "ok", summary: { injected: true, managed_session: sessionRef, tmux: tmuxSession, prompt_chars: prompt.length } };
}

// #1058 agent_inject 의 헤드리스판 — 임의 프롬프트를 헤드리스 claude -p 로. 인박스 체크 없음(스케줄될 때마다 접수).
//  상시세션 tmux 주입 대신 위탁(delegate) 헤드리스 claude -p one-shot 을 배치. fire-and-forget: 접수·배치까지가
//  잡 책임(실행·결과수집은 위탁 스케줄러). 매 실행 fresh 컨텍스트(관성 없음).
export async function runAgentHeadless(params: Record<string, unknown>, jobId: string, createdBy: string | null): Promise<{ status: string; summary: unknown }> {
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!prompt) return { status: "error", summary: { error: "params.prompt 미설정 — 잡 입력값에 작업 지시(프롬프트)가 필요합니다." } };
  const requester = headlessRequester(params, createdBy);
  if (!requester) return HEADLESS_REQUESTER_MISSING;
  const repo = (typeof params.repo === "string" && params.repo.trim()) ? params.repo.trim() : null;
  return enqueueHeadlessTask({ prompt, requester, jobId, repo, flags: headlessFlags(params), extra: { repo, prompt_chars: prompt.length } });
}

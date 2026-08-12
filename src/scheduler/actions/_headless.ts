// 액션 공용 헬퍼(R16) — 세션 주입(tmux)·헤드리스 위탁 접수. 세션판(*_inject)·헤드리스판(*_headless) 액션들이 공유한다.
//  scheduler/index.ts(구 827줄)에서 원문 이동 — 엔진(engine.ts) 소속이 아니라 액션 구현의 공용부다.
import { itemsPool, q } from "../../db/client.js";

// 관리세션 id → 현재 살아있는 tmux 세션 id 로 해소(keep-alive 보장 — 죽었으면 재생성). 세션 주입 잡 공용.
//  managed 조회 성공이면 ensure 로 tmux 보장, 실패(=관리세션 아님)면 raw tmux session id 로 폴백(후방호환).
export async function resolveSessionTmux(sessionRef: string): Promise<string> {
  const { getManagedSession, ensureManagedSession } = await import("../../sessions/managed-sessions.js");
  const ms = await getManagedSession(sessionRef).catch(() => null);
  if (!ms) return sessionRef; // 관리세션 아님 → raw tmux id 로 시도(후방호환).
  const ens = await ensureManagedSession(ms);
  if (!ens.session_id) throw new Error("관리세션 '" + sessionRef + "' 의 tmux 세션을 띄우지 못함(enabled 확인)");
  return ens.session_id;
}

// 세션 PTY 에 텍스트 주입(+Enter). **로컬 세션이든 노드 세션이든 같은 함수로 부른다**(#1664).
//  단일라인 평탄화·flush 지연·psmux 표면 분기 같은 규약은 terminal/send-keys 안에 갇혀 있고, 여기는
//  **어디로 보낼지**만 고른다. 종전엔 이 함수가 tmux 를 직접 execFile 해서 게이트웨이 로컬 세션에만
//  닿았다 — 멤버 PC(노드) 세션에는 크론도 리브도 일을 시킬 수 없었다.
export async function injectToSession(sessionId: string, text: string): Promise<void> {
  const { nodeOfSession, nodeRpc } = await import("../../node/registry.js");
  const nodeId = nodeOfSession(sessionId);
  if (nodeId) { await nodeRpc(nodeId, "sendKeys", { id: sessionId, text }); return; } // 원격 — 노드가 자기 mux 로 실행
  const { sendKeysToSession } = await import("../../terminal/send-keys.js");
  await sendKeysToSession(sessionId, text);
}

// 헤드리스 실행 신원(의뢰자) 해소 — params.requester 우선, 없으면 잡 created_by 폴백. D1(의뢰자 시트) — 그 멤버의 클로드 로그인/프로필로 과금·귀속.
export function headlessRequester(params: Record<string, unknown>, createdBy: string | null): string {
  return (typeof params.requester === "string" && params.requester.trim()) ? params.requester.trim() : (createdBy || "");
}
export const HEADLESS_REQUESTER_MISSING = { status: "error" as const, summary: { error: "의뢰자 미설정 — params.requester(멤버 id/이메일)를 지정하거나, 로그인 상태로 잡을 다시 저장해 created_by 를 남기세요." } };

// #1101 헤드리스 실행 모델·추론강도 — 잡 params(model/effort)를 claude 하네스 플래그(--model/--effort)로 변환.
//  세션 주입판은 관리세션 flags 가 모델을 정하지만, 헤드리스엔 이 경로가 없어 계정 기본모델로 떨어지던 갭(관리세션 sonnet/xhigh 무시).
//  빈 값은 생략(계정 기본). 값 검증은 실행 직전 tasks.ts spawnTaskSession 의 FLAG_WHITELIST 가 한 번 더 한다(choices 밖이면 무시).
export function headlessFlags(params: Record<string, unknown>): Record<string, string> {
  const f: Record<string, string> = {};
  const model = typeof params.model === "string" ? params.model.trim() : "";
  const effort = typeof params.effort === "string" ? params.effort.trim() : "";
  if (model) f["--model"] = model;
  if (effort) f["--effort"] = effort;
  return f;
}

// #1058/#1061 헤드리스 위탁 접수 — 세션 주입 대신 위탁(delegate) 파이프라인에 태스크를 넣어 **매 실행 새 `claude -p` one-shot**
//  (빈 컨텍스트)으로 수행한다. agent_headless·map_unmapped_headless·classify_knowledge_headless 공용.
//  러너(node/tasks.ts)·결과수집·노드분산(중앙 내장 노드 포함)은 위탁 시스템을 그대로 재사용.
//  왜 헤드리스: 상시세션은 컨텍스트 관성(옛 should 로 판단 — classify-knowledge-stale-session-inertia)이 있어 should 갱신
//   직후 재분류 같은 작업에서 갱신을 통째로 무시한다. 헤드리스는 매번 fresh 라 매 배치 최신 SoT 대비 판단이 정합적.
//  과금: 구독 크레딧(F5 실측 2026-07-15 — claude -p 가 공유 ~/.claude OAuth 로 실행, ANTHROPIC_API_KEY 부재 → 별도 API 과금 아님).
//   실행 신원 = 의뢰자(headlessRequester)의 클로드 로그인/프로필. 중앙 단일프로필 박스는 공유 로그인 폴백.
//  중첩 가드: 같은 잡의 이전 태스크가 아직 queued/running 이면 이번 주기는 건너뛴다(requester_session='cron:<id>' 마커) → pileup 방지.
//  fire-and-forget: 접수·배치까지가 잡 책임(실행·결과수집은 위탁 스케줄러가 5s tick 으로). 결과 요약은 org_task.result / delegate_status.
export async function enqueueHeadlessTask(o: { prompt: string; requester: string; jobId: string; repo?: string | null; flags?: Record<string, string>; extra?: Record<string, unknown>; marker?: string }): Promise<{ status: string; summary: unknown }> {
  // 중첩 방지 마커 — 기본은 잡 단위(cron:<job>). #1289 증류기처럼 한 잡이 여러 배치를 병렬 접수하면 배치별로 갈라
  //  넘긴다(cron:<job>#<key>) — 안 그러면 첫 배치가 나머지를 전부 '진행 중'으로 막는다.
  const marker = o.marker || "cron:" + o.jobId;
  const extra = o.extra ?? {};
  // 중첩 방지 — 이전 실행분이 아직 대기/실행 중이면 이번 주기는 건너뛴다(분류의 '인박스 비면 skip' 과 같은 결의 idempotency).
  try {
    const inflight = await q(itemsPool,
      `SELECT id, status FROM org_task WHERE requester_session=$1 AND status IN ('queued','running') ORDER BY id DESC LIMIT 1`, [marker]);
    if (inflight.length) return { status: "ok", summary: { skipped: "이전 실행 아직 진행 중", task_id: inflight[0].id, task_status: inflight[0].status, ...extra } };
  } catch { /* org_task 부재 등 — 계속 진행(생성 시점에 다시 실패하면 그때 보고) */ }

  const { createTask } = await import("../../node/task-store.js");
  const { tryAssignNow } = await import("../../node/task-scheduler.js");

  let task: Awaited<ReturnType<typeof createTask>>;
  try { task = await createTask({ requester: o.requester, requesterSession: marker, prompt: o.prompt, repo: o.repo ?? null, flags: o.flags ?? {} }); }
  catch (e) { return { status: "error", summary: { error: "위탁 태스크 생성 실패: " + ((e as Error)?.message ?? String(e)), requester: o.requester } }; }

  // 요청→즉답: 지금 배치 가능한지 그 자리에서 판정(위탁 스케줄러 tick 을 안 기다림). 안 되면 큐에 남겨 상한 내 재시도(중첩가드가 pileup 차단).
  let assign: Awaited<ReturnType<typeof tryAssignNow>>;
  try { assign = await tryAssignNow(task); }
  catch (e) { return { status: "error", summary: { error: "배치 오류: " + ((e as Error)?.message ?? String(e)), task_id: task.id } }; }

  if (!assign.assigned) return { status: "ok", summary: { task_id: task.id, queued: true, reason: assign.reason, requester: o.requester, ...extra } };
  return { status: "ok", summary: { task_id: task.id, assigned_node: assign.nodeId, requester: o.requester, ...extra } };
}

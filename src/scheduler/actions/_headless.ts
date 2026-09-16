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
//  규약(단일라인 평탄화·flush 지연·psmux 표면 분기)은 terminal/send-keys 가, 로컬/원격 라우팅은
//  node/session-inject 가 진다 — 웹 REST(세션 프롬프트 보내기)와 **같은 경로**를 타게 하려는 것이다.
//  종전엔 이 함수가 tmux 를 직접 execFile 해서 게이트웨이 로컬 세션에만 닿았다.
export async function injectToSession(sessionId: string, text: string): Promise<void> {
  const { injectPrompt } = await import("../../node/session-inject.js");
  await injectPrompt(sessionId, text);
}

// 헤드리스 실행 신원(의뢰자) 해소 — params.requester 우선, 없으면 잡 created_by 폴백. D1(의뢰자 시트) — 그 멤버의 클로드 로그인/프로필로 과금·귀속.
//  ⚠ **워크스페이스 설정을 못 본다.** 새 코드는 `resolveJobRunner` 를 써라 — 이 함수는 순수 판정이 필요한
//   자리(시험·순수 해소)만 남긴다. 둘의 차이는 가운데 칸(워크스페이스 실행 멤버) 하나다.
export function headlessRequester(params: Record<string, unknown>, createdBy: string | null): string {
  return (typeof params.requester === "string" && params.requester.trim()) ? params.requester.trim() : (createdBy || "");
}

/**
 * 맥락관리 잡(증류·분류·관리)을 **누구 자격으로 돌릴지** 정한다 (#4012 T1 · #3994 D1 확정).
 *
 * 우선순위:
 *   ① `explicit` — 레인·잡이 **명시한** requester. 더 구체적인 지정이므로 이긴다.
 *   ② 워크스페이스 설정 `context_job_policy.runner_member` — 2026-09-16 상민님 결정의 자리.
 *   ③ 잡 `created_by` — 호환 폴백. ②가 서기 전의 동작을 깨지 않으려고 남긴다.
 *      ⚠ «누가 마지막으로 그 잡을 저장했나» 는 자격 주체의 근거가 못 된다 — ②가 보급되면 걷는 것이 목표다.
 *
 * ⚠ 설정 조회가 실패해도 **던지지 않는다**. 이 함수가 막히면 잡이 통째로 안 도는데, 그건 설정 하나 못 읽은
 *  대가로는 너무 크다 — 종전 폴백(③)으로 내려가 적어도 돌던 것은 계속 돈다.
 */
export async function resolveJobRunner(
  explicit: unknown,
  createdBy: string | null,
  //  주입 seam — 시험이 DB 없이 우선순위를 잰다(`node/task-scheduler.leaseEnvFor` 와 같은 관례).
  workspaceRunner: () => Promise<string | null> = defaultWorkspaceRunner,
): Promise<string> {
  const e = typeof explicit === "string" ? explicit.trim() : "";
  if (e) return e;
  try {
    const m = await workspaceRunner();
    if (typeof m === "string" && m.trim()) return m.trim();
  } catch { /* 설정을 못 읽음 — 종전 폴백으로 내려간다(잡을 세우지 않는다) */ }
  return createdBy || "";
}

/** 기본 출처 — 워크스페이스 런타임 설정의 실행 멤버. */
async function defaultWorkspaceRunner(): Promise<string | null> {
  const { getRuntimeConfig } = await import("../../org/store.js");
  return (await getRuntimeConfig()).context_job_policy?.runner_member ?? null;
}
export const HEADLESS_REQUESTER_MISSING = { status: "error" as const, summary: { error: "의뢰자 미설정 — params.requester(멤버 id/이메일)를 지정하거나, 로그인 상태로 잡을 다시 저장해 created_by 를 남기세요." } };

// #1101/#4008 헤드리스 실행 모델·추론강도 — 설정(증류기·분류기·관리기 행) 우선, 없으면 잡 params.
//  ⚠ **여기서 플래그로 굳히지 않는다.** 하네스마다 모델 이름이 완전히 다르므로(opus ↔ gpt-5.6-sol ↔
//   gemini-3.8-flash-high), 어느 CLI 로 돌지 정해지기 전에 값을 확정하면 그 값이 맞는지 판단할 수가 없다.
//   종전엔 여기서 `{"--model": v}` 를 만들어 넘겼고, 하네스가 그 모델을 모르면 harnessFlagArgs 가 **조용히
//   버려** `--model` 없이 실행됐다 — 그게 곧 «CLI 계정 기본 모델»(claude 는 fable)이고, 무인 배치가 가장
//   비싼 모델로 도는 결말이었다(원준님 2026-09-16: 증류가 페이블로 돌아 토큰이 다 빨렸다).
//   그래서 이 함수는 **희망값만** 실어 보내고, 확정은 하네스 해소 직후 enqueueHeadlessTask 가 한다.
export function headlessRun(
  cfg: { model?: string | null; effort?: string | null },
  params: Record<string, unknown>,
): { model: string | null; effort: string | null } {
  const from = (a: unknown, b: unknown): string | null => {
    for (const v of [a, b]) if (typeof v === "string" && v.trim()) return v.trim();
    return null;
  };
  return { model: from(cfg.model, params.model), effort: from(cfg.effort, params.effort) };
}

// #1884/#4008 헤드리스 실행 하네스 — 설정(행) 우선, 없으면 잡 params, 그래도 없으면 자동(의뢰자가 로그인한
//  하네스 기준, claude 우선). 값 검증은 접수 시 resolveHeadlessHarness 가 한다(헤드리스 불가 하네스면
//  error 로 보고 — 조용히 claude 로 바꾸지 않는다).
//  cfg 를 앞에 둔 이유: 증류기·분류기·관리기는 **자기 제공자를 스스로 정할 수 있어야 한다**(#4008). 종전엔
//   이 축이 잡 params 에만 있어서, 한 잡이 여러 레인을 돌리는데 제공자는 잡 하나로 묶여 있었다.
export function headlessHarness(params: Record<string, unknown>, cfg?: { harness?: string | null }): string | null {
  for (const v of [cfg?.harness, params.harness]) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

// #1058/#1061 헤드리스 위탁 접수 — 세션 주입 대신 위탁(delegate) 파이프라인에 태스크를 넣어 **매 실행 새 헤드리스 one-shot**
//  (`claude -p` · `codex exec` … — 빈 컨텍스트)으로 수행한다. agent_headless·map_unmapped_headless·classify_knowledge_headless 공용.
//  실행 하네스(#1884): 명시(o.harness) > 의뢰자가 로그인한 하네스(claude 우선) > claude. 종전엔 org_task.harness 를 안 써
//   DB 기본 'claude' 고정이었고, codex 로만 로그인한 의뢰자의 잡이 전부 자격 없는 claude -p 로 떠서 무출력 stall 로 죽었다.
//  러너(node/tasks.ts)·결과수집·노드분산(중앙 내장 노드 포함)은 위탁 시스템을 그대로 재사용.
//  왜 헤드리스: 상시세션은 컨텍스트 관성(옛 should 로 판단 — classify-knowledge-stale-session-inertia)이 있어 should 갱신
//   직후 재분류 같은 작업에서 갱신을 통째로 무시한다. 헤드리스는 매번 fresh 라 매 배치 최신 SoT 대비 판단이 정합적.
//  과금: 구독 크레딧(F5 실측 2026-07-15 — claude -p 가 공유 ~/.claude OAuth 로 실행, ANTHROPIC_API_KEY 부재 → 별도 API 과금 아님).
//   실행 신원 = 의뢰자(headlessRequester)의 클로드 로그인/프로필. 중앙 단일프로필 박스는 공유 로그인 폴백.
//  중첩 가드: 같은 잡의 이전 태스크가 아직 queued/running 이면 이번 주기는 건너뛴다(requester_session='cron:<id>' 마커) → pileup 방지.
//  fire-and-forget: 접수·배치까지가 잡 책임(실행·결과수집은 위탁 스케줄러가 5s tick 으로). 결과 요약은 org_task.result / delegate_status.
//  모델·추론강도(#4008): `model`/`effort` 는 **희망값**이다 — 하네스를 정한 **뒤에** automationFlags 가 확정한다.
//   비었거나 그 하네스가 모르는 값이면 그 하네스의 자동화 기본값으로 간다(catalog.AUTOMATION_DEFAULTS).
//   종전(flags 를 통째로 받던 시절)엔 여기에 이미 굳은 `--model` 이 들어와, 하네스가 모르면 조용히 버려지고
//   CLI 계정 기본(=가장 비싼 모델)으로 돌았다. 그 자리를 닫는 것이 이 함수의 새 책임이다.
export async function enqueueHeadlessTask(o: { prompt: string; requester: string; jobId: string; repo?: string | null; harness?: string | null; model?: string | null; effort?: string | null; extra?: Record<string, unknown>; marker?: string; nodePref?: string | null }): Promise<{ status: string; summary: unknown }> {
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
  const { resolveHeadlessHarness } = await import("../../node/headless-harness.js");

  // 실행 하네스(#1884) — 명시가 무효(헤드리스 불가)면 접수하지 않고 잡 결과로 말한다. 로그인 프로브 실패는 안에서 claude 로 접는다.
  let harness: string;
  try { harness = await resolveHeadlessHarness(o.requester, o.harness ?? null); }
  catch (e) { return { status: "error", summary: { error: (e as Error)?.message ?? String(e), requester: o.requester, ...extra } }; }

  // 모델·추론강도 확정(#4008) — **하네스가 정해진 지금** 대입한다(왜 여기인지는 headlessRun 주석).
  //  dropped 는 «설정값이 이 하네스 것이 아니어서 기본으로 갈아탔다» 는 관측 — 잡 요약에 실어 조용히 넘어가지 않게 한다.
  const { automationFlags } = await import("../../terminal/catalog.js");
  const run = automationFlags(harness, { model: o.model, effort: o.effort });

  let task: Awaited<ReturnType<typeof createTask>>;
  // nodePref(#1881) — 잡이 실행 위치를 고정할 수 있다(예: node="central" = 게이트웨이 박스에서).
  //  기본은 미지정(스케줄러 자유 배정 — 오프로드 취지). matchNode 가 node_pref 있으면 그 노드만 후보로 삼는다.
  try { task = await createTask({ requester: o.requester, requesterSession: marker, prompt: o.prompt, harness, repo: o.repo ?? null, flags: run.flags, nodePref: o.nodePref ?? null }); }
  catch (e) { return { status: "error", summary: { error: "위탁 태스크 생성 실패: " + ((e as Error)?.message ?? String(e)), requester: o.requester, harness } }; }

  // 요청→즉답: 지금 배치 가능한지 그 자리에서 판정(위탁 스케줄러 tick 을 안 기다림). 안 되면 큐에 남겨 상한 내 재시도(중첩가드가 pileup 차단).
  let assign: Awaited<ReturnType<typeof tryAssignNow>>;
  try { assign = await tryAssignNow(task); }
  catch (e) { return { status: "error", summary: { error: "배치 오류: " + ((e as Error)?.message ?? String(e)), task_id: task.id } }; }

  //  model·effort 를 요약에 싣는다(#4008) — 종전엔 **무엇으로 돌았는지 어디에도 안 남아서**, 증류가 몇 주째
  //   가장 비싼 모델로 돌고 있는 것을 청구서를 보고서야 알았다. 관측이 없으면 같은 사고가 또 조용히 난다.
  const ran = { harness, model: run.flags["--model"] ?? null, effort: run.flags["--effort"] ?? null,
    ...(run.dropped.length ? { ignored_settings: run.dropped } : {}) };
  // 미배정을 무엇으로 적을까(#3994 T5 · #968) — **자리 부족만 정상**이고 나머지는 실패다.
  //  종전엔 전부 ok 였다: 후보가 하나도 없어 10분 뒤 죽을 배치도 «정상 접수» 로 기록돼, 크론 화면도
  //  서킷 브레이커도 10시간 동안 아무 말을 하지 않았다(실측 199/200 실패). 판정은 assign-outcome(순수).
  const { headlessEnqueueStatus } = await import("../../node/assign-outcome.js");
  if (!assign.assigned) {
    const status = headlessEnqueueStatus({ assigned: false, code: assign.code });
    return { status, summary: { task_id: task.id, queued: status === "ok", assign_code: assign.code ?? null, reason: assign.reason, requester: o.requester, ...ran, ...extra } };
  }
  return { status: "ok", summary: { task_id: task.id, assigned_node: assign.nodeId, requester: o.requester, ...ran, ...extra } };
}

// 자격 실패 대응(#1675 ②③) — 사양 엣지 표 36~43행(<스크래치패드>/spec.md).
//  틀렸을 때의 대가: 안 멈추면 어니스트의 24시간이 반복되고, 남의 크론을 멈추면 멀쩡한 파이프라인이 죽는다.
import { strict as assert } from "node:assert";
import { handleAuthFailure, shouldAlertNow, resetAuthAlertCooldown } from "./auth-failure-response.js";
import type { AuthFailure } from "./task-failure.js";

const AUTH: AuthFailure = { label: "토큰 폐기(revoked)", evidence: "… has been revoked", from: "stderr" };
const T0 = new Date("2026-08-13T00:00:00.000Z").getTime();

/** 호출을 기록하는 스텁 묶음 — '무엇이 실제로 불렸나'로 단언한다(문구 매칭 아님). */
function spies(o: { stopResult?: boolean; stopThrows?: boolean; alertThrows?: boolean } = {}) {
  const stopped: string[] = [], canceled: string[] = [];
  const alerts: Array<{ severity: string; title: string; text: string; detail: Record<string, unknown> }> = [];
  return {
    stopped, canceled, alerts,
    deps: {
      stop: async (jobId: string) => {
        if (o.stopThrows) throw new Error("DB 오류");
        stopped.push(jobId);
        return o.stopResult ?? true;
      },
      cancelQueued: async (jobId: string) => { canceled.push(jobId); return 2; },
      alert: async (a: { severity: string; title: string; text: string; detail: Record<string, unknown> }) => {
        if (o.alertThrows) throw new Error("웹훅 오류");
        alerts.push(a);
        return { sent: true };
      },
      now: () => T0,
    } as never,
  };
}

// ── ㊱ 크론이 낸 위탁 — 멈추고 큐를 비우고 알린다 ──
{
  resetAuthAlertCooldown();
  const s = spies();
  const out = await handleAuthFailure(
    { taskId: 2809, requester: "lively1", cronJobId: "distill-sources-headless", auth: AUTH },
    { stopCron: true }, s.deps);
  assert.deepEqual(s.stopped, ["distill-sources-headless"], "크론을 안 멈췄다 — 10분 뒤 또 9건이 들어온다");
  assert.deepEqual(s.canceled, ["distill-sources-headless"], "큐에 남은 후속 위탁을 안 걷었다 — 줄줄이 401 로 죽는다");
  assert.equal(out.cronStopped, true);
  assert.equal(out.queuedCanceled, 2);
  assert.equal(out.alerted, true);
  assert.equal(s.alerts.length, 1, "알림이 안 갔다 — 이 사고의 24시간은 '아무도 몰랐다'가 만들었다");
}

// ── ㊲ 사람이 낸 위탁 — 멈출 크론이 없다. 남의 크론을 멈추면 안 된다 ──
{
  resetAuthAlertCooldown();
  const s = spies();
  const out = await handleAuthFailure(
    { taskId: 10, requester: "yoon", cronJobId: null, auth: AUTH }, { stopCron: true }, s.deps);
  assert.deepEqual(s.stopped, [], "크론 마커가 없는데 무언가를 멈췄다");
  assert.deepEqual(s.canceled, [], "크론 마커가 없는데 큐를 건드렸다");
  assert.equal(out.cronStopped, false);
  assert.equal(s.alerts.length, 1, "멈출 크론이 없어도 알림은 가야 한다 — 자격은 여전히 죽었다");
}

// ── ㊳ 정책으로 자동 정지를 끄면 알림만 간다 ──
{
  resetAuthAlertCooldown();
  const s = spies();
  await handleAuthFailure(
    { taskId: 11, requester: "lively1", cronJobId: "job-a", auth: AUTH }, { stopCron: false }, s.deps);
  assert.deepEqual(s.stopped, [], "자동 정지를 껐는데 멈췄다 — 정책이 안 먹는다");
  assert.equal(s.alerts.length, 1, "정지를 꺼도 알림은 가야 한다");
}

// ── ㊴ ★알림 쿨다운 — 9레인이 동시에 죽어도 알림은 한 번 ──
{
  resetAuthAlertCooldown();
  const s = spies();
  for (let i = 0; i < 9; i++) {
    await handleAuthFailure(
      { taskId: 100 + i, requester: "lively1", cronJobId: `job#lane${i}`, auth: AUTH }, { stopCron: true }, s.deps);
  }
  assert.equal(s.alerts.length, 1, `증류 9레인이 동시에 죽자 알림이 ${s.alerts.length}건 나갔다 — 슬랙 폭탄`);
  assert.equal(s.stopped.length, 9, "쿨다운이 크론 정지까지 막았다 — 정지는 매번 시도해야 한다(멱등)");
}

// ── ㊵ 쿨다운은 requester 단위 — 다른 사람의 자격 실패는 따로 알린다 ──
{
  resetAuthAlertCooldown();
  const s = spies();
  await handleAuthFailure({ taskId: 1, requester: "a", cronJobId: null, auth: AUTH }, { stopCron: true }, s.deps);
  await handleAuthFailure({ taskId: 2, requester: "b", cronJobId: null, auth: AUTH }, { stopCron: true }, s.deps);
  assert.equal(s.alerts.length, 2, "다른 멤버의 자격 실패가 쿨다운에 먹혔다 — 그 사람은 영영 모른다");
}

// ── ㊶㊷ 부분 실패를 삼킨다(이 경로가 스케줄러를 깨면 안 된다) ──
{
  resetAuthAlertCooldown();
  const s = spies({ stopThrows: true });
  const out = await handleAuthFailure(
    { taskId: 12, requester: "lively1", cronJobId: "job-b", auth: AUTH }, { stopCron: true }, s.deps);
  assert.equal(out.cronStopped, false);
  assert.equal(s.alerts.length, 1, "크론 정지가 실패했는데 알림도 안 갔다 — 그러면 아무도 모른다");
}
{
  resetAuthAlertCooldown();
  const s = spies({ alertThrows: true });
  const out = await handleAuthFailure(
    { taskId: 13, requester: "lively1", cronJobId: "job-c", auth: AUTH }, { stopCron: true }, s.deps);
  assert.equal(out.alerted, false);
  assert.deepEqual(s.stopped, ["job-c"], "알림이 던졌다고 크론 정지까지 날아갔다");
}

// ── ㊸ 알림 본문 — 사람이 3초에 판단할 재료가 들어 있어야 한다 ──
{
  resetAuthAlertCooldown();
  const s = spies();
  await handleAuthFailure(
    { taskId: 2809, requester: "lively1", cronJobId: "distill-sources-headless", auth: AUTH }, { stopCron: true }, s.deps);
  const a = s.alerts[0];
  assert.equal(a.severity, "critical", "자격 폐기는 critical 이다 — warn 이면 min_severity=critical 인 조직에 안 간다");
  assert.ok(a.title.includes("lively1"), "누구의 자격인지가 제목에 없다");
  assert.ok(a.text.includes("distill-sources-headless"), "어느 크론이 멈췄는지가 본문에 없다");
  assert.ok(a.text.includes("setup-token"), "무엇을 해야 하는지(재발급)가 본문에 없다");
  assert.ok(a.text.includes(AUTH.evidence), "판정 근거가 없다 — 오탐을 뒤집을 수 없다");
  assert.equal(a.detail.task_id, 2809);
  assert.equal(a.detail.cron_job, "distill-sources-headless");
}

// ── 쿨다운 판정(순수) ──
assert.equal(shouldAlertNow(undefined, T0), true, "첫 실패인데 안 알린다");
assert.equal(shouldAlertNow(T0, T0 + 1000, 60_000), false, "쿨다운 안인데 알렸다");
assert.equal(shouldAlertNow(T0, T0 + 60_000, 60_000), true, "쿨다운 경계(정확히 만료)에서 안 알렸다");

console.log("auth-failure-response.test: ok");

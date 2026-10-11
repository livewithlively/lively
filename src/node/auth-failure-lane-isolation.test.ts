// 자격 실패 정지 범위의 레인 격리 — 사양 A(마커 파싱)·B(범위 판정)·C(대응) 전수.
//  틀렸을 때의 대가: 한 계정 만료로 다른 계정이 돌리는 레인까지 크론째 멈추면 멀쩡한 파이프라인이 9일 선다.
//  반대로 덜 멈추면 죽은 자격으로 10분마다 실패가 쌓이고 아무도 모른다.
import { strict as assert } from "node:assert";
import { handleAuthFailure as handleForBurst, resetAuthAlertCooldown as resetForBurst } from "./auth-failure-response.js";

// ── 같은 tick 에 같은 계정 레인 4개가 연달아 실패 — 첫 건이 레인을 끄고 알린다, 나머지는 조용히 수렴 ──
{
  resetForBurst();
  let laneCalls = 0, cronStops = 0;
  const alerts: unknown[] = [];
  const outs = [];
  for (let i = 0; i < 4; i++) {
    outs.push(await handleForBurst(
      { taskId: 900 + i, requester: "x", cronJobId: "distill-sources-headless", lane: `l${i}`,
        auth: { label: "인증 실패", evidence: "expired", from: "summary" } },
      { stopCron: true },
      {
        jobRunner: async () => ({ laneCapable: true, runner: "runner-a" }),
        stopLanes: async () => { laneCalls++; return laneCalls === 1 ? ["l0", "l1", "l2", "l3"] : []; },
        cancelQueuedFor: async () => 0,
        stop: async () => { cronStops++; return true; },
        cancelQueued: async () => 0,
        alert: async (a: unknown) => { alerts.push(a); return { sent: true }; },
        now: () => 0,
      } as never));
  }
  assert.equal(cronStops, 0, "같은 계정 레인이 연달아 죽자 크론이 섰다 — 다른 계정 레인까지 멈춘다");
  assert.equal(laneCalls, 4, "레인 정지는 매번 시도해야 한다(멱등)");
  assert.deepEqual(outs[0].lanesStopped, ["l0", "l1", "l2", "l3"]);
  assert.deepEqual(outs.slice(1).map((o) => o.lanesStopped.length), [0, 0, 0]);
  assert.equal(alerts.length, 1, `알림이 ${alerts.length}건 — 같은 계정의 동시 실패는 한 번만 알린다`);
}
import { handleAuthFailure, authFailureScope, resetAuthAlertCooldown } from "./auth-failure-response.js";
import { cronLaneFromMarker } from "./task-failure.js";
import type { AuthFailure } from "./task-failure.js";

const AUTH: AuthFailure = { label: "토큰 폐기(revoked)", evidence: "… has been revoked", from: "stderr" };
const T0 = new Date("2026-10-11T00:00:00.000Z").getTime();

type Alert = { severity: string; title: string; text: string; detail: Record<string, unknown> };

/** 호출 기록 스텁 — '무엇이 실제로 불렸나'로 단언한다. */
function spies(o: {
  runner?: { laneCapable: boolean; runner: string } | null;
  runnerThrows?: boolean;
  lanesResult?: string[];
  stopLanesThrows?: boolean;
  throwAll?: boolean;
} = {}) {
  const stopped: string[] = [], canceled: string[] = [], runnerLookups: string[] = [];
  const laneStops: Array<{ lane: string; requester: string }> = [];
  const canceledFor: Array<{ jobId: string; requester: string }> = [];
  const alerts: Alert[] = [];
  const boom = () => { if (o.throwAll) throw new Error("dep 오류"); };
  return {
    stopped, canceled, runnerLookups, laneStops, canceledFor, alerts,
    deps: {
      stop: async (jobId: string) => { boom(); stopped.push(jobId); return true; },
      cancelQueued: async (jobId: string) => { boom(); canceled.push(jobId); return 3; },
      jobRunner: async (jobId: string) => {
        boom();
        runnerLookups.push(jobId);
        if (o.runnerThrows) throw new Error("잡 조회 오류");
        return o.runner === undefined ? { laneCapable: true, runner: "owner" } : o.runner;
      },
      stopLanes: async (lane: string, requester: string) => {
        boom();
        if (o.stopLanesThrows) throw new Error("레인 정지 오류");
        laneStops.push({ lane, requester });
        return o.lanesResult ?? [lane];
      },
      cancelQueuedFor: async (jobId: string, requester: string) => {
        boom(); canceledFor.push({ jobId, requester }); return 1;
      },
      alert: async (a: Alert) => { boom(); alerts.push(a); return { sent: true }; },
      now: () => T0,
    } as never,
  };
}

// ════════ A. cronLaneFromMarker ════════
assert.equal(cronLaneFromMarker("cron:job#lane-a"), "lane-a", "레인 키를 못 뽑았다 — 레인 격리가 아예 작동하지 않는다");
assert.equal(cronLaneFromMarker("cron:job"), null, "레인 없는 마커에서 레인을 지어냈다 — 엉뚱한 레인을 끈다");
assert.equal(cronLaneFromMarker("cron:job#"), null, "빈 레인을 레인으로 봤다 — 이름 없는 레인을 끄려다 아무것도 안 멈춘다");
assert.equal(cronLaneFromMarker("cron:job#   "), null, "공백뿐인 레인을 레인으로 봤다 — 이름 없는 레인을 끄려다 아무것도 안 멈춘다");
assert.equal(cronLaneFromMarker("  cron:job#lane-a  "), "lane-a", "앞뒤 공백 때문에 레인 키가 어긋났다 — 존재하지 않는 레인을 끈다");
for (const m of ["box-xxx", "", null, undefined]) {
  assert.equal(cronLaneFromMarker(m as never), null, `크론 유래가 아닌 마커(${String(m)})에서 레인을 뽑았다 — 사람 위탁으로 크론 레인을 끈다`);
}

// ════════ B. authFailureScope ════════
assert.equal(authFailureScope({ cronJobId: null, lane: "lane-a", requester: "a", laneCapable: true, jobRunner: "owner" }), "none",
  "크론이 없는 위탁에 정지 범위를 매겼다 — 남의 크론을 멈춘다");
assert.equal(authFailureScope({ cronJobId: "job", lane: "lane-a", requester: "a", laneCapable: true, jobRunner: "owner" }), "lanes",
  "다른 계정이 돌리는 잡인데 레인 격리를 안 했다 — 한 계정 만료로 크론 전체가 선다");
assert.equal(authFailureScope({ cronJobId: "job", lane: null, requester: "a", laneCapable: true, jobRunner: "owner" } as never), "cron",
  "레인이 없는데 레인 격리를 골랐다 — 아무것도 안 멈춘다");
assert.equal(authFailureScope({ cronJobId: "job", lane: "lane-a", requester: "a", laneCapable: false, jobRunner: "owner" }), "cron",
  "레인을 못 끄는 잡인데 레인 격리를 골랐다 — 아무것도 안 멈춘다");
assert.equal(authFailureScope({ cronJobId: "job", lane: "lane-a", requester: "a", laneCapable: true, jobRunner: null }), "cron",
  "잡 실행 계정을 모르는데 레인 격리를 골랐다 — 덜 멈추는 쪽으로 기울었다");
assert.equal(authFailureScope({ cronJobId: "job", lane: "lane-a", requester: "a", laneCapable: true, jobRunner: "a" }), "cron",
  "잡 실행 계정 자체가 죽었는데 레인만 껐다 — 나머지 레인도 같은 죽은 자격으로 계속 실패한다");

// ════════ C. handleAuthFailure ════════
const LANE_CTX = { taskId: 501, requester: "lively1", cronJobId: "distill", lane: "lane-a", auth: AUTH };

// ── C1. 레인 격리 — 그 레인만 끄고, 그 계정 대기만 걷고, 크론은 계속 돈다 ──
{
  resetAuthAlertCooldown();
  const s = spies({ runner: { laneCapable: true, runner: "owner" }, lanesResult: ["lane-a", "lane-b"] });
  const out = await handleAuthFailure(LANE_CTX, { stopCron: true }, s.deps);
  assert.deepEqual(s.laneStops, [{ lane: "lane-a", requester: "lively1" }], "실패 계정의 레인을 안 껐다 — 죽은 자격으로 계속 실패한다");
  assert.deepEqual(s.stopped, [], "레인 격리 상황에서 크론 전체를 멈췄다 — 다른 계정 레인까지 선다");
  assert.deepEqual(s.canceled, [], "크론 전체 대기를 걷었다 — 멀쩡한 계정의 위탁까지 날아간다");
  assert.deepEqual(s.canceledFor, [{ jobId: "distill", requester: "lively1" }], "실패 계정의 대기 위탁을 안 걷었다 — 줄줄이 401 로 죽는다");
  assert.equal(out.cronStopped, false, "크론을 안 멈췄는데 멈췄다고 보고했다");
  assert.deepEqual(out.lanesStopped, ["lane-a", "lane-b"], "실제로 끈 레인 목록이 결과에 그대로 안 실렸다 — 무엇을 다시 켤지 모른다");
  assert.equal(out.queuedCanceled, 1, "계정 단위 대기 취소 건수가 결과에 안 실렸다");
}

// ── C1'. stopLanes 가 빈 배열(이미 꺼짐)이어도 크론은 멈추지 않는다 ──
{
  resetAuthAlertCooldown();
  const s = spies({ runner: { laneCapable: true, runner: "owner" }, lanesResult: [] });
  const out = await handleAuthFailure(LANE_CTX, { stopCron: true }, s.deps);
  assert.deepEqual(s.stopped, [], "레인이 이미 꺼져 있다고 크론 전체로 올렸다 — 이미 처리된 실패로 멀쩡한 레인이 선다");
  assert.equal(out.cronStopped, false);
  assert.deepEqual(out.lanesStopped, []);
}

// ── C2. 잡 실행 계정 == 실패 계정 → 종전대로 크론 정지 ──
{
  resetAuthAlertCooldown();
  const s = spies({ runner: { laneCapable: true, runner: "lively1" } });
  const out = await handleAuthFailure(LANE_CTX, { stopCron: true }, s.deps);
  assert.deepEqual(s.stopped, ["distill"], "잡 실행 계정 자체가 죽었는데 크론을 안 멈췄다 — 모든 레인이 계속 실패한다");
  assert.deepEqual(s.canceled, ["distill"], "크론 대기를 안 걷었다 — 줄줄이 401 로 죽는다");
  assert.deepEqual(s.laneStops, [], "크론을 멈추는 경로에서 레인까지 건드렸다 — 크론을 다시 켜도 레인이 꺼진 채 남는다");
  assert.equal(out.cronStopped, true);
}

// ── C3. 레인 단위로 못 끄는 잡 → 크론 정지 ──
{
  resetAuthAlertCooldown();
  const s = spies({ runner: { laneCapable: false, runner: "owner" } });
  const out = await handleAuthFailure(LANE_CTX, { stopCron: true }, s.deps);
  assert.deepEqual(s.stopped, ["distill"], "레인을 못 끄는 잡인데 크론도 안 멈췄다 — 아무것도 안 멈춘다");
  assert.deepEqual(s.laneStops, [], "레인을 못 끄는 잡에 레인 정지를 시도했다");
  assert.equal(out.cronStopped, true);
}

// ── C4. 레인 없음 → 크론 정지, 실행 계정 조회 불필요 ──
{
  resetAuthAlertCooldown();
  const s = spies();
  const out = await handleAuthFailure(
    { taskId: 502, requester: "lively1", cronJobId: "distill", auth: AUTH }, { stopCron: true }, s.deps);
  assert.deepEqual(s.stopped, ["distill"], "레인 없는 크론 위탁인데 크론을 안 멈췄다 — 10분 뒤 또 실패한다");
  assert.deepEqual(s.laneStops, [], "레인이 없는데 레인 정지를 시도했다");
  assert.equal(out.cronStopped, true);
}

// ── C5a. 실행 계정 조회가 throw → 크론 정지로 대응 ──
{
  resetAuthAlertCooldown();
  const s = spies({ runnerThrows: true });
  const out = await handleAuthFailure(LANE_CTX, { stopCron: true }, s.deps);
  assert.deepEqual(s.stopped, ["distill"], "잡 조회가 실패하자 아무것도 안 멈췄다 — 덜 멈추는 쪽으로 기울었다");
  assert.equal(out.cronStopped, true);
}

// ── C5b. 실행 계정 조회 결과 null(잡 없음) → 크론 정지로 대응 ──
{
  resetAuthAlertCooldown();
  const s = spies({ runner: null });
  const out = await handleAuthFailure(LANE_CTX, { stopCron: true }, s.deps);
  assert.deepEqual(s.stopped, ["distill"], "잡 정보가 없자 아무것도 안 멈췄다 — 덜 멈추는 쪽으로 기울었다");
  assert.deepEqual(s.laneStops, [], "잡 정보가 없는데 레인 격리를 했다");
  assert.equal(out.cronStopped, true);
}

// ── C6. stopLanes 가 throw → 크론 정지로 올려 대응 ──
{
  resetAuthAlertCooldown();
  const s = spies({ runner: { laneCapable: true, runner: "owner" }, stopLanesThrows: true });
  const out = await handleAuthFailure(LANE_CTX, { stopCron: true }, s.deps);
  assert.deepEqual(s.stopped, ["distill"], "레인 정지가 실패하자 아무것도 안 멈춘 채 끝났다 — 죽은 자격으로 계속 돈다");
  assert.equal(out.cronStopped, true);
}

// ── C7. 정책으로 자동 정지를 끄면 레인 상황이어도 알림만 ──
{
  resetAuthAlertCooldown();
  const s = spies({ runner: { laneCapable: true, runner: "owner" } });
  const out = await handleAuthFailure(LANE_CTX, { stopCron: false }, s.deps);
  assert.deepEqual(s.stopped, [], "자동 정지를 껐는데 크론을 멈췄다 — 정책이 안 먹는다");
  assert.deepEqual(s.laneStops, [], "자동 정지를 껐는데 레인을 껐다 — 정책이 안 먹는다");
  assert.deepEqual(s.canceled, [], "자동 정지를 껐는데 크론 대기를 걷었다");
  assert.deepEqual(s.canceledFor, [], "자동 정지를 껐는데 계정 대기를 걷었다");
  assert.equal(out.cronStopped, false);
  assert.deepEqual(out.lanesStopped, []);
  assert.equal(s.alerts.length, 1, "정지를 꺼도 알림은 가야 한다 — 자격은 여전히 죽었다");
}

// ── C8. 사람이 낸 위탁(cronJobId=null) — 레인이 있어도 아무것도 안 멈추고 알림은 간다 ──
{
  resetAuthAlertCooldown();
  const s = spies({ runner: { laneCapable: true, runner: "owner" } });
  const out = await handleAuthFailure(
    { taskId: 503, requester: "yoon", cronJobId: null, lane: "lane-a", auth: AUTH }, { stopCron: true }, s.deps);
  assert.deepEqual(s.stopped, [], "크론 마커가 없는데 크론을 멈췄다");
  assert.deepEqual(s.laneStops, [], "크론 마커가 없는데 레인을 껐다");
  assert.deepEqual(s.canceled, []);
  assert.deepEqual(s.canceledFor, []);
  assert.equal(out.cronStopped, false);
  assert.deepEqual(out.lanesStopped, []);
  assert.equal(s.alerts.length, 1, "멈출 크론이 없어도 알림은 가야 한다");
}

// ── C9. 레인 격리 알림 — 첫 건은 반드시 가고, 꺼진 레인을 알려 준다 ──
{
  resetAuthAlertCooldown();
  const s = spies({ runner: { laneCapable: true, runner: "owner" }, lanesResult: ["lane-a"] });
  const out = await handleAuthFailure(LANE_CTX, { stopCron: true }, s.deps);
  assert.equal(out.alerted, true, "레인 격리 첫 건인데 알림이 안 갔다 — 아무도 모른다");
  assert.equal(s.alerts.length, 1);
  const a = s.alerts[0];
  assert.deepEqual(a.detail.lanes_stopped, ["lane-a"], "알림에 꺼진 레인 목록이 없다 — 무엇을 다시 켤지 모른다");
  assert.equal(a.detail.lane, "lane-a", "알림에 실패한 레인이 없다 — 어느 계정 레인이 죽었는지 모른다");
  assert.ok(a.text.includes("레인"), "알림 본문이 레인을 다시 켜라는 조치를 말하지 않는다 — 꺼진 레인이 영영 꺼진 채 남는다");
}

// ── C10. 모든 dep 가 throw 해도 handleAuthFailure 는 throw 하지 않는다 ──
{
  resetAuthAlertCooldown();
  const s = spies({ throwAll: true });
  let threw: unknown = null;
  try {
    await handleAuthFailure(LANE_CTX, { stopCron: true }, s.deps);
  } catch (e) { threw = e; }
  assert.equal(threw, null, "dep 하나의 오류가 대응 경로 밖으로 새어 스케줄러를 깼다");
}

console.log("auth-failure-lane-isolation: ok");

// 미리보기 준비 줄(#4119) — 사양 엣지 표 Q1~Q10 각각에 시나리오 하나.
//
// 왜 이 테스트가 있나: 종전엔 준비가 줄 없이 곧바로 떴다(`void preparePreviewEnv`). 주기 점검이 stage 일곱을
//  한 번에 다시 빌드하자 빌드 프로세스 35개가 게이트웨이와 같은 메모리 한도(2GiB)를 10초 만에 채웠고,
//  게이트웨이가 1~4분씩 통째로 멈췄다(2026-09-21 매니지드 실측). 이 줄이 지키는 것은 셋이다 —
//  ① 동시에 도는 수가 한도를 넘지 않는다 ② 같은 미리보기는 두 벌 돌지 않는다 ③ 사람이 누른 것이 자동 갱신 뒤에 묻히지 않는다.
// 단언은 «무엇이 실제로 시작·끝났나» 의 기록(부작용)으로 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { createPrepareQueue, prepareConcurrencyFromEnv } from "./prepare-queue.js";

const turn = async (n = 4): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// 손으로 끝내는 일감 — 언제 시작했고 언제 끝났는지 적는다. 동시에 몇 개가 돌았는지(최대치)도 잰다.
function harness(concurrency: number) {
  const log: string[] = [];
  const open = new Map<string, () => void>();
  let peak = 0;
  const errors: Array<[string, string]> = [];
  const q = createPrepareQueue(concurrency, (k, e) => errors.push([k, (e as Error)?.message ?? String(e)]));
  const job = (key: string) => () => new Promise<void>((resolve) => {
    log.push("start:" + key);
    open.set(key, () => { log.push("end:" + key); resolve(); });
    peak = Math.max(peak, open.size);
  });
  const finish = async (key: string): Promise<void> => {
    const r = open.get(key);
    assert.ok(r, `${key} 가 아직 시작하지 않았다(배선: 일감이 실제로 불렸어야 한다)`);
    open.delete(key);
    r();
    await turn();
  };
  return { q, log, job, finish, errors, running: () => [...open.keys()], peak: () => peak };
}

test("Q1 한도 1 — 셋을 세워도 한 번에 하나만, 선 순서대로", async () => {
  const h = harness(1);
  h.q.schedule("a", h.job("a")); h.q.schedule("b", h.job("b")); h.q.schedule("c", h.job("c"));
  await turn();
  assert.deepEqual(h.running(), ["a"]);
  assert.deepEqual(h.q.stats(), { active: 1, waiting: 2 });
  await h.finish("a"); assert.deepEqual(h.running(), ["b"]);
  await h.finish("b"); assert.deepEqual(h.running(), ["c"]);
  await h.finish("c");
  assert.deepEqual(h.log, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  assert.equal(h.peak(), 1, "빌드 일곱이 한꺼번에 돈 것이 이번 고장이다");
  assert.deepEqual(h.q.stats(), { active: 0, waiting: 0 });
});

test("Q2 같은 키는 두 번 서지 않는다 — 도는 중이든 기다리는 중이든", async () => {
  const h = harness(1);
  assert.equal(h.q.schedule("a", h.job("a")), true);
  assert.equal(h.q.schedule("b", h.job("b")), true);
  await turn();
  assert.equal(h.q.schedule("a", h.job("a")), false, "도는 a 를 또 세우면 같은 워크트리에서 npm 이 두 벌 돈다");
  assert.equal(h.q.schedule("b", h.job("b")), false, "기다리는 b 도 마찬가지");
  assert.equal(h.q.stats().waiting, 1);
  await h.finish("a"); await h.finish("b");
  assert.deepEqual(h.log.filter((l) => l.startsWith("start")), ["start:a", "start:b"]);
});

test("Q3 사람이 누른 것(front)은 기다리는 줄 맨 앞 — 도는 것은 끊지 않는다", async () => {
  const h = harness(1);
  for (const k of ["auto1", "auto2", "auto3"]) h.q.schedule(k, h.job(k));
  await turn();
  assert.equal(h.q.schedule("human", h.job("human"), { front: true }), true);
  await turn();
  assert.deepEqual(h.running(), ["auto1"], "이미 도는 빌드는 끝까지 간다");
  await h.finish("auto1");
  assert.deepEqual(h.running(), ["human"], "자동 갱신 둘보다 먼저");
});

test("Q4 이미 기다리는 키를 front 로 다시 부르면 앞으로 옮긴다(두 번 세우지 않는다)", async () => {
  const h = harness(1);
  for (const k of ["run", "x", "y"]) h.q.schedule(k, h.job(k));
  await turn();
  assert.equal(h.q.schedule("y", h.job("y"), { front: true }), false);
  assert.equal(h.q.stats().waiting, 2, "대기 수가 늘면 두 번 선 것이다");
  await h.finish("run");
  assert.deepEqual(h.running(), ["y"]);
  await h.finish("y");
  assert.deepEqual(h.running(), ["x"]);
});

test("Q5 실패한 일감이 줄을 멈추지 않는다 — 거부·동기 throw 모두, 보고는 키와 함께", async () => {
  const h = harness(1);
  h.q.schedule("rej", () => Promise.reject(new Error("빌드 실패")));
  h.q.schedule("sync", () => { throw new Error("동기 실패"); });
  h.q.schedule("ok", h.job("ok"));
  await turn(8);
  assert.deepEqual(h.running(), ["ok"], "앞의 두 실패 뒤에도 셋째가 돈다");
  assert.deepEqual(h.errors, [["rej", "빌드 실패"], ["sync", "동기 실패"]]);
  assert.equal(h.q.has("rej"), false, "실패해도 자리를 비운다 — 다음 점검이 다시 세울 수 있어야 한다");
  assert.equal(h.q.has("sync"), false);
});

test("Q6 끝난 키는 다시 설 수 있다", async () => {
  const h = harness(1);
  h.q.schedule("a", h.job("a"));
  await turn(); await h.finish("a");
  assert.equal(h.q.has("a"), false);
  assert.equal(h.q.schedule("a", h.job("a")), true);
  await turn();
  assert.deepEqual(h.running(), ["a"]);
});

test("Q7 한도 2 — 둘까지 함께 돌고 셋째는 기다린다", async () => {
  const h = harness(2);
  for (const k of ["a", "b", "c"]) h.q.schedule(k, h.job(k));
  await turn();
  assert.deepEqual(h.running().sort(), ["a", "b"]);
  await h.finish("b");
  assert.deepEqual(h.running().sort(), ["a", "c"]);
  assert.equal(h.peak(), 2);
});

test("Q8 한도가 0·음수·NaN 이면 1 로 본다 — 줄이 영영 안 도는 설정을 만들지 않는다", async () => {
  for (const n of [0, -3, Number.NaN]) {
    const h = harness(n);
    h.q.schedule("a", h.job("a")); h.q.schedule("b", h.job("b"));
    await turn();
    assert.deepEqual(h.running(), ["a"], `한도 ${n}`);
  }
});

test("Q9 환경변수 — 없음·0·글자는 1, 1~8 그대로, 넘치면 8", () => {
  const f = (v?: string) => prepareConcurrencyFromEnv(v === undefined ? {} : { LVLY_PREVIEW_PREPARE_CONCURRENCY: v });
  assert.deepEqual(
    [f(), f("0"), f("abc"), f("1"), f("3"), f("8"), f("9"), f("99")],
    [1, 1, 1, 1, 3, 8, 8, 8]);
});

test("Q10 보고 함수가 throw 해도 줄은 돈다", async () => {
  const q = createPrepareQueue(1, () => { throw new Error("로거 고장"); });
  const ran: string[] = [];
  q.schedule("bad", () => Promise.reject(new Error("x")));
  q.schedule("next", async () => { ran.push("next"); });
  await turn(8);
  assert.deepEqual(ran, ["next"]);
  assert.deepEqual(q.stats(), { active: 0, waiting: 0 });
});

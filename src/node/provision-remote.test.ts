// 사양 기반 테스트 — drivePollProvision (원격 노드 provision 완료 폴링).
// provision-poll-spec.md 의 8개 행위만 검증한다. 구현 본문은 보지 않고 진입점만 import 한다.
// sleep 은 즉시-resolve, now 는 결정적 fake clock 을 주입해 실시간 대기 0 으로 돌린다.
import assert from "node:assert/strict";
import { drivePollProvision, nodeProjectCreatePlan, type ProvisionStatus } from "./provision-remote.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

// 폴링 간 대기 — 즉시 resolve(실시간 대기 없음).
const sleep = async (_ms: number): Promise<void> => {};

// 프로젝트 바인딩 정본이 기록되기 전에 노드가 첫 프롬프트를 실행하지 않게, 새 노드는 prompt를 create에서 분리한다.
{
  const input = { label: "", rootKey: "shared", subpath: "project/1", harness: "claude", flags: {}, autoApprove: false, initialPrompt: "첫 지시" };
  const modern = nodeProjectCreatePlan(input, true);
  assert.equal(modern.createInput.initialPrompt, undefined);
  assert.equal(modern.deferredPrompt, "첫 지시");
  const legacy = nodeProjectCreatePlan(input, false);
  assert.equal(legacy.createInput.initialPrompt, "첫 지시", "구 노드는 종전 create 주입으로 호환한다");
  assert.equal(legacy.deferredPrompt, null);
  ok("0 새 노드 첫 지시를 DB 바인딩 뒤로 지연");
}

// 호출마다 step 만큼 전진하는 결정적 시계. capMs 초과를 유도할 땐 step 을 크게 준다.
function fakeClock(step = 10, start = 0): () => number {
  let t = start;
  return () => { const v = t; t += step; return v; };
}

// 노드 폴 조회가 던지는 일시적 실패(HTTP status 없음 — 이 함수가 409/502 로 번역해야 한다).
function pollBoom(msg = "poll boom"): Error {
  return new Error(msg);
}

// status() 스텁: 시퀀스대로 값을 주되(Error 원소면 그 자리에서 throw), 마지막 원소를 계속 반복한다.
// calls.n 으로 폴링 횟수를 관찰한다. 폭주(무한 폴) 시 테스트가 매달리지 않게 가드를 둔다.
function seqStatus(items: Array<ProvisionStatus | Error>) {
  let i = 0;
  const calls = { n: 0 };
  const fn = async (): Promise<ProvisionStatus> => {
    calls.n++;
    if (calls.n > 20000) throw new Error("TEST_RUNAWAY: status() 가 20000회 넘게 호출됨(무한 폴 의심)");
    const idx = Math.min(i, items.length - 1);
    i++;
    const item: ProvisionStatus | Error | undefined = items[idx];
    if (!item) throw new Error("TEST: status 시퀀스가 비었다");
    if (item instanceof Error) throw item;
    return item;
  };
  return Object.assign(fn, { calls });
}

// ── 1. 완료 → result 배열을 그대로 반환. ──
{
  const repos = [{ repo: "context-ontology", path: "/w/1" }, { repo: "b", path: "/w/2" }];
  const status = seqStatus([{ known: true, state: "done", result: repos }]);
  const out = await drivePollProvision(
    { online: () => true, status, reprovision: async () => {}, sleep, now: fakeClock() },
    { nodeId: "n1", projectId: 905, capMs: 60_000 },
  );
  assert.equal(out.provisioned.length, 2, "done.result 의 개수를 그대로 돌려줘야 한다");
  assert.deepEqual(out.provisioned, repos, "done.result 배열을 그대로 돌려줘야 한다");
  assert.deepEqual(out.failed, [], "구 번들 노드(배열 응답)면 failed 는 빈 배열이어야 한다(#1155 하위호환)");
  ok("1 완료→결과 배열 그대로 반환");
}

// ── 2. running 지속 → 결국 완료(running 여러 번 뒤 done, 결과 1번). ──
{
  const repos = [{ repo: "x", path: "/w/x" }];
  const status = seqStatus([
    { known: true, state: "running" },
    { known: true, state: "running" },
    { known: true, state: "running" },
    { known: true, state: "done", result: repos },
  ]);
  let reprovisions = 0;
  const out = await drivePollProvision(
    { online: () => true, status, reprovision: async () => { reprovisions++; }, sleep, now: fakeClock() },
    { nodeId: "n1", projectId: 905, capMs: 60_000, pollMs: 5 },
  );
  assert.deepEqual(out.provisioned, repos, "running 을 거쳐 done 의 결과를 돌려줘야 한다");
  assert.equal(status.calls.n, 4, "running 3회 동안 계속 폴링하다 done 에서 멈춰 정확히 4번 조회해야 한다");
  assert.equal(reprovisions, 0, "known:false 신호가 없었는데 재지시했다");
  ok("2 running 지속→결국 완료");
}

// ── 3. 노드 보고 실패 → 502 + 메시지에 노드 error 문구 포함. ──
{
  const status = seqStatus([{ known: true, state: "error", error: "clone auth denied for repo X" }]);
  let threw = false;
  try {
    await drivePollProvision(
      { online: () => true, status, reprovision: async () => {}, sleep, now: fakeClock() },
      { nodeId: "n1", projectId: 905, capMs: 60_000 },
    );
  } catch (err: any) {
    threw = true;
    assert.equal(err.status, 502, "노드가 error 를 보고하면 502 로 던져야 한다");
    assert.ok(String(err.message).includes("clone auth denied for repo X"),
      "메시지에 노드가 보고한 error 문구가 담겨야 한다(원인 가시화)");
  }
  assert.ok(threw, "노드 error 인데 던지지 않았다");
  ok("3 노드 error→502(+노드 문구 포함)");
}

// ── 4. known:false → reprovision 후 이어감. 재지시는 known:false 를 만난 횟수만큼만. ──
{
  const repos = [{ repo: "y", path: "/w/y" }];
  const status = seqStatus([
    { known: false, state: "running" },   // 재지시 #1
    { known: true,  state: "running" },   // 신호 없음 → 재지시 없음
    { known: false, state: "running" },   // 재지시 #2
    { known: true,  state: "running" },   // 신호 없음 → 재지시 없음
    { known: true,  state: "done", result: repos },
  ]);
  let reprovisions = 0;
  const out = await drivePollProvision(
    { online: () => true, status, reprovision: async () => { reprovisions++; }, sleep, now: fakeClock() },
    { nodeId: "n1", projectId: 905, capMs: 60_000 },
  );
  assert.deepEqual(out.provisioned, repos, "재지시 후 폴링을 이어가 done 을 정상 완료해야 한다");
  assert.equal(reprovisions, 2, "재지시는 known:false 를 만난 횟수(2)만큼만 일어나야 한다");
  ok("4 known:false→재지시 후 완주");
}

// ── 5. 누적 대기가 capMs 초과(계속 running) → 504. ──
{
  const status = seqStatus([{ known: true, state: "running" }]);   // 끝없이 running
  let threw = false;
  try {
    await drivePollProvision(
      // now 가 폴마다 +50s → capMs(1s)를 즉시 초과.
      { online: () => true, status, reprovision: async () => {}, sleep, now: fakeClock(50_000) },
      { nodeId: "n1", projectId: 905, capMs: 1_000 },
    );
  } catch (err: any) {
    threw = true;
    assert.equal(err.status, 504, "누적 대기가 capMs 를 넘기면 504 로 던져야 한다");
  }
  assert.ok(threw, "capMs 를 넘겼는데 던지지 않았다(무한 대기)");
  ok("5 capMs 초과→504");
}

// ── 6. 폴 조회 실패 + 노드 오프라인 → 409 즉시(재시도 없음). ──
{
  const status = seqStatus([pollBoom("connection reset")]);   // 항상 throw
  let threw = false;
  try {
    await drivePollProvision(
      { online: () => false, status, reprovision: async () => {}, sleep, now: fakeClock() },
      { nodeId: "n1", projectId: 905, capMs: 60_000 },
    );
  } catch (err: any) {
    threw = true;
    assert.equal(err.status, 409, "폴 실패 시점에 오프라인이면 409 로 던져야 한다");
  }
  assert.ok(threw, "오프라인 폴 실패인데 던지지 않았다");
  assert.equal(status.calls.n, 1, "오프라인이면 재시도 없이 즉시 포기해야 한다(status 1회만 호출)");
  ok("6 폴 실패+오프라인→409 즉시");
}

// ── 7. 일시 폴 실패(온라인) → 몇 번 봐주고 회복해 완주. ──
{
  const repos = [{ repo: "z", path: "/w/z" }];
  const status = seqStatus([
    pollBoom("timeout 1"),   // 온라인이라 삼킴
    pollBoom("timeout 2"),   // 온라인이라 삼킴
    { known: true, state: "done", result: repos },
  ]);
  const out = await drivePollProvision(
    { online: () => true, status, reprovision: async () => {}, sleep, now: fakeClock() },
    { nodeId: "n1", projectId: 905, capMs: 60_000 },
  );
  assert.deepEqual(out.provisioned, repos, "일시 실패를 삼키고 회복되면 정상 완료해야 한다");
  assert.equal(status.calls.n, 3, "일시 실패 2회를 삼키고 3번째 done 으로 회복해야 한다");
  ok("7 일시 폴 실패(온라인)→봐주고 회복");
}

// ── 8. 연속 폴 실패가 한계 초과(노드는 온라인) → 502. ──
{
  const status = seqStatus([pollBoom("node still down")]);   // 온라인인데 끝없이 실패
  let threw = false;
  try {
    await drivePollProvision(
      // cap 은 넉넉히(원인이 폴 실패 한계여야 하고 504 가 아니어야 한다).
      { online: () => true, status, reprovision: async () => {}, sleep, now: fakeClock(10) },
      { nodeId: "n1", projectId: 905, capMs: 100_000 },
    );
  } catch (err: any) {
    threw = true;
    assert.equal(err.status, 502, "온라인인데 연속 폴 실패가 한계를 넘기면 502 로 던져야 한다");
  }
  assert.ok(threw, "연속 폴 실패 한계를 넘겼는데 던지지 않았다");
  ok("8 연속 폴 실패 한계초과(온라인)→502");
}


// ── 8. #1155 — 새 번들 노드는 {provisioned, failed} 를 돌려준다(실패해도 done 상태로 온다). ──
{
  const repos = [{ repo: "ok-repo", path: "/w/ok" }];
  const failed = [{ name: "bad-repo", path: null, expect: "/w/project/1/bad-repo", worktree: true, reason: "git clone 실패", hint: "자격을 등록하세요" }];
  const status = seqStatus([{ known: true, state: "done", result: { provisioned: repos, failed } }]);
  const out = await drivePollProvision(
    { online: () => true, status, reprovision: async () => {}, sleep, now: fakeClock() },
    { nodeId: "n1", projectId: 1155, capMs: 60_000 },
  );
  assert.deepEqual(out.provisioned, repos, "새 shape 의 provisioned 를 그대로 돌려줘야 한다");
  assert.deepEqual(out.failed, failed, "부분 실패는 error 가 아니라 done 의 failed 로 전달돼야 한다(#1155)");
  ok("8 #1155 새 shape — 부분 실패를 failed 로 전달");
}

console.log(`\n${pass} passed`);

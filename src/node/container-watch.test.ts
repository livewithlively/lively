// #4939 — 세션 호스트의 컨테이너 관측을 이어 보기(순수). 사양: 지식 session-reclaim-gaps-design-4939 «재설계 v2» v2-3 · G2·G3·G5.
//  명제: «컨테이너는 있는데 목록에 세션이 없다» 의 시작 시각은 관측이 **끊김 없이** 이어질 때만 유지된다.
//   목록에 한 번 보이거나 · 관측에 틈이 있거나 · 판정 재료가 아닌 관측(안쪽 표식 없음 · 못 봄 · 컨테이너 없음 · running 아님)이면 지운다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { hostViewsOf, MAX_CONTAINER_OBSERVATIONS, observeBeat, observeContainers, parseContainerObservations, type ContainerWatch, type HostFacts } from "./container-watch.js";
import { SESSION_HOST_DEAD_MS } from "./self-node.js";
import type { ContainerObservation } from "../terminal/tmux-route.js";

const STALE = 12_000;
const obs = (sid: string, o: Partial<ContainerObservation> = {}): ContainerObservation =>
  ({ sid, container: `lvly-s-acme-${sid}`, inside: true, state: "running", outcome: "ok", listed: false, ...o });
const since = (w: ContainerWatch | undefined, sid: string): number | undefined => w?.missing.get(sid)?.sinceMs;

test("[W1] ★ 컨테이너는 있는데 목록에 세션이 없다 → 처음 본 시각을 적고, 이어지면 그 시각을 지킨다", () => {
  let w = observeContainers(undefined, [obs("box-a")], 1_000, STALE);
  assert.equal(w.known, true);
  assert.equal(since(w, "box-a"), 1_000);
  w = observeContainers(w, [obs("box-a")], 4_000, STALE);
  w = observeContainers(w, [obs("box-a")], 7_000, STALE);
  assert.equal(since(w, "box-a"), 1_000, "이어 보면 처음 시각 그대로");
  assert.equal(w.missing.get("box-a")?.container, "lvly-s-acme-box-a");
});

test("[W1b] tmux 서버 없음(no-server) 확답도 «세션이 안 보임» 이다", () => {
  const w = observeContainers(undefined, [obs("box-a", { outcome: "no-server" })], 1_000, STALE);
  assert.equal(since(w, "box-a"), 1_000);
});

test("[W2] ★ G3 — 목록에 한 번이라도 보이면 지운다(다시 안 보이면 처음부터)", () => {
  let w = observeContainers(undefined, [obs("box-a")], 1_000, STALE);
  w = observeContainers(w, [obs("box-a", { listed: true })], 4_000, STALE);
  assert.equal(since(w, "box-a"), undefined);
  w = observeContainers(w, [obs("box-a")], 7_000, STALE);
  assert.equal(since(w, "box-a"), 7_000);
});

test("[W3] ★ G2 — 관측이 끊긴 틈(STALE 초과)이 있으면 그동안을 모르므로 처음부터 다시 센다", () => {
  let w = observeContainers(undefined, [obs("box-a")], 1_000, STALE);
  w = observeContainers(w, [obs("box-a")], 1_000 + STALE + 1, STALE);
  assert.equal(since(w, "box-a"), 1_000 + STALE + 1);
  //  경계 — 정확히 STALE 이면 이어진 것이다.
  let v = observeContainers(undefined, [obs("box-b")], 1_000, STALE);
  v = observeContainers(v, [obs("box-b")], 1_000 + STALE, STALE);
  assert.equal(since(v, "box-b"), 1_000);
});

test("[W4] 박동(«지난번 그대로»)은 이어 본 것이다 · 박동 사이 틈이 길면 다시 센다 · 본 적 없는 노드엔 아무것도 안 만든다", () => {
  let w = observeContainers(undefined, [obs("box-a")], 1_000, STALE);
  w = observeBeat(w, 9_000, STALE)!;
  w = observeBeat(w, 17_000, STALE)!;
  assert.equal(since(w, "box-a"), 1_000);
  assert.equal(w.lastAt, 17_000);
  const gap = observeBeat(w, 17_000 + STALE + 1, STALE)!;
  assert.equal(gap.missing.size, 0, "틈 — 그동안 목록에 보였을 수 있다");
  assert.equal(observeBeat(undefined, 1_000, STALE), undefined);
});

test("[W5] ★ G5 — 판정 재료가 아닌 관측은 지운다: 안쪽 표식 없음 · 안 물음 · 못 봄 · 컨테이너 없음 · running 아님", () => {
  for (const o of [
    { inside: false }, { outcome: "skipped" as const }, { outcome: "error" as const }, { outcome: "gone" as const }, { state: "stopped" },
  ]) {
    let w = observeContainers(undefined, [obs("box-a")], 1_000, STALE);
    w = observeContainers(w, [obs("box-a", o)], 4_000, STALE);
    assert.equal(since(w, "box-a"), undefined, JSON.stringify(o));
  }
  //  상태를 안 싣는 옛 브로커(state 없음)는 running 으로 본다 — 목록에 오른 컨테이너다.
  const w = observeContainers(undefined, [obs("box-b", { state: undefined })], 1_000, STALE);
  assert.equal(since(w, "box-b"), 1_000);
});

test("[W6] 컨테이너가 목록에서 사라지면 지운다 · 같은 sid 가 다른 컨테이너로 바뀌면 처음부터", () => {
  let w = observeContainers(undefined, [obs("box-a"), obs("box-b")], 1_000, STALE);
  w = observeContainers(w, [obs("box-b")], 4_000, STALE);
  assert.equal(since(w, "box-a"), undefined);
  assert.equal(since(w, "box-b"), 1_000);
  w = observeContainers(w, [obs("box-b", { container: "lvly-s-acme-slot-000000000001" })], 7_000, STALE);
  assert.equal(since(w, "box-b"), 7_000);
});

test("[W7] 옛 세션 호스트(containers 를 안 보냄) → known:false · 기억도 버린다(그 노드는 판정 재료가 없다)", () => {
  let w = observeContainers(undefined, [obs("box-a")], 1_000, STALE);
  w = observeContainers(w, undefined, 4_000, STALE);
  assert.equal(w.known, false);
  assert.equal(w.missing.size, 0);
});

test("[W8] 노드가 보낸 칸은 모양을 믿지 않는다 — 한 줄이라도 틀리면·상한을 넘으면 통째로 «모름»(일부만 믿지 않는다)", () => {
  const good = [obs("box-a"), obs("box-b", { state: undefined, outcome: "no-server" })];
  assert.deepEqual(parseContainerObservations(JSON.parse(JSON.stringify(good))), [obs("box-a"), { sid: "box-b", container: "lvly-s-acme-box-b", inside: true, outcome: "no-server", listed: false }]);
  for (const bad of [
    null, "x", [{ ...obs("box-a"), outcome: "maybe" }], [{ ...obs("box-a"), listed: "no" }], [{ ...obs("box-a"), state: 3 }],
    [{ sid: "box-a", container: "c", inside: true, outcome: "ok" }], [obs("box-a"), 7],
    Array.from({ length: MAX_CONTAINER_OBSERVATIONS + 1 }, (_, i) => obs(`box-${i}`)),
  ]) assert.equal(parseContainerObservations(bad), undefined, JSON.stringify(bad)?.slice(0, 80));
  assert.deepEqual(parseContainerObservations([]), [], "빈 배열은 «이 노드에 세션 컨테이너 0» 이라는 확답이다");
});

test("[W9] ★ 판정 재료 — 선언된 호스트만 · 죽은 호스트(하루)는 빼고 · 끊김·낡음·관측 없음·관측 낡음은 넣되 «신선 아님»(= 판정이 모름으로 읽는다)", () => {
  const NOW = 10_000_000;
  const watch = (lastAt: number, known = true): ContainerWatch => ({ lastAt, known, missing: new Map([["box-a", { sinceMs: 1, container: "c-a" }]]) });
  const f = (nodeId: string, o: Partial<HostFacts> = {}): HostFacts =>
    ({ nodeId, declared: true, online: true, stateAgeMs: 1_000, sessionIds: ["box-b"], watch: watch(NOW - 1_000), ...o });
  const v = hostViewsOf([
    f("ok"),
    f("pc", { declared: false }),
    f("dead", { online: false, stateAgeMs: SESSION_HOST_DEAD_MS + 1 }),
    f("offline", { online: false }),
    f("stale", { stateAgeMs: STALE + 1 }),
    f("no-watch", { watch: undefined }),
    f("watch-stale", { watch: watch(NOW - STALE - 1) }),
    f("old-agent", { watch: watch(NOW - 1_000, false) }),
  ], NOW, STALE);
  assert.deepEqual(v.map((h) => [h.nodeId, h.fresh, h.known]), [
    ["ok", true, true], ["offline", false, true], ["stale", false, true], ["no-watch", false, false],
    ["watch-stale", false, true], ["old-agent", true, false],
  ]);
  const ok = v[0]!;
  assert.deepEqual([...ok.listed], ["box-b"]);
  assert.equal(ok.missing.get("box-a")?.container, "c-a");
  //  경계 — 정확히 하루는 아직 죽은 것이 아니다(목록 소유 판정과 같은 자).
  assert.equal(hostViewsOf([f("edge", { online: false, stateAgeMs: SESSION_HOST_DEAD_MS })], NOW, STALE).length, 1);
});

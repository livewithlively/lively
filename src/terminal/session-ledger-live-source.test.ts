// 세션 장부의 `live` 출처 (#2600 T2 d6) — 브로커가 자기 노드를 실어 보내면 그 노드 세션 호스트의 관측으로 답한다.
//
//  ── 무엇을 지키나 ──
//  이 값의 소비자는 브로커의 회수 ②이고 «빠진 id 는 곧 회수 후보» 다. 그래서 틀리기 쉬운 곳은 호스트를 **잘못 고르거나**
//   (모양이 틀린 노드 이름으로 남의 등록을 찾는다) **모름을 빈 목록으로** 답하는 것이다. 표의 대부분이 «종전 tmux» 쪽이다.
//  «tmux 를 물었나» 는 값이 아니라 호출 횟수로 잰다(우연히 같은 값이 나오는 판을 통과시키지 않게).
//  엣지 표는 스크래치패드 `d6/spec.md` 의 C(L1~L8) — 행마다 시험 하나.
import { strict as assert } from "node:assert";
import test from "node:test";
import { ledgerAccess, ledgerAuthToken, ledgerLiveFrom, LEDGER_AUTH_HEADER } from "./session-ledger.js";

function probes(host: Record<string, string[] | null>): {
  hostLive: (nodeId: string) => string[] | null; hostAsked: string[];
  tmuxLive: () => Promise<string[]>; tmuxCalls: () => number;
} {
  const hostAsked: string[] = [];
  let tmux = 0;
  return {
    hostLive: (nodeId: string) => { hostAsked.push(nodeId); return nodeId in host ? host[nodeId]! : null; },
    hostAsked,
    tmuxLive: async () => { tmux++; return ["box-from-tmux"]; },
    tmuxCalls: () => tmux,
  };
}

test("L1 노드를 안 실어 보낸 브로커(옛 판) → 종전 tmux, 호스트를 찾지 않는다", async () => {
  const p = probes({ "sesshost-acme-i-0abc": ["box-a"] });
  const live = ledgerLiveFrom({ slug: "acme", node: undefined, hostLive: p.hostLive, tmuxLive: p.tmuxLive });
  assert.deepEqual(await live(), ["box-from-tmux"]);
  assert.equal(p.tmuxCalls(), 1);
  assert.deepEqual(p.hostAsked, []);
});

test("L2 ★ 그 노드의 세션 호스트가 자격 → 그 스냅샷 id, tmux 를 안 묻는다 — 호스트 id 는 `sesshost-<slug>-<node>`", async () => {
  const p = probes({ "sesshost-acme-i-0abc": ["box-a", "box-b"] });
  const live = ledgerLiveFrom({ slug: "acme", node: "i-0abc", hostLive: p.hostLive, tmuxLive: p.tmuxLive });
  assert.deepEqual(await live(), ["box-a", "box-b"]);
  assert.equal(p.tmuxCalls(), 0, "호스트가 답할 수 있는데 tmux 를 쳤다");
  assert.deepEqual(p.hostAsked, ["sesshost-acme-i-0abc"], "(테넌트, 노드) 로 만든 id 가 아닌 것을 찾았다");
});

test("L3 ★ 그 노드의 호스트가 자격이 없으면(null — 미선언·끊김·낡음) 종전 tmux", async () => {
  const p = probes({ "sesshost-acme-i-0abc": null });
  const live = ledgerLiveFrom({ slug: "acme", node: "i-0abc", hostLive: p.hostLive, tmuxLive: p.tmuxLive });
  assert.deepEqual(await live(), ["box-from-tmux"]);
  assert.equal(p.tmuxCalls(), 1);
  assert.deepEqual(p.hostAsked, ["sesshost-acme-i-0abc"], "배선 — 호스트에 먼저 물었어야 «자격 없음» 행이 뜻이 있다");
});

test("L4 ★ 자격 호스트의 **빈** 목록은 그대로 쓴다 — strict 관측의 0개는 확답이다(tmux 로 되묻지 않는다)", async () => {
  //  껍데기 컨테이너만 남은 노드가 이 모양이다(호스트는 서 있는데 tmux 가 산 세션이 0).
  const p = probes({ "sesshost-acme-i-0abc": [] });
  const live = ledgerLiveFrom({ slug: "acme", node: "i-0abc", hostLive: p.hostLive, tmuxLive: p.tmuxLive });
  assert.deepEqual(await live(), []);
  assert.equal(p.tmuxCalls(), 0);
});

test("L5 ★ 노드 이름 모양이 틀리면 호스트를 **찾지도 않고** 종전 tmux — 요청값으로 등록을 고르지 않는다", async () => {
  for (const bad of ["I-0ABC", "i-0abc/../x", "", "   ", "-lead", "x".repeat(80)]) {
    const p = probes({});
    const live = ledgerLiveFrom({ slug: "acme", node: bad, hostLive: p.hostLive, tmuxLive: p.tmuxLive });
    assert.deepEqual(await live(), ["box-from-tmux"], `node=${JSON.stringify(bad)}`);
    assert.equal(p.tmuxCalls(), 1, `node=${JSON.stringify(bad)}`);
    assert.deepEqual(p.hostAsked, [], `node=${JSON.stringify(bad)} 로 호스트를 찾았다`);
  }
});

test("L6 슬러그를 모르면 → 종전 tmux", async () => {
  const p = probes({ "sesshost-acme-i-0abc": ["box-a"] });
  const live = ledgerLiveFrom({ slug: undefined, node: "i-0abc", hostLive: p.hostLive, tmuxLive: p.tmuxLive });
  assert.deepEqual(await live(), ["box-from-tmux"]);
  assert.deepEqual(p.hostAsked, []);
});

test("L7 쿼리가 배열로 오면(`?node=a&node=b`) 고르지 않는다 → 종전 tmux", async () => {
  const p = probes({ "sesshost-acme-a": ["box-a"] });
  const live = ledgerLiveFrom({ slug: "acme", node: ["a", "b"], hostLive: p.hostLive, tmuxLive: p.tmuxLive });
  assert.deepEqual(await live(), ["box-from-tmux"]);
  assert.deepEqual(p.hostAsked, []);
});

test("L8 ★ 접근 판정이 200 이면 **서명이 묶인 슬러그**를 준다 — 라우트가 호스트를 찾을 때 같은 값을 쓴다", () => {
  const ENV = { LIVELY_TENANT_HEADER_SECRET: "s3cret" };
  const T = { "x-lvly-tenant-auth": "s3cret", "x-lvly-tenant": "acme", "x-lvly-tenant-id": "11111111-1111-1111-1111-111111111111" };
  const ok = ledgerAccess({ ...T, [LEDGER_AUTH_HEADER]: ledgerAuthToken("s3cret", "acme") }, ENV);
  assert.equal(ok.status, 200, "배선 — 200 판을 실제로 만들었어야 슬러그 단언이 뜻이 있다");
  assert.equal(ok.slug, "acme");
  assert.equal(ledgerAccess(T, ENV).slug, undefined, "401 에는 슬러그를 싣지 않는다");
});

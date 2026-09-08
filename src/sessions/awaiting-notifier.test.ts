// #1891 자동 알림 스윕 — 전이 판정 자체는 notify-policy.test.ts(N16~N21)가 지킨다.
//  여기서는 **배선**을 못박는다: 누구에게 보내나 · 무엇을 보내나 · 반복 스윕이 다시 울리지 않나.
import { strict as assert } from "node:assert";
import test from "node:test";
import { resetAwaitingState, sweepAwaitingNotifications } from "./awaiting-notifier.js";

type Sent = { appId: unknown; memberId: string; title: string; href?: unknown; dedupe_key?: unknown };

/**
 * listSessionsRaw 스텁 — 필요한 필드만 채운다(스윕이 보는 것은 id·owner·label·awaiting·lastActive).
 *
 * ⚠ `lastActive` 기본값이 **지금**인 이유 (#3741): 첫 관측 유예가 생겨서, 이 값이 없으면 처음 보는
 *  대기 세션은 알림이 안 간다(notify-policy P4). 아래 시험들이 보는 것은 **배선**(누구에게·무엇을·
 *  다시 안 울리나)이지 그 유예가 아니므로, 유예를 통과한 상태를 기본으로 둔다. 유예 자체는
 *  notify-policy.test 의 P 행들과 이 파일 맨 아래 「폭풍」 시험이 지킨다.
 */
const NOW_SEC = Math.floor(Date.now() / 1000);
const sessions = (rows: Array<{ id: string; owner?: string; awaiting?: boolean; label?: string; lastActive?: number }>) =>
  (async () => rows.map((r) => ({
    id: r.id, label: r.label ?? r.id, harness: "claude", dir: "", owner: r.owner ?? "yoon", owned: true,
    created: 0, attached: false, invites: [], flags: {}, projectId: 0, agentState: "idle",
    working: false, awaiting: !!r.awaiting, lastActive: r.lastActive ?? NOW_SEC,
  }))) as never;

function recorder() {
  const sent: Sent[] = [];
  const notify = (async (input: Sent) => { sent.push(input); return { ok: true, notification: { id: "n1" } }; }) as never;
  return { sent, notify };
}

test("전이한 세션만, 그 세션 주인에게, 그 세션으로 가는 링크로 보낸다", async () => {
  resetAwaitingState();
  const { sent, notify } = recorder();
  const r = await sweepAwaitingNotifications({
    list: sessions([
      { id: "box-a", owner: "yoon", awaiting: true, label: "노션 수집" },
      { id: "box-b", owner: "jang", awaiting: false },
    ]),
    notify,
  });

  assert.equal(r.notified, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].memberId, "yoon", "세션 주인에게 간다");
  assert.equal(sent[0].appId, "ai-session", "ai-session 앱이 보낸 것으로 남는다");
  assert.match(sent[0].title, /노션 수집/, "제목에 세션 이름이 들어간다");
  assert.equal(sent[0].href, "#/s/box-a", "누르면 그 세션으로 간다");
  assert.equal(sent[0].dedupe_key, "ai-session:awaiting:box-a");
});

test("같은 대기가 이어지는 동안 스윕을 다시 돌려도 또 보내지 않는다", async () => {
  resetAwaitingState();
  const { sent, notify } = recorder();
  const list = sessions([{ id: "box-a", owner: "yoon", awaiting: true }]);
  await sweepAwaitingNotifications({ list, notify });
  await sweepAwaitingNotifications({ list, notify });
  await sweepAwaitingNotifications({ list, notify });
  assert.equal(sent.length, 1, "30초마다 도는 스윕이 같은 대기를 세 번 울리면 사람이 알림을 끈다");
});

test("주인을 모르는 세션은 보낼 곳이 없으므로 건너뛴다", async () => {
  resetAwaitingState();
  const { sent, notify } = recorder();
  const r = await sweepAwaitingNotifications({
    list: sessions([{ id: "box-x", owner: "", awaiting: true }]),
    notify,
  });
  assert.equal(sent.length, 0);
  assert.equal(r.notified, 0);
});

test("발송이 거부돼도(권한·grant 없음) 스윕은 죽지 않고 세어서 넘어간다", async () => {
  resetAwaitingState();
  const denied = (async () => ({ ok: false, denial: "notify-grant-missing" })) as never;
  const r = await sweepAwaitingNotifications({
    list: sessions([{ id: "box-a", owner: "yoon", awaiting: true }]),
    notify: denied,
  });
  assert.equal(r.notified, 0);
  assert.equal(r.denied, 1);
});

test("발송이 예외를 던져도 스윕은 나머지를 계속 처리한다", async () => {
  resetAwaitingState();
  const seen: string[] = [];
  const flaky = (async (input: { memberId: string }) => {
    seen.push(input.memberId);
    if (input.memberId === "boom") throw new Error("network");
    return { ok: true, notification: { id: "n" } };
  }) as never;
  const r = await sweepAwaitingNotifications({
    list: sessions([
      { id: "box-1", owner: "boom", awaiting: true },
      { id: "box-2", owner: "yoon", awaiting: true },
    ]),
    notify: flaky,
  });
  assert.deepEqual(seen, ["boom", "yoon"], "한 건이 터져도 다음 건을 시도한다");
  assert.equal(r.notified, 1);
  assert.equal(r.denied, 1);
});

test("중복 억제된 발송은 실패가 아니라 suppressed 로 센다", async () => {
  resetAwaitingState();
  const suppress = (async () => ({ ok: true, suppressed: true })) as never;
  const r = await sweepAwaitingNotifications({
    list: sessions([{ id: "box-a", owner: "yoon", awaiting: true }]),
    notify: suppress,
  });
  assert.equal(r.suppressed, 1);
  assert.equal(r.denied, 0, "억제는 거부가 아니다");
});

// ── observed 를 함께 돌려주는 이유(#2246 실측) ────────────────────────────────
//  매니지드에서 이 스윕이 죽어 있던 걸 **이틀** 몰랐다. 셋(notified·suppressed·denied)만으로는
//  «봤는데 전이가 없어 0» 과 «볼 게 아예 0» 이 똑같이 0,0,0 이라 로그로 갈리지 않았기 때문이다.
test("아무것도 안 보낸 두 경우가 반환값에서 갈린다 — 봤는데 전이 없음 vs 볼 게 없음", async () => {
  resetAwaitingState();
  const { notify } = recorder();
  const 봤지만_전이없음 = await sweepAwaitingNotifications({
    list: sessions([{ id: "box-a", owner: "yoon", awaiting: false }, { id: "box-b", owner: "jang", awaiting: false }]),
    notify,
  });
  resetAwaitingState();
  const 볼게_없음 = await sweepAwaitingNotifications({ list: sessions([]), notify });

  // 셋만 보면 구별이 안 된다 — 그게 문제였다.
  for (const r of [봤지만_전이없음, 볼게_없음]) assert.deepEqual([r.notified, r.suppressed, r.denied], [0, 0, 0]);
  // observed 가 그 둘을 가른다.
  assert.equal(봤지만_전이없음.observed, 2, "세션 둘을 봤다");
  assert.equal(볼게_없음.observed, 0, "볼 세션이 없었다 — 중계가 끊겼거나 컨텍스트가 틀렸다는 신호");
});

test("awaiting 은 '지금 대기 중인 수'다 — 알림 0건이어도 대기가 있었는지 말해 준다", async () => {
  resetAwaitingState();
  const { notify } = recorder();
  // 첫 스윕에서 전이로 잡혀 알림이 나간다.
  const 첫판 = await sweepAwaitingNotifications({
    list: sessions([{ id: "box-a", owner: "yoon", awaiting: true }, { id: "box-b", owner: "yoon", awaiting: false }]),
    notify,
  });
  assert.deepEqual([첫판.observed, 첫판.awaiting, 첫판.notified], [2, 1, 1]);
  // 같은 상태로 다시 쓸면 전이가 아니라 알림은 0 — 그래도 대기가 하나 있다는 건 보여야 한다.
  const 둘째판 = await sweepAwaitingNotifications({
    list: sessions([{ id: "box-a", owner: "yoon", awaiting: true }, { id: "box-b", owner: "yoon", awaiting: false }]),
    notify,
  });
  assert.equal(둘째판.notified, 0, "같은 대기로 다시 울리지 않는다");
  assert.equal(둘째판.awaiting, 1, "그래도 대기가 하나 있다는 사실은 남는다");
});

// ── 알림 폭풍 (#3741) — 스윕 층에서 한 번 더 못박는다 ──
//
//  왜 notify-policy 시험만으로 부족한가: 폭풍은 «순수 판정» 이 아니라 «스윕이 실제로 몇 통 보내나» 로
//   드러난다. 판정이 옳아도 스윕이 lastActive 를 안 넘기면(그 한 줄을 빠뜨리면) 폭풍이 그대로 난다 —
//   실제로 이 배선이 빠진 채 한 번 초록이었다. 그 구멍을 여기서 막는다.
test("★ 오래 대기하던 세션이 한꺼번에 들어와도 알림이 쏟아지지 않는다 — 최근 것만 나간다", async () => {
  resetAwaitingState();
  const { sent, notify } = recorder();
  const flood = Array.from({ length: 200 }, (_, i) => ({
    id: `node-${i}`, owner: "yoon", awaiting: true, lastActive: NOW_SEC - 86_400,   // 하루 전
  }));
  const r = await sweepAwaitingNotifications({
    list: sessions([...flood, { id: "방금", owner: "yoon", awaiting: true, lastActive: NOW_SEC - 10 }]),
    notify,
  });
  assert.equal(r.observed, 201, "201개를 다 보긴 한다(안 보는 것이 아니라 안 울리는 것이다)");
  assert.equal(r.awaiting, 201, "전부 대기 상태로 세어진다");
  assert.equal(sent.length, 1, "발송은 한 통");
  assert.equal(sent[0].title.includes("방금"), true, "최근에 움직인 그 세션만");
});

test("★ 그 다음 스윕에서도 조용하다 — 폭풍이 한 틱 늦게 오면 안 고친 것이다", async () => {
  resetAwaitingState();
  const rows = Array.from({ length: 50 }, (_, i) => ({
    id: `node-${i}`, owner: "yoon", awaiting: true, lastActive: NOW_SEC - 86_400,
  }));
  const first = recorder();
  await sweepAwaitingNotifications({ list: sessions(rows), notify: first.notify });
  assert.equal(first.sent.length, 0);
  const second = recorder();
  await sweepAwaitingNotifications({ list: sessions(rows), notify: second.notify });
  assert.equal(second.sent.length, 0, "두 번째 스윕도 조용해야 한다");
});

// #1891 자동 알림 스윕 — 전이 판정 자체는 notify-policy.test.ts(N16~N21)가 지킨다.
//  여기서는 **배선**을 못박는다: 누구에게 보내나 · 무엇을 보내나 · 반복 스윕이 다시 울리지 않나.
import { strict as assert } from "node:assert";
import test from "node:test";
import { resetAwaitingState, sweepAwaitingNotifications } from "./awaiting-notifier.js";

type Sent = { appId: unknown; memberId: string; title: string; href?: unknown; dedupe_key?: unknown };

/** listSessionsRaw 스텁 — 필요한 필드만 채운다(스윕이 보는 것은 id·owner·label·awaiting 뿐). */
const sessions = (rows: Array<{ id: string; owner?: string; awaiting?: boolean; label?: string }>) =>
  (async () => rows.map((r) => ({
    id: r.id, label: r.label ?? r.id, harness: "claude", dir: "", owner: r.owner ?? "yoon", owned: true,
    created: 0, attached: false, invites: [], flags: {}, projectId: 0, agentState: "idle",
    working: false, awaiting: !!r.awaiting,
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

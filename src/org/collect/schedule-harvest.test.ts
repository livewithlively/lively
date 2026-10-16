// 지속 수집(#4213 T12 #4744) — 수집 실행의 뒷수습이 주기 판정에 넘기는 값(순수): 글 빈도 표본 · 밀림 · 한 판에 실을 단위의 순서 · 곧 때가 될 단위.
//  DB 쪽(그 값으로 다음 확인 시각을 실제로 적나)은 collect-schedule.pg-test.mjs.
//
//  엣지 표
//   H1 슬랙 다 읽은 판 — 계획 구간(시작 ~ 끝) 안 글만 센다(구간 앞의 옛 부모 · 끝 뒤의 답글은 빼고) · 끝 = 정한 끝 / 없으면 계획 시각 − 60초
//   H2 못 다 읽은 판 · 계획 시각 없는 옛 계획 · 끝 ≤ 시작 → 표본 없음
//   H3 노션 처음 읽음 — 최근 14일 안에 고쳐졌으면 1, 아니면 0 · 구간 = 14일
//   H4 노션 다시 읽음 — 지난번 본 고친 시각보다 새로 고쳐졌으면 1(같으면 0) · 구간 = 지난번 읽은 뒤 계획 시각까지
//   H5 지메일 — 받은 시각(internalDate)이 구간 안인 메일만
//   B1 밀림 — 슬랙 새 위치 + 구간(7일 · 저장된 span)이 지금보다 앞이면 밀림 · 지메일(1일) · 노션·위치 없음·열쇠 없음은 아님
//   K1 한 판에 실을 단위 — 때가 된 단위가 먼저(오래 안 읽은 «곧» 단위보다) · 상한 6 안에서 때가 된 단위가 밀려나지 않는다
//   K2 계획에 읽은 시각이 실린다 · 고친 시각은 노션만
//   S1 곧 때가 될 단위 — 주기대로 기다리는 중(interval)이고 남은 시간이 주기의 절반 이하 · 물러서는 단위·이미 때가 된 단위·시각 없음은 아니다
//   R1 저장 단계 → 주기 판정 입력(readNoteOf) — 안 읽음 · 막힘(안 읽음이 먼저) · 다 읽음(밀림·표본) · 못 다 읽음(줄였나 = 다음 위치가 있나 · 바닥)
import test from "node:test";
import assert from "node:assert/strict";
import { NOW_MARGIN_SEC, SLACK_WINDOW_SEC, UNITS_PER_RUN, behindAfter, harvestUnits, pickUnitsForRun, readNoteOf, type AssignedLike, type PlannedUnit } from "./collect-plan.js";
import { readCapture, type Capture } from "./connector-parse.js";
import { ACTIVITY_WINDOW_SEC, SOON_RATIO, isUnitSoon } from "./schedule-plan.js";

const NOW = Date.parse("2026-10-16T10:00:00.000Z");
const PLANNED = NOW / 1000;
const D = 86400, H = 3600;
const cap = (connector: string, tool: string, inner: unknown, input: Record<string, unknown> = {}): Capture => {
  const c = readCapture({ tool_name: `mcp__claude_ai_${connector}__${tool}`, tool_input: input, tool_response: [{ type: "text", text: typeof inner === "string" ? inner : JSON.stringify(inner) }] });
  assert.ok(c, "배선 — 캡처가 풀렸다");
  return c;
};
const CH = "C0SCHED001";
const slackUnit = (o: Partial<PlannedUnit> = {}): PlannedUnit => ({
  id: 1, app: "slack", instance: "T0TEAM", ref: CH, kind: "channel", connector: "Slack", since: `${PLANNED - 7 * D}.000000`, until: null, ...o,
});
/** 채널 한 쪽(끝) — msgs: [ts, 본문, 꼬리?]. */
const channel = (u: PlannedUnit, msgs: Array<[string, string, string?]>) => cap("Slack", "slack_read_channel", {
  messages: [`Channel: #c (${u.ref})`, "", ...msgs.flatMap(([ts, body, tail]) => [`=== Message from Kim <k@x.test> (U0SCHED001) at x ===`, `Message TS: ${ts}`, body, ...(tail ? [tail] : []), ""])].join("\n"),
  pagination_info: "There are no more messages available.\n",
}, { channel_id: u.ref, oldest: u.since, ...(u.until ? { latest: u.until } : {}), limit: 100 });
const thread = (u: PlannedUnit, parent: string, replies: string[]) => cap("Slack", "slack_read_thread", {
  messages: ["=== THREAD PARENT MESSAGE ===", "From: Kim (U0SCHED001)", "Time: x", `Message TS: ${parent}`, "부모", "",
    "=== THREAD REPLIES (n) ===", "", ...replies.flatMap((ts, i) => [`--- Reply ${i + 1} of ${replies.length} ---`, "From: Lee (U0SCHED002)", "Time: y", `Message TS: ${ts}`, `답글 ${i + 1}`, ""])].join("\n"),
  pagination_info: "There are no more messages in this thread.\n",
}, { channel_id: u.ref, message_ts: parent, limit: 200 });

test("H1 슬랙 — 계획 구간 안 글만 센다 · 끝이 없으면 계획 시각 − 60초", () => {
  const u = slackUnit();
  const start = PLANNED - 7 * D;
  const caps = [
    channel(u, [[`${start + 10}.000100`, "하나", "Thread: 2 replies (latest: x)"], [`${start + 20}.000200`, "둘"]]),
    //  구간 안 답글 하나 + 계획 시각 − 30초의 답글(끝 = 계획 시각 − 60초 뒤라 빈도에는 안 센다 — 자료로는 들어간다).
    thread(u, `${start + 10}.000100`, [`${start + 30}.000300`, `${PLANNED - 30}.000400`]),
  ];
  const h = harvestUnits(caps, [u], { plannedAt: PLANNED }).byUnit.get(1)!;
  assert.equal(h.complete, true, h.why ?? "");
  assert.equal(h.items.length, 4, "자료는 넷 다");
  assert.deepEqual(h.sample, { e: PLANNED - NOW_MARGIN_SEC, s: 7 * D - NOW_MARGIN_SEC, n: 3 });
  //  정한 끝이 있으면 그 끝까지만 — 끝 뒤 답글은 안 센다.
  const u2 = slackUnit({ since: `${start}.000000`, until: `${start + 25}.000000` });
  const h2 = harvestUnits([channel(u2, [[`${start + 10}.000100`, "하나", "Thread: 1 replies (latest: x)"], [`${start + 20}.000200`, "둘"]]),
    thread(u2, `${start + 10}.000100`, [`${start + 30}.000300`])], [u2], { plannedAt: PLANNED }).byUnit.get(1)!;
  assert.equal(h2.complete, true, h2.why ?? "");
  assert.deepEqual(h2.sample, { e: start + 25, s: 25, n: 2 });
});

test("H2 못 다 읽은 판 · 계획 시각 없는 옛 계획 · 끝이 시작보다 앞 → 표본 없음", () => {
  const u = slackUnit();
  const start = PLANNED - 7 * D;
  //  답글 있는 부모의 스레드를 안 읽었다 → 못 다 읽음.
  const partial = harvestUnits([channel(u, [[`${start + 10}.000100`, "하나", "Thread: 2 replies (latest: x)"]])], [u], { plannedAt: PLANNED }).byUnit.get(1)!;
  assert.equal(partial.complete, false);
  assert.equal(partial.sample, null);
  const old = harvestUnits([channel(u, [[`${start + 10}.000100`, "하나"]])], [u], {}).byUnit.get(1)!;
  assert.equal(old.complete, true);
  assert.equal(old.sample, null, "계획 시각을 모르면 끝을 몰라 표본을 안 만든다");
  const future = slackUnit({ since: `${PLANNED + 10}.000000` });
  const hf = harvestUnits([channel(future, [])], [future], { plannedAt: PLANNED }).byUnit.get(1)!;
  assert.equal(hf.sample, null, "끝(계획 시각 − 60초) ≤ 시작");
});

const NOTION_REF = "abcdef01-2345-6789-abcd-ef0123456789";
const notionUnit = (o: Partial<PlannedUnit> = {}): PlannedUnit => ({ id: 3, app: "notion", instance: "", ref: NOTION_REF, kind: "page", connector: "Notion", since: null, until: null, ...o });
const notionFetch = (editedIso: string) => cap("Notion", "notion-fetch", {
  metadata: { type: "page" }, title: "기획", url: `https://www.notion.so/x-${NOTION_REF.replace(/-/g, "")}`,
  text: "<content>\n본문\n</content>", page_last_edited_at: editedIso,
}, { id: NOTION_REF });

test("H3 노션 처음 읽음 — 최근 14일 안에 고쳐졌으면 1 · 아니면 0 · 구간 14일", () => {
  const recent = harvestUnits([notionFetch(new Date((PLANNED - 3 * D) * 1000).toISOString())], [notionUnit()], { plannedAt: PLANNED }).byUnit.get(3)!;
  assert.equal(recent.complete, true);
  assert.deepEqual(recent.sample, { e: PLANNED, s: ACTIVITY_WINDOW_SEC, n: 1 });
  const stale = harvestUnits([notionFetch(new Date((PLANNED - 30 * D) * 1000).toISOString())], [notionUnit()], { plannedAt: PLANNED }).byUnit.get(3)!;
  assert.deepEqual(stale.sample, { e: PLANNED, s: ACTIVITY_WINDOW_SEC, n: 0 });
});

test("H4 노션 다시 읽음 — 지난번 본 고친 시각보다 새로 고쳐졌을 때만 1 · 구간 = 지난번 읽은 뒤", () => {
  const readAt = new Date((PLANNED - 2 * H) * 1000).toISOString();
  const before = new Date((PLANNED - 5 * D) * 1000).toISOString();
  const changed = harvestUnits([notionFetch(new Date((PLANNED - H) * 1000).toISOString())],
    [notionUnit({ read_at: readAt, edited_at: before })], { plannedAt: PLANNED }).byUnit.get(3)!;
  assert.deepEqual(changed.sample, { e: PLANNED, s: 2 * H, n: 1 });
  const same = harvestUnits([notionFetch(before)], [notionUnit({ read_at: readAt, edited_at: before })], { plannedAt: PLANNED }).byUnit.get(3)!;
  assert.deepEqual(same.sample, { e: PLANNED, s: 2 * H, n: 0 }, "그대로면 0 — 같은 페이지를 다시 읽은 것은 새 글이 아니다");
  //  읽은 시각을 모르는데(옛 행) 이미 본 고친 시각이 있다 — 14일 창 안이어도 이미 본 고침은 다시 세지 않는다.
  const seen = new Date((PLANNED - 3 * D) * 1000).toISOString();
  const known = harvestUnits([notionFetch(seen)], [notionUnit({ read_at: null, edited_at: seen })], { plannedAt: PLANNED }).byUnit.get(3)!;
  assert.deepEqual(known.sample, { e: PLANNED, s: ACTIVITY_WINDOW_SEC, n: 0 });
});

test("H5 지메일 — 받은 시각이 구간 안인 메일만 센다", () => {
  const box = "me@example.com";
  const since = PLANNED - D, until = PLANNED - H;
  const u: PlannedUnit = { id: 2, app: "gmail", instance: "default", ref: box, kind: "mailbox", connector: "Gmail", since: String(since), until: String(until) };
  const view = `https://mail.google.com/mail/?authuser=${encodeURIComponent(box)}#all/x`;
  const msg = (id: string, sec: number) => ({ id, threadId: "t00000000001", subject: "s", sender: "a <a@x.test>", internalDate: String(sec * 1000), plaintextBody: "본문", viewUrl: view });
  const caps = [
    cap("Gmail", "search_threads", { threads: [{ id: "t00000000001", messages: [{ id: "a000000001", viewUrl: view }, { id: "a000000002", viewUrl: view }] }] }, { query: `after:${since} before:${until}`, pageSize: 50 }),
    cap("Gmail", "get_thread", { id: "t00000000001", messages: [msg("a000000001", since + 100), msg("a000000002", until + 100)] }, { threadId: "t00000000001", messageFormat: "PLAIN_TEXT" }),
  ];
  const h = harvestUnits(caps, [u], { plannedAt: PLANNED }).byUnit.get(2)!;
  assert.equal(h.complete, true, h.why ?? "");
  assert.deepEqual(h.sample, { e: until, s: until - since, n: 1 });
});

test("B1 밀림 — 새 위치에서 시작하는 다음 구간의 끝이 지금보다 앞이면 밀림", () => {
  assert.equal(behindAfter("slack", { ts: `${PLANNED - SLACK_WINDOW_SEC - 10}.000000` }, NOW), true, "7일 넘게 뒤");
  assert.equal(behindAfter("slack", { ts: `${PLANNED - SLACK_WINDOW_SEC + 10}.000000` }, NOW), false);
  assert.equal(behindAfter("slack", { ts: `${PLANNED - 2 * H}.000000`, span: H }, NOW), true, "줄여 둔 구간(1시간) 기준");
  assert.equal(behindAfter("gmail", { after: PLANNED - 2 * D }, NOW), true, "지메일 구간 1일");
  assert.equal(behindAfter("gmail", { after: PLANNED - 2 * H }, NOW), false);
  assert.equal(behindAfter("notion", { edited_at: "2026-01-01T00:00:00Z" }, NOW), false);
  assert.equal(behindAfter("slack", null, NOW), false);
  assert.equal(behindAfter("slack", { span: H }, NOW), false, "위치 열쇠가 없으면 밀림으로 보지 않는다(처음 수집 시작점을 «밀림» 으로 착각하지 않게)");
});

const assigned = (id: number, o: Partial<AssignedLike> = {}): AssignedLike => ({
  id, app: "slack", instance: "T0TEAM", ref: `C0SCHED${String(id).padStart(3, "0")}`, kind: "channel",
  read_at: new Date(NOW - id * H).toISOString(), cursor: {}, last_item_at: null, from_collector: false, ...o,
});
test("K1 때가 된 단위가 먼저 — 오래 안 읽은 «곧» 단위가 상한 안에서 때가 된 단위를 밀어내지 않는다", () => {
  const soon = Array.from({ length: UNITS_PER_RUN }, (_, i) => assigned(100 + i, { due: false }));   // 더 오래 안 읽었다
  const due = [assigned(1, { due: true }), assigned(2, { due: true })];
  const picked = pickUnitsForRun([...soon, ...due], { now: NOW });
  assert.equal(picked.length, UNITS_PER_RUN);
  assert.deepEqual(picked.slice(0, 2).map((u) => u.id), [2, 1], "때가 된 둘이 맨 앞(그 안에서는 오래 안 읽은 것부터)");
  assert.deepEqual(pickUnitsForRun([assigned(5), assigned(9)], { now: NOW }).map((u) => u.id), [9, 5], "due 가 없으면 종전대로 오래 안 읽은 것부터");
});
test("K2 계획에 읽은 시각이 실린다 · 고친 시각은 노션만", () => {
  const n = pickUnitsForRun([assigned(1, { app: "notion", ref: NOTION_REF, kind: "page", cursor: { edited_at: "2026-10-01T00:00:00.000Z" } }), assigned(2)], { now: NOW });
  const notion = n.find((u) => u.app === "notion")!;
  const slack = n.find((u) => u.app === "slack")!;
  assert.equal(notion.read_at, new Date(NOW - H).toISOString());
  assert.equal(notion.edited_at, "2026-10-01T00:00:00.000Z");
  assert.equal(slack.read_at, new Date(NOW - 2 * H).toISOString());
  assert.equal("edited_at" in slack, false);
});

test("S1 곧 때가 될 단위 — 주기대로 기다리는 중이고 남은 시간이 주기의 절반 이하", () => {
  const at = (sec: number) => new Date(NOW + sec * 1000).toISOString();
  const iv = 2 * H;
  assert.equal(isUnitSoon({ next_at: at(iv * SOON_RATIO), interval_sec: iv, sched: { why: "interval" } }, NOW), true, "정확히 절반");
  assert.equal(isUnitSoon({ next_at: at(iv * SOON_RATIO + 1), interval_sec: iv, sched: { why: "interval" } }, NOW), false);
  assert.equal(isUnitSoon({ next_at: at(60), interval_sec: iv, sched: { why: "retry" } }, NOW), false, "물러서는 단위는 싣지 않는다");
  assert.equal(isUnitSoon({ next_at: at(60), interval_sec: iv, sched: { why: "catchup" } }, NOW), false);
  assert.equal(isUnitSoon({ next_at: at(0), interval_sec: iv, sched: { why: "interval" } }, NOW), false, "이미 때가 된 단위는 isUnitDue 몫");
  assert.equal(isUnitSoon({ next_at: null, interval_sec: iv, sched: { why: "interval" } }, NOW), false);
  assert.equal(isUnitSoon({ next_at: at(60), interval_sec: iv, sched: null }, NOW), false);
});

test("R1 저장 단계 → 주기 판정 입력 — 노션처럼 다음 위치가 없는 «못 다 읽음» 은 줄이지 않은 것(shrunk:false)", () => {
  const base = { reads: 1, complete: false, nextCursor: null as Record<string, unknown> | null, stuck: false, sample: null };
  const now = NOW;
  assert.deepEqual(readNoteOf({ app: "slack" }, { ...base, reads: 0 }, { blocked: true, nowMs: now }), { outcome: "unread" }, "안 읽었으면 막힘보다 먼저");
  assert.deepEqual(readNoteOf({ app: "slack" }, { ...base, complete: true }, { blocked: true, nowMs: now }), { outcome: "blocked" });
  const sample = { e: PLANNED - 60, s: 3600, n: 2 };
  assert.deepEqual(readNoteOf({ app: "slack" }, { ...base, complete: true, nextCursor: { ts: `${PLANNED - 60}.000000` }, sample }, { blocked: false, nowMs: now }),
    { outcome: "complete", behind: false, sample });
  assert.deepEqual(readNoteOf({ app: "slack" }, { ...base, complete: true, nextCursor: { ts: `${PLANNED - 8 * D}.000000` }, sample: null }, { blocked: false, nowMs: now }),
    { outcome: "complete", behind: true, sample: null }, "다 읽었지만 밀림");
  assert.deepEqual(readNoteOf({ app: "slack" }, { ...base, nextCursor: { ts: "1.0", span: 3600 }, stuck: true }, { blocked: false, nowMs: now }),
    { outcome: "incomplete", shrunk: true, stuck: true });
  assert.deepEqual(readNoteOf({ app: "notion" }, { ...base, nextCursor: null }, { blocked: false, nowMs: now }),
    { outcome: "incomplete", shrunk: false, stuck: false }, "노션 — 줄일 구간이 없다");
});

test("R1b 노션 fetch 가 오류 모양이면(실측 리뷰 재현) 다음 위치 없이 «못 다 읽음» → shrunk:false", () => {
  const bad = cap("Notion", "notion-fetch", { error: "rate limited" }, { id: NOTION_REF });
  const h = harvestUnits([bad], [notionUnit()], { plannedAt: PLANNED }).byUnit.get(3)!;
  assert.equal(h.reads, 1);
  assert.equal(h.complete, false);
  assert.deepEqual(readNoteOf({ app: "notion" }, h, { blocked: false, nowMs: NOW }), { outcome: "incomplete", shrunk: false, stuck: false });
});

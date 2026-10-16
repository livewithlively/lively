// 수집 실행의 계획과 뒷수습(#4213 T11 저장 단계) — 사양 J(실행 종류) · 읽기 구간 · I2/I3(단위별 나누기 · 버리기) · I1(목록) 행.
//  DB 를 안 쓰는 셈만 본다(저장·한 번만 처리는 collect-ingest.pg-test.mjs). 픽스처는 커넥터 결과의 **모양**만 옮긴 합성 글이다.
//
//  엣지 표(사양 → 시나리오)
//   J1 목록 지시 — 앱마다 정한 도구·인자 · 모르는 앱은 던진다      J3 수집 지시 — 단위마다 한 줄 · 구간 끝이 있을 때만 latest/before · 모르는 앱은 뺀다
//   T1 턴 상한 — 바닥 12 · 단위당 8 · 지메일 40 · 천장 60
//   W1 시작점 — 읽은 위치 → (수집기 단위면) 마지막 글 → 처음 14일 · 잘못된 위치는 버린다
//   W2 구간 — 끝이 지금보다 **앞**일 때만 끝을 둔다(경계: 정확히 지금이면 끝 없음)
//   H1 슬랙 채널+스레드 → 한 좌표 한 항목 · 위치 = 채널에서 본 가장 새 ts   H2 구간을 다 읽었으면 조용해도 구간 끝으로
//   H3 다음 쪽이 남으면 위치 그대로(항목은 저장)   H4 요청 안 한 채널은 버린다(stray) · 안 읽은 단위는 위치 없음
//   H5 결과는 있는데 풀린 게 없으면 unparsed      H6 지메일 — 찾은 스레드를 다 펼쳐야 끝 · 다음 쪽 토큰이면 끝 아님 · 본문 쪽이 이긴다
//   H7 지메일 메일함 고르기(주소 · 하나뿐이면 그것)   H8 노션 — 맞는 페이지만 · 위치 = 수정 시각
//   L1 슬랙 목록 — 쪽 합치기 · 보관 채널 뺌 · 마지막 쪽에 다음이 없을 때만 «전부»   L2 다음이 남음/못 푼 쪽 → 전부 아님
//   L3 노션·지메일 목록은 «전부» 가 아니다
import assert from "node:assert/strict";
import {
  CLAUDE_COLLECT_APPS, FIRST_READ_DAYS, GMAIL_WINDOW_SEC, SLACK_WINDOW_SEC, collectMaxTurns, collectPrompt, harvestListing, harvestUnits,
  listingPrompt, unitInstruction, unitSince, unitWindow, type PlannedUnit,
} from "./collect-plan.js";
import { readCapture, type Capture } from "./connector-parse.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const cap = (connector: string, tool: string, inner: unknown, input: Record<string, unknown> = {}): Capture => {
  const c = readCapture({ tool_name: `mcp__claude_ai_${connector}__${tool}`, tool_input: input, tool_response: [{ type: "text", text: typeof inner === "string" ? inner : JSON.stringify(inner) }] });
  assert.ok(c, "배선 — 캡처가 풀렸다");
  return c;
};

const NOW = Date.parse("2026-10-16T10:00:00.000Z");
const NOW_SEC = NOW / 1000;
const SLACK: PlannedUnit = { id: 1, app: "slack", instance: "T0TEAM", ref: "C0AAAAAAA1", kind: "channel", name: "general", connector: "Slack", since: "1787000000.000000", until: null };
const GMAIL: PlannedUnit = { id: 2, app: "gmail", instance: "default", ref: "me@example.com", kind: "mailbox", name: null, connector: "Gmail", since: "1790900000", until: "1790986400" };
const NOTION: PlannedUnit = { id: 3, app: "notion", instance: "", ref: "abcdef01-2345-6789-abcd-ef0123456789", kind: "page", name: "회의록", connector: "Notion", since: null, until: null };

// ── J 지시 ──
t("J1 목록 지시 — 슬랙은 모든 대화 종류·limit 200·cursor 끝까지 · 노션은 목록 도구 셋 · 지메일은 한 번 · 모르는 앱은 던진다", () => {
  const s = listingPrompt("slack");
  assert.match(s, /slack_list_user_channels 를 types="public_channel,private_channel,mpim,im", limit=200, exclude_archived=true/);
  assert.match(s, /cursor 가 없을 때까지/);
  const n = listingPrompt("notion");
  for (const tool of ["notion-list-shared-pages", "notion-list-private-pages", "notion-list-recent-pages"]) assert.ok(n.includes(tool), tool);
  assert.match(listingPrompt("gmail"), /search_threads 를 pageSize=1/);
  for (const p of [s, n]) assert.match(p, /보내기·만들기·고치기·지우기 도구는 부르지 않는다/);
  assert.throws(() => listingPrompt("jira"));
  assert.deepEqual(Object.keys(CLAUDE_COLLECT_APPS).sort(), ["gmail", "notion", "slack"]);
});
t("J3 수집 지시 — 단위마다 정확한 도구·인자 · 구간 끝이 있을 때만 latest/before · 모르는 앱 단위는 뺀다", () => {
  const jira = { ...SLACK, id: 9, app: "jira", ref: "PROJ-1" };
  const { prompt, units } = collectPrompt([SLACK, { ...SLACK, id: 4, ref: "C0BBBBBBB2", until: "1787604800.000000" }, GMAIL, { ...GMAIL, id: 5, until: null }, NOTION, jira]);
  assert.deepEqual(units.map((u) => u.id), [1, 4, 2, 5, 3], "모르는 앱(jira)은 지시에도 계획에도 없다");
  assert.ok(prompt.includes('slack_read_channel 을 channel_id="C0AAAAAAA1", oldest="1787000000.000000", limit=100'), "구간 끝이 없으면 latest 없음");
  assert.ok(prompt.includes('channel_id="C0BBBBBBB2", oldest="1787000000.000000", latest="1787604800.000000", limit=100'));
  assert.ok(prompt.includes('query="after:1790900000 before:1790986400"'));
  assert.ok(prompt.includes('query="after:1790900000", pageSize=50'), "구간 끝이 없으면 before 없음");
  assert.ok(prompt.includes('notion-fetch 를 id="abcdef01-2345-6789-abcd-ef0123456789"'));
  assert.ok(!prompt.includes("PROJ-1"));
  assert.match(prompt, /slack_read_thread 를 channel_id="C0AAAAAAA1"/);
  assert.match(prompt, /get_thread 를 threadId=<그 id>, messageFormat="PLAIN_TEXT"/);
});
t("J3b 이름은 지시를 깨지 않게 — 따옴표·줄바꿈은 띄어쓰기 · 60자까지 · 데이터베이스는 그렇게 적는다", () => {
  const line = unitInstruction({ ...SLACK, name: '나쁜"이름\n' + "가".repeat(100) })!;
  assert.ok(!/나쁜"/.test(line) && !line.includes("\n가"), "따옴표·줄바꿈이 지시에 안 들어간다");
  assert.ok(line.includes(`C0AAAAAAA1(나쁜 이름 ${"가".repeat(54)})`), "60자에서 자른다");
  assert.match(unitInstruction({ ...NOTION, kind: "database" })!, /노션 데이터베이스/);
  assert.equal(unitInstruction({ ...SLACK, app: "jira" }), null);
});
t("T1 턴 상한 — 바닥 12 · 단위당 8 · 지메일 단위당 40 더 · 천장 60(경계 포함)", () => {
  assert.equal(collectMaxTurns(0), 12);
  assert.equal(collectMaxTurns(1), 14);
  assert.equal(collectMaxTurns(6), 54);
  assert.equal(collectMaxTurns(7), 60, "6+56=62 → 60");
  assert.equal(collectMaxTurns(1, 1), 54);
  assert.equal(collectMaxTurns(2, 1), 60);
});

// ── W 구간 ──
const U = (o: Record<string, unknown>) => ({ app: "slack", cursor: null, last_item_at: null, from_collector: false, ...o }) as Parameters<typeof unitSince>[0];
t("W1 시작점 — 읽은 위치 → 수집기 단위의 마지막 글 → 처음 14일 · 모양이 틀린 위치는 버린다", () => {
  const first = NOW_SEC - FIRST_READ_DAYS * 86400;
  assert.equal(unitSince(U({ cursor: { ts: "1787193938.792269" } }), NOW), "1787193938.792269");
  assert.equal(unitSince(U({ cursor: { ts: "어제" } }), NOW), `${first}.000000`);
  assert.equal(unitSince(U({ cursor: { ts: 1787193938 } }), NOW), `${first}.000000`, "숫자 ts 는 위치가 아니다");
  assert.equal(unitSince(U({ last_item_at: "2026-10-10T00:00:00.000Z", from_collector: true }), NOW), `${Date.parse("2026-10-10T00:00:00.000Z") / 1000}.000000`);
  assert.equal(unitSince(U({ last_item_at: "2026-10-10T00:00:00.000Z" }), NOW), `${first}.000000`, "수집기 단위가 아니면 마지막 글 시각을 시작점으로 안 쓴다");
  assert.equal(unitSince(U({ app: "gmail", cursor: { after: 1790900000 } }), NOW), "1790900000");
  for (const after of [0, -1, 1.5, "1790900000"]) assert.equal(unitSince(U({ app: "gmail", cursor: { after } }), NOW), String(first), JSON.stringify(after));
  assert.equal(unitSince(U({ app: "notion", cursor: { edited_at: "x" } }), NOW), null);
});
t("W2 구간 — 끝이 지금보다 앞일 때만 끝을 둔다(정확히 지금이면 끝 없음 — 지금까지 읽는다)", () => {
  const at = (s: number) => U({ cursor: { ts: `${s}.000000` } });
  assert.deepEqual(unitWindow(at(NOW_SEC - SLACK_WINDOW_SEC - 1), NOW), { since: `${NOW_SEC - SLACK_WINDOW_SEC - 1}.000000`, until: `${NOW_SEC - 1}.000000` });
  assert.deepEqual(unitWindow(at(NOW_SEC - SLACK_WINDOW_SEC), NOW).until, null, "경계 — 끝 = 지금");
  const g = (s: number) => U({ app: "gmail", cursor: { after: s } });
  assert.deepEqual(unitWindow(g(NOW_SEC - GMAIL_WINDOW_SEC - 1), NOW), { since: String(NOW_SEC - GMAIL_WINDOW_SEC - 1), until: String(NOW_SEC - 1) });
  assert.equal(unitWindow(g(NOW_SEC - GMAIL_WINDOW_SEC), NOW).until, null, "경계 — 끝 = 지금");
  assert.deepEqual(unitWindow(U({ app: "notion" }), NOW), { since: null, until: null });
  //  처음 읽는 단위는 14일 전부터 7일씩 — 첫 판의 끝은 7일 전
  assert.deepEqual(unitWindow(U({}), NOW).until, `${NOW_SEC - FIRST_READ_DAYS * 86400 + SLACK_WINDOW_SEC}.000000`);
});

// ── H 원문 → 단위별 자료 ──
const CH = (msgs: Array<[string, string, string?]>, o: { channel?: string; more?: boolean } = {}) => cap("Slack", "slack_read_channel", {
  messages: [`Channel: #general (${o.channel ?? "C0AAAAAAA1"})`, "",
    ...msgs.flatMap(([ts, body, tail]) => [`=== Message from Kim <kim@example.com> (U0AAAAAAA1) at x ===`, `Message TS: ${ts}`, body, ...(tail ? [tail] : []), ""])].join("\n"),
  pagination_info: o.more ? "There are more messages available. To get the next page, use cursor: `bmV4dA==`" : "",
}, { channel_id: o.channel ?? "C0AAAAAAA1" });
const TH = (channel: string, parent: string, replies: string[]) => cap("Slack", "slack_read_thread", {
  messages: ["=== THREAD PARENT MESSAGE ===", "From: Kim <kim@example.com> (U0AAAAAAA1)", "Time: x", `Message TS: ${parent}`, "부모 본문", "",
    "=== THREAD REPLIES (n) ===", "", ...replies.flatMap((ts, i) => [`--- Reply ${i + 1} of ${replies.length} ---`, "From: Lee (U0CCCCCCC3)", "Time: y", `Message TS: ${ts}`, `답글 ${i + 1}`, ""])].join("\n"),
}, { channel_id: channel, message_ts: parent });

t("H1 슬랙 채널 + 스레드 → 같은 좌표는 한 항목 · 위치 = 채널에서 본 가장 새 ts · 마지막 글 시각은 답글까지", () => {
  const caps = [
    CH([["1787193938.792269", "부모 본문", "Thread: 2 replies (latest: z)"], ["1787195400.000200", "나중 글"]]),
    TH("C0AAAAAAA1", "1787193938.792269", ["1787194200.111111", "1787199000.000300"]),
  ];
  const { byUnit, stray } = harvestUnits(caps, [SLACK]);
  const h = byUnit.get(1)!;
  assert.equal(stray, 0);
  assert.equal(h.reads, 2);
  assert.deepEqual(h.items.map((i) => i.provenance.external_id).sort(), [
    "C0AAAAAAA1:1787193938.792269", "C0AAAAAAA1:1787194200.111111", "C0AAAAAAA1:1787195400.000200", "C0AAAAAAA1:1787199000.000300",
  ], "부모가 채널·스레드 양쪽에 나와도 한 번");
  assert.equal(h.items.find((i) => i.provenance.external_id.endsWith("1787194200.111111"))!.parent_external_id, "C0AAAAAAA1:1787193938.792269");
  assert.equal(h.items[0].provenance.instance, "T0TEAM", "단위의 인스턴스로 좌표를 만든다");
  assert.equal(h.complete, true);
  assert.deepEqual(h.nextCursor, { ts: "1787195400.000200" }, "답글 ts 가 아니라 채널 기록의 위치");
  assert.equal(h.lastItemAt, new Date(1787199000000).toISOString());
  assert.equal(h.unparsed, 0);
});
t("H2 구간을 끝까지 읽었으면 조용한 구간도 구간 끝으로 넘어간다 · 구간 끝이 없고 새 글도 없으면 위치는 그대로", () => {
  const empty = cap("Slack", "slack_read_channel", { messages: "Channel: #general (C0AAAAAAA1)\n\nNo messages found in this time range.", pagination_info: "" }, { channel_id: "C0AAAAAAA1" });
  const w = harvestUnits([empty], [{ ...SLACK, until: "1787604800.000000" }]).byUnit.get(1)!;
  assert.deepEqual([w.reads, w.items.length, w.nextCursor], [1, 0, { ts: "1787604800.000000" }]);
  const n = harvestUnits([empty], [SLACK]).byUnit.get(1)!;
  assert.deepEqual([n.reads, n.nextCursor], [1, null]);
  //  구간 끝이 있으면 새 글이 있어도 구간 끝으로(구간 안의 가장 새 글이 아니라)
  const x = harvestUnits([CH([["1787195400.000200", "글"]])], [{ ...SLACK, until: "1787604800.000000" }]).byUnit.get(1)!;
  assert.deepEqual(x.nextCursor, { ts: "1787604800.000000" });
});
t("H3 다음 쪽이 남으면(못 다 읽음) 위치는 그대로 — 읽은 항목은 저장한다", () => {
  const h = harvestUnits([CH([["1787195400.000200", "글"]], { more: true })], [{ ...SLACK, until: "1787604800.000000" }]).byUnit.get(1)!;
  assert.deepEqual([h.complete, h.nextCursor, h.items.length], [false, null, 1]);
});
t("H4 요청하지 않은 채널(채널 읽기·스레드)은 버린다 · 이 판이 안 읽은 단위는 위치가 없다", () => {
  const { byUnit, stray } = harvestUnits([CH([["1787195400.000200", "남의 글"]], { channel: "C0ZZZZZZZ9" }), TH("C0ZZZZZZZ9", "1787195400.000200", ["1787195401.000000"])], [SLACK]);
  assert.equal(stray, 2);
  const h = byUnit.get(1)!;
  assert.deepEqual([h.reads, h.items.length, h.nextCursor, h.lastItemAt], [0, 0, null, null]);
});
t("H5 결과 글은 긴데 풀린 메시지가 없으면 unparsed(형식이 바뀌었을 수 있다) · «메시지 없음» 은 아니다 · 빈 스레드도 unparsed", () => {
  const junk = cap("Slack", "slack_read_channel", { messages: "알 수 없는 형식 ".repeat(60) }, { channel_id: "C0AAAAAAA1" });
  assert.equal(harvestUnits([junk], [SLACK]).byUnit.get(1)!.unparsed, 1);
  const none = cap("Slack", "slack_read_channel", { messages: "No messages found. " + " ".repeat(500) }, { channel_id: "C0AAAAAAA1" });
  assert.equal(harvestUnits([none], [SLACK]).byUnit.get(1)!.unparsed, 0);
  const thJunk = cap("Slack", "slack_read_thread", { messages: "?" }, { channel_id: "C0AAAAAAA1", message_ts: "1787195400.000200" });
  const h = harvestUnits([thJunk], [SLACK]).byUnit.get(1)!;
  assert.deepEqual([h.reads, h.unparsed], [1, 1]);
});

const GM = (id: string, threadId: string, o: Record<string, unknown> = {}) => ({
  id, threadId, subject: "제목", sender: "Kim <kim@example.com>", date: "2026-10-02T23:49:36Z", snippet: "요약", labelIds: [],
  viewUrl: `https://mail.google.com/mail/?authuser=me%40example.com#all/${id}`, ...o,
});
const T1 = "18f0a1b2c3d4e5f6", T2 = "18f0a1b2c3d4e700";
const search = (o: { token?: boolean; box?: string } = {}) => cap("Gmail", "search_threads", {
  threads: [{ id: T1, messages: [GM(T1, T1, o.box ? { viewUrl: `https://mail.google.com/mail/?authuser=${o.box}#all/x` } : {})] }, { id: T2, messages: [GM(T2, T2)] }],
  ...(o.token ? { nextPageToken: "p2" } : {}),
});
const thread = (id: string, extra: object[] = []) => cap("Gmail", "get_thread", { id, messages: [GM(id, id, { plaintextBody: `${id} 본문`, date: "2026-10-03T01:00:00Z" }), ...extra] });
t("H6 지메일 — 찾은 스레드를 다 펼쳐야 끝 · 하나라도 안 펼쳤으면 위치 그대로 · 본문 쪽이 요약을 이긴다", () => {
  const part = harvestUnits([search(), thread(T1)], [GMAIL]).byUnit.get(2)!;
  assert.deepEqual([part.complete, part.nextCursor], [false, null], "T2 를 안 펼쳤다");
  const full = harvestUnits([search(), thread(T1), thread(T2, [GM("18f0a1b2c3d4e701", T2, { plaintextBody: "답장" })])], [GMAIL]).byUnit.get(2)!;
  assert.equal(full.complete, true);
  assert.deepEqual(full.nextCursor, { after: 1790986400 }, "구간 끝으로");
  assert.equal(full.items.length, 3);
  assert.equal(full.items.find((i) => i.provenance.external_id === T1)!.body, `${T1} 본문`, "search 의 요약이 아니라 get_thread 본문");
  assert.equal(full.items.find((i) => i.provenance.external_id === "18f0a1b2c3d4e701")!.parent_external_id, T2);
  //  구간 끝이 없으면 마지막 글 시각
  const open = harvestUnits([search(), thread(T1), thread(T2)], [{ ...GMAIL, until: null }]).byUnit.get(2)!;
  assert.deepEqual(open.nextCursor, { after: Date.parse("2026-10-03T01:00:00Z") / 1000 });
  //  다음 쪽 토큰이 있으면 끝이 아니다
  assert.equal(harvestUnits([search({ token: true }), thread(T1), thread(T2)], [GMAIL]).byUnit.get(2)!.complete, false);
});
t("H7 지메일 메일함 — 둘 이상이면 주소로 · 하나뿐이면 주소를 못 읽은 결과도 그 메일함 · 둘 이상인데 주소가 없으면 버린다", () => {
  const OTHER: PlannedUnit = { ...GMAIL, id: 6, ref: "other@example.com" };
  const r = harvestUnits([search({ box: "other%40example.com" })], [GMAIL, OTHER]);
  assert.deepEqual([r.byUnit.get(6)!.reads, r.byUnit.get(2)!.reads], [1, 0], "결과의 첫 메일함 주소로 고른다");
  const noBox = cap("Gmail", "get_thread", { id: T1, messages: [GM(T1, T1, { viewUrl: null, plaintextBody: "x" })] });
  assert.equal(harvestUnits([noBox], [GMAIL]).byUnit.get(2)!.reads, 1);
  assert.equal(harvestUnits([noBox], [GMAIL, OTHER]).stray, 1);
});
t("H8 노션 — 계획한 페이지만 · 위치 = 수정 시각 · 다른 페이지는 버린다", () => {
  const fetch = (url: string) => cap("Notion", "notion-fetch", { metadata: { type: "page" }, title: "회의록", url, text: "<content>\n본문\n</content>", page_last_edited_at: "2026-08-25T10:37:30.618Z" });
  const r = harvestUnits([fetch("https://www.notion.so/abcdef0123456789abcdef0123456789"), fetch("https://www.notion.so/99999999999999999999999999999999")], [NOTION]);
  const h = r.byUnit.get(3)!;
  assert.equal(r.stray, 1);
  assert.deepEqual([h.reads, h.items.length, h.items[0].provenance.external_id, h.nextCursor], [1, 1, NOTION.ref, { edited_at: "2026-08-25T10:37:30.618Z" }]);
});

// ── L 목록 ──
const listPage = (rows: Array<[string, string, string, boolean?]>, cursor?: string) => cap("Slack", "slack_list_user_channels", {
  result: [...rows.flatMap(([id, name, type, archived]) => [`### #${name}`, `- **ID:** ${id}`, `- **Type:** ${type}`, ...(archived ? ["- **Archived:** Yes"] : []), ""]),
    ...(cursor ? [`There are more results available. Use cursor: "${cursor}"`] : [])].join("\n"),
});
t("L1 슬랙 목록 — 쪽을 합치고(같은 채널 한 번) · 보관 채널은 뺀다 · 마지막 쪽에 다음이 없으면 «전부»", () => {
  const r = harvestListing([
    listPage([["C0AAAAAAA1", "general", "Public Channel"], ["C0CCCCCCC3", "old", "Public Channel", true]], "c2"),
    listPage([["C0BBBBBBB2", "secret", "Private Channel"], ["C0AAAAAAA1", "general", "Public Channel"]]),
  ], "slack");
  assert.deepEqual(r.units.map((u) => [u.ref, u.kind]), [["C0AAAAAAA1", "channel"], ["C0BBBBBBB2", "private_channel"]]);
  assert.deepEqual([r.calls, r.complete, r.unparsed], [2, true, 0]);
});
t("L2 마지막 쪽에도 다음이 남음(쪽 상한) · 못 푼 쪽이 섞임 · 목록 도구를 안 부름 → «전부» 아님", () => {
  assert.equal(harvestListing([listPage([["C0AAAAAAA1", "general", "Public Channel"]], "c2")], "slack").complete, false);
  const junk = cap("Slack", "slack_list_user_channels", { result: "모르는 형식 ".repeat(40) });
  const r = harvestListing([listPage([["C0AAAAAAA1", "general", "Public Channel"]]), junk], "slack");
  assert.deepEqual([r.complete, r.unparsed, r.units.length], [false, 1, 1]);
  const none = harvestListing([cap("Slack", "slack_read_channel", { messages: "" })], "slack");
  assert.deepEqual([none.calls, none.complete], [0, false], "다른 도구는 목록이 아니다");
});
t("L3 노션 목록은 합치되 «전부» 가 아니다 · 지메일은 메일함 하나(주소 없으면 없음)", () => {
  const nl = (tool: string, ids: string[]) => cap("Notion", tool, { results: ids.map((id) => ({ type: "page", url: `https://www.notion.so/${id}`, title: id.slice(0, 4) })) });
  const n = harvestListing([nl("notion-list-shared-pages", ["abcdef0123456789abcdef0123456789"]), nl("notion-list-private-pages", ["0123456789abcdef0123456789abcdef"]),
    nl("notion-list-recent-pages", ["abcdef0123456789abcdef0123456789"])], "notion");
  assert.deepEqual([n.units.length, n.calls, n.complete], [2, 3, false]);
  const g = harvestListing([search()], "gmail");
  assert.deepEqual([g.units, g.complete, g.calls], [[{ ref: "me@example.com", name: "me@example.com", kind: "mailbox" }], false, 1]);
  const g0 = harvestListing([cap("Gmail", "search_threads", { threads: [] })], "gmail");
  assert.deepEqual([g0.units, g0.calls], [[], 1]);
});

console.log(`\ncollect-plan: ${pass} passed`);

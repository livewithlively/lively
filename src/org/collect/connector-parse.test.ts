// claude.ai 커넥터 원문 풀기(#4213 T11 저장 단계) — 사양 P 표(X·S·G·N·E) 행마다 시나리오 하나 이상.
//  픽스처는 맥 실측(2026-10-16, Claude Code 2.1.301)에서 본 **모양**만 옮긴 합성 글이다(실제 대화·메일·페이지 내용은 없다).
//  단언은 «좌표가 기존 수집기와 같은가» 에 무게를 둔다 — 좌표가 어긋나면 같은 글이 두 행이 된다.
import assert from "node:assert/strict";
import {
  firstLineTitle, gmailItem, gmailMailbox, isGmailFetch, isGmailSearch, notionId, notionItem, parseGmailMessages, parseNotionFetch, parseNotionList,
  parseSlackChannelList, parseSlackChannelMessages, parseSlackThread, readCapture, slackItem, slackTsIso, type Capture,
} from "./connector-parse.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

/** 진짜 커넥터처럼 — 결과는 [{type:"text", text}] 이고 슬랙·노션은 그 text 가 JSON 문자열이다. */
const cap = (tool: string, inner: unknown, input: Record<string, unknown> = {}, connector = "Slack"): Capture => {
  const c = readCapture({ tool_name: `mcp__claude_ai_${connector}__${tool}`, tool_input: input, tool_response: [{ type: "text", text: typeof inner === "string" ? inner : JSON.stringify(inner) }] });
  assert.ok(c, "배선 — 캡처가 풀렸다");
  return c;
};

// ── X 캡처 한 건 ──
t("X1 결과 글 — [{text}] 는 이어 붙이고 · 문자열은 그대로 · 객체는 JSON · saved_text 가 있으면 그것", () => {
  const base = { tool_name: "mcp__claude_ai_Slack__slack_read_channel", tool_input: { channel_id: "C0AAAAAAA1" } };
  assert.equal(readCapture({ ...base, tool_response: [{ type: "text", text: "가" }, { type: "text", text: "나" }] })!.text, "가\n나");
  assert.equal(readCapture({ ...base, tool_response: "그냥 글" })!.text, "그냥 글");
  assert.equal(readCapture({ ...base, tool_response: { a: 1 } })!.text, '{"a":1}');
  assert.equal(readCapture({ ...base, tool_response: "Output has been saved to /x.txt", saved_text: "원문 전체" })!.text, "원문 전체");
  const c = readCapture({ ...base, tool_response: [] })!;
  assert.deepEqual([c.connector, c.tool, c.input.channel_id], ["Slack", "slack_read_channel", "C0AAAAAAA1"]);
  //  커넥터 이름의 밑줄은 띄어쓰기(«claude.ai Google Drive»)
  assert.deepEqual([readCapture({ tool_name: "mcp__claude_ai_Google_Drive__google_drive_fetch" })!.connector, readCapture({ tool_name: "mcp__claude_ai_Google_Drive__google_drive_fetch" })!.tool],
    ["Google Drive", "google_drive_fetch"]);
});
t("X2 안쪽이 JSON 이면 풀고, 아니면 글 그대로(json null) · 입력이 없으면 빈 객체", () => {
  const j = readCapture({ tool_name: "mcp__claude_ai_Gmail__get_thread", tool_response: [{ type: "text", text: '{"id":"x"}' }] })!;
  assert.deepEqual(j.json, { id: "x" });
  assert.deepEqual(j.input, {});
  assert.equal(readCapture({ tool_name: "mcp__claude_ai_Gmail__get_thread", tool_response: "JSON 아님" })!.json, null);
});
t("E1 claude.ai 커넥터 도구가 아니거나 모양이 틀리면 null — 던지지 않는다", () => {
  for (const bad of [{ tool_name: "Bash" }, { tool_name: "mcp__lively__source_list" }, { tool_name: 7 }, {}]) assert.equal(readCapture(bad), null, JSON.stringify(bad));
  assert.equal(readCapture(null as never), null);
  assert.equal(readCapture([] as never), null);
});

// ── S 슬랙 ──
const LIST_P1 = {
  result: [
    "### #general", "- **ID:** C0AAAAAAA1", "- **Type:** Public Channel", "- **Members:** 12", "",
    "### #secret-proj", "- **ID:** C0BBBBBBB2", "- **Type:** Private Channel", "",
    "### #old-room", "- **ID:** C0CCCCCCC3", "- **Type:** Public Channel", "- **Archived:** Yes", "",
    "### Kim Dev", "- **ID:** D0DDDDDDD4", "- **Type:** Direct Message", "",
    "### mpdm-kim--lee--park", "- **ID:** G0EEEEEEE5", "- **Type:** Multi-Party Direct Message", "",
    "### #broken (ID 없음)", "- **Type:** Public Channel", "",
    'There are more results available. Use cursor: "dXNlcjpVMEFC"',
  ].join("\n"),
};
t("S1 채널 목록 — id·이름·종류(공개·비공개·DM·그룹 DM) · ID 없는 칸은 버린다 · 보관 채널 표시", () => {
  const r = parseSlackChannelList(cap("slack_list_user_channels", LIST_P1));
  assert.deepEqual(r.units, [
    { ref: "C0AAAAAAA1", name: "general", kind: "channel" },
    { ref: "C0BBBBBBB2", name: "secret-proj", kind: "private_channel" },
    { ref: "C0CCCCCCC3", name: "old-room", kind: "channel" },
    { ref: "D0DDDDDDD4", name: "Kim Dev", kind: "dm" },
    { ref: "G0EEEEEEE5", name: "mpdm-kim--lee--park", kind: "group_dm" },
  ]);
  assert.deepEqual(r.archived, ["C0CCCCCCC3"]);
});
t("S2 다음 쪽 — cursor 가 있으면 있다(문구가 바뀌어도 · «전부» 판정이 구성원을 지우므로 의심스러우면 더 있음) · 없으면 끝", () => {
  const r = parseSlackChannelList(cap("slack_list_user_channels", LIST_P1));
  assert.deepEqual([r.more, r.cursor], [true, "dXNlcjpVMEFC"]);
  const last = parseSlackChannelList(cap("slack_list_user_channels", { result: "### #a\n- **ID:** C0AAAAAAA1\n- **Type:** Public Channel" }));
  assert.deepEqual([last.more, last.cursor], [false, null]);
  const odd = parseSlackChannelList(cap("slack_list_user_channels", { result: '### #a\n- **ID:** C0AAAAAAA1\nUse cursor: "x"' }));
  assert.deepEqual([odd.more, odd.cursor], [true, "x"]);
});

const CH_TEXT = [
  "Channel: #general (C0AAAAAAA1)", "",
  "=== Message from Kim Dev <Kim@Example.com> (U0AAAAAAA1) at 2026-08-20 11:45:38 KST ===",
  "Message TS: 1787193938.792269",
  "배포 일정 공유합니다", "둘째 줄",
  "Thread: 3 replies (latest: 2026-08-20 12:00:00 KST)",
  "Reactions: :+1: (2)", "",
  "=== Message from deploy-bot (B0BBBBBBB2) at 2026-08-20 11:50:00 KST ===",
  "Message TS: 1787194200.111111", "",
  "=== Message from Lee <lee@example.com> (U0CCCCCCC3) at 2026-08-20 12:10:00 KST ===",
  "Message TS: 1787195400.000200",
  "Thread: 이건 본문 줄이다", "마지막 줄",
  "Files: report.pdf",
].join("\n");
const NO_MORE = "There are no more messages available.\n";
const chCap = (pagination = NO_MORE, input: Record<string, unknown> = { channel_id: "C0AAAAAAA1" }) => cap("slack_read_channel", { messages: CH_TEXT, pagination_info: pagination }, input);
t("S3 채널 읽기 — 채널 · 메시지마다 ts·작성자(메일 소문자)·본문(꼬리 메타 줄 뺌)·답글 수", () => {
  const r = parseSlackChannelMessages(chCap());
  assert.deepEqual(r.channel, { id: "C0AAAAAAA1", name: "general" });
  assert.equal(r.messages.length, 3);
  assert.deepEqual(r.messages[0], {
    ts: "1787193938.792269", user_id: "U0AAAAAAA1", user_name: "Kim Dev", email: "kim@example.com", at: "2026-08-20 11:45:38 KST",
    body: "배포 일정 공유합니다\n둘째 줄", reply_count: 3,
  });
  assert.deepEqual([r.more, r.end, r.cursor, r.wellFormed], [false, true, null, true], "«더 없음» 이 분명하다");
  const p = parseSlackChannelMessages(chCap("There are more messages available. To view the next page, use cursor: `bmV4dA==`"));
  assert.deepEqual([p.more, p.end, p.cursor, p.wellFormed], [true, false, "bmV4dA==", true]);
  //  쪽 안내가 없거나 모르는 글이면 제 모양이 아니다(«다 읽었다» 의 증거가 못 된다)
  for (const pag of ["", "뭔가 다른 안내"]) assert.equal(parseSlackChannelMessages(chCap(pag)).wellFormed, false, JSON.stringify(pag));
});
t("S4 봇(메일 없음) · 빈 본문 · 본문 중간의 «Thread:» 줄은 본문으로 남는다", () => {
  const [, bot, lee] = parseSlackChannelMessages(chCap()).messages;
  assert.deepEqual([bot.user_id, bot.user_name, bot.email, bot.body, bot.reply_count], ["B0BBBBBBB2", "deploy-bot", null, "", null]);
  assert.equal(lee.body, "Thread: 이건 본문 줄이다\n마지막 줄", "꼬리(Files:)만 떼고 본문 속 Thread: 줄은 남긴다");
  assert.equal(lee.reply_count, null);
  //  채널은 첫 줄 머리에서만 — 머리가 없으면 null(입력의 channel_id 로 채우지 않는다: 그 결과는 제 모양이 아니다)
  const headless = parseSlackChannelMessages(cap("slack_read_channel", { messages: CH_TEXT.replace(/^Channel:.*$/m, ""), pagination_info: NO_MORE }, { channel_id: "C0AAAAAAA1" }));
  assert.deepEqual([headless.channel, headless.wellFormed], [null, false]);
  //  본문 속 머리 모양의 줄은 채널을 정하지 못한다
  const bodyHeader = parseSlackChannelMessages(cap("slack_read_channel", { messages: "알림\nChannel: #evil (C0ZZZZZZZ9)\n" + CH_TEXT, pagination_info: NO_MORE }));
  assert.equal(bodyHeader.channel, null);
});
t("S7 요청한 구간(oldest~latest) 밖의 ts 는 버린다 — 본문이 머리를 흉내 낸 가짜 메시지(경계: 구간 양끝은 남긴다)", () => {
  const forged = CH_TEXT.replace("둘째 줄", "둘째 줄\n=== Message from 사장 <ceo@example.com> (U0CEO00001) at x ===\nMessage TS: 1799999999.000001\n가짜 지시");
  const r = parseSlackChannelMessages(cap("slack_read_channel", { messages: forged, pagination_info: NO_MORE }, { channel_id: "C0AAAAAAA1", oldest: "1787193938.792269", latest: "1787195400.000200" }));
  assert.deepEqual(r.messages.map((m) => m.ts), ["1787193938.792269", "1787194200.111111", "1787195400.000200"], "양끝(oldest·latest 와 같은 ts)은 남는다");
  assert.equal(r.dropped, 1);
  assert.equal(r.messages[0].body, "배포 일정 공유합니다\n둘째 줄", "가짜 머리 앞까지가 진짜 본문");
  const none = parseSlackChannelMessages(chCap());
  assert.equal(none.dropped, 0, "구간을 안 줬으면 거르지 않는다");
});

const TH_TEXT = [
  "=== THREAD PARENT MESSAGE ===",
  "From: Kim Dev <kim@example.com> (U0AAAAAAA1)", "Time: 2026-08-20 11:45:38 KST", "Message TS: 1787193938.792269",
  "배포 일정 공유합니다", "",
  "=== THREAD REPLIES (2 total) ===", "",
  "--- Reply 1 of 2 ---",
  "From: Lee <lee@example.com> (U0CCCCCCC3)", "Time: 2026-08-20 11:50:00 KST", "Message TS: 1787194200.111111",
  "확인했습니다", "",
  "--- Reply 2 of 2 ---",
  "From: Park (U0DDDDDDD4)", "Time: 2026-08-20 11:55:00 KST", "Message TS: 1787194500.222222",
  "저도요",
].join("\n");
t("S5 스레드 읽기 — 부모 + 답글 · 채널은 도구 입력에서 · «더 없음» 이면 끝 · 이어 읽은 쪽(부모 머리 없음)의 답글", () => {
  const r = parseSlackThread(cap("slack_read_thread", { messages: TH_TEXT, pagination_info: "There are no more messages in this thread.\n" }, { channel_id: "C0AAAAAAA1", message_ts: "1787193938.792269" }));
  assert.equal(r.channelId, "C0AAAAAAA1");
  assert.deepEqual([r.end, r.more, r.wellFormed], [true, false, true]);
  assert.equal(parseSlackThread(cap("slack_read_thread", { messages: TH_TEXT }, { channel_id: "C0AAAAAAA1" })).wellFormed, false, "쪽 안내가 없으면 제 모양이 아니다");
  const cont = parseSlackThread(cap("slack_read_thread", { messages: "--- Reply 3 of 3 ---\nFrom: Lee (U0CCCCCCC3)\nTime: y\nMessage TS: 1787194600.000003\n끝 답글", pagination_info: "There are no more messages in this thread.\n" },
    { channel_id: "C0AAAAAAA1", cursor: "t2" }));
  assert.deepEqual([cont.parent, cont.replies.map((m) => m.ts), cont.end], [null, ["1787194600.000003"], true]);
  assert.deepEqual([r.parent?.ts, r.parent?.body, r.parent?.email], ["1787193938.792269", "배포 일정 공유합니다", "kim@example.com"]);
  assert.deepEqual(r.replies.map((m) => [m.ts, m.user_id, m.body]), [["1787194200.111111", "U0CCCCCCC3", "확인했습니다"], ["1787194500.222222", "U0DDDDDDD4", "저도요"]]);
  assert.equal(r.replies[1].email, null);
  assert.equal(parseSlackThread(cap("slack_read_thread", { messages: TH_TEXT }, { channel_id: "nope" })).channelId, null);
});
t("S6 RawItem — 좌표 `채널:ts`(connectors/slack.ts 와 같다) · 답글의 parent · 시각 = ts · 제목 = 첫 줄 · fields", () => {
  const [kim] = parseSlackChannelMessages(chCap()).messages;
  const it = slackItem(kim, { instance: "T0TEAM", channel: "C0AAAAAAA1", channelName: "general" });
  assert.deepEqual(it.provenance, { category: "messenger", system: "slack", instance: "T0TEAM", external_id: "C0AAAAAAA1:1787193938.792269" });
  assert.equal(it.type, "message");
  assert.equal(it.container_ref, "C0AAAAAAA1");
  assert.equal(it.container_name, "general");
  assert.equal(it.parent_external_id, undefined, "부모 메시지는 parent 가 없다");
  assert.equal(it.occurred_at, "2026-08-20T02:45:38.792Z", "11:45:38 KST");
  assert.equal(it.title, "배포 일정 공유합니다");
  assert.deepEqual(it.fields, { ts: "1787193938.792269", thread_ts: "1787193938.792269", reply_count: 3, via: "claude_connector" });
  assert.deepEqual([it.actor?.external_id, it.actor?.email, it.actor?.is_bot], ["U0AAAAAAA1", "kim@example.com", false]);
  const reply = parseSlackThread(cap("slack_read_thread", { messages: TH_TEXT }, { channel_id: "C0AAAAAAA1" })).replies[0];
  const r = slackItem(reply, { instance: "T0TEAM", channel: "C0AAAAAAA1", threadParentTs: "1787193938.792269" });
  assert.equal(r.provenance.external_id, "C0AAAAAAA1:1787194200.111111");
  assert.equal(r.parent_external_id, "C0AAAAAAA1:1787193938.792269");
  assert.equal(r.fields?.thread_ts, "1787193938.792269");
  //  자기 ts 를 부모로 주면 답글이 아니다(부모가 스레드 결과에 다시 나올 때)
  assert.equal(slackItem(kim, { instance: "", channel: "C0AAAAAAA1", threadParentTs: kim.ts }).parent_external_id, undefined);
  const bot = parseSlackChannelMessages(chCap()).messages[1];
  const b = slackItem(bot, { instance: "", channel: "C0AAAAAAA1" });
  assert.deepEqual([b.actor?.is_bot, b.body, b.title], [true, undefined, undefined], "빈 본문은 본문·제목 없음");
  assert.equal(slackTsIso("abc"), undefined);
  assert.equal(firstLineTitle("\n\n  첫 줄  \n둘째"), "첫 줄");
  assert.equal(firstLineTitle("가".repeat(100))!.length, 80, "경계 — 80자에서 자른다");
  assert.equal(firstLineTitle("가".repeat(80)), "가".repeat(80), "정확히 80자는 그대로");
});

// ── G 지메일 ──
const MSG = (id: string, o: Record<string, unknown> = {}) => ({
  id, threadId: "18f0a1b2c3d4e5f6", subject: "견적 요청", sender: '"Kim Dev" <Kim@Example.com>', date: "2026-10-02T23:49:36Z",
  snippet: "안녕하세요 견적…", labelIds: ["INBOX", 7], viewUrl: `https://mail.google.com/mail/?authuser=Me%40Example.com#all/${id}`, ...o,
});
t("G1 search_threads · get_thread · get_message → 메시지(같은 id 면 본문 쪽) · 메일함 = viewUrl authuser(소문자)", () => {
  const s = parseGmailMessages(cap("search_threads", { threads: [{ id: "18f0a1b2c3d4e5f6", messages: [MSG("18f0a1b2c3d4e5f6")] }], nextPageToken: "p2" }, {}, "Gmail"));
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].full, s[0].body, s[0].labelIds], [false, null, ["INBOX"]], "숫자 라벨은 버린다");
  assert.equal(gmailMailbox(s), "me@example.com");
  const g = parseGmailMessages(cap("get_thread", { id: "18f0a1b2c3d4e5f6", messages: [MSG("18f0a1b2c3d4e5f6", { plaintextBody: "본문 전체" }), MSG("18f0a1b2c3d4e600", { plaintextBody: "답장" })] }, {}, "Gmail"));
  assert.deepEqual(g.map((m) => [m.id, m.full, m.body]), [["18f0a1b2c3d4e5f6", true, "본문 전체"], ["18f0a1b2c3d4e600", true, "답장"]]);
  const one = parseGmailMessages(cap("get_message", MSG("18f0a1b2c3d4e601", { plaintextBody: "하나" }), {}, "Gmail"));
  assert.deepEqual(one.map((m) => m.id), ["18f0a1b2c3d4e601"]);
  //  한 결과에 같은 id 가 요약·본문 둘로 오면 본문 쪽
  const both = parseGmailMessages(cap("search_threads", { threads: [{ messages: [MSG("18f0a1b2c3d4e5f6"), MSG("18f0a1b2c3d4e5f6", { plaintextBody: "본문" })] }] }, {}, "Gmail"));
  assert.deepEqual(both.map((m) => m.body), ["본문"]);
  //  internalDate(밀리초)만 있으면 그것으로
  assert.equal(parseGmailMessages(cap("get_message", MSG("18f0a1b2c3d4e602", { date: undefined, internalDate: "1790984976000" }), {}, "Gmail"))[0].date, "2026-10-02T23:49:36.000Z");
});
t("G1c 시각은 구글이 받은 시각(internalDate)이 먼저 — 보낸 쪽이 적은 Date 머리는 칸에만 남긴다", () => {
  const [m] = parseGmailMessages(cap("get_message", MSG("18f0a1b2c3d4e5f6", { date: "Fri, 1 Jan 2099 00:00:00 +0000", internalDate: "1790984976000", plaintextBody: "x" }), {}, "Gmail"));
  assert.equal(m.date, "2026-10-02T23:49:36.000Z");
  const it = gmailItem(m, { instance: "default", mailbox: "me@example.com" });
  assert.deepEqual([it.occurred_at, it.fields?.date_header], ["2026-10-02T23:49:36.000Z", "Fri, 1 Jan 2099 00:00:00 +0000"]);
});
t("G3 제 모양 — search 는 {threads:[…]} · get_thread 는 {id, messages:[…]} · 오류 글·빈 객체는 아니다", () => {
  assert.equal(isGmailSearch(cap("search_threads", { threads: [] }, {}, "Gmail")), true);
  assert.equal(isGmailSearch(cap("search_threads", "Error: invalid query", {}, "Gmail")), false);
  assert.equal(isGmailSearch(cap("search_threads", { error: "x" }, {}, "Gmail")), false);
  assert.equal(isGmailFetch(cap("get_thread", { id: "18f0a1b2c3d4e5f6", messages: [] }, {}, "Gmail")), true);
  assert.equal(isGmailFetch(cap("get_thread", { id: "18f0a1b2c3d4e5f6" }, {}, "Gmail")), false);
  assert.equal(isGmailFetch(cap("get_message", MSG("18f0a1b2c3d4e5f6", { plaintextBody: "x" }), {}, "Gmail")), true);
  assert.equal(isGmailFetch(cap("get_message", { error: "not found" }, {}, "Gmail")), false);
});
t("G1b 메일함을 못 읽는 경우 — viewUrl 없음 · authuser 가 메일 모양이 아님 → null", () => {
  assert.equal(gmailMailbox(parseGmailMessages(cap("get_message", MSG("18f0a1b2c3d4e5f6", { viewUrl: null }), {}, "Gmail"))), null);
  assert.equal(gmailMailbox(parseGmailMessages(cap("get_message", MSG("18f0a1b2c3d4e5f6", { viewUrl: "https://mail.google.com/mail/?authuser=0#all/x" }), {}, "Gmail"))), null);
  assert.equal(gmailMailbox([]), null);
});
t("G2 RawItem — 좌표 = 메시지 id(connectors/gmail.ts 와 같다) · parent = threadId(다를 때만) · 제목 · 본문(없으면 요약)", () => {
  const [first, reply] = parseGmailMessages(cap("get_thread", { messages: [MSG("18f0a1b2c3d4e5f6", { plaintextBody: "본문 전체" }), MSG("18f0a1b2c3d4e600")] }, {}, "Gmail"));
  const a = gmailItem(first, { instance: "default", mailbox: "me@example.com" });
  assert.deepEqual(a.provenance, { category: "messenger", system: "gmail", instance: "default", external_id: "18f0a1b2c3d4e5f6", external_url: "https://mail.google.com/mail/u/0/#all/18f0a1b2c3d4e5f6" });
  assert.equal(a.parent_external_id, undefined, "스레드 첫 메일(id = threadId)은 parent 없음");
  assert.deepEqual([a.title, a.body, a.container_ref, a.occurred_at], ["견적 요청", "본문 전체", "me@example.com", "2026-10-02T23:49:36.000Z"]);
  assert.deepEqual([a.actor?.email, a.actor?.display_name], ["kim@example.com", "Kim Dev"]);
  assert.equal(a.fields?.via, "claude_connector");
  const b = gmailItem(reply, { instance: "default", mailbox: "me@example.com" });
  assert.equal(b.parent_external_id, "18f0a1b2c3d4e5f6");
  assert.equal(b.body, "안녕하세요 견적…", "본문이 없으면 요약");
  //  id 모양이 아니면 메시지로 안 본다
  assert.deepEqual(parseGmailMessages(cap("get_message", MSG("not-an-id!"), {}, "Gmail")), []);
});

// ── N 노션 ──
const FETCH = (o: Record<string, unknown> = {}) => ({
  metadata: { type: "page" }, title: "회의록", url: "https://www.notion.so/Cafe-abcdef0123456789abcdef0123456789",
  text: 'Here is the result of "fetch" for the page\n<page url="x">\n<properties>{}</properties>\n<content>\n본문 첫 줄\n둘째\n</content>\n</page>',
  page_last_edited_at: "2026-08-25T10:37:30.618Z", ...o,
});
t("N1 notion-fetch — 페이지 id = 하이픈 UUID(URL 끝 32자리 — 제목의 16진 글자에 안 끌린다) · 제목 · <content> 안 · 수정 시각", () => {
  const p = parseNotionFetch(cap("notion-fetch", FETCH(), { id: "x" }, "Notion"))!;
  assert.deepEqual(p, { id: "abcdef01-2345-6789-abcd-ef0123456789", title: "회의록", url: FETCH().url, body: "본문 첫 줄\n둘째", edited_at: "2026-08-25T10:37:30.618Z", kind: "page" });
  assert.equal(parseNotionFetch(cap("notion-fetch", FETCH({ metadata: { type: "database" } }), {}, "Notion"))!.kind, "database");
  //  URL 이 없으면 도구 입력의 id
  assert.equal(parseNotionFetch(cap("notion-fetch", FETCH({ url: null }), { id: "ABCDEF0123456789ABCDEF0123456789" }, "Notion"))!.id, "abcdef01-2345-6789-abcd-ef0123456789");
  //  <content> 가 없으면 머리말 줄만 뺀 글
  assert.equal(parseNotionFetch(cap("notion-fetch", FETCH({ text: 'Here is the result of "fetch" for x\n그냥 글' }), {}, "Notion"))!.body, "그냥 글");
  assert.equal(parseNotionFetch(cap("notion-fetch", FETCH({ url: null }), {}, "Notion")), null, "id 를 모르면 null");
  //  오류 모양은 페이지가 아니다 — 입력 id 로 빈 페이지를 만들면 저장 단계가 있던 제목·본문을 지운다
  for (const bad of [{ error: "object_not_found" }, { ...FETCH(), error: "x" }, { ...FETCH(), text: undefined }, { metadata: {}, text: "글" }]) {
    assert.equal(parseNotionFetch(cap("notion-fetch", bad, { id: "abcdef0123456789abcdef0123456789" }, "Notion")), null, JSON.stringify(bad).slice(0, 60));
  }
  //  보기(?v=) 가 붙은 데이터베이스 URL — 앞의 id(보기 id 가 아니다)
  assert.equal(notionId("https://www.notion.so/0123456789abcdef0123456789abcdef?v=fedcba9876543210fedcba9876543210"), "01234567-89ab-cdef-0123-456789abcdef");
  assert.equal(notionId("abcdef01-2345-6789-abcd-ef0123456789"), "abcdef01-2345-6789-abcd-ef0123456789", "이미 하이픈 꼴");
  assert.equal(notionId(null), null);
  assert.equal(notionId("짧은 글"), null);
});
t("N2 목록 결과 — 페이지·데이터베이스만(사람 등은 뺀다) · 다음 쪽", () => {
  const r = parseNotionList(cap("notion-list-shared-pages", {
    results: [
      { type: "page", url: "https://www.notion.so/A-abcdef0123456789abcdef0123456789", title: " 공유 페이지 " },
      { type: "database", url: "https://www.notion.so/0123456789abcdef0123456789abcdef?v=1", title: "DB" },
      { type: "data_source", id: "11111111-2222-3333-4444-555555555555", title: "" },
      { type: "user", url: "https://www.notion.so/99999999999999999999999999999999", title: "사람" },
      { type: "page", title: "id 없음" },
    ], next_cursor: "c2",
  }, {}, "Notion"));
  assert.deepEqual(r.units, [
    { ref: "abcdef01-2345-6789-abcd-ef0123456789", name: "공유 페이지", kind: "page" },
    { ref: "01234567-89ab-cdef-0123-456789abcdef", name: "DB", kind: "database" },
    { ref: "11111111-2222-3333-4444-555555555555", name: null, kind: "database" },
  ]);
  assert.equal(r.cursor, "c2");
  assert.deepEqual(parseNotionList(cap("notion-list-private-pages", { results: [] }, {}, "Notion")), { units: [], cursor: null });
});
t("N3 RawItem — 좌표 = 하이픈 UUID(connectors/notion 과 같다) · doc · 제목 없으면 «(제목 없음)»", () => {
  const p = parseNotionFetch(cap("notion-fetch", FETCH(), {}, "Notion"))!;
  const it = notionItem(p, { instance: "W0" });
  assert.deepEqual(it.provenance, { category: "collab_tool", system: "notion", instance: "W0", external_id: "abcdef01-2345-6789-abcd-ef0123456789", external_url: FETCH().url });
  assert.deepEqual([it.type, it.title, it.body, it.updated_at], ["doc", "회의록", "본문 첫 줄\n둘째", "2026-08-25T10:37:30.618Z"]);
  assert.equal(notionItem({ ...p, title: null, body: "" }, { instance: "" }).title, "(제목 없음)");
  assert.equal(notionItem({ ...p, title: null, body: "" }, { instance: "" }).body, undefined);
});

// ── E 모양을 모르는 글 ──
t("E2 모르는 모양은 빈 결과 — 던지지 않는다(호출부가 «풀린 게 없다» 를 실패로 센다)", () => {
  const junk = cap("slack_read_channel", "형식이 바뀐 글 ".repeat(50), { channel_id: "C0AAAAAAA1" });
  assert.deepEqual(parseSlackChannelList(junk).units, []);
  assert.deepEqual(parseSlackChannelMessages(junk).messages, []);
  const th = parseSlackThread(junk);
  assert.deepEqual([th.parent, th.replies], [null, []]);
  assert.deepEqual(parseGmailMessages(junk), []);
  assert.equal(parseNotionFetch(junk), null);
  assert.deepEqual(parseNotionList(junk).units, []);
  //  Message TS 가 모양이 아니면 그 메시지는 버린다
  assert.deepEqual(parseSlackChannelMessages(cap("slack_read_channel", { messages: "=== Message from A (U0AAAAAAA1) at x ===\nMessage TS: 어제\n본문" })).messages, []);
});

console.log(`\nconnector-parse: ${pass} passed`);

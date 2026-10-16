// 링크 따라 읽기(#4213 T12 #4744) — 거두기 사양 엣지 표 A 행(순수). 링크 판정은 link-plan.test.ts · 저장 단계는 collect-links.pg-test.mjs.
//
//  엣지 표
//   A1 이번 판 노션 단위 글 속 링크 P · 계획 밖 notion-fetch(P) → 링크 읽기(stray 아님) · 그 문서의 자료는 링크가 있던 단위에 안 들어간다
//   A2 계획 밖 notion-fetch(Q) · Q 는 어떤 글에도 링크 없음 → stray
//   A3 슬랙 단위 글 속 다른 채널 메시지 링크 · 계획 밖 slack_read_thread(C2, 부모) → 링크 읽기(부모 + 답글 · 계획 시각 뒤 답글은 버림)
//   A4 다른 앱 링크(슬랙 글 속 노션 링크)는 같은 판에 읽어도 받지 않는다(그 앱 판의 몫 — 이 판은 노션을 허락하지 않았다) → stray
//   A5 같은 문서를 두 번 읽음(스레드 이어 읽기 포함) → 한 줄 · 자료 합침
//   A6 단위마다 같은 앱 링크 읽기 3개 넘음 → 앞 3개만 · 나머지는 링크 쪽 버림(linkStray — «지시를 벗어남» 의 stray 가 아니다)
//   A7 링크 읽기 결과가 오류 모양 → ok:false(저장 안 함)
//   A8 계획에 실은 링크 읽기 → via planned · 링크 id 가 실린다
//   A9 다시 읽는 노션 단위(읽은 시각 있음)의 글 속 링크는 같은 판에 받지 않는다(판마다 같은 문서를 다시 열지 않게 — 계획 길의 몫)
//   A10 thread_ts 없이 답글을 가리킨 슬랙 링크 — 그 스레드에서 본 글 ts 로 맞춘다
//   P3 지시 — 계획 링크는 이 판의 앱만 · 5개까지 · 단위가 없으면 링크도 없다 · 같은 판 지시는 슬랙 · 처음 읽는 노션만
//   P4 턴 — 링크 몫을 더해도 러너 상한 60 을 넘지 않는다
//   A11 처음 읽는 노션 단위와 다시 읽는 노션 단위가 섞인 판 — 다시 읽는 페이지의 링크를 연 읽기는 받지 않되 링크 쪽(linkStray)으로 센다
//   P5 지시 — 노션 같은 판 링크는 처음 읽는 페이지만 이름으로 적는다(다시 읽는 페이지는 안 적는다)
import test from "node:test";
import assert from "node:assert/strict";
import { collectMaxTurns, collectPrompt, harvestUnits, sameRunLinkApps, type PlannedLink, type PlannedUnit } from "./collect-plan.js";
import { readCapture, type Capture } from "./connector-parse.js";
import { SAME_APP_LINKS_PER_UNIT } from "./link-plan.js";

const PLANNED = Date.parse("2026-10-16T10:00:00.000Z") / 1000;
const D = 86400;
const cap = (connector: string, tool: string, inner: unknown, input: Record<string, unknown> = {}): Capture => {
  const c = readCapture({ tool_name: `mcp__claude_ai_${connector}__${tool}`, tool_input: input, tool_response: [{ type: "text", text: typeof inner === "string" ? inner : JSON.stringify(inner) }] });
  assert.ok(c, "배선 — 캡처가 풀렸다");
  return c;
};
const hex = (n: number) => n.toString(16).padStart(32, "0");
const uuid = (n: number) => { const h = hex(n); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const P_UNIT = uuid(0xa0), P1 = uuid(0xb1), P2 = uuid(0xb2), P3 = uuid(0xb3), P4 = uuid(0xb4), Q = uuid(0xc9);
const notionUnit: PlannedUnit = { id: 3, app: "notion", instance: "", ref: P_UNIT, kind: "page", connector: "Notion", since: null, until: null };
const page = (id: string, body: string, title = "문서") => cap("Notion", "notion-fetch", {
  metadata: { type: "page" }, title, url: `https://www.notion.so/x-${id.replace(/-/g, "")}`, text: `<content>\n${body}\n</content>`,
  page_last_edited_at: "2026-10-15T00:00:00.000Z",
}, { id });
const link = (id: string) => `https://www.notion.so/acme/Doc-${id.replace(/-/g, "")}`;

const CH = "C0LINK0001", C2 = "C0LINK0002";
const slackUnit: PlannedUnit = { id: 1, app: "slack", instance: "T0TEAM", ref: CH, kind: "channel", connector: "Slack", since: `${PLANNED - 7 * D}.000000`, until: null };
const channel = (msgs: Array<[string, string]>) => cap("Slack", "slack_read_channel", {
  messages: [`Channel: #c (${CH})`, "", ...msgs.flatMap(([ts, body]) => [`=== Message from Kim <k@x.test> (U0LINK0001) at x ===`, `Message TS: ${ts}`, body, ""])].join("\n"),
  pagination_info: "There are no more messages available.\n",
}, { channel_id: CH, oldest: slackUnit.since, limit: 100 });
const thread = (ch: string, parent: string, replies: string[], input: Record<string, unknown> = {}) => cap("Slack", "slack_read_thread", {
  messages: [`Channel: ${ch}`, "=== THREAD PARENT MESSAGE ===", "From: Kim (U0LINK0001)", "Time: x", `Message TS: ${parent}`, "부모", "",
    "=== THREAD REPLIES (n) ===", "", ...replies.flatMap((ts, i) => [`--- Reply ${i + 1} of ${replies.length} ---`, "From: Lee (U0LINK0002)", "Time: y", `Message TS: ${ts}`, `답글 ${i + 1}`, ""])].join("\n"),
  pagination_info: "There are no more messages in this thread.\n",
}, { channel_id: ch, message_ts: parent, limit: 200, ...input });

test("A1 같은 판 노션 글 속 링크 P → 계획 밖 fetch(P) 는 링크 읽기 · 링크가 있던 단위 자료에는 안 들어간다", () => {
  const r = harvestUnits([page(P_UNIT, `참고: ${link(P1)}`), page(P1, "링크된 문서", "결정")], [notionUnit], { plannedAt: PLANNED });
  assert.equal(r.stray, 0, "링크로 읽은 것은 stray 가 아니다");
  assert.equal(r.linked.length, 1);
  const l = r.linked[0];
  assert.deepEqual({ app: l.app, ref: l.ref, kind: l.kind, name: l.name, via: l.via, from: l.from_unit_id, ok: l.ok, n: l.items.length },
    { app: "notion", ref: P1, kind: "page", name: "결정", via: "same-run", from: 3, ok: true, n: 1 });
  assert.equal(l.items[0].provenance.external_id, P1);
  const own = r.byUnit.get(3)!;
  assert.deepEqual(own.items.map((i) => i.provenance.external_id), [P_UNIT], "단위 자료는 그 단위 페이지 하나");
  assert.equal(own.complete, true, own.why ?? "");
});

test("A2 어떤 글에도 링크가 없는 계획 밖 읽기는 stray", () => {
  const r = harvestUnits([page(P_UNIT, "링크 없음"), page(Q, "아무 문서")], [notionUnit], { plannedAt: PLANNED });
  assert.equal(r.linked.length, 0);
  assert.equal(r.stray, 1);
});

test("A3 슬랙 글 속 다른 채널 메시지 링크 → 계획 밖 스레드 읽기는 링크 읽기 · 계획 시각 뒤 답글은 버린다", () => {
  const parent = `${PLANNED - 30 * D}.000100`;   // 처음 수집 기간보다 오래된 스레드
  const r = harvestUnits([
    channel([[`${PLANNED - D}.000200`, `이 결정 봐 주세요 https://acme.slack.com/archives/${C2}/p${parent.replace(".", "")}`]]),
    thread(C2, parent, [`${PLANNED - 29 * D}.000300`, `${PLANNED + 3600}.000400`]),
  ], [slackUnit], { plannedAt: PLANNED });
  assert.equal(r.stray, 0);
  assert.equal(r.linked.length, 1);
  const l = r.linked[0];
  assert.deepEqual({ app: l.app, ref: l.ref, thread: l.thread, via: l.via, ok: l.ok, instance: l.instance }, { app: "slack", ref: C2, thread: parent, via: "same-run", ok: true, instance: "T0TEAM" });
  assert.deepEqual(l.items.map((i) => i.provenance.external_id).sort(), [`${C2}:${parent}`, `${C2}:${PLANNED - 29 * D}.000300`].sort(), "부모 + 계획 시각 전 답글(자료 좌표 = 채널:ts)");
  assert.equal(r.byUnit.get(1)!.items.length, 1, "링크가 있던 채널의 자료는 그 채널 글만");
});

test("A4 다른 앱 링크(슬랙 글 속 노션 링크)는 같은 판에 받지 않는다", () => {
  const r = harvestUnits([channel([[`${PLANNED - D}.000200`, `문서 ${link(P1)}`]]), page(P1, "문서")], [slackUnit], { plannedAt: PLANNED });
  assert.equal(r.linked.length, 0);
  assert.equal(r.stray, 1);
});

test("A5 같은 문서를 두 번(스레드 이어 읽기) → 한 줄 · 자료 합침", () => {
  const parent = `${PLANNED - 30 * D}.000100`;
  const r = harvestUnits([
    channel([[`${PLANNED - D}.000200`, `https://acme.slack.com/archives/${C2}/p${parent.replace(".", "")}`]]),
    cap("Slack", "slack_read_thread", {
      messages: [`Channel: ${C2}`, "=== THREAD PARENT MESSAGE ===", "From: Kim (U0LINK0001)", "Time: x", `Message TS: ${parent}`, "부모", "",
        "=== THREAD REPLIES (n) ===", "", "--- Reply 1 of 2 ---", "From: Lee (U0LINK0002)", "Time: y", `Message TS: ${PLANNED - 29 * D}.000300`, "첫 쪽", ""].join("\n"),
      pagination_info: "More replies are available. To get the next page, use cursor: `abc`\n",
    }, { channel_id: C2, message_ts: parent, limit: 200 }),
    cap("Slack", "slack_read_thread", {
      messages: [`Channel: ${C2}`, "--- Reply 2 of 2 ---", "From: Lee (U0LINK0002)", "Time: y", `Message TS: ${PLANNED - 28 * D}.000400`, "둘째 쪽", ""].join("\n"),
      pagination_info: "There are no more messages in this thread.\n",
    }, { channel_id: C2, message_ts: parent, limit: 200, cursor: "abc" }),
  ], [slackUnit], { plannedAt: PLANNED });
  assert.equal(r.linked.length, 1, JSON.stringify(r.linked.map((l) => [l.ref, l.items.length])));
  assert.equal(r.linked[0].items.length, 3, "부모 + 두 쪽의 답글");
  assert.equal(r.stray, 0);
});

test("A6 단위마다 같은 앱 링크 읽기는 상한까지 — 나머지는 stray", () => {
  const ids = [P1, P2, P3, P4];
  const r = harvestUnits([page(P_UNIT, ids.map(link).join(" ")), ...ids.map((id) => page(id, "문서"))], [notionUnit], { plannedAt: PLANNED });
  assert.equal(SAME_APP_LINKS_PER_UNIT, 3);
  assert.deepEqual(r.linked.map((l) => l.ref), [P1, P2, P3]);
  assert.deepEqual([r.stray, r.linkStray], [0, 1], "상한을 넘은 링크 읽기는 «지시를 벗어남» 이 아니라 링크 쪽으로 센다");
});

test("A7 링크 읽기 결과가 오류 모양 → ok:false · 자료 없음", () => {
  const bad = cap("Notion", "notion-fetch", { error: "rate limited" }, { id: P1 });
  const r = harvestUnits([page(P_UNIT, link(P1)), bad], [notionUnit], { plannedAt: PLANNED });
  assert.equal(r.linked.length, 1);
  assert.deepEqual({ ok: r.linked[0].ok, n: r.linked[0].items.length }, { ok: false, n: 0 });
});

test("A8 계획에 실은 링크 읽기 → via planned · 링크 id · 링크가 글에 없어도 받는다", () => {
  const planned: PlannedLink[] = [{ id: 77, app: "notion", ref: P2, kind: "page" }];
  const r = harvestUnits([page(P_UNIT, "링크 없음"), page(P2, "지난 판이 적어 둔 링크의 문서")], [notionUnit], { plannedAt: PLANNED, links: planned });
  assert.equal(r.linked.length, 1);
  assert.deepEqual({ ref: r.linked[0].ref, via: r.linked[0].via, id: r.linked[0].link.id, from: r.linked[0].from_unit_id }, { ref: P2, via: "planned", id: 77, from: null });
  assert.equal(r.stray, 0);
});

test("A9 다시 읽는 노션 단위의 글 속 링크는 같은 판에 받지 않는다 — 계획 길의 몫", () => {
  const reread = { ...notionUnit, read_at: "2026-10-15T00:00:00.000Z" };
  const r = harvestUnits([page(P_UNIT, `참고 ${link(P1)}`), page(P1, "링크된 문서")], [reread], { plannedAt: PLANNED });
  assert.equal(r.linked.length, 0);
  assert.deepEqual([r.stray, r.linkStray], [0, 1], "받지 않되 «지시를 벗어남» 이 아니라 링크 쪽으로 센다");
  const first = harvestUnits([page(P_UNIT, `참고 ${link(P1)}`), page(P1, "링크된 문서")], [notionUnit], { plannedAt: PLANNED });
  assert.equal(first.linked.length, 1, "처음 읽는 단위는 받는다");
});

test("A10 thread_ts 없이 답글을 가리킨 슬랙 링크 — 그 스레드에서 본 글 ts 로 맞춘다", () => {
  const parent = `${PLANNED - 30 * D}.000100`, reply = `${PLANNED - 29 * D}.000300`;
  const r = harvestUnits([
    channel([[`${PLANNED - D}.000200`, `이 답글 https://acme.slack.com/archives/${C2}/p${reply.replace(".", "")}`]]),
    thread(C2, parent, [reply], { message_ts: reply }),
  ], [slackUnit], { plannedAt: PLANNED });
  assert.equal(r.linked.length, 1, JSON.stringify({ stray: r.stray, linkStray: r.linkStray }));
  assert.equal(r.linked[0].thread, parent, "읽은 것은 부모 스레드");
});

test("P3 지시 — 계획 링크는 이 판의 앱만 · 5개까지 · 단위가 없으면 링크도 없다 · 같은 판 지시는 슬랙 · 처음 읽는 노션만", () => {
  const links: PlannedLink[] = [
    ...Array.from({ length: 7 }, (_, i) => ({ id: i + 1, app: "notion", ref: uuid(0xd00 + i), kind: "page" as const })),
    { id: 99, app: "slack", ref: `${C2}:${PLANNED}.000100`, kind: "message", channel: C2, thread: `${PLANNED}.000100` },
  ];
  const p = collectPrompt([notionUnit], links);
  assert.equal(p.links.length, 5, "5개까지");
  assert.ok(p.links.every((l) => l.app === "notion"), "이 판에 없는 앱(슬랙)의 링크는 싣지 않는다");
  assert.match(p.prompt, /마지막으로/, "처음 읽는 노션 단위 — 같은 판 지시가 붙는다");
  const re = collectPrompt([{ ...notionUnit, read_at: "2026-10-15T00:00:00.000Z" }], []);
  assert.doesNotMatch(re.prompt, /마지막으로/, "다시 읽는 노션 단위 — 같은 판 지시가 없다");
  assert.deepEqual(collectPrompt([], links).links, [], "단위가 없으면 링크도 없다");
  assert.deepEqual(sameRunLinkApps([slackUnit, { ...notionUnit, read_at: "x" }]), ["slack"]);
});

test("P4 턴 — 링크 몫을 더해도 러너 상한 60 을 넘지 않는다(확인 읽기 몫과 따로)", () => {
  assert.equal(collectMaxTurns(1, 0, 0, 0), 14);
  assert.equal(collectMaxTurns(1, 0, 0, 5), 19, "몫을 더한다");
  assert.equal(collectMaxTurns(1, 0, 2, 5), 23, "확인 읽기 몫(단위마다 둘)과 함께");
  assert.equal(collectMaxTurns(6, 0, 0, 30), 60, "넘는 몫은 없다");
  assert.equal(collectMaxTurns(2, 1, 0, 12), 60);
});

test("P6 확인 읽기 단위만 있는 판에는 링크를 싣지 않는다 · 섞인 판에서는 확인 읽기 단위의 링크를 따라가지 않는다", () => {
  const links: PlannedLink[] = [{ id: 1, app: "slack", ref: `${C2}:${PLANNED}.000100`, kind: "message", channel: C2, thread: `${PLANNED}.000100` }];
  const proof: PlannedUnit = { ...slackUnit, id: 9, proof: true, since: `${PLANNED - 10}.000000`, until: `${PLANNED}.000000` };
  const only = collectPrompt([proof], links);
  assert.deepEqual(only.links, [], "확인 읽기만 있는 판 — 링크 없음");
  assert.doesNotMatch(only.prompt, /마지막으로/, "같은 판 링크 지시도 없다");
  assert.deepEqual(sameRunLinkApps([proof]), []);
  const mixed = collectPrompt([{ ...notionUnit }, proof], links);
  assert.deepEqual(mixed.links, [], "모으는 단위의 앱(노션)이 아닌 링크(슬랙)는 싣지 않는다 — 확인 읽기 단위의 앱으로 싣지 않는다");
});

test("A11 처음 읽는 노션 단위와 다시 읽는 노션 단위가 섞인 판 — 다시 읽는 페이지의 링크를 연 읽기는 받지 않되 링크 쪽으로 센다", () => {
  const reread: PlannedUnit = { ...notionUnit, id: 4, ref: Q, read_at: "2026-10-15T00:00:00.000Z" };
  const r = harvestUnits([page(P_UNIT, `참고 ${link(P1)}`), page(Q, `참고 ${link(P2)}`), page(P1, "처음 읽는 페이지의 링크"), page(P2, "다시 읽는 페이지의 링크")],
    [notionUnit, reread], { plannedAt: PLANNED });
  assert.deepEqual(r.linked.map((l) => l.ref), [P1], "처음 읽는 페이지의 링크만 받는다");
  assert.deepEqual([r.stray, r.linkStray], [0, 1], "다시 읽는 페이지의 링크 읽기는 «지시를 벗어남» 이 아니다");
});

test("P5 지시 — 노션 같은 판 링크는 처음 읽는 페이지만 이름으로 적는다", () => {
  const reread: PlannedUnit = { ...notionUnit, id: 4, ref: Q, read_at: "2026-10-15T00:00:00.000Z" };
  const p = collectPrompt([notionUnit, reread], []);
  const tail = p.prompt.slice(p.prompt.indexOf("마지막으로"));
  assert.match(tail, new RegExp(`id="${P_UNIT}"`), "처음 읽는 페이지는 적는다");
  assert.doesNotMatch(tail, new RegExp(`id="${Q}"`), "다시 읽는 페이지는 안 적는다");
});

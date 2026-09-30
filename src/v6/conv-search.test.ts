import { strict as assert } from "node:assert";
import test from "node:test";
import {
  extractConvMessages, clipBody, snippetAround, hasAllTerms, recencyBoost, rankConvSessions, parseConvSort,
  CONV_BODY_MAX, RECENCY_MAX, type ConvRow,
} from "./conv-search.js";
import type { ChatLine } from "../terminal/harness-io/chat-line.js";

// #4517 — ⌘K 대화 검색의 순수 규칙. 원준 2026-09-30: «cmd+K 검색 안에 세션의 대화내용으로도 세션을 검색하고 싶어.
//  지금 완전 관련도 순으로만 나오는데 최신순이 아예 안 되더라. 슬랙 참고해서 고쳐 줘.»
//  엣지 표(행마다 테스트 하나 — 스크래치패드 spec.md A·B·C):
//   X1~X10 무엇을 색인하나(사람 말·AI 말만) · C1~C2 긴 말 자르기 · S1~S4 발췌문 · R1 최근 가산
//   K1~K11 세션 묶기·순위(관련도순/최신순) · P1 정렬 파라미터

const NOW = Date.parse("2026-09-30T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const user = (content: unknown, extra: Record<string, unknown> = {}): ChatLine =>
  ({ type: "user", timestamp: "2026-09-30T01:00:00.000Z", message: { role: "user", content }, ...extra }) as unknown as ChatLine;
const asst = (content: unknown[], extra: Record<string, unknown> = {}): ChatLine =>
  ({ type: "assistant", timestamp: "2026-09-30T01:00:01.000Z", message: { role: "assistant", content }, ...extra }) as unknown as ChatLine;

// ── 무엇을 색인하나 ──
test("[X1] 사람 말(문자열 content)은 담는다", () => {
  assert.deepEqual(extractConvMessages([user("슬랙처럼 검색 고쳐 줘")]).map((m) => [m.role, m.text]), [["user", "슬랙처럼 검색 고쳐 줘"]]);
});
test("[X2] text 블록과 tool_result 블록이 섞이면 text 만 잇는다", () => {
  const m = extractConvMessages([user([{ type: "text", text: "첫 줄" }, { type: "tool_result", tool_use_id: "t", content: "도구 결과" }, { type: "text", text: "둘째 줄" }])]);
  assert.equal(m.length, 1);
  assert.equal(m[0].text, "첫 줄\n둘째 줄");
});
test("[X3] tool_result 만 있는 user 줄은 사람 말이 아니다", () => {
  assert.equal(extractConvMessages([user([{ type: "tool_result", tool_use_id: "t", content: "ls 결과" }])]).length, 0);
});
test("[X4] 주입(isMeta)은 뺀다", () => {
  assert.equal(extractConvMessages([user("주입된 글", { isMeta: true })]).length, 0);
});
test("[X5] 주입 문구로 시작하는 user 줄은 뺀다(시스템 리마인더·슬래시 명령·caveat·중단 표식)", () => {
  const lines = ["<system-reminder>x</system-reminder>", "<command-name>/clear</command-name>", "Caveat: the messages below", "[Request interrupted by user]"].map((t) => user(t));
  assert.equal(extractConvMessages(lines).length, 0);
});
test("[X6] 서브에이전트 가지(isSidechain)는 사람 말도 AI 말도 뺀다", () => {
  assert.equal(extractConvMessages([user("가지 지시", { isSidechain: true }), asst([{ type: "text", text: "가지 답" }], { isSidechain: true })]).length, 0);
});
test("[X7] AI 말은 text 블록만 — thinking·tool_use 는 뺀다", () => {
  const m = extractConvMessages([asst([{ type: "thinking", thinking: "속생각" }, { type: "text", text: "답입니다" }, { type: "tool_use", id: "u", name: "Bash", input: { command: "ls" } }])]);
  assert.deepEqual(m.map((x) => [x.role, x.text]), [["assistant", "답입니다"]]);
});
test("[X8] 도구 호출만 있는 AI 줄은 뺀다", () => {
  assert.equal(extractConvMessages([asst([{ type: "tool_use", id: "u", name: "Read", input: {} }])]).length, 0);
});
test("[X9] system 줄(턴 마감 등)은 뺀다", () => {
  assert.equal(extractConvMessages([{ type: "system", subtype: "turn_duration", timestamp: "2026-09-30T00:00:00Z" } as ChatLine]).length, 0);
});
test("[X10] 순서와 시각을 그대로 싣는다", () => {
  const m = extractConvMessages([user("질문"), asst([{ type: "text", text: "답" }])]);
  assert.deepEqual(m.map((x) => [x.role, x.ts]), [["user", "2026-09-30T01:00:00.000Z"], ["assistant", "2026-09-30T01:00:01.000Z"]]);
});

// ── 긴 말 자르기 ──
test("[C1] 상한 안이면 그대로", () => {
  assert.equal(clipBody("짧은 말"), "짧은 말");
});
test("★ [C2] 상한을 넘으면 앞과 **뒤**를 함께 남긴다 — 전사본을 붙이고 끝에 시킨 말이 살아야 한다", () => {
  const long = "전사".repeat(CONV_BODY_MAX) + " 이거 정리해 줘";
  const c = clipBody(long);
  assert.ok(c.length <= CONV_BODY_MAX + 5, "상한 근처로 줄어든다: " + c.length);
  assert.ok(c.startsWith("전사전사"), "앞이 남는다");
  assert.ok(c.endsWith("이거 정리해 줘"), "뒤(시킨 말)가 남는다");
});

// ── 발췌문 ──
test("[S1] 짧은 글은 공백만 접어 그대로", () => {
  assert.equal(snippetAround("  슬랙 \n 검색  ", ["슬랙"]), "슬랙 검색");
});
test("[S2] 긴 글에서 뒤쪽 일치는 앞을 …로 자르고 그 낱말을 보인다", () => {
  const t = "가".repeat(400) + " 슬랙처럼 최신순 " + "나".repeat(400);
  const s = snippetAround(t, ["최신순"], 140);
  assert.ok(s.startsWith("…"), s.slice(0, 10));
  assert.ok(s.includes("최신순"), "일치한 낱말이 발췌문 안에 있어야 한다");
  assert.ok(s.endsWith("…"));
  assert.ok(s.length <= 142, "길이 " + s.length);
});
test("[S3] 앞쪽 일치는 앞을 자르지 않는다", () => {
  const s = snippetAround("최신순 " + "다".repeat(300), ["최신순"], 140);
  assert.ok(s.startsWith("최신순"));
});
test("[S4] 자르는 자리에 이모지가 걸려도 반쪽 글자를 남기지 않는다", () => {
  //  이모지 한 개 = UTF-16 두 칸. 일치 앞 lead(36)가 홀수 자리에 떨어지도록 앞에 글자 하나를 섞어 둔다.
  for (const pad of ["", "a"]) {
    const t = pad + "🙂".repeat(200) + " 검색 " + "🙂".repeat(200);
    const s = snippetAround(t, ["검색"], 61, 37);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) { const n = s.charCodeAt(i + 1); assert.ok(n >= 0xdc00 && n <= 0xdfff, `짝 없는 앞쪽 반쪽 at ${i} (pad=${pad})`); i++; }
      else assert.ok(!(c >= 0xdc00 && c <= 0xdfff), `짝 없는 뒤쪽 반쪽 at ${i} (pad=${pad})`);
    }
    assert.ok(s.includes("검색"));
  }
});

// ── 최근 가산 ──
test("[R1] 지금 = 최대 · 7일 = 반 · 미래 = 지금으로 · 모름 = 0", () => {
  assert.equal(recencyBoost(NOW, NOW), RECENCY_MAX);
  assert.ok(Math.abs(recencyBoost(NOW - 7 * DAY, NOW) - RECENCY_MAX / 2) < 1e-9);
  assert.equal(recencyBoost(NOW + DAY, NOW), RECENCY_MAX, "앞선 시계는 지금으로 본다(가산을 부풀리지 않는다)");
  assert.equal(recencyBoost(NaN, NOW), 0);
});

// ── 세션 묶기 · 순위 ──
const row = (sid: string, body: string, ms: number | null, extra: Partial<ConvRow> = {}): ConvRow =>
  ({ node_id: "", session_id: sid, role: "user", ts: ms == null ? null : iso(ms), body, owner: "me", ...extra });
const rank = (rows: ConvRow[], q: string, sort: "relevance" | "recent" = "relevance", limit = 10, requester = "me") =>
  rankConvSessions(rows, { q, sort, nowMs: NOW, requester, limit });

test("[K1] 모든 낱말이 한 말 안에 있어야 한다(슬랙 «match all terms»)", () => {
  const r = rank([row("a", "슬랙 이야기", NOW), row("a", "검색 이야기", NOW), row("b", "슬랙처럼 검색", NOW)], "슬랙 검색");
  assert.deepEqual(r.map((x) => x.session_id), ["b"], "낱말이 다른 말에 흩어진 세션 a 는 안 맞는다");
});
test("[K2] 한 세션에 맞은 말이 여럿이면 한 줄로 묶고 수를 센다", () => {
  const r = rank([row("a", "검색 하나", NOW - 2000), row("a", "검색 둘", NOW), row("a", "검색 셋", NOW - 1000)], "검색");
  assert.equal(r.length, 1);
  assert.equal(r[0].hits, 3);
  assert.equal(r[0].at, iso(NOW), "시각은 맞은 말 중 가장 늦은 것");
});
test("★ [K3] 관련도순: 구절이 그대로 맞은 옛 세션이, 낱말만 흩어져 맞은 오늘 세션보다 앞선다", () => {
  const r = rank([
    row("today", "검색 " + "x".repeat(200) + " 그리고 슬랙", NOW),
    row("old", "슬랙 검색 로직을 참고해", NOW - 30 * DAY),
  ], "슬랙 검색");
  assert.deepEqual(r.map((x) => x.session_id), ["old", "today"]);
});
test("★ [K4] 관련도순: 한 낱말 질의면 조금 더 자주 나온 옛 세션보다 오늘 말한 세션이 앞선다(슬랙 관련도의 «메시지 나이»)", () => {
  //  동점 순서(최근 먼저)만으로는 이 행을 못 잰다 — 옛 세션 쪽 글자 점수를 일부러 조금 높여 둔다(같은 낱말 세 번).
  const r = rank([row("old", "검색 검색 검색", NOW - 20 * DAY), row("new", "검색", NOW)], "검색");
  assert.deepEqual(r.map((x) => x.session_id), ["new", "old"]);
});
test("★ [K5] 최신순: 점수와 무관하게 맞은 말이 늦은 세션부터", () => {
  const r = rank([
    row("phrase-old", "슬랙 검색", NOW - 10 * DAY),
    row("scatter-new", "검색 " + "y".repeat(150) + " 슬랙", NOW - 60_000),
  ], "슬랙 검색", "recent");
  assert.deepEqual(r.map((x) => x.session_id), ["scatter-new", "phrase-old"]);
});
test("[K6] 대표 말: 관련도순은 가장 잘 맞은 말 · 최신순은 가장 늦은 말", () => {
  const rows = [row("a", "슬랙 검색 그대로", NOW - 5 * DAY), row("a", "검색 " + "z".repeat(120) + " 슬랙", NOW)];
  assert.ok(rank(rows, "슬랙 검색")[0].best.text.startsWith("슬랙 검색 그대로"), "관련도순 = 구절이 맞은 말");
  assert.ok(rank(rows, "슬랙 검색", "recent")[0].best.text.startsWith("검색"), "최신순 = 가장 늦은 말");
  assert.equal(rank(rows, "슬랙 검색", "recent")[0].best.ts, iso(NOW));
});
test("[K7] 같은 글이면 사람 말(지시)이 AI 말보다 대표가 된다", () => {
  const r = rank([row("a", "배포 해 줘", NOW, { role: "assistant" }), row("a", "배포 해 줘", NOW - 1000, { role: "user" })], "배포");
  assert.equal(r[0].best.role, "user");
});
test("[K8] 나머지가 같으면 내 세션이 앞선다", () => {
  const r = rank([row("theirs", "검색", NOW, { owner: "other" }), row("mine", "검색", NOW, { owner: "me" })], "검색");
  assert.deepEqual(r.map((x) => x.session_id), ["mine", "theirs"]);
});
test("[K9] limit 만큼만", () => {
  const rows = Array.from({ length: 12 }, (_, i) => row("s" + i, "검색", NOW - i * 1000));
  assert.equal(rank(rows, "검색", "recent", 5).length, 5);
});
test("[K10] 시각을 모르는 세션은 최신순 맨 뒤 · at=null", () => {
  const r = rank([row("nots", "검색", null), row("ts", "검색", NOW - 3 * DAY)], "검색", "recent");
  assert.deepEqual(r.map((x) => x.session_id), ["ts", "nots"]);
  assert.equal(r[1].at, null);
});
test("[K11] 대소문자를 가리지 않는다", () => {
  assert.equal(rank([row("a", "Slack Search", NOW)], "slack SEARCH").length, 1);
  assert.ok(hasAllTerms("slack search", ["slack", "search"]));
});

test("[P1] 정렬 파라미터 — recent 만 최신순, 나머지는 관련도순", () => {
  assert.equal(parseConvSort("recent"), "recent");
  for (const v of ["relevance", "", undefined, "RECENT", "score"]) assert.equal(parseConvSort(v), "relevance");
});

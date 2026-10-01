import { strict as assert } from "node:assert";
import test from "node:test";
import {
  extractConvMessages, clipBody, snippetAround, recencyBoost, editTail, rankConvAggs, convRelevance, parseConvSort, editedPaths,
  editLabel, snippetTerms, CONV_BODY_MAX, RECENCY_MAX, CONV_TOP_MAX, type ConvSessionAgg,
} from "./conv-search.js";
import { parseQueryTerms, stemKo, termStrength, likePattern, termPatterns } from "./query-terms.js";
import type { ChatLine } from "../terminal/harness-io/chat-line.js";

// #4517 — ⌘K 대화 검색의 순수 규칙. 원준 2026-09-30: «cmd+K 검색 안에 세션의 대화내용으로도 세션을 검색하고 싶어.
//  지금 완전 관련도 순으로만 나오는데 최신순이 아예 안 되더라. 슬랙 참고해서 고쳐 줘.»
//  엣지 표(행마다 테스트 하나 — 스크래치패드 spec.md A·B·C):
//   X1~X10 무엇을 색인하나(사람 말·AI 말만) · C1~C2 긴 말 자르기 · S1~S4 발췌문 · R1 최근 가산
//   K1~K11 세션 묶기·순위(관련도순/최신순) · P1 정렬 파라미터
//  #4530(원준 2026-10-01 «대화 일부나 고쳤던 대상을 어렴풋하게 쳐서 세션을 찾고 싶은데 퀄리티가 형편없다»):
//   X11~X14 고친 파일 색인 · Q1~Q8 검색어 낱말(조사·구절·LIKE 글자 그대로) · K1~K12 세션 단위 관련도와 순서(맨 위 셋 + 최근 것부터)

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

// ── 고친 파일 색인(#4530) ──
test("★ [X11] 파일을 고친 도구(Edit·Write·MultiEdit·NotebookEdit)의 경로를 role 'edit' 로 담는다", () => {
  const m = extractConvMessages([asst([
    { type: "text", text: "고쳤습니다" },
    { type: "tool_use", id: "1", name: "Edit", input: { file_path: "/w/lively/web/v2/omni.ts", old_string: "a", new_string: "b" } },
    { type: "tool_use", id: "2", name: "Write", input: { file_path: "/w/lively/src/v6/query-terms.ts", content: "…" } },
    { type: "tool_use", id: "3", name: "NotebookEdit", input: { notebook_path: "/w/n.ipynb" } },
  ])]);
  //  경로는 마지막 세 마디만 담는다 — 앞부분(work·shared·홈 폴더)이 모든 세션에 맞지 않게(격리 리뷰).
  assert.deepEqual(m.map((x) => [x.role, x.text]), [
    ["assistant", "고쳤습니다"], ["edit", "web/v2/omni.ts"], ["edit", "src/v6/query-terms.ts"], ["edit", "w/n.ipynb"],
  ]);
});
test("[X12] 읽기·셸 같은 다른 도구의 입력은 담지 않는다", () => {
  const m = extractConvMessages([asst([
    { type: "tool_use", id: "1", name: "Read", input: { file_path: "/w/a.ts" } },
    { type: "tool_use", id: "2", name: "Bash", input: { command: "git status" } },
  ])]);
  assert.equal(m.length, 0);
});
test("[X13] 같은 묶음 안에서 같은 파일을 여러 번 고쳐도 한 번만", () => {
  const e = (id: string) => ({ type: "tool_use", id, name: "Edit", input: { file_path: "/w/omni.ts" } });
  const m = extractConvMessages([asst([e("1"), e("2")]), asst([e("3")])]);
  assert.equal(m.filter((x) => x.role === "edit").length, 1);
});
test("[X14] 코덱스 파일 변경(paths[])도 · 서브에이전트 가지는 뺀다 · 경로가 아닌 긴 값은 뺀다", () => {
  assert.deepEqual(editedPaths([{ type: "tool_use", name: "Edit", input: { file_path: "a.ts", paths: ["a.ts", "b.ts"] } }]), ["a.ts", "b.ts"]);
  assert.equal(extractConvMessages([asst([{ type: "tool_use", id: "1", name: "Edit", input: { file_path: "/w/x.ts" } }], { isSidechain: true })]).length, 0);
  assert.deepEqual(editedPaths([{ type: "tool_use", name: "Edit", input: { file_path: "x".repeat(401) } }]), []);
});

// ── 검색어 낱말(#4530 query-terms) ──
test("★ [Q1] 끝의 조사를 한 번 뗀다 — 긴 조사부터", () => {
  assert.equal(stemKo("검색을"), "검색");
  assert.equal(stemKo("세션이"), "세션");
  assert.equal(stemKo("화면에서는"), "화면");
  assert.equal(stemKo("omni.ts에서"), "omni.ts");
  assert.equal(stemKo("프로젝트로"), "프로젝트");
});
test("[Q2] 떼고 남는 것이 두 글자 미만이면 떼지 않는다 · 한글로 안 끝나면 그대로", () => {
  assert.equal(stemKo("이가"), "이가");
  assert.equal(stemKo("나는"), "나는");
  assert.equal(stemKo("search"), "search");
  assert.equal(stemKo("검색"), "검색");
});
test("[Q3] 큰따옴표는 구절 하나 · 구절은 조사를 떼지 않는다 · 소문자 · 중복 제거", () => {
  assert.deepEqual(parseQueryTerms('"관련도 순" 검색을 Omni omni').map((t) => [t.t, t.stem, t.quoted]),
    [["관련도 순", "관련도 순", true], ["검색을", "검색", false], ["omni", "omni", false]]);
});
test("[Q4] 낱말 세기 — 그대로 1 · 조사 뗀 꼴만 0.8 · 없음 0", () => {
  const [t] = parseQueryTerms("검색을");
  assert.equal(termStrength("검색을 고쳐 줘", t), 1);
  assert.equal(termStrength("통합검색 결함", t), 0.8);
  assert.equal(termStrength("세션 목록", t), 0);
});
test("★ [Q5] LIKE 꼴은 % _ \\ 를 글자로 만든다(«%» 한 글자가 모든 글과 맞지 않게)", () => {
  assert.equal(likePattern("100%"), "%100\\%%");
  assert.equal(likePattern("a_b"), "%a\\_b%");
  assert.equal(likePattern("c:\\x"), "%c:\\\\x%");
});
test("[Q6] 조사를 뗀 꼴이 다르면 LIKE 꼴이 둘(그대로 · 뗀 꼴) · 같으면 하나", () => {
  assert.deepEqual(termPatterns(parseQueryTerms("검색을")[0]), ["%검색을%", "%검색%"]);
  assert.deepEqual(termPatterns(parseQueryTerms("검색")[0]), ["%검색%"]);
});
test("[Q7] 괄호·물음표는 글자 그대로 한 낱말이다(정규식으로 읽지 않는다)", () => {
  assert.deepEqual(parseQueryTerms("통합검색(⌘k) 왜?").map((t) => t.t), ["통합검색(⌘k)", "왜?"]);
});
test("[Q8] 낱말은 8개까지 · 빈 글은 낱말 없음", () => {
  assert.equal(parseQueryTerms("a b c d e f g h i j").length, 8);
  assert.equal(parseQueryTerms("   ").length, 0);
  assert.deepEqual(snippetTerms(parseQueryTerms("검색을 omni")), ["검색을", "검색", "omni"]);
});

// ── 세션 단위 관련도 · 순서(#4530) ──
const agg = (sid: string, per: Array<Partial<{ user: number; assistant: number; edit: number }>>, extra: Partial<ConvSessionAgg> = {}): ConvSessionAgg => ({
  node_id: "", session_id: sid, owner: "me", label: null, title: null, project: null,
  strength: per.map((p) => ({ user: 0, assistant: 0, edit: 0, ...p })),
  maxCo: 1, coAll: 0, phrase: false, hits: 1, lastHit: iso(NOW), ...extra,
});
const rank = (aggs: ConvSessionAgg[], q: string, sort: "relevance" | "recent" = "recent", limit = 20, requester = "me") =>
  rankConvAggs(aggs, { terms: parseQueryTerms(q), sort, nowMs: NOW, requester, limit });

test("★ [K1] 낱말이 서로 다른 말에 있어도 같은 세션이면 맞는다(종전: 한 말 안에 모두 있어야 했다 — 실측 1위 5%)", () => {
  const r = rank([agg("a", [{ user: 1 }, { assistant: 1 }], { maxCo: 1, coAll: 0 })], "슬랙 검색");
  assert.deepEqual(r.map((x) => x.agg.session_id), ["a"]);
});
test("[K2] 낱말 하나라도 그 세션 어디에도 없으면 빠진다", () => {
  assert.equal(rank([agg("a", [{ user: 1 }, {}])], "슬랙 검색").length, 0);
});
test("★ [K3] 고친 파일로 맞은 낱말도 센다 — 자리에 'edit' 가 실린다(종전: 고친 대상은 색인에 없었다 — 실측 1위 2%)", () => {
  const r = rank([agg("a", [{ edit: 1 }, { user: 1 }])], "omni.ts 칩");
  assert.equal(r.length, 1);
  assert.ok(r[0].fields.includes("edit") && r[0].fields.includes("user"));
});
test("[K4] 이름·첫 지시·프로젝트 이름에 든 낱말도 센다", () => {
  const r = rank([agg("a", [{}, { assistant: 1 }], { label: "검색 결함 점검", project: "통합검색" })], "결함 readalignedwindow");
  assert.equal(r.length, 1);
  assert.ok(r[0].fields.includes("name"));
  const p = rank([agg("b", [{}, { user: 1 }], { project: "로고 만들기" })], "로고 색");
  assert.ok(p[0].fields.includes("project"));
});
test("★ [K5] 관련도: 한 말에 함께 모인 세션이 흩어진 세션보다 앞선다", () => {
  const r = rank([
    agg("scatter", [{ user: 1 }, { assistant: 1 }], { maxCo: 1, coAll: 0, lastHit: iso(NOW) }),
    agg("together", [{ user: 1 }, { user: 1 }], { maxCo: 2, coAll: 1, lastHit: iso(NOW - 10 * DAY) }),
  ], "슬랙 검색", "relevance");
  assert.deepEqual(r.map((x) => x.agg.session_id), ["together", "scatter"]);
});
test("[K5b] 관련도: 모든 낱말이 한 말에 다 모이지 않아도, 더 많이 모인 세션이 앞선다", () => {
  const r = rank([
    agg("one-each", [{ user: 1 }, { user: 1 }, { user: 1 }], { maxCo: 1, coAll: 0, lastHit: iso(NOW) }),
    agg("two-together", [{ user: 1 }, { user: 1 }, { user: 1 }], { maxCo: 2, coAll: 0, lastHit: iso(NOW - 5 * DAY) }),
  ], "슬랙 검색 순서", "relevance");
  assert.deepEqual(r.map((x) => x.agg.session_id), ["two-together", "one-each"]);
});
test("[K6] 관련도: 친 그대로 맞은 세션이 조사 뗀 꼴로만 맞은 세션보다 앞선다", () => {
  const r = rank([agg("stem", [{ user: 0.8 }]), agg("full", [{ user: 1 }])], "검색을", "relevance");
  assert.deepEqual(r.map((x) => x.agg.session_id), ["full", "stem"]);
});
test("★ [K7] 최신순(기본): 맨 위에 관련도 앞 셋, 그 아래는 맞은 때가 늦은 세션부터(슬랙 Recent + Top Results)", () => {
  const strong = (sid: string, days: number) => agg(sid, [{ user: 1 }, { user: 1 }], { maxCo: 2, coAll: 3, phrase: true, hits: 9, lastHit: iso(NOW - days * DAY) });
  const weak = (sid: string, days: number) => agg(sid, [{ assistant: 0.8 }, { edit: 0.8 }], { maxCo: 1, hits: 1, lastHit: iso(NOW - days * DAY) });
  const r = rank([weak("w-new", 0), strong("s-old", 30), weak("w-mid", 3), weak("w-old", 9)], "슬랙 검색");
  assert.deepEqual(r.map((x) => [x.agg.session_id, x.top]), [["s-old", true], ["w-new", false], ["w-mid", false], ["w-old", false]]);
});
test("[K8] 맨 위에는 1등의 80% 이상만 · 최대 셋", () => {
  const s = (sid: string) => agg(sid, [{ user: 1 }], { hits: 50 });
  const r = rank([s("a"), s("b"), s("c"), s("d"), agg("weak", [{ assistant: 0.8 }])], "검색");
  assert.equal(r.filter((x) => x.top).length, CONV_TOP_MAX);
  assert.ok(!r.find((x) => x.agg.session_id === "weak")?.top);
});
test("[K9] 관련도순은 맨 위 표시 없이 관련도 내림차순", () => {
  const r = rank([agg("a", [{ assistant: 0.8 }]), agg("b", [{ user: 1 }], { hits: 9 })], "검색", "relevance");
  assert.deepEqual(r.map((x) => [x.agg.session_id, x.top]), [["b", false], ["a", false]]);
});
test("[K10] 시각을 모르는 세션은 최신순 맨 뒤 · at=null", () => {
  const r = rank([agg("nots", [{ assistant: 1 }], { lastHit: null }), agg("ts", [{ assistant: 1 }], { lastHit: iso(NOW - 3 * DAY) }), agg("top", [{ user: 1 }], { hits: 40, coAll: 5 })], "검색");
  assert.equal(r[r.length - 1].agg.session_id, "nots");
  assert.equal(r[r.length - 1].at, null);
});
test("[K11] 나머지가 같으면 내 세션이 앞선다 · limit 만큼만", () => {
  const r = rank([agg("theirs", [{ user: 1 }], { owner: "other" }), agg("mine", [{ user: 1 }])], "검색", "relevance");
  assert.deepEqual(r.map((x) => x.agg.session_id), ["mine", "theirs"]);
  assert.equal(rank(Array.from({ length: 12 }, (_, i) => agg("s" + i, [{ user: 1 }])), "검색", "recent", 5).length, 5);
});
test("[K12] 낱말이 없으면 결과 없음 · 대소문자 무시는 SQL ILIKE 와 낱말 소문자화가 맡는다", () => {
  assert.equal(rank([agg("a", [])], "").length, 0);
  assert.equal(convRelevance(agg("a", [{ user: 1 }], { label: "Slack 정리" }), parseQueryTerms("SLACK"), { nowMs: NOW }).all, true);
});
test("[E2] 색인하는 고친 파일 = 경로 끝 세 마디(빈 값 · 세 마디 미만 · 윈도 경로)", () => {
  assert.equal(editTail(""), "");
  assert.equal(editTail("omni.ts"), "omni.ts");
  assert.equal(editTail("v2/omni.ts"), "v2/omni.ts");
  assert.equal(editTail("C:\\w\\lively\\web\\v2\\omni.ts"), "web/v2/omni.ts");
  assert.equal(editTail("/work/shared/project/4530/lively/web/v2/omni.ts"), "web/v2/omni.ts");
});
test("[E1] 고친 파일은 파일 이름 + 바로 위 폴더로 보인다", () => {
  assert.equal(editLabel("/work/shared/project/4530/lively/web/v2/omni.ts"), "v2/omni.ts");
  assert.equal(editLabel("omni.ts"), "omni.ts");
  assert.equal(editLabel("C:\\w\\a\\b.ts"), "a/b.ts");
});

test("[P1] 정렬 파라미터 — recent 만 최신순, 나머지는 관련도순", () => {
  assert.equal(parseConvSort("recent"), "recent");
  for (const v of ["relevance", "", undefined, "RECENT", "score"]) assert.equal(parseConvSort(v), "relevance");
});

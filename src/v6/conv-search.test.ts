import { strict as assert } from "node:assert";
import test from "node:test";
import {
  extractConvMessages, clipBody, snippetAround, snippetAroundMost, recencyBoost, editTail, rankConvAggs, rankConvAggsCounted, convRelevance, parseConvSort, editedPaths,
  editLabel, snippetTerms, CONV_BODY_MAX, RECENCY_MAX, CONV_TOP_MAX, parseSessionIds, SEARCH_SESSION_IDS_MAX, SESSION_ID_RE, type ConvSessionAgg,
} from "./conv-search.js";
import { parseQueryTerms, stemKo, termStrength, likePattern, termPatterns, loosePatterns, looseStrength, looseFind, requiredTerms, likeToRegExp } from "./query-terms.js";
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
  //  다른 표기(검색 = search · 서치)도 발췌에서 칠한다(#4530 3차).
  assert.deepEqual(snippetTerms(parseQueryTerms("검색을 omni")), ["검색을", "검색", "search", "서치", "omni"]);
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
test("[K2] 낱말 하나가 그 세션 어디에도 없으면 맞는 결과가 아니다 — «덜 맞는 결과» 로만(빠진 낱말을 말한다)", () => {
  const r = rankConvAggsCounted([agg("a", [{ user: 1 }, {}])], { terms: parseQueryTerms("슬랙 검색"), sort: "recent", nowMs: NOW, requester: "me", limit: 20 });
  assert.equal(r.total, 0);
  assert.deepEqual(r.rows.map((x) => [x.agg.session_id, x.tier, x.missing]), [["a", "weak", ["검색"]]]);
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

// ── #4553 세션 이력 앱 «대화 찾기» — 발췌는 낱말이 가장 많이 모인 자리에서 ──
//  S5 낱말 둘이 멀리 떨어져 먼저 하나씩 나오고 뒤에서 함께 나온다 → 함께 나오는 자리 · S6 낱말 하나면 snippetAround 와 같다 ·
//  S7 낱말이 한 번도 안 나오면 글의 앞머리 · S8 짧은 글은 그대로 · S9 경계값(뒤 낱말이 창 안에 끝까지 들어야 한 창) · S10 같은 수면 앞쪽 자리
const FILL = (n: number): string => "가나다라마바사아자차".repeat(Math.ceil(n / 10)).slice(0, n);
test("[S5] 낱말 둘 — 따로 먼저 나오고 뒤에서 함께 나오면, 함께 나오는 자리를 발췌한다", () => {
  const text = `세션 이야기로 시작한다 ${FILL(400)} 한참 뒤에 세션 이력 앱을 고친다 ${FILL(200)}`;
  const first = snippetAround(text, ["세션", "이력"], 80, 20);
  const most = snippetAroundMost(text, ["세션", "이력"], 80, 20);
  assert.ok(first.includes("세션") && !first.includes("이력"), `대조: 첫 자리 발췌에는 한 낱말뿐 — ${first}`);
  assert.ok(most.includes("세션 이력 앱"), most);
});
test("[S6] 낱말이 하나면 첫 자리 발췌와 같다", () => {
  const text = `${FILL(300)} 검색을 고친다 ${FILL(300)} 검색을 또 고친다`;
  assert.equal(snippetAroundMost(text, ["검색"], 80, 20), snippetAround(text, ["검색"], 80, 20));
});
test("[S7] 낱말이 한 번도 안 나오면 글의 앞머리다", () => {
  const text = FILL(500);
  assert.equal(snippetAroundMost(text, ["없는말"], 80, 20), text.slice(0, 80) + "…");
  assert.equal(snippetAroundMost(text, [], 80, 20), text.slice(0, 80) + "…");
});
test("[S8] 상한보다 짧은 글은 그대로다", () => {
  assert.equal(snippetAroundMost("세션  이력\n앱", ["세션", "이력"], 80, 20), "세션 이력 앱");
});
test("[S9] 경계값 — 뒤 낱말이 창 폭(max - lead = 60) 안에 끝까지 들어야 한 창이다(한 글자라도 넘치면 아니다)", () => {
  //  뒤쪽(400 근처)에 두 낱말이 넉넉히 함께 나오는 자리를 하나 더 둔다 — 앞 자리가 한 창인지 아닌지에 따라 고르는 자리가 갈린다.
  const LATER = `${FILL(240)}세션 이력 함께${FILL(100)}`;
  //  «세션»(100~102) 뒤로 «이력» 이 158~160 → 창 [100, 160) 에 끝까지 든다 → 앞 자리가 이미 둘 다 든 창이다(앞쪽이 이긴다).
  const fits = `${FILL(100)}세션${FILL(56)}이력${LATER}`;
  const s1 = snippetAroundMost(fits, ["세션", "이력"], 80, 20);
  assert.equal(s1, snippetAround(fits, ["세션", "이력"], 80, 20));
  assert.ok(s1.includes("세션") && s1.includes("이력") && !s1.includes("함께"), s1);
  //  한 글자 밀리면(159~161) «이» 만 걸친다 → 앞 자리는 한 창이 아니다 → 둘 다 끝까지 드는 뒤 자리를 고른다.
  const spills = `${FILL(100)}세션${FILL(57)}이력${LATER}`;
  const s2 = snippetAroundMost(spills, ["세션", "이력"], 80, 20);
  assert.ok(s2.includes("세션 이력 함께"), s2);
});
test("[S10] 낱말 수가 같은 창이 여럿이면 앞쪽 자리다", () => {
  const text = `${FILL(100)}세션 이력 하나${FILL(300)}세션 이력 둘${FILL(100)}`;
  assert.ok(snippetAroundMost(text, ["세션", "이력"], 80, 20).includes("세션 이력 하나"));
});

// ── #4530 3차 — 글자가 조금 달라도 찾는다 · 충분히 맞는 것만 추려 시간순 ──
//  원준 2026-10-05: «검색의 퀄리티가 너무 구린 것 같은데» · «결국 세션을 해야함» · «어느정도 이상 되는 애들 찾고 그 다음은 시간순 정렬이 맞지않나».
//  엣지 표(행마다 시험 하나):
//   | L1 | 군말(«방법» · «세션»)                    | 없어도 되는 낱말 — 전부 군말이면 전부 있어야 한다 |
//   | L2 | 다른 표기(배포 = deploy)                  | 세기 0.7 로 맞는다 · 같을 때만(일부가 아니라)      |
//   | L3 | 붙여 쓴 말(«통합검색» ↔ «통합 검색»)       | 느슨한 꼴로 맞는다(0.5) · 실제 글을 찾아 준다      |
//   | L4 | 한 글자 틀림 · 자리 바뀜 · 빠뜨림 · 더 침  | 세 글자(영문 다섯)부터 · 두 글자 낱말은 안 느슨해진다 |
//   | L5 | LIKE 메타문자가 든 낱말                    | 글자 그대로(와일드카드가 되지 않는다)              |
//   | T1 | AI 가 한두 번 스친 말로만 맞은 세션         | 덜 맞는 결과 · 세 번 이상이면 맞는 결과            |
//   | T2 | 느슨하게 맞은 세션                         | 덜 맞는 결과(무엇을 느슨하게 봤는지 말한다)        |
//   | T3 | 낱말 일부만 맞은 세션                      | 맞는 결과가 적을 때만 · 사람 자리에 맞았을 때만    |
//   | T4 | 순서                                       | 맞는 결과(맨 위 셋 + 시간순) 뒤에 덜 맞는 결과(관련도순) |
//   | T5 | 군말이 섞인 검색어                         | 군말이 없는 세션도 맞는 결과 · 있으면 더 위(관련도) |
test("[L1] 군말은 없어도 되는 낱말 — 전부 군말이면 전부 있어야 하는 낱말로 돌아간다", () => {
  assert.deepEqual(parseQueryTerms("배포 절차 방법").map((t) => [t.t, !!t.optional]), [["배포", false], ["절차", false], ["방법", true]]);
  assert.deepEqual(parseQueryTerms("배포 세션을").map((t) => [t.t, !!t.optional]), [["배포", false], ["세션을", true]]);
  assert.deepEqual(parseQueryTerms("문제 해결").map((t) => !!t.optional), [false, false]);
  assert.deepEqual(parseQueryTerms('"방법" 배포').map((t) => !!t.optional), [false, false]);   // 구절은 군말이 아니다
  assert.deepEqual(requiredTerms(parseQueryTerms("로그인 문제 어떻게")).map((t) => t.t), ["로그인"]);
});
test("[L2] 다른 표기 — 그 표기로 든 글도 맞는다(0.7) · 낱말이 묶음의 표기와 같을 때만", () => {
  const [t] = parseQueryTerms("배포를");
  assert.deepEqual(t.alts, ["deploy", "디플로이", "deployment"]);
  assert.equal(termStrength("we deploy on friday", t), 0.7);
  assert.equal(termStrength("배포 절차", t), 0.8);
  assert.equal(parseQueryTerms("재배포")[0].alts, undefined);            // 일부가 같은 것은 묶음이 아니다
  assert.equal(parseQueryTerms("log")[0].alts, undefined);               // login 에 맞아 버리는 짧은 표기는 묶음에 없다
});
test("[L3] 붙여 쓴 말은 띄어 쓴 글과 느슨하게 맞는다 · 실제 글을 찾아 준다", () => {
  const [t] = parseQueryTerms("통합검색");
  assert.equal(termStrength("새 통합 검색 창", t), 0);
  assert.equal(looseStrength("새 통합 검색 창", t), 0.5);
  assert.equal(looseFind("새 통합 검색 창", t), "통합 검색");
  assert.equal(looseStrength("통합 프로젝트 검사", t), 0);
});
test("[L4] 한 글자 틀림 · 자리 바뀜 · 빠뜨림 · 더 침 — 세 글자(영문 다섯)부터", () => {
  const T = (q: string) => parseQueryTerms(q)[0];
  assert.equal(looseStrength("새 프로젝트 만들기", T("프로잭트")), 0.5);   // 한 글자 틀림
  assert.equal(looseStrength("미리보기 칸", T("미리기보")), 0.5);          // 이웃 글자 자리 바뀜
  assert.equal(looseStrength("새 프로젝트", T("프젝트")), 0.5);            // 한 글자 빠뜨림
  assert.equal(looseStrength("새 프로젝트", T("프로젝젝트")), 0.5);        // 한 글자 더 침
  assert.equal(looseFind("새 프로젝트 만들기", T("프로잭트")), "프로젝트");
  assert.deepEqual(loosePatterns(T("검색")), []);                          // 두 글자 — «검_» 이 «검사»·«검토» 를 다 잡는다
  assert.deepEqual(loosePatterns(T("omni")), ["%omni%"]);                  // 영문 네 글자 — 붙여 쓴 꼴만
  assert.equal(looseStrength("the sidebar closes", T("sidebor")), 0.5);
  assert.deepEqual(loosePatterns(parseQueryTerms('"통합 검색"')[0]), []);  // 구절은 친 그대로만
  assert.deepEqual(loosePatterns(parseQueryTerms("배포 방법")[1]), []);    // 군말은 느슨하게 찾지 않는다
});
test("[L5] LIKE 메타문자가 든 낱말은 글자 그대로 — 느슨한 꼴에서도 와일드카드가 되지 않는다", () => {
  const [t] = parseQueryTerms("100%_");
  assert.ok(loosePatterns(t).every((p) => !/[^\\][%_]/.test(p.slice(1, -1).replace(/\\[%_\\]/g, "").replace(/_/g, ""))), "탈출 안 된 % 가 없다");
  assert.ok(likeToRegExp(loosePatterns(t)[0]).test("100%_"));
  assert.equal(likeToRegExp(loosePatterns(t)[0]).test("100xx"), false);
});
const judge = (a: ConvSessionAgg, q: string, loose: number[] = []) => convRelevance(a, parseQueryTerms(q), { nowMs: NOW, requester: "me", looseIdx: new Set(loose) });
test("★ [T1] AI 가 한두 번 스친 말로만 맞은 세션은 문턱 밖 — 세 번 이상 이야기했으면 문턱 안", () => {
  assert.equal(judge(agg("a", [{ assistant: 1 }], { aiHits: 2, hits: 2 }), "배포").strong, false);
  assert.equal(judge(agg("a", [{ assistant: 1 }], { aiHits: 3, hits: 3 }), "배포").strong, true);
  assert.equal(judge(agg("a", [{ user: 1 }], { userHits: 1 }), "배포").strong, true);                       // 사람이 한 말
  assert.equal(judge(agg("a", [{ edit: 1 }]), "omni.ts").strong, true);                                     // 고친 파일
  assert.equal(judge(agg("a", [{ assistant: 1 }, { assistant: 1 }], { coAll: 0, aiHits: 2 }), "배포 절차").strong, false);   // AI 말에 흩어져
  assert.equal(judge(agg("a", [{ assistant: 1 }, { assistant: 1 }], { coAll: 1, maxCo: 2, aiHits: 1 }), "배포 절차").strong, true);   // 한 말에 함께
  assert.equal(judge(agg("a", [{ user: 1 }, { assistant: 1 }], { coAll: 0 }), "배포 절차").strong, true);    // K1 — 사람 말에 하나라도
});
test("[T2] 느슨하게만 맞은 낱말이 있으면 문턱 밖 — 무엇을 느슨하게 봤는지 싣는다", () => {
  const j = judge(agg("a", [{ user: 0.5 }, { user: 1 }], { coAll: 1, maxCo: 2 }), "통합검색 창", [0]);
  assert.equal(j.all, true); assert.equal(j.strong, false); assert.deepEqual(j.loose, [0]);
  //  이름·첫 지시에도 느슨한 맞춤을 본다(looseIdx 의 낱말만)
  const named = { ...agg("b", [{}, { user: 1 }]), label: "통합 검색 고치기" };
  assert.deepEqual(judge(named, "통합검색 창", [0]).loose, [0]);
  assert.deepEqual(judge(named, "통합검색 창").missing, [0]);
});
test("[T3] 낱말 일부만 맞은 세션 — 맞는 결과가 다섯보다 적을 때만 · 맞은 낱말이 사람 자리에 있을 때만 · 절반 이상 맞았을 때만", () => {
  const full = (id: string) => agg(id, [{ user: 1 }, { user: 1 }], { coAll: 1, maxCo: 2 });
  const half = agg("p", [{ user: 1 }, {}]);
  const aiHalf = agg("q", [{ assistant: 1 }, {}], { aiHits: 9 });
  const few = rankConvAggsCounted([full("a"), half, aiHalf], { terms: parseQueryTerms("슬랙 검색"), sort: "recent", nowMs: NOW, requester: "me", limit: 20 });
  assert.deepEqual(few.rows.map((x) => [x.agg.session_id, x.tier]), [["a", "match"], ["p", "weak"]]);
  const many = rankConvAggsCounted([full("a"), full("b"), full("c"), full("d"), full("e"), half], { terms: parseQueryTerms("슬랙 검색"), sort: "recent", nowMs: NOW, requester: "me", limit: 20 });
  assert.equal(many.rows.some((x) => x.agg.session_id === "p"), false);
  const third = rankConvAggsCounted([agg("t", [{ user: 1 }, {}, {}])], { terms: parseQueryTerms("슬랙 검색 순서"), sort: "recent", nowMs: NOW, requester: "me", limit: 20 });
  assert.equal(third.rows.length, 0);   // 셋 중 하나만 — 절반이 안 된다
});
test("★ [T4] 순서 — 맞는 결과(맨 위 셋 + 그 아래 시간순)가 먼저, 덜 맞는 결과(관련도순)가 뒤 · limit 은 맞는 결과에만", () => {
  const D = 86_400_000;
  const strongOld = agg("old", [{ user: 1 }, { user: 1 }], { coAll: 3, maxCo: 2, phrase: true, hits: 9, lastHit: iso(NOW - 200 * D) });
  const okNew = agg("new", [{ user: 1 }, { assistant: 1 }], { lastHit: iso(NOW - D) });
  const okMid = agg("mid", [{ user: 1 }, { assistant: 1 }], { lastHit: iso(NOW - 30 * D) });
  const weakNew = agg("weak", [{ assistant: 1 }, { assistant: 1 }], { aiHits: 2, lastHit: iso(NOW) });
  const r = rankConvAggsCounted([weakNew, okMid, okNew, strongOld], { terms: parseQueryTerms("슬랙 검색"), sort: "recent", nowMs: NOW, requester: "me", limit: 20 });
  //  옛 세션은 맨 위 «가장 맞는 결과» 로만 선다(점수가 압도적일 때) — 그 아래는 최근 것부터. 방금 스친 세션은 맨 아래.
  assert.deepEqual(r.rows.map((x) => [x.agg.session_id, x.tier, x.top]), [["old", "match", true], ["new", "match", false], ["mid", "match", false], ["weak", "weak", false]]);
  assert.deepEqual([r.total, r.weak], [3, 1]);
  const cut = rankConvAggsCounted([weakNew, okMid, okNew, strongOld], { terms: parseQueryTerms("슬랙 검색"), sort: "recent", nowMs: NOW, requester: "me", limit: 2 });
  assert.deepEqual(cut.rows.map((x) => x.agg.session_id), ["old", "new", "weak"]);
});
test("[T5] 군말이 섞인 검색어 — 군말이 없는 세션도 맞는 결과 · 군말까지 든 세션은 관련도가 더 높다", () => {
  const without = agg("a", [{ user: 1 }, {}]);
  const withIt = agg("b", [{ user: 1 }, { user: 1 }]);
  assert.equal(judge(without, "배포 방법").all, true);
  assert.equal(judge(without, "배포 방법").strong, true);
  assert.ok(judge(withIt, "배포 방법").rel > judge(without, "배포 방법").rel);
});

// ── #4530 번호로 찾기 — 친 번호가 그 세션이 묶인 프로젝트·맡은 태스크의 번호다 ──
test("[N1] 번호로 묶인 세션은 문턱 안(지목이다) — 대화에 그 숫자가 없어도 · 자리에 'ident' 가 실린다", () => {
  const bound = { ...agg("a", [{}], { hits: 0 }), ident: [true] };
  const j = judge(bound, "4530");
  assert.equal(j.all, true); assert.equal(j.strong, true); assert.ok(j.fields.includes("ident"));
  //  번호 + 낱말 — 낱말이 없으면 낱말 일부만 맞은 세션이다(문턱 밖).
  const half = { ...agg("b", [{}, {}], { hits: 0 }), ident: [true, false] };
  assert.equal(judge(half, "4530 배포").all, false);
  assert.deepEqual(judge(half, "4530 배포").missing, [1]);
  //  AI 가 그 숫자를 한 번 스친 세션은 여전히 문턱 밖 — 묶인 세션이 그 위에 선다.
  const mention = agg("c", [{ assistant: 1 }], { aiHits: 1 });
  assert.equal(judge(mention, "4530").strong, false);
  assert.ok(judge(bound, "4530").rel > judge(mention, "4530").rel);
});

test("[N2] 숫자만으로 된 낱말은 느슨하게 찾지 않는다 — 한 글자 다른 번호는 다른 번호다", () => {
  assert.deepEqual(loosePatterns(parseQueryTerms("4530")[0]!), []);
  assert.deepEqual(loosePatterns(parseQueryTerms("#123456")[0]!), []);
  assert.ok(loosePatterns(parseQueryTerms("통합검색")[0]!).length > 1, "대조 — 글자 낱말은 느슨한 꼴이 있다");
});
test("[N3] rankConvAggsCounted 는 층이 매겨진 세션 전부를 돌려준다 — 줄 수 상한에 잘린 것도(뜻으로만 온 세션과 가르는 근거)", () => {
  const many = Array.from({ length: 5 }, (_, i) => agg("s" + i, [{ user: 1 }], { hits: 2, lastHit: new Date(NOW - i * 3_600_000).toISOString() }));
  const r = rankConvAggsCounted(many, { terms: parseQueryTerms("물소"), sort: "recent", nowMs: NOW, limit: 2 });
  assert.equal(r.rows.length, 2);
  assert.equal(r.total, 5);
  assert.deepEqual(r.judged.map((a) => a.session_id).sort(), ["s0", "s1", "s2", "s3", "s4"]);
});

// #4553 — 맞은 말 검색의 세션 거르개(세션 이력 앱의 사이드바에서 고른 범위). 원준 2026-10-05 «A안으로 고고».
//  엣지 표(스크래치패드 spec-side.md V): V1 없음 = 거르지 않음 · V2 빈 목록 = 빈 목록(결과 없음) · V3 틀린 것은 400 감 ·
//   V4 중복은 한 번 · V5 경계(정확히 상한 개). 저장 쪽(그 세션의 말만)은 session-history.pg-test.mjs M19~M23 이 SQL 로 잰다.
test("[V1] sessions 가 없으면 거르지 않는다(null) — undefined · null 둘 다", () => {
  assert.deepEqual(parseSessionIds(undefined), { ok: true, ids: null });
  assert.deepEqual(parseSessionIds(null), { ok: true, ids: null });
});
test("[V2] 빈 목록은 «없음» 이 아니다 — 빈 목록 그대로(찾을 세션이 없다)", () => {
  assert.deepEqual(parseSessionIds([]), { ok: true, ids: [] });
});
test("[V3] 배열이 아니거나 세션 id 꼴이 아닌 값이 섞이면 틀렸다고 답한다 — 조용히 버리지 않는다", () => {
  for (const bad of ["c1", 5, { 0: "c1" }, true]) assert.equal(parseSessionIds(bad).ok, false, JSON.stringify(bad));
  for (const bad of [["c1", 5], ["c1", ""], ["c1", null], ["a b"], ["c1", "x".repeat(65)], ["c1", ["c2"]], ["../etc"], ["c1,c2"]]) {
    const r = parseSessionIds(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    if (!r.ok) assert.match(r.error, /sessions/);
  }
});
test("[V4] 같은 id 가 두 번 와도 한 번만 · 순서는 온 순서", () => {
  assert.deepEqual(parseSessionIds(["b", "a", "b", "a.b_c-1"]), { ok: true, ids: ["b", "a", "a.b_c-1"] });
});
test("[V5] 경계 — 정확히 상한 개는 받고, 하나 더 많으면 틀렸다고 답한다", () => {
  const ids = Array.from({ length: SEARCH_SESSION_IDS_MAX }, (_, i) => "s" + i);
  const at = parseSessionIds(ids);
  assert.equal(at.ok && at.ids?.length, SEARCH_SESSION_IDS_MAX);
  assert.equal(parseSessionIds([...ids, "one-more"]).ok, false);
  assert.equal(SESSION_ID_RE.test("x".repeat(64)), true);
  assert.equal(SESSION_ID_RE.test("x".repeat(65)), false);
});

// ── #4530 배포 뒤 — 한 글자 낱말은 다른 있어야 하는 낱말이 둘 이상이면 없어도 되는 낱말 ──
test("[N4] 한 글자 낱말 — 다른 낱말이 둘 이상이면 없어도 되는 낱말 · 둘뿐이면 그대로 · 따옴표·숫자 한 자는 그대로", () => {
  const opt = (q: string): string[] => parseQueryTerms(q).filter((t) => t.optional).map((t) => t.t);
  assert.deepEqual(opt("미리 보기 환경이 안 뜸"), ["안", "뜸"]);
  assert.deepEqual(opt("폰 터미널 사진 첨부"), ["폰"]);
  assert.deepEqual(opt("폰에서 터미널 사진 첨부"), [], "조사가 붙은 한 글자(«폰에서»)는 조사를 떼지 않으므로(한 글자로 줄지 않는다) 그대로 있어야 하는 낱말");
  assert.deepEqual(opt("앱 삭제"), [], "낱말이 둘뿐이면 한 글자도 있어야 하는 낱말이다");
  assert.deepEqual(opt("앱"), []);
  assert.deepEqual(opt('터미널 사진 "폰"'), [], "따옴표로 묶으면 그대로 찾는다");
  assert.deepEqual(opt("터미널 사진 3"), [], "숫자 한 자는 번호일 수 있다");
  assert.deepEqual(opt("a 터미널 사진"), ["a"]);
});

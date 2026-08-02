// 블록 에디터 파스↔직렬화 왕복 골든 (#1313 R58)
//  web/ 에는 테스트가 0건이었다 — block-editor.ts(2,200줄)를 web/editor/ 로 분해하기 전에 세운 안전망이다.
//  러너는 web/ 을 수집하지 않으므로(src/**/*.test.ts 와 kit|scripts|deploy/**/*.test.mjs 만),
//  컴파일 산출물 public/app/editor/*.js 를 그대로 import 한다(DOM 무의존 순수 모듈이라 가능 — session-status.test.mjs 동형).
//
// 이 왕복이 깨지면 실제로 나는 일:
//  🔴 지식 본문(body_md)을 에디터로 한 번 열었다 저장하기만 해도 문서가 변형된다 — 표·수식·:::synced 같은
//     '에디터가 구조적으로 못 다루는' 마크다운은 raw 블록으로 무손실 보존하는 것이 계약인데, 그게 깨지면 소실된다.
//  🔴 #657z 실행취소가 마크다운 스냅샷 스택이라(왕복 무손실을 전제로 한다) ⌘Z 한 번에 문서가 뒤틀린다.
//  🔴 에이전트/MCP 가 쓴 notion-md ::: 방언(toggle/columns/callout/collection)이 사람이 한 번 편집하면 raw 로 강등된다.
//
// 3계층으로 고정한다:
//  ① 고정점(fixed point) — 정규형 문서는 md → 블록 → md 가 **완전 동일**해야 한다(24종).
//  ② 정규화 + 안정성 — 비정규형(별표 마커·1) 번호·*** 구분선…)은 1패스에서 정규형으로, 그 뒤로는 불변.
//  ③ 블록 모델 스냅샷 — 파서가 만드는 블록 구조 자체를 못박는다(고정점만으로는 파서·직렬화가 같이 틀려도 통과하므로).
//  ④ inlineDomToMd — renderInline 의 역함수. DOM 노드 최소 페이크(childNodes/nodeType/tagName/textContent/getAttribute)로 검증.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { mdToBlocks, parseColumns } = await import(join(root, "public/app/editor/parse.js"));
const { blocksToMd, escInline, escLineStart, inlineDomToMd } = await import(join(root, "public/app/editor/serialize.js"));

let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const round = (md) => blocksToMd(mdToBlocks(md));

// ════════ ① 고정점 — 정규형 문서는 왕복해도 한 글자도 안 바뀐다 ════════
const FIXED_POINT = {
  "문단(소프트 브레이크 보존)": "첫 문단입니다.\n소프트 브레이크 줄.\n\n둘째 문단.",
  "제목 1-4": "# 제목1\n\n## 제목2\n\n### 제목3\n\n#### 제목4",
  "글머리 목록(중첩)": "- 하나\n- 둘\n  - 중첩\n- 셋",
  "번호 목록(중첩)": "1. 하나\n2. 둘\n  1. 중첩\n3. 셋",
  "할 일 목록": "- [ ] 안 함\n- [x] 함",
  "인용(연속 줄 = 한 블록)": "> 인용 한 줄\n> 인용 둘째 줄",
  "콜아웃": ":::callout icon=💡\n주의하세요\n:::",
  "콜아웃(배경색)": ":::callout icon=🔥 color=red_background\n빨강\n:::",
  "코드(lang)": "```ts\nconst a = 1;\n```",
  "코드(lang 없음)": "```\nplain\n```",
  "구분선": "---",
  "토글": ":::toggle 요약 텍스트\n안쪽 문단\n:::",
  "토글(중첩)": ":::toggle 바깥\n:::toggle 안쪽\n내용\n:::\n:::",
  "컬럼 2열": ":::columns\n:::column\n왼쪽\n:::\n:::column\n오른쪽\n:::\n:::",
  "컬렉션(전체 속성)": ":::collection category=ops type=decision limit=5 view=cards sort=title\n:::",
  "컬렉션(기본)": ":::collection limit=5\n:::",
  "페이지 카드": "[문서 제목](#/k/some-doc)",
  "표(raw 무손실)": "| 열 1 | 열 2 |\n| --- | --- |\n| a | b |",
  "수식(raw 무손실)": "$$\nE = mc^2\n$$",
  "미지 컨테이너(raw 무손실)": ":::synced\n동기화 블록\n:::",
  "인라인 서식 원문 보존": "**굵게** *기울임* ~~취소~~ ==형광== ++밑줄++ `코드`",
  "링크": "[라이블리](https://example.com) 뒤 텍스트",
  "이미지": "![alt 텍스트](https://example.com/a.png)",
  "복합 문서": "# 문서\n\n소개 문단.\n\n- 항목 1\n- 항목 2\n\n> 인용\n\n```js\nfoo();\n```\n\n---\n\n마지막 문단.",
};
for (const [name, md] of Object.entries(FIXED_POINT)) {
  assert.equal(round(md), md, `고정점 깨짐 [${name}]\n  기대: ${JSON.stringify(md)}\n  실제: ${JSON.stringify(round(md))}`);
  assert.equal(round(round(md)), md, `고정점 2패스 불안정 [${name}]`);
  ok(`① 고정점 — ${name}`);
}

// ════════ ② 정규화 + 그 뒤 안정 — 비정규 입력은 1패스에서 정규형으로 수렴하고 이후 불변 ════════
const NORMALIZE = {
  "별표 마커 → '-'": ["* 하나\n* 둘", "- 하나\n- 둘"],
  "더하기 마커 → '-'": ["+ 하나", "- 하나"],
  "'1)' 괄호 번호 → '1.'": ["1) 하나\n2) 둘", "1. 하나\n2. 둘"],
  "번호 재부여": ["3. 하나\n7. 둘\n9. 셋", "1. 하나\n2. 둘\n3. 셋"],
  "'***' 구분선 → '---'": ["***", "---"],
  "'___' 구분선 → '---'": ["___", "---"],
  "빈 줄 여러 개 → 한 칸": ["첫째\n\n\n\n둘째", "첫째\n\n둘째"],
  "CRLF → LF": ["첫째\r\n\r\n둘째", "첫째\n\n둘째"],
  "제목 앞뒤 공백 정리": ["#   제목  ", "# 제목"],
  "빈 문서 → 빈 문단": ["", ""],
  "공백뿐인 문서 → 빈 문단": ["   \n\n  ", ""],
  "리스트 뒤 이어지는 들여쓴 평문은 직전 항목에 합류": ["- 하나\n  이어지는 줄", "- 하나 이어지는 줄"],
  "빈 컬럼 컨테이너는 해체": [":::columns\n:::column\n하나뿐\n:::\n:::", "하나뿐"],
  "닫히지 않은 컨테이너는 raw 로 보존": [":::toggle 안 닫힘\n내용", ":::toggle 안 닫힘\n내용"],
};
for (const [name, [input, want]] of Object.entries(NORMALIZE)) {
  const got = round(input);
  assert.equal(got, want, `정규화 어긋남 [${name}]\n  기대: ${JSON.stringify(want)}\n  실제: ${JSON.stringify(got)}`);
  assert.equal(round(got), want, `정규화 뒤 불안정 [${name}] — 2패스에서 또 바뀐다`);
  ok(`② 정규화 — ${name}`);
}

// ════════ ③ 블록 모델 스냅샷 — 파서 산출 구조 자체를 못박는다 ════════
//  (고정점만으로는 파서와 직렬화가 대칭으로 함께 틀려도 통과한다 — 중간 표현을 직접 고정한다.)
const SNAPSHOT = [
  ["문단", "본문", [{ type: "p", text: "본문" }]],
  ["제목 level", "### 셋", [{ type: "h", level: 3, text: "셋" }]],
  ["글머리 indent", "- a\n    - b", [
    { type: "bullet", indent: 0, checked: false, text: "a" },
    { type: "bullet", indent: 2, checked: false, text: "b" },
  ]],
  ["할 일 checked", "- [x] 됨", [{ type: "todo", indent: 0, checked: true, text: "됨" }]],
  ["콜아웃 attrs", ":::callout icon=🔥 color=red_background\n본문\n:::",
    [{ type: "callout", icon: "🔥", color: "red", text: "본문" }]],
  ["콜아웃 미지 색 → default", ":::callout icon=💡 color=nosuch_background\nx\n:::",
    [{ type: "callout", icon: "💡", color: "default", text: "x" }]],
  ["토글 children 재귀", ":::toggle 요약\n- 항목\n:::",
    [{ type: "toggle", summary: "요약", children: [{ type: "bullet", indent: 0, checked: false, text: "항목" }] }]],
  ["컬럼 cols 재귀", ":::columns\n:::column\nL\n:::\n:::column\nR\n:::\n:::",
    [{ type: "columns", cols: [[{ type: "p", text: "L" }], [{ type: "p", text: "R" }]] }]],
  ["컬렉션 attrs", ":::collection category=ops limit=3\n:::",
    [{ type: "collection", attrs: { category: "ops", limit: "3" } }]],
  ["페이지 카드 승격(내부 링크뿐인 줄)", "[제목](#/k/문서)",
    [{ type: "pagecard", name: "문서", label: "제목" }]],
  ["페이지 카드 아님(줄에 다른 내용이 섞이면 문단)", "앞 [제목](#/k/문서)",
    [{ type: "p", text: "앞 [제목](#/k/문서)" }]],
  ["표는 raw", "| a |\n| --- |\n| 1 |", [{ type: "raw", text: "| a |\n| --- |\n| 1 |" }]],
  ["수식은 raw", "$$\nx\n$$", [{ type: "raw", text: "$$\nx\n$$" }]],
  ["코드 lang·본문", "```py\nx = 1\n```", [{ type: "code", lang: "py", text: "x = 1" }]],
  ["빈 문서 → 빈 문단 1개", "", [{ type: "p", text: "" }]],
];
for (const [name, md, want] of SNAPSHOT) {
  assert.deepEqual(mdToBlocks(md), want, `블록 모델 스냅샷 어긋남 [${name}]\n  실제: ${JSON.stringify(mdToBlocks(md))}`);
  ok(`③ 블록 모델 — ${name}`);
}

// parseColumns 는 :::column 컨테이너로만 구성돼야 성립 — 아니면 null(= raw 폴백)
assert.deepEqual(parseColumns([":::column", "L", ":::"]), [[{ type: "p", text: "L" }]]);
ok("③ parseColumns — :::column 만 있으면 컬럼 배열");
assert.equal(parseColumns(["평문", ":::column", "L", ":::"]), null);
ok("③ parseColumns — 평문이 섞이면 null(raw 폴백)");
assert.equal(parseColumns([":::column", "L"]), null);
ok("③ parseColumns — 닫히지 않으면 null(raw 폴백)");

// ════════ ④ 역방향 — 블록 배열 → md → 블록 배열 ════════
const BLOCKS_ROUND = [
  ["텍스트 블록 전종", [
    { type: "h", level: 2, text: "제목" },
    { type: "p", text: "문단" },
    { type: "quote", text: "인용" },
    { type: "divider" },
  ]],
  ["리스트 run", [
    { type: "bullet", indent: 0, checked: false, text: "a" },
    { type: "numbered", indent: 0, checked: false, text: "b" },
    { type: "todo", indent: 0, checked: true, text: "c" },
  ]],
];
for (const [name, blocks] of BLOCKS_ROUND) {
  assert.deepEqual(mdToBlocks(blocksToMd(blocks)), blocks, `역방향 왕복 깨짐 [${name}]\n  실제: ${JSON.stringify(mdToBlocks(blocksToMd(blocks)))}`);
  ok(`④ 역방향 — ${name}`);
}

// ════════ ⑤ inlineDomToMd — renderInline 의 역함수(DOM 최소 페이크) ════════
const txt = (s) => ({ nodeType: 3, textContent: s, childNodes: [] });
const elem = (tagName, attrs, ...childNodes) => ({
  nodeType: 1,
  tagName,
  childNodes,
  dataset: attrs.dataset || {},
  getAttribute: (k) => (k in attrs ? attrs[k] : null),
  get textContent() { return childNodes.map((c) => c.textContent ?? "").join(""); },
});
const inl = (...kids) => inlineDomToMd({ childNodes: kids });

assert.equal(inl(txt("평문")), "평문");
ok("⑤ inlineDomToMd — 텍스트 노드");
assert.equal(inl(elem("STRONG", {}, txt("굵게"))), "**굵게**");
ok("⑤ inlineDomToMd — STRONG → **");
assert.equal(inl(elem("EM", {}, txt("기울임"))), "*기울임*");
ok("⑤ inlineDomToMd — EM → *");
assert.equal(inl(elem("DEL", {}, txt("취소"))), "~~취소~~");
ok("⑤ inlineDomToMd — DEL → ~~");
assert.equal(inl(elem("U", {}, txt("밑줄"))), "++밑줄++");
ok("⑤ inlineDomToMd — U → ++");
assert.equal(inl(elem("MARK", {}, txt("형광"))), "==형광==");
ok("⑤ inlineDomToMd — MARK → ==");
assert.equal(inl(elem("CODE", {}, txt("code()"))), "`code()`");
ok("⑤ inlineDomToMd — CODE → 백틱(내부 이스케이프 없음)");
assert.equal(inl(elem("A", { href: "#/k/문서" }, txt("제목"))), "[제목](#/k/문서)");
ok("⑤ inlineDomToMd — A → [텍스트](href)");
assert.equal(inl(elem("IMG", { src: "u.png", alt: "설명" })), "![설명](u.png)");
ok("⑤ inlineDomToMd — IMG → ![alt](src)");
assert.equal(inl(elem("IMG", { src: "/served/x.png", alt: "", dataset: { mdSrc: "원본.png" } })), "![](원본.png)");
ok("⑤ inlineDomToMd — IMG 는 data-md-src 를 우선(서빙 URL 이 아니라 원문 유지)");
assert.equal(inl(elem("BR", {})), "\n");
ok("⑤ inlineDomToMd — BR → 개행(소프트 브레이크)");
assert.equal(inl(elem("SPAN", {}, txt("속만"))), "속만");
ok("⑤ inlineDomToMd — 미지 요소는 투명(내용만)");
assert.equal(inl(elem("STRONG", {})), "");
ok("⑤ inlineDomToMd — 빈 마크는 버림");
assert.equal(inl(txt("a​b")), "ab");
ok("⑤ inlineDomToMd — ZWSP(캐럿 패딩 잔재) 제거");
assert.equal(inl(txt("별표*와 [대괄호 `백틱`")), "별표\\*와 \\[대괄호 \\`백틱\\`");
ok("⑤ inlineDomToMd — 평문의 인라인 문법 문자는 이스케이프");

// escInline / escLineStart 단위
assert.equal(escInline("a\\b"), "a\\\\b");
ok("⑤ escInline — 백슬래시 먼저 이스케이프");
assert.equal(escInline("~~x++y"), "\\~~x\\++y");
ok("⑤ escInline — ~~ · ++ 페어");
assert.equal(escLineStart("# 제목처럼 시작"), "\\# 제목처럼 시작");
ok("⑤ escLineStart — 제목 오파싱 차단");
assert.equal(escLineStart("- 목록처럼 시작"), "\\- 목록처럼 시작");
ok("⑤ escLineStart — 목록 오파싱 차단");
assert.equal(escLineStart("1. 번호처럼 시작"), "1\\. 번호처럼 시작");
ok("⑤ escLineStart — 번호 오파싱 차단");
assert.equal(escLineStart("> 인용처럼 시작"), "\\> 인용처럼 시작");
ok("⑤ escLineStart — 인용 오파싱 차단");
assert.equal(escLineStart("| 표처럼 시작"), "\\| 표처럼 시작");
ok("⑤ escLineStart — 표 오파싱 차단");
assert.equal(escLineStart("보통 문장"), "보통 문장");
ok("⑤ escLineStart — 평범한 줄은 그대로");

// 이스케이프된 줄머리는 다음 파스에서 블록으로 승격되지 않는다(왕복 계약의 핵심).
{
  const md = blocksToMd([{ type: "p", text: "# 제목 아님" }]);
  assert.deepEqual(mdToBlocks(md), [{ type: "p", text: "\\# 제목 아님" }]);
  ok("⑤ 줄머리 이스케이프 왕복 — 문단이 제목으로 승격되지 않는다");
}

console.log(`\n✓ block-editor 파스↔직렬화 왕복 골든 ${pass}건 통과`);

// 위키 레포 수집기 «경로 식별 모드» — 사양 기반·구현 블라인드 시험 (사양 §2·§3·§4). DB·네트워크 불요(순수 함수).
// 실행: npm run build && node dist/connectors/domain-wiki-path.test.js
//
// 잠그는 행위:
//  §2.1 wikiPathName — 결정적(NFC/NFD 무관) · 64자 이하 · 지식 이름 정규화의 고정점(밑줄 없음) · 같은 파일명 다른 경로/
//       다른 instance 는 다른 이름 · instance 가 앞부분 · 파일명이 읽히게 들어감 · 정규화하면 비는 파일명 · 아주 긴 입력.
//       (고정점은 사양 문장의 정규화를 이 파일 안에 그대로 옮겨 확인한다 — 다른 모듈을 import 하지 않는다.)
//  §2.2 firstHeading — 코드펜스(```·~~~, 같은 문자·그 이상 길이로 닫힘) 밖 첫 1단계 제목 · `##`/`#제목` 제외 ·
//       링크/굵게/코드 표시 걷기(낱개 밑줄 유지) · 닫는 # 제거 · CRLF.
//  §2.3 buildPathLinkTargets · pathBaseKey · normalizeWikiLinksByPath — 경로 기준 링크 해소 규칙 1~10.
//  §3   parseMaskKinds · maskSensitive — 종류 파싱 · 표식 · 고른 종류만 · 전화/사업자/주민·법인/이메일과 안 가리는 꼴.
//  §4   selectMarkdown · parseGitLogTimes · blobUrl · toRawItemPath, 그리고 슬러그 모드 toRawItem 회귀(§4.5).
import assert from "node:assert/strict";
import test from "node:test";
import {
  wikiPathName,
  firstHeading,
  buildPathLinkTargets,
  normalizeWikiLinksByPath,
  pathBaseKey,
  parseMaskKinds,
  unknownMaskWords,
  maskSensitive,
  wikiSlug,
} from "./domain-wiki-md.js";
import type { MaskKind } from "./domain-wiki-md.js";
import { selectMarkdown, parseGitLogTimes, blobUrl, toRawItemPath, toRawItem } from "./domain-wiki.js";

const nfc = (s: string): string => s.normalize("NFC");
const nfd = (s: string): string => s.normalize("NFD");

// ═══════════════════════════════ §2.1 wikiPathName ═══════════════════════════════

// 사양 §2.1.3 의 «지식 이름 정규화 함수»(소문자화 → [^a-z0-9가-힣]+ 를 - 로 → 양끝 - 제거 → 64자 자르기)를 문장 그대로 옮긴 것.
const normalizeKnowledgeName = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
const NAME_SHAPE = /^[a-z0-9가-힣]+(?:-[a-z0-9가-힣]+)*$/;

function assertValidName(name: string, ctx: string): void {
  assert.equal(typeof name, "string", `§2.1 ${ctx}: 이름은 문자열`);
  assert.ok(name.length >= 1, `§2.1.8 ${ctx}: 비지 않은 유효한 이름`);
  assert.ok(name.length <= 64, `§2.1.2 ${ctx}: 64자 이하여야 한다 (실제 ${name.length}자: ${name})`);
  assert.ok(!name.includes("_"), `§2.1.3 ${ctx}: 밑줄이 없다 (${name})`);
  assert.ok(NAME_SHAPE.test(name), `§2.1.3 ${ctx}: 소문자 영문·숫자·한글 완성형·하이픈만, 하이픈 연속·양끝 없음 (${name})`);
  assert.equal(normalizeKnowledgeName(name), name, `§2.1.3 ${ctx}: 지식 이름 정규화의 고정점이어야 한다 (${name})`);
}

test("§2.1.1 같은 (instance, relpath) 는 언제나 같은 이름 — relpath 가 NFC/NFD 만 다르면 같은 이름", () => {
  for (const rel of ["Card/a.md", "Card/2_business_layer/2-2.md", nfc("카드/입회 조건.md"), "_.md"]) {
    assert.equal(wikiPathName("wiki-pm", rel), wikiPathName("wiki-pm", rel), `§2.1.1 결정적: ${rel}`);
  }
  assert.equal(wikiPathName("wiki-pm", nfd("카드/입회 조건.md")), wikiPathName("wiki-pm", nfc("카드/입회 조건.md")),
    "§2.1.1 NFC/NFD 만 다른 경로는 같은 이름");
  assert.equal(wikiPathName("wiki-pm", nfd("Card/카드사-입회-조건.md")), wikiPathName("wiki-pm", nfc("Card/카드사-입회-조건.md")),
    "§2.1.1 NFC/NFD 만 다른 한글 파일명은 같은 이름");
});

test("§2.1.2·§2.1.3 64자 이하이고 지식 이름 정규화의 고정점(밑줄·대문자·공백 없음)", () => {
  const rels = [
    "Card/a.md", "README.md", "a/README.md", "Card/2_business_layer/2-2.md", "카드사-입회-조건.md",
    "Card/카드사-입회-조건.md", "docs/Card Policy (v2).md", "x/y/z/깊은/경로/문서.md", nfd("카드/정책.md"),
    "My_Snake_Case__File.md", "UPPER/CASE/FILE.MD", "점.이.많은.파일.md", "--dash--/--x--.md",
  ];
  for (const rel of rels) assertValidName(wikiPathName("wiki-pm", rel), `wiki-pm × ${JSON.stringify(rel)}`);
});

test("§2.1.3 instance 에 대문자·밑줄·공백이 섞여도 이름은 글자 규칙을 지킨다", () => {
  assertValidName(wikiPathName("Wiki_PM 위키", "a/README.md"), "instance 'Wiki_PM 위키'");
});

test("§2.1.4 파일명이 같은 서로 다른 경로는 서로 다른 이름", () => {
  const groups: string[][] = [
    ["a/README.md", "b/README.md", "README.md", "a/b/README.md", "a-b/README.md", "a_b/README.md", "a b/README.md"],
    ["Card/카드사-입회-조건.md", "Ops/카드사-입회-조건.md", "카드사-입회-조건.md"],
  ];
  for (const g of groups) {
    const names = g.map((rel) => wikiPathName("wiki-pm", rel));
    assert.equal(new Set(names).size, g.length,
      `§2.1.4 같은 파일명·다른 경로는 이름이 모두 달라야 한다: ${JSON.stringify(g)} → ${JSON.stringify(names)}`);
  }
});

test("§2.1.5 같은 경로라도 instance 가 다르면 다른 이름", () => {
  for (const rel of ["a/README.md", "Card/카드사-입회-조건.md", "_.md"]) {
    assert.notEqual(wikiPathName("wiki-pm", rel), wikiPathName("wiki-dev", rel), `§2.1.5 instance 가 다르면 다른 이름: ${rel}`);
  }
});

test("§2.1.6 instance 가 이름 앞부분으로 읽힌다", () => {
  for (const rel of ["Card/a.md", "README.md", "Card/카드사-입회-조건.md", "docs/Onboarding-Guide.md"]) {
    const name = wikiPathName("wiki-pm", rel);
    assert.ok(name.startsWith("wiki-pm-"), `§2.1.6 instance wiki-pm → 'wiki-pm-' 로 시작해야 한다: ${rel} → ${name}`);
  }
});

test("§2.1.7 파일명(확장자 뺀)이 사람이 읽게 이름에 들어간다 — 영문은 소문자, 한글은 그대로", () => {
  const cases: Array<[string, string]> = [
    ["카드사-입회-조건.md", "카드사-입회-조건"],
    ["Card/카드사-입회-조건.md", "카드사-입회-조건"],
    [nfd("Card/카드사-입회-조건.md"), "카드사-입회-조건"],
    ["docs/Onboarding-Guide.md", "onboarding-guide"],
    ["a/README.md", "readme"],
    ["Card/Policy.md", "policy"],
  ];
  for (const [rel, piece] of cases) {
    const name = wikiPathName("wiki-pm", rel);
    assert.ok(name.includes(piece), `§2.1.7 ${JSON.stringify(rel)} 의 이름에 ${piece} 가 보여야 한다 → ${name}`);
  }
});

test("§2.1.8 파일명이 정규화하면 비어도 1~5 를 지키는 유효한 이름", () => {
  for (const rel of ["_.md", "___.md", "a/_.md", "b/_.md", "🚀.md", "x/(!).md"]) {
    const name = wikiPathName("wiki-pm", rel);
    assertValidName(name, `정규화하면 비는 파일명 ${JSON.stringify(rel)}`);
    assert.equal(wikiPathName("wiki-pm", rel), name, `§2.1.8/§2.1.1 결정적: ${rel}`);
    assert.notEqual(wikiPathName("wiki-dev", rel), name, `§2.1.8/§2.1.5 instance 가 다르면 다른 이름: ${rel}`);
  }
  for (const file of ["_.md", "___.md", "🚀.md"]) {
    assert.notEqual(wikiPathName("wiki-pm", `a/${file}`), wikiPathName("wiki-pm", `b/${file}`),
      `§2.1.8/§2.1.4 같은 파일명(${file})·다른 경로는 다른 이름`);
  }
});

test("§2.1.9 아주 긴 파일명·아주 긴 instance 에서도 64자·글자 규칙·경로 구별(2·3·4)", () => {
  const longKo = "긴".repeat(120) + ".md";
  const longEn = "word-".repeat(40) + "end.md";
  const longInst = "wiki-" + "instance".repeat(20);
  const deep = "deep/".repeat(30);
  const pairs: Array<[string, string, string]> = [
    ["wiki-pm", "a/" + longKo, "b/" + longKo],
    ["wiki-pm", "a/" + longEn, "b/" + longEn],
    [longInst, "a/README.md", "b/README.md"],
    [longInst, "a/" + longKo, "b/" + longKo],
    ["wiki-pm", deep + "a/README.md", deep + "b/README.md"],
    [longInst, deep + "a/" + longEn, deep + "b/" + longEn],
  ];
  for (const [inst, r1, r2] of pairs) {
    const n1 = wikiPathName(inst, r1);
    const n2 = wikiPathName(inst, r2);
    assertValidName(n1, `긴 입력(instance ${inst.length}자 × 경로 ${r1.length}자)`);
    assertValidName(n2, `긴 입력(instance ${inst.length}자 × 경로 ${r2.length}자)`);
    assert.notEqual(n1, n2, `§2.1.9/§2.1.4 긴 입력에서도 같은 파일명·다른 경로는 다른 이름: ${n1}`);
  }
});

// ═══════════════════════════════ §2.2 firstHeading ═══════════════════════════════

test("§2.2.1 코드펜스 밖의 첫 1단계 제목 — 없으면 null", () => {
  assert.equal(firstHeading("# 제목\n본문"), "제목", "§2.2.1 첫 줄 제목");
  assert.equal(firstHeading("서론\n\n# 진짜 제목\n\n# 둘째 제목"), "진짜 제목", "§2.2.1 첫 번째 1단계 제목");
  assert.equal(firstHeading("본문만 있다\n- 목록"), null, "§2.2.1 제목이 없으면 null");
  assert.equal(firstHeading(""), null, "§2.2.1 빈 글은 null");
});

test("§2.2.1·§2.2.6 펜스 안의 `# 주석` 은 제목이 아니다 — 같은 문자·그 이상 길이로만 닫힌다", () => {
  assert.equal(firstHeading("```\n# 주석\n```\n# 진짜"), "진짜", "§2.2.6 ``` 펜스 안의 # 은 제목 아님");
  assert.equal(firstHeading("```bash\n# 주석\necho hi\n```\n\n# 진짜"), "진짜", "§2.2.6 언어 표시가 붙은 펜스 안의 # 은 제목 아님");
  assert.equal(firstHeading("~~~\n# 주석\n~~~\n# 진짜"), "진짜", "§2.2.1 ~~~ 펜스");
  assert.equal(firstHeading("```\n# 주석\n```"), null, "§2.2.6 펜스 안에만 제목이 있으면 null");
  assert.equal(firstHeading("```\n# a\n`````\n# 진짜"), "진짜", "§2.2.1 같은 문자의 더 긴 줄로 닫힌다");
  assert.equal(firstHeading("````\n# a\n```\n# b\n````\n# 진짜"), "진짜", "§2.2.1 더 짧은 줄로는 닫히지 않는다");
  assert.equal(firstHeading("```\n# a\n~~~\n# b\n```\n# 진짜"), "진짜", "§2.2.1 다른 문자(~~~)로는 ``` 펜스가 닫히지 않는다");
  assert.equal(firstHeading("~~~\n# a\n```\n# b\n~~~\n# 진짜"), "진짜", "§2.2.1 다른 문자(```)로는 ~~~ 펜스가 닫히지 않는다");
  assert.equal(firstHeading("# 처음\n```\n# x\n```"), "처음", "§2.2.1 펜스 앞의 제목");
});

test("§2.2.2 `##` 는 1단계가 아니고 `#제목`(# 뒤 공백 없음)은 제목이 아니다", () => {
  assert.equal(firstHeading("## 둘째\n### 셋째"), null, "§2.2.2 ##·### 만 있으면 null");
  assert.equal(firstHeading("## 둘째\n# 첫째"), "첫째", "§2.2.2 ## 를 건너뛰고 # 를 찾는다");
  assert.equal(firstHeading("#제목\n본문"), null, "§2.2.2 #제목 은 제목 아님");
  assert.equal(firstHeading("#제목\n# 진짜"), "진짜", "§2.2.2 #제목 을 건너뛴다");
  assert.equal(firstHeading("#### 넷째"), null, "§2.2.2 #### 도 1단계 아님");
});

test("§2.2.3 링크는 글만 남기고, 굵게·코드 표시는 걷고, 낱개 밑줄은 남긴다", () => {
  assert.equal(firstHeading("# [카드 정책](https://example.com/a) 개요"), "카드 정책 개요", "§2.2.3 링크 → 글");
  assert.equal(firstHeading("# 개요: [입회](../a.md)와 [해지](b.md)"), "개요: 입회와 해지", "§2.2.3 링크 여러 개");
  assert.equal(firstHeading("# **굵게** 제목"), "굵게 제목", "§2.2.3 ** 표시 걷기");
  assert.equal(firstHeading("# __굵게__ 제목"), "굵게 제목", "§2.2.3 __ 표시 걷기");
  assert.equal(firstHeading("# `code` 설명"), "code 설명", "§2.2.3 ` 표시 걷기");
  assert.equal(firstHeading("# card_policy 정리"), "card_policy 정리", "§2.2.3 낱개 밑줄은 남긴다");
  assert.equal(firstHeading("# my_card_policy"), "my_card_policy", "§2.2.3 낱개 밑줄 여러 개도 남긴다");
  assert.equal(firstHeading("# **[카드](a.md)** 와 `x_y`"), "카드 와 x_y", "§2.2.3 섞인 표시");
});

test("§2.2.4 끝의 닫는 `#` 들과 앞뒤 공백은 빠진다", () => {
  assert.equal(firstHeading("# 제목 ##"), "제목", "§2.2.4 닫는 ##");
  assert.equal(firstHeading("# 제목 #"), "제목", "§2.2.4 닫는 #");
  assert.equal(firstHeading("#   제목   "), "제목", "§2.2.4 앞뒤 공백");
  assert.equal(firstHeading("# C# 언어"), "C# 언어", "§2.2.4 끝이 아닌 # 은 남는다");
});

test("§2.2.5 줄 끝이 CRLF 여도 같은 결과", () => {
  assert.equal(firstHeading("# 제목\r\n본문\r\n"), "제목", "§2.2.5 CRLF 첫 줄 제목");
  assert.equal(firstHeading("서론\r\n# 제목 ##\r\n"), "제목", "§2.2.5 CRLF + 닫는 #");
  assert.equal(firstHeading("```\r\n# 주석\r\n```\r\n# 진짜\r\n"), "진짜", "§2.2.5 CRLF 펜스");
  assert.equal(firstHeading("## 둘째\r\n#제목\r\n"), null, "§2.2.5 CRLF 에서도 ##·#제목 은 제목 아님");
});

// ═══════════════════════ §2.3 경로 링크 해소 (buildPathLinkTargets · pathBaseKey · normalizeWikiLinksByPath) ═══════════════════════

const NAMES: Record<string, string> = {
  "Card/a.md": "card-a",
  "Card/sub/b.md": "card-sub-b",
  "Card/c d.md": "card-c-d",
  "Card/카드.md": "card-카드",
  "Card/README.md": "card-readme",
  "Card/Ops/README.md": "card-ops-readme",
  "Ops/README.md": "ops-readme",
  "Card/카드사-입회-조건.md": "card-입회조건",
  "Policy/card_policy.md": "policy-card-policy",
  "Guide/b.md": "guide-b",
  "x.md": "root-x",
};
const RELS = Object.keys(NAMES);
const nameOf = (rel: string): string => NAMES[rel] ?? `unknown-${rel}`;
const NOTION_KEY = "notion-310746a5-e573-8002-a8e4-cc75b89ec108";
const T = buildPathLinkTargets(RELS, nameOf, new Set([NOTION_KEY]));
const L = (md: string, fromRel: string): string => normalizeWikiLinksByPath(md, fromRel, T);
const sorted = (xs: readonly string[] | undefined): string[] => [...(xs ?? [])].sort();

test("§2.3 buildPathLinkTargets: byPath 는 경로 → nameOf(경로), notion 은 주어진 집합", () => {
  for (const rel of RELS) assert.equal(T.byPath.get(rel), NAMES[rel], `§2.3 byPath.get(${rel}) = nameOf(${rel})`);
  assert.equal(T.byPath.get("Card/none.md"), undefined, "§2.3 rels 에 없는 경로는 byPath 에 없다");
  assert.equal(T.notion.has(NOTION_KEY), true, "§2.3 notion 집합을 그대로 담는다");
});

test("§2.3 buildPathLinkTargets: byBase 는 pathBaseKey(경로) → 그 파일명을 가진 이름들", () => {
  const readmes = ["card-ops-readme", "card-readme", "ops-readme"];
  assert.deepEqual(sorted(T.byBase.get("readme")), readmes, "§2.3 byBase readme → 셋");
  assert.deepEqual(sorted(T.byBase.get(pathBaseKey("Ops/README.md"))), readmes, "§2.3 byBase 키는 pathBaseKey(경로)");
  assert.deepEqual(sorted(T.byBase.get("b")), ["card-sub-b", "guide-b"], "§2.3 byBase b → 둘");
  assert.deepEqual(sorted(T.byBase.get("카드사-입회-조건")), ["card-입회조건"], "§2.3 byBase 한글 키");
  assert.deepEqual(sorted(T.byBase.get("card-policy")), ["policy-card-policy"], "§2.3 byBase card_policy.md → card-policy");
  assert.deepEqual(sorted(T.byBase.get("c-d")), ["card-c-d"], "§2.3 byBase 'c d.md' → c-d");
  assert.deepEqual(sorted(T.byBase.get("a")), ["card-a"], "§2.3 byBase a → 하나");
});

test("§2.3 pathBaseKey: 마지막 조각·.md 떼기·NFC 소문자·영숫자/한글 밖 덩어리는 하이픈 하나·양끝 하이픈 제거", () => {
  assert.equal(pathBaseKey("카드사 입회 조건"), "카드사-입회-조건", "§2.3 [[카드사 입회 조건]] 의 키");
  assert.equal(pathBaseKey("카드사-입회-조건.md"), "카드사-입회-조건", "§2.3 카드사-입회-조건.md 의 키");
  assert.equal(pathBaseKey("Card Policy"), "card-policy", "§2.3 [[Card Policy]] 의 키");
  assert.equal(pathBaseKey("card_policy.md"), "card-policy", "§2.3 card_policy.md 의 키");
  assert.equal(pathBaseKey("Policy/card_policy.md"), "card-policy", "§2.3 마지막 경로 조각만 본다");
  assert.equal(pathBaseKey("a/b/--Hello__World--.md"), "hello-world", "§2.3 덩어리는 하이픈 하나, 양끝 하이픈 제거");
  assert.equal(pathBaseKey(nfd("카드사 입회 조건.md")), "카드사-입회-조건", "§2.3 NFC 로 맞춘다");
  assert.equal(pathBaseKey("정책"), "정책", "§2.3 한글만 있는 이름도 빈 키가 아니다");
  assert.equal(pathBaseKey("x/README.md"), "readme", "§2.3 소문자");
  assert.equal(pathBaseKey("2-2.md"), "2-2", "§2.3 숫자·하이픈");
});

test("§2.3.1 상대 링크는 fromRel 의 폴더 기준으로 풀어 대상이면 내부 링크, 아니면 원문", () => {
  assert.equal(L("[A](../a.md)", "Card/sub/b.md"), "[A](#/k/card-a)", "§2.3.1 ../");
  assert.equal(L("[B](sub/b.md)", "Card/a.md"), "[B](#/k/card-sub-b)", "§2.3.1 하위 폴더");
  assert.equal(L("[B](./sub/b.md)", "Card/a.md"), "[B](#/k/card-sub-b)", "§2.3.1 ./");
  assert.equal(L("[R](README.md)", "Card/a.md"), "[R](#/k/card-readme)", "§2.3.1 같은 폴더의 README");
  assert.equal(L("[R](../Ops/README.md)", "Card/a.md"), "[R](#/k/ops-readme)", "§2.3.1 다른 폴더의 같은 파일명");
  assert.equal(L("[R](Ops/README.md)", "Card/a.md"), "[R](#/k/card-ops-readme)", "§2.3.1 fromRel 폴더 기준(Card/Ops)");
  assert.equal(L("[R](../Card/README.md)", "Ops/README.md"), "[R](#/k/card-readme)", "§2.3.1 Ops → Card");
  assert.equal(L("[A](Card/a.md)", "x.md"), "[A](#/k/card-a)", "§2.3.1 루트 문서에서");
  assert.equal(L("보라 [A](../a.md) 끝", "Card/sub/b.md"), "보라 [A](#/k/card-a) 끝", "§2.3.1 문장 속 링크");
  assert.equal(L("[없음](../nothing.md)", "Card/a.md"), "[없음](../nothing.md)", "§2.3.1 대상이 아니면 원문");
  assert.equal(L("[없음](missing.md)", "Card/a.md"), "[없음](missing.md)", "§2.3.1 대상이 아니면 원문");
  assert.equal(L("[A](a.md)", "Ops/README.md"), "[A](a.md)", "§2.3.1 폴더 기준으로 풀면 Ops/a.md — 대상이 아니면 원문(파일명만으로 찾지 않는다)");
});

test("§2.3.2 #앵커·?쿼리 는 풀 때 무시하고 바꾼 링크에 남지 않는다", () => {
  assert.equal(L("[A](../a.md#section)", "Card/sub/b.md"), "[A](#/k/card-a)", "§2.3.2 #앵커");
  assert.equal(L("[A](../a.md?plain=1)", "Card/sub/b.md"), "[A](#/k/card-a)", "§2.3.2 ?쿼리");
  assert.equal(L("[A](../a.md?x=1#y)", "Card/sub/b.md"), "[A](#/k/card-a)", "§2.3.2 ?쿼리#앵커");
});

test("§2.3.3 퍼센트 인코딩된 경로는 풀어서 찾는다", () => {
  assert.equal(L("[C](c%20d.md)", "Card/a.md"), "[C](#/k/card-c-d)", "§2.3.3 %20");
  assert.equal(L("[K](%EC%B9%B4%EB%93%9C.md)", "Card/a.md"), "[K](#/k/card-카드)", "§2.3.3 한글 인코딩");
  assert.equal(L("[K](../Card/%EC%B9%B4%EB%93%9C.md)", "Ops/README.md"), "[K](#/k/card-카드)", "§2.3.3 상대 경로 + 한글 인코딩");
});

test("§2.3.4 확장자 없는 링크는 .md 를 붙인 경로가 대상이면 그것으로 푼다", () => {
  assert.equal(L("[A](../a)", "Card/sub/b.md"), "[A](#/k/card-a)", "§2.3.4 ../a → ../a.md");
  assert.equal(L("[A](../a#h)", "Card/sub/b.md"), "[A](#/k/card-a)", "§2.3.4+§2.3.2 확장자 없음 + 앵커");
  assert.equal(L("[Z](../zzz)", "Card/sub/b.md"), "[Z](../zzz)", "§2.3.4 .md 를 붙여도 대상이 아니면 원문");
});

test("§2.3.5 `/` 로 시작하는 링크는 레포 루트 기준", () => {
  assert.equal(L("[A](/Card/a.md)", "Ops/README.md"), "[A](#/k/card-a)", "§2.3.5 /Card/a.md");
  assert.equal(L("[X](/x.md)", "Card/sub/b.md"), "[X](#/k/root-x)", "§2.3.5 /x.md");
  assert.equal(L("[N](/nope.md)", "Card/a.md"), "[N](/nope.md)", "§2.3.5 대상이 아니면 원문");
});

test("§2.3.6 레포 루트 밖으로 나가는 링크는 원문 그대로", () => {
  assert.equal(L("[X](../../x.md)", "Card/a.md"), "[X](../../x.md)", "§2.3.6 루트 밖(루트의 x.md 가 대상이어도)");
  assert.equal(L("[X](../../../x.md)", "Card/sub/b.md"), "[X](../../../x.md)", "§2.3.6 루트 밖");
  assert.equal(L("[X](../../x.md)", "Card/sub/b.md"), "[X](#/k/root-x)", "§2.3.6 대조: 루트 안에서 끝나면 바꾼다");
});

test("§2.3.7 스킴 링크·#앵커만 있는 링크·이미지는 원문 그대로", () => {
  const keep = [
    "[g](https://example.com/Card/a.md)",
    "[h](http://example.com/a.md)",
    "[m](mailto:kim@example.com)",
    "[f](ftp://example.com/a.md)",
    "[s](#section)",
    "![그림](a.md)",
    "![그림](sub/b.md)",
  ];
  for (const md of keep) assert.equal(L(md, "Card/a.md"), md, `§2.3.7 원문 그대로: ${md}`);
});

test("§2.3.8 노션 페이지 URL 은 t.notion 에 있으면 notion-<uuid> 내부 링크, 없으면 원문", () => {
  assert.equal(L("[N](https://www.notion.so/Some-Page-310746a5e5738002a8e4cc75b89ec108)", "Card/a.md"),
    "[N](#/k/notion-310746a5-e573-8002-a8e4-cc75b89ec108)", "§2.3.8 미러된 노션 페이지");
  const miss = "[M](https://www.notion.so/Other-Page-999999999999999999999999999999ff)";
  assert.equal(L(miss, "Card/a.md"), miss, "§2.3.8 미러 안 된 노션 페이지는 원문");
});

test("§2.3.9 [[경로꼴]] 은 현재 폴더 기준으로 먼저, 안 되면 루트 기준으로 푼다", () => {
  const linkTo = (name: string): RegExp => new RegExp(`^\\[[^\\]]+\\]\\(#/k/${name}\\)$`);
  assert.match(L("[[sub/b]]", "Card/a.md"), linkTo("card-sub-b"), "§2.3.9 현재 폴더 기준");
  assert.match(L("[[sub/b.md]]", "Card/a.md"), linkTo("card-sub-b"), "§2.3.9 .md 붙은 경로꼴");
  assert.match(L("[[Card/a]]", "Ops/README.md"), linkTo("card-a"), "§2.3.9 현재 폴더(Ops/Card/a)에 없으면 루트 기준");
  assert.match(L("[[Card/sub/b]]", "Card/a.md"), linkTo("card-sub-b"), "§2.3.9 Card/Card/sub/b 가 없으면 루트 기준");
  assert.match(L("[[Ops/README]]", "Card/a.md"), linkTo("card-ops-readme"), "§2.3.9 현재 폴더(Card/Ops)가 루트(Ops)보다 먼저");
  assert.match(L("[[Ops/README.md]]", "x.md"), linkTo("ops-readme"), "§2.3.9 루트 문서에서");
  assert.equal(L("[[sub/b|하위 문서]]", "Card/a.md"), "[하위 문서](#/k/card-sub-b)", "§2.3.9 경로꼴 + 표시글");
  assert.ok(!L("[[nope/zz]]", "Card/a.md").includes("#/k/"), "§2.3.9 풀리지 않는 경로꼴은 내부 링크가 되지 않는다");
});

test("§2.3.9 [[이름]] 은 파일명 키를 가진 대상이 정확히 하나일 때만 링크, 둘 이상·없으면 평문", () => {
  assert.equal(L("[[카드사 입회 조건]]", "Card/a.md"), "[카드사 입회 조건](#/k/card-입회조건)", "§2.3.9 한글 이름 → 유일한 대상");
  assert.equal(L("[[Card Policy]]", "Ops/README.md"), "[Card Policy](#/k/policy-card-policy)", "§2.3.9 Card Policy ≡ card_policy.md");
  assert.equal(L("[[a]]", "Card/sub/b.md"), "[a](#/k/card-a)", "§2.3.9 유일한 대상");
  assert.equal(L("[[README]]", "x.md"), "README", "§2.3.9 같은 키 셋 → 평문");
  assert.equal(L("[[b]]", "x.md"), "b", "§2.3.9 같은 키 둘 → 평문");
  assert.equal(L("[[README]]", "Card/a.md"), "README", "§2.3.9 이름만이면 같은 폴더에 README 가 있어도 키가 여럿이면 평문");
  assert.equal(L("[[없는 문서]]", "Card/a.md"), "없는 문서", "§2.3.9 대상이 없으면 평문");
  assert.equal(L("앞 [[없는 문서]] 뒤", "Card/a.md"), "앞 없는 문서 뒤", "§2.3.9 문장 속 평문");
});

test("§2.3.9 [[이름|표시글]] 은 표시글을 쓴다", () => {
  assert.equal(L("[[카드사 입회 조건|입회 조건]]", "Card/a.md"), "[입회 조건](#/k/card-입회조건)", "§2.3.9 링크의 표시글");
  assert.equal(L("[[README|읽어보기]]", "x.md"), "읽어보기", "§2.3.9 여럿이면 평문 표시글");
  assert.equal(L("[[없는 문서|보기]]", "Card/a.md"), "보기", "§2.3.9 없으면 평문 표시글");
});

test("§2.3.10 코드펜스 안·인라인 코드 안은 절대 바꾸지 않는다", () => {
  const fenced = "```\n[A](../a.md)\n[[카드사 입회 조건]]\n[N](https://www.notion.so/Some-Page-310746a5e5738002a8e4cc75b89ec108)\n```";
  assert.equal(L(fenced, "Card/sub/b.md"), fenced, "§2.3.10 펜스 안은 그대로");
  const inline = "보기 `[A](../a.md)` 와 `[[카드사 입회 조건]]` 끝";
  assert.equal(L(inline, "Card/sub/b.md"), inline, "§2.3.10 인라인 코드 안은 그대로");
  assert.equal(L("[A](../a.md) 그리고 `[A](../a.md)`", "Card/sub/b.md"), "[A](#/k/card-a) 그리고 `[A](../a.md)`",
    "§2.3.10 코드 밖만 바꾼다");
  assert.equal(L("```\n[A](../a.md)\n```\n[A](../a.md)", "Card/sub/b.md"), "```\n[A](../a.md)\n```\n[A](#/k/card-a)",
    "§2.3.10 펜스가 닫힌 뒤는 바꾼다");
});

// ═══════════════════════════════ §3 민감정보 가리기 ═══════════════════════════════

const kindsOf = (s: ReadonlySet<string>): string[] => [...s].sort();
const ALL4 = ["bizno", "email", "phone", "rrn"];
const K = (...kinds: MaskKind[]): Set<MaskKind> => new Set<MaskKind>(kinds);
const counts = (r: { masked: Record<MaskKind, number> }): Record<MaskKind, number> =>
  ({ phone: r.masked.phone, email: r.masked.email, bizno: r.masked.bizno, rrn: r.masked.rrn });

test("§3.1 parseMaskKinds: 쉼표·공백 구분, 대소문자 무시, all, 모르는 낱말이면 전부(개정), 빈 값", () => {
  assert.deepEqual(kindsOf(parseMaskKinds(null)), [], "§3.1 null → 빈 집합");
  assert.deepEqual(kindsOf(parseMaskKinds(undefined)), [], "§3.1 undefined → 빈 집합");
  assert.deepEqual(kindsOf(parseMaskKinds("")), [], "§3.1 빈 문자열 → 빈 집합");
  assert.deepEqual(kindsOf(parseMaskKinds("   ")), [], "§3.1 공백뿐 → 빈 집합");
  assert.deepEqual(kindsOf(parseMaskKinds("phone,email")), ["email", "phone"], "§3.1 쉼표 구분");
  assert.deepEqual(kindsOf(parseMaskKinds("PHONE  Email")), ["email", "phone"], "§3.1 공백 구분·대소문자 무시");
  assert.deepEqual(kindsOf(parseMaskKinds("phone, bizno rrn")), ["bizno", "phone", "rrn"], "§3.1 쉼표+공백 섞임");
  assert.deepEqual(kindsOf(parseMaskKinds("all")), ALL4, "§3.1 all → 네 종류");
  assert.deepEqual(kindsOf(parseMaskKinds("ALL")), ALL4, "§3.1 ALL(대소문자 무시) → 네 종류");
  assert.deepEqual(kindsOf(parseMaskKinds("all, foo")), ALL4, "§3.1 all + 모르는 낱말");
  //  2026-11-04 개정(리뷰 차단 지적) — 개인정보 옵션이라 오타가 가리기를 끄면 안 된다: 모르는 낱말이 있으면 네 종류 전부.
  assert.deepEqual(kindsOf(parseMaskKinds("foo, bar")), ALL4, "§3.1(개정) 모르는 낱말만 → 네 종류 전부(오류 없음)");
  assert.deepEqual(kindsOf(parseMaskKinds("phone,unknown")), ALL4, "§3.1(개정) 모르는 낱말이 섞이면 → 네 종류 전부");
  assert.deepEqual(kindsOf(parseMaskKinds("phones")), ALL4, "§3.1(개정) 오타(phones) → 네 종류 전부");
  assert.deepEqual(kindsOf(parseMaskKinds("e-mail")), ALL4, "§3.1(개정) 오타(e-mail) → 네 종류 전부");
});

test("§3.1(개정) unknownMaskWords: 모르는 낱말만 소문자로", () => {
  assert.deepEqual(unknownMaskWords(""), [], "§3.1 빈 값 → 없음");
  assert.deepEqual(unknownMaskWords("phone, ALL email"), [], "§3.1 아는 낱말·all 만 → 없음");
  assert.deepEqual(unknownMaskWords("Phones, email e-mail"), ["phones", "e-mail"], "§3.1 모르는 낱말만 · 소문자");
});

test("§3.2·§3.3 고른 종류만 가린다 — 표식과 종류별 개수(안 가린 종류는 0), 빈 집합이면 그대로", () => {
  const text = "전화 010-1234-5678 메일 kim@corp.io";
  const onlyPhone = maskSensitive(text, K("phone"));
  assert.equal(onlyPhone.text, "전화 [전화번호] 메일 kim@corp.io", "§3.3 phone 만 가린다");
  assert.deepEqual(counts(onlyPhone), { phone: 1, email: 0, bizno: 0, rrn: 0 }, "§3.2 phone 1, 나머지 0");
  const onlyEmail = maskSensitive(text, K("email"));
  assert.equal(onlyEmail.text, "전화 010-1234-5678 메일 [이메일]", "§3.3 email 만 가린다");
  assert.deepEqual(counts(onlyEmail), { phone: 0, email: 1, bizno: 0, rrn: 0 }, "§3.2 email 1, 나머지 0");
  const none = maskSensitive(text, new Set<MaskKind>());
  assert.equal(none.text, text, "§3.3 빈 집합이면 글을 그대로");
  assert.deepEqual(counts(none), { phone: 0, email: 0, bizno: 0, rrn: 0 }, "§3.2 빈 집합이면 전부 0");
});

test("§3.2 종류별 표식", () => {
  assert.equal(maskSensitive("a 010-1234-5678 b", K("phone")).text, "a [전화번호] b", "§3.2 phone 표식");
  assert.equal(maskSensitive("a kim@corp.io b", K("email")).text, "a [이메일] b", "§3.2 email 표식");
  assert.equal(maskSensitive("a 123-45-67890 b", K("bizno")).text, "a [사업자번호] b", "§3.2 bizno 표식");
  assert.equal(maskSensitive("a 900101-1234567 b", K("rrn")).text, "a [주민·법인번호] b", "§3.2 rrn 표식");
});

test("§3.4 phone — 휴대폰·유선 꼴은 가린다", () => {
  const phones = [
    "010-1234-5678", "010.1234.5678", "010 1234 5678", "01012345678", "011-123-4567",
    "02-123-4567", "031-1234-5678", "070-1234-5678", "0505-123-4567",
  ];
  for (const p of phones) {
    const r = maskSensitive(`연락처 ${p} 로`, K("phone"));
    assert.equal(r.text, "연락처 [전화번호] 로", `§3.4 가린다: ${p}`);
    assert.equal(r.masked.phone, 1, `§3.4 개수 1: ${p}`);
  }
});

test("§3.4 phone — 국가번호 +82 꼴도 가린다", () => {
  const r = maskSensitive("번호 +82-10-1234-5678 끝", K("phone"));
  assert.equal(r.masked.phone, 1, "§3.4 +82-10-1234-5678 개수 1");
  assert.ok(r.text.includes("[전화번호]"), `§3.4 +82 꼴에 표식: ${r.text}`);
  assert.ok(!r.text.includes("82-10") && !r.text.includes("1234") && !r.text.includes("5678"), `§3.4 번호가 남지 않는다: ${r.text}`);
  assert.ok(r.text.startsWith("번호 ") && r.text.endsWith(" 끝"), `§3.4 앞뒤 글은 그대로: ${r.text}`);
});

test("§3.4 phone — 가리지 않는 것: 구분자 없는 유선꼴·대표번호·금액·날짜·버전", () => {
  for (const s of ["0212345678", "1588-1234", "1,234,567", "2026-11-04", "v2.6.3"]) {
    const text = `값 ${s} 끝`;
    const r = maskSensitive(text, K("phone"));
    assert.equal(r.text, text, `§3.4 안 가린다: ${s}`);
    assert.equal(r.masked.phone, 0, `§3.4 개수 0: ${s}`);
  }
});

test("§3.4 phone — 한 글의 여러 번호는 각각 가리고 센다", () => {
  const r = maskSensitive("a 010-1234-5678 b 02-123-4567 c", K("phone"));
  assert.equal(r.text, "a [전화번호] b [전화번호] c", "§3.4 두 번호 모두 가린다");
  assert.equal(r.masked.phone, 2, "§3.4 개수 2");
});

test("§3.5 bizno — 3-2-5 꼴, 앞뒤에 숫자가 더 붙으면 사업자번호로 가리지 않는다", () => {
  const r = maskSensitive("사업자 123-45-67890 입니다", K("bizno"));
  assert.equal(r.text, "사업자 [사업자번호] 입니다", "§3.5 가린다");
  assert.equal(r.masked.bizno, 1, "§3.5 개수 1");
  for (const s of ["1123-45-67890", "123-45-678901"]) {
    const text = `번호 ${s} 끝`;
    const n = maskSensitive(text, K("bizno"));
    assert.equal(n.text, text, `§3.5 숫자가 더 붙으면 안 가린다: ${s}`);
    assert.equal(n.masked.bizno, 0, `§3.5 개수 0: ${s}`);
  }
});

test("§3.6 rrn — 6-7 꼴, 앞뒤에 숫자가 더 붙으면 가리지 않는다", () => {
  const r = maskSensitive("주민 900101-1234567 끝", K("rrn"));
  assert.equal(r.text, "주민 [주민·법인번호] 끝", "§3.6 가린다");
  assert.equal(r.masked.rrn, 1, "§3.6 개수 1");
  for (const s of ["1900101-1234567", "900101-12345678"]) {
    const text = `번호 ${s} 끝`;
    const n = maskSensitive(text, K("rrn"));
    assert.equal(n.text, text, `§3.6 숫자가 더 붙으면 안 가린다: ${s}`);
    assert.equal(n.masked.rrn, 0, `§3.6 개수 0: ${s}`);
  }
});

test("§3.7 email — 주소 전체를 가린다", () => {
  const r = maskSensitive("문의는 first.last+tag@corp.io 로 주세요", K("email"));
  assert.equal(r.text, "문의는 [이메일] 로 주세요", "§3.7 주소 전체를 가린다");
  assert.equal(r.masked.email, 1, "§3.7 개수 1");
  assert.equal(maskSensitive("메일 kim@example.com 끝", K("email")).text, "메일 [이메일] 끝", "§3.7 keep 목록이 없으면 가린다");
});

test("§3.7 email — keepEmailDomains 와 같거나 하위 도메인이면 남긴다(대소문자 무시, 앞 @ 무시)", () => {
  const keep = ["example.com"];
  for (const addr of ["kim@example.com", "kim@a.example.com", "kim@a.b.example.com", "kim@EXAMPLE.COM", "kim@Sub.Example.Com"]) {
    const text = `메일 ${addr} 끝`;
    const k = maskSensitive(text, K("email"), keep);
    assert.equal(k.text, text, `§3.7 남긴다: ${addr}`);
    assert.equal(k.masked.email, 0, `§3.7 남긴 것은 세지 않는다: ${addr}`);
  }
  for (const addr of ["kim@notexample.com", "kim@example.org", "kim@example.com.evil.io"]) {
    const k = maskSensitive(`메일 ${addr} 끝`, K("email"), keep);
    assert.equal(k.text, "메일 [이메일] 끝", `§3.7 하위 도메인이 아니면 가린다: ${addr}`);
    assert.equal(k.masked.email, 1, `§3.7 개수 1: ${addr}`);
  }
  assert.equal(maskSensitive("메일 kim@example.com 끝", K("email"), ["@example.com"]).text, "메일 kim@example.com 끝",
    "§3.7 keep 항목 앞의 @ 는 무시");
  assert.equal(maskSensitive("메일 kim@a.example.com 끝", K("email"), ["Example.COM"]).text, "메일 kim@a.example.com 끝",
    "§3.7 keep 항목 대소문자 무시");
});

test("§3.8 한 글 안에 여러 종류가 섞여도 각각 가리고 센다", () => {
  const text = "전화 010-9876-5432, 031-1234-5678 / 메일 kim@corp.io / 사업자 220-81-12345 / 주민 850315-2345678 / 대표 1588-1234";
  const r = maskSensitive(text, parseMaskKinds("all"));
  assert.equal(r.text,
    "전화 [전화번호], [전화번호] / 메일 [이메일] / 사업자 [사업자번호] / 주민 [주민·법인번호] / 대표 1588-1234",
    "§3.8 종류마다 가린다");
  assert.deepEqual(counts(r), { phone: 2, email: 1, bizno: 1, rrn: 1 }, "§3.8 종류별 개수");
});

// ═══════════════════════════════ §4 수집기 순수 함수 ═══════════════════════════════

test("§4.1 selectMarkdown: inScope 와 같은 판정, 입력 순서 유지, 둘 다 비면 새 배열", () => {
  const rels = ["b.md", "a/x.md", "docs/c.md", "docs/private/d.md", "README.md", "z/README.md"];
  const before = [...rels];
  const all = selectMarkdown(rels, [], []);
  assert.deepEqual(all, rels, "§4.1 include·exclude 둘 다 비면 입력과 같은 내용");
  assert.notEqual(all, rels, "§4.1 include·exclude 둘 다 비면 새 배열");
  assert.deepEqual(selectMarkdown(rels, ["docs/"], []), ["docs/c.md", "docs/private/d.md"], "§4.1 include 만");
  assert.deepEqual(selectMarkdown(rels, [], ["docs/private/"]), ["b.md", "a/x.md", "docs/c.md", "README.md", "z/README.md"],
    "§4.1 exclude 만");
  assert.deepEqual(selectMarkdown(rels, ["docs/", "README.md"], ["**/private/**", "z/"]), ["docs/c.md", "README.md"],
    "§4.1 exclude 가 이긴다");
  assert.deepEqual(selectMarkdown(["z.md", "a.md", "m/x.md"], ["*.md"], []), ["z.md", "a.md", "m/x.md"], "§4.1 입력 순서를 지킨다(정렬하지 않음)");
  assert.deepEqual(selectMarkdown(rels, ["nothing/"], []), [], "§4.1 include 에 하나도 안 맞으면 빈 배열");
  assert.deepEqual(rels, before, "§4.1 입력 배열은 바뀌지 않는다");
  assert.equal(selectMarkdown([nfd("카드/a.md")], [nfc("카드/")], []).length, 1, "§4.1+§1.10 NFC/NFD 와 무관한 판정");
});

test("§4.2 parseGitLogTimes: 경로마다 처음 만난(최신) 커밋 시각 · 머리 앞/빈 줄 무시 · C 따옴표 풀기 · NFC 키", () => {
  const SOH = "\x01";
  const T1 = "2026-11-03T10:00:00+09:00";
  const T2 = "2026-11-02T09:00:00+09:00";
  const T3 = "2026-11-01T08:00:00+09:00";
  const out = [
    "머리 앞 줄은 무시",
    `${SOH}${T1}`, "", "docs/a.md", "docs/b c.md", '"a\\tb.md"', "",
    `${SOH}${T2}`, "", "docs/a.md", "c.md", '"\\"q\\".md"', '"back\\\\slash.md"', '"\\354\\271\\264\\353\\223\\234.md"',
    nfd("한글/정책.md"), "",
    `${SOH}${T3}`, "", "c.md", "d.md", "",
  ].join("\n");
  const map = parseGitLogTimes(out);
  const at = (key: string, item: string): number => {
    const v = map.get(key);
    if (v === undefined) assert.fail(`${item}: 키 ${JSON.stringify(key)} 가 있어야 한다 (keys=${JSON.stringify([...map.keys()])})`);
    return Date.parse(v);
  };
  assert.equal(at("docs/a.md", "§4.2"), Date.parse(T1), "§4.2 처음 만난(최신) 커밋 시각");
  assert.equal(at("docs/b c.md", "§4.2"), Date.parse(T1), "§4.2 공백 든 경로");
  assert.equal(at("c.md", "§4.2"), Date.parse(T2), "§4.2 더 오래된 커밋이 덮어쓰지 않는다");
  assert.equal(at("d.md", "§4.2"), Date.parse(T3), "§4.2 마지막 커밋의 경로");
  assert.equal(at("a\tb.md", "§4.2 C 따옴표 \\t"), Date.parse(T1), "§4.2 \"a\\tb.md\" → 탭");
  assert.equal(at('"q".md', "§4.2 C 따옴표 \\\""), Date.parse(T2), "§4.2 \"\\\"q\\\".md\" → \"q\".md");
  assert.equal(at("back\\slash.md", "§4.2 C 따옴표 \\\\"), Date.parse(T2), "§4.2 \"back\\\\slash.md\" → back\\slash.md");
  assert.equal(at("카드.md", "§4.2 C 따옴표 8진수 UTF-8"), Date.parse(T2), "§4.2 8진수 UTF-8 → 카드.md");
  assert.equal(at(nfc("한글/정책.md"), "§4.2 NFC 키"), Date.parse(T2), "§4.2 NFD 로 온 경로의 키는 NFC");
  assert.equal(map.has(nfd("한글/정책.md")), false, "§4.2 NFD 키는 없다");
  assert.equal(map.has("머리 앞 줄은 무시"), false, "§4.2 첫 커밋 머리 앞의 줄은 무시");
  assert.equal(map.has(""), false, "§4.2 빈 줄은 무시");
  assert.equal(map.size, 9, `§4.2 경로 9개만 (keys=${JSON.stringify([...map.keys()])})`);
  assert.equal(parseGitLogTimes("").size, 0, "§4.2 빈 출력 → 빈 Map");
});

const BASE = "https://git.example.com/pm/wiki/-/blob/main";

test("§4.3 blobUrl: base 가 비면 undefined, 아니면 base/경로 — 조각마다 퍼센트 인코딩, 조각 사이 / 는 그대로", () => {
  assert.equal(blobUrl("", "a.md"), undefined, "§4.3 빈 base → undefined");
  assert.equal(blobUrl(BASE, "Card/2_business_layer/2-2.md"), `${BASE}/Card/2_business_layer/2-2.md`, "§4.3 base + / + 경로");
  assert.equal(blobUrl(BASE, "a/b/c.md"), `${BASE}/a/b/c.md`, "§4.3 조각 사이 / 는 그대로");
  assert.equal(blobUrl(BASE, "docs/a b.md"), `${BASE}/docs/a%20b.md`, "§4.3 공백 → %20");
  assert.equal(blobUrl(BASE, "카드/정책.md"), `${BASE}/%EC%B9%B4%EB%93%9C/%EC%A0%95%EC%B1%85.md`, "§4.3 한글 인코딩");
  assert.equal(blobUrl(BASE, "docs/C# 노트.md"), `${BASE}/docs/C%23%20%EB%85%B8%ED%8A%B8.md`, "§4.3 # → %23");
});

type PathArgs = Parameters<typeof toRawItemPath>[0];
const mk = (a: Partial<PathArgs> & { relpath: string; raw: string }) =>
  toRawItemPath({ instance: "wiki-pm", baseUrl: BASE, ...a }, T);
function dwOf(it: { fields?: Record<string, unknown> }, item: string): Record<string, unknown> {
  const fd = it.fields?.domain_wiki;
  if (fd === null || typeof fd !== "object") assert.fail(`${item}: fields.domain_wiki 는 객체여야 한다`);
  return fd as Record<string, unknown>;
}

test("§4.4 toRawItemPath: type·provenance·name_hint·path·제목·본문·시각·fields 기본 칸", () => {
  const committedAt = "2026-11-03T10:00:00+09:00";
  const raw = "---\ntitle: 카드 입회 정책\ncode_sot: acme/api/card\nsource_sot: notion/카드정책\n---\n"
    + "# 본문 제목\n입회는 [하위](sub/b.md) 와 [[카드사 입회 조건]] 참고";
  const it = mk({ relpath: "Card/a.md", raw, mtime: "2026-10-01T00:00:00Z", committedAt });
  assert.equal(it.type, "doc", "§4.4 type 은 doc");
  assert.equal(it.provenance.system, "domain-wiki", "§4.4 provenance.system");
  assert.equal(it.provenance.instance, "wiki-pm", "§4.4 provenance.instance = args.instance");
  assert.equal(it.provenance.external_id, "Card/a.md", "§4.4 provenance.external_id = relpath");
  assert.equal(it.provenance.external_url, `${BASE}/Card/a.md`, "§4.4 provenance.external_url = blobUrl(baseUrl, relpath)");
  assert.equal(it.provenance.external_url, blobUrl(BASE, "Card/a.md"), "§4.4 external_url 은 blobUrl 과 같다");
  assert.equal(it.name_hint, "card-a", "§4.4 targets.byPath 에 있으면 그 이름");
  assert.equal(it.path, "Card/a.md", "§4.4 path = relpath");
  assert.equal(it.title, "카드 입회 정책", "§4.4 제목은 프론트매터 title 이 먼저");
  assert.equal(it.body, "# 본문 제목\n입회는 [하위](#/k/card-sub-b) 와 [카드사 입회 조건](#/k/card-입회조건) 참고",
    "§4.4 본문 = 프론트매터를 뺀 본문 + §2.3 링크 해소");
  assert.equal(Date.parse(it.occurred_at ?? ""), Date.parse(committedAt), "§4.4 occurred_at 은 committedAt 이 먼저");
  assert.equal(Date.parse(it.updated_at ?? ""), Date.parse(committedAt), "§4.4 updated_at 은 committedAt 이 먼저");
  const fd = dwOf(it, "§4.4");
  assert.equal(fd.relpath, "Card/a.md", "§4.4 fields.domain_wiki.relpath");
  assert.equal(fd.id_mode, "path", "§4.4 fields.domain_wiki.id_mode = path");
  assert.equal(fd.code_sot, "acme/api/card", "§4.4 fields.domain_wiki.code_sot = code_sot 줄 값");
  assert.equal(fd.source_sot, "notion/카드정책", "§4.4 fields.domain_wiki.source_sot = source_sot 줄 값");
  assert.equal(Date.parse(String(fd.committed_at)), Date.parse(committedAt), "§4.4 committedAt 이 있으면 committed_at");
  assert.equal(fd.masked, undefined, "§4.4 mask 가 없으면 masked 없음");
});

test("§4.4 toRawItemPath: NFD 경로는 NFC 로, byPath 에 없으면 wikiPathName, 제목은 본문 첫 1단계 제목, 시각은 mtime", () => {
  const relN = nfc("새 폴더/카드 정책.md");
  const mtime = "2026-10-01T00:00:00Z";
  const it = mk({ relpath: nfd(relN), raw: "서론\n```\n# 주석\n```\n# **카드** 정책\n본문", mtime });
  assert.equal(it.provenance.external_id, relN, "§4.4 external_id 는 NFC");
  assert.equal(it.path, relN, "§4.4 path 는 NFC");
  assert.equal(it.name_hint, wikiPathName("wiki-pm", relN), "§4.4 byPath 에 없으면 wikiPathName(instance, relpath)");
  assert.equal(it.title, "카드 정책", "§4.4 프론트매터 title 이 없으면 본문 첫 1단계 제목(§2.2 — 펜스 밖·표시 걷기)");
  assert.equal(Date.parse(it.occurred_at ?? ""), Date.parse(mtime), "§4.4 committedAt 이 없으면 occurred_at = mtime");
  assert.equal(Date.parse(it.updated_at ?? ""), Date.parse(mtime), "§4.4 committedAt 이 없으면 updated_at = mtime");
  const url = it.provenance.external_url ?? "";
  assert.ok(url.startsWith(`${BASE}/`), `§4.4 external_url 은 baseUrl 아래: ${url}`);
  assert.equal(nfc(decodeURIComponent(url.slice(BASE.length + 1))), relN, "§4.4 external_url 은 그 경로의 blob 주소");
  const fd = dwOf(it, "§4.4");
  assert.equal(fd.id_mode, "path", "§4.4 id_mode = path");
  assert.equal(fd.committed_at, undefined, "§4.4 committedAt 이 없으면 committed_at 없음");
  assert.equal(fd.code_sot ?? null, null, "§4.4 code_sot 줄이 없으면 없음");
  assert.equal(fd.source_sot ?? null, null, "§4.4 source_sot 줄이 없으면 없음");
});

test("§4.4 toRawItemPath: 제목 순서 — 프론트매터 title → 본문 첫 1단계 제목 → 확장자 뺀 relpath", () => {
  assert.equal(mk({ relpath: "Card/2_business_layer/2-2.md", raw: "제목 없는 본문\n## 둘째 단계만" }).title,
    "Card/2_business_layer/2-2", "§4.4 제목이 없으면 확장자 뺀 relpath");
  assert.equal(mk({ relpath: "Card/2_business_layer/2-2.md", raw: "---\ncode_sot: x/y\n---\n본문" }).title,
    "Card/2_business_layer/2-2", "§4.4 프론트매터에 title 이 없고 본문 제목도 없으면 확장자 뺀 relpath");
  assert.equal(mk({ relpath: "Card/a.md", raw: "---\ncode_sot: x/y\n---\n# 머리\n본문" }).title, "머리",
    "§4.4 프론트매터에 title 이 없으면 본문 첫 1단계 제목");
});

test("§4.4 toRawItemPath: 빈 본문이면 body 없음", () => {
  const a = mk({ relpath: "Card/a.md", raw: "---\ntitle: 빈 문서\n---\n" });
  assert.equal(a.body, undefined, "§4.4 프론트매터만 있으면 body 없음");
  assert.equal(a.title, "빈 문서", "§4.4 제목은 프론트매터 title");
  const b = mk({ relpath: "Ops/empty.md", raw: "" });
  assert.equal(b.body, undefined, "§4.4 빈 원문이면 body 없음");
  assert.equal(b.title, "Ops/empty", "§4.4 빈 원문의 제목은 확장자 뺀 relpath");
});

test("§4.4 toRawItemPath: baseUrl 이 비면 external_url 없음, committedAt 만 있어도 시각이 들어간다", () => {
  const committedAt = "2026-11-03T10:00:00+09:00";
  const it = mk({ relpath: "Card/a.md", raw: "x", baseUrl: "", committedAt });
  assert.equal(it.provenance.external_url, undefined, "§4.4+§4.3 빈 baseUrl → external_url 없음");
  assert.equal(Date.parse(it.occurred_at ?? ""), Date.parse(committedAt), "§4.4 committedAt → occurred_at");
  assert.equal(Date.parse(it.updated_at ?? ""), Date.parse(committedAt), "§4.4 committedAt → updated_at");
});

test("§4.4 toRawItemPath: mask 는 제목·본문 모두 가리고(keepEmailDomains 반영) masked 는 종류별 합(0 인 종류는 빠짐)", () => {
  const raw = "---\ntitle: 담당 010-1234-5678\n---\n연락 010-9876-5432, kim@corp.io, lee@keep.example.com";
  const it = mk({ relpath: "Ops/README.md", raw, mask: K("phone", "email"), maskKeepEmailDomains: ["example.com"] });
  assert.equal(it.title, "담당 [전화번호]", "§4.4 제목도 가린다");
  assert.equal(it.body, "연락 [전화번호], [이메일], lee@keep.example.com", "§4.4 본문을 가리고 keep 도메인은 남긴다");
  assert.deepEqual(dwOf(it, "§4.4").masked, { phone: 2, email: 1 }, "§4.4 masked = 제목·본문 합, 0 인 종류는 빠진다");
});

test("§4.4 toRawItemPath: 본문 첫 제목에서 온 제목도 가린다", () => {
  const it = mk({ relpath: "Card/a.md", raw: "# 문의 help@corp.io\n본문", mask: K("email") });
  assert.equal(it.title, "문의 [이메일]", "§4.4 본문 제목에서 온 제목도 가린다");
  assert.equal(it.body, "# 문의 [이메일]\n본문", "§4.4 본문도 가린다");
  const masked = dwOf(it, "§4.4").masked as Record<string, number> | undefined;
  assert.deepEqual(Object.keys(masked ?? {}), ["email"], "§4.4 masked 에는 가린 종류(email)만");
  assert.ok((masked?.email ?? 0) >= 1, "§4.4 masked.email 은 1 이상");
});

test("§4.4 toRawItemPath: 가린 것이 없거나 mask 가 없으면 masked 없음·원문 유지", () => {
  const a = mk({ relpath: "Card/a.md", raw: "# 제목\n민감정보 없음", mask: parseMaskKinds("all") });
  assert.equal(a.body, "# 제목\n민감정보 없음", "§4.4 가릴 것이 없으면 본문 그대로");
  assert.equal(dwOf(a, "§4.4").masked, undefined, "§4.4 가린 것이 없으면 masked 없음");
  const b = mk({ relpath: "Card/a.md", raw: "연락 010-1234-5678" });
  assert.equal(b.body, "연락 010-1234-5678", "§4.4 mask 가 없으면 가리지 않는다");
  assert.equal(dwOf(b, "§4.4").masked, undefined, "§4.4 mask 가 없으면 masked 없음");
});

test("§4.5 슬러그 모드 toRawItem 은 종전 그대로 — external_id 는 basename 의 wikiSlug, 제목은 title 또는 슬러그, id_mode 없음", () => {
  const stem = "Savings-Bank-Operations";
  // 사양은 «파일 basename 의 wikiSlug» — basename 에 .md 를 포함하는지는 사양이 못박지 않아 두 꼴을 다 받는다.
  const candidates = [wikiSlug(stem), wikiSlug(`${stem}.md`)];
  const base = { mtime: "2026-10-01T00:00:00Z", instance: "wiki-pm", baseUrl: BASE };
  const a = toRawItem({ ...base, relpath: `domain/baas/${stem}.md`, raw: "본문만" }, new Set<string>());
  assert.ok(candidates.includes(a.provenance.external_id), `§4.5 external_id 는 basename 의 wikiSlug: ${a.provenance.external_id}`);
  assert.ok(!a.provenance.external_id.includes("/"), "§4.5 external_id 에 경로가 들어가지 않는다");
  assert.equal(a.title, a.provenance.external_id, "§4.5 프론트매터 title 이 없으면 제목 = 슬러그");
  const slugFd = a.fields?.domain_wiki as Record<string, unknown> | undefined;
  assert.equal(slugFd?.id_mode, undefined, "§4.5 슬러그 모드의 fields.domain_wiki 에는 id_mode 가 없다");
  const b = toRawItem({ ...base, relpath: `domain/baas/${stem}.md`, raw: "---\ntitle: 저축은행 운영\n---\n본문" }, new Set<string>());
  assert.equal(b.title, "저축은행 운영", "§4.5 프론트매터 title 이 있으면 그것");
  assert.equal(b.provenance.external_id, a.provenance.external_id, "§4.5 external_id 는 원문과 무관(basename 만)");
  const r1 = toRawItem({ ...base, relpath: "a/README.md", raw: "x" }, new Set<string>());
  const r2 = toRawItem({ ...base, relpath: "b/README.md", raw: "y" }, new Set<string>());
  assert.equal(r1.provenance.external_id, r2.provenance.external_id, "§4.5 슬러그 모드는 basename 만 본다(폴더 무관)");
});

// 변이 시험이 드러낸 빈칸(§2.1.5) — 위 시험의 instance 들은 정규화하면 앞부분부터 달라서, 이름의 앞머리만 달라도 통과했다.
//  정규화하면 같은 꼴이 되는 서로 다른 instance(대소문자·공백·밑줄 차이, 앞부분이 같은 긴 이름)도 이름이 갈라져야 한다.
test("§2.1.5 정규화하면 같아 보이는 서로 다른 instance 도 다른 이름", () => {
  for (const [a, b] of [["wiki pm", "wiki-pm"], ["Wiki_PM", "wiki-pm"], ["x".repeat(40) + "-alpha", "x".repeat(40) + "-beta"]]) {
    for (const rel of ["Card/README.md", "a.md", "카드/정책.md"]) {
      assert.notEqual(wikiPathName(a, rel), wikiPathName(b, rel), `§2.1.5 instance ${JSON.stringify(a)} vs ${JSON.stringify(b)} × ${rel}`);
    }
  }
});


// ── 2026-11-04 개정(리뷰 지적) — 가리기는 원문 전체를 링크 바꾸기 전에 · 앞머리 값은 앞머리에서만 ──
test("§4.4(개정) 앞머리 title·code_sot 도 가리고, code_sot 는 앞머리 안에서만 읽는다", () => {
  const raw = "---\ntitle: 담당 010-1234-5678\ncode_sot: repo/x 02-123-4567\n---\n# 본문 제목\n본문\ncode_sot: 본문줄은-값이-아니다\n";
  const t = buildPathLinkTargets(["a/x.md"], (r) => `n-${r.length}`, new Set());
  const it = toRawItemPath({ relpath: "a/x.md", raw, instance: "wiki-pm", baseUrl: "", mask: new Set<MaskKind>(["phone"]) }, t);
  assert.equal(it.title, "담당 [전화번호]", "§4.4(개정) 앞머리 title 이 가려진다");
  const dw = (it.fields as { domain_wiki: Record<string, unknown> }).domain_wiki;
  assert.equal(dw.code_sot, "repo/x [전화번호]", "§4.4(개정) code_sot 도 가린 값 · 앞머리에서 읽는다");
  assert.deepEqual(dw.masked, { phone: 2 }, "§4.4(개정) masked 는 원문 전체에서 가린 수");
  const noFm = toRawItemPath({ relpath: "a/x.md", raw: "본문\ncode_sot: 본문줄\nsource_sot: 본문줄\n", instance: "wiki-pm", baseUrl: "" }, t);
  const dw2 = (noFm.fields as { domain_wiki: Record<string, unknown> }).domain_wiki;
  assert.equal(dw2.code_sot, undefined, "§4.4(개정) 앞머리 밖 code_sot 줄은 값이 아니다");
  assert.equal(dw2.source_sot, undefined, "§4.4(개정) 앞머리 밖 source_sot 줄은 값이 아니다");
});

test("§4.4(개정) 바꿔 넣은 내부 링크는 가리기에 깨지지 않는다(대상 이름에 전화번호 꼴 숫자)", () => {
  const phoneish = "wiki-pm-readme-0101234567";
  const t = buildPathLinkTargets(["a/x.md", "b/README.md"], (r) => (r === "b/README.md" ? phoneish : "wiki-pm-x-abcdefabcd"), new Set());
  const raw = "[다음](../b/README.md) 문서 · 연락 010-9876-5432";
  const it = toRawItemPath({ relpath: "a/x.md", raw, instance: "wiki-pm", baseUrl: "", mask: new Set<MaskKind>(["phone", "email", "bizno", "rrn"]) }, t);
  assert.ok(String(it.body).includes(`[다음](#/k/${phoneish})`), "§4.4(개정) 링크 대상 이름이 그대로 남는다");
  assert.ok(String(it.body).includes("[전화번호]"), "§4.4(개정) 본문 속 진짜 전화번호는 가린다");
});

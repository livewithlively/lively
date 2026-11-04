// 경로 glob — 사양 기반·구현 블라인드 시험 (사양 §1, src/connectors/path-glob.ts). DB·네트워크 불요(순수 함수).
// 실행: npm run build && node dist/connectors/path-glob.test.js
//
// 잠그는 행위(§1 — 모든 경로는 레포 기준 상대 POSIX 경로):
//  1. `*` 는 `/` 를 넘지 않는 0자 이상, `?` 는 `/` 가 아닌 정확히 한 글자.
//  2. `**` 는 `/` 를 넘는다. `**/` 는 0개 이상의 폴더(`**/x.md` 는 루트 `x.md` 에도 맞는다).
//  3. `/` 로 끝나는 패턴은 그 폴더 아래 전부(`Card/` ≡ `Card/**`) — 이름 비슷한 폴더(`Cardx/`)는 아니다.
//  4. `/` 가 없는 패턴은 어느 깊이의 파일 이름에도 맞는다 — 이름 일부만 같은 파일(`MY_CLAUDE.md`)은 아니다.
//  5. `/`·`./` 로 시작하면 루트 기준. 6. 중간에 `/` 가 있으면 루트부터 맞춘다. 7. 대소문자를 가린다.
//  8. 정규식 특수문자·공백·한글은 글자 그대로. 9. 빈/공백뿐/`#` 시작은 패턴이 아니다.
// 10. 패턴·경로의 한글 NFC/NFD 차이는 같은 글자. 11. parseGlobList 분할 규칙. 12. GlobSet.size·빈 GlobSet.
// 13. inScope — include 비면 전부, exclude 가 이긴다. 14. toPosixRel — 앞 `./` 제거·NFC.
//
// 맞춤 판정은 공개 표면 `GlobSet.matches` 로 본다(패턴 하나짜리 집합). compileGlob 은 null 판정(§1.9)과,
//  루트부터 맞추는 패턴(중간 `/`)에 한해 정규식이 상대경로에 그대로 맞는지만 본다.
import assert from "node:assert/strict";
import test from "node:test";
import { compileGlob, parseGlobList, GlobSet, inScope, toPosixRel } from "./path-glob.js";

const nfc = (s: string): string => s.normalize("NFC");
const nfd = (s: string): string => s.normalize("NFD");

const m = (pattern: string, relpath: string): boolean => new GlobSet([pattern]).matches(relpath);

function expectMatch(item: string, pattern: string, yes: readonly string[], no: readonly string[]): void {
  for (const p of yes) {
    assert.equal(m(pattern, p), true, `${item}: 패턴 ${JSON.stringify(pattern)} 은 ${JSON.stringify(p)} 에 맞아야 한다`);
  }
  for (const p of no) {
    assert.equal(m(pattern, p), false, `${item}: 패턴 ${JSON.stringify(pattern)} 은 ${JSON.stringify(p)} 에 안 맞아야 한다`);
  }
}

// ── §1.1 `*` · `?` ──
test("§1.1 `*` 는 `/` 를 넘지 않는 0자 이상", () => {
  expectMatch("§1.1 *", "docs/*.md", ["docs/a.md", "docs/.md", "docs/긴 이름.md"], ["docs/sub/a.md", "docs/a/b/c.md", "docs/a.mdx"]);
  expectMatch("§1.1 * (끝)", "docs/*", ["docs/a.md", "docs/README"], ["docs/sub/a.md"]);
});

test("§1.1 `?` 는 `/` 가 아닌 정확히 한 글자", () => {
  expectMatch("§1.1 ?", "dir/a?c.md", ["dir/abc.md", "dir/a1c.md", "dir/a가c.md"], ["dir/ac.md", "dir/abbc.md", "dir/a/c.md"]);
  expectMatch("§1.1 ? (이름 패턴)", "?.md", ["x.md", "a/b/y.md", "가.md"], ["ab.md", ".md", "a/bc.md"]);
});

// ── §1.2 `**` ──
test("§1.2 `**/` 는 0개 이상의 폴더 — 루트 파일에도 맞는다", () => {
  expectMatch("§1.2 **/x.md", "**/x.md", ["x.md", "a/x.md", "a/b/x.md"], ["a/bx.md", "bx.md", "a/b/y.md", "a/x.mdx"]);
  expectMatch("§1.2 a/**/z.md", "a/**/z.md", ["a/z.md", "a/b/z.md", "a/b/c/z.md"], ["b/z.md", "a/bz.md", "x/a/b/z.md"]);
  expectMatch("§1.2 docs/**/*.md", "docs/**/*.md", ["docs/a.md", "docs/x/y/a.md"], ["docs/a.txt", "other/a.md"]);
});

test("§1.2 `**` 는 `/` 를 넘는다", () => {
  expectMatch("§1.2 Card/**", "Card/**", ["Card/a.md", "Card/x/y/z.md"], ["Cardx/a.md", "Card.md", "x/Card/a.md"]);
});

// ── §1.3 `/` 로 끝나는 패턴 ──
test("§1.3 `/` 로 끝나는 패턴은 그 폴더 아래 전부 — 비슷한 이름 폴더는 아님", () => {
  expectMatch("§1.3 Card/", "Card/", ["Card/a.md", "Card/2_business_layer/2-2.md", "Card/x/y/z.md"],
    ["Cardx/a.md", "xCard/a.md", "Card.md", "card/a.md"]);
});

test("§1.3 `Card/` ≡ `Card/**`", () => {
  const paths = ["Card/a.md", "Card/x/y/z.md", "Cardx/a.md", "Card.md", "a/Card.md", "b.md"];
  for (const p of paths) {
    assert.equal(m("Card/", p), m("Card/**", p), `§1.3 Card/ 와 Card/** 는 ${JSON.stringify(p)} 에 대해 같은 판정이어야 한다`);
  }
});

// ── §1.4 `/` 없는 패턴 = 어느 깊이의 파일 이름 ──
test("§1.4 `/` 없는 패턴은 어느 깊이의 파일 이름에도 맞는다", () => {
  expectMatch("§1.4 CLAUDE.md", "CLAUDE.md", ["CLAUDE.md", "a/CLAUDE.md", "a/b/CLAUDE.md"],
    ["MY_CLAUDE.md", "a/MY_CLAUDE.md", "CLAUDE.md.bak", "a/CLAUDE.mdx"]);
  expectMatch("§1.4 *.md", "*.md", ["a.md", "x/y/b.md"], ["a.txt", "x/y/b.md.txt"]);
  expectMatch("§1.4 README*", "README*", ["README", "README.md", "a/b/README.ko.md"], ["a/MY_README.md"]);
});

// ── §1.5 `/`·`./` 로 시작 = 루트 기준 ──
test("§1.5 `/`·`./` 로 시작하는 패턴은 루트 기준", () => {
  expectMatch("§1.5 /CLAUDE.md", "/CLAUDE.md", ["CLAUDE.md"], ["a/CLAUDE.md", "a/b/CLAUDE.md"]);
  expectMatch("§1.5 ./CLAUDE.md", "./CLAUDE.md", ["CLAUDE.md"], ["a/CLAUDE.md", "a/b/CLAUDE.md"]);
  expectMatch("§1.5 /docs/*.md", "/docs/*.md", ["docs/a.md"], ["x/docs/a.md"]);
  expectMatch("§1.5 ./docs/", "./docs/", ["docs/a.md", "docs/x/y.md"], ["x/docs/a.md"]);
});

// ── §1.6 중간 `/` = 루트부터 ──
test("§1.6 중간에 `/` 가 있는 패턴은 루트부터 맞춘다", () => {
  expectMatch("§1.6 docs/*.md", "docs/*.md", ["docs/a.md"], ["x/docs/a.md"]);
  expectMatch("§1.6 Card/2_business_layer/*.md", "Card/2_business_layer/*.md",
    ["Card/2_business_layer/2-2.md"], ["x/Card/2_business_layer/2-2.md"]);
});

// ── §1.7 대소문자 ──
test("§1.7 대소문자를 가린다", () => {
  expectMatch("§1.7 CLAUDE.md", "CLAUDE.md", ["CLAUDE.md"], ["claude.md", "Claude.md", "a/claude.md"]);
  expectMatch("§1.7 Card/", "Card/", ["Card/a.md"], ["card/a.md", "CARD/a.md"]);
  expectMatch("§1.7 *.md", "*.md", ["a.md"], ["a.MD", "x/b.Md"]);
});

// ── §1.8 특수문자·공백·한글은 글자 그대로 ──
test("§1.8 정규식 특수문자는 글자 그대로", () => {
  expectMatch("§1.8 .", "a.md", ["a.md"], ["aXmd", "a/aXmd"]);
  expectMatch("§1.8 +", "a+b.md", ["a+b.md"], ["aab.md", "ab.md"]);
  expectMatch("§1.8 ( )", "(x).md", ["(x).md"], ["x.md"]);
  expectMatch("§1.8 [ ]", "[ab].md", ["[ab].md"], ["a.md", "b.md"]);
  expectMatch("§1.8 $ ^", "$x^.md", ["$x^.md"], ["x.md"]);
  expectMatch("§1.8 { }", "{a,b}.md", ["{a,b}.md"], ["a.md", "b.md"]);
  expectMatch("§1.8 |", "a|b.md", ["a|b.md"], ["a", "b.md"]);
  expectMatch("§1.8 특수문자 섞인 폴더 패턴", "docs/v1.2+(rc)/*.md", ["docs/v1.2+(rc)/a.md"], ["docs/v1x2+(rc)/a.md", "docs/v1.22(rc)/a.md"]);
});

test("§1.8 공백·한글이 든 패턴도 글자 그대로", () => {
  expectMatch("§1.8 공백+한글 폴더", "제품 문서/*.md", ["제품 문서/개요.md"], ["제품문서/개요.md", "x/제품 문서/개요.md"]);
  expectMatch("§1.8 공백+한글 이름", "카드 정책.md", ["카드 정책.md", "a/카드 정책.md"], ["카드정책.md", "a/카드  정책.md"]);
  expectMatch("§1.8 괄호+공백", "docs/제품 문서 (v2).md", ["docs/제품 문서 (v2).md"], ["docs/제품 문서 v2.md"]);
});

// ── §1.9 패턴이 아닌 것 ──
test("§1.9 빈 문자열·공백뿐·`#` 시작은 compileGlob 이 null", () => {
  for (const p of ["", "   ", "\t \t", "#", "# 주석", "#x.md"]) {
    assert.equal(compileGlob(p), null, `§1.9 compileGlob(${JSON.stringify(p)}) 은 null`);
  }
});

// 정규식을 어떤 문자열(상대경로 그대로인지 등)에 대어 보는지는 사양이 정하지 않아, compileGlob 은 null/RegExp 여부만 본다.
test("§1.9 유효한 패턴은 null 이 아니라 RegExp", () => {
  for (const p of ["a.md", "Card/", "/CLAUDE.md", "./CLAUDE.md", "docs/*.md", "**/x.md", "카드 정책.md", "a#b.md"]) {
    assert.ok(compileGlob(p) instanceof RegExp, `§1.9 compileGlob(${JSON.stringify(p)}) 은 RegExp`);
  }
});

test("§1.9 GlobSet 은 패턴이 아닌 항목을 세지도 맞추지도 않는다", () => {
  assert.equal(new GlobSet(["", "  ", "#c", "# d", "a.md"]).size, 1, "§1.9 유효 패턴은 a.md 하나");
  assert.equal(new GlobSet(["", "   ", "\t"]).size, 0, "§1.9 공백뿐 항목은 세지 않는다");
  assert.equal(new GlobSet(["#x"]).matches("#x"), false, "§1.9 `#` 항목은 패턴이 아니라 `#x` 경로에도 안 맞는다");
  assert.equal(new GlobSet(["", "#c"]).matches("a.md"), false, "§1.9 유효 패턴 없는 GlobSet 은 아무것에도 안 맞는다");
});

// ── §1.10 NFC/NFD ──
test("§1.10 패턴과 경로의 한글이 NFC/NFD 로 달라도 맞는다", () => {
  assert.equal(m(nfd("카드/*.md"), nfc("카드/정책.md")), true, "§1.10 NFD 패턴 × NFC 경로");
  assert.equal(m(nfc("카드/*.md"), nfd("카드/정책.md")), true, "§1.10 NFC 패턴 × NFD 경로");
  assert.equal(m(nfd("정책.md"), nfc("a/정책.md")), true, "§1.10 NFD 이름 패턴 × NFC 경로");
  assert.equal(m(nfc("/카드/정책.md"), nfd("카드/정책.md")), true, "§1.10 NFC 루트 패턴 × NFD 경로");
  assert.equal(m(nfc("카드/"), nfd("카드/하위/정책.md")), true, "§1.10 NFC 폴더 패턴 × NFD 경로");
  assert.equal(m(nfc("카드/*.md"), nfd("카도/정책.md")), false, "§1.10 다른 글자(드≠도)는 정규화해도 다르다");
});

test("§1.10+§1.1 NFD 로 온 한글 한 글자도 `?` 하나에 맞는다", () => {
  assert.equal(m("?.md", nfc("가.md")), true, "§1.1 `?` 는 NFC 한글 한 글자");
  assert.equal(m("?.md", nfd("가.md")), true, "§1.10 `?` 는 NFD 한글 한 글자(같은 글자)");
  assert.equal(m(nfc("카?.md"), nfd("카드.md")), true, "§1.10 NFC 패턴의 `?` × NFD 경로");
});

// ── §1.11 parseGlobList ──
test("§1.11 parseGlobList: null/undefined/빈 문자열 → 빈 배열", () => {
  assert.deepEqual(parseGlobList(null), [], "§1.11 null");
  assert.deepEqual(parseGlobList(undefined), [], "§1.11 undefined");
  assert.deepEqual(parseGlobList(""), [], "§1.11 빈 문자열");
  assert.deepEqual(parseGlobList("   "), [], "§1.11 공백뿐");
  assert.deepEqual(parseGlobList("\n\n"), [], "§1.11 줄바꿈뿐");
  assert.deepEqual(parseGlobList(" # only "), [], "§1.11 주석뿐");
});

test("§1.11 parseGlobList: 줄바꿈이 없으면 쉼표로 나누고 공백을 걷는다", () => {
  assert.deepEqual(parseGlobList("a.md, b/*.md ,c/"), ["a.md", "b/*.md", "c/"], "§1.11 쉼표 분할·공백 제거·순서 유지");
  assert.deepEqual(parseGlobList("a.md,#x,, ,b.md"), ["a.md", "b.md"], "§1.11 빈 항목·주석 항목은 버린다");
  assert.deepEqual(parseGlobList("Card/"), ["Card/"], "§1.11 한 항목");
});

test("§1.11 parseGlobList: 줄바꿈이 있으면 줄바꿈으로만 나눈다(쉼표는 패턴의 일부)", () => {
  assert.deepEqual(parseGlobList("a.md\n{x,y}.md\n  # 주석\n\n  docs/  \n"), ["a.md", "{x,y}.md", "docs/"],
    "§1.11 줄 분할·주석/빈 줄 제거·공백 제거");
  assert.deepEqual(parseGlobList("a.md, b.md\nc.md"), ["a.md, b.md", "c.md"], "§1.11 줄바꿈 모드에서 쉼표는 나누지 않는다");
  assert.deepEqual(parseGlobList("a.md\r\nb.md"), ["a.md", "b.md"], "§1.11 CRLF 의 \\r 은 앞뒤 공백으로 걷힌다");
});

test("§1.11 parseGlobList: `#` 으로 시작하지 않는 항목은 주석이 아니다", () => {
  assert.deepEqual(parseGlobList("a#b.md"), ["a#b.md"], "§1.11 중간 # 은 패턴의 일부");
});

// ── §1.12 GlobSet.size · 빈 GlobSet ──
test("§1.12 GlobSet.size 는 유효한 패턴 수, 빈 GlobSet 은 아무것에도 안 맞는다", () => {
  const empty = new GlobSet([]);
  assert.equal(empty.size, 0, "§1.12 빈 GlobSet 의 size 는 0");
  for (const p of ["a.md", "x/y/z.md", "CLAUDE.md"]) {
    assert.equal(empty.matches(p), false, `§1.12 빈 GlobSet 은 ${p} 에 안 맞는다`);
  }
  const set = new GlobSet(["a.md", "docs/", "", "#c"]);
  assert.equal(set.size, 2, "§1.12 유효 패턴 2개(a.md, docs/)");
  assert.equal(set.matches("docs/x.md"), true, "§1.12 여러 패턴 중 하나(docs/)에 맞으면 맞다");
  assert.equal(set.matches("q/a.md"), true, "§1.12 여러 패턴 중 하나(a.md, 이름 패턴)에 맞으면 맞다");
  assert.equal(set.matches("b.md"), false, "§1.12 어느 패턴에도 안 맞으면 안 맞다");
});

// ── §1.13 inScope ──
test("§1.13 inScope: include 가 비면 모든 경로가 후보", () => {
  const none = new GlobSet([]);
  for (const p of ["a.md", "x/y/z.md", "Card/2_business_layer/2-2.md"]) {
    assert.equal(inScope(p, none, none), true, `§1.13 include·exclude 비면 ${p} 는 범위 안`);
  }
  assert.equal(inScope("x.md", new GlobSet(["# c", ""]), none), true, "§1.13+§1.12 유효 패턴 없는 include 는 빈 include");
});

test("§1.13 inScope: include 가 있으면 그중 하나에 맞아야 한다", () => {
  const inc = new GlobSet(["docs/", "README.md"]);
  const none = new GlobSet([]);
  assert.equal(inScope("docs/a.md", inc, none), true, "§1.13 include(docs/) 에 맞음");
  assert.equal(inScope("x/README.md", inc, none), true, "§1.13 include(README.md) 에 맞음");
  assert.equal(inScope("src/a.md", inc, none), false, "§1.13 include 어디에도 안 맞으면 범위 밖");
});

test("§1.13 inScope: exclude 에 맞으면 무조건 범위 밖(exclude 가 이긴다)", () => {
  const none = new GlobSet([]);
  const exDraft = new GlobSet(["**/draft/**"]);
  assert.equal(inScope("a/draft/x.md", none, exDraft), false, "§1.13 include 없이 exclude 만 — 맞으면 밖");
  assert.equal(inScope("a/x.md", none, exDraft), true, "§1.13 include 없이 exclude 만 — 안 맞으면 안");
  const inc = new GlobSet(["docs/"]);
  const ex = new GlobSet(["docs/private/"]);
  assert.equal(inScope("docs/private/x.md", inc, ex), false, "§1.13 include·exclude 둘 다 맞으면 exclude 가 이긴다");
  assert.equal(inScope("docs/x.md", inc, ex), true, "§1.13 include 만 맞으면 안");
  assert.equal(inScope("src/x.md", inc, ex), false, "§1.13 둘 다 안 맞으면 밖");
  assert.equal(inScope("a.md", new GlobSet(["a.md"]), new GlobSet(["a.md"])), false, "§1.13 같은 패턴이 양쪽에 있어도 exclude 가 이긴다");
});

// ── §1.14 toPosixRel ──
test("§1.14 toPosixRel: 앞의 `./` 를 걷고 NFC 로 맞춘다", () => {
  assert.equal(toPosixRel("./a/b.md"), "a/b.md", "§1.14 앞 ./ 제거");
  assert.equal(toPosixRel(nfd("./카드/정책.md")), nfc("카드/정책.md"), "§1.14 ./ 제거 + NFC");
  assert.equal(toPosixRel(nfd("카드/정책.md")), nfc("카드/정책.md"), "§1.14 NFD → NFC");
});

test("§1.14 toPosixRel: 이미 POSIX 인 경로는 그대로", () => {
  for (const p of ["a/b.md", "Card/2_business_layer/2-2.md", "README.md", nfc("카드/정책 문서.md"), ".github/x.md"]) {
    assert.equal(toPosixRel(p), p, `§1.14 ${JSON.stringify(p)} 는 그대로`);
  }
});


// ── 2026-11-04 개정(리뷰 지적) — include 는 좁히는 설정이라 실패는 닫힌 쪽 ──
test("§1.13(개정) include 에 패턴을 적었는데 유효한 것이 없으면 아무것도 들지 않는다", () => {
  const none = new GlobSet([]);
  for (const bad of [["/"], ["./"], ["/", "./"]]) {
    const inc = new GlobSet(bad);
    assert.equal(inc.size, 0, `§1.12 유효 패턴 0: ${JSON.stringify(bad)}`);
    assert.equal(inc.configured, bad.length, `§1.13(개정) 적힌 패턴 수: ${JSON.stringify(bad)}`);
    for (const p of ["a.md", "Card/x.md"]) assert.equal(inScope(p, inc, none), false, `§1.13(개정) 무효 include ${JSON.stringify(bad)} → ${p} 범위 밖`);
  }
  const comments = new GlobSet(["# 주석", "   "]);
  assert.equal(comments.configured, 0, "§1.13 주석·빈 줄은 적힌 패턴이 아니다");
  assert.equal(inScope("a.md", comments, none), true, "§1.13 주석뿐인 include 는 빈 include(전부)");
  const mixed = new GlobSet(["/", "Card/"]);
  assert.equal(inScope("Card/x.md", mixed, none), true, "§1.13 유효한 패턴이 하나라도 있으면 그것으로 고른다");
  assert.equal(inScope("a.md", mixed, none), false, "§1.13 유효한 패턴에 안 맞으면 범위 밖");
});

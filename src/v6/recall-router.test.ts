// recall-router 순수 로직 단위 체크 — DB 불요(순수 함수). 테스트 러너 없이 node:assert 로 자급.
// 실행: npm run build && node dist/v6/recall-router.test.js
//
// 잠그는 불변식(#637 최종설계):
//  - (a) term-index 는 도메인맵(key/name/모듈 basename)에서 유도, 제네릭/스캐폴딩 토큰은 버린다.
//  - 리터럴 매칭: ascii 식별자(≥3)는 단어경계(aml 이 small 에 안 걸림), 한글 등은 부분문자열.
//  - (b) 경로해소: 절대경로→(repo,relpath)→조상 prefix→최장매칭(모듈단위 code_unit 이므로 리프는 exact-miss).
import assert from "node:assert/strict";
import {
  tokenizeTerm, deriveDomainTerms, matchDomainsByText,
  pickRepoRelpath, ancestorPrefixes, unitMatchCandidates, longestPrefixPath, gistLine, RECALL_STOPWORDS,
} from "./recall-router.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── tokenizeTerm — 경계문자에서 분할, 영/숫/한글만 ──
t("tokenizeTerm: 경계문자(-_/.공백)에서 분할", () => {
  assert.deepEqual(tokenizeTerm("personal-credit-loan"), ["personal", "credit", "loan"]);
  assert.deepEqual(tokenizeTerm("domain/bond-domain"), ["domain", "bond", "domain"]);
  assert.deepEqual(tokenizeTerm("고객 웹·모바일 앱"), ["고객", "웹", "모바일", "앱"]);
});

// ── deriveDomainTerms — 변별 토큰만(모듈 basename 앞토큰), 제네릭·언어·스캐폴딩 제외 ──
t("deriveDomainTerms: bond-management/채권관리 → bond·채권관리, 제네릭 제외", () => {
  const terms = deriveDomainTerms({
    key: "bond-management", name: "채권관리",
    unitPaths: ["domain/bond-domain", "application/bond-facade", "domain/cra-domain"],
  });
  assert.ok(terms.includes("bond"), "bond(변별자) 포함");
  assert.ok(terms.includes("cra"), "cra 포함");
  assert.ok(terms.includes("채권관리"), "한글 도메인명 통째 포함");
  assert.ok(!terms.includes("domain"), "domain(제네릭) 제외");
  assert.ok(!terms.includes("application"), "application 제외");
  assert.ok(!terms.includes("facade"), "facade 제외");
  assert.ok(!terms.includes("management"), "management(제네릭) 제외");
});

t("deriveDomainTerms: 영문 key 토큰 유지(personal/credit/loan)", () => {
  const terms = deriveDomainTerms({ key: "personal-credit-loan", name: "개인신용대출", unitPaths: ["application/credit-facade"] });
  assert.ok(terms.includes("personal") && terms.includes("credit") && terms.includes("loan"));
  assert.ok(terms.includes("개인신용대출"));
});

t("RECALL_STOPWORDS: 대표 제네릭 포함", () => {
  for (const w of ["domain", "application", "facade", "core", "lib", "management"]) assert.ok(RECALL_STOPWORDS.has(w));
});

// ── matchDomainsByText — 리터럴, 단어경계(ascii)·부분문자열(한글), score=매칭 term 수 ──
const DOMAINS = [
  { id: 7, terms: ["bond", "채권관리", "cra"] },
  { id: 3, terms: ["personal", "credit", "loan", "개인신용대출"] },
  { id: 6, terms: ["aml", "institution"] },
];
t("matchDomainsByText: 영문 키워드 → 해당 도메인만", () => {
  const hits = matchDomainsByText("fix the bond redemption logic", DOMAINS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 7);
  assert.deepEqual(hits[0].matched, ["bond"]);
});
t("matchDomainsByText: 단어경계 — 'aml' 이 'small' 에 안 걸림", () => {
  assert.equal(matchDomainsByText("just a small change", DOMAINS).length, 0);
  assert.equal(matchDomainsByText("run the AML check", DOMAINS)[0].id, 6);
});
t("matchDomainsByText: 다중 토큰 매칭이 상위(score 정렬)", () => {
  const hits = matchDomainsByText("personal credit loan for a bond", DOMAINS);
  assert.equal(hits[0].id, 3, "3토큰 매칭 도메인이 1토큰보다 상위");
  assert.equal(hits[0].matched.length, 3);
});
t("matchDomainsByText: 한글 도메인명 통째는 부분문자열 매칭(부분어는 미스 — 알려진 v1 한계)", () => {
  assert.equal(matchDomainsByText("개인신용대출 한도 계산", DOMAINS)[0].id, 3);
  assert.equal(matchDomainsByText("신용대출 한도", DOMAINS).length, 0, "부분어(신용대출)는 통째매칭 미스 — 시맨틱 보조 담당");
});
t("matchDomainsByText: 빈/공백 텍스트 → 무매칭", () => {
  assert.equal(matchDomainsByText("", DOMAINS).length, 0);
  assert.equal(matchDomainsByText("   ", DOMAINS).length, 0);
});

// ── pickRepoRelpath — 절대경로에서 (repo, relpath) ──
const REPOS = ["example-one", "gitlab-code-harness", "domain-wiki"];
t("pickRepoRelpath: 체크아웃 루트 무관하게 repo 세그먼트로 분리", () => {
  assert.deepEqual(
    pickRepoRelpath("/srv/lively/shared/repos/example-one/domain/bond-domain/src/main/kotlin/kr/example/Bond.kt", REPOS),
    { repo: "example-one", relpath: "domain/bond-domain/src/main/kotlin/kr/example/Bond.kt" },
  );
  assert.deepEqual(
    pickRepoRelpath("/home/me/work/gitlab-code-harness/plugins/wiki-router/hooks/x.js", REPOS),
    { repo: "gitlab-code-harness", relpath: "plugins/wiki-router/hooks/x.js" },
  );
});
t("pickRepoRelpath: repo 세그먼트 없음 → null", () => {
  assert.equal(pickRepoRelpath("/etc/passwd", REPOS), null);
  assert.equal(pickRepoRelpath("/tmp/example-one", REPOS), null, "repo 가 마지막 세그먼트면 relpath 없음 → null");
});

// ── ancestorPrefixes / longestPrefixPath — 모듈단위 code_unit 최장 조상매칭 ──
t("ancestorPrefixes: 뒤에서 세그먼트 제거(자기포함)", () => {
  assert.deepEqual(ancestorPrefixes("domain/bond-domain/src/Bond.kt"),
    ["domain/bond-domain/src/Bond.kt", "domain/bond-domain/src", "domain/bond-domain", "domain"]);
});
t("longestPrefixPath: 리프파일 → 최장 모듈 매칭", () => {
  const rel = "domain/bond-domain/src/main/kotlin/kr/example/Bond.kt";
  assert.equal(longestPrefixPath(rel, ["domain", "domain/bond-domain"]), "domain/bond-domain", "더 구체적인 모듈 우선");
  assert.equal(longestPrefixPath(rel, ["application/credit-facade"]), null, "무관 모듈 → null");
  assert.equal(longestPrefixPath("aml-app/src/A.kt", ["aml-app"]), "aml-app", "단일세그먼트 모듈도 매칭");
});

t("unitMatchCandidates: repo-relative·repo-prefixed 양 컨벤션 후보(box 별 상이 대비)", () => {
  const c = unitMatchCandidates("example-one", "domain/bond-domain/src/X.kt");
  assert.ok(c.includes("domain/bond-domain"), "고객사 A식(repo-relative) 조상");
  assert.ok(c.includes("example-one/domain/bond-domain"), "라이블리식(repo-prefixed) 조상");
  assert.ok(c.includes("example-one/domain/bond-domain/src/X.kt"));
});
t("deriveDomainTerms: 파일단위 경로(.ts) → 확장자 제거, 파일명 토큰만", () => {
  const terms = deriveDomainTerms({
    key: "domain-cartography", name: "도메인 맵",
    unitPaths: ["context-ontology/src/capabilities/domainmap-curation.ts"],
  });
  assert.ok(terms.includes("domainmap") && terms.includes("curation"), "파일명 토큰 포함");
  assert.ok(!terms.includes("ts"), "확장자 토큰 제외");
});

// ── gistLine — 포인터 원칙(본문 아님), max 자 절단 ──
t("gistLine: 짧으면 그대로, 길면 절단+…, null→''", () => {
  assert.equal(gistLine("짧은 정의"), "짧은 정의");
  assert.equal(gistLine(null), "");
  const long = "가".repeat(300);
  const g = gistLine(long, 140);
  assert.ok(g.length <= 141 && g.endsWith("…"));
});

console.log(`\n${pass} passed`);

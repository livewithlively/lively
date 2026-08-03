// #976 notion-push 순수 함수 테스트 — 사양 기반(구현 블라인드).
//   실행: npm run build && node dist/connectors/notion-push.test.js
//   목적: 위키 아웃바운드 투영의 순수 함수를 사양(intent)만으로 잠근다.
//     (1) synopsisOf  — 카드용 스캔 한줄요약(summary 우선 · 본문 폴백 · 장식 제거 · max 절단)
//     (2) feedContentHash — 무변경 재푸시 skip 용 콘텐츠 지문(결정론 · 5필드 민감 · 고정길이 hex)
//     (3) knowledgeDeepLink — 카드의 '정본 보기' 링크(base 표기 정규화 = 게이트웨이 base 와 동일 계약 ·
//         base 없거나 비면 링크 없음 · 지식 이름 URL 인코딩)
//   라이브 노션/DB 불요 — 입력→출력만 검증.
import assert from "node:assert";
import { synopsisOf, feedContentHash, knowledgeDeepLink } from "./notion-push.js";

// ────────────────────────────────────────────────────────────────────────
// 1) synopsisOf(k, max=200) → string
// ────────────────────────────────────────────────────────────────────────

// ── summary 우선: 실질 내용의 summary 가 있으면 본문 무시하고 그것을 쓴다 ──
// 사양 예시: {summary:"핵심 한줄", body_md:"# 제목\n\n본문"} → "핵심 한줄"
assert.strictEqual(
  synopsisOf({ summary: "핵심 한줄", body_md: "# 제목\n\n본문" }),
  "핵심 한줄",
);
// summary 우선은 본문에 긴 실질 문단이 있어도 유지된다.
assert.strictEqual(
  synopsisOf({ summary: "짧은 요약", body_md: "이것은 아주 긴 실질 본문 문단입니다 무시되어야 한다" }),
  "짧은 요약",
);
// summary 경로에는 본문의 '8자 미만 skip' 하한이 적용되지 않는다 — 비어있지만 않으면 짧아도 그대로 쓴다.
assert.strictEqual(
  synopsisOf({ summary: "짧", body_md: "이것은 충분히 긴 실질 본문 문단입니다" }),
  "짧",
);

// ── 공백만 있는 summary 는 '없음'으로 취급하고 본문 규칙으로 넘어간다 ──
// 사양 예시: {summary:"   ", body_md:"#\n\n짧\n\n충분히 긴 두번째 문단이다"} → "충분히 긴 두번째 문단이다"
assert.strictEqual(
  synopsisOf({ summary: "   ", body_md: "#\n\n짧\n\n충분히 긴 두번째 문단이다" }),
  "충분히 긴 두번째 문단이다",
);
// 탭/개행뿐인 summary 도 공백으로 취급 — 본문도 없으면 "".
assert.strictEqual(synopsisOf({ summary: " \t\n ", body_md: null }), "");

// ── 본문 폴백 + 마크다운 장식 제거 ──
// 사양 예시: {summary:null, body_md:"# 제목\n\n**중요** 첫 문단입니다."} → "중요 첫 문단입니다."
//   (짧은 제목줄 "제목" 건너뜀 + 볼드 표식 제거)
assert.strictEqual(
  synopsisOf({ summary: null, body_md: "# 제목\n\n**중요** 첫 문단입니다." }),
  "중요 첫 문단입니다.",
);
// 장식 표식 전종(`* _ ` > # -`)이 제거된다 — 모두 장식 위치에 둔 뒤 결과에 마커가 남지 않고 본문 텍스트는 보존됨을 확인.
{
  const r = synopsisOf({
    summary: null,
    body_md: "> # *중요* _기울임_ `코드` - 항목 충분히 긴 실질 문단입니다",
  });
  assert.ok(!r.includes("*"), "강조 표식 * 제거");
  assert.ok(!r.includes("_"), "강조 표식 _ 제거");
  assert.ok(!r.includes("`"), "코드 표식 ` 제거");
  assert.ok(!r.includes(">"), "인용 표식 > 제거");
  assert.ok(!r.includes("#"), "제목 표식 # 제거");
  assert.ok(!r.includes("-"), "목록 표식 - 제거");
  assert.ok(r.includes("중요"), "본문 텍스트 보존");
  assert.ok(r.includes("충분히 긴 실질 문단입니다"), "본문 텍스트 보존");
}
// 내부 연속 공백은 하나로 접힌다.
assert.strictEqual(
  synopsisOf({ summary: null, body_md: "여러      공백    접힘    테스트" }),
  "여러 공백 접힘 테스트",
);

// ── 짧은(제목/단어 수준) 문단은 건너뛰고 첫 '실질' 문단을 고른다 ──
// 사양 경계: 정리된 길이 8자 미만이면 실질 문단 아님 → 다음 문단. (7자 skip, 8자 채택)
assert.strictEqual(
  synopsisOf({ summary: null, body_md: "일곱글자입니다\n\n여덟글자입니다요" }),
  "여덟글자입니다요",
);

// ── summary 도 실질 문단도 없으면 빈 문자열 ──
// 사양 예시: {summary:null, body_md:"#\n\n짧"} → ""
assert.strictEqual(synopsisOf({ summary: null, body_md: "#\n\n짧" }), "");
assert.strictEqual(synopsisOf({ summary: null, body_md: null }), "");
assert.strictEqual(synopsisOf({}), "");
assert.strictEqual(synopsisOf({ summary: "", body_md: undefined }), "");

// ── 길이 제한: 어느 경로든 결과는 max 글자로 절단(기본 200) ──
// 사양 예시: summary "x"×300 을 max=200 으로 → 길이 200
const long = "x".repeat(300);
assert.strictEqual(synopsisOf({ summary: long }).length, 200); // 기본 max=200
assert.strictEqual(synopsisOf({ summary: long }), "x".repeat(200)); // 앞 200자
assert.strictEqual(synopsisOf({ summary: long }, 200).length, 200); // 명시 max=200
assert.strictEqual(synopsisOf({ summary: long }, 50), "x".repeat(50)); // 커스텀 max 반영
// 본문 폴백 경로도 동일하게 절단된다.
assert.strictEqual(
  synopsisOf({ summary: null, body_md: "실질적으로충분히긴문단입니다" }, 5),
  "실질적으로",
);

// ────────────────────────────────────────────────────────────────────────
// 2) feedContentHash(f) → string
// ────────────────────────────────────────────────────────────────────────

const base = {
  title: "설계 노트",
  domain: "컨텍스트 저장소",
  type: "knowledge",
  summary: "위키 아웃바운드 투영",
  updated: "2026-07-19T00:00:00Z",
};
const h = feedContentHash(base);

// ── 안정 지문 포맷: 빈 문자열 아님 + 16진수 문자열(길이 하드코딩 없음) ──
assert.ok(h.length > 0, "지문은 빈 문자열이 아니다");
assert.ok(/^[0-9a-fA-F]+$/.test(h), "지문은 16진수 문자열이다");

// ── 결정론: 같은 5개 필드 값이면 항상 같은 출력(호출 시점 무관) ──
assert.strictEqual(feedContentHash(base), h); // 같은 입력 재호출
assert.strictEqual(
  feedContentHash({
    title: "설계 노트",
    domain: "컨텍스트 저장소",
    type: "knowledge",
    summary: "위키 아웃바운드 투영",
    updated: "2026-07-19T00:00:00Z",
  }),
  h,
); // 값이 같은 별개 객체도 동일 출력

// ── 민감: 5개 필드 중 어느 하나라도 바뀌면 출력이 달라진다 ──
assert.notStrictEqual(feedContentHash({ ...base, title: "다른 제목" }), h); // title
assert.notStrictEqual(feedContentHash({ ...base, domain: "다른 도메인" }), h); // domain
assert.notStrictEqual(feedContentHash({ ...base, type: "project" }), h); // type
assert.notStrictEqual(feedContentHash({ ...base, summary: "다른 요약" }), h); // summary
assert.notStrictEqual(feedContentHash({ ...base, updated: "2026-07-20T00:00:00Z" }), h); // updated

// ── 고정 길이: 입력 크기와 무관하게 출력 길이가 일정하다(정확한 길이 값은 사양에 없음 — 하드코딩 금지) ──
const hLong = feedContentHash({
  ...base,
  title: "훨씬 더 길고 완전히 다른 제목을 넣어도 지문 길이는 고정이어야 한다",
});
assert.strictEqual(hLong.length, h.length, "입력이 길어져도 지문 길이는 고정");

// ── 전부 빈 필드여도 비지 않은 고정 길이 16진수를 낸다 ──
const hEmpty = feedContentHash({ title: "", domain: "", type: "", summary: "", updated: "" });
assert.ok(hEmpty.length > 0, "빈 필드 입력도 빈 지문이 아니다");
assert.ok(/^[0-9a-fA-F]+$/.test(hEmpty), "빈 필드 입력도 16진수");
assert.strictEqual(hEmpty.length, h.length, "빈 필드 입력도 동일한 고정 길이");

// ────────────────────────────────────────────────────────────────────────
// 3) knowledgeDeepLink(base, name) → string | null
//    사양: 카드에 실을 '정본 보기' 링크. base 가 없거나 정규화 후 비면 **링크를 만들지 않는다**(null —
//    깨진 링크보다 링크 없음이 낫다). base 는 게이트웨이 base 와 동일 계약으로 정규화한다(공백·'/mcp'·
//    말미 슬래시 흡수). 지식 이름은 URL 조각으로 안전하게 인코딩한다.
// ────────────────────────────────────────────────────────────────────────

// ── base 가 없으면 링크 없음 ──
assert.strictEqual(knowledgeDeepLink(null, "foo"), null, "base=null → 링크 없음");
assert.strictEqual(knowledgeDeepLink(undefined, "foo"), null, "base=undefined → 링크 없음");
assert.strictEqual(knowledgeDeepLink("", "foo"), null, "base='' → 링크 없음");
// 정규화하면 비는 값(공백뿐)도 '없음'과 같이 취급 — 'https:///#/k/foo' 같은 반쪽 링크를 만들면 안 된다.
assert.strictEqual(knowledgeDeepLink("   ", "foo"), null, "base=공백뿐 → 링크 없음");

// ── 정상 base ──
assert.strictEqual(knowledgeDeepLink("http://host", "foo"), "http://host/#/k/foo");
// 말미 슬래시가 있어도 '//#/k/' 처럼 겹치지 않는다.
assert.strictEqual(knowledgeDeepLink("http://host/", "foo"), "http://host/#/k/foo");
// 회귀 핵심: '/mcp' 로 저장된 조직. 종전엔 말미 슬래시만 떼서 'http://host/mcp/#/k/foo' 라는 죽은 링크가 실렸다.
assert.strictEqual(knowledgeDeepLink("http://host/mcp/", "foo"), "http://host/#/k/foo");
assert.strictEqual(knowledgeDeepLink("http://host/mcp", "foo"), "http://host/#/k/foo");
// 앞뒤 공백도 흡수한다(게이트웨이 base 와 같은 계약).
assert.strictEqual(knowledgeDeepLink("  http://host  ", "foo"), "http://host/#/k/foo");
assert.strictEqual(knowledgeDeepLink("\thttps://gw.example.com:8080/mcp/\n", "foo"),
  "https://gw.example.com:8080/#/k/foo");

// ── 이름 인코딩: '/'·'#'·공백이 원문 그대로 나오면 해시 라우트가 깨진다 ──
{
  const link = knowledgeDeepLink("http://host", "a/b c#d");
  assert.ok(link, "링크가 만들어져야 한다");
  const frag = link.slice("http://host/#/k/".length);
  assert.ok(!frag.includes("/"), "이름의 '/' 는 인코딩되어야 한다");
  assert.ok(!frag.includes(" "), "이름의 공백은 인코딩되어야 한다");
  assert.ok(!frag.includes("#"), "이름의 '#' 는 인코딩되어야 한다");
  assert.strictEqual(decodeURIComponent(frag), "a/b c#d", "디코드하면 원래 이름으로 돌아온다");
}

console.log("notion-push.test: OK");

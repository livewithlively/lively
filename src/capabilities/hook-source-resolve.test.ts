// resolveHookSource 순수함수 단위 체크 — DB 불요. 테스트 러너 없이 node:assert 로 자급.
// 실행: npm run build && node dist/capabilities/hook-source-resolve.test.js
//
// 커스텀 훅 저장 경로에서 본문(source_code) 값 해소. 사양(spec970) 블라인드 테스트 — 구현 미참조, 행위만 잠근다.
//  불변식: "생략(undefined)=보존 ≠ 빈문자열('')=지움". 둘은 다른 의도이므로 결과가 달라야 한다.
//  거부(throw): 비문자열 · 상한(16384) 초과 · 평문 시크릿 포함. 단 시크릿 검사는 '값이 있을 때만' 돈다.
import assert from "node:assert/strict";
import { resolveHookSource, resolveHookMatcher } from "./delivery.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

// ── A. 생략 = 보존. 부분 수정이 본문을 언급 안 했으면 그대로 둔다(데이터 소실 방지 핵심). ──
t("A: 생략(undefined) → undefined 반환(본문 보존 신호)", () => {
  assert.equal(resolveHookSource(undefined), undefined);
});

// ── B. 문자열 = 설정. 받은 값을 그대로 돌려준다. ──
t("B: 일반 문자열 → 그대로 반환(변형 없음)", () => {
  const src = "export default async () => { return 0; }";
  assert.equal(resolveHookSource(src), src);
});

// ── C. 명시적 빈 문자열 = 지움. 이 사양의 핵심: A(보존)와 결과가 달라야 한다. ──
t('C: 빈 문자열 "" → "" 반환(undefined 아님)', () => {
  assert.equal(resolveHookSource(""), "");
});
t("C: 빈 문자열과 생략은 결과가 다르다(지움 ≠ 보존 — 헷갈리면 안 됨)", () => {
  assert.notEqual(resolveHookSource(""), resolveHookSource(undefined));
});

// ── D. 비문자열 입력 = 거부. 조용히 빈 값·보존으로 넘어가지 않는다(0·false 같은 falsy 도 던진다). ──
t("D: 비문자열(null·숫자·객체·불리언) → 거부", () => {
  assert.throws(() => resolveHookSource(null));
  assert.throws(() => resolveHookSource(42));
  assert.throws(() => resolveHookSource(0)); // falsy 숫자도 '보존'으로 새면 안 됨
  assert.throws(() => resolveHookSource({}));
  assert.throws(() => resolveHookSource([])); // 배열도 문자열 아님
  assert.throws(() => resolveHookSource(true));
  assert.throws(() => resolveHookSource(false)); // falsy 불리언도 던진다
});

// ── E. 지나치게 긴 본문 = 거부. 경계: 정확히 16384 허용, 16385 거부. ──
t("E: 정확히 16384자 → 허용(그대로 반환)", () => {
  const atCap = "x".repeat(16384);
  assert.equal(resolveHookSource(atCap), atCap);
});
t("E: 상한(16384) 초과(16385자) → 거부", () => {
  assert.throws(() => resolveHookSource("x".repeat(16385)));
});

// ── F. 평문 시크릿 포함 = 거부(hard-block). AWS 액세스 키(AKIA + 대문자·숫자 16). ──
t("F: 평문 시크릿(AWS 액세스 키) 포함 → 거부", () => {
  assert.throws(() => resolveHookSource('const k = "AKIAIOSFODNN7EXAMPLE";'));
});
t("F: 생략(A)은 시크릿 검사를 타지 않는다 — 값 없으면 오류 없음", () => {
  assert.doesNotThrow(() => resolveHookSource(undefined));
});

// ── 엣지: 유효한 문자열은 앞뒤 공백을 잘라내거나 변형하지 않는다. ──
t("엣지: 앞뒤 공백은 트리밍하지 않고 원문 그대로 반환", () => {
  assert.equal(resolveHookSource("  hi  "), "  hi  ");
});

// ── resolveHookMatcher(#970) — source 와 달리 세 갈래: null 이 '전체 매칭'이라는 의미 있는 값이다. ──
//  불변식: 생략(undefined)=보존 · 명시적 null/""=전체매칭(null) · 문자열=패턴. 셋을 뭉개면 '명시적 지움'이 삼켜진다.
t("matcher A: 생략(undefined) → undefined(보존 신호)", () => {
  assert.equal(resolveHookMatcher(undefined), undefined);
});
t("matcher B: 문자열 → 그대로(패턴)", () => {
  assert.equal(resolveHookMatcher("Write|Edit"), "Write|Edit");
});
t("matcher C: 명시적 null → null(전체매칭)", () => {
  assert.equal(resolveHookMatcher(null), null);
});
t("matcher C2: 빈 문자열 \"\" → null(전체매칭 — null 과 동일 취급)", () => {
  assert.equal(resolveHookMatcher(""), null);
});
t("matcher D: 생략(보존)과 명시적 null(전체매칭)은 다르다 — undefined ≠ null", () => {
  assert.notEqual(resolveHookMatcher(undefined), resolveHookMatcher(null));
});
t("matcher E: 비문자열(숫자·객체)은 거부", () => {
  assert.throws(() => resolveHookMatcher(42));
  assert.throws(() => resolveHookMatcher({}));
});

console.log(`\n${pass} passed`);

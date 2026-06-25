// buildKnowledgeIndex 단위 체크 — DB 불요(순수 함수). 테스트 러너 없이 node:assert 로 자급.
// 실행: npm run build && node dist/org/materialize.test.js
// V4-P3 재작성: v4 주입 = R(규칙) 전문 항상주입 + area 지도 + 쓰기 가이드. recalled 제목리스트·중요도캡·
//  observed 인덱스제외·distill 제외절은 폐기됐다(아래 케이스가 그 폐기 동작을 검증). WYSIWYG(결정적·중복없음) 유지.
import assert from "node:assert/strict";
import { buildKnowledgeIndex, type CategoryMapEntry } from "./materialize.js";
import type { KnowledgeRow } from "../v6/knowledge-store.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

// 최소 KnowledgeRow 팩토리(v6) — buildKnowledgeIndex 가 읽는 필드(name/injection/lifecycle/title/body_md/sort)는
//  명시 채움. V6: kind 폐기 → injection ∈ {always(규칙·페르소나 항상주입), recalled(검색 소환)}.
const unit = (over: Partial<KnowledgeRow>): KnowledgeRow => ({
  name: "u",
  injection: "recalled",
  provenance: "authored",
  title: null,
  body_md: "",
  lifecycle: "active",
  confidence: "human",
  source: "authored",
  version: 1,
  updated_at: "",
  sort: 0,
  ...over,
  summary: over.summary ?? null,
  is_wiki: over.is_wiki ?? false,
});

const category = (over: Partial<CategoryMapEntry>): CategoryMapEntry =>
  ({ space: "product", key: "k", name: "n", active_units: 0, ...over });

// ── (v4-a) R(규칙) **전문**이 항상 주입된다(enforced). 제목 헤더 + 본문 전문. ──
t("v4-a: R 규칙은 전문(body_md)이 인덱스에 주입된다(enforced)", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "rule-1", injection: "always", title: "푸시 전 빌드·린트", body_md: "push 전 반드시 빌드 + 린트 확인. 깨지면 push 금지." }),
  ]);
  assert.ok(idx.includes("## 강제 규칙 (R · 항상 적용)"), "R 섹션 헤더");
  assert.ok(idx.includes("### 푸시 전 빌드·린트"), "R 제목이 헤더로");
  assert.ok(idx.includes("push 전 반드시 빌드 + 린트 확인"), "R 전문(body)이 통째로 주입");
});

// ── (v4-b) K/H/W 는 정적 주입하지 않는다(area 지도로 발견·검색 소환). 제목 리스트 폐기. ──
t("v4-b: K/H/W 는 정적 주입 안 됨(제목리스트 폐기 — name 도 미노출)", () => {
  const idx = buildKnowledgeIndex([
    // 픽스처 제목은 가이드 정적 산문과 부분문자열 충돌이 없도록 고유하게(예: "어떤 지식"은 가이드 'WIKI 인덱스 핀: 어떤 지식이…'와 충돌).
    unit({ name: "fixK1", injection: "recalled", title: "픽스처제목ZZK", body_md: "지식 본문" }),
    unit({ name: "fixH1", injection: "recalled", title: "픽스처제목ZZH", body_md: "절차 본문" }),
    unit({ name: "fixW1", injection: "recalled", title: "픽스처제목ZZW", body_md: "작업 본문" }),
  ]);
  assert.ok(!idx.includes("fixK1") && !idx.includes("픽스처제목ZZK"), "K 는 정적 주입 안 됨");
  assert.ok(!idx.includes("fixH1") && !idx.includes("픽스처제목ZZH"), "H 는 정적 주입 안 됨");
  assert.ok(!idx.includes("fixW1") && !idx.includes("픽스처제목ZZW"), "W 는 정적 주입 안 됨");
  // 구 제목리스트 항목줄(`- <title> — <요약>  · ctx_cat name=<name>  · <freshness>`) 형태가 없어야 한다.
  assert.ok(!/·\s*ctx_cat name=/.test(idx), "제목리스트 폐기 — '· ctx_cat name=' 항목 줄 없음");
});

// ── (v4-c) observed 폐기: 주입은 출처 아닌 kind 가 결정한다. observed R 은 (드물지만) 주입되고, ──
//  observed K 는 K 라서 정적 미주입(observed 라서가 아님). 즉 'observed 인덱스 제외 필터'는 사라졌다.
t("v4-c: observed 제외 필터 폐기 — 주입은 kind 가 결정(observed R 주입·observed K 미주입은 K 라서)", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "obs-rule", injection: "always", title: "수집된 규칙", body_md: "observed 규칙 전문", confidence: "observed" }),
    unit({ name: "obs-k", injection: "recalled", title: "수집된 지식", body_md: "observed 지식 본문", confidence: "observed" }),
  ]);
  assert.ok(idx.includes("observed 규칙 전문"), "observed 여도 R 이면 전문 주입(출처가 주입을 결정 안 함)");
  assert.ok(!idx.includes("수집된 지식"), "K 는 미주입(observed 라서가 아니라 K 라서)");
});

// ── (v4-d) area 지도 — 전 area 를 space 별로 key — name (active수) 로. 발견용. ──
t("v4-d: area 지도가 space 별로 key — name (N) 렌더(product→business 순)", () => {
  const idx = buildKnowledgeIndex([], [
    category({ space: "product", key: "agent-gateway", name: "에이전트 게이트웨이", active_units: 8 }),
    category({ space: "business", key: "gtm", name: "GTM", active_units: 16 }),
    category({ space: "product", key: "audit-history", name: "감사 이력", active_units: 0 }),
  ]);
  assert.ok(idx.includes("## 카테고리 (주제 — 검색으로 소환)"), "카테고리 지도 헤더");
  assert.ok(idx.includes("### product") && idx.includes("### business"), "space 섹션");
  assert.ok(idx.includes("- agent-gateway — 에이전트 게이트웨이 (8)"), "active>0 은 (N) 표기");
  assert.ok(idx.includes("- audit-history — 감사 이력"), "active=0 area 도 완전성 위해 나열");
  assert.ok(!idx.includes("- audit-history — 감사 이력 (0)"), "active=0 은 (0) 미표기");
  assert.ok(idx.includes("- gtm — GTM (16)"), "business area 항목");
  // product 섹션이 business 섹션보다 먼저(에이전트가 제품 도메인 우선 인지).
  assert.ok(idx.indexOf("### product") < idx.indexOf("### business"), "product 가 business 보다 먼저");
});

// ── (wiki) is_wiki 핀 지식은 ${wiki} 위치에 '소환키 — 제목 · category' 인덱스로(본문 제외). ──
t("wiki: is_wiki 핀이 ${wiki} 블록에 소환키·제목·category 로 인덱스됨(본문 제외)", () => {
  const idx = buildKnowledgeIndex(
    [
      unit({ name: "service-pivot", injection: "recalled", title: "서비스 피벗 전략", body_md: "본문비밀", is_wiki: true }),
      unit({ name: "not-pinned", injection: "recalled", title: "안핀됨", body_md: "안나와야", is_wiki: false }),
    ],
    [], "# T\n\n${wiki}\n\n## 끝",
    new Map([["service-pivot", "strategy-research-gtm"]]),
  );
  assert.ok(idx.includes("## WIKI 인덱스"), "WIKI 인덱스 헤더");
  assert.ok(idx.includes("- service-pivot — 서비스 피벗 전략 · strategy-research-gtm"), "핀: 소환키 — 제목 · category");
  assert.ok(!idx.includes("본문비밀"), "핀이라도 본문 제외(인덱스만)");
  assert.ok(!idx.includes("not-pinned") && !idx.includes("안핀됨"), "미핀은 wiki 블록에 없음");
});

// ── (wiki-b) ${wiki} 미배치 템플릿이면 핀이 있어도 미출력(메커니즘만 — 기본 템플릿 불변 정책). ──
t("wiki-b: ${wiki} 미배치면 핀 지식이 있어도 주입 안 됨(opt-in 배치)", () => {
  const idx = buildKnowledgeIndex(
    [unit({ name: "pinned", injection: "recalled", title: "핀된것", is_wiki: true })],
    [], "# 고정\n\n${rules}본문없음",
    new Map([["pinned", "k"]]),
  );
  assert.ok(!idx.includes("WIKI 인덱스") && !idx.includes("pinned"), "${wiki} 없으면 핀도 미출력");
});

// ── (wiki-c) 대표 category 없는 핀은 ' · category' 칩 없이 '소환키 — 제목' 만. ──
t("wiki-c: 대표 category 없는 핀은 칩 없이 소환키 — 제목", () => {
  const idx = buildKnowledgeIndex(
    [unit({ name: "no-cat", injection: "recalled", title: "분류없음", is_wiki: true })],
    [], "${wiki}", new Map(),
  );
  assert.ok(idx.includes("- no-cat — 분류없음"), "칩 없이 소환키 — 제목");
  assert.ok(!idx.includes("분류없음 ·"), "칩 구분자 미출력");
});

// ── (v4-e) 맥락 로드/기록 가이드는 항상 박힌다(빈 입력에도) — 06-23 재설계로 단일 템플릿에 통합(구 WRITE_GUIDE_BLOCK 폐기). ──
t("v4-e: 맥락 로드/기록 가이드가 항상 주입된다(빈 입력에도)", () => {
  const idx = buildKnowledgeIndex([], []);
  assert.ok(idx.includes("## 맥락 로드/기록 가이드"), "로드/기록 가이드 헤더");
  assert.ok(idx.includes("knowledge_save"), "기록=knowledge_save 안내");
  assert.ok(idx.includes("미러"), "외부=미러 안내");
});

// ── (v4-f) 중요도 캡 폐기 — R 이 많아도 전부 전문 주입(PER_KIND_CAP/TOTAL_CAP 없음). ──
t("v4-f: 중요도 캡 폐기 — R 50개 초과여도 전부 주입(잘림·'외 N건' 없음)", () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    unit({ name: `rule-${i}`, injection: "always", title: `규칙${i}`, body_md: `규칙${i} 전문` }));
  const idx = buildKnowledgeIndex(many);
  for (let i = 0; i < 60; i++) {
    assert.ok(idx.includes(`### 규칙${i}`), `규칙${i} 전부 주입(캡 없음)`);
  }
  assert.ok(!idx.includes("외 ") || !/외 \d+건/.test(idx), "'… 외 N건' 잘림 표기 없음");
});

// ── (v4-g) H1-b 시크릿 출력게이트: R 전문/제목·area 표시명이 마스킹된다(서빙 = throw 금지, 마스킹만). ──
t("v4-g: R 전문의 OpenAI 키가 [REDACTED] 로 마스킹", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "leaky", injection: "always", title: "정상 제목", body_md: "키 sk-ABCDEFGHIJKLMNOP1234 가 본문에 노출" }),
  ]);
  assert.ok(!idx.includes("sk-ABCDEFGHIJKLMNOP1234"), "원본 키가 인덱스에 남으면 안 됨");
  assert.ok(idx.includes("[REDACTED]"), "마스킹 토큰이 있어야 함");
});

t("v4-g: R 제목·area 표시명의 라이블리 토큰이 마스킹", () => {
  const idx = buildKnowledgeIndex(
    [unit({ name: "r2", injection: "always", title: "제목에 lvk_abcdefghijklmnopqrstuvwxyz 섞임", body_md: "본문" })],
    [category({ space: "product", key: "k", name: "area 이름 lvk_zyxwvutsrqponmlkjihgfedcba" })],
  );
  assert.ok(!idx.includes("lvk_abcdefghijklmnopqrstuvwxyz"), "R 제목 토큰 마스킹");
  assert.ok(!idx.includes("lvk_zyxwvutsrqponmlkjihgfedcba"), "area 표시명 토큰 마스킹");
  assert.ok(idx.includes("[REDACTED]"));
});

t("v4-g: 시크릿 없는 정상 입력은 마스킹 없이 원문 유지", () => {
  const idx = buildKnowledgeIndex(
    [unit({ name: "clean", injection: "always", title: "깨끗한 규칙", body_md: "평범한 규칙 전문" })],
    [category({ space: "product", key: "billing", name: "결제" })],
  );
  assert.ok(!idx.includes("[REDACTED]"));
  assert.ok(idx.includes("깨끗한 규칙") && idx.includes("평범한 규칙 전문") && idx.includes("- billing — 결제"));
});

// ── (v4-h) lifecycle!=active R 은 방어적으로 제외(호출자가 active 만 넘기더라도). ──
t("v4-h: lifecycle!=active 인 R 은 전문 주입에서 제외", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "live", injection: "always", title: "활성 규칙", body_md: "활성 규칙 전문", lifecycle: "active" }),
    unit({ name: "dead", injection: "always", title: "폐기 규칙", body_md: "폐기 규칙 전문", lifecycle: "superseded" }),
  ]);
  assert.ok(idx.includes("활성 규칙 전문"));
  assert.ok(!idx.includes("폐기 규칙 전문"));
});

// ── (v4-i) WYSIWYG 불변식: 같은 입력 → byte-identical, 헤더/블록 중복 누적 0(preview↔발행 byte-identical 보증). ──
t("v4-i: 멱등 — 같은 입력 2회 호출 byte-identical(중복 누적 0)", () => {
  const units = [
    unit({ name: "r1", injection: "always", title: "A", body_md: "A 전문", sort: 0 }),
    unit({ name: "r2", injection: "always", title: "B", body_md: "B 전문", sort: 1 }),
  ];
  const amap = [category({ space: "product", key: "k1", name: "n1", active_units: 3 })];
  const a = buildKnowledgeIndex(units, amap);
  const b = buildKnowledgeIndex(units, amap);
  assert.equal(a, b, "동일 입력은 동일 출력(결정적 = WYSIWYG byte-identical)");
  assert.equal((a.match(/# Knowledge Index/g) ?? []).length, 1, "헤더 정확히 1개");
  assert.equal((a.match(/## 강제 규칙/g) ?? []).length, 1, "R 섹션 헤더 1개");
  assert.equal((a.match(/## 카테고리/g) ?? []).length, 1, "카테고리 지도 헤더 1개");
  assert.equal((a.match(/## 맥락 로드\/기록 가이드/g) ?? []).length, 1, "로드/기록 가이드 헤더 1개");
});

// ── (v4-j) R sort→name 결정적 순서(WYSIWYG 안정성). ──
t("v4-j: R 은 sort→name 안정 순서로 전문 주입", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "z", injection: "always", title: "Z규칙", body_md: "Z", sort: 0 }),
    unit({ name: "a", injection: "always", title: "A규칙", body_md: "A", sort: 0 }),
    unit({ name: "m", injection: "always", title: "M규칙", body_md: "M", sort: -1 }),
  ]);
  // sort -1(m) 먼저, 그다음 sort 0 에서 name a < z.
  assert.ok(idx.indexOf("### M규칙") < idx.indexOf("### A규칙"), "sort 작은 게 먼저");
  assert.ok(idx.indexOf("### A규칙") < idx.indexOf("### Z규칙"), "동 sort 는 name 오름차순");
});

// ── (v4-k) 중복 주입 방지: org_content 섹션 R(managed-policy·org-defaults)은 R 전문 섹션에서 제외. ──
//  이 둘은 전용 경로(머리말 prepend·생성기 org/*.md)로 세션당 1회 전달되므로, 인덱스 R 섹션에 또 실으면
//  한 컨텍스트에 같은 규칙이 두 번 박힌다. 사용자-저작 R ku 는 전용 경로가 없어 그대로 전문 주입돼야 한다.
t("v4-k: managed-policy·org-defaults 는 R 전문 섹션에서 제외(중복 주입 방지), 사용자 R 은 주입", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "managed-policy", injection: "always", title: "강제 규칙", body_md: "정책 본문 — 여기 한 번만" }),
    unit({ name: "org-defaults", injection: "always", title: "회사 맥락", body_md: "맥락 본문 — 여기 한 번만" }),
    unit({ name: "custom-rule", injection: "always", title: "사내 규칙", body_md: "사내 규칙 전문" }),
  ]);
  assert.ok(!idx.includes("정책 본문 — 여기 한 번만"), "managed-policy 전문은 R 섹션에 안 실림(머리말 단일 출처)");
  assert.ok(!idx.includes("맥락 본문 — 여기 한 번만"), "org-defaults 전문은 R 섹션에 안 실림(머리말 단일 출처)");
  assert.ok(idx.includes("### 사내 규칙") && idx.includes("사내 규칙 전문"), "사용자-저작 R ku 는 전문 주입");
});

// ── (v4-l) 섹션 R 만 있고 사용자 R 이 없으면 R 섹션 자체가 안 뜬다(빈 헤더 잔존 금지). ──
t("v4-l: 섹션 R 만 있으면 '## 강제 규칙' 헤더가 안 남는다", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "managed-policy", injection: "always", title: "강제 규칙", body_md: "정책 본문" }),
    unit({ name: "org-defaults", injection: "always", title: "회사 맥락", body_md: "맥락 본문" }),
  ], [category({ space: "product", key: "k1", name: "n1", active_units: 1 })]);
  assert.ok(!idx.includes("## 강제 규칙 (R · 항상 적용)"), "제외 후 R 단위 0 → R 섹션 헤더 없음");
  assert.ok(idx.includes("## 카테고리"), "다른 섹션은 정상 렌더");
});

console.log(`\n${pass} checks passed`);

// buildKnowledgeIndex / substituteBlocks 단위 체크 — DB 불요(순수 함수). 테스트 러너 없이 node:assert 로 자급.
// 실행: npm run build && node dist/org/materialize.test.js
// #335 재작성: 항상-주입의 '강제 규칙(R/${rules})' 경로는 폐기됐다(항상-주입 = 섹션 문서뿐). 이 파일은 남은
//  동적 치환(${team}/${categories}/${wiki})·발견 지도·마스킹·멱등(WYSIWYG byte-identical)을 검증한다.
import assert from "node:assert/strict";
import { buildKnowledgeIndex, substituteBlocks, type CategoryMapEntry } from "./materialize.js";
import type { KnowledgeRow } from "../v6/knowledge-store.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

// 최소 KnowledgeRow 팩토리(v6) — buildKnowledgeIndex/buildWikiBlock 가 읽는 필드만 명시 채움.
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

// ── (a) #335: always 지식(비-섹션)은 더 이상 인덱스에 전문 주입되지 않는다(${rules} 폐기). 항상-주입은 섹션 문서뿐. ──
t("a: always 지식의 전문/제목은 인덱스에 주입되지 않는다('## 강제 규칙' 폐기)", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "rule-1", injection: "always", title: "푸시 전 빌드·린트", body_md: "push 전 반드시 빌드 + 린트 확인." }),
  ]);
  assert.ok(!idx.includes("## 강제 규칙"), "강제 규칙(R) 섹션은 더 이상 없음");
  assert.ok(!idx.includes("### 푸시 전 빌드·린트"), "always 지식 제목 미주입");
  assert.ok(!idx.includes("push 전 반드시 빌드 + 린트 확인"), "always 지식 전문 미주입");
});

// ── (rules-stale) 편집본 템플릿에 잔존한 ${rules} 는 리터럴로 노출되지 않고 빈 문자열로 정리된다. ──
t("rules-stale: 잔존 ${rules} 플레이스홀더는 빈 문자열로 제거(리터럴 노출 없음)", () => {
  const out = substituteBlocks("# 고정\n\n${rules}본문", {});
  assert.ok(!out.includes("${rules}"), "${rules} 리터럴이 남지 않음");
  assert.ok(out.includes("# 고정") && out.includes("본문"), "주변 텍스트는 보존");
});

// ── (team) ${team} 플레이스홀더가 팀 블록으로 치환되고, consumedTeam 으로 사용 여부를 알린다. ──
t("team: ${team} 치환 + consumedTeam 신호", () => {
  const consumedTeam = { v: false };
  const out = substituteBlocks("앞\n\n${team}\n\n뒤", { team: "## 우리 팀\n- 팀: 근로팀", consumedTeam });
  assert.ok(out.includes("## 우리 팀") && out.includes("- 팀: 근로팀"), "팀 블록 치환");
  assert.equal(consumedTeam.v, true, "consumedTeam.v=true (한 섹션이 ${team} 소비)");
  // 미사용 시 false 유지.
  const c2 = { v: false };
  substituteBlocks("팀 없음", { team: "## 우리 팀", consumedTeam: c2 });
  assert.equal(c2.v, false, "${team} 없는 템플릿이면 consumedTeam.v=false");
});

// ── (b) recalled 지식은 정적 주입하지 않는다(area 지도로 발견·검색 소환). 제목/본문/name 모두 미노출. ──
t("b: recalled 지식은 정적 주입 안 됨(제목·본문·name 미노출)", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "fixK1", injection: "recalled", title: "픽스처제목ZZK", body_md: "지식 본문" }),
    unit({ name: "fixH1", injection: "recalled", title: "픽스처제목ZZH", body_md: "절차 본문" }),
  ]);
  assert.ok(!idx.includes("fixK1") && !idx.includes("픽스처제목ZZK"), "recalled 는 정적 주입 안 됨");
  assert.ok(!idx.includes("픽스처제목ZZH"), "recalled 는 정적 주입 안 됨");
});

// ── (categories) 카테고리 지도 — 전 카테고리를 space 별 'key — name (active수)' 로(발견용, product→business 순). ──
t("categories: 카테고리 지도가 space 별로 key — name (N) 렌더(product→business 순)", () => {
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

// ── (wiki-b) ${wiki} 미배치 템플릿이면 핀이 있어도 미출력(opt-in 배치). ──
t("wiki-b: ${wiki} 미배치면 핀 지식이 있어도 주입 안 됨(opt-in 배치)", () => {
  const idx = buildKnowledgeIndex(
    [unit({ name: "pinned", injection: "recalled", title: "핀된것", is_wiki: true })],
    [], "# 고정\n\n본문없음",
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

// ── (guide) 맥락 로드/기록 가이드는 기본 템플릿에 항상 박힌다(빈 입력에도). ──
t("guide: 맥락 로드/기록 가이드가 항상 주입된다(빈 입력에도)", () => {
  const idx = buildKnowledgeIndex([], []);
  assert.ok(idx.includes("## 맥락 로드/기록 가이드"), "로드/기록 가이드 헤더");
  assert.ok(idx.includes("knowledge_save"), "기록=knowledge_save 안내");
});

// ── (mask) H1-b 시크릿 출력게이트: 동적 블록(카테고리 표시명)·템플릿 본문의 시크릿이 [REDACTED] 로 마스킹(서빙=throw 금지). ──
t("mask: 카테고리 표시명·템플릿 본문의 토큰이 [REDACTED] 로 마스킹", () => {
  const idx = buildKnowledgeIndex(
    [], [category({ space: "product", key: "k", name: "area 이름 lvk_zyxwvutsrqponmlkjihgfedcba" })],
    "키 sk-ABCDEFGHIJKLMNOP1234 가 템플릿에\n\n${categories}",
  );
  assert.ok(!idx.includes("lvk_zyxwvutsrqponmlkjihgfedcba"), "카테고리 표시명 토큰 마스킹");
  assert.ok(!idx.includes("sk-ABCDEFGHIJKLMNOP1234"), "템플릿 본문 토큰 마스킹");
  assert.ok(idx.includes("[REDACTED]"), "마스킹 토큰");
});

t("mask: 시크릿 없는 정상 입력은 마스킹 없이 원문 유지", () => {
  const idx = buildKnowledgeIndex([], [category({ space: "product", key: "billing", name: "결제" })]);
  assert.ok(!idx.includes("[REDACTED]"));
  assert.ok(idx.includes("- billing — 결제"));
});

// ── (idem) WYSIWYG 불변식: 같은 입력 → byte-identical, 헤더 중복 누적 0. ──
t("idem: 멱등 — 같은 입력 2회 호출 byte-identical(중복 누적 0)", () => {
  const amap = [category({ space: "product", key: "k1", name: "n1", active_units: 3 })];
  const a = buildKnowledgeIndex([], amap);
  const b = buildKnowledgeIndex([], amap);
  assert.equal(a, b, "동일 입력은 동일 출력(결정적 = WYSIWYG byte-identical)");
  assert.equal((a.match(/# Knowledge Index/g) ?? []).length, 1, "헤더 정확히 1개");
  assert.equal((a.match(/## 강제 규칙/g) ?? []).length, 0, "강제 규칙 섹션은 폐기(0개)");
  assert.equal((a.match(/## 카테고리/g) ?? []).length, 1, "카테고리 지도 헤더 1개");
  assert.equal((a.match(/## 맥락 로드\/기록 가이드/g) ?? []).length, 1, "로드/기록 가이드 헤더 1개");
});

console.log(`\n${pass} checks passed`);

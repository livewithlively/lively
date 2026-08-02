// buildKnowledgeIndex / substituteBlocks 단위 체크 — DB 불요(순수 함수). 테스트 러너 없이 node:assert 로 자급.
// 실행: npm run build && node dist/org/delivery/knowledge-index.test.js
// #335 재작성: 항상-주입의 '강제 규칙(R/${rules})' 경로는 폐기됐다(항상-주입 = 섹션 문서뿐). 이 파일은 남은
//  동적 치환(${team}/${categories}/${wiki})·발견 지도·마스킹·멱등(WYSIWYG byte-identical)을 검증한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildKnowledgeIndex, substituteBlocks, effectiveSectionTemplate, isLockedSection, DEFAULT_CONTEXT_ONTOLOGY_GUIDE, CONTEXT_ONTOLOGY_GUIDE_SECTION, type CategoryMapEntry } from "./knowledge-index.js";
import type { KnowledgeRow } from "../../v6/knowledge-store.js";

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
  is_folder: over.is_folder ?? false,   // #592 폴더 노드 — 인덱스 조립엔 무관(기본 false)
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
  // #533: MCP 도구는 대부분 REST로도 열려 있고, 코드/기계적 호출 상황에서 REST 사용 가능 — 이 안내가 항상 주입되어야 한다.
  assert.ok(idx.includes("MCP 도구는 대부분 REST로도 열려 있다"), "기록: MCP 대부분 REST 지원 안내");
  assert.ok(idx.includes("/api/ui/knowledge"), "기록: REST 엔드포인트 예시");
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
  // #906: '# Knowledge Index' H1 제거 — 이 템플릿은 주입 블록의 한 섹션이라 문서 제목이 필요 없고, org DB 섹션엔
  //  원래 없어서 코드↔DB 드리프트의 한 축이었다. 0개로 못박아 무심코 되살아나는 걸 막는다(중복 누적 가드는 아래 3줄이 유지).
  assert.equal((a.match(/# Knowledge Index/g) ?? []).length, 0, "H1 헤더 없음(#906 — 코드↔DB 통일)");
  assert.equal((a.match(/## 강제 규칙/g) ?? []).length, 0, "강제 규칙 섹션은 폐기(0개)");
  assert.equal((a.match(/## 카테고리/g) ?? []).length, 1, "카테고리 지도 헤더 1개");
  assert.equal((a.match(/## 맥락 로드\/기록 가이드/g) ?? []).length, 1, "로드/기록 가이드 헤더 1개");
});

// ── (#1245) 잠금(제품 소유) 섹션 — 사양: 본문은 항상 코드 기본값(행 무시), org 는 주입 여부만 정한다. ──
//  엣지 표(스크래치 spec.md)의 행 1~11 을 전부 시나리오로. GUIDE = 잠금 키(현재 유일).
const GUIDE = CONTEXT_ONTOLOGY_GUIDE_SECTION;
t("lock 표1-3: 잠금 키는 행 상태(스냅샷/빈 행/행 없음)와 무관하게 항상 코드 기본값 — 행 동결 드리프트(#537/#1242) 차단", () => {
  assert.equal(effectiveSectionTemplate(GUIDE, "## 옛날에 복사된 스냅샷 본문", true), DEFAULT_CONTEXT_ONTOLOGY_GUIDE, "표1: 스냅샷 행 무시");
  assert.equal(effectiveSectionTemplate(GUIDE, "", true), DEFAULT_CONTEXT_ONTOLOGY_GUIDE, "표2: 빈 행도 기본값");
  assert.equal(effectiveSectionTemplate(GUIDE, null, true), DEFAULT_CONTEXT_ONTOLOGY_GUIDE, "표3: 행 없음(null)도 기본값");
  assert.equal(effectiveSectionTemplate(GUIDE, undefined, true), DEFAULT_CONTEXT_ONTOLOGY_GUIDE, "표3: undefined 도 기본값");
});

t("lock 표4: 주입 토글 off 면 잠금 섹션은 null(미주입) — 행 본문이 있어도", () => {
  assert.equal(effectiveSectionTemplate(GUIDE, "무엇이든", false), null);
  assert.equal(effectiveSectionTemplate(GUIDE, null, false), null);
});

t("lock 표5-8: 일반 섹션은 행 본문 그대로(토글 무관) — 잠금은 가이드 키에만 국한", () => {
  assert.equal(effectiveSectionTemplate("org-defaults", "조직 본문", false), "조직 본문", "표5: 토글 off 여도 렌더");
  assert.equal(effectiveSectionTemplate("org-defaults", "조직 본문", true), "조직 본문", "표6");
  assert.equal(effectiveSectionTemplate("custom-sec", null, true), null, "표7: 행 없음 → 렌더 없음");
  const empty = effectiveSectionTemplate("custom-sec", "", true);
  assert.ok(!empty || !empty.trim(), "표8: 빈 행 → 렌더 없음(빈 값)");
});

t("lock 표9-10: 잠금 판정은 가이드 키 정확 일치만 — org-defaults·임의 키·대소문자 변형은 일반", () => {
  assert.ok(isLockedSection(GUIDE), "표9: 가이드 키는 잠금");
  assert.ok(!isLockedSection("org-defaults"), "표9: 조직 섹션은 잠금 아님(계속 편집 가능)");
  assert.ok(!isLockedSection("custom-sec"), "표9: 임의 키 아님");
  assert.ok(!isLockedSection(""), "표9: 빈 키 아님");
  assert.ok(!isLockedSection("Context-Ontology-Guide"), "표10: 대소문자 변형은 정확 일치 실패 → 일반 취급");
  assert.equal(effectiveSectionTemplate("Context-Ontology-Guide", "x", true), "x", "표10: 변형 키는 일반 규칙(행 본문)");
});

t("lock 표11: 코드 기본 가이드에 외부 MCP 라우팅 원칙(#1242)·플레이스홀더가 실려 있다(릴리스=갱신의 내용 검증)", () => {
  assert.ok(DEFAULT_CONTEXT_ONTOLOGY_GUIDE.includes("외부 서비스 MCP 는 라이블리 `ext__*` 가 기본이다"), "ext__ 우선 원칙 불릿");
  assert.ok(DEFAULT_CONTEXT_ONTOLOGY_GUIDE.includes("${categories}"), "카테고리 플레이스홀더 보존");
  assert.ok(DEFAULT_CONTEXT_ONTOLOGY_GUIDE.includes("${wiki}"), "위키 플레이스홀더 보존");
});

// ── (#1247 E9) ${wiki} 소스 배선 — 세 표면이 '핀 전량 조회'를 넘겨야 한다. ──
//  buildWikiBlock 의 is_wiki 필터는 **방어용**이지 선별 장치가 아니다. 여기에 일반 목록의 한 페이지를 넘기면
//  그 페이지 안에서만 골라, 창 밖 핀이 인덱스에서 조용히 빠진다 — 2026-07-29 실제 사고(고객사 A 실박스:
//  활성 1,173건 → 핀 3건 중 1건만 주입). 렌더는 순수함수라 이 오배선을 스스로 감지할 수 없고,
//  세 표면 중 하나만 되돌아가도 "미리보기는 맞는데 주입은 틀린" 상태가 되어 사람이 고쳐졌다고 오판한다.
//  그래서 배선을 텍스트로 못 박는다(선례: deploy/journal-access-order.test.mjs — 조용한 no-op 배치를 락).
{
  const here = dirname(fileURLToPath(import.meta.url));          // dist/org/delivery → 레포 루트
  const srcOf = (rel: string): string => readFileSync(join(here, "..", "..", "..", "src", rel), "utf8");
  const SURFACES: [string, string][] = [
    ["org/delivery/publish.ts", "세션 주입(previewMemberContext → SessionStart 훅)"],
    ["capabilities/delivery/org-content.ts", "관리탭 미리보기(org_guide_preview)"], // #1313 R26: delivery.ts 도메인 분할로 이동
    ["org/delivery/knowledge-index.ts", "발행물(knowledge-index.md)"],
  ];
  for (const [rel, what] of SURFACES) {
    t(`#1247 E9: ${what} 의 \${wiki} 소스 = 핀 전량(listWikiPins)`, () => {
      const src = srcOf(rel);
      assert.match(src, /listWikiPins\(/, `${rel}: 핀 전량 조회를 안 쓰면 창 밖 핀이 주입에서 빠진다`);
      assert.doesNotMatch(src, /listKnowledge\(\s*\{[^}]*limit:\s*500/,
        `${rel}: 일반 목록 500건 페이지를 다시 넘기면 #1247 로 되돌아간다`);
    });
  }
}

console.log(`\n${pass} checks passed`);

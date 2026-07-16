// P-V3-5 Part A — 정적 폴백 context.md DB 단일소스 통합 체크.
//  실행: npm run build && node --env-file-if-exists=.env dist/org/static-context.test.js
//  ITEMS_DATABASE_URL 미설정이면 graceful skip(빌드 게이트 통과). **읽기 전용**(쓰기 없음 — 비파괴).
//  커버: (1) materializeStaticContext 가 DB 인덱스를 담는다(stale 파일기반 Canonical 아님)
//        (2) 멱등(2회 호출 byte-identical — 인덱스 중복 누적 0)
//        (3) 진실원천 통일: 정적(materializeStaticContext)·라이브(previewMemberContext)가 동일 DB 인덱스(buildKnowledgeIndex)를 공유.
import assert from "node:assert/strict";
import { materializeStaticContext, previewMemberContext } from "./publish.js";
import { getOrgProfile } from "./store.js";
import { listKnowledge } from "../v6/knowledge-store.js";
import { buildKnowledgeIndex, categoryMapForIndex, loadGuideTemplate, wikiCategoryMap } from "./materialize.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};

/** 발행자(materializeOrgContent)와 **동일한 인자**로 인덱스를 굽는다 — 기대값을 코드에 박지 않고 같은 빌더에서 파생시킨다.
 *  ⚠ 가이드 템플릿은 org 편집값(CONTEXT_ONTOLOGY_GUIDE_SECTION)이다. 그래서 코드 기본 템플릿의 헤더('# Knowledge Index')를
 *   하드코딩하면 **템플릿 제목을 편집한 조직에서 거짓 실패**한다(실제로 그랬다 — 라이블리 org 의 템플릿은 '## 컨텍스트 온톨로지 개념'
 *   으로 시작한다). 검사하려는 불변식은 '어떤 H1 이 박혔나'가 아니라 '정적·라이브가 같은 DB 인덱스를 공유하나'이므로
 *   loadGuideTemplate()/wikiCategoryMap() 까지 발행자와 맞춘 뒤 산출물 자체를 비교한다.
 *  redact 는 substituteBlocks 안에서 이미 걸리므로(materialize.ts) 발행물과 동일하게 마스킹된 문자열이 나온다.
 *  완전 빈 DB(지식·카테고리 0) → 발행자도 인덱스를 생략하므로 "" 반환. */
async function publishedIndex(): Promise<string> {
  const knowledge = await listKnowledge({ lifecycle: "active", limit: 500 });
  const categoryMap = await categoryMapForIndex();
  if (!knowledge.length && !categoryMap.length) return "";
  return buildKnowledgeIndex(knowledge, categoryMap, await loadGuideTemplate(), await wikiCategoryMap()).trim();
}

async function main(): Promise<void> {
  if (!process.env.ITEMS_DATABASE_URL) {
    console.log("skip  ITEMS_DATABASE_URL 미설정 — P-V3-5 정적 context 통합 체크 건너뜀(빌드 게이트는 통과)");
    return;
  }

  await t("정적 context.md 는 DB 인덱스를 담는다(stale 파일기반 Canonical 아님)", async () => {
    const { context } = await materializeStaticContext();
    const idx = await publishedIndex();
    assert.ok(context.length > 0, "context 비어있지 않음");
    if (idx) assert.ok(context.includes(idx), "DB 에서 구운 인덱스 전문이 정적 context 에 그대로 들어가야 함");
    assert.ok(!context.includes("Canonical Memory Index"), "stale 파일기반 Canonical Memory Index 가 들어가면 안 됨");
  });

  await t("멱등: 2회 호출 byte-identical(인덱스 중복 누적 0)", async () => {
    const a = await materializeStaticContext();
    const b = await materializeStaticContext();
    assert.equal(a.context, b.context, "같은 DB 상태 → 동일 출력(결정적)");
    const idx = await publishedIndex();
    if (idx) assert.equal(a.context.split(idx).length - 1, 1, "인덱스는 정확히 1번만(중복 누적 없음)");
  });

  await t("진실원천 통일: 정적·라이브가 동일 DB 인덱스(buildKnowledgeIndex)를 공유", async () => {
    const p = await getOrgProfile();
    const name = p.display_name?.trim() || p.name?.trim() || "조직";
    const live = await previewMemberContext(name);
    const { context: stat } = await materializeStaticContext();
    // V6: 둘 다 buildKnowledgeIndex(v6 listKnowledge active, categoryMapForIndex, 편집 가이드 템플릿) 단일소스에서 인덱스를 굽는다
    //  (injection=always 전문 + 카테고리 지도 + 쓰기 가이드). recalled 제목리스트·캡·observed제외 폐기.
    //  헤더 2줄이 아니라 **인덱스 전문**을 양 표면에서 대조한다 — 헤더만 보면 본문이 갈라져도 통과한다.
    const idx = await publishedIndex();
    if (idx) {
      assert.ok(live.includes(idx), "라이브 preview 에 동일 인덱스 전문 포함");
      assert.ok(stat.includes(idx), "정적 context 에 동일 인덱스 전문 포함");
    }
  });

  console.log(`\n${pass} checks passed`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

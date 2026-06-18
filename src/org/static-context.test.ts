// P-V3-5 Part A — 정적 폴백 context.md DB 단일소스 통합 체크.
//  실행: npm run build && node --env-file-if-exists=.env dist/org/static-context.test.js
//  ITEMS_DATABASE_URL 미설정이면 graceful skip(빌드 게이트 통과). **읽기 전용**(쓰기 없음 — 비파괴).
//  커버: (1) materializeStaticContext 가 DB Knowledge Index 를 담는다(stale 파일기반 Canonical 아님)
//        (2) 멱등(2회 호출 byte-identical — 인덱스 중복 누적 0)
//        (3) 진실원천 통일: 정적(materializeStaticContext)·라이브(previewMemberContext)가 동일 DB 인덱스(buildKnowledgeIndex)를 공유.
import assert from "node:assert/strict";
import { materializeStaticContext, previewMemberContext } from "./publish.js";
import { getOrgProfile } from "./store.js";
import { listKnowledge } from "./knowledge.js";
import { buildKnowledgeIndex, areaMapForIndex } from "./materialize.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};

async function main(): Promise<void> {
  if (!process.env.ITEMS_DATABASE_URL) {
    console.log("skip  ITEMS_DATABASE_URL 미설정 — P-V3-5 정적 context 통합 체크 건너뜀(빌드 게이트는 통과)");
    return;
  }

  await t("정적 context.md 는 DB Knowledge Index 를 담는다(stale 파일기반 Canonical 아님)", async () => {
    const { context } = await materializeStaticContext();
    assert.ok(context.length > 0, "context 비어있지 않음");
    assert.ok(context.includes("# Knowledge Index"), "DB Knowledge Index 가 들어가야 함");
    assert.ok(!context.includes("Canonical Memory Index"), "stale 파일기반 Canonical Memory Index 가 들어가면 안 됨");
  });

  await t("멱등: 2회 호출 byte-identical(인덱스 중복 누적 0)", async () => {
    const a = await materializeStaticContext();
    const b = await materializeStaticContext();
    assert.equal(a.context, b.context, "같은 DB 상태 → 동일 출력(결정적)");
    assert.equal((a.context.match(/# Knowledge Index/g) ?? []).length, a.context.includes("# Knowledge Index") ? 1 : 0,
      "Knowledge Index 헤더는 최대 1개(중복 누적 없음)");
  });

  await t("진실원천 통일: 정적·라이브가 동일 DB 인덱스(buildKnowledgeIndex)를 공유", async () => {
    const p = await getOrgProfile();
    const name = p.display_name?.trim() || p.name?.trim() || "조직";
    const live = await previewMemberContext(name);
    const { context: stat } = await materializeStaticContext();
    // V4-P3: 둘 다 buildKnowledgeIndex(listKnowledge active, areaMapForIndex) 단일소스에서 인덱스를 굽는다
    //  (R 전문 + area 지도 + 쓰기 가이드). recalled 제목리스트·캡·observed제외 폐기.
    const knowledge = await listKnowledge({ lifecycle: "active" });
    const areaMap = await areaMapForIndex();
    const idx = (knowledge.length || areaMap.length) ? buildKnowledgeIndex(knowledge, areaMap).trim() : "";
    if (idx) {
      // 인덱스 본문(Knowledge Index 헤더부터)이 양 표면에 동일하게 들어있어야 단일소스.
      const head = idx.split("\n").slice(0, 2).join("\n"); // 헤더 2줄(제목 + 안내)
      assert.ok(live.includes(head), "라이브 preview 에 동일 인덱스 헤더 포함");
      assert.ok(stat.includes(head), "정적 context 에 동일 인덱스 헤더 포함");
      // 쓰기 가이드 블록(항상 박힘)이 양쪽에 동일하게 존재 — 같은 DB·같은 빌더 산출 증명.
      assert.ok(live.includes("## 지식 쓰기 가이드"), "라이브에 쓰기 가이드 존재");
      assert.ok(stat.includes("## 지식 쓰기 가이드"), "정적에 쓰기 가이드 존재");
    }
  });

  console.log(`\n${pass} checks passed`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

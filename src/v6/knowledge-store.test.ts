// resolveUpsertFacets 단위 체크 — DB 불요(순수 함수). 테스트 러너 없이 node:assert 로 자급.
// 실행: npm run build && node dist/v6/knowledge-store.test.js
//
// 프로젝트 #345 회귀 방지 — knowledge_save(upsertKnowledge)가 기존 지식 '본문만' 편집할 때 미전송 facet
//  (특히 WIKI 핀 is_wiki)을 조용히 리셋하지 않는지 잠근다. 원 증상: 핀된 지식(런북·불변식 등) 본문을 누가
//  편집하면 is_wiki 가 false 로 떨어져 매 세션 WIKI 인덱스에서 소리없이 빠짐 → 발견·소환 트리거 상실.
//  불변식: "명시(undefined 아님) 우선 → 없으면 기존(before) 보존 → 신규(before=null)면 기본값".
import assert from "node:assert/strict";
import { resolveUpsertFacets } from "./knowledge-store.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

// 핀된 기존 지식(before) — 본문만 편집(facet 전부 미전송)하는 저장을 흉내내는 스냅샷.
const pinned = { injection: "recalled", provenance: "authored", summary: "요약", sort: 5, is_wiki: true, type: "how-to" };

// ── #345 핵심: is_wiki 미전송 → 기존(true) 보존. 본문 편집이 WIKI 핀을 리셋하면 안 된다. ──
t("#345: 본문만 편집(is_wiki 미전송) → 핀(is_wiki=true) 보존", () => {
  assert.equal(resolveUpsertFacets({}, pinned).isWiki, true, "핀이 유실되면 안 됨");
});

// ── 같은 클래스의 조용한 유실 방지 — 나머지 facet 도 미전송 시 기존 보존. ──
t("본문만 편집 → injection/provenance/summary/sort/type 모두 기존 보존", () => {
  const r = resolveUpsertFacets({}, pinned);
  assert.equal(r.injection, "recalled");
  assert.equal(r.provenance, "authored");
  assert.equal(r.summary, "요약");
  assert.equal(r.sort, 5);
  assert.equal(r.type, "how-to");
});

// ── 명시값은 기존을 덮어쓴다(의도적 변경 존중). ──
t("is_wiki=false 명시 → 덮어쓰기(핀 해제 의도 존중)", () => {
  assert.equal(resolveUpsertFacets({ is_wiki: false }, pinned).isWiki, false);
});
t("injection/type 명시 → 덮어쓰기", () => {
  const r = resolveUpsertFacets({ injection: "always", type: "reference" }, pinned);
  assert.equal(r.injection, "always");
  assert.equal(r.type, "reference");
});

// ── 신규(before=null) → 기본값. ──
t("신규(before=null): is_wiki false, injection recalled, provenance authored, summary null, sort 0, type null", () => {
  const r = resolveUpsertFacets({}, null);
  assert.equal(r.isWiki, false);
  assert.equal(r.injection, "recalled");
  assert.equal(r.provenance, "authored");
  assert.equal(r.summary, null);
  assert.equal(r.sort, 0);
  assert.equal(r.type, null);
});

// ── 경계: null/0 '명시'는 undefined(미전송)와 구분되어 그대로 적용된다. ──
t("summary=null 명시 → null 로 덮어씀(미전송 보존과 구분)", () => {
  assert.equal(resolveUpsertFacets({ summary: null }, pinned).summary, null);
});
t("sort=0 명시 → 0 적용(기존 5 로 되돌아가지 않음)", () => {
  assert.equal(resolveUpsertFacets({ sort: 0 }, pinned).sort, 0);
});

// ── before 가 부분적(is_wiki 없음)이면 기본값으로 폴백. ──
t("before 에 is_wiki 없음 → 기본 false 폴백", () => {
  assert.equal(resolveUpsertFacets({}, { injection: "recalled" }).isWiki, false);
});

console.log(`\n${pass} passed`);

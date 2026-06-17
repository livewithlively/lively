// buildKnowledgeIndex 단위 체크 — DB 불요(순수 함수). 테스트 러너 없이 node:assert 로 자급.
// 실행: npm run build && node dist/org/materialize.test.js
// 커버: (1) H1-b 시크릿 출력게이트(제목/요약 마스킹) (2) recalled kind 필터·섹션화 (3) 재발행 멱등(중복 누적 0).
import assert from "node:assert/strict";
import { buildKnowledgeIndex } from "./materialize.js";
import type { KnowledgeUnit } from "./knowledge.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

// 최소 KnowledgeUnit 팩토리 — 전 필드 채움(buildKnowledgeIndex 는 일부만 읽지만 타입 충실).
const unit = (over: Partial<KnowledgeUnit>): KnowledgeUnit => ({
  name: "u",
  kind: "K",
  kinds: [],
  title: null,
  body_md: "",
  domain_key: null,
  domain_repo: null,
  lifecycle: "active",
  supersedes: null,
  confidence: "human",
  author: null,
  source_ref: null,
  as_of: null,
  sort: 0,
  version: 1,
  updated_at: null,
  updated_by: null,
  ...over,
});

// ── H1-b: 제목에 평문 시크릿이 있으면 마스킹된다(서빙 경로 = throw 금지, 마스킹만) ──
t("H1-b: 제목의 OpenAI 키가 [REDACTED] 로 마스킹", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "leaky", kind: "K", title: "키 sk-ABCDEFGHIJKLMNOP1234 노출", body_md: "본문" }),
  ]);
  assert.ok(!idx.includes("sk-ABCDEFGHIJKLMNOP1234"), "원본 키가 인덱스에 남아선 안 됨");
  assert.ok(idx.includes("[REDACTED]"), "마스킹 토큰이 있어야 함");
  assert.ok(idx.includes("ctx_cat name=leaky"), "정상 메타는 보존");
});

t("H1-b: 요약(첫 본문줄)의 라이블리 토큰이 마스킹", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "doc", kind: "F", title: "정상 제목", body_md: "lvk_abcdefghijklmnopqrstuvwxyz 가 본문에" }),
  ]);
  assert.ok(!idx.includes("lvk_abcdefghijklmnopqrstuvwxyz"), "본문 토큰이 요약에 누출되면 안 됨");
  assert.ok(idx.includes("[REDACTED]"));
});

t("H1-b: 시크릿 없는 정상 유닛은 마스킹 없이 원문 유지", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "clean", kind: "K", title: "깨끗한 지식", body_md: "평범한 요약 본문" }),
  ]);
  assert.ok(!idx.includes("[REDACTED]"));
  assert.ok(idx.includes("깨끗한 지식 — 평범한 요약 본문"));
});

// ── recalled kind 필터: K/D/F/H 만 섹션화, 그 외(R/S/A/W/…)는 인덱스 제외 ──
t("recalled kind 필터: A/W(수집물)·R 은 인덱스에서 제외", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "k1", kind: "K", title: "지식" }),
    unit({ name: "a1", kind: "A", title: "활동수집물" }),
    unit({ name: "w1", kind: "W", title: "태스크수집물" }),
    unit({ name: "r1", kind: "R", title: "강제규칙전문" }),
  ]);
  assert.ok(idx.includes("ctx_cat name=k1"), "K 는 포함");
  assert.ok(!idx.includes("ctx_cat name=a1"), "A 는 제외(query kind)");
  assert.ok(!idx.includes("ctx_cat name=w1"), "W 는 제외(query kind)");
  assert.ok(!idx.includes("ctx_cat name=r1"), "R 은 제외(enforced=전문 주입, 인덱스 아님)");
});

t("lifecycle!=active 는 방어적으로 제외", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "live", kind: "K", title: "활성", lifecycle: "active" }),
    unit({ name: "dead", kind: "K", title: "폐기", lifecycle: "superseded" }),
  ]);
  assert.ok(idx.includes("ctx_cat name=live"));
  assert.ok(!idx.includes("ctx_cat name=dead"));
});

// ── H2(P-V3-3a): confidence='observed'(커넥터 수집물) 는 recalled kind(K/D) 여도 인덱스에서 영구 제외 ──
t("H2: observed 는 recalled kind(K/D) 여도 주입 인덱스에서 영구 제외", () => {
  const idx = buildKnowledgeIndex([
    unit({ name: "curated", kind: "K", title: "큐레이션 지식", confidence: "human" }),
    unit({ name: "obsK", kind: "K", title: "수집된 K", confidence: "observed" }),
    unit({ name: "obsD", kind: "D", title: "수집된 D", confidence: "observed", domain_key: "billing" }),
  ]);
  assert.ok(idx.includes("ctx_cat name=curated"), "큐레이션 K 는 포함");
  assert.ok(!idx.includes("ctx_cat name=obsK"), "observed K 는 인덱스 제외");
  assert.ok(!idx.includes("ctx_cat name=obsD"), "observed D 는 인덱스 제외");
});

// ── 재발행 멱등(L): 같은 입력 → 같은 출력, 인덱스 블록 중복 누적 없음 ──
t("멱등: 같은 입력 2회 호출 → 동일 출력(중복 누적 0)", () => {
  const units = [
    unit({ name: "k1", kind: "K", title: "A", updated_at: new Date("2026-06-10").toISOString() }),
    unit({ name: "d1", kind: "D", title: "B", updated_at: new Date("2026-06-11").toISOString() }),
  ];
  const a = buildKnowledgeIndex(units);
  const b = buildKnowledgeIndex(units);
  assert.equal(a, b, "동일 입력은 동일 출력(결정적)");
  // 헤더가 정확히 1번(블록 중복 누적 없음) — 정적 context.md 재발행 시 인덱스 중복 방지의 함수-레벨 보증.
  assert.equal((a.match(/# Knowledge Index/g) ?? []).length, 1, "헤더는 정확히 1개");
  assert.equal((a.match(/## Knowledge \(K\)/g) ?? []).length, 1, "K 섹션 헤더 1개");
});

// ── P-V3-2 하드코딩 제거: 섹션 정책(recalled kind)을 인자로 주입(=kind_registry 가 권위, non-stale) ──
t("recalledKinds 인자가 섹션/순서/라벨을 결정한다(레지스트리 주입)", () => {
  const units = [
    unit({ name: "k1", kind: "K", title: "지식" }),
    unit({ name: "f1", kind: "F", title: "사실" }),
    unit({ name: "h1", kind: "H", title: "절차" }),
  ];
  // 레지스트리가 F 만 recalled 라고 말하면(가상 정책) F 섹션만 나오고 K/H 는 제외돼야 한다(상수 하드코딩 아님 증명).
  const idx = buildKnowledgeIndex(units, [{ kind: "F", label: "사실섹션" }]);
  assert.ok(idx.includes("## 사실섹션 (F)"), "인자로 준 라벨/순서로 섹션 출력");
  assert.ok(idx.includes("ctx_cat name=f1"), "F 는 포함");
  assert.ok(!idx.includes("ctx_cat name=k1") && !idx.includes("ctx_cat name=h1"), "인자에 없는 kind 는 제외");
});

console.log(`\n${pass} checks passed`);

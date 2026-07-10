// raw-PII 언마스크 grant(P4, #746) 단위 체크 — getSourcePolicy/getMaskStyleMap/resolveMaskedAttrs 의 unmask 반영.
// 실행: npm run build && node dist/db/unmask.test.js
//  resolveUnmaskKeys(DB grant 해소)는 실 pg 통합(scripts/integration/db-access-log-pg.mjs 계열)에서 확인 — 여기선 순수 필터 로직.
import assert from "node:assert/strict";
import { getSourcePolicy, getMaskStyleMap, resolveMaskedAttrs, _resetPolicyCacheForTest } from "./policy.js";

let pass = 0;
const t = (name: string, fn: () => void | Promise<void>): Promise<void> | void => {
  const r = fn();
  if (r instanceof Promise) return r.then(() => { pass++; console.log(`ok  ${name}`); });
  pass++; console.log(`ok  ${name}`);
};

// policy 스냅샷을 직접 심는다(refreshPolicy 우회 — DB 불요). _snap 은 모듈 내부라 리셋 후 최소 재구성.
// getSourcePolicy 는 snapOf(내부 _snap)만 읽으므로, 여기선 마스킹 없는 소스(빈 스냅샷) 기준 unmask 무해성 +
// getMaskStyleMap/resolveMaskedAttrs 의 unmask 필터(입력 맵 직접 전달 경로)를 검증한다.

// ── getMaskStyleMap: 인자 unmask 로 키 제거 (snapOf 빈 소스라 빈 맵 — 필터 자체는 아래 pg 경로로) ──
t("getSourcePolicy: 빈 소스 + unmask → hasMasks=false, 안전(무해)", () => {
  _resetPolicyCacheForTest();
  const p = getSourcePolicy("nope", new Set(["t.ssn"]));
  assert.equal(p.hasMasks, false);
  assert.equal(p.maskedCols.size, 0);
});

// ── resolveMaskedAttrs: pg 카탈로그 목 → unmask 로 특정 컬럼 마스킹 제외 ──
// snapOf 가 빈 소스면 styleMap 이 비어 카탈로그 조회를 안 하므로, 이 테스트는 정책 스냅샷이 필요.
// 대신 resolveMaskedAttrs 의 unmask 필터는 "카탈로그가 채운 base.attr 에서 unmask 키를 뺀다"는 순수 후처리 —
// 이를 검증하기 위해 정책 스냅샷을 리플렉션 없이 심을 수 없으므로, 통합 스크립트(db-access-log-pg)가 실 pg 로 커버.
// 여기서는 최소한 "unmask 없을 때 == 기존 동작"과 "빈 unmask 무해"만 순수 확인.
await t("resolveMaskedAttrs: 마스킹 없는 소스 → 빈 맵(unmask 유무 무관)", async () => {
  _resetPolicyCacheForTest();
  const q = { query: async () => ({ rows: [] as Array<Record<string, unknown>> }) };
  const a = await resolveMaskedAttrs("nope", q);
  const b = await resolveMaskedAttrs("nope", q, new Set(["t.ssn"]));
  assert.equal(a.size, 0);
  assert.equal(b.size, 0);
});

// getMaskStyleMap 은 snapOf(source).maskStyle 를 unmask 로 필터 — 빈 소스라 빈 맵이지만 unmask 경로가 throw 없이 도는지.
t("getMaskStyleMap: unmask 전달해도 안전(빈 소스)", () => {
  _resetPolicyCacheForTest();
  const m = getMaskStyleMap("nope", new Set(["a.b"]));
  assert.equal(m.size, 0);
});

// ── 감사 정확성(리뷰 blocking 회귀) — 언마스크 컬럼은 '출력 필드' 기준, grant_ids 는 관여 grant 만 ──
//  db_query 핸들러의 감사-필드 도출 로직을 순수 함수로 추출한 형태로 검증(핸들러는 외부 소스 필요 → 여기선 로직만).
//  fields=출력 컬럼(srcKey), unmaskKeys=언마스크 대상, grantsByKey=컬럼별 grant. mysql srcKey=table.col 가정.
function deriveUnmaskAudit(
  fields: Array<{ srcKey?: string | null }>,
  unmaskKeys: Set<string>,
  grantsByKey: Map<string, string[]>,
): { cols: string[]; grantIds: string[] } {
  const outCols = new Set<string>();
  for (const f of fields) { if (f.srcKey && unmaskKeys.has(f.srcKey)) outCols.add(f.srcKey); }
  const gidSet = new Set<string>();
  for (const c of outCols) for (const g of (grantsByKey.get(c) ?? [])) gidSet.add(g);
  return { cols: [...outCols], grantIds: [...gidSet] };
}

t("감사: PII 컬럼이 출력에 없으면(COUNT(*)) 언마스크 0 · grant_ids 0 (과다기록 방지)", () => {
  const unmaskKeys = new Set(["users.ssn", "users.phone"]);
  const grantsByKey = new Map([["users.ssn", ["gA"]], ["users.phone", ["gB"]]]);
  // SELECT COUNT(*) FROM users — 출력 필드에 PII 컬럼 srcKey 없음
  const r = deriveUnmaskAudit([{ srcKey: null }], unmaskKeys, grantsByKey);
  assert.deepEqual(r.cols, []);
  assert.deepEqual(r.grantIds, []);
});
t("감사: ssn 만 출력 → ssn·gA 만 기록(phone·gB 제외)", () => {
  const unmaskKeys = new Set(["users.ssn", "users.phone"]);
  const grantsByKey = new Map([["users.ssn", ["gA"]], ["users.phone", ["gB"]]]);
  const r = deriveUnmaskAudit([{ srcKey: "users.ssn" }, { srcKey: "users.id" }], unmaskKeys, grantsByKey);
  assert.deepEqual(r.cols, ["users.ssn"]);
  assert.deepEqual(r.grantIds, ["gA"]);
});
t("감사: 한 컬럼을 여러 grant 가 열면 grant_ids 합집합(중복 제거)", () => {
  const r = deriveUnmaskAudit([{ srcKey: "users.ssn" }], new Set(["users.ssn"]), new Map([["users.ssn", ["gA", "gB"]]]));
  assert.deepEqual(r.grantIds.sort(), ["gA", "gB"]);
});

console.log(`\nunmask tests: ${pass} passed`);

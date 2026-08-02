// 증류기 저장의 부분 갱신 계약(#1289 회귀 가드) — 안 보낸 필드를 지우지 않는다.
//
// 왜 이 테스트가 있나: upsertDistiller 는 미지정 필드를 **기본값으로 덮어썼다**(enabled ?? false 등).
// 그래서 `{key, batch_size}` 한 줄이 그 증류기의 기준·형식·채널·사전필터를 통째로 날렸다.
// 실측(2026-07-31): batch_size 만 3→1 로 바꾸려던 호출이 튜닝한 키워드 62개와 criteria 3,458자를 지우고
// enabled 까지 false 로 꺼뜨렸다 — 증류가 멈췄고 잔량이 24→306 으로 튀었다(필터가 사라져서).
// 툴 설명("같은 key 로 다시 저장하면 갱신")도, 모든 필드가 optional 인 스키마도 부분 갱신을 약속한다.
// 약속과 동작이 어긋난 자리였고, 되돌릴 수단이 감사 로그뿐이었다.
//
// DB 없이 검증한다 — 병합 규칙(무엇을 유지하고 무엇을 덮나)이 이 결함의 전부이므로 그 규칙만 재현해 못박는다.
import { strict as assert } from "node:assert";
import { pickDistillerField } from "../store.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// 실제 병합 규칙(store.pickDistillerField)을 그대로 태운다 — 테스트가 제 사본을 검증하지 않게.
//  upsertDistiller 는 필드마다 이 함수로 '보낸 값 vs 기존 값'을 고른 뒤 UPDATE 에 싣는다.
function merge(input: Record<string, unknown>, before: Record<string, unknown> | undefined,
               defaults: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(defaults)) out[k] = pickDistillerField(input, before, k, input[k] ?? defaults[k]);
  return out;
}

const DEFAULTS = { enabled: false, priority: 0, criteria_md: null, format_md: null, prefilter_rules: null, batch_size: 3, include_channels: null };
const EXISTING = {
  enabled: true, priority: 50, criteria_md: "기준 3,458자…", format_md: "형식…",
  prefilter_rules: { keywords: ["하기로", "결정"], match: "any", min_decisive: 1 },
  batch_size: 3, include_channels: ["hf여신_제품_업무논의"],
};

// U1 — 이번 사고 그대로: batch_size 만 보낸다.
t("U1 한 필드만 보내면 나머지는 **전부 유지**된다(이번 사고의 재현)", () => {
  const r = merge({ key: "hf-yeosin-product", batch_size: 1 }, EXISTING, DEFAULTS);
  assert.equal(r.batch_size, 1, "보낸 값은 반영돼야 한다");
  assert.equal(r.enabled, true, "안 보낸 enabled 가 false 로 꺼지면 증류가 멈춘다");
  assert.equal(r.priority, 50);
  assert.equal(r.criteria_md, EXISTING.criteria_md, "기준이 날아가면 조직 공통 기본으로 증류된다(팀 기준 상실)");
  assert.deepEqual(r.prefilter_rules, EXISTING.prefilter_rules, "튜닝한 사전필터가 날아가면 잔량이 폭증한다");
  assert.deepEqual(r.include_channels, EXISTING.include_channels, "채널이 날아가면 스코프가 전체로 열린다");
});

// U2 — 비움은 유지와 다르다. 명시적 null 은 지우는 뜻이다.
t("U2 명시적 null 은 '지우기'로 반영된다(유지와 구분)", () => {
  const r = merge({ key: "k", criteria_md: null, prefilter_rules: null }, EXISTING, DEFAULTS);
  assert.equal(r.criteria_md, null, "명시적으로 비운 건 비워져야 한다");
  assert.equal(r.prefilter_rules, null);
  assert.equal(r.enabled, true, "그 와중에 다른 필드는 여전히 유지");
});

// U3 — false·0 처럼 falsy 한 값도 '보낸 값'이다(truthy 검사로 구현하면 여기서 깨진다).
t("U3 false·0 을 보내면 그대로 반영된다(falsy 를 '미지정'으로 오해하지 않는다)", () => {
  const r = merge({ key: "k", enabled: false, priority: 0 }, EXISTING, DEFAULTS);
  assert.equal(r.enabled, false, "끄려고 보낸 false 가 무시되면 증류기를 끌 수 없다");
  assert.equal(r.priority, 0);
});

// U4 — 신규 생성은 종전대로 기본값. 부분 갱신이 신규 경로를 바꾸면 안 된다.
t("U4 기존 행이 없으면(신규) 기본값이 쓰인다", () => {
  const r = merge({ key: "new" }, undefined, DEFAULTS);
  assert.equal(r.enabled, false, "신규는 꺼진 채로 만들어져 사람이 확인 후 켠다");
  assert.equal(r.batch_size, 3);
  assert.equal(r.criteria_md, null);
});

// U5 — 빈 입력(key 만)은 아무것도 바꾸지 않는다.
t("U5 key 만 보내면 행이 그대로다(무해한 no-op)", () => {
  assert.deepEqual(merge({ key: "hf-yeosin-product" }, EXISTING, DEFAULTS), { ...EXISTING });
});

console.log(`distiller-upsert.test: ok (${pass})`);

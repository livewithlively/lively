// #1643 권한 밖 도구를 MCP 표면에서 소거하는 규칙 검증 — DB 없이(registry + mock server), node:assert 자급.
//  실행: npm run build && node dist/capabilities/scope-exposure.test.js
//
// 왜 이 규칙이 생겼나 — 고객사 도입 첫 40일 실측(MCP 로그 10,050콜):
//  · 관리 계열 호출 54건이 **전부** scope 부족으로 차단됐고 성공은 0건이었다.
//  · 시도자는 12명 = 활성 사용자 거의 전원. 목록에 보이니까 한 번씩 두드렸다는 뜻이다.
//  · 그중 변경성 도구는 3건뿐이고 나머지는 전부 조회성이었다(org_hooks·cron_list·managed_session_list…).
// 결론: 못 쓰는 도구를 목록에 남겨 두는 것 자체가 마찰이다. 읽기전용 세션(#1007)이 쓰기 툴을 소거하는 것과
//  같은 자리·같은 이유로 소거한다 — 하네스가 그 도구의 존재조차 모르게.
//
// ⚠ 이 파일이 지키는 가장 중요한 불변식은 "숨긴다"가 아니라 **"미상일 땐 숨기지 않는다"** 다.
//  인증 파싱이 한 번 어긋난 순간 admin 이 도구를 통째로 잃으면 그게 훨씬 큰 사고다(fail-safe).
import assert from "node:assert/strict";
import { registry, registerMcpCapabilities } from "./index.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// mock server — 등록된 도구 이름만 모은다(readonly.test.ts 와 같은 수법).
const registered = (scopes?: readonly string[], readOnly = false): string[] => {
  const names: string[] = [];
  registerMcpCapabilities(
    { registerTool: (n: string) => names.push(n) } as never,
    undefined, undefined, null, readOnly, false, scopes,
  );
  return names;
};

// 실측에서 실제로 차단된 도구들. scope 값은 **registry 에서 읽는다** — 여기 하드코딩하면
//  나중에 그 도구의 scope 가 바뀌었을 때 테스트가 조용히 헛돈다.
const FIELD_BLOCKED = ["org_hooks", "managed_session_list", "org_harness_assets", "org_connectors", "cron_list", "org_credentials"];
const scopeOf = (name: string): string => {
  const cap = registry.get(name);
  if (!cap) throw new Error(`registry missing capability: ${name}`);
  if (!cap.scope) throw new Error(`${name} 은 scope 가 없다 — 이 테스트의 전제(권한 도구)가 깨졌다`);
  return cap.scope;
};
// scope 가 없는(=누구나 쓰는) 도구 하나 — 권한 필터가 이런 도구까지 삼키면 안 된다.
const openCap = (): string => {
  for (const cap of registry.values()) {
    if (cap.expose?.mcp === true && !cap.scope) return cap.name;
  }
  throw new Error("scope 없는 MCP capability 가 하나도 없다 — 테스트 전제 확인 필요");
};

// ── 핵심 fail-safe: 권한을 모르면 종전대로 전부 노출한다. ──
t("scopes 미상(undefined) → 아무것도 숨기지 않는다(무회귀·fail-safe)", () => {
  const names = registered(undefined);
  for (const n of FIELD_BLOCKED) assert.ok(names.includes(n), `미상일 때 ${n} 이 사라지면 안 된다`);
});

// ── 빈 배열은 '미상'이 아니라 '권한 없음'이다. ──
t("scopes=[] → 권한이 필요한 도구는 전부 사라진다", () => {
  const names = registered([]);
  for (const n of FIELD_BLOCKED) assert.ok(!names.includes(n), `권한 없음인데 ${n} 이 보인다`);
});

t("scopes=[] 여도 scope 없는 도구는 남는다(권한 필터가 공개 도구를 삼키지 않는다)", () => {
  const open = openCap();
  assert.ok(registered([]).includes(open), `${open} 은 scope 가 없으니 항상 보여야 한다`);
});

// ── 실측 차단 6종: 각자의 scope 유무로 정확히 갈린다. ──
t("실측 차단 도구들 — 그 scope 가 없으면 사라지고, 있으면 보인다", () => {
  for (const n of FIELD_BLOCKED) {
    const sc = scopeOf(n);
    assert.ok(!registered(["__none__"]).includes(n), `${n}: scope 없는 주체에게 보이면 안 된다`);
    assert.ok(registered([sc]).includes(n), `${n}: scope '${sc}' 를 가졌는데 사라지면 안 된다(과잉 차단)`);
  }
});

// ── 한 scope 를 가졌다고 다른 scope 도구까지 열리면 안 된다. ──
t("scope 는 정확히 일치할 때만 연다(부분 권한이 전체를 열지 않는다)", () => {
  const admins = FIELD_BLOCKED.filter((n) => scopeOf(n) === "admin");
  const others = FIELD_BLOCKED.filter((n) => scopeOf(n) !== "admin");
  if (admins.length && others.length) {
    const names = registered(["admin"]);
    for (const n of admins) assert.ok(names.includes(n), `admin 인데 ${n} 이 안 보인다`);
    for (const n of others) assert.ok(!names.includes(n), `admin 뿐인데 ${n}(scope=${scopeOf(n)})이 보인다`);
  }
});

// ── 권한을 가지면 목록이 실제로 더 길다(필터가 살아 있다는 배선 확인). ──
//  이 단언이 없으면 "둘 다 0개"인 vacuous 통과를 못 잡는다.
t("권한이 많을수록 노출 도구가 많다 — 필터가 실제로 동작한다", () => {
  const none = registered([]).length;
  const some = registered(["admin"]).length;
  const all = registered(undefined).length;
  assert.ok(none > 0, "권한이 없어도 공개 도구는 남아야 한다");
  assert.ok(some > none, `admin 이 무권한보다 많아야 한다(${some} vs ${none})`);
  assert.ok(all > some, `미상(전체 노출)이 admin 보다 많아야 한다(${all} vs ${some})`);
});

// ── 다른 축(읽기전용)과 함께 걸려도 각자 동작한다. ──
t("읽기전용과 권한 필터는 함께 걸린다(한쪽이 다른 쪽을 무력화하지 않는다)", () => {
  const names = registered([], true);
  for (const n of FIELD_BLOCKED) assert.ok(!names.includes(n), `${n} 은 권한 없음으로 사라져야 한다`);
  assert.ok(!names.includes("knowledge_save"), "읽기전용이면 쓰기 도구도 사라져야 한다");
});

console.log(`\n${pass} passed`);

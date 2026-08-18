// 세션 공유 정책(#905 C1) resolve/normalize 단위검증 — 순수 모듈, DB 무접촉.
//  실행: npm run build && node dist/sessions/session-share.test.js
//  계약(#1752 대표 결정 2026-08-18 반영): 부재/잡값 → 기본값(enabled=true — 캡처 기본 켬) · **명시 false 만 끔** ·
//  잡값 방어 · "안 건드린 필드 보존". 종전 '명시 true 만 켬' 계약을 뒤집었다 — 아래 첫 블록이 그 뒤집힘 자체를 잠근다.
import assert from "node:assert/strict";
import { resolveSessionShare, normalizeSessionShare, DEFAULT_SESSION_SHARE, RETENTION_MAX_DAYS } from "./session-share.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

// ── 부재/잡값 → 기본값(#1752: 기본 켬). **명시 false 만 끈다** — 한 번도 설정 안 한 박스는 업그레이드로 켜진다. ──
{
  assert.deepEqual(resolveSessionShare(undefined), DEFAULT_SESSION_SHARE, "부재 → 전부 기본값");
  assert.deepEqual(resolveSessionShare(null), DEFAULT_SESSION_SHARE);
  assert.deepEqual(resolveSessionShare({}), DEFAULT_SESSION_SHARE, "빈 객체(구 DB) → 기본값");
  assert.equal(DEFAULT_SESSION_SHARE.enabled, true, "🔴 #1752 기본 켬 — 이 값이 false 로 돌아가면 대표 결정 회귀");
  assert.equal(resolveSessionShare({}).enabled, true, "🔴 한 번도 설정 안 한 박스(빈 객체) → 켜짐(업그레이드로 캡처 시작)");
  assert.equal(resolveSessionShare({ enabled: false }).enabled, false, "🔴 명시 false 는 영구 존중 — 기본값 변경이 못 되살린다");
  assert.equal(resolveSessionShare({ enabled: true }).enabled, true, "명시 true → 켜짐");
  assert.equal(resolveSessionShare({ enabled: "no" }).enabled, true, "잡값(비 boolean) → 기본값(켬) — asEnum 필드들과 같은 규약");
  assert.equal(resolveSessionShare({ enabled: 0 }).enabled, true, "falsy 라도 boolean false 아니면 기본값 — 명시 boolean 만 의미");
  ok("부재·잡값 → 기본값(켬) · 명시 false 만 끔(#1752)");
}

// ── enum 필드 잡값 방어 ──
{
  assert.equal(resolveSessionShare({ scope: "everything" }).scope, "main", "미지원 scope → 기본 main");
  assert.equal(resolveSessionShare({ scope: "tree" }).scope, "tree");
  assert.equal(resolveSessionShare({ store: "gzip" }).store, "slim", "미지원 store → 기본 slim");
  assert.equal(resolveSessionShare({ store: "raw" }).store, "raw");
  assert.equal(resolveSessionShare({ view_policy: "public" }).view_policy, "attach", "미지원 view_policy → 기본 attach");
  assert.equal(resolveSessionShare({ resume_policy: "anyone" }).resume_policy, "owner", "resume_policy 는 v1 고정 owner");
  ok("enum 필드 — 잡값이면 기본값, 유효값은 반영");
}

// ── harnesses: 미지원/중복/빈 배열 방어 ──
{
  assert.deepEqual(resolveSessionShare({ harnesses: ["claude", "codex"] }).harnesses, ["claude", "codex"]);
  assert.deepEqual(resolveSessionShare({ harnesses: ["claude", "gpt", "claude"] }).harnesses, ["claude"], "미지원(gpt) 제거 + 중복 제거");
  assert.deepEqual(resolveSessionShare({ harnesses: [] }).harnesses, DEFAULT_SESSION_SHARE.harnesses, "빈 배열 → 기본(전부 꺼지는 것 방지)");
  assert.deepEqual(resolveSessionShare({ harnesses: ["gpt"] }).harnesses, DEFAULT_SESSION_SHARE.harnesses, "전부 미지원 → 기본");
  assert.deepEqual(resolveSessionShare({ harnesses: "claude" }).harnesses, DEFAULT_SESSION_SHARE.harnesses, "배열 아님 → 기본");
  ok("harnesses — 미지원 제거·중복 제거·빈/비배열 → 기본");
}

// ── retention_days: 범위·타입 방어 ──
{
  assert.equal(resolveSessionShare({ retention_days: 7 }).retention_days, 7);
  assert.equal(resolveSessionShare({ retention_days: 0 }).retention_days, 0, "0=무제한 허용");
  assert.equal(resolveSessionShare({ retention_days: -5 }).retention_days, 0, "음수 → 기본(0=무제한, #1752)");
  assert.equal(resolveSessionShare({ retention_days: 999999 }).retention_days, RETENTION_MAX_DAYS, "상한 클램프");
  assert.equal(resolveSessionShare({ retention_days: 3.9 }).retention_days, 3, "소수 → floor");
  assert.equal(resolveSessionShare({ retention_days: "abc" }).retention_days, 0, "비수 → 기본(0=무제한, #1752)");
  assert.equal(DEFAULT_SESSION_SHARE.retention_days, 0, "🔴 #1752 기본 무제한 — '중앙 보관'이 시한부가 되면 회귀");
  ok("retention_days — 0(무제한) 기본·음수/비수 기본·상한 클램프·floor");
}

// ── normalize: "안 건드린 필드는 before 유지" (storage_policy 동형) ──
{
  const before = resolveSessionShare({ enabled: true, harnesses: ["claude"], scope: "tree", retention_days: 14, store: "raw", view_policy: "owner" });
  const after = normalizeSessionShare(before, { retention_days: 7 });   // 하나만 바꿈
  assert.equal(after.retention_days, 7, "바꾼 필드는 반영");
  assert.equal(after.enabled, true, "안 건드린 enabled 유지");
  assert.equal(after.scope, "tree", "안 건드린 scope 유지");
  assert.equal(after.store, "raw", "안 건드린 store 유지");
  assert.equal(after.view_policy, "owner", "안 건드린 view_policy 유지");
  assert.deepEqual(after.harnesses, ["claude"], "안 건드린 harnesses 유지");
  ok("normalize — patch 필드만 바뀌고 나머지는 before 보존");
}

// ── normalize 도 잡값을 방어(관리탭이 잘못 보내도 저장은 안전) ──
{
  const before = DEFAULT_SESSION_SHARE;
  const after = normalizeSessionShare(before, { scope: "nonsense" as never, retention_days: -1 as never });
  assert.equal(after.scope, "main", "잡값 scope patch → 기본으로 접힘");
  assert.equal(after.retention_days, 0, "잡값 retention patch → 기본(무제한)으로 접힘");
  ok("normalize — patch 잡값도 최종 방어(기본값으로 접힘)");
}

// ── #1752 끄기 왕복 — normalize 로 명시 false 를 저장하면 이후 resolve 가 계속 꺼진 채를 돌려준다. ──
//  (기본 켬 세계에서 '끈 조직이 계속 꺼져 있음'이 가장 중요한 안전 성질이다 — 저장→재해석 왕복으로 잠근다.)
{
  const off = normalizeSessionShare(DEFAULT_SESSION_SHARE, { enabled: false });
  assert.equal(off.enabled, false, "patch false → 꺼짐");
  assert.equal(resolveSessionShare(off).enabled, false, "저장된 false 재해석 → 여전히 꺼짐(기본값이 못 되살림)");
  ok("끄기 왕복 — 명시 false 저장→재해석 불변(#1752)");
}

// ── #1752 저장 경계 재확인 — 명시 boolean 이 아닌 값은 어느 쪽으로도 '의사 표시'가 아니다(기본값으로 접힘).
//    쓰기 검증(capability)이 엄격 boolean 을 강제하므로 DB 에 비-boolean 이 있다는 건 손상·구버전뿐 — 그때 기본값이 답.
{
  for (const v of [1, "true", "yes", {}, [], "1", 0, "false", "no"]) {
    assert.equal(resolveSessionShare({ enabled: v }).enabled, true, `enabled=${JSON.stringify(v)} 비-boolean → 기본값(켬)`);
  }
  assert.equal(resolveSessionShare({ enabled: false }).enabled, false, "boolean false 만 유일한 끄기 표현");
  ok("enabled — 비-boolean 은 기본값(켬)·boolean false 만 끔(저장 경계, #1752)");
}

console.log(`\n${pass} passed`);

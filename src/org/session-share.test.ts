// 세션 공유 정책(#905 C1) resolve/normalize 단위검증 — 순수 모듈, DB 무접촉.
//  실행: npm run build && node dist/org/session-share.test.js
//  계약: 부재/잡값 → 기본값(enabled=false) · 명시값만 반영 · 잡값 방어 · "안 건드린 필드 보존".
import assert from "node:assert/strict";
import { resolveSessionShare, normalizeSessionShare, DEFAULT_SESSION_SHARE, RETENTION_MAX_DAYS } from "./session-share.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

// ── 부재/잡값 → 기본값. 특히 enabled 는 명시 true 일 때만 켜진다(롤아웃 안전의 핵심). ──
{
  assert.deepEqual(resolveSessionShare(undefined), DEFAULT_SESSION_SHARE, "부재 → 전부 기본값");
  assert.deepEqual(resolveSessionShare(null), DEFAULT_SESSION_SHARE);
  assert.deepEqual(resolveSessionShare({}), DEFAULT_SESSION_SHARE, "빈 객체(구 DB) → 기본값");
  assert.equal(resolveSessionShare({}).enabled, false, "🔴 기본 꺼짐 — 켜기 전엔 캡처 안 함");
  assert.equal(resolveSessionShare({ enabled: "yes" }).enabled, false, "🔴 잡값 enabled 는 꺼짐(명시 true 만 켜짐)");
  assert.equal(resolveSessionShare({ enabled: 1 }).enabled, false, "🔴 truthy 라도 boolean true 아니면 꺼짐");
  assert.equal(resolveSessionShare({ enabled: true }).enabled, true, "명시 true → 켜짐");
  ok("부재·잡값 → 기본값 · enabled 는 명시 true 만 켜짐(롤아웃 안전)");
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
  assert.equal(resolveSessionShare({ retention_days: -5 }).retention_days, 30, "음수 → 기본");
  assert.equal(resolveSessionShare({ retention_days: 999999 }).retention_days, RETENTION_MAX_DAYS, "상한 클램프");
  assert.equal(resolveSessionShare({ retention_days: 3.9 }).retention_days, 3, "소수 → floor");
  assert.equal(resolveSessionShare({ retention_days: "abc" }).retention_days, 30, "비수 → 기본");
  ok("retention_days — 0 허용·음수/비수 기본·상한 클램프·floor");
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
  assert.equal(after.retention_days, 30, "잡값 retention patch → 기본으로 접힘");
  ok("normalize — patch 잡값도 최종 방어(기본값으로 접힘)");
}

// ── resolve 는 관대(잡값 접기)하지만 그게 곧 "쓰기도 관대"는 아니다 — 쓰기 검증(capability)은 별도로
//    엄격 boolean 을 강제한다(delivery.ts). 여기선 resolve 계약(=== true)이 truthy 를 안 켠다는 것만 재확인:
//    입력 경계(capability)와 저장 경계(resolve) **양쪽 다** 느슨하면 마스터 스위치가 실수로 켜질 수 있다.
{
  for (const v of [1, "true", "yes", {}, [], "1"]) {
    assert.equal(resolveSessionShare({ enabled: v }).enabled, false, `enabled=${JSON.stringify(v)} 는 켜지면 안 된다(=== true 만)`);
  }
  ok("enabled — 어떤 truthy 도 resolve 계층에서 안 켜짐(저장 경계 방어)");
}

console.log(`\n${pass} passed`);

// #699 per-member 유효 가시성 규칙 진리표 — DB 없이 도는 순수 로직.
//  이 규칙은 store.listEnabledAssets/listEnabledHooks 의 SQL CASE 와 delivery.me_assets_get 의 JS 가 동일하게 구현한다.
//  실행: npm run build && node dist/org/asset-visibility.test.js
import assert from "node:assert/strict";
import { effectiveVisible, targetsMember } from "./asset-visibility.js";

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };
const ev = (enabled: boolean, targetMembers: string[] | null, memberId: string | null, override: boolean | null) =>
  effectiveVisible({ enabled, targetMembers, memberId, override });

// ── targetsMember (관리자 정책 기본값) ──
{
  assert.equal(targetsMember(null, "yoon"), true);       // NULL = 전원
  assert.equal(targetsMember([], "yoon"), true);         // 빈 = 전원
  assert.equal(targetsMember(["yoon"], "yoon"), true);   // 지정 + 포함
  assert.equal(targetsMember(["charles"], "yoon"), false); // 지정 + 미포함
  assert.equal(targetsMember(["yoon"], null), false);    // 지정 + 익명 = 제외(안전 기본)
  assert.equal(targetsMember(null, null), true);         // NULL + 익명 = 전원
  ok("targetsMember: NULL/빈=전원, 지정=포함시만, 익명은 지정에서 제외");
}

// ── effectiveVisible: 마스터킬(enabled=false) ──
{
  assert.equal(ev(false, null, "yoon", null), false);    // 전원 대상이어도 꺼짐
  assert.equal(ev(false, null, "yoon", true), false);    // 오버라이드 on 이어도 마스터킬 이김
  assert.equal(ev(false, ["yoon"], "yoon", true), false);
  ok("effectiveVisible: enabled=false 는 마스터킬(오버라이드도 못 켬)");
}

// ── effectiveVisible: 개인 오버라이드 우선 ──
{
  // opt-out: 전원 대상인데 본인만 끔
  assert.equal(ev(true, null, "yoon", false), false);
  assert.equal(ev(true, [], "yoon", false), false);
  // opt-in: 대상 아닌데 본인만 켬(카나리 밖 멤버가 자발 opt-in)
  assert.equal(ev(true, ["charles"], "yoon", true), true);
  assert.equal(ev(true, null, "yoon", true), true);
  ok("effectiveVisible: 오버라이드가 정책 기본값을 덮는다(opt-out/opt-in)");
}

// ── effectiveVisible: 오버라이드 없으면 정책 기본값 ──
{
  assert.equal(ev(true, null, "yoon", null), true);       // 전원
  assert.equal(ev(true, [], "yoon", null), true);
  assert.equal(ev(true, ["yoon"], "yoon", null), true);   // 카나리 포함
  assert.equal(ev(true, ["charles"], "yoon", null), false); // 카나리 밖
  assert.equal(ev(true, ["yoon"], null, null), false);    // 익명 런너는 지정 자산 제외
  ok("effectiveVisible: 오버라이드 없으면 target_members 기본값 그대로");
}

// ── 카나리 롤아웃 시나리오(문서화) — #654 훅 롤아웃이 실제로 이러길 원함 ──
{
  // 관리자: spec-blind-guard 를 카나리 1명(yoon)에게만
  const target = ["yoon"];
  assert.equal(ev(true, target, "yoon", null), true);     // 카나리는 받고
  assert.equal(ev(true, target, "charles", null), false); // 나머지는 안 받고
  // 카나리 검증 후 전원 확대(target=null)
  assert.equal(ev(true, null, "charles", null), true);
  // 확대 후 한 명이 본인만 opt-out
  assert.equal(ev(true, null, "charles", false), false);
  ok("시나리오: 카나리(1명) → 전원 확대 → 개인 opt-out 이 규칙대로 동작");
}

console.log(`\n${pass} checks passed (asset-visibility #699)`);

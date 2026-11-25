// 기능 하나의 권한 판정 (#5799) — 이 기능이 컨텍스트를 바꾸는가 · 무엇을 요구하는가 · 이 주체가 그것을 갖고 있는가.
//  등록부(index.ts)를 import 하지 않는 잎이다. index.ts 가 여기를 재수출하지만, 등록부가 import 하는 capability 파일은
//  이 파일을 직결 import 한다(index ↔ 자기 자신 순환 방지 — #1313 R25).
import type { Capability } from "./types.js";
import { permits, type GrantHolder, type Need } from "../auth/permissions.js";
import { needFor } from "./permission-map.js";

// 읽기전용 모드(#1007) 판정의 단일 진실원천 — 이 capability 가 컨텍스트 스토어를 **변형(write)**하는가.
//  · cap.mutates 명시가 있으면 그것(POST인데 읽기·MCP전용 읽기 등 예외 표기).
//  · 없으면 REST 마운트 method 에서 파생: POST 마운트가 하나라도 있으면 쓰기, GET-only 면 읽기
//    (이 코드베이스 관례 = 읽기 GET·쓰기 POST. 드리프트 0 — 새 co-exposed 툴은 자동 분류).
//  · rest:false(MCP 전용) + 명시 없음 → 파생 신호 부재 → **fail-closed = 쓰기로 간주**.
//    보안 게이트라 미지정의 안전한 기본은 '차단'이다 — 새 MCP전용 쓰기 툴이 읽기전용 세션에서 조용히 새지 않게.
//    (그래서 순수 MCP전용 '읽기'는 반드시 mutates:false 를 달아야 읽기전용에서도 노출된다 — 실패해도 방향이 안전).
export function capMutates(cap: Capability): boolean {
  if (typeof cap.mutates === "boolean") return cap.mutates;
  const rest = cap.expose.rest;
  if (Array.isArray(rest) && rest.length) return rest.some((m) => m.method === "POST");
  return true;
}

// ── 권한 판정 (#5799) — 이 기능이 요구하는 것과, 이 주체가 그것을 갖고 있는가 ──
//  기능마다 새 권한(영역) × 수준(보기 · 고치기)을 요구한다(permission-map.ts 배정표 + capMutates).
//  · 새 권한이 실린 주체(역할로 옮긴 구성원)는 그 요구를 덮는지로 판정한다.
//  · 옛 scope 만 가진 주체는 **종전 그대로** «scope 배열에 cap.scope 가 들어 있나» 로 판정한다(auth/permissions.ts permits 의 머리말).
//  MCP · REST · 앱 화면 다리 세 어댑터가 이 한 판정을 쓴다 — 표면마다 다르게 막히지 않게.
export function capNeed(cap: Capability): Need | null {
  return needFor(cap.name, cap.scope, capMutates(cap));
}

export function capAllowed(user: GrantHolder | null | undefined, cap: Capability): boolean {
  return permits(user, cap.scope, capNeed(cap));
}

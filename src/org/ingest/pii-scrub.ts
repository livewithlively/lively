// 비정형 PII 스크럽 경계(#746 P3) — **타입·계약은 코어(AGPL), 탐지·마스킹 구현은 Enterprise(src/ee/ingest/pii-scrub.ts).**
//
//  호출 조건이 곧 fail-closed 설계다: 이 함수들은 `tool.pii_scrub` / `server.pii_scrub` 플래그가 **켜진**
//  프록시 경로에서만 불린다(dynamic-tools.ts · mcp-proxy.ts). 즉 스크럽을 끈 무료판은 여기에 도달하지 않고,
//  켜 놓고 EE 만 빠진 박스는 조용히 PII 를 흘리는 대신 **거부**된다 — 그게 이 경계에서 유일하게 안전한 기본값이다.
import { ee, requireEnterprise } from "../../enterprise/registry.js";

export type PiiType = "rrn" | "biznum" | "card" | "phone" | "email";
export interface PiiHit { type: PiiType; count: number }
export interface PiiScrubResult { text: string; hits: PiiHit[]; total: number }

/** 문자열의 PII 를 마스킹. 스크럽이 켜진 경로 전용 — EE 미탑재면 거부. */
export function scrubPii(input: unknown): PiiScrubResult {
  return requireEnterprise(ee().pii, "PII 스크럽").scrubPii(input);
}

/** 탐지만(마스킹 없이). EE 미탑재면 거부. */
export function detectPii(input: unknown): PiiHit[] {
  return requireEnterprise(ee().pii, "PII 탐지").detectPii(input);
}

/** 객체 깊은 순회 스크럽. EE 미탑재면 거부. */
export function scrubPiiDeep<T>(v: T): { value: T; hits: PiiHit[]; total: number } {
  return requireEnterprise(ee().pii, "PII 스크럽").scrubPiiDeep(v);
}

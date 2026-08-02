// 컬럼 마스킹 경계(#186) — **타입·계약은 코어(AGPL), 실제 마스킹 구현은 Enterprise(src/ee/db/mask.ts).**
//  EE 미탑재(무료 배포판)면 마스킹은 수행되지 않는다 — 무료판에 컬럼 마스킹 기능이 없기 때문이다.
//  ⚠ '기능 없음' 과 '정책 무시' 는 다르다: 마스킹 정책이 **설정된** 박스에서 EE 만 빠지면 raw 가 샐 수 있으므로,
//   그 경우는 db/policy.ts 의 refreshPolicy 가 fail-closed 로 거부한다(assertEnterpriseForCompliance).
import { ee } from "../enterprise/registry.js";

export type MaskStyle = "full" | "partial" | "email" | "hash" | "null";

export interface FieldMeta {
  name: string;
  // 출처 키 — pg `${tableID}:${columnID}` / mysql `${orgTable}.${orgName}`(lower).
  //  null = 표현식·무출처·스키마 불일치(마스킹 비대상 — 게이트1이 마스킹 컬럼의 표현식/파생 접촉을 이미 거부).
  srcKey?: string | null;
}
export interface MaskTarget {
  index: number;
  style: MaskStyle;
}

/** 값 하나를 style 로 마스킹. EE 미탑재면 원값 그대로(마스킹 기능 없음). */
export function maskValue(v: unknown, style: MaskStyle): unknown {
  const h = ee().dbMask;
  return h ? h.maskValue(v, style) : v;
}

/** 출력 필드 중 마스킹 대상의 인덱스·스타일. EE 미탑재면 대상 없음. */
export function planMaskTargets(fields: FieldMeta[], attrStyles: Map<string, MaskStyle>): MaskTarget[] {
  const h = ee().dbMask;
  return h ? h.planMaskTargets(fields, attrStyles) : [];
}

/** 결과 행에 마스킹 적용. EE 미탑재면 원본 그대로. */
export function applyRowMasking(rows: unknown[][], targets: MaskTarget[]): unknown[][] {
  const h = ee().dbMask;
  return h ? h.applyRowMasking(rows, targets) : rows;
}

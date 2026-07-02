// 결정론적 컬럼 마스킹 (#186) — 고객 DB 무수정, 게이트웨이(TS)에서 값 변환.
//  db_query 결과 행(rowMode:"array")의 특정 출력 컬럼 값을 style 에 따라 마스킹한다. 순수 함수 — 단위테스트(mask.test.ts).
//  마스킹 대상 식별은 '출력 컬럼명'이 아니라 DB 가 알려주는 출처(pg field.tableID/columnID)로 한다(이름바꾸기 우회 무력화).
import { createHash } from "node:crypto";

export type MaskStyle = "full" | "partial" | "email" | "hash" | "null";

// 값 하나를 style 로 마스킹. null/undefined 는 그대로(빈값은 가릴 것이 없음).
export function maskValue(v: unknown, style: MaskStyle): unknown {
  if (v === null || v === undefined) return v;
  const s = typeof v === "string" ? v : String(v);
  switch (style) {
    case "null":
      return null;
    case "hash":
      return "sha256:" + createHash("sha256").update(s).digest("hex");
    case "email":
      return maskEmail(s);
    case "partial":
      return maskPartial(s);
    case "full":
    default:
      return "***";
  }
}

// 이메일 로컬부 마스킹 — a***@domain 유지(도메인은 노출, 개인식별 로컬부만 가림). @ 없으면 partial 폴백.
function maskEmail(s: string): string {
  const at = s.indexOf("@");
  if (at <= 0) return maskPartial(s);
  const local = s.slice(0, at);
  const domain = s.slice(at); // '@...' 포함
  const head = local.slice(0, 1);
  return `${head}***${domain}`;
}

// 부분 마스킹 — 앞1·뒤1 만 남기고 가운데를 가린다. 짧으면(<=2) 전부 가림.
function maskPartial(s: string): string {
  if (s.length <= 2) return "***";
  return `${s[0]}***${s[s.length - 1]}`;
}

export interface FieldMeta {
  name: string;
  tableID?: number;
  columnID?: number;
}
export interface MaskTarget {
  index: number;
  style: MaskStyle;
}

// 출력 필드 중 마스킹 대상(출처 oid:attnum 이 attrStyles 에 있는 컬럼)의 인덱스·스타일을 뽑는다.
//  attrStyles 키 = `${tableID}:${columnID}`. tableID 0(표현식)·미매칭은 대상 아님(게이트1이 표현식 PII 미접촉 보장).
export function planMaskTargets(fields: FieldMeta[], attrStyles: Map<string, MaskStyle>): MaskTarget[] {
  const targets: MaskTarget[] = [];
  fields.forEach((f, i) => {
    if (!f.tableID || !f.columnID) return; // 표현식/무출처 — 마스킹 대상 아님
    const style = attrStyles.get(`${f.tableID}:${f.columnID}`);
    if (style) targets.push({ index: i, style });
  });
  return targets;
}

// rowMode:"array" 결과 행들에 마스킹 적용. 원본 불변(새 배열 반환). targets 없으면 그대로.
export function applyRowMasking(rows: unknown[][], targets: MaskTarget[]): unknown[][] {
  if (targets.length === 0) return rows;
  return rows.map((row) => {
    const copy = row.slice();
    for (const t of targets) copy[t.index] = maskValue(copy[t.index], t.style);
    return copy;
  });
}

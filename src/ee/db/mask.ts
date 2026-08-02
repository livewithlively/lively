// ⚠ Lively Enterprise Edition — 이 디렉터리(src/ee)는 상용 라이센스다. src/ee/LICENSE 참조.
//   유효한 구독 없이 프로덕션에서 사용할 수 없다(열람·개발·테스트는 허용).
//
// 결정론적 컬럼 마스킹 (#186, mysql #715) — 고객 DB 무수정, 게이트웨이(TS)에서 값 변환.
//  db_query 결과 행(rowMode:"array")의 특정 출력 컬럼 값을 style 에 따라 마스킹한다. 순수 함수 — 단위테스트(mask.test.ts).
//  마스킹 대상 식별은 '출력 컬럼명'이 아니라 DB 가 알려주는 출처로 한다(이름바꾸기 우회 무력화) — 엔진 중립
//  srcKey 로 일반화: pg `${tableID}:${columnID}`(oid:attnum, mask-policy.resolveMaskedAttrs 가 해석) /
//  mysql `${orgTable}.${orgName}`(lower — 정책 키와 같은 도메인이라 카탈로그 조회 불요, mysql-engine 이 채움).
import { createHash } from "node:crypto";
import type { MaskStyle, FieldMeta, MaskTarget } from "../../db/mask.js";

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

// 출력 필드 중 마스킹 대상(출처 srcKey 가 attrStyles 에 있는 컬럼)의 인덱스·스타일을 뽑는다.
//  attrStyles 키 = srcKey 와 같은 도메인(pg oid:attnum / mysql table.col). 무출처(srcKey null)·미매칭은 대상 아님.
export function planMaskTargets(fields: FieldMeta[], attrStyles: Map<string, MaskStyle>): MaskTarget[] {
  const targets: MaskTarget[] = [];
  fields.forEach((f, i) => {
    if (!f.srcKey) return; // 표현식/무출처 — 마스킹 대상 아님
    const style = attrStyles.get(f.srcKey);
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

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
  if (style === "age") return ageAtMonthStart(v, new Date());
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

// 생년월일 → 출생월 1일부터 기준 시각이 속한 달 1일까지의 만 나이. 양쪽을 월 첫날로 묶는 이유: 날마다 조회해 나이가
//  바뀌는 날을 찾으면 생일(일)이 드러난다. 기준일만 묶으면 «1일생인가» 1비트가 남으므로 생일 쪽도 묶는다 —
//  드러나는 건 출생 연·월까지다. 게이트1 이 허용하는 SQL 파생(firewall.ts ageDerivationRef)과 같은 산식이어야 한다
//  (둘이 다르면 그 차이가 또 하나의 비트가 된다).
//  Date(드라이버가 DATE 를 로컬 자정 Date 로 준다) · 'YYYY-MM-DD[ 시각]' · 'YYYYMMDD' 를 받고, 그 외·없는 날짜·미래는 null.
export function ageAtMonthStart(v: unknown, now: Date): number | null {
  let y: number, m: number, d: number;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    y = v.getFullYear(); m = v.getMonth() + 1; d = v.getDate();
  } else {
    const hit = /^(\d{4})-?(\d{2})-?(\d{2})(?:$|[ T])/.exec(String(v).trim());
    if (!hit) return null;
    y = Number(hit[1]); m = Number(hit[2]); d = Number(hit[3]);
    const probe = new Date(y, m - 1, d);
    if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return null; // 1990-02-30 류
  }
  const ry = now.getFullYear(), rm = now.getMonth() + 1; // 기준일 = 이번 달 1일
  const age = ry - y - (rm < m ? 1 : 0);
  return age >= 0 ? age : null;
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

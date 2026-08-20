// 앱 데이터 테이블(store_*) DDL 의 **순수** 부분 (#1780 D6) — RLS/부팅자식 배선과 무관하게 안정적인 것:
//  ① 컬럼 타입 화이트리스트(선언형 — 임의 DDL 금지) ② 앱별 테이블 네임스페이스 합성 ③ 식별자 검증.
//  실제 CREATE TABLE 실행·tenant_id·RLS 정책 부착은 스키마 자식(owner DSN)에서 별도로 한다(이 파일은 SQL 조각만).
import { HttpError } from "../http-error.js";

// 선언형 컬럼 타입 — 매니페스트 data.columns[].type 가 이 화이트리스트 안이어야 한다(임의 SQL 타입 주입 차단).
//  키 = 매니페스트가 쓰는 논리 타입, 값 = 실제 postgres 타입. 소문자 정규화 후 대조.
export const STORE_COLUMN_TYPES: Readonly<Record<string, string>> = {
  text: "text",
  int: "bigint",
  integer: "bigint",
  bigint: "bigint",
  float: "double precision",
  number: "double precision",
  bool: "boolean",
  boolean: "boolean",
  timestamp: "timestamptz",
  timestamptz: "timestamptz",
  date: "date",
  json: "jsonb",
  jsonb: "jsonb",
  uuid: "uuid",
};

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/; // 소문자·_ 시작, 소문자 영숫자/_ (매니페스트 검증과 동일 charset)

/** 매니페스트 논리 타입 → postgres 타입. 화이트리스트 밖이면 400. */
export function resolveColumnType(logical: string): string {
  const t = STORE_COLUMN_TYPES[String(logical).trim().toLowerCase()];
  if (!t) throw new HttpError(400, `허용되지 않은 컬럼 타입: ${logical} (허용: ${Object.keys(STORE_COLUMN_TYPES).join(", ")})`);
  return t;
}

/** 식별자(테이블·컬럼명) 검증 — charset 밖이면 400. 예약 컬럼(tenant_id·id 등 시스템 컬럼) 충돌도 거부. */
const RESERVED_COLUMNS = new Set(["tenant_id", "id", "app_id", "created_at", "updated_at"]);
export function assertIdent(kind: "table" | "column", name: string): string {
  const n = String(name).trim();
  if (!IDENT.test(n)) throw new HttpError(400, `${kind}명이 규칙에 맞지 않습니다: ${name}`);
  if (kind === "column" && RESERVED_COLUMNS.has(n)) throw new HttpError(400, `예약된 컬럼명입니다: ${name}`);
  return n;
}

/**
 * 앱별 물리 테이블명 = app 스키마의 `<appId>__<table>` (앱 격리 — 앱 X 는 앱 Y 의 테이블명을 못 만든다/못 건드린다).
 *  appId 는 STRICT_SLUG(매니페스트에서 검증됨)이나 방어적으로 재검. 반환은 스키마 없는 relation 명(호출부가 app. 붙임).
 */
export function physicalTableName(appId: string, table: string): string {
  const a = String(appId).trim();
  if (!IDENT.test(a)) throw new HttpError(400, `앱 id 가 식별자 규칙에 맞지 않습니다: ${appId}`);
  return `${a}__${assertIdent("table", table)}`;
}

export interface StoreColumn { name: string; type: string }

/** 선언 컬럼 목록 → 컬럼 DDL 조각 배열(순수). 시스템 컬럼(tenant_id·id·created_at)은 호출부가 앞에 붙인다. */
export function columnDefs(columns: StoreColumn[]): string[] {
  if (!columns.length) throw new HttpError(400, "컬럼이 최소 1개 필요합니다");
  const seen = new Set<string>();
  return columns.map((c) => {
    const name = assertIdent("column", c.name);
    if (seen.has(name)) throw new HttpError(400, `중복 컬럼명: ${name}`);
    seen.add(name);
    return `"${name}" ${resolveColumnType(c.type)}`;
  });
}

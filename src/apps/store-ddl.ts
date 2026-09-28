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

// Postgres 식별자 상한(NAMEDATALEN-1). 넘는 이름은 **조용히 잘려** 서로 다른 선언이 같은 물리 테이블이 된다 — 그래서 거부한다.
export const PG_IDENT_MAX = 63;

/**
 * 앱 id → 물리 이름 접두(#4224). 매니페스트는 앱 id 에 `-` 를 허용하지만(`crm-dashboard`) 테이블 식별자 규칙엔 없다 —
 *  종전엔 하이픈 id 앱의 테이블 생성이 전부 실패했다. `-` 를 `_` 로 바꾼다.
 *  ★ 단사성: 앱 id 엔 `_` 가 없으므로(APP_ID_RE) 바꾼 결과가 서로 겹치지 않는다. 다만 구분자 `__` 와 헷갈리면
 *   `<접두>__<테이블>` 을 두 가지로 읽을 수 있다(`a--b`+`x` 와 `a`+`b__x` 가 둘 다 `a__b__x`, `a-`+`x` 와 `a`+`_x` 가 둘 다
 *   `a___x`). 그래서 접두에 `__` 가 생기거나 `_` 로 끝나는 id(연속 하이픈·끝 하이픈)는 데이터 테이블을 못 가진다 —
 *   그러면 물리 이름의 **첫 `__`** 가 늘 구분자라 (앱, 테이블) 이 하나로 정해진다.
 */
export function physicalAppPrefix(appId: string): string {
  const raw = String(appId).trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(raw)) throw new HttpError(400, `앱 id 가 식별자 규칙에 맞지 않습니다: ${appId}`);
  const a = raw.replace(/-/g, "_");
  if (a.includes("__") || a.endsWith("_")) {
    throw new HttpError(400, `앱 id '${appId}' 는 데이터 테이블을 가질 수 없습니다 — 하이픈을 연달아 쓰거나 하이픈으로 끝나는 id 는 테이블 이름이 다른 앱과 겹칠 수 있습니다. id 를 바꿔 주세요`);
  }
  return a;
}

/**
 * 앱별 물리 테이블명 = `<앱 접두>__<table>` (앱 격리 — 앱 X 는 앱 Y 의 테이블명을 못 만든다/못 건드린다).
 *  앱 접두 = physicalAppPrefix(하이픈 → 밑줄, #4224). 반환은 스키마 없는 relation 명(호출부가 스키마를 붙임).
 *  63자를 넘으면 400 — Postgres 가 잘라 버리면 다른 테이블과 한 몸이 된다.
 */
export function physicalTableName(appId: string, table: string): string {
  const name = `${physicalAppPrefix(appId)}__${assertIdent("table", table)}`;
  if (name.length > PG_IDENT_MAX) {
    throw new HttpError(400, `테이블 이름이 너무 깁니다: 앱 '${appId}' 의 '${table}' → ${name}(${name.length}자, 최대 ${PG_IDENT_MAX}자). 앱 id 나 테이블 이름을 줄여 주세요`);
  }
  return name;
}

/** 워크스페이스 스키마 옆의 보관 스키마(#4224) — 매니페스트에서 빠졌지만 데이터가 있던 테이블이 옮겨 가는 자리. */
export function archiveSchemaName(schema: string): string {
  if (!IDENT.test(schema)) throw new HttpError(500, `스키마 이름이 식별자 규칙에 맞지 않습니다: ${schema}`);
  const s = `${schema}_archive`;
  if (s.length > PG_IDENT_MAX) throw new HttpError(500, `보관 스키마 이름이 너무 깁니다: ${s}`);
  return s;
}

/**
 * 보관 테이블 이름(순수, #4224) — `<물리명>__<YYYYMMDDHHMMSS>[꼬리]`. 같은 테이블을 두 번 보관해도 겹치지 않게 시각을 붙이고,
 *  63자를 넘으면 물리명 앞쪽을 남기고 자른다(시각과 꼬리는 늘 남긴다 — 사람이 «언제 빠졌나» 를 읽는 자리).
 *  suffix 는 테이블과 함께 옮겨 가는 인덱스·시퀀스 이름용(`_pkey`·`_seq1`…) — 테이블·인덱스·시퀀스는 한 스키마 안에서
 *  이름을 나눠 쓰므로, 옮기기 전에 이것들도 겹치지 않는 이름으로 바꿔야 두 번째 보관이 `..._pkey already exists` 로 죽지 않는다.
 */
export function archivedTableName(physical: string, at: Date, suffix: string = ""): string {
  const ts = at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const tail = `__${ts}${suffix}`;
  return `${physical.slice(0, PG_IDENT_MAX - tail.length)}${tail}`;
}

/**
 * 앱 데이터 테이블이 사는 스키마(순수, #4223).
 *  - 기본 앱(builtin — 코드가 구조의 주인, 여러 워크스페이스가 같은 구조) → 공유 `app` 스키마 + tenant_id 행 격리.
 *  - 워크스페이스가 설치한 앱(빌더로 만든 앱 등 — 그 워크스페이스가 구조의 주인) → 멀티테넌트에서는 워크스페이스별
 *    `app_<테넌트 id hex32>`. 같은 앱 id 를 다른 워크스페이스가 설치해도 물리 테이블이 섞이지 않고(컬럼이 달라도 된다),
 *    제거가 그 워크스페이스 테이블만 지운다(종전엔 공유 테이블을 통째로 DROP — 남의 행까지 지웠다).
 *  - 단일 테넌트(자가호스팅)·컨텍스트 없음 → 종전 그대로 `app`(기존 박스의 데이터 이행이 필요 없다).
 */
export const SHARED_APP_SCHEMA = "app";
const SINGLE_TENANT = "00000000-0000-0000-0000-000000000000"; // db/tenant-column SINGLE_TENANT_ID 와 같은 값(이 파일은 순수 — import 하지 않는다)
export function appSchemaName(opts: { builtin: boolean; tenantId: string | null | undefined }): string {
  if (opts.builtin) return SHARED_APP_SCHEMA;
  const t = String(opts.tenantId ?? "").trim().toLowerCase();
  if (!t || t === SINGLE_TENANT) return SHARED_APP_SCHEMA;
  const hex = t.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new HttpError(500, `테넌트 id 형식이 아닙니다: ${opts.tenantId}`);
  return `app_${hex}`;
}

/** 스키마까지 붙인 인용 relation 이름(순수) — `"<스키마>"."<appId>__<table>"`. */
export function qualifiedAppTable(schema: string, appId: string, table: string): string {
  if (!IDENT.test(schema)) throw new HttpError(500, `스키마 이름이 식별자 규칙에 맞지 않습니다: ${schema}`);
  return `"${schema}"."${physicalTableName(appId, table)}"`;
}

/** 설치 출처가 기본 앱(코드 소유)인가 — org_app.source / 설치 호출의 source 둘 다 같은 모양({kind}). */
export function isBuiltinSource(source: unknown): boolean {
  return !!source && typeof source === "object" && (source as { kind?: unknown }).kind === "builtin";
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

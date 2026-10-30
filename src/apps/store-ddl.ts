// 앱 데이터 테이블(store_*) DDL 의 **순수** 부분 (#1780 D6) — RLS/부팅자식 배선과 무관하게 안정적인 것:
//  ① 컬럼 타입 화이트리스트(선언형 — 임의 DDL 금지) ② 앱별 테이블 네임스페이스 합성 ③ 식별자 검증.
//  실제 CREATE TABLE 실행·tenant_id·RLS 정책 부착은 스키마 자식(owner DSN)에서 별도로 한다(이 파일은 SQL 조각만).
import { createHash } from "node:crypto";
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

// ── 칸 타입 v2(#4483) — 값 정합성을 위해 되도록 전부 ────────────────────────────────────────
//  위 14 종(종전 이름 — int/integer 는 bigint, timestamp 는 timestamptz 로 남긴다: 이미 깔린 앱의 표와 같아야 한다)에 더해
//  smallint · int4 · real · double · numeric(p,s) · varchar(n) · time · timetz · interval · bytea · inet · cidr · 배열(<타입>[]) · enum.
//  enum 은 text 칸 + 값 목록 검사(CHECK)다 — Postgres 열거형은 값 빼기·순서 바꾸기가 안 되고 형 이름이 표 이름과 같은 자리를 다툰다.
//  vector 는 아직 없다 — 매니지드의 pgvector 는 public 스키마에 있어 앱 SQL 의 검색 경로(pg_catalog)에서 연산자가 안 보인다(별도 검토).
const MORE_TYPES: Readonly<Record<string, string>> = {
  smallint: "smallint", int2: "smallint", int4: "integer", int8: "bigint",
  real: "real", float4: "real", double: "double precision", float8: "double precision", "double precision": "double precision",
  time: "time", timetz: "time with time zone", interval: "interval",
  bytea: "bytea", bytes: "bytea", inet: "inet", cidr: "cidr",
  numeric: "numeric", decimal: "numeric", varchar: "varchar",
  enum: "text",
};

export interface ColumnType {
  /** CREATE TABLE 에 쓰는 형. */
  sql: string;
  /** Postgres format_type 이 같은 형을 부르는 이름(선언과 실제를 비교할 때). */
  canonical: string;
  array: boolean;
  enum: boolean;
  /** 정수 형(외래키 칸이 될 수 있다). */
  integer: boolean;
}

/** format_type 이 내는 이름(PG 17·18 실측 — store-schema.pg-test 가 대조). */
const CANONICAL: Readonly<Record<string, string>> = {
  timestamptz: "timestamp with time zone", time: "time without time zone", varchar: "character varying",
};

const allTypeNames = (): string => [...new Set([...Object.keys(STORE_COLUMN_TYPES), ...Object.keys(MORE_TYPES)])].join(", ") + ", numeric(p,s), varchar(n), <타입>[]";

/** 매니페스트 논리 타입 → 칸 형. 화이트리스트 밖·숫자 범위 밖이면 400. 대소문자·공백은 무시한다(`Numeric(12, 2)`). */
export function parseColumnType(logical: string): ColumnType {
  let s = String(logical ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const fail = (why = ""): never => { throw new HttpError(400, `허용되지 않은 컬럼 타입: ${logical}${why ? ` — ${why}` : ""} (허용: ${allTypeNames()})`); };
  let array = false;
  if (s.endsWith("[]")) { array = true; s = s.slice(0, -2).trim(); if (s.endsWith("[]")) fail("배열은 한 겹만"); }
  let sql: string | undefined;
  let canonical: string | undefined;
  const num = /^(numeric|decimal) ?(?:\( ?(\d+) ?(?:, ?(\d+) ?)?\))?$/.exec(s);
  const vc = /^varchar ?\( ?(\d+) ?\)$/.exec(s);
  if (num && num[2] !== undefined) {
    const p = Number(num[2]), sc = num[3] === undefined ? 0 : Number(num[3]);
    if (!(p >= 1 && p <= 1000)) fail("numeric 자릿수는 1~1000");
    if (!(sc >= 0 && sc <= p)) fail("numeric 소수 자릿수는 0~자릿수");
    sql = `numeric(${p},${sc})`;
    canonical = sql;
  } else if (vc) {
    const n = Number(vc[1]);
    if (!(n >= 1 && n <= 10_485_760)) fail("varchar 길이는 1~10485760");
    sql = `varchar(${n})`;
    canonical = `character varying(${n})`;
  } else {
    sql = STORE_COLUMN_TYPES[s] ?? MORE_TYPES[s];
    if (!sql) return fail();
    canonical = CANONICAL[sql] ?? sql;
  }
  const isEnum = s === "enum";
  if (isEnum && array) fail("enum 배열은 받지 않습니다 — text[] 를 쓰세요");
  return {
    sql: array ? `${sql}[]` : sql,
    canonical: array ? `${canonical}[]` : canonical,
    array,
    enum: isEnum,
    integer: !array && (sql === "bigint" || sql === "integer" || sql === "smallint"),
  };
}

/** 매니페스트 논리 타입 → postgres 타입(종전 이름 — parseColumnType 의 sql). 화이트리스트 밖이면 400. */
export function resolveColumnType(logical: string): string {
  return parseColumnType(logical).sql;
}

// ── 칸 제약(#4483) — 매니페스트로만 ─────────────────────────────────────────────────────────
/** 기본값 식 — 이 목록만(임의 식은 앱 역할로 실행되는 코드라 검사기 밖으로 새는 길이 된다). 값 기본값은 default 에 JSON 으로. */
export const DEFAULT_EXPRS: Readonly<Record<string, string>> = {
  "now()": "now()", "current_timestamp": "CURRENT_TIMESTAMP", "current_date": "CURRENT_DATE", "gen_random_uuid()": "gen_random_uuid()",
};
export type OnDelete = "cascade" | "set null" | "restrict" | "no action";
export const ON_DELETE: ReadonlySet<string> = new Set(["cascade", "set null", "restrict", "no action"]);

/** 제약 이름 — 라이블리가 만든 것만 이 접두로 알아보고, 선언에서 빠지면 지운다(사람이 만든 제약은 건드리지 않는다). */
export const APP_CHECK_PREFIX = "lvck_";
export const APP_FK_PREFIX = "lvfk_";
/** 외래키가 가리키는 표의 (tenant_id, id) 유일 제약(#4483) — 설치 앱 표의 기본 키가 (id) 라 외래키 대상 키를 따로 둔다. */
export const APP_KEY_PREFIX = "lvuq_";
export function appConstraintName(prefix: string, ...parts: string[]): string {
  return `${prefix}${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16)}`;
}

/**
 * 기본값 JSON → Postgres 리터럴 글자(따옴표 전 — 따옴표는 DB 의 quote_literal 이 붙인다). 형에 맞지 않으면 400.
 *  배열 칸이면 배열 리터럴(`{"a","b"}`), json/jsonb 면 JSON 글자, 나머지는 글자 그대로. null 은 «기본값 없음».
 */
export function defaultLiteralText(value: unknown, type: ColumnType): string | null {
  if (value === null || value === undefined) return null;
  const isJson = type.sql === "jsonb" || type.sql === "json";
  if (isJson) return JSON.stringify(value);
  if (type.array) {
    if (!Array.isArray(value)) throw new HttpError(400, `배열 칸(${type.sql})의 default 는 배열이어야 합니다`);
    const el = (v: unknown): string => {
      if (v === null) return "NULL";
      if (typeof v === "object") throw new HttpError(400, "배열 default 의 원소는 글자·수·참거짓만");
      return `"${String(v).replace(/[\\"]/g, (m) => `\\${m}`)}"`;
    };
    return `{${value.map(el).join(",")}}`;
  }
  if (typeof value === "object") throw new HttpError(400, `칸(${type.sql})의 default 는 글자·수·참거짓이어야 합니다`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new HttpError(400, "default 수는 유한해야 합니다");
  const text = String(value);
  if (text.includes("\0")) throw new HttpError(400, "default 에 NUL 문자가 있습니다");
  return text;
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
 * **행을 고르는 조건(match)** 의 칸 이름 검증 — 선언 칸에 더해 시스템 칸 `id` · `created_at` 을 받는다.
 *  왜: 모든 앱 테이블엔 id·created_at 이 저절로 있고 store_insert 는 그 id 를 돌려준다. 그런데 match 가 선언 칸과 같은 검증기
 *  (assertIdent — 예약 칸 거부)를 타서 **돌려받은 id 로 그 행을 집을 수 없었다**(2026-10-07 #4592 실측: 의견 한 줄을 고치려던
 *  store_update {match:{id}} 가 「예약된 컬럼명입니다: id」). 앱은 «내용이 같은 행 전부» 로만 고치고 지울 수 있었다.
 *  쓰는 쪽(insert 의 row · update 의 set)은 그대로 막는다 — 시스템이 정하는 값이다. tenant_id·app_id·updated_at 은 match 에서도 막는다
 *  (앞 둘은 격리 경계라 서버만 다루고, updated_at 은 잡아 두기만 한 이름이라 실제 칸이 없다).
 */
const MATCHABLE_SYSTEM_COLUMNS = new Set(["id", "created_at"]);
export function assertMatchIdent(name: string): string {
  const n = String(name).trim();
  if (MATCHABLE_SYSTEM_COLUMNS.has(n)) return n;
  return assertIdent("column", n);
}

/** match 의 id 값 — bigint 범위의 정수(숫자 또는 숫자 문자열)만. 아니면 DB 가 22P02·22003 으로 던져 500 이 된다 — 그 전에 400 으로 말한다.
 *  #5172 원래 id 로 넣기(OVERRIDING SYSTEM VALUE)가 열려 0·음수·19자리 id 도 생긴다 — 그 행도 match 로 집을 수 있어야 한다. */
const BIGINT_MIN = -(2n ** 63n), BIGINT_MAX = 2n ** 63n - 1n;
export function assertMatchId(value: unknown): string {
  const v = typeof value === "number" ? (Number.isSafeInteger(value) ? String(value) : "") : typeof value === "string" ? value.trim() : "";
  if (!/^-?\d{1,19}$/.test(v) || BigInt(v) < BIGINT_MIN || BigInt(v) > BIGINT_MAX) throw new HttpError(400, "match 의 id 는 bigint 범위의 정수여야 합니다");
  return v;
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

/** 칸 보관 표 이름이 길 때 남기는 물리명 앞 글자 수 · 해시 글자 수 — 주인 짐작(archive-meta.ts)이 같은 값으로 해시꼴을 알아본다(#4733). */
export const COLUMN_ARCHIVE_HEAD = 24;
export const COLUMN_ARCHIVE_HASH = 8;

/** 지운 칸(drop_columns)의 값을 보관하는 표 이름(순수, #4483) — `<물리명>__<칸>__<시각>`, 63자를 넘으면 앞을 줄이고 해시를 붙인다
 *  (`<물리명 앞 24자>__<해시8>__<시각>`). 이름 규칙이 한 자리에 있어야 주인 짐작(archive-meta.ts)과 그 시험이 같은 규칙을 본다(#4733). */
export function columnArchiveName(physical: string, column: string, at: Date): string {
  const base = `${physical}__${column}`;
  const full = archivedTableName(base, at);
  if (full.length <= PG_IDENT_MAX && base.length + 16 <= PG_IDENT_MAX) return full;
  const h = createHash("sha256").update(base).digest("hex").slice(0, COLUMN_ARCHIVE_HASH);
  return archivedTableName(`${physical.slice(0, COLUMN_ARCHIVE_HEAD)}__${h}`, at);
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

/**
 * 앱 자유 SQL(#4226)이 내려가는 DB 역할 이름(순수) — (DB, 스키마, 앱)마다 하나. 역할은 **클러스터 전역** 이름이라
 *  같은 RDS 에 DB 가 여럿이어도(스테이지·옛 테넌트 DB) 겹치지 않게 DB 이름까지 섞어 해시한다.
 *  이 역할은 로그인하지 않는다 — 런타임 연결이 트랜잭션 안에서 `SET LOCAL ROLE` 로 내려가 쓴다.
 */
export const APP_SQL_ROLE_PREFIX = "lvly_appsql_";
export function appSqlRoleName(db: string, schema: string, appId: string): string {
  const h = createHash("sha256").update(`${db}\0${schema}\0${appId}`).digest("hex").slice(0, 24);
  return `${APP_SQL_ROLE_PREFIX}${h}`;
}

/** 매니페스트가 선언한 인덱스(#4226) — 칸 목록과 유일 여부. */
export interface StoreIndex { columns: string[]; unique?: boolean }

/**
 * 선언 인덱스의 물리 이름(순수) — `lvix_<해시 16>`. 라이블리가 만든 인덱스를 이 접두로 알아보고, 선언에서 빠지면 지운다.
 *  해시에 스키마·물리 테이블·칸·유일 여부를 넣는다(인덱스 이름은 스키마 안에서 유일해야 한다).
 */
export const APP_INDEX_PREFIX = "lvix_";
export function appIndexName(schema: string, physical: string, idx: StoreIndex, tenantScoped: boolean): string {
  const key = `${schema}\0${physical}\0${idx.unique ? "u" : "i"}\0${tenantScoped ? "t" : ""}\0${idx.columns.join(",")}`;
  return `${APP_INDEX_PREFIX}${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/** 설치 출처가 기본 앱(코드 소유)인가 — org_app.source / 설치 호출의 source 둘 다 같은 모양({kind}). */
export function isBuiltinSource(source: unknown): boolean {
  return !!source && typeof source === "object" && (source as { kind?: unknown }).kind === "builtin";
}

/** 매니페스트 칸(#4483 확장). 제약은 전부 선택이다 — 없으면 종전처럼 NULL 허용·기본값 없음. */
export interface StoreColumn {
  name: string;
  type: string;
  not_null?: boolean;
  /** 값 기본값(JSON) — 형에 맞게 리터럴로. default_expr 과 함께 못 쓴다. */
  default?: unknown;
  /** 식 기본값 — DEFAULT_EXPRS 의 열쇠만(now() · current_date · gen_random_uuid() …). */
  default_expr?: string;
  unique?: boolean;
  /** 이 칸에 거는 검사 식(그 표의 칸만 쓴다) — 예 `amount >= 0`. */
  check?: string;
  /** 같은 앱의 다른 표(또는 자기 표)의 id 를 가리킨다. 칸은 정수형이어야 한다. */
  references?: { table: string; on_delete?: OnDelete };
  /** type 이 enum 일 때 허용 값. */
  values?: string[];
  /** 이 칸의 옛 이름 — 그 이름의 칸이 있고 새 이름이 없으면 이름만 바꾼다(데이터 그대로). */
  renamed_from?: string;
}

/** 선언 컬럼 목록 → 컬럼 DDL 조각 배열(순수). 시스템 컬럼(tenant_id·id·created_at)은 호출부가 앞에 붙인다.
 *  제약(NOT NULL·DEFAULT·CHECK·외래키)은 여기서 안 붙인다 — 새 표든 있던 표든 같은 동기화(store-schema)가 건다. */
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

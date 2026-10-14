// 앱 테이블 자유 SQL — 문장 검사 · 테이블 이름 바꿔 쓰기 · 결과 상한 감싸기 (#4226 · #4483). **순수**(DB 무접근).
//
// ── 무엇을 여나 (계획 지식 crm-dogfood-app-builder-plan-4200 §7 · 설계 app-framework-v2-general-web-design §3-D) ──
//  워크스페이스가 설치한 앱은 자기 테이블에 SELECT·INSERT·UPDATE·DELETE 를 자유 SQL 로 쓴다. 표·칸 만들기(DDL)는
//  매니페스트로만 — 매니페스트가 구조의 원본이어야 옮기기·갱신·버전 비교가 성립한다.
//  SQL 은 선언한 이름 그대로 쓴다(`SELECT * FROM contacts`). 실행 전에 그 이름을 워크스페이스 스키마의 물리 테이블로
//  바꿔 쓴다(`"app_<ws>"."crm__contacts" AS "contacts"`) — 별칭을 붙여 `contacts.name` 같은 수식이 그대로 산다.
//  앱 서버의 SDK(Drizzle HTTP 드라이버)가 만드는 SQL 도 이 길로 온다 — 그래서 Postgres 문법을 **좁히지 않고** 받는다(#4483).
//
// ── 경계는 여기가 아니라 DB 다 ───────────────────────────────────────────────────────────
//  진짜 경계는 실행기(app-sql-exec)가 내려가는 **앱별 DB 역할**이다 — 그 역할은 이 앱의 테이블에만 권한이 있다.
//  그런데 역할은 SQL 안에서 되돌릴 수 있다: `SELECT set_config('role','none',true)` 한 줄이면 런타임 역할로 돌아간다
//  (PG 17 실측 2026-09-30). 그래서 이 파일의 일은 **역할을 되돌리거나 문장 밖으로 나가는 길**을 막는 것이다:
//   ① 해석은 **Postgres 의 실제 파서**(libpg_query)로 한다 — 검사기와 DB 가 같은 문장을 다르게 읽는 틈(#4226 때 렉싱
//      불일치를 막으려고 주석·백슬래시·달러 인용을 통째로 거부했다)이 원리적으로 없다. 그래서 그 넷은 이제 받는다.
//      실행기는 `standard_conforming_strings = on` 을 걸어 파서가 가정하는 렉싱과 DB 렉싱을 같게 고정한다.
//   ② 한 문장 · 네 종류(SELECT·INSERT·UPDATE·DELETE)만. 트리의 노드는 **허용 목록** 안이어야 한다(모르는 문법은 거부).
//   ③ 역할·설정을 바꾸거나 문자열을 SQL 로 실행하는 함수(set_config · *_to_xml · ts_stat …), 카탈로그를 더듬는 함수(pg_* ·
//      has_* · to_reg* · reg*in/out · row_security_active · brin_*), 한 번에 큰 메모리를 잡는 함수(repeat · lpad · format …)를 막는다.
//   ④ 스키마를 붙인 이름(테이블·함수·형·연산자·콜레이션)을 받지 않는다 — 실행기는 search_path 를 pg_catalog 로 좁혀 둔다.
//      예외는 파서가 SQL 표준 구문을 바꿔 쓴 것(`extract(…)` → pg_catalog.extract, `cast(… as integer)` → pg_catalog.int4)뿐.
//   ⑤ 테이블 자리(RangeVar)에 오는 이름은 선언 테이블이거나 그 자리에서 보이는 WITH 이름이어야 한다. pg_catalog 의 관계는
//      전부 `pg_` 로 시작하므로(PG 18 실측) `pg_` 로 시작하는 WITH 이름을 막으면 카탈로그 테이블에 닿는 이름이 남지 않는다.
//  이 파일이 뭔가를 놓쳐도 데이터는 앱 역할이 지킨다(다른 앱·본체 테이블은 권한 거부). 그래도 ③ 이 뚫리면 역할 자체가 풀리고,
//  ④·⑤ 가 뚫리면 카탈로그(다른 워크스페이스의 스키마·테이블 이름, 정책 식)가 보인다 — 셋 다 놓치면 안 된다.
//  ⚠ «조건 없는 UPDATE·DELETE 거부» 는 실수 방지다 — `WHERE id > 0` 처럼 모든 행을 겨냥하는 조건까지 막지는 않는다.
//   그 뒤는 일일 떠 두기(app-snapshot)가 받친다.
//  ⚠ 위치(location)는 **UTF-8 바이트** 오프셋이다 — 바꿔 쓰기는 바이트 위에서 한다(한글 값이 든 문장에서 글자 위치로 자르면 어긋난다).
import { loadModule, parseSync } from "libpg-query";
import { HttpError } from "../http-error.js";
import { qualifiedAppTable } from "./store-ddl.js";

export const APP_SQL_MAX_LEN = 100_000;
export const APP_SQL_MAX_PARAMS = 100;
/** 트리(JSON) 깊이 상한 — 수천 겹 쌓은 문장이 검사기(재귀)의 스택을 다 쓰지 않게. 논리 한 겹이 JSON 3~8 단계라
 *  `a || b || …` 사슬 수백 개·서브쿼리 수백 겹까지 받는다(Drizzle 관계 조회는 수십 단계). 넘으면 400, 스택이 먼저 차도 400. */
const MAX_DEPTH = 3000;

export type AppSqlKind = "select" | "insert" | "update" | "delete";
export interface AppSqlPlan {
  kind: AppSqlKind;
  /** INSERT·UPDATE·DELETE 인가. */
  writes: boolean;
  /** 행 잠금(FOR UPDATE·FOR SHARE …)이 있다 — 읽기 문장이어도 읽기 전용 트랜잭션으로는 못 돈다. */
  locks: boolean;
  /** 결과 행이 나오는가 — SELECT, 또는 RETURNING 이 붙은 쓰기. */
  returning: boolean;
  /** SQL 이 건드리는 이 앱의 테이블(선언 이름, 정렬). */
  tables: string[];
  /** 쓰기 대상 테이블(INSERT INTO · UPDATE · DELETE FROM) — 화면 알림에 싣는다. */
  targets: string[];
  /** 실행할 SQL — 선언 이름이 물리 이름으로 바뀐 것. 사용자 원문과 파라미터 번호($n)가 같다. 끝 세미콜론·꼬리 주석은 뗀다. */
  sql: string;
  /** SQL 이 쓰는 가장 큰 파라미터 번호($n) — params 개수와 같아야 한다. */
  paramCount: number;
}

const bad = (msg: string): never => { throw new HttpError(400, `SQL 을 받을 수 없습니다 — ${msg}`); };

// ── 파서 준비 ───────────────────────────────────────────────────────────────────────────
//  WASM 모듈은 한 번 싣는다(약 20MB). 게이트웨이 부팅을 막지 않게 처음 쓸 때 싣는다 — 실패하면 그 호출만 503.
let loading: Promise<void> | null = null;
let ready = false;
export async function ensureAppSqlParser(): Promise<void> {
  if (ready) return;
  loading ??= loadModule().then(() => { ready = true; }, (e) => { loading = null; throw e; });
  try { await loading; }
  catch (e) { throw new HttpError(503, `SQL 해석기를 싣지 못했습니다 — ${(e as Error)?.message ?? e}`, { cause: e }); }
}

// ── 함수 ────────────────────────────────────────────────────────────────────────────────
//  역할·설정 변경(set_config — `role` 을 바꾸면 SET ROLE 과 같다) · 설정 읽기(current_setting — 행 격리 값) ·
//  문자열을 SQL 로 실행(query_to_xml 류 · ts_stat · ts_rewrite) · 카탈로그 더듬기(pg_* · has_*_privilege · to_reg* ·
//  *_description · row_security_active · reg*in/out · brin_* · gin_clean_pending_list — 문자열이 regclass 로 자동 변환돼
//  «그 이름의 테이블이 있나» 를 떠볼 수 있다) · 시퀀스 조작 · 외부 접속(dblink) · 대형 객체(lo_*) · 서버 주소(inet_server_*).
const FORBIDDEN_FN = new Set([
  "set_config", "current_setting", "ts_stat", "ts_rewrite",
  //  한 번 부르면 1GB 가까이 할당하는 함수 — work_mem·문장 시간으로 안 막힌다(격리 리뷰 실측: repeat 9억 → 1.8GB 요청).
  //  format('%1000000000s', '') 도 같다. 전부는 아니다(남은 위험은 문장 5초 · 동시 2 · 풀 4 로 묶는다).
  "repeat", "lpad", "rpad", "array_fill", "format",
  "nextval", "setval", "currval", "lastval",
  "obj_description", "col_description", "shobj_description",
  "row_security_active", "gin_clean_pending_list",
  "inet_server_addr", "inet_server_port", "inet_client_addr", "inet_client_port",
]);
const FORBIDDEN_FN_PREFIX = ["pg_", "lo_", "dblink", "has_", "to_reg", "query_to_", "brin_"];
//  reg* 형 이름과 그 입출력 함수(regclassout('스키마.표') — 문자열이 regclass 로 바뀌며 카탈로그를 찾는다). regexp_* 는 아니다.
const REG_TYPES = /^reg(class|collation|config|dictionary|namespace|oper|operator|proc|procedure|role|type)$/;
const REG_FUNCS = /^reg(class|collation|config|dictionary|namespace|oper|operator|proc|procedure|role|type)(in|out|send|recv)?$/;

export function forbiddenFunction(name: string): boolean {
  const f = name.toLowerCase();
  return FORBIDDEN_FN.has(f) || FORBIDDEN_FN_PREFIX.some((p) => f.startsWith(p)) || f.includes("_to_xml") || REG_FUNCS.test(f);
}

/** 거부 문구 — 무엇 대신 무엇을 쓰라는 데까지 말한다(#4483: 빌더가 규칙을 외우지 않고 오류를 읽고 고친다). */
function forbiddenFunctionReason(f: string): string {
  if (f === "set_config" || f === "current_setting") return `'${f}' 는 쓸 수 없습니다(DB 역할·설정을 바꾸거나 읽는 함수)`;
  if (["nextval", "setval", "currval", "lastval"].includes(f)) return `시퀀스 함수 '${f}' 는 쓸 수 없습니다 — 새 id 는 INSERT … RETURNING id 로 받으세요`;
  if (["repeat", "lpad", "rpad", "array_fill", "format"].includes(f)) {
    return `'${f}' 는 한 번에 큰 메모리를 잡을 수 있어 막혀 있습니다 — 문자열은 || 나 concat() 으로 이으세요`;
  }
  if (f.startsWith("pg_") || f.startsWith("has_") || f.startsWith("to_reg") || REG_FUNCS.test(f) || f.endsWith("_description") || f === "row_security_active") {
    return `카탈로그·시스템 함수 '${f}' 는 쓸 수 없습니다 — 이 앱 테이블의 칸만 쓰세요(구조는 store_tables 로 봅니다)`;
  }
  return `함수 '${f}' 는 쓸 수 없습니다`;
}

// ── 트리 허용 목록 ───────────────────────────────────────────────────────────────────────
//  libpg_query 의 JSON 은 노드를 `{ "SelectStmt": {…} }` 처럼 감싸고, 형이 정해진 칸(InsertStmt.relation · TypeCast.typeName
//  · SelectStmt.larg …)은 감싸지 않고 그대로 둔다. 감싼 노드는 이 목록 안이어야 한다 — DML 안에 올 수 있는 표현식·절만.
//  이름이 바뀌거나 새 노드가 생기면(PG 판 올림) 거부 쪽으로 기운다(실패는 400 «이 문법은 받지 않습니다» 로 드러난다).
const ALLOWED_NODES = new Set([
  "SelectStmt", "InsertStmt", "UpdateStmt", "DeleteStmt",
  "A_Expr", "A_Const", "A_Star", "A_Indices", "A_Indirection", "A_ArrayExpr",
  "ColumnRef", "ParamRef", "FuncCall", "TypeCast", "TypeName", "CollateClause", "NamedArgExpr",
  "BoolExpr", "BooleanTest", "NullTest", "CaseExpr", "CaseWhen", "CoalesceExpr", "MinMaxExpr", "RowExpr", "SubLink",
  "SQLValueFunction", "SetToDefault", "MultiAssignRef", "GroupingFunc", "GroupingSet", "XmlExpr", "XmlSerialize",
  "ResTarget", "SortBy", "WindowDef", "RangeVar", "RangeSubselect", "RangeFunction", "RangeTableFunc", "RangeTableFuncCol",
  "RangeTableSample", "JoinExpr", "Alias", "CommonTableExpr", "WithClause", "CTESearchClause", "CTECycleClause",
  "OnConflictClause", "InferClause", "IndexElem", "LockingClause", "ColumnDef", "ReturningClause", "ReturningOption",
  "List", "String", "Integer", "Float", "Boolean", "BitString",
  "JsonValueExpr", "JsonFormat", "JsonReturning", "JsonOutput", "JsonKeyValue", "JsonObjectConstructor", "JsonArrayConstructor",
  "JsonArrayQueryConstructor", "JsonAggConstructor", "JsonObjectAgg", "JsonArrayAgg", "JsonIsPredicate", "JsonParseExpr",
  "JsonScalarExpr", "JsonSerializeExpr", "JsonFuncExpr", "JsonArgument", "JsonBehavior", "JsonTable", "JsonTablePathSpec",
  "JsonTableColumn",
]);
const STATEMENTS: Record<string, AppSqlKind> = { SelectStmt: "select", InsertStmt: "insert", UpdateStmt: "update", DeleteStmt: "delete" };
const TABLESAMPLE_METHODS = new Set(["system", "bernoulli"]);

type J = Record<string, unknown>;
const isObj = (x: unknown): x is J => x !== null && typeof x === "object" && !Array.isArray(x);
/** `{ "String": { "sval": "x" } }` 목록 → 이름 배열. 모양이 다르면 null. */
function names(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const it of list) {
    const s = isObj(it) && isObj(it.String) ? it.String.sval : undefined;
    if (typeof s !== "string") return null;
    out.push(s);
  }
  return out;
}
/** 감싼 노드면 [형, 내용]. */
function wrapped(x: J): [string, J] | null {
  const keys = Object.keys(x);
  if (keys.length !== 1 || !/^[A-Z]/.test(keys[0])) return null;
  const v = x[keys[0]];
  return isObj(v) ? [keys[0], v] : null;
}

function checkIdentName(n: string, what: string): void {
  if (n.toLowerCase().startsWith("__lively")) bad(`${what} '${n}' 는 라이블리가 쓰는 이름입니다 — 다른 이름을 쓰세요`);
}

/** 형 이름 — 한 이름(검색 경로 = pg_catalog) 또는 파서가 붙인 pg_catalog. 만 받는다. reg* 형은 거부. */
function checkTypeName(t: J): void {
  const n = names(t.names);
  if (!n || !n.length) return bad("형 이름을 읽지 못했습니다");
  if (n.length > 2 || (n.length === 2 && n[0] !== "pg_catalog")) bad(`스키마를 붙인 형(${n.join(".")})은 쓸 수 없습니다 — 형 이름만 쓰세요(::numeric, ::jsonb)`);
  const last = n[n.length - 1].toLowerCase();
  if (REG_TYPES.test(last)) bad(`reg* 형(${last})은 쓸 수 없습니다 — 카탈로그를 찾는 형입니다`);
  if (t.pct_type) bad("%TYPE 은 쓸 수 없습니다");
}

/** 이름 목록(연산자·콜레이션·opclass) — 스키마를 붙이면 거부(OPERATOR(pg_catalog.+) 도). 파서가 연산자·콜레이션에
 *  스키마를 스스로 붙이는 구문은 없다 — 붙어 있으면 사람이 쓴 것이다. */
function checkQualifiedList(list: unknown, what: string): void {
  const n = names(list);
  if (!n) return;
  if (n.length > 1) bad(`스키마를 붙인 ${what}(OPERATOR(${n.join(".")}) 등)는 쓸 수 없습니다 — ${what}만 쓰세요`);
}

interface Walk {
  declared: ReadonlySet<string>;
  tables: Set<string>;
  /** 바꿔 쓸 테이블 자리 — 바이트 위치 · 선언 이름 · 별칭이 이미 있나. */
  refs: Array<{ loc: number; relname: string; aliased: boolean }>;
  maxParam: number;
  locks: boolean;
}

function walk(x: unknown, scope: ReadonlySet<string>, w: Walk, depth: number): void {
  if (depth > MAX_DEPTH) bad(`너무 깊게 중첩된 문장입니다(${MAX_DEPTH}겹 초과) — 서브쿼리·괄호를 줄여 주세요`);
  if (Array.isArray(x)) { for (const el of x) walk(el, scope, w, depth + 1); return; }
  if (!isObj(x)) return;
  const wrap = wrapped(x);
  if (wrap) {
    const [type, body] = wrap;
    if (!ALLOWED_NODES.has(type)) {
      if (type === "CurrentOfExpr") bad("WHERE CURRENT OF(커서)는 받지 않습니다 — 조건으로 행을 고르세요");
      if (type === "IntoClause") bad("SELECT … INTO 는 받지 않습니다(새 테이블을 만든다) — INSERT INTO <선언 테이블> SELECT … 로 쓰세요");
      bad(`이 문법(${type})은 받지 않습니다`);
    }
    node(type, body, scope, w, depth);
    return;
  }
  node(null, x, scope, w, depth);
}

/** 노드 하나(감싼 것이든 형이 정해진 칸이든). type 은 감싼 노드일 때만 있다. */
function node(type: string | null, o: J, scope: ReadonlySet<string>, w: Walk, depth: number): void {
  // ── 형별 검사 ──
  if (type === "FuncCall") {
    const n = names(o.funcname);
    if (!n || !n.length) bad("함수 이름을 읽지 못했습니다");
    const fn = n![n!.length - 1];
    // 파서가 SQL 표준 구문(extract · substring · trim · AT TIME ZONE …)을 pg_catalog.<함수> 로 바꿔 쓴 것만 받는다.
    if (n!.length > 1 && !(n!.length === 2 && n![0] === "pg_catalog" && o.funcformat === "COERCE_SQL_SYNTAX")) {
      bad(`스키마를 붙인 함수 호출(${n!.join(".")})은 쓸 수 없습니다 — 함수 이름만 쓰세요`);
    }
    if (forbiddenFunction(fn)) bad(forbiddenFunctionReason(fn.toLowerCase()));
    if (REG_TYPES.test(fn.toLowerCase())) bad(`reg* 형(${fn})은 쓸 수 없습니다`);
  } else if (type === "A_Expr") {
    checkQualifiedList(o.name, "연산자");
  } else if (type === "SubLink") {
    checkQualifiedList(o.operName, "연산자");
  } else if (type === "SortBy") {
    checkQualifiedList(o.useOp, "연산자");
  } else if (type === "CollateClause") {
    checkQualifiedList(o.collname, "콜레이션");
  } else if (type === "IndexElem") {
    checkQualifiedList(o.collation, "콜레이션");
    checkQualifiedList(o.opclass, "연산자 클래스");
  } else if (type === "TypeName") {
    checkTypeName(o);
  } else if (type === "ColumnRef") {
    const f = Array.isArray(o.fields) ? o.fields : [];
    if (f.length > 2) bad("칸은 `칸` 또는 `테이블.칸` 으로 쓰세요(스키마를 붙인 이름은 쓸 수 없습니다)");
    for (const s of names(f.filter((e) => isObj(e) && "String" in e)) ?? []) checkIdentName(s, "이름");
  } else if (type === "ParamRef") {
    const num = Number(o.number);
    if (!Number.isInteger(num) || num < 1) bad("파라미터는 $1 부터 씁니다");
    w.maxParam = Math.max(w.maxParam, num);
  } else if (type === "ResTarget") {
    if (typeof o.name === "string") checkIdentName(o.name, "이름");
  } else if (type === "RangeTableSample") {
    const m = names(o.method);
    if (!m || m.length !== 1 || !TABLESAMPLE_METHODS.has(m[0].toLowerCase())) bad("TABLESAMPLE 은 system · bernoulli 만 받습니다");
  } else if (type === "LockingClause") {
    // FOR UPDATE · FOR SHARE … OF <별칭> — OF 뒤는 테이블이 아니라 FROM 자리의 이름(별칭)이다. 바꿔 쓰지 않는다.
    w.locks = true;
    for (const r of Array.isArray(o.lockedRels) ? o.lockedRels : []) {
      const rv = isObj(r) && isObj(r.RangeVar) ? r.RangeVar : null;
      if (!rv || rv.schemaname || rv.catalogname) bad("FOR UPDATE OF 뒤에는 FROM 에 쓴 이름(별칭)만 씁니다");
    }
    return;
  } else if (type === "SelectStmt" || type === "InsertStmt" || type === "UpdateStmt" || type === "DeleteStmt") {
    statementChecks(type, o);
  }
  if (typeof o.aliasname === "string") checkIdentName(o.aliasname, "별칭");
  if (isObj(o.typeName)) checkTypeName(o.typeName);
  // 형이 정해진 칸으로 온 SELECT(집합 연산의 larg·rarg)도 같은 검사를 받는다.
  if (type === null && "op" in o && "limitOption" in o) statementChecks("SelectStmt", o);

  // ── 테이블 자리 ──
  if (typeof o.relname === "string") {
    if (o.schemaname || o.catalogname) bad(`스키마를 붙인 이름(${[o.catalogname, o.schemaname, o.relname].filter(Boolean).join(".")})은 쓸 수 없습니다 — 매니페스트에 선언한 테이블 이름만 쓰세요(FROM contacts)`);
    const rel = o.relname;
    if (w.declared.has(rel)) {
      const loc = Number(o.location);
      if (!Number.isInteger(loc) || loc < 0) bad("테이블 자리를 확실히 읽지 못했습니다");
      w.refs.push({ loc, relname: rel, aliased: isObj(o.alias) });
      w.tables.add(rel);
    } else if (!scope.has(rel)) {
      throw new HttpError(403, `이 앱이 선언하지 않은 테이블입니다: ${rel} — 이 앱의 테이블: ${[...w.declared].sort().join(", ") || "(없음)"}. 새 테이블은 매니페스트 data.tables 에 선언하세요`);
    }
  }

  // ── WITH — 이름이 보이는 범위(Postgres 규칙): 재귀가 아니면 앞서 정의된 것만, 재귀면 자기까지, 본문은 전부 ──
  let inner = scope;
  if (isObj(o.withClause)) {
    const wc = o.withClause;
    const ctes = (Array.isArray(wc.ctes) ? wc.ctes : []).map((c) => (isObj(c) && isObj(c.CommonTableExpr) ? c.CommonTableExpr : null));
    if (ctes.some((c) => !c)) bad("WITH 절을 읽지 못했습니다");
    const all = ctes.map((c) => String(c!.ctename ?? ""));
    for (const n of all) {
      if (!n) bad("WITH 이름이 없습니다");
      if (w.declared.has(n)) bad(`WITH 이름 '${n}' 가 이 앱의 테이블 이름과 같습니다 — 다른 이름을 쓰세요`);
      if (n.toLowerCase().startsWith("pg_")) bad(`WITH 이름 '${n}' 는 쓸 수 없습니다(pg_ 로 시작)`);
      checkIdentName(n, "WITH 이름");
    }
    ctes.forEach((c, i) => {
      const q = c!.ctequery;
      const qt = isObj(q) ? Object.keys(q)[0] : "";
      if (qt !== "SelectStmt") {
        bad(qt === "InsertStmt" || qt === "UpdateStmt" || qt === "DeleteStmt" || qt === "MergeStmt"
          ? "WITH 안의 INSERT·UPDATE·DELETE 는 받지 않습니다 — 여러 쓰기는 묶음(store_sql_batch · SDK db.batch)으로 나눠 쓰세요"
          : "WITH 절을 읽지 못했습니다");
      }
      const visible = new Set([...scope, ...(wc.recursive ? all : all.slice(0, i))]);
      for (const [k, v] of Object.entries(c!)) if (k !== "ctename") walk(v, visible, w, depth + 1);
    });
    inner = new Set([...scope, ...all]);
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === "withClause") continue;
    if (v !== null && typeof v === "object") walk(v, inner, w, depth + 1);
  }
}

/** 시험 전용 — 임의 트리를 검사 산책에 넣는다(지금 문법으로는 만들 수 없는 노드가 허용 목록에서 막히는지 보려고). */
export function _walkTreeForTest(tree: unknown, declared: readonly string[]): void {
  walk(tree, new Set(), { declared: new Set(declared), tables: new Set(), refs: [], maxParam: 0, locks: false }, 0);
}

/** 문장 노드(어느 깊이든) — SELECT INTO · ON CONSTRAINT · OVERRIDING SYSTEM VALUE. */
function statementChecks(type: string, o: J): void {
  if (type === "SelectStmt" && isObj(o.intoClause)) bad("SELECT … INTO 는 받지 않습니다(새 테이블을 만든다) — INSERT INTO <선언 테이블> SELECT … 로 쓰세요");
  if (type === "InsertStmt") {
    if (o.override === "OVERRIDING_SYSTEM_VALUE") bad("OVERRIDING SYSTEM VALUE 는 받지 않습니다 — id 는 DB 가 정합니다(INSERT … RETURNING id 로 받으세요)");
    const oc = isObj(o.onConflictClause) ? o.onConflictClause : null;
    if (oc && isObj(oc.infer) && oc.infer.conname) bad("ON CONFLICT ON CONSTRAINT 는 받지 않습니다 — ON CONFLICT (칸, …) 로 쓰세요(그 칸들에 unique 를 매니페스트로 선언)");
  }
}

/** 트리 안에 칸 참조가 있나(늘 참인 조건을 가르는 데 쓴다). */
function hasColumnRef(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(hasColumnRef);
  if (!isObj(x)) return false;
  if ("ColumnRef" in x) return true;
  return Object.values(x).some((v) => v !== null && typeof v === "object" && hasColumnRef(v));
}

/**
 * 바이트 위치 at 에서 시작하는 식별자 하나 — Postgres 렉서 규칙의 부분집합: 인용 이름 `"…"`(안의 `""` 는 `"`)과
 *  인용 안 한 이름(글자·밑줄·0x80 이상 바이트로 시작, 이어서 숫자·$). 인용 안 한 것은 소문자로 접는다(ASCII 만 — Postgres 와 같다).
 *  다른 모양(U&"…" 등)이면 null — 호출부가 거부한다.
 */
function identAt(buf: Buffer, at: number): { name: string; end: number } | null {
  const c = buf[at];
  if (c === 0x22) {
    let i = at + 1;
    for (;;) {
      if (i >= buf.length) return null;
      if (buf[i] === 0x22) { if (buf[i + 1] === 0x22) { i += 2; continue; } break; }
      i++;
    }
    return { name: buf.subarray(at + 1, i).toString("utf8").replace(/""/g, "\""), end: i + 1 };
  }
  const start = (b: number): boolean => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f || b >= 0x80;
  const part = (b: number): boolean => start(b) || (b >= 0x30 && b <= 0x39) || b === 0x24;
  if (c === undefined || !start(c)) return null;
  let i = at + 1;
  while (i < buf.length && part(buf[i])) i++;
  return { name: buf.subarray(at, i).toString("utf8").replace(/[A-Z]+/g, (m) => m.toLowerCase()), end: i };
}

/** libpg_query 오류 → 사람이 읽을 400. 위치는 바이트라 글자 위치로 바꿔 앞뒤를 보인다. */
function parseError(e: unknown, buf: Buffer): never {
  const err = e as { message?: string; sqlDetails?: { cursorPosition?: number } };
  const msg = String(err?.message ?? e).replace(/^Error:\s*/, "");
  const pos = Number(err?.sqlDetails?.cursorPosition);
  let near = "";
  if (Number.isInteger(pos) && pos >= 0) {
    const at = buf.subarray(0, Math.min(pos, buf.length)).toString("utf8").length;
    const text = buf.toString("utf8");
    near = ` (${at + 1}번째 글자 근처: «${text.slice(Math.max(0, at - 20), at + 20).replace(/\s+/g, " ")}»)`;
  }
  return bad(`SQL 문법 오류: ${msg}${near}`);
}

function parseOne(text: string, buf: Buffer): { type: string; body: J; loc: number; len: number } {
  let tree: { stmts?: Array<{ stmt?: unknown; stmt_location?: number; stmt_len?: number }> };
  try { tree = parseSync(text) as typeof tree; }
  catch (e) {
    if (e instanceof RangeError) bad("문장이 너무 복잡합니다 — 서브쿼리·괄호를 줄여 주세요");
    return parseError(e, buf);
  }
  const stmts = tree.stmts ?? [];
  if (stmts.length !== 1) bad(stmts.length ? "한 번에 한 문장만 받습니다 — 여러 문장은 묶음(store_sql_batch · SDK db.batch)으로 보내세요" : "비어 있습니다");
  const s = stmts[0];
  const top = isObj(s.stmt) ? wrapped(s.stmt) : null;
  if (!top) bad("문장을 읽지 못했습니다");
  return { type: top![0], body: top![1], loc: Number(s.stmt_location ?? 0), len: Number(s.stmt_len ?? 0) };
}

/** 받지 않는 문장 종류 → 대신 쓸 길. */
function unsupportedStatement(type: string): never {
  const t = type.replace(/Stmt$/, "");
  if (/^(Create|Alter|Drop|Truncate|Rename|Comment|Grant|Revoke|Index|View|Create.*)/.test(t)) {
    return bad(`${t} 문장은 받지 않습니다 — 테이블·칸·인덱스·제약은 매니페스트 data.tables 로 바꿉니다(앱을 저장·설치하면 반영)`);
  }
  if (t === "Transaction" || t === "VariableSet" || t === "VariableShow") {
    return bad("트랜잭션·설정 문장은 받지 않습니다 — 여러 문장을 한꺼번에(전부 되거나 전부 취소) 하려면 묶음(store_sql_batch · SDK db.batch)을 쓰세요");
  }
  if (t === "Merge") return bad("MERGE 는 받지 않습니다 — INSERT … ON CONFLICT (칸) DO UPDATE 로 쓰세요");
  return bad(`${t} 문장은 받지 않습니다 — SELECT · INSERT · UPDATE · DELETE 만`);
}

// ── 계획 ───────────────────────────────────────────────────────────────────────────────

export interface PlanAppSqlOpts {
  appId: string;
  /** 테이블이 사는 스키마(store-schema.appSchemaFor). */
  schema: string;
  /** 매니페스트 data.tables 의 선언 이름들. */
  tables: readonly string[];
}

/**
 * 앱 SQL 한 문장을 검사하고 실행할 모양으로 바꾼다. 받을 수 없으면 HttpError(400 · 선언 밖 테이블은 403).
 *  반환한 plan.sql 은 앱 역할·좁힌 search_path 아래에서 돌려야 한다(app-sql-exec) — 이 함수만으로는 경계가 아니다.
 *  먼저 ensureAppSqlParser() 를 기다려야 한다(planAppSql 이 대신 부른다).
 */
export async function planAppSql(input: string, opts: PlanAppSqlOpts): Promise<AppSqlPlan> {
  await ensureAppSqlParser();
  return planAppSqlSync(input, opts);
}

/** ensureAppSqlParser() 가 끝난 뒤에만 부른다(묶음이 문장마다 기다리지 않게). */
export function planAppSqlSync(input: string, opts: PlanAppSqlOpts): AppSqlPlan {
  if (!ready) throw new HttpError(503, "SQL 해석기가 아직 준비되지 않았습니다");
  const raw = String(input ?? "");
  if (raw.length > APP_SQL_MAX_LEN) bad(`너무 깁니다(${raw.length}자, 최대 ${APP_SQL_MAX_LEN}자)`);
  if (raw.includes("\0")) bad("NUL 문자가 있습니다");
  const trimmed = raw.trim();
  if (!trimmed) bad("비어 있습니다");

  // 1) 문장 하나를 떼어 낸다 — 끝 세미콜론·꼬리 주석을 버리고(실행기가 이 문장을 괄호로 감싼다) 다시 해석한다.
  //    떼어 낼 것이 없으면(Drizzle 이 만드는 SQL 은 늘 그렇다) 첫 해석을 그대로 쓴다.
  const whole = Buffer.from(trimmed, "utf8");
  const first = parseOne(trimmed, whole);
  const end = first.len > 0 ? first.loc + first.len : whole.length;
  const same = first.loc === 0 && end === whole.length;
  const text = same ? trimmed : whole.subarray(first.loc, end).toString("utf8").trim();
  const buf = same ? whole : Buffer.from(text, "utf8");
  const { type, body } = same ? first : parseOne(text, buf);
  const kind = STATEMENTS[type];
  if (!kind) unsupportedStatement(type);

  // 2) 조건 없는 UPDATE·DELETE(실수 방지).
  if (kind === "update" || kind === "delete") {
    const verb = kind.toUpperCase();
    if (!body.whereClause) bad(`조건(WHERE) 없는 ${verb} 는 받지 않습니다 — 모든 행이 바뀝니다. 대상 행을 고르는 조건을 적으세요`);
    if (!hasColumnRef(body.whereClause)) bad(`${verb} 의 조건에 칸이 없습니다(늘 참인 조건) — 대상 행을 고르는 조건을 적으세요`);
  }

  // 3) 트리 전체 — 허용 목록 · 함수 · 형 · 연산자 · 테이블 자리 · WITH 범위.
  const w: Walk = { declared: new Set(opts.tables.map((t) => t.toLowerCase())), tables: new Set(), refs: [], maxParam: 0, locks: false };
  try { node(type, body, new Set(), w, 0); }
  catch (e) {
    if (e instanceof RangeError) bad("문장이 너무 복잡합니다 — 서브쿼리·괄호를 줄여 주세요");
    throw e;
  }
  if (w.maxParam > APP_SQL_MAX_PARAMS) bad(`파라미터가 너무 많습니다($${w.maxParam}, 최대 ${APP_SQL_MAX_PARAMS})`);

  // 4) 바꿔 쓰기 — 파서가 알려 준 위치에서 식별자 하나를 읽어 그 이름 그대로인지 한 번 더 확인한다(어긋나면 바꾸지 않고 거부).
  //    libpg_query 의 렉서 출력(scanSync)은 쓰지 않는다 — 2KB 넘는 토큰 하나(긴 문자열 값)가 있으면 JSON 이 잘려 깨진다(18.1.4 실측).
  const refs = [...w.refs].sort((a, b) => a.loc - b.loc);
  const parts: Buffer[] = [];
  let pos = 0;
  for (const r of refs) {
    const id = identAt(buf, r.loc);
    if (!id || id.name !== r.relname || r.loc < pos) bad(`테이블 자리(${r.relname})를 확실히 읽지 못했습니다 — 더 단순하게 써 주세요`);
    parts.push(buf.subarray(pos, r.loc), Buffer.from(qualifiedAppTable(opts.schema, opts.appId, r.relname) + (r.aliased ? "" : ` AS "${r.relname}"`), "utf8"));
    pos = id!.end;
  }
  parts.push(buf.subarray(pos));

  const relOf = (x: unknown): string | null => (isObj(x) && typeof x.relname === "string" ? x.relname : null);
  const target = kind === "select" ? null : relOf(body.relation);
  const returning = kind === "select" || (isObj(body.returningClause) && Array.isArray(body.returningClause.exprs) && body.returningClause.exprs.length > 0);
  return {
    kind,
    writes: kind !== "select",
    locks: w.locks,
    returning,
    tables: [...w.tables].sort(),
    targets: target && w.tables.has(target) ? [target] : [],
    sql: Buffer.concat(parts).toString("utf8"),
    paramCount: w.maxParam,
  };
}

// ── 결과 상한 — DB 쪽에서 자른다 ─────────────────────────────────────────────────────────
//  종전 db_query 실행기는 결과를 **전부 받은 뒤** 잘랐다(query-exec allRows.slice). 큰 결과 하나가 게이트웨이(전원이
//  나눠 쓰는 메모리)를 터뜨릴 수 있어서, 앱 SQL 은 행 수와 바이트를 DB 안에서 센다:
//   · 행: 안쪽에서 LIMIT (상한+1) — +1 은 «잘렸나» 를 알기 위해
//   · 바이트: 행마다 텍스트 표현 길이의 누적합(창 함수)을 두고 상한 밖의 행은 DB 에서 버린다(값 하나가 커도 오지 않는다)
//  바깥은 «세기» 한 행에 LEFT JOIN 한다 — 행이 하나도 안 남아도(첫 행부터 상한을 넘어도) 전체 수는 늘 돌아온다.
//  감싼 결과의 끝 세 칸(__lively_rn · __lively_acc · __lively_total)은 실행기가 떼어 낸다. __lively_rn 이 NULL 인 행은
//  «데이터 없음» 표지다.
//  쓰기 + RETURNING 은 CTE 로 감싼다 — 데이터를 바꾸는 CTE 는 LIMIT 과 상관없이 끝까지 한 번 실행되므로(Postgres 규칙)
//  바뀐 행 수(total)는 전체를 센다. SELECT 는 전체를 세면 LIMIT 이 무의미해지므로 잘린 묶음 안에서만 센다(상한+1 이면 잘림).
//  사용자 문장은 앞뒤 줄바꿈으로 감싼다 — 꼬리에 `-- 주석` 이 남아도 닫는 괄호를 먹지 않게.
export const WRAP_COLUMNS = ["__lively_rn", "__lively_acc", "__lively_total"] as const;

export function wrapForCaps(plan: Pick<AppSqlPlan, "kind" | "returning" | "sql">, caps: { maxRows: number; maxBytes: number }): string {
  if (!plan.returning) return plan.sql;
  const rows = Math.max(1, Math.floor(caps.maxRows));
  const bytes = Math.max(1, Math.floor(caps.maxBytes));
  const counted = plan.kind === "select" ? "__lively_l" : "__lively_q";
  return [
    "WITH __lively_q AS (",
    plan.sql,
    "), __lively_l AS (",
    `  SELECT __lively_q.*, row_number() OVER () AS __lively_rn FROM __lively_q LIMIT ${rows + 1}`,
    "), __lively_s AS (",
    "  SELECT __lively_l.*, sum(octet_length(__lively_l::text)) OVER (ORDER BY __lively_l.__lively_rn ROWS UNBOUNDED PRECEDING) AS __lively_acc",
    "    FROM __lively_l",
    "), __lively_m AS (",
    `  SELECT count(*) AS n FROM ${counted}`,
    ")",
    "SELECT __lively_s.*, __lively_m.n AS __lively_total",
    "  FROM __lively_m LEFT JOIN __lively_s",
    `    ON __lively_s.__lively_rn <= ${rows} AND __lively_s.__lively_acc <= ${bytes}`,
    " ORDER BY __lively_s.__lively_rn",
  ].join("\n");
}

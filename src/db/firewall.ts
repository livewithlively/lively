import pkg from "node-sql-parser";

// node-sql-parser 는 CommonJS — ESM 에서는 default import 후 구조분해해야 한다.
const { Parser } = pkg;
const parser = new Parser();

// 방어선 1: 위험 키워드/함수 패턴 차단 (파서가 못 잡는 확장기능 포함)
const BLOCKED: RegExp[] = [
  /\bpg_read_file\b/i,
  /\bpg_ls_dir\b/i,
  /\blo_import\b/i,
  /\blo_export\b/i,
  /\bpg_sleep\b/i,
  /\bdblink\b/i,
  /\bcopy\b/i,
  /\bset\s+role\b/i,
  /\bset_config\b/i, // 게이트웨이가 주입한 RLS GUC(app.current_user 등) 덮어쓰기 방지
  /\bcurrent_setting\b/i,
  /\bcreate\b/i,
  /\balter\b/i,
  /\bdrop\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\btruncate\b/i,
];

// ── mysql dialect(#715) — MySQL(Aurora) 소스용 차단목록. pg 목록(BLOCKED)은 후방호환 위해 무변경. ──
//  파일 I/O(LOAD_FILE·INTO OUTFILE/DUMPFILE·LOAD DATA)·DoS(BENCHMARK·SLEEP·GET_LOCK)·세션변수(SET GLOBAL/
//  SESSION/@@ — 게이트웨이가 주입한 max_execution_time 무력화 방지)·프로시저/동적SQL(CALL·PREPARE·EXECUTE·
//  HANDLER)·복제/관리(KILL·MASTER_POS_WAIT) + 공통 DML/DDL. 정규식은 리터럴에도 매칭될 수 있으나 fail-closed(안전측).
const MYSQL_BLOCKED: RegExp[] = [
  /\bload_file\b/i,
  /\bload\s+data\b/i,
  /\binto\s+(outfile|dumpfile)\b/i,
  /\bbenchmark\b/i,
  /\bsleep\b/i,
  /\bget_lock\b/i,
  /\brelease_lock\b/i,
  /\bis_free_lock\b/i,
  /\bis_used_lock\b/i,
  /\bmaster_pos_wait\b/i,
  /\bwait_for_executed_gtid_set\b/i,
  /\bset\s+(global|session|persist|@@)/i, // 게이트웨이 주입 세션변수(max_execution_time) 덮어쓰기 방지
  /\bhandler\b/i,
  /\bprepare\b/i,
  /\bexecute\b/i,
  /\bcall\b/i,
  /\bkill\b/i,
  /\breplace\b/i, // REPLACE INTO(쓰기). 문자열함수 REPLACE() 도 걸리지만 fail-closed 수용
  /\block\s+tables\b/i,
  /\bcreate\b/i,
  /\balter\b/i,
  /\bdrop\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\btruncate\b/i,
];

// 방어선 2: AST 함수호출 차단목록. 정규식은 주석/스키마수식(pg_catalog.set_config)으로 우회 가능하므로,
// astify 결과를 walk 하여 CTE·서브쿼리까지 포함한 모든 function 노드를 검사한다 — RLS GUC 덮어쓰기/읽기와
// 파일·sleep 류를 SQL 한 줄로 무력화하지 못하게 하는 진짜 방어선.
const FORBIDDEN_FUNCTIONS = new Set([
  "set_config",
  "current_setting",
  "pg_read_file",
  "pg_ls_dir",
  "lo_import",
  "lo_export",
  "pg_sleep",
  "dblink",
]);
// mysql AST 함수 차단(#715) — 주석 삽입(`SLEEP/**/(1)`) 등 정규식 우회 대비 2차 방어선.
const MYSQL_FORBIDDEN_FUNCTIONS = new Set([
  "load_file",
  "sleep",
  "benchmark",
  "get_lock",
  "release_lock",
  "is_free_lock",
  "is_used_lock",
  "master_pos_wait",
  "wait_for_executed_gtid_set",
]);

function assertNoForbiddenFunctions(ast: unknown, forbidden: Set<string> = FORBIDDEN_FUNCTIONS): void {
  const stack: unknown[] = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const el of node) stack.push(el);
      continue;
    }
    const n = node as Record<string, unknown>;
    if ((n.type === "function" || n.type === "aggr_func") && n.name !== null && typeof n.name === "object") {
      // node-sql-parser v5: name = { name: [{ value: 'set_config' }, ...] } — 스키마수식이면 여러 파트.
      const parts = (n.name as { name?: unknown }).name;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          const v = (part as { value?: unknown } | null)?.value;
          if (typeof v === "string" && forbidden.has(v.toLowerCase())) {
            throw new Error(`Blocked function: ${v}`);
          }
        }
      }
    }
    for (const val of Object.values(n)) {
      if (val !== null && typeof val === "object") stack.push(val);
    }
  }
}

// 방어선 3(B18): db_query 가 민감 테이블을 읽지 못하게 한다.
//  db_query 는 게이트웨이 읽기풀(DATABASE_URL)을 쓰고 org-content 는 items 풀(ITEMS_DATABASE_URL)에 있어
//  배포에 따라 물리 분리될 수 있으나, 같은 DB/리플리카에 섞이는 배포에선 토큰 해시·감사·훅 소스코드·툴
//  정의가 자유 SELECT 로 새어나갈 수 있다 → 코드로 deny(배포 토폴로지와 무관한 방어). 운영 권장 보강:
//  db_query 리플리카에서 이 테이블들을 물리 제외 + 기동 시 자가검증 + RLS.
//  #604: admin 이 자기 items DB 를 직접 읽는 내장 self 소스(db/self-source.ts) 도입으로 items DB=콘텐츠+시크릿이
//   한 물리 DB 인 통합배포에서 자유 SELECT 노출면이 커졌다 → 시크릿/자격증명/세션/콜로그 테이블을 백스톱에 확대.
//   (self 소스는 default-deny allow-list 로도 막지만, 웹 table-policy 오작동에도 새지 않게 코드로 이중 차단.)
//   PII(person*/org_member)는 여기 넣지 않는다 — 고객이 등록한 제품 DB 에 동명 테이블이 있으면 정당한 조회를
//   막게 되므로. self 소스에서의 PII 차단은 allow-list(콘텐츠 미포함)로 처리한다.
const DENIED_TABLES = new Set([
  "auth_token", "org_content_audit", "org_hook", "org_tool", "org_harness_asset", "org_asset_pref", "org_mcp_server", "org_db_source",
  "member_credential", "web_session", "git_credential", "org_connector", "mcp_call_log",
  "db_access_log", "org_db_subject_key", // P5(#746) 감사 기록·감사 설정 — 조회는 전용 표면(db_audit_list)으로만
  "member_secret", // P1(#746) per-user 자격 vault(secret_enc) — git_credential 과 동급 시크릿 테이블(db_query 자유 SELECT·self 소스 정책우회 차단)
  "member_channel_policy", // #1226 개인이 숨긴 대화 채널 — '누가 어떤 채널을 가렸는지'도 그 사람의 사생활(시크릿은 아니지만 열람 금지)
  "member_channel_meta",   // #1262 대화 종류 캐시 — '누가 어떤 대화(비공개 채널·DM)에 속해 있는지' 도 같은 급의 사생활
]);

// 게이트웨이 내부 테이블 절대 deny(B18) 여부 — 웹 정책과 무관하게 항상 차단(웹 UI·db_schema 가 정직하게 '시스템 차단'으로 표시하는 데 쓴다).
export function isSystemDeniedTable(name: string): boolean {
  return DENIED_TABLES.has(name.toLowerCase());
}

// ── 소스별 정책(#186) — 웹 관리 테이블 allow/deny + 컬럼 마스킹. src/db/policy.ts 가 조립해 넘긴다. ──
export interface SourcePolicy {
  tableDefault: "allow" | "deny"; // 정책행 없는 테이블의 기본자세
  tableMode: Map<string, "allow" | "deny">; // key: lower(table)
  maskedCols: Set<string>; // key: `${lower(table)}.${lower(col)}`
  maskedColNames: Set<string>; // lower(col) — 미수식 참조 보수적 매칭용
  hasMasks: boolean;
}
// 게이트1 산출 — 게이트2(tools/db.ts) fail-closed 검증에 쓰는 '마스킹 출력 기대치'.
export interface QueryPlan {
  minMaskedOutputs: number; // 최상위 투영에 그대로 나온 마스킹 컬럼 수(하한)
  hasTopStarOverMaskedTable: boolean; // 최상위 * 가 마스킹 테이블을 덮는가
  tables?: string[]; // 참조 테이블 전수(lower, 조인/서브쿼리 포함) — db 접근 감사(P5, #746) 기록용. assertSafeSelect 가 채운다.
}
const EMPTY_PLAN: QueryPlan = { minMaskedOutputs: 0, hasTopStarOverMaskedTable: false };

// column_ref 노드에서 컬럼명 추출 — v5: column={expr:{value}} | "*" | (구버전) string.
function refColName(node: Record<string, unknown>): string | null {
  const c = node.column;
  if (c === "*") return "*";
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    const e = (c as { expr?: { value?: unknown } }).expr;
    if (e && typeof e.value === "string") return e.value;
  }
  return null;
}
// column_ref 노드에서 테이블/별칭 추출 — table=null | "u" | {value:"u"}.
function refTableName(node: Record<string, unknown>): string | null {
  const t = node.table;
  if (t == null) return null;
  if (typeof t === "string") return t;
  if (typeof t === "object" && typeof (t as { value?: unknown }).value === "string") return (t as { value: string }).value;
  return null;
}
// AST 하위 전 column_ref 노드 수집(CTE·서브쿼리·표현식·set-op 포함 전수). 노드 아이덴티티 보존.
function collectColumnRefs(root: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) { for (const el of node) stack.push(el); continue; }
    const n = node as Record<string, unknown>;
    if (n.type === "column_ref") out.push(n);
    for (const v of Object.values(n)) if (v !== null && typeof v === "object") stack.push(v);
  }
  return out;
}

/**
 * 게이트1(#186) — 소스 정책 집행(테이블 allow/deny + 마스킹-파생 차단). 순수(라이브 스키마 불요).
 *  진짜 마스킹은 게이트2(tools/db.ts, 실행 후 출처기반)가 하고, 여기선 '마스킹 원본이 출력에 새는 경로'를 원천 차단한다:
 *  마스킹 컬럼은 최상위 SELECT 투영에 그대로(또는 최상위 *)만 허용 — 표현식/WHERE/JOIN/ORDER/서브쿼리/CTE/UNION 참조는 거부.
 *  그러면 마스킹 원본이 출력에 도달하는 경로는 '최상위 직접 투영/스타'뿐 → 출처가 확실 → 게이트2가 반드시 마스킹(건전).
 */
export function assertSourcePolicy(stmt: Record<string, unknown>, tableNames: string[], policy: SourcePolicy): QueryPlan {
  // ── 테이블 게이트 — 참조 테이블 전부 effective allow 여야 함(effective = 정책행 or table_default). ──
  for (const t of tableNames) {
    const mode = policy.tableMode.get(t) ?? policy.tableDefault;
    if (mode === "deny") {
      // blockedTable 은 호출측(tools/db.ts)이 '정책 deny 인가, 실은 없는 이름인가'를 카탈로그로 갈라
      //  답하는 데 쓴다(#1259). 문구 파싱에 의존하지 않도록 구조화해 실어 보낸다.
      throw Object.assign(
        new Error(`Blocked table: ${t} — 이 소스에서 조회가 허용되지 않은 테이블입니다(웹에서 허용 설정 필요)`),
        { blockedTable: t },
      );
    }
  }
  if (!policy.hasMasks) return EMPTY_PLAN;

  // 이 쿼리에 관련된 마스킹 컬럼명(참조 테이블에 걸린 것만)
  const relevantNames = new Set<string>();
  for (const key of policy.maskedCols) {
    const dot = key.indexOf(".");
    if (tableNames.includes(key.slice(0, dot))) relevantNames.add(key.slice(dot + 1));
  }
  if (relevantNames.size === 0) return EMPTY_PLAN;

  // 최상위 from 별칭맵 + 마스킹 테이블 판정
  const aliasMap = new Map<string, string>(); // lower(alias|table) -> lower(realTable)
  const topFromTables: string[] = [];
  if (Array.isArray(stmt.from)) {
    for (const f of stmt.from) {
      const fo = f as { table?: unknown; as?: unknown };
      if (typeof fo.table === "string") {
        const rt = fo.table.toLowerCase();
        topFromTables.push(rt);
        aliasMap.set(rt, rt);
        if (typeof fo.as === "string" && fo.as) aliasMap.set(fo.as.toLowerCase(), rt);
      }
    }
  }
  const tableHasMask = (t: string): boolean => {
    for (const key of policy.maskedCols) if (key.startsWith(t + ".")) return true;
    return false;
  };
  const isSensitive = (ref: Record<string, unknown>, cn: string): boolean => {
    const tr = refTableName(ref);
    if (tr) {
      const real = aliasMap.get(tr.toLowerCase()) ?? tr.toLowerCase();
      return policy.maskedCols.has(`${real}.${cn.toLowerCase()}`);
    }
    return relevantNames.has(cn.toLowerCase()); // 미수식 — 보수적(이름 매칭, fail-closed)
  };

  // 허용 위치 = 최상위 투영의 bare column_ref / star (노드 아이덴티티로 판정)
  const allowedRef = new Set<unknown>();
  const allowedStar = new Set<unknown>();
  if (Array.isArray(stmt.columns)) {
    for (const item of stmt.columns) {
      const e = (item as { expr?: Record<string, unknown> }).expr;
      if (e && e.type === "column_ref") {
        if (refColName(e) === "*") allowedStar.add(e); else allowedRef.add(e);
      }
    }
  }

  // set-op(UNION 등)이면 최상위 투영도 출처 신뢰 불가 → 마스킹 컬럼 관여 자체를 금지.
  if ((stmt as { _next?: unknown })._next) {
    for (const ref of collectColumnRefs(stmt)) {
      const cn = refColName(ref);
      if (cn && cn !== "*" && isSensitive(ref, cn)) throw new Error(`Blocked: 마스킹 컬럼 '${cn}' 은 집합연산(UNION 등)에 사용할 수 없습니다 — 단일 SELECT 로 직접 조회하세요`);
      if (cn === "*" && topFromTables.some(tableHasMask)) throw new Error(`Blocked: 마스킹 테이블에 대한 '*' 은 집합연산에 사용할 수 없습니다`);
    }
    return EMPTY_PLAN;
  }

  // 게이트1 본체 — 모든 column_ref 를 훑어 마스킹 컬럼이 허용 위치 밖이면 거부.
  for (const ref of collectColumnRefs(stmt)) {
    const cn = refColName(ref);
    if (cn === "*") {
      if (allowedStar.has(ref)) continue; // 최상위 투영 스타 — 게이트2가 출처로 마스킹
      throw new Error(`Blocked: '*' 는 서브쿼리 등 비최상위 위치에서 쓸 수 없습니다(마스킹 소스 보호) — 컬럼을 명시하세요`);
    }
    if (!cn) continue;
    if (isSensitive(ref, cn) && !allowedRef.has(ref)) {
      throw new Error(`Blocked: 마스킹 컬럼 '${cn}' 은 최상위 SELECT 투영에 그대로만 쓸 수 있습니다(표현식·WHERE·JOIN·ORDER·GROUP·서브쿼리 불가) — 개인정보 파생/필터 차단`);
    }
  }

  let minMaskedOutputs = 0;
  for (const node of allowedRef) {
    const n = node as Record<string, unknown>;
    if (isSensitive(n, refColName(n) ?? "")) minMaskedOutputs++;
  }
  let hasTopStarOverMaskedTable = false;
  for (const st of allowedStar) {
    const tr = refTableName(st as Record<string, unknown>);
    const scope = tr === null ? topFromTables : [aliasMap.get(tr.toLowerCase()) ?? tr.toLowerCase()];
    if (scope.some(tableHasMask)) { hasTopStarOverMaskedTable = true; break; }
  }
  return { minMaskedOutputs, hasTopStarOverMaskedTable };
}

// 카탈로그(메타데이터) 스키마 — 여기를 SELECT 로 더듬는 건 '스키마를 알고 싶다'는 뜻이니 안내를 붙인다(#1259).
const CATALOG_SCHEMAS = new Set(["information_schema", "mysql", "sys", "performance_schema", "pg_catalog"]);

// 엔진별 SQL dialect(#715) — 파서·차단목록 선택. 기본 postgresql(후방호환).
export type SqlDialect = "postgresql" | "mysql";
export interface SafeSelectOpts {
  dialect?: SqlDialect;
  // mysql 전용: 소스가 고정된 스키마(=database). db-수식 참조(`otherdb.t`)가 이 스키마 밖이면 거부 —
  //  MySQL 계정은 여러 스키마를 SELECT 할 수 있어, 스키마 밖 참조를 허용하면 per-source 정책(테이블
  //  allow/deny·마스킹이 bare 테이블명 키)이 다른 스키마의 동명/이명 테이블로 우회된다(fail-open). 원천 차단.
  schema?: string | null;
}

// ── #1181 ②③ 파서가 모르는 pg 연산자 + 원문 스캔 ──
//  node-sql-parser 는 pg 연산자의 일부만 안다(실측 5.4.0). pgvector 거리연산자(<=> <-> <#> <+>)뿐 아니라
//  전문검색 @@ · 거듭제곱 ^ · starts-with ^@ · jsonpath @? · 비트 & | # · 시프트/범위 << >> <<= >>= &< &> -|- ·
//  기하 연산자가 전부 `Unparseable SQL … but ">" found` 류로 막혔다.
//  그래서 **파서에 넘길 사본에서만** 연산자 문자 런을 pg 렉싱 규칙대로 읽어 '파서가 아는 연산자면 그대로,
//  모르면 같은 길이의 산술연산자(`%`+공백)로 중화'한다 — 이항식 구조와 피연산자(테이블·컬럼 참조)가 그대로
//  남아 테이블/마스킹 게이트 판정은 원본과 동일하다. 특정 연산자 목록을 좇지 않으므로 앞으로 어떤 확장
//  연산자가 와도 SQL 이 파싱 단계에서 막히지 않는다.
//  실행되는 SQL 은 언제나 사용자 원본이고(이 모듈은 검증만 한다), 중화본은 검증 AST 전용이다.
//  문자열·주석·인용식별자 안은 건드리지 않는다. 스캐너가 오판해도 방향은 안전측이다 —
//   (a) 리터럴 안을 중화 → 검증 AST 의 리터럴 '값'만 달라짐(정책은 값을 보지 않는다),
//   (b) 리터럴 밖을 놓침 → 파싱 실패 → 거부(fail-closed).
//  ⚠ 한계: **단항** 위치의 미지원 연산자(`|/ 16`·`@ x`)는 중화해도 이항식이 안 되어 거부된다(fail-closed).
//  같이 뽑는 mixedCaseQuoted 는 CTE 이름 대소문자 폴딩 판정용(#1181 ①, collectTableRefs 주석 참조).
const OP_CHARS = "+-*/<>=~!@#%^&|?"; // pg 연산자 문자(백틱 제외 — 인용식별자와 충돌)
//  파서가 아는 연산자(실측) — 이것만 원본대로 두고 나머지 런은 중화한다.
//  JSONB·배열·정규식이 여기 있다 = 그 쿼리들은 원래 막혀 있지 않았다.
const PARSER_KNOWN_OPS = new Set([
  "=", "<>", "!=", "<", ">", "<=", ">=", // 비교
  "+", "-", "*", "/", "%", // 산술
  "->", "->>", "#>", "#>>", "@>", "<@", "?", "?|", "?&", "#-", // json·jsonb
  "&&", "||", // 배열 겹침 · 연결
  "~", "~*", "!~", "!~*", // 정규식
]);
const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/; // 달러 인용 태그(숫자로 시작 불가 — $1 은 파라미터)
interface SqlTextScan {
  parseSql: string; // 파서에 넘길 사본(pg 에서만 중화 — 그 외엔 원본과 동일)
  mixedCaseQuoted: boolean; // 대문자를 포함한 인용식별자("Person" · `Person`)가 원문에 있는가
}
function scanSqlText(sql: string, neutralizeOps: boolean): SqlTextScan {
  const out = sql.split("");
  const n = sql.length;
  let mixedCaseQuoted = false;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") { // 줄 주석
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") { // 블록 주석(pg 는 중첩 허용)
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; continue; }
        i++;
      }
      continue;
    }
    if (c === "'") { // 문자열 리터럴('' 더블링 · 백슬래시 이스케이프 — sql-scrub 과 같은 관대한 규칙)
      i++;
      while (i < n) {
        if (sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (c === "\"" || c === "`") { // 인용 식별자 — 대소문자 보존 여부를 여기서 관측한다
      const close = c;
      const start = ++i;
      while (i < n) {
        if (sql[i] === close) { if (sql[i + 1] === close) { i += 2; continue; } break; }
        i++;
      }
      const ident = sql.slice(start, i);
      if (ident !== ident.toLowerCase()) mixedCaseQuoted = true;
      i++;
      continue;
    }
    if (c === "$") { // 달러 인용 문자열($tag$…$tag$)
      const tag = DOLLAR_TAG_RE.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
      i++;
      continue;
    }
    if (neutralizeOps && OP_CHARS.includes(c)) {
      // 연산자 문자 런을 통째로 읽는다 — 부분 매칭 금지(`#>>` 를 `#>` 로 자르면 남은 `>` 가 파싱을 깬다).
      let end = i;
      while (end < n && OP_CHARS.includes(sql[end])) {
        if (sql[end] === "-" && sql[end + 1] === "-") break; // 주석 시작 — 연산자 런은 여기서 끝난다
        if (sql[end] === "/" && sql[end + 1] === "*") break;
        end++;
      }
      if (end === i) { i++; continue; } // 방어(주석 경계와 겹치는 첫 글자) — 무한루프 방지
      let run = sql.slice(i, end);
      // pg 규칙: 다중문자 연산자는 `~!@#%^&|?` 를 하나도 안 가지면 끝의 +/- 를 포함하지 않는다(`<=>-1` = `<=>` 뒤 음수).
      if (run.length > 1 && !/[~!@#%^&|?]/.test(run)) {
        const trimmed = run.replace(/[+-]+$/, "");
        if (trimmed.length > 0) run = trimmed;
      }
      if (!PARSER_KNOWN_OPS.has(run)) {
        out[i] = "%"; // 길이 유지 — 파서 에러 위치가 원본 SQL 과 어긋나지 않게 한다
        for (let k = i + 1; k < i + run.length; k++) out[k] = " ";
      }
      i += run.length;
      continue;
    }
    i++;
  }
  return { parseSql: out.join(""), mixedCaseQuoted };
}

// ── #1181 ① CTE(WITH) 는 테이블이 아니다 ──
//  parser.tableList 는 WITH 별칭도 테이블로 돌려주고 스코프도 구분하지 않는다 → allow-list 소스(self)에서
//  WITH 를 쓰는 분석 쿼리가 전부 `Blocked table: <CTE 이름>` 으로 막혔다. AST 를 스코프 인지로 훑어
//  'CTE 로만 참조된 이름'을 가려낸다. 안전 설계(우회 불가):
//   - 이름이 **어디서든 실제 테이블로도** 참조되면 그대로 게이트 대상 — 다른 스코프에 동명 CTE 를 만들어
//     바깥의 진짜 테이블을 가리는 shadow 우회가 통하지 않는다.
//   - 가시범위는 pg 규칙 — 비-RECURSIVE 는 앞서 정의된 CTE 만, RECURSIVE 는 자기 자신까지, 스코프 밖은 불가.
//   - 이 walk 가 무언가를 놓치면 그 이름은 tableList 에 남아 게이트를 받는다(과잉차단 = fail-closed).
interface TableRefScan {
  real: Set<string>; // 실제 테이블로 참조된 이름(lower)
  cteRefs: Set<string>; // CTE 로 참조된 이름(lower)
  cteNames: Set<string>; // 정의된 CTE 이름 전부(lower) — 시스템 차단 테이블명 충돌 검사용
}
//  대소문자: pg/mysql 은 미인용 식별자를 소문자로 접는데, FROM 참조의 인용 여부는 AST 에 남지 않는다.
//  그래서 원문에 '대문자를 포함한 인용식별자'가 없을 때만(=대문자면 미인용 확정) 소문자 폴딩으로 비교하고,
//  있으면 소문자 이름끼리만 매칭한다 — 애매한 건 실제 테이블 취급(fail-closed).
function identKey(raw: string, quoted: boolean, fold: boolean): string | null {
  const name = quoted ? raw : raw.toLowerCase();
  if (fold) return name.toLowerCase();
  return name === name.toLowerCase() ? name : null;
}
function cteEntryName(entry: Record<string, unknown>): { raw: string; quoted: boolean } | null {
  const nm = entry.name;
  if (typeof nm === "string") return { raw: nm, quoted: false }; // 구버전 파서 호환
  if (nm !== null && typeof nm === "object") {
    const o = nm as { value?: unknown; type?: unknown };
    if (typeof o.value === "string") return { raw: o.value, quoted: o.type === "double_quote_string" };
  }
  return null;
}
function collectTableRefs(stmt: unknown, fold: boolean): TableRefScan {
  const acc: TableRefScan = { real: new Set(), cteRefs: new Set(), cteNames: new Set() };
  walkQueryScope(stmt, new Set<string>(), fold, acc);
  return acc;
}
function walkQueryScope(node: unknown, visible: ReadonlySet<string>, fold: boolean, acc: TableRefScan): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const el of node) walkQueryScope(el, visible, fold, acc);
    return;
  }
  const n = node as Record<string, unknown>;
  const withList = Array.isArray(n.with) ? (n.with as Record<string, unknown>[]) : null;
  if (withList === null && n.type !== "select") { // 쿼리 스코프가 아니면 가시범위를 그대로 물려 내려간다
    for (const v of Object.values(n)) if (v !== null && typeof v === "object") walkQueryScope(v, visible, fold, acc);
    return;
  }
  let vis: ReadonlySet<string> = visible;
  if (withList) {
    const recursive = withList.some((e) => e.recursive === true); // WITH RECURSIVE — 자기참조가 CTE 다
    const scoped = new Set(visible);
    for (const entry of withList) {
      const nm = cteEntryName(entry);
      if (nm) acc.cteNames.add(nm.raw.toLowerCase());
      const key = nm ? identKey(nm.raw, nm.quoted, fold) : null;
      // 본문에서 보이는 건 '앞서 정의된 것' + (RECURSIVE 면) 자기 자신 — 뒤에 정의된 이름은 실제 테이블이다.
      walkQueryScope(entry.stmt, recursive && key !== null ? new Set(scoped).add(key) : scoped, fold, acc);
      if (key !== null) scoped.add(key);
    }
    vis = scoped;
  }
  if (Array.isArray(n.from)) {
    for (const item of n.from) {
      if (item === null || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      const t = f.table;
      if (typeof t === "string") {
        const db = f.db;
        const qualified = typeof db === "string" && db.length > 0 && db.toLowerCase() !== "null"; // 스키마 수식은 CTE 일 수 없다
        const key = qualified ? null : identKey(t, false, fold);
        if (key !== null && vis.has(key)) acc.cteRefs.add(t.toLowerCase());
        else acc.real.add(t.toLowerCase());
      }
      for (const [k, v] of Object.entries(f)) { // 조인 조건·파생테이블(서브쿼리)은 같은 가시범위로 계속 훑는다
        if (k === "table" || k === "db" || k === "as") continue;
        if (v !== null && typeof v === "object") walkQueryScope(v, vis, fold, acc);
      }
    }
  }
  for (const [k, v] of Object.entries(n)) { // columns·where·orderby·_next(UNION) 등 — WITH 별칭이 보이는 범위
    if (k === "with" || (k === "from" && Array.isArray(v))) continue; // 위에서 처리(배열이 아닌 from 은 여기서 훑는다)
    if (v !== null && typeof v === "object") walkQueryScope(v, vis, fold, acc);
  }
}

/**
 * 자유 SQL 의 1차 방어선. 진짜 권한 경계는 DB의 읽기전용 role + RLS 다(이건 보조).
 * 단일 SELECT 만 통과시키고, 금지 함수(특히 set_config/current_setting)는 CTE·서브쿼리까지 차단한다.
 * policy 를 주면 소스별 테이블 allow/deny + 마스킹-파생 차단(게이트1)까지 집행하고, 게이트2용 QueryPlan 을 돌려준다.
 * opts.dialect="mysql" 이면 mysql 파서·차단목록 + 크로스-스키마 거부(opts.schema 기준)로 동작(#715).
 */
export function assertSafeSelect(sql: string, policy?: SourcePolicy, opts?: SafeSelectOpts): QueryPlan {
  const dialect: SqlDialect = opts?.dialect ?? "postgresql";
  const blocked = dialect === "mysql" ? MYSQL_BLOCKED : BLOCKED;
  for (const re of blocked) {
    if (re.test(sql)) throw new Error(`Blocked SQL pattern: ${re.source}`);
  }

  // 파서에 넘길 사본 — pgvector 연산자 중화(pg) + 인용식별자 대소문자 관측(#1181). 실행되는 SQL 은 언제나 원본.
  const scan = scanSqlText(sql, dialect === "postgresql");
  const parseSql = scan.parseSql;

  let ast: unknown;
  try {
    ast = parser.astify(parseSql, { database: dialect });
  } catch (e) {
    throw new Error(`Unparseable SQL: ${(e as Error).message}`);
  }

  const stmts = Array.isArray(ast) ? ast : [ast];
  if (stmts.length !== 1) throw new Error("Only a single statement is allowed");
  if ((stmts[0] as { type?: string }).type !== "select") {
    throw new Error("Only SELECT statements are allowed");
  }
  // CTE/서브쿼리 포함 전 함수 호출 검사 — pg: set_config/current_setting 등 / mysql: sleep·load_file 등(주석 우회 대비)
  assertNoForbiddenFunctions(stmts[0], dialect === "mysql" ? MYSQL_FORBIDDEN_FUNCTIONS : FORBIDDEN_FUNCTIONS);

  // #1181 ① — WITH 별칭은 테이블이 아니다. 스코프 인지로 훑어 'CTE 로만 참조된 이름'을 가려낸다.
  const refs = collectTableRefs(stmts[0], !scan.mixedCaseQuoted);
  for (const nm of refs.cteNames) {
    // 시스템 차단 테이블명을 CTE 이름으로 쓰는 건 실익이 없고 감사·shadow 판정만 흐린다 → 백스톱으로 거부.
    if (DENIED_TABLES.has(nm)) throw new Error(`Blocked: CTE 이름 '${nm}' — 시스템 차단 테이블명은 CTE 이름으로 쓸 수 없습니다`);
  }
  const cteOnly = new Set([...refs.cteRefs].filter((n) => !refs.real.has(n)));

  // 참조 테이블 deny — node-sql-parser 의 tableList: "{type}::{db}::{table}" (조인/서브쿼리 포함 전수).
  let tables: string[];
  try {
    tables = parser.tableList(parseSql, { database: dialect });
  } catch (e) {
    throw new Error(`Unparseable SQL: ${(e as Error).message}`);
  }
  const srcSchema = (opts?.schema ?? "").toLowerCase();
  const tableNames: string[] = [];
  try {
    for (const t of tables) {
      const segs = t.split("::");
      const name = segs[segs.length - 1]?.toLowerCase();
      if (!name) continue;
      const dbPart = segs.length >= 3 ? segs[1] : null;
      // #1181 ① WITH 별칭 — 실제 테이블이 아니므로 게이트도 감사(tables)도 대상이 아니다(스키마 수식이면 CTE 일 수 없다).
      if ((!dbPart || dbPart === "null") && cteOnly.has(name)) continue;
      tableNames.push(name); // 차단으로 throw 하더라도 감사(P5)가 '어떤 테이블을 건드리려 했나'를 알도록 먼저 수집
      // mysql 크로스-스키마 거부(#715) — db-수식 참조는 소스 스키마와 일치할 때만(미수식 'null' 은 통과 —
      //  커넥션이 소스 스키마로 고정돼 있어 미수식은 그 스키마로 해석된다). information_schema/mysql/sys 포함 전부 차단.
      if (dialect === "mysql" && dbPart && dbPart !== "null" && dbPart.toLowerCase() !== srcSchema) {
        // 카탈로그 스키마를 SELECT 로 더듬는 건 스키마 탐색 의도다 — 막기만 하면 이름을 추측하게 되므로
        //  올바른 경로(db_schema)를 함께 알려준다(#1259: information_schema 차단이 실패 177건 중 33건).
        const catalogHint = CATALOG_SCHEMAS.has(dbPart.toLowerCase())
          ? " — 테이블·컬럼 목록은 db_schema 툴로 조회하세요(db_schema({source, match:'<이름 일부>'})=테이블 목록, table 지정=컬럼)"
          : "";
        throw new Error(`Blocked: 다른 스키마(db) 참조 '${dbPart}.${name}' — 이 소스는 '${opts?.schema ?? ""}' 스키마만 조회할 수 있습니다${catalogHint}`);
      }
      if (DENIED_TABLES.has(name)) throw new Error(`Blocked table: ${name} — 민감 테이블은 db_query 로 조회할 수 없습니다`);
    }

    if (!policy) return { ...EMPTY_PLAN, tables: tableNames };
    return { ...assertSourcePolicy(stmts[0] as Record<string, unknown>, tableNames, policy), tables: tableNames };
  } catch (e) {
    // P5(#746) — 차단 에러에 참조 테이블을 실어 tools/db.ts 가 감사 행(tables)을 채우게 한다(구조화 필터 db_audit_list table= 대응).
    if (e instanceof Error) (e as Error & { tables?: string[] }).tables = tableNames;
    throw e;
  }
}

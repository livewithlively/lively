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

function assertNoForbiddenFunctions(ast: unknown): void {
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
          if (typeof v === "string" && FORBIDDEN_FUNCTIONS.has(v.toLowerCase())) {
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
const DENIED_TABLES = new Set([
  "auth_token", "org_content_audit", "org_hook", "org_tool", "org_mcp_server", "org_db_source",
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
    if (mode === "deny") throw new Error(`Blocked table: ${t} — 이 소스에서 조회가 허용되지 않은 테이블입니다(웹에서 허용 설정 필요)`);
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

/**
 * 자유 SQL 의 1차 방어선. 진짜 권한 경계는 DB의 읽기전용 role + RLS 다(이건 보조).
 * 단일 SELECT 만 통과시키고, 금지 함수(특히 set_config/current_setting)는 CTE·서브쿼리까지 차단한다.
 * policy 를 주면 소스별 테이블 allow/deny + 마스킹-파생 차단(게이트1)까지 집행하고, 게이트2용 QueryPlan 을 돌려준다.
 */
export function assertSafeSelect(sql: string, policy?: SourcePolicy): QueryPlan {
  for (const re of BLOCKED) {
    if (re.test(sql)) throw new Error(`Blocked SQL pattern: ${re.source}`);
  }

  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: "postgresql" });
  } catch (e) {
    throw new Error(`Unparseable SQL: ${(e as Error).message}`);
  }

  const stmts = Array.isArray(ast) ? ast : [ast];
  if (stmts.length !== 1) throw new Error("Only a single statement is allowed");
  if ((stmts[0] as { type?: string }).type !== "select") {
    throw new Error("Only SELECT statements are allowed");
  }
  assertNoForbiddenFunctions(stmts[0]); // CTE/서브쿼리 포함 전 함수 호출 검사(set_config/current_setting 등)

  // 참조 테이블 deny — node-sql-parser 의 tableList: "{type}::{db}::{table}" (조인/서브쿼리 포함 전수).
  let tables: string[];
  try {
    tables = parser.tableList(sql, { database: "postgresql" });
  } catch (e) {
    throw new Error(`Unparseable SQL: ${(e as Error).message}`);
  }
  const tableNames: string[] = [];
  for (const t of tables) {
    const name = t.split("::").pop()?.toLowerCase();
    if (!name) continue;
    if (DENIED_TABLES.has(name)) throw new Error(`Blocked table: ${name} — 민감 테이블은 db_query 로 조회할 수 없습니다`);
    tableNames.push(name);
  }

  if (!policy) return EMPTY_PLAN;
  return assertSourcePolicy(stmts[0] as Record<string, unknown>, tableNames, policy);
}

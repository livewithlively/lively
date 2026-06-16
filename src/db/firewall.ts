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

/**
 * 자유 SQL 의 1차 방어선. 진짜 권한 경계는 DB의 읽기전용 role + RLS 다(이건 보조).
 * 단일 SELECT 만 통과시키고, 금지 함수(특히 set_config/current_setting)는 CTE·서브쿼리까지 차단한다.
 */
export function assertSafeSelect(sql: string): void {
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
  assertNoForbiddenFunctions(stmts[0]); // CTE/서브쿼리 포함 전 함수 호출 검사
}

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

// 방어선 3(B18): db_query 가 민감 테이블을 읽지 못하게 한다.
//  db_query 는 게이트웨이 읽기풀(DATABASE_URL)을 쓰고 org-content 는 items 풀(ITEMS_DATABASE_URL)에 있어
//  배포에 따라 물리 분리될 수 있으나, 같은 DB/리플리카에 섞이는 배포에선 토큰 해시·감사·훅 소스코드·툴
//  정의가 자유 SELECT 로 새어나갈 수 있다 → 코드로 deny(배포 토폴로지와 무관한 방어). 운영 권장 보강:
//  db_query 리플리카에서 이 테이블들을 물리 제외 + 기동 시 자가검증 + RLS.
const DENIED_TABLES = new Set([
  "auth_token", "org_content_audit", "org_hook", "org_tool", "org_mcp_server",
]);

/**
 * 자유 SQL 의 1차 방어선. 진짜 권한 경계는 DB의 읽기전용 role + RLS 다(이건 보조).
 * 단일 SELECT 만 통과시킨다.
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

  // 참조 테이블 deny — node-sql-parser 의 tableList: "{type}::{db}::{table}" (조인/서브쿼리 포함 전수).
  let tables: string[];
  try {
    tables = parser.tableList(sql, { database: "postgresql" });
  } catch (e) {
    throw new Error(`Unparseable SQL: ${(e as Error).message}`);
  }
  for (const t of tables) {
    const name = t.split("::").pop()?.toLowerCase();
    if (name && DENIED_TABLES.has(name)) {
      throw new Error(`Blocked table: ${name} — 민감 테이블은 db_query 로 조회할 수 없습니다`);
    }
  }
}

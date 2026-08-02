// #1291 가시성 술어 — 순수함수 단위 체크(DB 불요, npm test 체인 포함).
//  SQL 을 실제로 돌려보는 검증은 visibility.pg-test.mjs 가 한다(실 Postgres 필요 — CI PG 잡/운영 박스).
//  여기서는 DB 없이 잡을 수 있는 것만 본다: 술어 조립의 세 갈래와 열람 신원 정규화.
//  이 둘이 조용히 뒤집히면 결과가 **전원 공개**(잠금 무력화)거나 **전원 차단**(장애)이라, 값싼 가드를 깔아둔다.
import { listIdPredicate } from "./visibility.js";
import { viewerOf } from "../capabilities/principal.js";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const bad = (n: string, why?: string) => { fail++; console.error(`FAIL ${n} — ${why ?? ""}`); };
const chk = (n: string, c: boolean, why?: string) => (c ? ok(n) : bad(n, why));

// SQL 조각이 실제로 어떻게 동작할지를 흉내 내는 최소 평가기.
//  문자열 매칭("IS NULL 이 들어있나")으로 단언하면 술어를 재진술할 뿐이라, 조립 실수(예: OR 를 AND 로)를 못 잡는다.
//  대신 **행을 통과시키는지**라는 관찰 가능한 효과로 단언한다.
function passesRow(sql: string, listId: number | null): boolean {
  if (sql.trim() === "TRUE") return true;
  const isNull = /\bIS NULL\b/.test(sql);
  const inMatch = sql.match(/IN\s*\(([^)]*)\)/);
  const allowed = inMatch ? inMatch[1].split(",").map((s) => Number(s.trim())) : [];
  if (inMatch && inMatch[1].trim() === "") throw new Error(`빈 IN 절 — 실제 DB 라면 문법 오류: ${sql}`);
  return listId === null ? isNull : allowed.includes(listId);
}

// ── ① 특권: 한 행도 거르지 않는다 ──
{
  const sql = listIdPredicate("p.list_id", null);
  chk("특권 — 잠긴 리스트 행도 통과", passesRow(sql, 42), sql);
  chk("특권 — 미분류 행도 통과", passesRow(sql, null), sql);
}

// ── ② 가시 집합이 빈 경우(아무 리스트도 못 보는 사람) ──
//  ⚠ 여기서 빈 IN 절을 만들면 SQL 문법 오류로 목록 API 가 통째로 죽는다(전원 차단).
{
  const sql = listIdPredicate("p.list_id", new Set<number>());
  chk("빈 집합 — 미분류는 통과", passesRow(sql, null), sql);
  chk("빈 집합 — 어떤 리스트 행도 불통과", !passesRow(sql, 1) && !passesRow(sql, 999), sql);
  let syntaxSafe = true;
  try { passesRow(sql, 1); } catch { syntaxSafe = false; }
  chk("빈 집합 — 빈 IN 절을 만들지 않는다", syntaxSafe, sql);
}

// ── ③ 일반: 미분류 OR 가시 목록 ──
{
  const sql = listIdPredicate("p.list_id", new Set([3, 1, 2]));
  chk("가시 리스트 행은 통과", passesRow(sql, 1) && passesRow(sql, 2) && passesRow(sql, 3), sql);
  chk("비가시 리스트 행은 불통과", !passesRow(sql, 4), sql);
  chk("미분류는 통과(잠글 상위가 없다)", passesRow(sql, null), sql);
}

// ── ④ 컬럼 자리에 SQL 식(조인 COALESCE 등)을 그대로 쓴다 ──
{
  const sql = listIdPredicate("COALESCE(pr.list_id, p.list_id)", new Set([7]));
  chk("컬럼 식 보존", sql.includes("COALESCE(pr.list_id, p.list_id)"), sql);
}

// ── ⑤ 집합 원소는 숫자 — 따옴표 없이 인라인해도 안전하다는 전제를 고정 ──
{
  const sql = listIdPredicate("p.list_id", new Set([10, 20]));
  chk("숫자만 인라인(문자열 리터럴 없음)", !sql.includes("'"), sql);
}

// ── ⑥~⑩ 열람 신원 ──
//  이 판정이 어댑터 두 곳(MCP·REST)에만 있어야 핸들러가 신원 분기를 중복 구현하지 않는다.
//  ⚠ v2: **admin 도 우회하지 않는다.** admin 신원은 그 사람의 AI 세션이 물려받으므로, 우회를 허용하면
//   admin 이 돌리는 자동화가 잠긴 내용을 읽어 공개 지식으로 되뱉는다. 우회는 긴급열람(사유·감사·통지)으로만.
chk("admin 도 자기 id 로 필터(우회 없음)", viewerOf({ userId: "yoon", scopes: ["items", "admin"] }) === "yoon");
chk("일반 멤버는 자기 id 로 필터", viewerOf({ userId: "yoon", scopes: ["items", "memory"] }) === "yoon");
chk("신원 객체가 없으면 특권(내부 경로)", viewerOf(undefined) === null);
chk("userId 가 비면 특권(빈 문자열로 필터 금지)", viewerOf({ userId: "", scopes: ["items"] }) === null);
chk("scopes 부재에도 크래시 없이 그 멤버로", viewerOf({ userId: "kim" }) === "kim");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

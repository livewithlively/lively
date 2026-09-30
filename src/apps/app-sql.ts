// 앱 테이블 자유 SQL — 문장 검사 · 테이블 이름 바꿔 쓰기 · 결과 상한 감싸기 (#4226). **순수**(DB 무접근).
//
// ── 무엇을 여나 (계획 지식 crm-dogfood-app-builder-plan-4200 §7) ─────────────────────────────
//  워크스페이스가 설치한 앱은 자기 테이블에 SELECT·INSERT·UPDATE·DELETE 를 자유 SQL 로 쓴다. 표·칸 만들기(DDL)는
//  매니페스트로만 — 매니페스트가 구조의 원본이어야 옮기기·갱신·버전 비교가 성립한다.
//  SQL 은 선언한 이름 그대로 쓴다(`SELECT * FROM contacts`). 실행 전에 그 이름을 워크스페이스 스키마의 물리 테이블로
//  바꿔 쓴다(`"app_<ws>"."crm__contacts" AS contacts`) — 별칭을 붙여 `contacts.name` 같은 수식이 그대로 산다.
//
// ── 경계는 여기가 아니라 DB 다 ───────────────────────────────────────────────────────────
//  진짜 경계는 실행기(app-sql-exec)가 내려가는 **앱별 DB 역할**이다 — 그 역할은 이 앱의 테이블에만 권한이 있다.
//  그런데 역할은 SQL 안에서 되돌릴 수 있다: `SELECT set_config('role','none',true)` 한 줄이면 런타임 역할로 돌아간다
//  (PG 17 실측 2026-09-30). 그래서 이 파일의 일은 **역할을 되돌리거나 문장 밖으로 나가는 길**을 막는 것이다:
//   ① 렉싱이 Postgres 와 어긋날 자리를 아예 받지 않는다 — 주석 · 백슬래시 · 달러 인용 · U& 표기 · 세미콜론.
//      (문자열 안에 숨긴 코드가 검사기에겐 문자열, Postgres 에겐 코드가 되는 틈이 이 넷에서 나온다.)
//   ② 한 문장 · 네 종류만(파서) — 실행기는 확장 프로토콜로 보내 DB 도 여러 문장을 거부한다.
//   ③ 역할·설정을 바꾸거나 문자열을 SQL 로 실행하는 함수(set_config · *_to_xml · ts_stat …)와 pg_* 함수를 막는다.
//      이름 뒤에 괄호가 오면 함수 호출로 본다(토큰 단위) — AST 모양에 기대지 않는다.
//   ④ 스키마를 붙인 이름(테이블·함수·타입)을 받지 않는다 — 실행기는 search_path 를 pg_catalog 로 좁혀 둔다.
//   ⑤ 테이블 자리에 오는 이름은 토큰 검사가 직접 판정한다(파서가 못 보는 괄호 조인 — 아래 「테이블 자리 찾기」).
//  이 파일이 뭔가를 놓쳐도 데이터는 앱 역할이 지킨다(다른 앱·본체 테이블은 권한 거부). 그래도 ③ 이 뚫리면 역할 자체가 풀리고,
//  ④·⑤ 가 뚫리면 카탈로그(다른 워크스페이스의 스키마·테이블 이름, 정책 식)가 보인다 — 셋 다 놓치면 안 된다.
//  ⚠ «조건 없는 UPDATE·DELETE 거부» 는 실수 방지다 — `WHERE id > 0` 처럼 모든 행을 겨냥하는 조건까지 막지는 않는다.
//   그 뒤는 일일 떠 두기(app-snapshot)가 받친다.
import pkg from "node-sql-parser";
import { HttpError } from "../http-error.js";
import { parserSafeCopy } from "../db/firewall.js";
import { qualifiedAppTable } from "./store-ddl.js";

const { Parser } = pkg;
const parser = new Parser();

export const APP_SQL_MAX_LEN = 100_000;
export const APP_SQL_MAX_PARAMS = 100;

export type AppSqlKind = "select" | "insert" | "update" | "delete";
export interface AppSqlPlan {
  kind: AppSqlKind;
  /** INSERT·UPDATE·DELETE 인가. */
  writes: boolean;
  /** 결과 행이 나오는가 — SELECT, 또는 RETURNING 이 붙은 쓰기. */
  returning: boolean;
  /** SQL 이 건드리는 이 앱의 테이블(선언 이름, 정렬). */
  tables: string[];
  /** 쓰기 대상 테이블(INSERT INTO · UPDATE · DELETE FROM) — 화면 알림에 싣는다. */
  targets: string[];
  /** 실행할 SQL — 선언 이름이 물리 이름으로 바뀐 것. 사용자 원문과 파라미터 번호($n)가 같다. */
  sql: string;
  /** SQL 이 쓰는 가장 큰 파라미터 번호($n) — params 개수와 같아야 한다. */
  paramCount: number;
}

const bad = (msg: string): never => { throw new HttpError(400, `SQL 을 받을 수 없습니다 — ${msg}`); };

// ── ① 렉싱 ─────────────────────────────────────────────────────────────────────────────
type TokType = "ident" | "qident" | "str" | "num" | "param" | "op" | "punct";
interface Tok { type: TokType; text: string; start: number; end: number }

const OP_CHARS = "+-*/<>=~!@#%^&|?";
const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80;
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

/** Postgres 렉싱의 **좁은 부분집합**만 받는 토크나이저. 부분집합 밖이면 거부한다(머리말 ①). */
function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "\\") bad("백슬래시(\\)는 쓸 수 없습니다. 백슬래시가 든 값은 params 로 넘기세요");
    if (c === "'") {
      const s = i++;
      for (;;) {
        if (i >= n) bad("따옴표(')가 닫히지 않았습니다");
        // 문자열 안의 백슬래시도 받지 않는다 — Postgres('…' 안에선 글자)와 파서(이스케이프로 읽는다)가 문자열 끝을 다르게 본다.
        if (sql[i] === "\\") bad("백슬래시(\\)는 쓸 수 없습니다. 백슬래시가 든 값은 params 로 넘기세요");
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      out.push({ type: "str", text: sql.slice(s, i), start: s, end: i });
      continue;
    }
    if (c === "\"") {
      const s = i++;
      for (;;) {
        if (i >= n) bad("큰따옴표(\")가 닫히지 않았습니다");
        if (sql[i] === "\\") bad("이름 안의 백슬래시(\\)는 쓸 수 없습니다");
        if (sql[i] === "\"") { if (sql[i + 1] === "\"") { i += 2; continue; } i++; break; }
        i++;
      }
      if (i - s <= 2) bad("빈 이름(\"\")은 쓸 수 없습니다");
      out.push({ type: "qident", text: sql.slice(s, i), start: s, end: i });
      continue;
    }
    if (c === "$") {
      const m = /^\$[0-9]+/.exec(sql.slice(i));
      if (!m) bad("달러 인용($…$)은 쓸 수 없습니다. 값은 '…' 또는 params 로 넘기세요");
      out.push({ type: "param", text: m![0], start: i, end: i + m![0].length });
      i += m![0].length;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? "") && !endsOperand(out))) {
      const s = i;
      while (i < n && /[0-9A-Za-z_.]/.test(sql[i])) {
        // 지수 부호(1e-3)만 숫자 안에 둔다 — 그 밖의 +/- 는 연산자다.
        if ((sql[i] === "e" || sql[i] === "E") && (sql[i + 1] === "+" || sql[i + 1] === "-")) { i += 2; continue; }
        i++;
      }
      out.push({ type: "num", text: sql.slice(s, i), start: s, end: i });
      continue;
    }
    if (isIdentStart(c)) {
      const s = i;
      while (i < n && isIdentPart(sql[i])) i++;
      const word = sql.slice(s, i);
      // 접두 문자열(E'…' · N'…' · B'…' · X'…'): 백슬래시를 이미 막았으므로 안의 뜻은 '…' 와 같다.
      if (sql[i] === "'" && /^[eEnNbBxX]$/.test(word)) continue; // 다음 바퀴가 문자열로 읽는다(접두는 버린다 — 위치만 쓰므로 무해)
      if (/^[uU]$/.test(word) && sql[i] === "&") bad("U& 표기는 쓸 수 없습니다");
      out.push({ type: "ident", text: word, start: s, end: i });
      continue;
    }
    if (OP_CHARS.includes(c)) {
      const s = i;
      while (i < n && OP_CHARS.includes(sql[i])) i++;
      const run = sql.slice(s, i);
      if (run.includes("--") || run.includes("/*")) bad("주석(-- 또는 /* */)은 쓸 수 없습니다");
      out.push({ type: "op", text: run, start: s, end: i });
      continue;
    }
    if (c === ":" && sql[i + 1] === ":") { out.push({ type: "punct", text: "::", start: i, end: i + 2 }); i += 2; continue; }
    if ("(),.[]:".includes(c)) { out.push({ type: "punct", text: c, start: i, end: i + 1 }); i++; continue; }
    if (c === ";") bad("세미콜론(;)으로 여러 문장을 잇지 마세요 — 한 번에 한 문장입니다");
    bad(`쓸 수 없는 문자입니다: ${JSON.stringify(c)}`);
  }
  return out;
}

/** 바로 앞 토큰이 피연산자로 끝나나 — `t.5` 가 아니라 `t .col` 을 가르는 데 쓴다. */
function endsOperand(out: Tok[]): boolean {
  const p = out[out.length - 1];
  return !!p && (p.type === "ident" || p.type === "qident" || (p.type === "punct" && (p.text === ")" || p.text === "]")));
}

const lower = (t: Tok | undefined): string => (t ? t.text.toLowerCase() : "");
const isPunct = (t: Tok | undefined, p: string): boolean => !!t && t.type === "punct" && t.text === p;
const isKw = (t: Tok | undefined, k: string): boolean => !!t && t.type === "ident" && t.text.toLowerCase() === k;
/** 이름 토큰 → Postgres 가 보는 이름(인용 안 한 건 소문자로 접힌다). */
const identName = (t: Tok): string => (t.type === "qident" ? t.text.slice(1, -1).replace(/""/g, "\"") : t.text.toLowerCase());

// ── ③ 함수 ─────────────────────────────────────────────────────────────────────────────
//  역할·설정 변경(set_config — `role` 을 바꾸면 SET ROLE 과 같다) · 설정 읽기(current_setting — 행 격리 값) ·
//  문자열을 SQL 로 실행(query_to_xml 류 · ts_stat · ts_rewrite) · 카탈로그 더듬기(pg_* · has_*_privilege · to_reg* ·
//  *_description) · 시퀀스 조작 · 외부 접속(dblink) · 대형 객체(lo_*) · 연산자 수식(OPERATOR(…)).
const FORBIDDEN_FN = new Set([
  "set_config", "current_setting", "ts_stat", "ts_rewrite",
  //  한 문장에 1GB 가까이 할당하는 함수 — work_mem·문장 시간으로 안 막힌다(격리 리뷰 실측: repeat 9억 → 1.8GB 요청).
  //  전부는 아니다(남은 위험은 문장 5초 · 동시 2 · 풀 4 로 묶는다).
  "repeat", "lpad", "rpad", "array_fill",
  "nextval", "setval", "currval", "lastval",
  "obj_description", "col_description", "shobj_description",
  "operator",
]);
const FORBIDDEN_FN_PREFIX = ["pg_", "lo_", "dblink", "has_", "to_reg", "query_to_"];
export function forbiddenFunction(name: string): boolean {
  const f = name.toLowerCase();
  return FORBIDDEN_FN.has(f) || FORBIDDEN_FN_PREFIX.some((p) => f.startsWith(p)) || f.includes("_to_xml");
}

const REG_TYPES = /^reg(class|collation|config|dictionary|namespace|oper|operator|proc|procedure|role|type)$/;

function checkTokens(toks: Tok[]): void {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = toks[i - 1], next = toks[i + 1];
    if (t.type === "ident" || t.type === "qident") {
      const name = identName(t).toLowerCase();
      if (name.startsWith("__lively")) bad(`'${name}' 는 라이블리가 쓰는 이름입니다`);
      // 괄호가 따라오지 않아도 막는다(방어 겹) — 이 두 이름은 앱 SQL 에 나올 까닭이 없다.
      if (name === "set_config" || name === "current_setting") bad(`'${name}' 는 쓸 수 없습니다`);
      if (isPunct(next, "(")) {
        if (forbiddenFunction(name)) bad(`함수 '${name}' 은(는) 쓸 수 없습니다`);
        if (isPunct(prev, ".")) bad("스키마를 붙인 함수 호출은 쓸 수 없습니다 — 함수 이름만 쓰세요");
      }
    }
    //  reg* 형은 이름을 카탈로그에서 찾는다(다른 워크스페이스 테이블 이름 확인) — `::regclass` · `CAST(… AS regclass)` ·
    //   `regclass('…')` 어느 모양이든 그 낱말이 나오면 거부한다.
    if ((t.type === "ident" || t.type === "qident") && REG_TYPES.test(identName(t).toLowerCase())) bad("reg* 형(regclass 등)은 쓸 수 없습니다");
    if (isPunct(t, "::")) {
      if (next && (next.type === "ident" || next.type === "qident") && identName(next).toLowerCase().startsWith("reg")) {
        bad("reg* 형 변환(::regclass 등)은 쓸 수 없습니다");
      }
      if (isPunct(toks[i + 2], ".")) bad("스키마를 붙인 형 변환은 쓸 수 없습니다");
    }
  }
}

// ── ② 파서 ─────────────────────────────────────────────────────────────────────────────
type Node = Record<string, unknown>;

/** AST 안의 모든 노드를 훑는다(순서 무관). */
function* walk(root: unknown): Generator<Node> {
  const stack: unknown[] = [root];
  while (stack.length) {
    const x = stack.pop();
    if (x === null || typeof x !== "object") continue;
    if (Array.isArray(x)) { for (const el of x) stack.push(el); continue; }
    const node = x as Node;
    yield node;
    for (const v of Object.values(node)) if (v !== null && typeof v === "object") stack.push(v);
  }
}

function hasColumnRef(expr: unknown): boolean {
  for (const n of walk(expr)) if (n.type === "column_ref") return true;
  return false;
}

function cteNames(ast: unknown): Set<string> {
  const out = new Set<string>();
  for (const n of walk(ast)) {
    if (!Array.isArray(n.with)) continue;
    for (const e of n.with as Node[]) {
      const nm = e?.name as unknown;
      const v = typeof nm === "string" ? nm : (nm && typeof nm === "object" ? (nm as { value?: unknown }).value : null);
      if (typeof v === "string") out.add(v.toLowerCase());
    }
  }
  return out;
}

function astTableNames(list: unknown): string[] {
  return Array.isArray(list) ? (list as Node[]).map((t) => String(t?.table ?? "").toLowerCase()).filter(Boolean) : [];
}

// ── 테이블 자리 찾기 ────────────────────────────────────────────────────────────────────
//  괄호 깊이마다 «지금 어느 절인가» 를 들고 다닌다. 테이블이 오는 자리는 FROM·JOIN·INTO·UPDATE 바로 뒤, 그리고 FROM 절 안의
//  쉼표 뒤다(ONLY·LATERAL 은 건너서 본다). 함수 괄호 안의 FROM(extract(year FROM x)) 과 IS DISTINCT FROM 은 테이블 자리가 아니다.
//  ★ 이 토큰 검사가 **정본**이다(격리 리뷰 2026-09-30): 파서는 `FROM (a JOIN b ON …)` 처럼 괄호로 묶은 조인 안의 테이블을
//   목록에 올리지 않는다 — 파서 목록만 믿으면 그 안에 카탈로그(pg_roles·pg_class)를 넣어 검사를 통째로 빠져나간다(실측).
//   그래서 테이블 자리에 오는 것은 전부 여기서 판정한다: 선언 테이블(바꿔 쓴다) · WITH 이름 · 함수(이름 뒤 괄호) · 서브쿼리
//   괄호만 받고, 괄호로 묶은 조인 · 스키마 붙인 이름 · 선언 밖 이름은 거부한다. 파서 목록과는 한 번 더 맞춰 본다.
const CLAUSE_OTHER = new Set(["select", "where", "group", "having", "order", "limit", "offset", "fetch", "window",
  "returning", "set", "values", "union", "intersect", "except", "conflict", "do"]);
//  테이블 이름 바로 뒤에 와도 별칭이 아닌 낱말.
const NOT_ALIAS = new Set(["where", "join", "left", "right", "full", "inner", "cross", "natural", "on", "group", "order",
  "limit", "offset", "set", "values", "returning", "union", "intersect", "except", "window", "having", "fetch", "for",
  "using", "default", "select", "with", "tablesample", "overriding"]);
//  테이블 자리 앞에 붙는 수식어 — 건너서 본다.
const TABLE_MODIFIERS = new Set(["only", "lateral"]);

interface Frame { query: boolean; clause: string | null }

/** i 번째 토큰이 테이블 자리에 있나 — 어느 쪽(from: FROM·JOIN·쉼표, target: INSERT INTO·UPDATE)인지. 아니면 null. */
function tablePosition(toks: Tok[], i: number, frame: Frame): "from" | "target" | null {
  let j = i - 1;
  while (j >= 0 && toks[j].type === "ident" && TABLE_MODIFIERS.has(toks[j].text.toLowerCase())) j--;
  const lead = toks[j];
  const lk = lead && lead.type === "ident" ? lead.text.toLowerCase() : "";
  if ((lk === "from" || lk === "join") && frame.clause === "from") return "from";
  if (isPunct(lead, ",") && frame.clause === "from") return "from";
  if (lk === "into" && frame.clause === "into") return "target";
  if (lk === "update" && frame.clause === "update") return "target";
  return null;
}

function rewriteTables(sql: string, toks: Tok[], declared: ReadonlySet<string>, ctes: ReadonlySet<string>, qualify: (t: string) => string): { sql: string; found: Set<string> } {
  const stack: Frame[] = [{ query: true, clause: null }];
  const reps: Array<{ start: number; end: number; text: string }> = [];
  const found = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = toks[i - 1], next = toks[i + 1];
    const frame = stack[stack.length - 1];
    if (isPunct(t, "(")) {
      const sub = ["select", "with", "values"].includes(lower(next));
      if (!sub && tablePosition(toks, i, frame) === "from") {
        bad("FROM 에서 괄호로 묶은 조인은 받지 않습니다 — 괄호를 풀어 `FROM a JOIN b ON …` 로 쓰세요");
      }
      stack.push({ query: sub, clause: null });
      continue;
    }
    if (isPunct(t, ")")) { if (stack.length > 1) stack.pop(); continue; }
    if (t.type === "ident") {
      const kw = t.text.toLowerCase();
      if (kw === "from") { frame.clause = frame.query && !isKw(prev, "distinct") ? "from" : "expr"; continue; }
      if (kw === "join") { if (frame.query) frame.clause = "from"; continue; }
      if (kw === "into") { frame.clause = "into"; continue; }
      if (kw === "update") { frame.clause = "update"; continue; }
      if (kw === "on" && frame.clause === "from") continue;            // 조인 조건 — 아직 FROM 절이다
      if (CLAUSE_OTHER.has(kw) || kw === "on") { frame.clause = kw; continue; }
      if (TABLE_MODIFIERS.has(kw) && tablePosition(toks, i + 1, frame)) continue;   // ONLY·LATERAL — 다음 토큰이 자리다
    }
    if (t.type !== "ident" && t.type !== "qident") continue;
    const at = tablePosition(toks, i, frame);
    if (!at) continue;
    if (isPunct(prev, ".")) continue;                                  // 수식의 뒤쪽(앞쪽에서 이미 판정했다)
    if (isPunct(next, ".")) bad(`스키마를 붙인 이름(${sql.slice(t.start, next.end)}…)은 쓸 수 없습니다 — 이 앱의 테이블 이름만 쓰세요`);
    if (at === "from" && isPunct(next, "(")) continue;                  // FROM 자리의 함수(generate_series(…)) — 함수 검사는 checkTokens
    const name = identName(t);
    if (!declared.has(name)) {
      if (ctes.has(name.toLowerCase())) continue;                      // WITH 이름
      throw new HttpError(403, `이 앱이 선언하지 않은 테이블입니다: ${name} — 이 앱의 테이블: ${[...declared].sort().join(", ") || "(없음)"}`);
    }
    const aliased = isKw(next, "as") || (!!next && (next.type === "qident" || (next.type === "ident" && !NOT_ALIAS.has(next.text.toLowerCase()))));
    reps.push({ start: t.start, end: t.end, text: qualify(name) + (aliased ? "" : ` AS ${sql.slice(t.start, t.end)}`) });
    found.add(name);
  }
  let out = "";
  let pos = 0;
  for (const r of reps) { out += sql.slice(pos, r.start) + r.text; pos = r.end; }
  return { sql: out + sql.slice(pos), found };
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
 */
export function planAppSql(input: string, opts: PlanAppSqlOpts): AppSqlPlan {
  let sql = String(input ?? "");
  if (sql.length > APP_SQL_MAX_LEN) bad(`너무 깁니다(${sql.length}자, 최대 ${APP_SQL_MAX_LEN}자)`);
  if (sql.includes("\0")) bad("NUL 문자가 있습니다");
  sql = sql.trim().replace(/;\s*$/, "").trim();                        // 끝의 세미콜론 하나는 흔한 습관이라 받아 준다
  if (!sql) bad("비어 있습니다");

  const toks = tokenize(sql);
  checkTokens(toks);

  let ast: unknown;
  const copy = parserSafeCopy(sql);
  try { ast = parser.astify(copy, { database: "postgresql" }); }
  catch (e) {
    bad(`해석하지 못했습니다(${String((e as Error)?.message ?? e).slice(0, 160)}). 이 검사기가 모르는 문법일 수 있습니다 — `
      + "DELETE … USING · WITH 뒤 DELETE · INSERT … AS 별칭 · FOR UPDATE 는 아직 받지 않습니다");
  }
  const stmts = Array.isArray(ast) ? ast : [ast];
  if (stmts.length !== 1) bad("한 번에 한 문장만 받습니다");
  const st = stmts[0] as Node;
  const kind = String(st.type) as AppSqlKind;
  if (!["select", "insert", "update", "delete"].includes(kind)) {
    bad(`${String(st.type).toUpperCase()} 는 받지 않습니다 — SELECT · INSERT · UPDATE · DELETE 만. 테이블·칸은 매니페스트로 바꿉니다`);
  }
  for (const n of walk(st)) {
    const into = n.into as { expr?: unknown } | undefined;
    if (n.type === "select" && into && into.expr) bad("SELECT … INTO 는 받지 않습니다(새 테이블을 만든다)");
  }
  if (kind === "update" || kind === "delete") {
    const verb = kind.toUpperCase();
    if (!st.where) bad(`조건(WHERE) 없는 ${verb} 는 받지 않습니다 — 모든 행이 바뀝니다. 대상 행을 고르는 조건을 적으세요`);
    if (!hasColumnRef(st.where)) bad(`${verb} 의 조건에 칸이 없습니다(늘 참인 조건) — 대상 행을 고르는 조건을 적으세요`);
  }

  // 테이블 — 파서가 본 이름이 전부 이 앱의 선언 안이어야 한다. CTE 이름은 테이블이 아니다.
  const declared = new Set(opts.tables.map((t) => t.toLowerCase()));
  let list: string[];
  try { list = parser.tableList(copy, { database: "postgresql" }); }
  catch (e) { return bad(`해석하지 못했습니다(${String((e as Error)?.message ?? e).slice(0, 160)})`); }
  const ctes = cteNames(st);
  for (const c of ctes) {
    if (declared.has(c)) bad(`WITH 이름 '${c}' 가 이 앱의 테이블 이름과 같습니다 — 다른 이름을 쓰세요`);
    if (c.startsWith("pg_")) bad(`WITH 이름 '${c}' 는 쓸 수 없습니다`);
  }
  const real = new Set<string>();
  for (const entry of list) {
    const segs = entry.split("::");
    const db = segs.length >= 3 ? segs[1] : null;
    const name = String(segs[segs.length - 1] ?? "").toLowerCase();
    if (!name) continue;
    if (db && db !== "null") bad(`스키마를 붙인 이름(${db}.${name})은 쓸 수 없습니다 — 이 앱의 테이블 이름만 쓰세요`);
    if (ctes.has(name)) continue;
    if (!declared.has(name)) {
      throw new HttpError(403, `이 앱이 선언하지 않은 테이블입니다: ${name} — 이 앱의 테이블: ${[...declared].sort().join(", ") || "(없음)"}`);
    }
    real.add(name);
  }

  const { sql: rewritten, found } = rewriteTables(sql, toks, declared, ctes, (t) => qualifiedAppTable(opts.schema, opts.appId, t));
  const missing = [...real].filter((t) => !found.has(t));
  const extra = [...found].filter((t) => !real.has(t));
  if (missing.length || extra.length) {
    bad(`테이블 자리를 확실히 읽지 못했습니다(${[...missing, ...extra].join(", ")}) — 서브쿼리·쉼표 조인을 JOIN 으로 바꾸는 등 더 단순하게 써 주세요`);
  }

  const targets = kind === "insert" || kind === "update" ? astTableNames(st.table)
    : kind === "delete" ? astTableNames(st.from).slice(0, 1) : [];
  const paramCount = toks.filter((t) => t.type === "param").reduce((m, t) => Math.max(m, Number(t.text.slice(1))), 0);
  if (paramCount > APP_SQL_MAX_PARAMS) bad(`파라미터가 너무 많습니다($${paramCount}, 최대 ${APP_SQL_MAX_PARAMS})`);
  return {
    kind,
    paramCount,
    writes: kind !== "select",
    returning: kind === "select" || !!st.returning,
    tables: [...real].sort(),
    targets: [...new Set(targets)],
    sql: rewritten,
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

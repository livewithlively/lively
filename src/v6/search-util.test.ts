// search-util 순수 함수 단위 체크(#631 프로젝트 검색) — DB 불요(테스트 러너 없이 node:assert 자급).
//  실행: npm run build && node dist/v6/search-util.test.js
//  잠그는 것: grep 매처(parseGrep)·WHERE 생성(grepWhere)·스니펫(grepSnippet, L<n>:/폴백/오버플로/context)·regex→token 폴백(grepExec).
//  이 유틸은 knowledge(#172)·project(#631) 검색이 공유하므로 회귀 시 양쪽이 깨진다.
import assert from "node:assert/strict";
import {
  parseGrep, grepWhere, grepSnippet, grepExec, type GrepPlan,
  parsePlainGrep, titleFirst, embedQuery, __resetQueryEmbedCache, QUERY_EMBED_TTL_MS,
} from "./search-util.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── parseGrep — 평문=토큰 AND, 정규식 메타=regex(깨지면 토큰 폴백). ──
t("parseGrep: 단일 평문 토큰", () => {
  assert.deepEqual(parseGrep("hello"), { mode: "tokens", tokens: ["hello"] });
});
t("parseGrep: 다중 토큰(공백 분리, 트림)", () => {
  assert.deepEqual(parseGrep("  벡터  검색 "), { mode: "tokens", tokens: ["벡터", "검색"] });
});
t("parseGrep: 정규식 메타 → regex 모드(대소문자 무시)", () => {
  const p = parseGrep("벡터|vector");
  assert.equal(p.mode, "regex");
  if (p.mode === "regex") { assert.equal(p.pattern, "벡터|vector"); assert.ok(p.re.test("VECTOR")); }
});
t("parseGrep: 깨진 정규식('[') → 토큰 폴백", () => {
  assert.deepEqual(parseGrep("["), { mode: "tokens", tokens: ["["] });
});
t("parseGrep: 빈 문자열 → 토큰 ['']", () => {
  assert.deepEqual(parseGrep(""), { mode: "tokens", tokens: [""] });
});

// ── grepWhere — cols 불가지론(project 는 [p.name,p.description]). 토큰마다 (cols OR) 를 AND. ──
t("grepWhere: 토큰 AND — 각 토큰이 (cols OR), params 는 %tok%", () => {
  const params: unknown[] = [];
  const where = grepWhere(["p.name", "p.description"], { mode: "tokens", tokens: ["a", "b"] }, params);
  assert.ok(where.includes("p.name ILIKE $1"));
  assert.ok(where.includes("p.description ILIKE $1"));
  assert.ok(where.includes("$2"));
  assert.ok(where.includes(" AND "));
  assert.deepEqual(params, ["%a%", "%b%"]);
});
t("grepWhere: 정규식 — ~* 로 단일 파라미터", () => {
  const params: unknown[] = [];
  const where = grepWhere(["p.name", "p.description"], { mode: "regex", pattern: "a|b", re: /a|b/i }, params);
  assert.ok(where.includes("p.name ~* $1"));
  assert.ok(where.includes("p.description ~* $1"));
  assert.deepEqual(params, ["a|b"]);
});
t("grepWhere: LIKE 와일드카드(%,_)는 리터럴 이스케이프", () => {
  const params: unknown[] = [];
  grepWhere(["p.name"], { mode: "tokens", tokens: ["a_b%c"] }, params);
  assert.equal(params[0], "%a\\_b\\%c%");  // _ 와 % 앞에 백슬래시
});

// ── grepSnippet — 매치 줄만 L<n>:, 매치 0줄이면 앞부분 미리보기, 오버플로 footer(getHint), context ±N. ──
t("grepSnippet: 매치 줄을 L<n>: 로", () => {
  const s = grepSnippet("line one\nhas foo here\nline three", { mode: "tokens", tokens: ["foo"] }, 0, "project_get_v6");
  assert.ok(s.includes("L2: has foo here"));
});
t("grepSnippet: 본문 매치 0줄(제목만 매치 등) → 앞부분 미리보기 폴백", () => {
  const s = grepSnippet("some body text here", { mode: "tokens", tokens: ["zzz"] }, 0, "project_get_v6");
  assert.equal(s, "some body text here");
});
t("grepSnippet: 매치 4줄 초과 → 잔여 수 + getHint 힌트", () => {
  const body = ["m", "m", "m", "m", "m", "m"].join("\n");  // 6 매치줄(SNIP_MAX_LINES=4)
  const s = grepSnippet(body, { mode: "tokens", tokens: ["m"] }, 0, "project_get_v6");
  assert.ok(s.includes("(+2 matches) → project_get_v6"));
});
t("grepSnippet: context>0 면 매치 줄 ±context 포함", () => {
  const s = grepSnippet("a\nb\nMATCH\nd\ne", { mode: "tokens", tokens: ["match"] }, 1, "project_get_v6");
  assert.ok(s.includes("L2: b") && s.includes("L3: MATCH") && s.includes("L4: d"));
});

// ── grepExec — POSIX 가 정규식을 거부하면(JS 유효·POSIX 무효) 토큰모드로 1회 재시도. ──
const calls: string[] = [];
const { result, plan } = await grepExec("a|b", async (p: GrepPlan) => {
  calls.push(p.mode);
  if (p.mode === "regex") throw new Error("posix reject");  // 첫 시도(regex) 실패 흉내
  return "ok";
});
t("grepExec: regex 실패 → 토큰모드 1회 재시도(에러 누출 안 함)", () => {
  assert.equal(result, "ok");
  assert.equal(plan.mode, "tokens");
  assert.deepEqual(calls, ["regex", "tokens"]);
});

// ── plain(#4530) — 화면 검색(⌘K)이 사람이 친 글을 글자 그대로 찾는다. 엣지 표(P1~P9) ──────────────────────────────
//  P1 괄호·물음표·$ 는 정규식이 아니라 글자 — plain 계획은 regex 모드가 되지 않는다(종전 parseGrep 은 regex 로 읽어 0건)
//  P2 % · _ · \ 는 LIKE 글자 그대로(ESCAPE)
//  P3 조사를 뗀 꼴도 같이 찾는다(«검색을» → «검색») · 남는 것이 두 글자 미만이면 안 뗀다
//  P4 "구절" 은 통째로 한 낱말 · 조사를 떼지 않는다
//  P5 낱말끼리는 AND · 한 낱말 안의 꼴(그대로/조사 뗀 꼴)끼리는 OR · 컬럼끼리 OR
//  P6 공백뿐이면 원문 덩어리 하나
//  P7 titleFirst — 계획의 매처 그대로 제목만 · NULL 은 빈 글(COALESCE)
//  P8 grepExec plain — 정규식 폴백 없이 한 번
//  P9 grepSnippet plain — 조사 뗀 꼴로도 줄을 찾는다
t("P1 plain: «통합검색(⌘K)» 는 regex 가 아니다(종전 parseGrep 은 regex)", () => {
  assert.equal(parseGrep("통합검색(⌘K)").mode, "regex");          // 종전 동작(에이전트 grep) 은 그대로
  const p = parsePlainGrep("통합검색(⌘K)");
  assert.equal(p.mode, "plain");
  const params: unknown[] = [];
  const sql = grepWhere(["k.title"], p, params);
  assert.ok(!sql.includes("~*"), sql);
  assert.deepEqual(params, ["%통합검색(⌘k)%"]);
});
t("P2 plain: % _ \\ 는 글자 그대로", () => {
  const params: unknown[] = [];
  grepWhere(["s.title"], parsePlainGrep("100% a_b c\\d"), params);
  assert.deepEqual(params, ["%100\\%%", "%a\\_b%", "%c\\\\d%"]);
});
t("P3 plain: 조사를 뗀 꼴도 찾는다 · 두 글자 미만이면 안 뗀다", () => {
  const params: unknown[] = [];
  const sql = grepWhere(["k.title", "k.body_md"], parsePlainGrep("검색을 세션이 이가"), params);
  assert.deepEqual(params, ["%검색을%", "%검색%", "%세션이%", "%세션%", "%이가%"]);
  assert.equal((sql.match(/ AND /g) || []).length, 2, sql);   // 낱말 셋 → AND 둘
});
t("P4 plain: \"구절\" 은 통째로 · 조사 안 뗌", () => {
  const p = parsePlainGrep('"배포 가이드를" 정리');
  assert.equal(p.mode, "plain");
  if (p.mode === "plain") assert.deepEqual(p.terms.map((x) => [x.t, x.stem, x.quoted]), [["배포 가이드를", "배포 가이드를", true], ["정리", "정리", false]]);
});
t("P5 plain: 낱말 AND · 꼴 OR · 컬럼 OR", () => {
  const params: unknown[] = [];
  const sql = grepWhere(["a.x", "a.y"], parsePlainGrep("검색을 회의"), params);
  assert.equal(sql, "((a.x ILIKE $1 ESCAPE '\\' OR a.y ILIKE $1 ESCAPE '\\') OR (a.x ILIKE $2 ESCAPE '\\' OR a.y ILIKE $2 ESCAPE '\\')) AND ((a.x ILIKE $3 ESCAPE '\\' OR a.y ILIKE $3 ESCAPE '\\'))");
});
t("P6 plain: 공백뿐이면 원문 덩어리 하나", () => {
  const p = parsePlainGrep("   ");
  assert.equal(p.mode, "plain");
  if (p.mode === "plain") assert.equal(p.terms.length, 1);
});
t("P7 titleFirst: 계획의 매처로 제목만 · COALESCE · 콤마 꼬리", () => {
  const a: unknown[] = ["x"];
  assert.equal(titleFirst("k.title", parsePlainGrep("배포를"), a), "((COALESCE(k.title, '') ILIKE $2 ESCAPE '\\' OR COALESCE(k.title, '') ILIKE $3 ESCAPE '\\')) DESC, ");
  assert.deepEqual(a, ["x", "%배포를%", "%배포%"]);
  const b: unknown[] = [];
  assert.equal(titleFirst("p.name", parseGrep("벡터|vector"), b), "(COALESCE(p.name, '') ~* $1) DESC, ");
  const c: unknown[] = [];
  assert.equal(titleFirst("p.name", parseGrep("a b"), c), "(COALESCE(p.name, '') ILIKE $1 ESCAPE '\\' AND COALESCE(p.name, '') ILIKE $2 ESCAPE '\\') DESC, ");
});
const plainCalls: string[] = [];
await grepExec("a|b(", async (p: GrepPlan) => { plainCalls.push(p.mode); return 1; }, { plain: true });
t("P8 grepExec plain: 정규식 시도·폴백 없이 plain 한 번", () => {
  assert.deepEqual(plainCalls, ["plain"]);
});
t("P9 grepSnippet plain: 조사 뗀 꼴로도 줄을 찾는다", () => {
  const s = grepSnippet("첫 줄\n여기서 검색 결함을 봤다\n끝", parsePlainGrep("검색을"), 0);
  assert.ok(s.includes("L2: 여기서 검색 결함을 봤다"), s);
});

// ── embedQuery(#4530) — 질의 임베딩 한 번만 · 짧게. 엣지 표(E1~E7) ─────────────────────────────────────────
//  E1 off 면 status off(벡터 없음) — provider 를 부르지 않는다
//  E2 같은 글을 두 번 → provider 한 번(기억)
//  E3 같은 글이 동시에 둘 → provider 한 번(진행 중 공유)
//  E4 설정 열쇠가 다르면 다른 기억
//  E5 실패는 기억하지 않는다 — 다음 번에 다시 부른다 · status failed
//  E6 시간 상한을 넘으면 failed — 늦게 온 값은 기억해 다음 번에 바로 쓴다
//  E7 기억은 TTL 이 지나면 다시 부른다
{
  const mk = (behave: (t: string) => Promise<number[][]>) => {
    const calls: string[] = [];
    const provider = { kind: "http", model: "m", dimensions: 2, isAvailable: async () => true,
      embed: async (texts: string[]) => { calls.push(texts[0]); return behave(texts[0]); } } as never;
    return { calls, src: (key = "K") => async () => ({ provider, key }) };
  };
  __resetQueryEmbedCache();
  const off = await embedQuery("x", { source: async () => null });
  t("E1 off → status off", () => { assert.deepEqual(off, { vec: null, status: "off" }); });

  __resetQueryEmbedCache();
  const a = mk(async () => [[1, 2]]);
  const r1 = await embedQuery("세션", { source: a.src() });
  const r2 = await embedQuery("세션", { source: a.src() });
  t("E2 같은 글 두 번 → 한 번 부른다", () => { assert.equal(a.calls.length, 1); assert.deepEqual(r1, { vec: [1, 2], status: "ok" }); assert.deepEqual(r2, r1); });

  __resetQueryEmbedCache();
  let release: (v: number[][]) => void = () => {};
  const b = mk(() => new Promise((res) => { release = res; }));
  const pa = embedQuery("동시", { source: b.src() }), pb = embedQuery("동시", { source: b.src() });
  await new Promise((r) => setTimeout(r, 5));
  release([[3, 4]]);
  const [ra, rb] = await Promise.all([pa, pb]);
  t("E3 동시에 둘 → 한 번 부르고 나눠 쓴다", () => { assert.equal(b.calls.length, 1); assert.deepEqual(ra.vec, [3, 4]); assert.deepEqual(rb.vec, [3, 4]); });

  __resetQueryEmbedCache();
  const c = mk(async () => [[5, 6]]);
  await embedQuery("열쇠", { source: c.src("K1") });
  await embedQuery("열쇠", { source: c.src("K2") });
  t("E4 설정 열쇠가 다르면 따로 기억", () => { assert.equal(c.calls.length, 2); });

  __resetQueryEmbedCache();
  let fail = true;
  const d = mk(async () => { if (fail) throw new Error("down"); return [[7, 8]]; });
  const f1 = await embedQuery("실패", { source: d.src() });
  fail = false;
  const f2 = await embedQuery("실패", { source: d.src() });
  t("E5 실패는 기억 안 한다 · failed → 다음엔 다시 부른다", () => { assert.equal(f1.status, "failed"); assert.equal(f2.status, "ok"); assert.equal(d.calls.length, 2); });

  __resetQueryEmbedCache();
  let late: (v: number[][]) => void = () => {};
  const e = mk(() => new Promise((res) => { late = res; }));
  const slow = await embedQuery("느림", { source: e.src(), timeoutMs: 20 });
  late([[9, 9]]);
  await new Promise((r) => setTimeout(r, 5));
  const again = await embedQuery("느림", { source: e.src(), timeoutMs: 20 });
  t("E6 상한 넘으면 failed · 늦게 온 값은 기억해 다음 번에 쓴다", () => { assert.equal(slow.status, "failed"); assert.deepEqual(again, { vec: [9, 9], status: "ok" }); assert.equal(e.calls.length, 1); });

  __resetQueryEmbedCache();
  let clock = 1_000_000;
  const g = mk(async () => [[1, 1]]);
  await embedQuery("ttl", { source: g.src(), now: () => clock });
  clock += QUERY_EMBED_TTL_MS + 1;
  await embedQuery("ttl", { source: g.src(), now: () => clock });
  t("E7 TTL 지나면 다시 부른다", () => { assert.equal(g.calls.length, 2); });
}

console.log(`\n${pass} passed`);

// 새 구성원 기본 권한(2026-11-23) — 권한을 고르지 않고 만든 구성원이 items · context · memory · db · code 를 받는가. **실제 Postgres 필요**(run-tests --pg).
//    npm run build && ITEMS_DATABASE_URL=… node src/org/store/default-member-scopes.pg-test.mjs
//  목으로는 못 보는 것을 본다: 저장소 · REST/MCP 핸들러 · 회사 계정 자동 가입 · 토큰 발급이 실제로 행에 적는 값, 그리고 옛 기본값(세 개)으로
//  만들어진 DB 에서 스키마 초기화가 칸 기본값만 맞추고 이미 있는 구성원 행은 건드리지 않는가.
//  ★ 칸 기본값은 이 시험이 잠깐 옛 값으로 되돌렸다가 스키마 초기화로 다시 맞춘다 — 끝에 한 번 더 초기화해 새 값으로 남긴다.
//
//  엣지 표(사양 E1~E11):
//   E1 새 구성원 · 권한 생략(저장소)                         → 다섯 개
//   E2 새 구성원 · 권한 생략(REST/MCP org_member_upsert)      → 다섯 개
//   E3 새 구성원 · 좁게 명시(items 하나)                      → 그대로
//   E4 새 구성원 · 빈 배열 명시(경계)                         → 빈 채로
//   E5 기존 구성원(좁은 권한) · 권한 생략하고 이름만 수정      → 그대로
//   E6 옛 기본값인 DB 에서 스키마 초기화                       → 칸 기본값 다섯 개 · 두 번 돌려도 같다
//   E7 초기화 전부터 있던 구성원(세 개)                        → 행은 그대로
//   E8 칸 기본값에 기대는 직접 INSERT                          → 다섯 개
//   E9 회사 계정 자동 가입                                     → 다섯 개
//   E10 토큰 발급 · 권한 생략 · 구성원 행 없음                 → 다섯 개로 굽는다
//   E11 토큰 발급 · 권한 생략 · 구성원 있음(좁은 권한)         → 구성원 권한으로 굽는다
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const store = await import(`${DIST}/org/store.js`);
const { initOrgCore } = await import(`${DIST}/org/schema/core.js`);
const memberCaps = await import(`${DIST}/capabilities/delivery/members.js`);
const tokenCaps = await import(`${DIST}/capabilities/delivery/tokens-devices.js`);
const oidc = await import(`${DIST}/ee/auth/oidc-login.js`);
const cap = (name) => [...memberCaps.membersCapabilities, ...tokenCaps.tokenMintCapabilities].find((c) => c.name === name);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());

const FIVE = ["items", "context", "memory", "db", "code"];
const OLD = ["items", "context", "memory"];
const P = "__dflt_scopes_pg_test__";
const DOMAIN = "dflt-scopes-pgtest.example.invalid";
const admin = { userId: `${P}admin`, email: "", scopes: ["items", "context", "memory", "admin"], projects: ["*"], tokenSource: "session" };

const rowScopes = async (id) => (await itemsPool.query(`SELECT scopes FROM org_member WHERE id=$1`, [id])).rows[0]?.scopes ?? null;
const colDefault = async () => (await itemsPool.query(
  `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='org_member'::regclass AND a.attname='scopes'`)).rows[0]?.expr ?? "";
const defaultScopes = async () => { const m = /'(\[.*\])'/.exec(await colDefault()); return m ? JSON.parse(m[1]) : null; };
async function cleanup() {
  await itemsPool.query(`DELETE FROM auth_token WHERE user_id LIKE $1 OR member_id LIKE $1`, [`${P}%`]);
  await itemsPool.query(`DELETE FROM member_credential WHERE member_id LIKE $1 OR member_id IN (SELECT id FROM org_member WHERE email LIKE $2)`, [`${P}%`, `%@${DOMAIN}`]).catch(() => {});
  await itemsPool.query(`DELETE FROM person_identity WHERE member_id LIKE $1 OR member_id IN (SELECT id FROM org_member WHERE email LIKE $2)`, [`${P}%`, `%@${DOMAIN}`]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_member WHERE id LIKE $1 OR email LIKE $2`, [`${P}%`, `%@${DOMAIN}`]);
}

try {
  await initOrgCore(itemsPool);
  await cleanup();

  // ── E1 저장소 · 권한 생략 ──
  const e1 = await store.upsertMember({ id: `${P}e1`, kind: "agent", display_name: "기본값" }, "pgtest", "pgtest");
  chk("E1 새 구성원 · 권한 생략(저장소) → 다섯 개", same(e1.scopes, FIVE) && same(await rowScopes(`${P}e1`), FIVE), JSON.stringify(e1.scopes));

  // ── E2 REST/MCP 핸들러 · 권한 생략 ──
  const e2 = await cap("org_member_upsert").handler({ id: `${P}e2`, kind: "agent", display_name: "핸들러" }, admin);
  chk("E2 새 구성원 · 권한 생략(org_member_upsert) → 다섯 개", same(await rowScopes(`${P}e2`), FIVE), JSON.stringify([e2?.member?.scopes, await rowScopes(`${P}e2`)]));

  // ── E3 좁게 명시 ──
  await cap("org_member_upsert").handler({ id: `${P}e3`, kind: "agent", display_name: "좁게", scopes: ["items"] }, admin);
  chk("E3 새 구성원 · items 하나만 명시 → 그대로", same(await rowScopes(`${P}e3`), ["items"]), JSON.stringify(await rowScopes(`${P}e3`)));

  // ── E4 빈 배열(경계) ──
  await store.upsertMember({ id: `${P}e4`, kind: "system", display_name: "빈 권한", scopes: [] }, "pgtest", "pgtest");
  chk("E4 새 구성원 · 빈 배열 명시 → 빈 채로(기본값으로 채우지 않는다)", same(await rowScopes(`${P}e4`), []), JSON.stringify(await rowScopes(`${P}e4`)));

  // ── E5 기존 구성원 · 권한 생략하고 수정 ──
  await cap("org_member_upsert").handler({ id: `${P}e3`, display_name: "좁게(이름 바꿈)" }, admin);
  const e5 = await itemsPool.query(`SELECT scopes, display_name FROM org_member WHERE id=$1`, [`${P}e3`]);
  chk("E5 기존 구성원 · 이름만 수정 → 권한 그대로(넓어지지 않는다)", same(e5.rows[0]?.scopes, ["items"]) && e5.rows[0]?.display_name === "좁게(이름 바꿈)", JSON.stringify(e5.rows[0]));

  // ── E6 · E7 옛 기본값인 DB 에서 스키마 초기화 ──
  await itemsPool.query(`ALTER TABLE org_member ALTER COLUMN scopes SET DEFAULT '["items","context","memory"]'::jsonb`);
  await itemsPool.query(`INSERT INTO org_member(id, kind, display_name, state) VALUES($1,'agent','옛 구성원','active')`, [`${P}old`]);
  chk("E6a (준비) 옛 기본값으로 되돌린 칸이 옛 구성원에게 세 개를 준다", same(await defaultScopes(), OLD) && same(await rowScopes(`${P}old`), OLD), JSON.stringify([await colDefault(), await rowScopes(`${P}old`)]));
  await initOrgCore(itemsPool);
  chk("E6b 스키마 초기화 뒤 칸 기본값 → 다섯 개", same(await defaultScopes(), FIVE), await colDefault());
  chk("E7 초기화 전부터 있던 구성원 → 세 개 그대로", same(await rowScopes(`${P}old`), OLD), JSON.stringify(await rowScopes(`${P}old`)));
  await initOrgCore(itemsPool);
  chk("E6c 한 번 더 초기화해도 같다(멱등)", same(await defaultScopes(), FIVE) && same(await rowScopes(`${P}old`), OLD), await colDefault());

  // ── E8 칸 기본값에 기대는 직접 INSERT ──
  await itemsPool.query(`INSERT INTO org_member(id, kind, display_name, state) VALUES($1,'agent','직접 넣음','active')`, [`${P}raw`]);
  chk("E8 권한 칸을 생략한 직접 INSERT → 다섯 개", same(await rowScopes(`${P}raw`), FIVE), JSON.stringify(await rowScopes(`${P}raw`)));

  // ── E9 회사 계정 자동 가입 ──
  const e9 = await oidc.provisionOidcMember({ sub: `${P}sub`, email: `newcomer@${DOMAIN}`, displayName: "새 사람" });
  chk("E9 회사 계정 자동 가입 → 다섯 개", same(await rowScopes(e9), FIVE), JSON.stringify([e9, await rowScopes(e9)]));

  // ── E10 · E11 토큰 발급 · 권한 생략 ──
  const tokenRow = async (hash) => (await itemsPool.query(`SELECT scopes FROM auth_token WHERE token_hash=$1`, [hash])).rows[0]?.scopes ?? null;
  const e10 = await cap("org_token_mint").handler({ memberId: `${P}ghost`, label: "pgtest-dflt" }, admin);
  chk("E10 토큰 발급 · 구성원 행 없음 → 다섯 개로 굽는다", same(await tokenRow(e10.tokenHash), FIVE), JSON.stringify(await tokenRow(e10.tokenHash)));
  const e11 = await cap("org_token_mint").handler({ memberId: `${P}e3`, label: "pgtest-dflt" }, admin);
  chk("E11 토큰 발급 · 구성원 있음(items 하나) → 구성원 권한으로 굽는다", same(await tokenRow(e11.tokenHash), ["items"]), JSON.stringify(await tokenRow(e11.tokenHash)));
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch((e) => bad("정리", String(e)));
  await initOrgCore(itemsPool).catch(() => {});
  await itemsPool.end().catch(() => {});
}
console.log(`\n${pass} ok · ${fail} fail`);
process.exit(fail ? 1 : 0);

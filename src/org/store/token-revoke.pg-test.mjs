// #2646 토큰 회수 PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖 — 그 체인은 DB 없는 유닛뿐).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/store/token-revoke.pg-test.mjs
//
// 왜 이 계층이 따로 있는가(2026-09-04 실측 사고):
//  회수 창구가 `{ok:true}` 를 돌려줬는데 **그 토큰은 살아 있었다** — 같은 토큰으로 API 가 200 을 냈고,
//  목록의 회수 시각은 비어 있었다. 사람은 "자격증명을 무효화했다"고 믿고 자리를 떴다.
//  즉 「회수했다」는 **말**은 이미 한 번 거짓말을 했다. 그래서 여기서는 반환값만 보지 않고
//  **부작용**(revoked_at 이 실제로 찍혔는가 · 같은 평문 토큰이 실제로 죽었는가 · 감사에 무엇이 남았는가)을 본다.
//  목 pg 로는 못 본다 — now() 기준 판정, RETURNING rowCount 로 갈리는 revoked/already-revoked/not-found,
//  앞자리 유일성(LIKE) 판정은 실제 트랜잭션에서만 드러난다.
//
//  사양·엣지 표: 1~5행(회수 결과 3분기 + 감사) · 13~15행(앞자리: 모호/유일/없음) · 16행(부작용 확인).
//  6~12행(핸들 분류 순수판정)은 DB 없이 src/org/store/token-revoke.test.ts 가 덮는다.
import crypto from "node:crypto";
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const tok = await import(`${DIST}/org/store/tokens.js`);
const { BearerVerifier } = await import(`${DIST}/auth/bearer.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const MID = "__token_revoke_pg_test__";
const ACTOR = MID;           // 감사 행을 이 액터로 묶어 뒤에서 통째로 지운다
const SOURCE = "pgtest";
const touched = new Set();   // 이 테스트가 만든/건드린 token_hash — 감사 정리에 쓴다
const TC_APP = "pgt-tool-ceiling";   // 도구 허용 목록(TC 블록)이 만드는 앱 — 앱 행 · 동의 행을 cleanup 이 지운다

// 사양 B — 감사에 '회수'가 몇 건 남았는가. **실제로 지운 경우에만** 남아야 한다.
const auditRevokes = async (h) => (await itemsPool.query(
  `SELECT count(*)::int AS n FROM org_content_audit WHERE entity='auth_token' AND op='revoke' AND entity_key=$1`,
  [h],
)).rows[0].n;

const rowCount = async (sql, args) => (await itemsPool.query(sql, args)).rows[0].n;
const revokedAt = async (h) => (await itemsPool.query(
  `SELECT revoked_at FROM auth_token WHERE token_hash=$1`, [h])).rows[0]?.revoked_at ?? null;

async function mkMember() {
  await itemsPool.query(
    `INSERT INTO org_member(id, kind, display_name, email, state, scopes)
       VALUES($1,'human','토큰회수테스트','__token_revoke_pg_test__@example.invalid','active',$2::jsonb)
     ON CONFLICT (tenant_id, id) DO UPDATE SET scopes=$2::jsonb, state='active'`,
    [MID, JSON.stringify(["items"])],
  );
}

async function mint(label) {
  const m = await tok.mintToken({ userId: MID, scopes: ["items"], label, memberId: MID }, ACTOR, SOURCE);
  touched.add(m.tokenHash);
  return m;
}

async function cleanup() {
  await itemsPool.query(`DELETE FROM auth_token WHERE member_id=$1 OR user_id=$1`, [MID]);
  await itemsPool.query(`DELETE FROM org_content_audit WHERE actor=$1`, [MID]).catch(() => {});
  for (const h of touched) {
    await itemsPool.query(
      `DELETE FROM org_content_audit WHERE entity='auth_token' AND entity_key=$1`, [h]).catch(() => {});
    await itemsPool.query(`DELETE FROM auth_token WHERE token_hash=$1`, [h]).catch(() => {});
  }
  await itemsPool.query(`DELETE FROM org_app_grant WHERE app_id=$1`, [TC_APP]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_app WHERE id=$1`, [TC_APP]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_member WHERE id=$1`, [MID]);
}

try {
  await cleanup();
  await mkMember();

  // ── 엣지 1 (= 사양 C 왕복) — 발급이 준 tokenHash 를 **그대로** 회수에 넣으면 통한다 ────────────
  {
    const a = await mint("pgtest-e1");
    chk("E1a 발급 응답의 tokenHash 는 64자 16진수(회수 창구가 받는 모양 그대로)",
      typeof a.tokenHash === "string" && /^[0-9a-f]{64}$/.test(a.tokenHash), `tokenHash=${a.tokenHash}`);
    const out = await tok.revokeToken(a.tokenHash, ACTOR, SOURCE);
    chk("E1b ★ 살아있는 토큰을 그 전체 핸들로 회수 → 'revoked'", out === "revoked", `out=${JSON.stringify(out)}`);
    // 말이 아니라 부작용 — 목록의 회수 시각이 비어 있던 것이 이 사고의 실체였다.
    chk("E1c ★ 부작용: revoked_at 이 실제로 찍힌다", (await revokedAt(a.tokenHash)) != null, "revoked_at 이 여전히 비어 있다");
    chk("E1d 사양 B: 실제로 지웠으니 감사 '회수' 1건", (await auditRevokes(a.tokenHash)) === 1,
      `n=${await auditRevokes(a.tokenHash)}`);
  }

  // ── 엣지 2 — 같은 토큰 연달아 두 번 → 회수됨 / 이미 회수됨, 감사는 총 1건 ────────────────────
  let alreadyOutcome = null;
  {
    const b = await mint("pgtest-e2");
    const first = await tok.revokeToken(b.tokenHash, ACTOR, SOURCE);
    chk("E2a 1회차 → 'revoked'", first === "revoked", `out=${JSON.stringify(first)}`);
    chk("E2b 1회차 뒤 감사 1건", (await auditRevokes(b.tokenHash)) === 1, `n=${await auditRevokes(b.tokenHash)}`);
    alreadyOutcome = await tok.revokeToken(b.tokenHash, ACTOR, SOURCE);
    chk("E2c ★ 2회차 → 'already-revoked'(성공이되 멱등 — 이번에 내가 지운 건 아니다)",
      alreadyOutcome === "already-revoked", `out=${JSON.stringify(alreadyOutcome)}`);
    chk("E2d ★ 사양 B: 2회차는 아무것도 무효화하지 않았으니 감사는 여전히 1건(거짓 근거 금지)",
      (await auditRevokes(b.tokenHash)) === 1, `n=${await auditRevokes(b.tokenHash)}`);
  }

  // ── 엣지 3 — 이미 회수된 토큰을 회수 → 이미 회수됨, 감사 0건 ───────────────────────────────
  //  (다른 경로로 이미 죽어 있던 토큰. 이 호출은 아무것도 안 했으므로 '회수'로 남으면 안 된다.)
  {
    const c = await mint("pgtest-e3");
    await itemsPool.query(`UPDATE auth_token SET revoked_at = now() WHERE token_hash=$1`, [c.tokenHash]);
    const out = await tok.revokeToken(c.tokenHash, ACTOR, SOURCE);
    chk("E3a 이미 회수된 토큰 → 'already-revoked'", out === "already-revoked", `out=${JSON.stringify(out)}`);
    chk("E3b ★ 사양 B: 아무것도 무효화하지 않았으니 감사 '회수' 0건",
      (await auditRevokes(c.tokenHash)) === 0, `n=${await auditRevokes(c.tokenHash)}`);
  }

  // ── 엣지 4 — 존재하지 않는 핸들로 회수 → 그런 토큰 없음(실패), 감사 0건 ────────────────────
  let notFoundOutcome = null;
  {
    const ghost = crypto.randomBytes(32).toString("hex");
    touched.add(ghost);
    const pre = await rowCount(`SELECT count(*)::int AS n FROM auth_token WHERE token_hash=$1`, [ghost]);
    chk("E4a (가드) 그 해시는 DB 에 없다", pre === 0, `n=${pre}`);
    notFoundOutcome = await tok.revokeToken(ghost, ACTOR, SOURCE);
    chk("E4b ★ 존재하지 않는 64자 해시 → 'not-found'(성공이라 말하면 안 된다)",
      notFoundOutcome === "not-found", `out=${JSON.stringify(notFoundOutcome)}`);
    chk("E4c ★ 사양 B: 없는 토큰에 대한 감사 '회수' 0건",
      (await auditRevokes(ghost)) === 0, `n=${await auditRevokes(ghost)}`);
  }

  // ── 엣지 5 — 「이미 회수됨」과 「그런 토큰 없음」이 서로 다른 값인가 ──────────────────────────
  //  뭉개면 사양 A 표의 마지막 줄(**아직 안 끝났다** — 올바른 핸들을 다시 찾아야 한다)이 사라진다.
  {
    chk("E5a ★ 'already-revoked' ≠ 'not-found'(한 값으로 뭉개면 안 된다)",
      alreadyOutcome !== notFoundOutcome, `already=${JSON.stringify(alreadyOutcome)} notFound=${JSON.stringify(notFoundOutcome)}`);
    chk("E5b 세 결과가 서로 다르다(revoked / already-revoked / not-found)",
      new Set(["revoked", alreadyOutcome, notFoundOutcome]).size === 3,
      `set=${JSON.stringify([...new Set(["revoked", alreadyOutcome, notFoundOutcome])])}`);
  }

  // ── 엣지 13 — 앞자리가 여러 토큰에 걸림 → 모호(회수 안 함) + 몇 개가 걸렸는지 ────────────────
  //  같은 앞자리를 가진 토큰 2개를 일부러 만든다(발급 해시를 같은 앞자리로 덮어써서).
  {
    const P = crypto.randomBytes(8).toString("hex");           // 16자 — MIN_HANDLE_LEN(12) 이상
    const d1 = await mint("pgtest-amb-1");
    const d2 = await mint("pgtest-amb-2");
    const h1 = P + crypto.randomBytes(24).toString("hex");     // 16 + 48 = 64
    const h2 = P + crypto.randomBytes(24).toString("hex");
    touched.add(h1); touched.add(h2);
    await itemsPool.query(`UPDATE auth_token SET token_hash=$2 WHERE token_hash=$1`, [d1.tokenHash, h1]);
    await itemsPool.query(`UPDATE auth_token SET token_hash=$2 WHERE token_hash=$1`, [d2.tokenHash, h2]);
    const n = await rowCount(`SELECT count(*)::int AS n FROM auth_token WHERE token_hash LIKE $1`, [`${P}%`]);
    chk("E13a (가드) 그 앞자리에 정확히 2건이 걸려 있다", n === 2, `n=${n}`);

    const r = await tok.resolveTokenHandle(P);
    chk("E13b ★ 앞자리가 여럿에 걸림 → 회수하지 않고 'ambiguous'(아무거나 하나 죽이면 엉뚱한 사람의 접속이 끊긴다)",
      r.ok === false && r.reason === "ambiguous", JSON.stringify(r));
    chk("E13c ★ 몇 개가 걸렸는지 함께 답한다(사람이 앞자리를 더 붙여 좁힐 수 있어야 한다)",
      r.ok === false && r.matches === 2, JSON.stringify(r));
    // 부작용 없음 — 모호할 때는 하나도 죽이지 않는다.
    chk("E13d ★ 부작용: 두 토큰 모두 살아 있다(모호 판정이 하나를 죽이지 않았다)",
      (await revokedAt(h1)) == null && (await revokedAt(h2)) == null,
      `h1=${await revokedAt(h1)} h2=${await revokedAt(h2)}`);
    chk("E13e 사양 B: 모호 판정은 감사 '회수'를 남기지 않는다",
      (await auditRevokes(h1)) === 0 && (await auditRevokes(h2)) === 0,
      `h1=${await auditRevokes(h1)} h2=${await auditRevokes(h2)}`);
  }

  // ── 엣지 14 — 앞자리가 정확히 한 토큰에 걸림 → 그 토큰을 회수 (사양 C: 앞 12자로도 통한다) ──────
  {
    const e = await mint("pgtest-e14");
    const p12 = e.tokenHash.slice(0, 12);
    const n = await rowCount(`SELECT count(*)::int AS n FROM auth_token WHERE token_hash LIKE $1`, [`${p12}%`]);
    chk("E14a (가드) 그 12자 앞자리에 정확히 1건이 걸린다", n === 1, `n=${n}`);

    const r = await tok.resolveTokenHandle(p12);
    chk("E14b ★ 유일한 12자 앞자리 → 그 토큰의 전체 해시로 해석된다",
      r.ok === true && r.tokenHash === e.tokenHash, `${JSON.stringify(r)} want=${e.tokenHash}`);
    chk("E14c ★ 해석된 해시로 회수하면 실제로 회수된다",
      r.ok === true && (await tok.revokeToken(r.tokenHash, ACTOR, SOURCE)) === "revoked", JSON.stringify(r));
    chk("E14d 부작용: revoked_at 이 찍혔다", (await revokedAt(e.tokenHash)) != null, "revoked_at 이 비어 있다");
    chk("E14e 감사 '회수' 1건", (await auditRevokes(e.tokenHash)) === 1, `n=${await auditRevokes(e.tokenHash)}`);
  }

  // ── 엣지 15 — 앞자리가 하나도 안 걸림 → 그런 토큰 없음 ────────────────────────────────────
  {
    const orphan = crypto.randomBytes(16).toString("hex");     // 32자 — 길이는 정상, 걸리는 토큰이 없다
    const n = await rowCount(`SELECT count(*)::int AS n FROM auth_token WHERE token_hash LIKE $1`, [`${orphan}%`]);
    chk("E15a (가드) 그 앞자리에 걸리는 토큰이 없다", n === 0, `n=${n}`);
    const r = await tok.resolveTokenHandle(orphan);
    chk("E15b ★ 안 걸리는 앞자리 → 'not-found'(모호도 아니고 성공도 아니다)",
      r.ok === false && r.reason === "not-found", JSON.stringify(r));
  }

  // ── 엣지 16 (가장 중요) — 회수한 뒤 그 평문 토큰으로 인증하면 거부된다 ──────────────────────
  //  이 사고의 본체가 바로 여기다: 창구는 ok 를 냈는데 **평문 토큰이 계속 200 을 냈다**.
  //  「회수했다」는 말이 아니라 **그 토큰이 실제로 죽었는지**를 본다.
  {
    const f = await mint("pgtest-e16");
    const before = await tok.verifyDbToken(f.token);
    chk("E16a (전제) 발급 직후 그 평문 토큰으로 인증된다", before !== null && typeof before === "object",
      `before=${JSON.stringify(before)}`);
    const out = await tok.revokeToken(f.tokenHash, ACTOR, SOURCE);
    chk("E16b 발급이 준 tokenHash 로 회수 → 'revoked'", out === "revoked", `out=${JSON.stringify(out)}`);
    const after = await tok.verifyDbToken(f.token);
    chk("E16c ★★ 회수 뒤 **같은 평문 토큰**으로 인증하면 거부된다(살아 있으면 안 된다)",
      after === null, `여전히 인증된다 — 회수가 말뿐이었다: ${JSON.stringify(after)}`);
    chk("E16d ★ 목록에 보일 회수 시각이 실제로 찍혔다(사고 당시 이 자리가 비어 있었다)",
      (await revokedAt(f.tokenHash)) != null, "revoked_at 이 비어 있다");
  }

  // ── #4891 앱 서버 급 토큰 — 사람 홈 없는 작업 AI 의 토큰. 검증이 appServer 를 켜야 문(auth/http-auth)과 EXEMPT 끄기(apps/principal)가 선다 ──
  {
    const app = await tok.mintToken({ userId: MID, scopes: ["items"], label: "pgtest-asp", memberId: MID, appId: "pgt-app", appServerPrincipal: true }, ACTOR, SOURCE);
    touched.add(app.tokenHash);
    const v = await tok.verifyDbToken(app.token);
    chk("AS1 앱 서버 급으로 만든 앱 토큰 — 검증이 appServer 를 켜고 앱 · 구성원을 그대로 싣는다",
      v !== null && v.appServer === true && v.appId === "pgt-app" && v.userId === MID, JSON.stringify(v));
    const plainApp = await tok.mintToken({ userId: MID, scopes: ["items"], label: "pgtest-app", memberId: MID, appId: "pgt-app" }, ACTOR, SOURCE);
    touched.add(plainApp.tokenHash);
    const pv = await tok.verifyDbToken(plainApp.token);
    chk("AS2 표시 없는 앱 토큰 · 일반 토큰은 appServer 칸이 없다(무회귀)",
      pv !== null && !("appServer" in pv) && !("appServer" in ((await tok.verifyDbToken((await mint("pgtest-plain")).token)) ?? {})), JSON.stringify(pv));
    let threw = null;
    try { await tok.mintToken({ userId: MID, scopes: ["items"], label: "pgtest-asp-noapp", memberId: MID, appServerPrincipal: true }, ACTOR, SOURCE); } catch (e) { threw = e; }
    chk("AS3 앱 없이 앱 서버 급으로는 못 만든다", threw !== null && /appId/.test(String(threw?.message)), String(threw?.message));
    //  있어선 안 되는 행(표시는 켜졌는데 앱이 없다)을 직접 넣어도 검증이 받지 않는다 — 앱 도구 게이트가 안 걸리는 주체가 생기지 않게.
    const bogus = "lvk_" + crypto.randomBytes(24).toString("base64url");
    const bh = crypto.createHash("sha256").update(bogus).digest("hex");
    touched.add(bh);
    await itemsPool.query(
      `INSERT INTO auth_token(token_hash, user_id, scopes, projects, label, member_id, created_by, app_id, app_server_principal)
         VALUES($1,$2,'["items"]'::jsonb,'["*"]'::jsonb,'pgtest-bogus',$2,$3,NULL,true)`, [bh, MID, ACTOR]);
    chk("AS4 표시만 있고 앱이 없는 토큰은 검증이 거부한다", (await tok.verifyDbToken(bogus)) === null);
    //  진짜 검증기(bearer.ts)가 그 표시를 주체(LivelyUser)로 옮기는가 — 문(auth/http-auth)이 보는 것은 이 주체다.
    const vf = new BearerVerifier();
    const jobU = (await vf.verifyAccessToken(app.token)).extra;
    const plainU = (await vf.verifyAccessToken(plainApp.token)).extra;
    chk("AS5 진짜 검증기가 앱 서버 급 표시를 주체로 옮긴다 · 표시 없는 앱 토큰은 그대로", jobU?.appServer === true && jobU?.appId === "pgt-app" && !plainU?.appServer,
      JSON.stringify({ job: jobU && { appServer: jobU.appServer, appId: jobU.appId }, plain: plainU && { appServer: plainU.appServer } }));
  }
  // ── 도구 허용 목록(ai.tools) — 작업 토큰의 도구 상한(도구 허용 목록 사양 T22 · T22b · T23 · T24~T27 · T29 사슬) ──
  //  이게 틀리면: 목록을 둔 앱 AI 작업의 토큰이 상한 없이(앱 동의 전체 — store_sql 등) 쓰이거나, 손상된 상한 칸이 «상한 없음» 으로 읽히거나,
  //  상한 밖 도구가 배관 면제(whoami 등) · DB 도구 길로 새거나, 롤 창(칸이 아직 없는 DB)에서 토큰 발급 · 확인이 통째로 깨진다.
  {
    const principal = await import(`${DIST}/apps/principal.js`);
    const appsStore = await import(`${DIST}/org/store/apps.js`);
    const dbTools = await import(`${DIST}/tools/db.js`);
    const { appPrincipalGate } = await import(`${DIST}/auth/http-auth.js`);
    const same = (a, b) => Array.isArray(a) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const ceilRaw = async (h) => (await itemsPool.query(`SELECT tool_ceiling FROM auth_token WHERE token_hash=$1`, [h])).rows[0]?.tool_ceiling;
    const byLabel = async (label) => (await itemsPool.query(`SELECT count(*)::int AS n FROM auth_token WHERE label=$1`, [label])).rows[0].n;
    const mintT = async (label, extra) => {
      const m = await tok.mintToken({ userId: MID, scopes: ["items"], label, memberId: MID, ...extra }, ACTOR, SOURCE);
      touched.add(m.tokenHash);
      return m;
    };
    const verifySafe = async (t) => { try { return await tok.verifyDbToken(t); } catch (e) { return `던짐: ${e?.message ?? e}`; } };
    const keysOf = (v) => (v && typeof v === "object" ? Object.keys(v) : v);

    // ── T22 · T23 발급 → 행 → 확인 ──
    const c1 = await mintT("pgtest-tc1", { appId: TC_APP, toolCeiling: ["store_sql", "knowledge_search"] });
    const v1 = await tok.verifyDbToken(c1.token);
    chk("TC1 T22·T23 상한을 준 앱 토큰 — 토큰 행에 그 상한이 남고 확인이 그 목록(toolCeiling)을 싣는다",
      same(await ceilRaw(c1.tokenHash), ["store_sql", "knowledge_search"]) && v1 !== null && v1.appId === TC_APP && same(v1.toolCeiling, ["store_sql", "knowledge_search"]),
      JSON.stringify({ raw: await ceilRaw(c1.tokenHash), v: v1 && { appId: v1.appId, toolCeiling: v1.toolCeiling } }));
    const c0 = await mintT("pgtest-tc-empty", { appId: TC_APP, toolCeiling: [] });
    const v0 = await tok.verifyDbToken(c0.token);
    chk("TC2 T22·T23 빈 상한([])도 상한 — 행에 빈 목록이 남고 확인이 빈 목록을 싣는다(아무것도 허락하지 않음)",
      same(await ceilRaw(c0.tokenHash), []) && v0 !== null && same(v0.toolCeiling, []), JSON.stringify({ raw: await ceilRaw(c0.tokenHash), v: v0 && v0.toolCeiling }));
    const nApp = await mintT("pgtest-tc-noceil-app", { appId: TC_APP });
    const nNull = await mintT("pgtest-tc-null-app", { appId: TC_APP, toolCeiling: null });
    const nPlain = await mintT("pgtest-tc-noceil-plain", {});
    const vs = { app: await tok.verifyDbToken(nApp.token), nul: await tok.verifyDbToken(nNull.token), plain: await tok.verifyDbToken(nPlain.token) };
    const raws = [await ceilRaw(nApp.tokenHash), await ceilRaw(nNull.tokenHash), await ceilRaw(nPlain.tokenHash)];
    chk("TC3 T22·T23 상한을 주지 않은 발급(생략 · null — 앱 토큰 · 일반 토큰)은 종전 — 행의 상한 칸은 비고 확인은 toolCeiling 을 싣지 않는다",
      Object.values(vs).every((v) => v !== null && !("toolCeiling" in v)) && raws.every((r) => r == null),
      JSON.stringify({ keys: Object.fromEntries(Object.entries(vs).map(([k, v]) => [k, keysOf(v)])), raws }));
    const noApp = {};
    for (const [label, ceiling] of [["pgtest-tc-noapp", ["store_sql"]], ["pgtest-tc-noapp-empty", []]]) {
      let threw = null;
      try { const m = await tok.mintToken({ userId: MID, scopes: ["items"], label, memberId: MID, toolCeiling: ceiling }, ACTOR, SOURCE); touched.add(m.tokenHash); } catch (e) { threw = e; }
      noApp[label] = { threw: threw !== null, rows: await byLabel(label) };
    }
    chk("TC4 T22 상한은 앱 토큰에만 — 앱 없이 상한을 주면(빈 상한 포함) 던지고 토큰을 만들지 않는다", Object.values(noApp).every((x) => x.threw && x.rows === 0), JSON.stringify(noApp));

    // ── T23 손상된 칸 · 앱 없이 상한이 걸린 행(직접 넣은 행) ──
    const rawToken = async (label, appId, ceilingJson) => {
      const t = "lvk_" + crypto.randomBytes(24).toString("base64url");
      const h = crypto.createHash("sha256").update(t).digest("hex");
      touched.add(h);
      await itemsPool.query(
        `INSERT INTO auth_token(token_hash, user_id, scopes, projects, label, member_id, created_by, app_id, tool_ceiling)
           VALUES($1,$2,'["items"]'::jsonb,'["*"]'::jsonb,$3,$2,$4,$5,$6::jsonb)`, [h, MID, label, ACTOR, appId, ceilingJson]);
      return t;
    };
    const broken = {};
    for (const [i, bad] of ['"store_sql"', '{"store_sql":true}', "[1]", '["store_sql", 2]', '[["store_sql"]]', "[null]", "true", "3"].entries()) {
      const v = await verifySafe(await rawToken(`pgtest-tc-broken-${i}`, TC_APP, bad));
      broken[bad] = v === null ? "무효" : (typeof v === "string" ? v : v.toolCeiling);
    }
    chk("TC5 T23 상한 칸의 값이 문자열 배열이 아니면(손상) 빈 상한으로 싣는다 — 토큰은 유효 · 아무것도 허락하지 않음",
      Object.values(broken).every((x) => same(x, [])), JSON.stringify(broken));
    const orphan = { list: await verifySafe(await rawToken("pgtest-tc-orphan", null, '["store_sql"]')), empty: await verifySafe(await rawToken("pgtest-tc-orphan-empty", null, "[]")) };
    chk("TC6 T23 앱 없이 상한이 걸린 행은 무효 토큰(null)", orphan.list === null && orphan.empty === null, JSON.stringify(orphan));
    const vf = new BearerVerifier();
    const u1 = (await vf.verifyAccessToken(c1.token)).extra;
    const uApp = (await vf.verifyAccessToken(nApp.token)).extra;
    chk("TC7 T23 사슬 — 진짜 검증기(bearer)가 상한을 주체(LivelyUser.toolCeiling)로 옮긴다 · 상한 없는 앱 토큰의 주체엔 그 칸이 없다",
      same(u1?.toolCeiling, ["store_sql", "knowledge_search"]) && u1?.appId === TC_APP && !!uApp && !("toolCeiling" in uApp),
      JSON.stringify({ u1: u1?.toolCeiling, app: keysOf(uApp) }));

    // ── T22b 앱 토큰 발급(principal.mintAppToken)의 opts.toolCeiling — 진짜 앱 행 · 동의 행으로 ──
    const GRANT = ["store_sql", "knowledge_search", "db_query"];
    await appsStore.upsertApp({ id: TC_APP, title: "pgtest 도구 상한", version: "1.0.0", source: { kind: "inline" }, content_hash: null, status: "active", enabled: true,
      manifest: { id: TC_APP, title: "pgtest 도구 상한", version: "1.0.0", permissions: { tools: GRANT } } }, { actor: ACTOR, source: SOURCE });
    await appsStore.upsertGrant(TC_APP, MID, ["items"], GRANT, { actor: ACTOR, source: SOURCE });
    principal._clearAppToolCache();
    const mintApp = async (opts) => { const m = await principal.mintAppToken(MID, TC_APP, ACTOR, opts); touched.add(m.tokenHash); return m; };
    const ma = await mintApp({ toolCeiling: ["knowledge_search"] });
    const mOmit = await mintApp(undefined), mNull = await mintApp({ toolCeiling: null }), mSrv = await mintApp({ appServerPrincipal: true, toolCeiling: ["store_sql"] });
    const av = { ceil: await tok.verifyDbToken(ma.token), omit: await tok.verifyDbToken(mOmit.token), nul: await tok.verifyDbToken(mNull.token), srv: await tok.verifyDbToken(mSrv.token) };
    chk("TC8 T22b 앱 토큰 발급의 opts.toolCeiling 이 그대로 토큰의 상한이 된다(확인에 실린다) · 생략 · null 이면 상한 없음 · 앱 서버 급 표시와 함께여도",
      same(av.ceil?.toolCeiling, ["knowledge_search"]) && av.ceil?.appId === TC_APP
        && !!av.omit && !("toolCeiling" in av.omit) && !!av.nul && !("toolCeiling" in av.nul)
        && av.srv?.appServer === true && same(av.srv?.toolCeiling, ["store_sql"]),
      JSON.stringify(Object.fromEntries(Object.entries(av).map(([k, v]) => [k, v && { appId: v.appId, appServer: v.appServer, toolCeiling: v.toolCeiling }]))));

    // ── T24~T27 도구 판정 — 진짜 동의 행(GRANT = store_sql · knowledge_search · db_query)으로 ──
    principal._clearAppToolCache();
    const base = { userId: MID, email: "", scopes: ["items"], projects: ["*"], appId: TC_APP };
    const allowed = async (u, names) => {
      const out = {};
      for (const n of names) { try { out[n] = await principal.appToolAllowed(u, n); } catch (e) { out[n] = `던짐: ${e?.status ?? ""} ${e?.message ?? e}`; } }
      return out;
    };
    const required = async (u, name) => { try { await principal.requireAppTool(u, name); return "ok"; } catch (e) { return e?.status ?? `던짐: ${e?.message ?? e}`; } };
    const dbGate = async (u, name) => { try { await dbTools.requireDbToolForAppServer(u, name); return "ok"; } catch (e) { return e?.status ?? `던짐: ${e?.message ?? e}`; } };
    const eq = (got, want) => JSON.stringify(got) === JSON.stringify(want);

    const U0 = base;                                                                                   // 상한 없음
    const U1 = { ...base, toolCeiling: ["knowledge_search"] };                                          // 동의의 일부만
    const U2 = { ...base, toolCeiling: ["knowledge_get", "store_sql", "whoami", "db_query", "db_schema"] };   // 동의 밖 이름도 섞임
    const U3 = { ...base, toolCeiling: [] };                                                            // 빈 상한
    const U4 = { ...base, toolCeiling: ["store_*", "*", "knowledge_sea", "knowledge_search_x", "STORE_SQL "] };   // 정확한 이름이 아닌 것들
    const S1 = { ...base, appServer: true, toolCeiling: ["whoami", "store_sql"] };
    const H1 = { userId: MID, email: "", scopes: ["items"], projects: ["*"], toolCeiling: ["knowledge_search"] };   // 앱 없는 주체 + 상한
    const H0 = { userId: MID, email: "", scopes: ["items"], projects: ["*"] };

    const a0 = await allowed(U0, ["store_sql", "knowledge_search", "db_query", "knowledge_get", "whoami"]);
    const r0 = { store_sql: await required(U0, "store_sql"), knowledge_get: await required(U0, "knowledge_get") };
    chk("TC9 T26 상한이 없는 주체는 종전 — 동의 안 통과 · 동의 밖 거절(403) · 배관 면제(whoami) 통과",
      eq(a0, { store_sql: true, knowledge_search: true, db_query: true, knowledge_get: false, whoami: true }) && r0.store_sql === "ok" && r0.knowledge_get === 403,
      JSON.stringify({ a0, r0 }));
    const a1 = await allowed(U1, ["knowledge_search", "store_sql", "db_query", "knowledge_get"]);
    const r1 = { store_sql: await required(U1, "store_sql"), knowledge_search: await required(U1, "knowledge_search") };
    chk("TC10 T24 상한 밖 도구는 앱 동의에 있어도 거절(requireAppTool 403) · 상한 안이고 동의에도 있으면 통과",
      eq(a1, { knowledge_search: true, store_sql: false, db_query: false, knowledge_get: false }) && r1.store_sql === 403 && r1.knowledge_search === "ok",
      JSON.stringify({ a1, r1 }));
    const a2 = await allowed(U2, ["knowledge_get", "store_sql", "db_query"]);
    const r2 = await required(U2, "knowledge_get");
    chk("TC11 T24 상한 안이어도 종전 판정(앱 동의)을 또 통과해야 — 동의 밖(knowledge_get)은 거절(403) · 동의 안은 통과",
      eq(a2, { knowledge_get: false, store_sql: true, db_query: true }) && r2 === 403, JSON.stringify({ a2, r2 }));
    const w1 = { allowed: (await allowed(U1, ["whoami"])).whoami, required: await required(U1, "whoami"), inCeiling: (await allowed(U2, ["whoami"])).whoami };
    chk("TC12 T25 상한은 세션 배관 면제보다 앞선다 — 상한 밖이면 whoami 도 거절(403) · 상한 안이면 종전 면제대로 통과",
      w1.allowed === false && w1.required === 403 && w1.inCeiling === true, JSON.stringify(w1));
    const a3 = await allowed(U3, ["store_sql", "knowledge_search", "db_query", "whoami"]);
    chk("TC13 T3·T24 빈 상한 — 동의 안 도구 · 배관 면제 모두 거절", Object.values(a3).every((x) => x === false), JSON.stringify(a3));
    const a4 = await allowed(U4, ["store_sql", "knowledge_search"]);
    chk("TC14 T24 상한의 이름은 정확히 같아야 — 글롭 · 앞머리 · 더 긴 이름 · 대소문자 · 빈칸이 다른 이름은 열지 않는다",
      Object.values(a4).every((x) => x === false), JSON.stringify(a4));
    const s1 = await allowed(S1, ["store_sql", "whoami"]);
    chk("TC15 T24 앱 서버 급 + 상한 — 상한 안이어도 종전 판정(앱 서버 급은 배관 면제 없음 · 동의 밖 whoami 거절)",
      eq(s1, { store_sql: true, whoami: false }), JSON.stringify(s1));
    const h1 = await allowed(H1, ["knowledge_search", "store_sql", "project_create_v6"]);
    const h0 = await allowed(H0, ["project_create_v6", "store_sql"]);
    chk("TC16 T24·T26 앱 없는 주체 — 상한이 있으면 상한 안만(종전 판정은 통과) · 상한이 없으면 종전대로 모두 통과",
      eq(h1, { knowledge_search: true, store_sql: false, project_create_v6: false }) && eq(h0, { project_create_v6: true, store_sql: true }),
      JSON.stringify({ h1, h0 }));
    const g = {
      ceilOut: await dbGate(U1, "db_query"), inBoth: await dbGate(U2, "db_query"), inCeilNotGrant: await dbGate(U2, "db_schema"), empty: await dbGate(U3, "db_query"),
      plainQuery: await dbGate(U0, "db_query"), plainSchema: await dbGate(U0, "db_schema"),
      srvQuery: await dbGate({ ...base, appServer: true }, "db_query"), srvSchema: await dbGate({ ...base, appServer: true }, "db_schema"),
    };
    chk("TC17 T27 DB 도구 앱 게이트 — 상한이 있는 주체: 상한 밖 403 · 상한 안 + 동의 통과 · 상한 안 + 동의 밖 403 · 빈 상한 403 / 상한 없는 앱 세션 토큰은 종전(게이트 없음) · 앱 서버 급은 종전(동의 판정)",
      g.ceilOut === 403 && g.inBoth === "ok" && g.inCeilNotGrant === 403 && g.empty === 403 && g.plainQuery === "ok" && g.plainSchema === "ok"
        && g.srvQuery === "ok" && g.srvSchema === 403, JSON.stringify(g));
    const hDb = await dbGate(H1, "db_query");
    chk("TC18 T27 앱 없는 주체라도 상한이 있으면 DB 도구 게이트가 걸린다 — 상한 밖 db_query 403", hDb === 403, JSON.stringify({ hDb }));

    // ── 사슬 — 앱 토큰 발급(상한) → 진짜 검증기 → 도구 판정 · 문 판정(T22b → T23 → T24 · T27 · T29) ──
    const ju = (await vf.verifyAccessToken(ma.token)).extra;
    const chain = {
      ceiling: ju?.toolCeiling, store: await required(ju, "store_sql"), search: await required(ju, "knowledge_search"), db: await dbGate(ju, "db_query"),
      gate: ["cap", "mcp", "deny"].map((m) => appPrincipalGate(ju, m)),
    };
    chk("TC19 사슬 — 상한 [knowledge_search] 로 발급한 앱 토큰: 검증기를 지난 주체가 store_sql · db_query 403 · knowledge_search 통과 · 문은 cap/mcp 만 받고 그 밖 거부",
      same(chain.ceiling, ["knowledge_search"]) && chain.store === 403 && chain.search === "ok" && chain.db === 403 && eq(chain.gate, ["next", "next", "deny"]),
      JSON.stringify(chain));

    // ── T23 롤 창 — 토큰 표에 상한 칸이 아직 없는 DB(마이그레이션 전). 끝나면 칸을 되살린다(CI 는 같은 DB 로 다음 단계를 돈다) ──
    const before = await mintT("pgtest-tc-pre-old", { appId: TC_APP });
    await itemsPool.query(`ALTER TABLE auth_token DROP COLUMN IF EXISTS tool_ceiling`);
    try {
      const tryMint = async (label, extra) => { try { return await mintT(label, extra); } catch (e) { return { err: e?.code ?? e?.message ?? String(e) }; } };
      const p = { app: await tryMint("pgtest-tc-pre-app", { appId: TC_APP }), nul: await tryMint("pgtest-tc-pre-null", { appId: TC_APP, toolCeiling: null }),
        plain: await tryMint("pgtest-tc-pre-plain", {}) };
      const pv = {
        old: await verifySafe(before.token), app: p.app.token ? await verifySafe(p.app.token) : p.app, nul: p.nul.token ? await verifySafe(p.nul.token) : p.nul,
        plain: p.plain.token ? await verifySafe(p.plain.token) : p.plain,
      };
      let bearerOk = null;
      try { bearerOk = (await vf.verifyAccessToken(before.token)).extra?.userId === MID; } catch (e) { bearerOk = `던짐: ${e?.message ?? e}`; }
      chk("TC20 T23 칸이 없는 DB — 상한 없는 발급(앱 토큰 · null · 일반 토큰)과 토큰 확인(그 전에 만든 토큰 포함 · 진짜 검증기)은 깨지지 않고 상한 없음으로 본다",
        Object.values(pv).every((v) => v !== null && typeof v === "object" && !("err" in v) && !("toolCeiling" in v)) && bearerOk === true,
        JSON.stringify({ pv: Object.fromEntries(Object.entries(pv).map(([k, v]) => [k, typeof v === "object" && v && !("err" in v) ? keysOf(v) : v])), bearerOk }));
      const withCeil = {};
      for (const [label, extra] of [["pgtest-tc-pre-ceil", { appId: TC_APP, toolCeiling: ["store_sql"] }], ["pgtest-tc-pre-ceil-empty", { appId: TC_APP, toolCeiling: [] }]]) {
        const r = await tryMint(label, extra);
        withCeil[label] = { threw: !r.token, rows: await byLabel(label) };
      }
      let appThrew = false;
      try { const m = await principal.mintAppToken(MID, TC_APP, ACTOR, { toolCeiling: ["knowledge_search"] }); touched.add(m.tokenHash); } catch { appThrew = true; }
      chk("TC21 T23·T22b 칸이 없는 DB 에서 상한을 실은 발급(빈 상한 · 앱 토큰 발급 포함)은 던지고 — 상한 없이 굽지 않는다(행이 생기지 않는다)",
        Object.values(withCeil).every((x) => x.threw && x.rows === 0) && appThrew, JSON.stringify({ withCeil, appThrew }));
    } finally {
      await itemsPool.query(`ALTER TABLE auth_token ADD COLUMN IF NOT EXISTS tool_ceiling JSONB`);
    }
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\ntoken-revoke pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

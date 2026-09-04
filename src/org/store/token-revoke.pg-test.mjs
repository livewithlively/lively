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

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const MID = "__token_revoke_pg_test__";
const ACTOR = MID;           // 감사 행을 이 액터로 묶어 뒤에서 통째로 지운다
const SOURCE = "pgtest";
const touched = new Set();   // 이 테스트가 만든/건드린 token_hash — 감사 정리에 쓴다

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
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\ntoken-revoke pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

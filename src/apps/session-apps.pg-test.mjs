// 앱 폴더 판정·승계 DB 함수(#4788 앱 v2-23 · #4684 후속) PG 통합 테스트 — **실제 Postgres 필요**(CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/session-apps.pg-test.mjs
//
//  왜 PG 통합인가: 앱 폴더 판정·맞추기 시험(session-app-folders.test.ts · session-app-folders-wiring.test.ts)은 DB 함수를 가짜로 바꿔 끼운다.
//   그래서 src/apps/session-apps.ts 의 SQL — 뗀 행(detached_at) 거르기 · 붙인 사람 거르기 · 승계의 충돌 키 · 앱 제거가 돌려주는 세션 —
//   은 실제 Postgres 에서 돈 적이 없다. 조건 하나를 지워도 가짜 위에서는 초록이다.
//
//  ★ 워크스페이스 격리는 함수가 아니라 **행 격리 정책**이 한다 — 함수의 SQL 은 tenant_id 를 적지 않는다(ON CONFLICT 키만 예외).
//   매니지드(lvly-cloud tenantrls)와 셀프호스트 다중 워크스페이스(org/tenancy/activate.ts ensureTenantPolicies)가 둘 다
//   org_session_app · org_session_state · org_app · org_app_grant 에 `tenant_id = current_setting('app.tenant_id')` 를 건다.
//   그래서 여기서는 정책을 **실제로 켠** DB 에 앱 역할(NOSUPERUSER · NOBYPASSRLS)로 붙어 «워크스페이스 A» 컨텍스트에서 함수를 부르고,
//   같은 세션 · 앱 id 를 쓰는 «워크스페이스 B» 행이 섞이지 않는지 본다. 행은 B 쪽에 «섞이면 결과가 바뀌게» 깐다.
//   스키마 만들기와 정책 걸기는 소유자(슈퍼유저) 자식 프로세스가 한다 — 이 프로세스의 풀은 import 때 한 접속 문자열로 정해지기 때문이다.
//
//  L1 붙은 앱 목록 — 붙인 순서 · 뗀 것 · B 의 것 없음
//  A1~A5 붙이기 — 처음 · 같은 사람 다시(false) · 다른 사람(붙인 사람 교체) · 뗀 뒤 다시 · B 에 같은 (세션, 앱)이 있어도 A 에 새 행
//  D1~D3 떼기 — 붙은 것 · 이미 뗀 것 · B 는 그대로
//  W1~W4 앱이 붙은 세션 — 뗀 것 · 다른 앱 · B 제외 · 붙인 사람으로 거르기 · 없는 앱
//  B1 이 사람이 붙인 세션 — 같은 세션 둘이면 한 번 · 뗀 것 · B 제외
//  C1~C6 새 id 복원 승계 — 붙은 것만 · 붙인 사람·시각 그대로 · 옛 행 남김 · 두 번 해도 한 벌 · 이미 있는 행(붙음 · 뗌)은 그대로 ·
//        같은 id · 빈 id · B 의 행은 안 넘어오고 B 에 있는 같은 키가 A 의 승계를 막지 않는다(충돌 키에 tenant_id)
//  X1 한 번도 안 뜬 세션 행 지우기 — 붙음 · 뗌 모두 · B 그대로
//  P1 앱 제거 — 그때 «붙어 있던» 세션만(뗀 것 · 중복 없음) · 그 앱 행만 지움 · B 그대로
//  O1~O6 세션 주인(엄격) — 행 · 행 없으면 tmux 표식 · 둘 다 없으면 null · DB 오류는 던짐(느슨한 쪽은 폴백) · B 의 주인 안 줌 · 컨텍스트 없음은 던짐
//  E1~E5 세션에 들어갈 수 있나 — 주인 · 초대 · 초대 없음 · 없는 세션 · B 의 초대 안 셈
//  F1~F5 앱 폴더 판정(folderAppsFor, 실제 의존) — 켜짐·공개·동의 거르기 · 초대받은 사람이 붙인 것 · B 의 앱·동의 안 셈 · 주인 조회 오류는 던짐 · 모르는 세션 []
//  S1~S4 앱 폴더 맞춘 기록(#4786) — 넣기 · 모르는 bound 는 그대로 · 고친 횟수 · B 그대로
//  T1~T9 주기 맞추기 대상 — 붙은 기록 · 노드에 붙었다고 들은 것 · 지난 실패(한 판의 절반까지) · 30분 재확인 · 순서 · 한도 · B 제외 · 굶김 막기
//  S5 · S6 기록이 직전 값을 돌려주고 · 더 새 기록은 덮지 않는다   Q1 끝난 세션의 기록 정리
//  G1 배선 — 앱 역할이 슈퍼유저 · BYPASSRLS 가 아니고 이 시험이 쓰는 다섯 표에 FORCE RLS 와 tenant_isolation 이 있다 · 가짜 tmux 가 실제로 불렸다
import pg from "pg";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_session_apps_4788";
const ROLE = `lvly_app_${DB}`;            // org/tenancy/activate.ts appRoleName(current_database()) 과 같은 이름 — 정책이 이 역할에 걸린다
const ROLE_PW = crypto.randomBytes(16).toString("hex");
const dsnFor = (db, user) => { const u = new URL(BASE); u.pathname = "/" + db; if (user) { u.username = user.name; u.password = user.pw; } return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`DROP ROLE IF EXISTS ${ROLE}`);
const OWNER_DSN = dsnFor(DB);
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const ROOT = mkdtempSync(path.join(os.tmpdir(), "lively-session-apps-pg-"));
//  아래 finally 가 만들기부터 덮는다 — 스키마 · 정책 자식 프로세스가 실패해도 DB · 역할(클러스터 전역 LOGIN) · 임시 폴더가 남지 않게.
let dbc = null, itemsPool = null;

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const J = (x) => JSON.stringify(x);
const sorted = (a) => [...a].sort();
const same = (a, b) => J(sorted(a)) === J(sorted(b));
const iso = (d) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));
const TA = crypto.randomUUID(), TB = crypto.randomUUID();
let CUR = TA;
const inB = async (fn) => { const prev = CUR; CUR = TB; try { return await fn(); } finally { CUR = prev; } };

//  행은 소유자 접속으로 tenant_id 를 박아 깐다(정책 밖) — 시험할 함수로 시험할 행을 깔지 않는다.
const T0 = "2026-10-01T00:00:00.000Z", T1 = "2026-10-01T00:01:00.000Z", T2 = "2026-10-01T00:02:00.000Z";
const seedApp = (t, sid, app, member, at = T0, detached = null) => dbc.query(
  `INSERT INTO org_session_app(tenant_id, session_id, app_id, member_id, attached_at, detached_at) VALUES($1,$2,$3,$4,$5,$6)`, [t, sid, app, member, at, detached]);
const rowsOf = async (sid) => (await dbc.query(
  `SELECT tenant_id::text AS t, app_id, member_id, attached_at, detached_at FROM org_session_app WHERE session_id=$1 ORDER BY tenant_id, app_id`, [sid])).rows
  .map((r) => ({ t: r.t === TA ? "A" : r.t === TB ? "B" : r.t, app: r.app_id, by: r.member_id, at: iso(r.attached_at), off: iso(r.detached_at) }));
const seedSession = (t, id, owner, invites = []) => dbc.query(
  `INSERT INTO org_session_state(tenant_id, id, owner, label, dir, invites) VALUES($1,$2,$3,$2,$4,$5::jsonb)`, [t, id, owner, path.join(ROOT, "work"), J(invites)]);
const seedOrgApp = (t, id, o = {}) => dbc.query(
  `INSERT INTO org_app(tenant_id, id, title, status, enabled, visibility, owner_member) VALUES($1,$2,$2,$3,$4,$5,$6)`,
  [t, id, o.status ?? "active", o.enabled ?? true, o.visibility ?? "all", o.owner ?? null]);
const seedGrant = (t, app, member, revoked = false) => dbc.query(
  `INSERT INTO org_app_grant(tenant_id, app_id, member_id, revoked_at) VALUES($1,$2,$3,$4)`, [t, app, member, revoked ? T1 : null]);

// ── 가짜 tmux — «DB 에 행이 없으면 tmux 의 @box_owner» 폴백을 실제로 태운다(불린 argv 를 적는다) ──
const TMUX_LOG = path.join(ROOT, "tmux.log");
const TMUX_SID = "box-pgt-tmux-0000abcd";
const FAKE_TMUX = path.join(ROOT, "fake-tmux.sh");
writeFileSync(FAKE_TMUX, `#!/bin/sh
echo "$*" >> "${TMUX_LOG}"
case "$*" in
  *"-t ${TMUX_SID} "*"@box_owner"*) echo "pgt-tmux-owner"; exit 0 ;;
esac
echo "can't find session: fake" >&2
exit 1
`);
chmodSync(FAKE_TMUX, 0o755);

try {
  await su.query(`CREATE DATABASE ${DB}`);
  await su.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  dbc = new pg.Client({ connectionString: OWNER_DSN }); await dbc.connect();     // 소유자(슈퍼유저) — 행 깔기 · 결과 대조(모든 워크스페이스를 본다)
  await dbc.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => { /* pgvector 없는 로컬 PG — 렉시컬 폴백 */ });

  // ── 스키마 + 행 격리 정책 — 소유자 자식 프로세스(이 프로세스의 풀은 앱 역할로 붙어야 한다) ──
  const childEnv = { ...process.env, ITEMS_DATABASE_URL: OWNER_DSN };
  for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "LIVELY_TENANT_BINDING", "LIVELY_TENANT_ID"]) delete childEnv[k];
  const policyOut = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { initAllSchemas } = await import(${JSON.stringify(`${D}/boot/schemas.js`)});
    await initAllSchemas({ quiet: true });
    const { ensureTenantPolicies } = await import(${JSON.stringify(`${D}/org/tenancy/activate.js`)});
    const r = await ensureTenantPolicies();
    const { itemsPool } = await import(${JSON.stringify(`${D}/db/client.js`)});
    await itemsPool.end();
    process.stdout.write("\\n@@policies " + JSON.stringify(r) + "\\n");
    process.exit(0);`], { env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 300_000 });
  //  스키마 초기화가 표준출력에 로그를 남긴다 — 표식 줄만 읽는다.
  const policies = (() => { try { return JSON.parse(/^@@policies (.+)$/m.exec(policyOut)?.[1] ?? "null"); } catch { return null; } })();
  await dbc.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await dbc.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  await dbc.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);

  // 이 프로세스는 앱 역할로 — 정책이 걸리는 자리(매니지드 게이트웨이와 같은 조건). 테넌트는 위 CUR 이 정한다.
  process.env.TMUX_BIN = FAKE_TMUX;
  process.env.ITEMS_DATABASE_URL = dsnFor(DB, { name: ROLE, pw: ROLE_PW });
  const client = await import(`${D}/db/client.js`);
  itemsPool = client.itemsPool;
  client.installTenantResolver(() => CUR);
  const SA = await import(`${D}/apps/session-apps.js`);
  const { folderAppsFor } = await import(`${D}/apps/session-app-folders.js`);
  const { getApp } = await import(`${D}/org/store/apps.js`);

  chk("G0 스키마 · 정책 자식 프로세스가 콘텐츠 표에 정책을 걸었다", Number(policies?.tables) > 0, policyOut.slice(-300));

  // ── G1 배선 — 아래 격리 시험들이 장식이 아니려면 ──
  const role = (await itemsPool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
  const ISOLATED = ["org_session_app", "org_session_state", "org_app", "org_app_grant", "org_session_app_folder"];
  const relOf = async (t) => ({
    t, ...(await dbc.query(`SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE relname=$1 AND relkind='r'`, [t])).rows[0],
    pols: (await dbc.query(`SELECT polname FROM pg_policy WHERE polrelid=$1::regclass`, [t])).rows.map((r) => r.polname),
  });
  const rels = await Promise.all(ISOLATED.map(relOf));
  chk("G1 앱 역할은 슈퍼유저 · BYPASSRLS 가 아니고, 이 시험이 쓰는 다섯 표 모두 FORCE RLS · tenant_isolation 정책",
    role && role.rolsuper === false && role.rolbypassrls === false && rels.every((r) => r.on === true && r.forced === true && r.pols.includes("tenant_isolation")), J({ role, rels }));

  // ── L1 ──
  const L = "box-pgt-l1-0000aa01";
  await seedApp(TA, L, "crm", "pgt-alice", T1);
  await seedApp(TA, L, "memo", "pgt-alice", T0);
  await seedApp(TA, L, "gone", "pgt-alice", T0, T1);
  await seedApp(TB, L, "b-only", "pgt-bob", T0);
  const l1 = await SA.listAttachedApps(L);
  chk("L1 붙은 앱 목록 — 붙인 순서(memo → crm) · 뗀 것 없음 · B 의 것 없음 · 붙인 사람 · 시각 그대로",
    J(l1.map((r) => [r.app_id, r.member_id, r.attached_at])) === J([["memo", "pgt-alice", T0], ["crm", "pgt-alice", T1]]), J(l1));

  // ── A1~A5 ──
  const A = "box-pgt-a1-0000aa02";
  const a1 = await SA.attachAppRow(A, "crm", "pgt-alice");
  const a1rows = await rowsOf(A);
  const a2 = await SA.attachAppRow(A, "crm", "pgt-alice");
  const a2rows = await rowsOf(A);
  chk("A1 처음 붙이면 true · A 에 붙은 행 하나", a1 === true && a1rows.length === 1 && a1rows[0].t === "A" && a1rows[0].by === "pgt-alice" && a1rows[0].off === null, J({ a1, a1rows }));
  chk("A2 같은 사람이 다시 붙이면 false · 붙인 시각 그대로", a2 === false && a2rows.length === 1 && a2rows[0].at === a1rows[0].at, J({ a2, a2rows }));
  const a3 = await SA.attachAppRow(A, "crm", "pgt-carol");
  const a3rows = await rowsOf(A);
  chk("A3 다른 사람이 다시 붙이면 true · 붙인 사람이 그 사람으로", a3 === true && a3rows.length === 1 && a3rows[0].by === "pgt-carol" && a3rows[0].off === null, J({ a3, a3rows }));
  await dbc.query(`UPDATE org_session_app SET detached_at=$2 WHERE session_id=$1`, [A, T2]);
  const a4 = await SA.attachAppRow(A, "crm", "pgt-carol");
  const a4rows = await rowsOf(A);
  chk("A4 뗀 뒤 다시 붙이면 true · detached_at 비움", a4 === true && a4rows.length === 1 && a4rows[0].off === null, J({ a4, a4rows }));
  const A5 = "box-pgt-a5-0000aa03";
  await seedApp(TB, A5, "crm", "pgt-bob", T0);
  const a5 = await SA.attachAppRow(A5, "crm", "pgt-alice");
  const a5rows = await rowsOf(A5);
  const a5A = a5rows.filter((r) => r.t === "A"), a5B = a5rows.filter((r) => r.t === "B");
  chk("A5 B 에 같은 (세션, 앱)이 붙어 있어도 A 에 새 행(true · tenant_id=A) · B 행은 붙인 사람 · 붙음 그대로",
    a5 === true && a5rows.length === 2 && a5A.length === 1 && a5A[0].by === "pgt-alice" && a5A[0].off === null
      && a5B.length === 1 && a5B[0].by === "pgt-bob" && a5B[0].off === null, J({ a5, a5rows }));

  // ── D1~D3 ──
  const d1 = await SA.detachAppRow(A5, "crm");
  const d2 = await SA.detachAppRow(A5, "crm");
  const d3rows = await rowsOf(A5);
  chk("D1 붙은 것을 떼면 true", d1 === true, String(d1));
  chk("D2 이미 뗀 것은 false", d2 === false, String(d2));
  chk("D3 A 에서 뗐다 — A 행만 detached_at · B 행은 그대로 붙음",
    d3rows.find((r) => r.t === "A")?.off !== null && d3rows.find((r) => r.t === "B")?.off === null, J(d3rows));

  // ── W1~W4 ──
  const W = (n) => `box-pgt-w${n}-0000bb0${n}`;
  await seedApp(TA, W(1), "crm", "pgt-m1");
  await seedApp(TA, W(2), "crm", "pgt-m2");
  await seedApp(TA, W(3), "crm", "pgt-m1", T0, T1);           // 뗌
  await seedApp(TA, W(4), "memo", "pgt-m1");                  // 다른 앱
  await seedApp(TB, W(5), "crm", "pgt-m1");                   // B
  await seedApp(TB, W(6), "crm", "pgt-b-only");               // B 에서만 붙인 사람
  const w1 = await SA.sessionsWithApp("crm");
  const w2 = await SA.sessionsWithApp("crm", "pgt-m1");
  const w3 = await SA.sessionsWithApp("crm", "pgt-b-only");
  const w4 = await SA.sessionsWithApp("no-such-app");
  //  앞 절(L1 · A · D)의 crm 행도 A 에 있다 — 지금 붙은 것만 센다(A 의 crm 은 붙음 · A5 의 crm 은 뗌).
  chk("W1 앱이 붙은 세션 — 붙은 것만 · 다른 앱 · B 제외", same(w1, [L, A, W(1), W(2)]), J(w1));
  chk("W2 붙인 사람으로 거르기 — m1 이 붙인 것만(뗀 것 · 다른 앱 · B 제외)", same(w2, [W(1)]), J(w2));
  chk("W3 B 에서만 붙인 사람이면 []", w3.length === 0, J(w3));
  chk("W4 없는 앱이면 []", w4.length === 0, J(w4));

  // ── B1 ──
  const Bs = (n) => `box-pgt-b${n}-0000cc0${n}`;
  await seedApp(TA, Bs(1), "crm", "pgt-by");
  await seedApp(TA, Bs(1), "memo", "pgt-by");                 // 같은 세션 둘
  await seedApp(TA, Bs(2), "crm", "pgt-by");
  await seedApp(TA, Bs(3), "crm", "pgt-by", T0, T1);          // 뗌
  await seedApp(TA, Bs(4), "crm", "pgt-other");               // 남이 붙임
  await seedApp(TB, Bs(5), "crm", "pgt-by");                  // B
  const b1 = await SA.sessionsAttachedBy("pgt-by");
  chk("B1 이 사람이 붙인 세션 — 같은 세션은 한 번 · 뗀 것 · 남이 붙인 것 · B 제외", J(sorted(b1)) === J(sorted([Bs(1), Bs(2)])), J(b1));

  // ── C1~C6 ──
  const CF = "box-pgt-cf-0000dd01", CT = "box-pgt-ct-0000dd02";
  await seedApp(TA, CF, "crm", "pgt-m1", T0);
  await seedApp(TA, CF, "memo", "pgt-m2", T1);
  await seedApp(TA, CF, "gone", "pgt-m1", T0, T1);            // 뗌 — 넘기지 않는다
  await seedApp(TB, CF, "b-carry", "pgt-bob", T0);            // B 의 옛 세션 — A 승계에 오면 안 된다
  await seedApp(TB, CT, "crm", "pgt-bob", T0);                // B 의 새 세션에 같은 키 — A 승계를 막으면 안 된다
  const c1 = await SA.carrySessionApps(CF, CT);
  const ct1 = await rowsOf(CT);
  const cf1 = await rowsOf(CF);
  chk("C1 붙은 것만 넘긴다 — 2 · 붙인 사람 · 시각 그대로 · 뗀 것 없음 · 새 행은 A",
    c1 === 2 && J(ct1.filter((r) => r.t === "A").map((r) => [r.app, r.by, r.at, r.off])) === J([["crm", "pgt-m1", T0, null], ["memo", "pgt-m2", T1, null]]), J({ c1, ct1 }));
  chk("C1b 옛 세션 행은 그대로 남는다(승계가 실패해 옛 id 를 다시 복원할 재료)", cf1.filter((r) => r.t === "A").length === 3, J(cf1));
  chk("C6 B 의 옛 세션 행은 넘어오지 않고 · B 에 있는 같은 키(새 세션 crm)가 A 의 승계를 막지 않는다 · B 행 그대로",
    !ct1.some((r) => r.app === "b-carry") && ct1.some((r) => r.t === "A" && r.app === "crm") && J(ct1.filter((r) => r.t === "B").map((r) => [r.app, r.by])) === J([["crm", "pgt-bob"]]), J(ct1));
  const c2 = await SA.carrySessionApps(CF, CT);
  const ct2 = await rowsOf(CT);
  chk("C2 두 번 승계해도 한 벌 — 0 · 행 수 그대로", c2 === 0 && ct2.length === ct1.length, J({ c2, ct2 }));
  const CF3 = "box-pgt-cf3-0000dd03", CT3 = "box-pgt-ct3-0000dd04";
  await seedApp(TA, CF3, "crm", "pgt-m1", T0);
  await seedApp(TA, CF3, "memo", "pgt-m1", T0);
  await seedApp(TA, CF3, "note", "pgt-m1", T0);
  await seedApp(TA, CT3, "crm", "pgt-m9", T2);                // 새 세션에 이미 붙은 것
  await seedApp(TA, CT3, "memo", "pgt-m9", T1, T2);           // 새 세션에서 이미 뗀 것
  const c3 = await SA.carrySessionApps(CF3, CT3);
  const ct3 = await rowsOf(CT3);
  chk("C3 새 세션에 이미 붙은 행은 그대로(붙인 사람 m9 · 시각) · 반환 수에서 빠진다",
    c3 === 1 && J(ct3.find((r) => r.app === "crm")) === J({ t: "A", app: "crm", by: "pgt-m9", at: T2, off: null }), J({ c3, ct3 }));
  chk("C4 새 세션에서 이미 뗀 행은 되살리지 않는다 · 없던 것(note)만 새로",
    ct3.find((r) => r.app === "memo")?.off === T2 && ct3.find((r) => r.app === "note")?.by === "pgt-m1", J(ct3));
  const before5 = (await dbc.query(`SELECT count(*)::int AS n FROM org_session_app`)).rows[0].n;
  const c5 = [await SA.carrySessionApps(CF, CF), await SA.carrySessionApps("", CT), await SA.carrySessionApps(CF, "")];
  const after5 = (await dbc.query(`SELECT count(*)::int AS n FROM org_session_app`)).rows[0].n;
  chk("C5 같은 id · 빈 id 는 0 · 행 변화 없음", J(c5) === J([0, 0, 0]) && before5 === after5, J({ c5, before5, after5 }));

  // ── X1 ──
  const X = "box-pgt-x1-0000ee01";
  await seedApp(TA, X, "crm", "pgt-m1");
  await seedApp(TA, X, "memo", "pgt-m1", T0, T1);             // 뗀 것도 지운다
  await seedApp(TB, X, "crm", "pgt-bob");
  const x1 = await SA.dropSessionApps(X);
  const xRows = await rowsOf(X);
  const ctAfterX = await rowsOf(CT);
  chk("X1 A 의 그 세션 행을 붙음 · 뗌 모두 지운다(2) · 다른 세션 그대로 · B 그대로",
    x1 === 2 && J(xRows.map((r) => [r.t, r.app])) === J([["B", "crm"]]) && ctAfterX.length === ct2.length, J({ x1, xRows }));

  // ── P1 ──
  const P = (n) => `box-pgt-p${n}-0000ff0${n}`;
  await seedApp(TA, P(1), "prune-me", "pgt-m1");
  await seedApp(TA, P(1), "keep-me", "pgt-m1");
  await seedApp(TA, P(2), "prune-me", "pgt-m2");
  await seedApp(TA, P(3), "prune-me", "pgt-m1", T0, T1);      // 뗌 — 돌려주지 않는다
  await seedApp(TB, P(5), "prune-me", "pgt-bob");             // B
  const p1 = await SA.pruneSessionApps("prune-me");
  const left = (await dbc.query(`SELECT tenant_id::text AS t, session_id, app_id FROM org_session_app WHERE app_id IN ('prune-me','keep-me') ORDER BY session_id, app_id`)).rows
    .map((r) => [r.t === TA ? "A" : "B", r.session_id, r.app_id]);
  chk("P1 앱 제거 — 그때 붙어 있던 세션만(뗀 것 · 중복 없음 · B 제외)", J(sorted(p1)) === J(sorted([P(1), P(2)])) && p1.length === 2, J(p1));
  chk("P1b 그 앱 행만 지운다(뗀 행 포함) — 같은 세션의 다른 앱 · B 의 행 그대로",
    J(left) === J([["A", P(1), "keep-me"], ["B", P(5), "prune-me"]]), J(left));

  // ── O1~O6 ──
  const O1 = "box-pgt-o1-00001101", O5 = "box-pgt-o5-00001105";
  await seedSession(TA, O1, "pgt-alice");
  await seedSession(TB, O5, "pgt-bob");
  chk("O1 세션 행이 있으면 그 주인", (await SA.sessionOwnerStrict(O1)) === "pgt-alice");
  chk("O2 행이 없으면 tmux 의 @box_owner", (await SA.sessionOwnerStrict(TMUX_SID)) === "pgt-tmux-owner");
  chk("O3 행도 tmux 표식도 없으면 null", (await SA.sessionOwnerStrict("box-pgt-none-00001103")) === null);
  chk("O5 B 에만 있는 세션 행의 주인을 A 에서 주지 않는다", (await SA.sessionOwnerStrict(O5)) === null && (await inB(() => SA.sessionOwnerStrict(O5))) === "pgt-bob");
  await dbc.query(`REVOKE SELECT ON org_session_state FROM ${ROLE}`);
  const o4 = await errOf(SA.sessionOwnerStrict(O1));
  const o4loose = await errOf(SA.sessionOwnerOf(TMUX_SID));
  const o4looseVal = await SA.sessionOwnerOf(TMUX_SID).catch(() => "threw");
  const f4 = await errOf(folderAppsFor(O1));
  await dbc.query(`GRANT SELECT ON org_session_state TO ${ROLE}`);
  chk("O4 DB 조회 오류는 던진다(«주인 없음» 으로 접지 않는다) · 느슨한 sessionOwnerOf 는 던지지 않고 tmux 로 폴백",
    o4 !== null && /permission denied/i.test(String(o4?.message)) && o4loose === null && o4looseVal === "pgt-tmux-owner", J({ o4: o4?.message, o4loose: o4loose?.message, o4looseVal }));
  chk("F4 앱 폴더 판정 — 주인 조회 오류면 던진다([] 를 돌려 «모두 떼기» 를 보내지 않게)", f4 !== null && /permission denied/i.test(String(f4?.message)), String(f4));
  CUR = null;
  const o6 = await errOf(SA.sessionOwnerStrict(O1));
  CUR = TA;
  chk("O6 테넌트 컨텍스트가 빠진 경로면 던진다(정책이 막는다 — 남의 행도 «없음» 도 아니다)", o6 !== null && /uuid|app\.tenant_id/i.test(String(o6?.message)), String(o6));

  // ── E1~E5 ──
  const E = "box-pgt-e1-00002201", E5 = "box-pgt-e5-00002205";
  await seedSession(TA, E, "pgt-alice", ["pgt-guest"]);
  await seedSession(TB, E5, "pgt-bob", ["pgt-guest"]);        // A 엔 이 id 행이 없다
  chk("E1 주인은 들어간다", (await SA.sessionCanEnter(E, "pgt-alice")) === true);
  chk("E2 초대받은 사람은 들어간다", (await SA.sessionCanEnter(E, "pgt-guest")) === true);
  chk("E3 초대받지 않은 사람은 못 들어간다", (await SA.sessionCanEnter(E, "pgt-stranger")) === false);
  chk("E4 없는 세션엔 못 들어간다", (await SA.sessionCanEnter("box-pgt-nosuch-00002204", "pgt-alice")) === false);
  chk("E5 B 의 같은 id 세션 초대를 A 에서 세지 않는다", (await SA.sessionCanEnter(E5, "pgt-guest")) === false && (await inB(() => SA.sessionCanEnter(E5, "pgt-guest"))) === true);

  // ── F1~F5 — folderAppsFor 실제 의존(listAttachedApps · getApp · getActiveGrant · sessionOwnerStrict · sessionCanEnter) ──
  const F = "box-pgt-f1-00003301";
  await seedSession(TA, F, "pgt-alice", ["pgt-guest"]);
  //  B 의 같은 id 앱을 A 보다 **먼저** 깐다 — 정책이 새면 `SELECT … WHERE id=$1` 의 첫 행이 B 의 것이 되어 아래 F1 · F3 이 바뀐다.
  await seedOrgApp(TB, "f-off");
  await seedOrgApp(TB, "f-revoked");
  await seedOrgApp(TB, "f-b-only");
  await seedOrgApp(TA, "f-ok");
  await seedOrgApp(TA, "f-off", { enabled: false });
  await seedOrgApp(TA, "f-mine", { visibility: "me", owner: "pgt-bob" });     // 남(bob)의 «나만» — 주인 alice 가 못 본다
  await seedOrgApp(TA, "f-revoked");
  await seedOrgApp(TA, "f-guest");
  for (const a of ["f-ok", "f-off", "f-mine"]) await seedGrant(TA, a, "pgt-alice");
  await seedGrant(TA, "f-revoked", "pgt-alice", true);
  await seedGrant(TA, "f-guest", "pgt-guest");
  for (const a of ["f-ok", "f-off", "f-mine", "f-revoked"]) await seedApp(TA, F, a, "pgt-alice");
  await seedApp(TA, F, "f-guest", "pgt-guest");
  //  B — 같은 세션 id · 같은 앱 id 를 «섞이면 결과가 바뀌게» 깐다: A 에서 꺼진 f-off 가 B 에선 켜짐 · A 에서 거둔 동의가 B 에선 살아 있음 · B 에만 붙은 앱.
  await seedSession(TB, F, "pgt-alice");
  for (const a of ["f-off", "f-revoked", "f-b-only"]) await seedGrant(TB, a, "pgt-alice");
  await seedApp(TB, F, "f-b-only", "pgt-alice");
  const f1 = await folderAppsFor(F);
  chk("F1 켜짐 · 주인이 볼 수 있음 · 붙인 사람 동의 — 꺼진 앱 · 남의 «나만» 앱 · 동의 거둔 앱은 빠진다", same(f1, ["f-ok", "f-guest"]), J(f1));
  chk("F3 B 의 앱 · 동의 · 붙은 기록을 A 의 판정에 쓰지 않는다(B 에선 f-off 켜짐 · f-revoked 동의 · f-b-only 붙음)",
    !f1.includes("f-off") && !f1.includes("f-revoked") && !f1.includes("f-b-only") && same(await inB(() => folderAppsFor(F)), ["f-b-only"]), J(f1));
  const onlyB = await getApp("f-b-only"), offA = await getApp("f-off"), offB = await inB(() => getApp("f-off"));
  chk("F3b 앱 표의 격리(쌓인 순서와 무관) — B 에만 있는 앱은 A 에서 없고 B 에서 보인다 · 같은 id 는 각자 제 행(A 꺼짐 · B 켜짐)",
    onlyB === null && (await inB(() => getApp("f-b-only")))?.id === "f-b-only" && offA?.enabled === false && offB?.enabled === true,
    J({ onlyB, offA: offA?.enabled, offB: offB?.enabled }));
  await dbc.query(`UPDATE org_session_state SET invites='[]'::jsonb WHERE tenant_id=$1 AND id=$2`, [TA, F]);
  const f2 = await folderAppsFor(F);
  chk("F2 초대받은 사람이 붙인 앱은 그 사람이 세션 밖이 되면 빠진다", same(f2, ["f-ok"]), J(f2));
  const f5 = await folderAppsFor("box-pgt-unknown-00003305");
  chk("F5 세션 행도 tmux 표식도 없으면 []", J(f5) === "[]", J(f5));

  // ── S — 앱 폴더 맞춘 기록 · 고친 횟수 · 주기 대상 · 정리(#4786) — 앞 절의 행과 섞이지 않게 워크스페이스 C 에서 ──
  const TC = crypto.randomUUID();
  const inC = async (fn) => { const prev = CUR; CUR = TC; try { return await fn(); } finally { CUR = prev; } };
  const seedFolder = (t, sid, bound, state, agoMin) => dbc.query(
    `INSERT INTO org_session_app_folder(tenant_id, session_id, bound, state, checked_at) VALUES($1,$2,$3::jsonb,$4, now() - ($5::int * interval '1 minute'))`,
    [t, sid, J(bound), state, agoMin]);
  const folderRows = async (sid) => (await dbc.query(
    `SELECT tenant_id::text AS t, bound, state, detail, fixed_count, last_fixed_at FROM org_session_app_folder WHERE session_id=$1 ORDER BY tenant_id`, [sid])).rows
    .map((r) => ({ t: r.t === TC ? "C" : r.t === TB ? "B" : r.t === TA ? "A" : r.t, bound: r.bound, state: r.state, detail: r.detail, fixed: r.fixed_count, fixedAt: r.last_fixed_at }));
  const S = (n) => `box-pgt-s-${n}-4786`.replace(/-4786$/, "-00004786");

  //  S1~S3 기록 — 넣기 · bound 모름(null)은 지난 bound 그대로 · 사유 300자 · B 의 같은 세션 행은 그대로
  const SR = S("rec");
  await seedSession(TC, SR, "pgt-alice");
  await seedFolder(TB, SR, ["b-app"], "ok", 0);
  await inC(() => SA.recordAppFolderSync(SR, { bound: ["crm"], state: "ok" }));
  const s1 = await folderRows(SR);
  await inC(() => SA.recordAppFolderSync(SR, { bound: null, state: "error", detail: "허브 503 ".repeat(100) }));
  const s2 = await folderRows(SR);
  await inC(() => SA.recordAppFolderSync(SR, { bound: [], state: "not-running" }));
  const s3 = await folderRows(SR);
  const cOf = (rows) => rows.find((r) => r.t === "C"), bOf = (rows) => rows.find((r) => r.t === "B");
  chk("S1 기록을 넣는다(워크스페이스 C) — B 의 같은 세션 행은 그대로", J([cOf(s1)?.bound, cOf(s1)?.state]) === J([["crm"], "ok"]) && J(bOf(s1)?.bound) === J(["b-app"]), J(s1));
  chk("S2 bound 를 모르면(null) 지난 bound 그대로 · 상태 · 사유(300자)만 바뀐다",
    J(cOf(s2)?.bound) === J(["crm"]) && cOf(s2)?.state === "error" && String(cOf(s2)?.detail).length === 300, J(cOf(s2)));
  chk("S3 컨테이너 없음이면 bound [] · B 그대로", J(cOf(s3)?.bound) === "[]" && cOf(s3)?.state === "not-running" && bOf(s3)?.state === "ok", J(s3));

  //  S4 고친 횟수 — C 의 행만 · 기록 없는 세션은 행을 만들지 않는다
  await inC(() => SA.markAppFolderFixed(SR));
  await inC(() => SA.markAppFolderFixed(SR));
  await inC(() => SA.markAppFolderFixed(S("norec")));
  const s4 = await folderRows(SR);
  const s4none = await folderRows(S("norec"));
  chk("S4 고친 횟수는 C 의 그 행만 올린다(2 · 시각) · 기록 없는 세션엔 행을 만들지 않는다",
    cOf(s4)?.fixed === 2 && cOf(s4)?.fixedAt != null && bOf(s4)?.fixed === 0 && s4none.length === 0, J({ s4, s4none }));

  //  T1~T8 주기 대상
  const T = {
    live: S("t1"), bound: S("t2"), err: S("t3e"), failed: S("t3f"), oldLong: S("t3ol"), oldNew: S("t3on"), okEmpty: S("t4"), detached: S("t4d"),
    exited: S("t5x"), superseded: S("t5s"), node: S("t5n"), nrNew: S("t6a"), nrOld: S("t6b"), unsNew: S("t6c"),
  };
  for (const id of Object.values(T)) await seedSession(TC, id, "pgt-alice");
  await dbc.query(`UPDATE org_session_state SET exited_at=now() WHERE tenant_id=$1 AND id=$2`, [TC, T.exited]);
  await dbc.query(`UPDATE org_session_state SET superseded_by='box-pgt-next-00004786' WHERE tenant_id=$1 AND id=$2`, [TC, T.superseded]);
  await dbc.query(`UPDATE org_session_state SET node_id='node-1' WHERE tenant_id=$1 AND id=$2`, [TC, T.node]);
  for (const id of [T.live, T.exited, T.superseded, T.node, T.nrNew, T.nrOld, T.unsNew]) await seedApp(TC, id, "crm", "pgt-alice");
  await seedApp(TC, T.detached, "crm", "pgt-alice", T0, T1);            // 뗀 기록만
  await seedFolder(TC, T.bound, ["memo"], "ok", 10);                    // 붙은 기록은 없는데 노드엔 붙어 있다고 들었다(앱 제거 · 떼기 실패)
  await seedFolder(TC, T.err, [], "error", 5);
  await seedFolder(TC, T.failed, ["crm"], "failed", 1);
  await seedFolder(TC, T.oldLong, [], "old-broker", 70);
  await seedFolder(TC, T.oldNew, [], "old-broker", 1);
  await seedFolder(TC, T.okEmpty, [], "ok", 2);
  await seedFolder(TC, T.nrNew, [], "not-running", 5);
  await seedFolder(TC, T.nrOld, [], "not-running", 65);
  await seedFolder(TC, T.unsNew, [], "unsupported", 5);
  //  B — C 에서 대상이 아닌 세션 id 에 붙은 기록 · 비어 있지 않은 기록을 깐다(섞이면 C 의 대상에 끼어든다).
  await seedSession(TB, T.okEmpty, "pgt-bob");
  await seedApp(TB, T.okEmpty, "crm", "pgt-bob");
  await seedSession(TB, T.detached, "pgt-bob");
  await seedFolder(TB, T.detached, ["crm"], "ok", 0);
  const RECHECK = 30 * 60_000;
  const tg = await inC(() => SA.appFolderSyncTargets(50, RECHECK));
  const ids = tg.map((x) => x.session_id);
  chk("T1~T6 대상 — 붙은 기록 · 노드에 붙었다고 들은 것 · 지난 실패 · 30분 지난 컨테이너 없음/옛 브로커만(끝난 · 이어진 · 노드 세션 · 뗀 기록만 · ok [] · 30분 안의 not-running/unsupported/old-broker 제외)",
    same(ids, [T.live, T.bound, T.err, T.failed, T.oldLong, T.nrOld]), J(ids));
  chk("T7 순서 — 실패(error · failed, 오래된 것부터) → 한 번도 안 본 것 → 오래 안 본 것", J(ids) === J([T.err, T.failed, T.live, T.oldLong, T.nrOld, T.bound]), J(ids));
  const tPrev = Object.fromEntries(tg.map((x) => [x.session_id, x.prev]));
  chk("T7b 지난 기록을 같이 준다(없으면 null)", tPrev[T.live] === null && J(tPrev[T.bound]?.bound) === J(["memo"]) && tPrev[T.bound]?.state === "ok", J(tPrev));
  const tg2 = await inC(() => SA.appFolderSyncTargets(2, RECHECK));
  chk("T7c 한도 2 — 실패는 절반(1)까지 · 나머지는 안 본 것", J(tg2.map((x) => x.session_id)) === J([T.err, T.live]), J(tg2));
  chk("T8 B 의 붙은 기록 · 맞춘 기록이 C 의 대상에 끼어들지 않는다", !ids.includes(T.okEmpty) && !ids.includes(T.detached), J(ids));

  //  T9 굶김 막기(#4786 검토) — 계속 실패하는 세션 60개 + 아직 안 본 산 세션 5개(워크스페이스 D — 앞 절과 섞이지 않게).
  const TD = crypto.randomUUID();
  const inD = async (fn) => { const prev = CUR; CUR = TD; try { return await fn(); } finally { CUR = prev; } };
  const bads = Array.from({ length: 60 }, (_, i) => `box-pgt-bad${String(i).padStart(2, "0")}-00009${String(i).padStart(3, "0")}`);
  const goods = Array.from({ length: 5 }, (_, i) => `box-pgt-good${i}-0000a00${i}`);
  for (const [i, id] of bads.entries()) { await seedSession(TD, id, "pgt-alice"); await seedFolder(TD, id, [], "error", 100 - i); }
  for (const id of goods) { await seedSession(TD, id, "pgt-alice"); await seedApp(TD, id, "crm", "pgt-alice"); }
  const t9 = (await inD(() => SA.appFolderSyncTargets(50, RECHECK))).map((x) => x.session_id);
  chk("T9 계속 실패하는 세션이 한도를 다 차지하지 않는다 — 실패는 앞 25개(오래된 것부터) · 산 세션 5개는 모두 · 남는 자리를 실패가 채운다",
    t9.length === 50 && goods.every((g) => t9.includes(g)) && J(t9.slice(0, 25)) === J(bads.slice(0, 25)) && J(t9.slice(25, 30)) === J([...goods].sort()),
    J({ n: t9.length, head: t9.slice(0, 3), mid: t9.slice(24, 31) }));

  //  S5 · S6 — 기록은 쓰기 직전의 값을 같은 문장에서 돌려주고(«고침» 의 기준), «이 시각보다 새 기록» 은 덮지 않는다(만든 뒤 기록).
  const SX = S("rx");
  await seedSession(TC, SX, "pgt-alice");
  const rw1 = await inC(() => SA.recordAppFolderSync(SX, { bound: ["crm"], state: "ok" }, { at: 2_000_000_000_000 }));
  const rw2 = await inC(() => SA.recordAppFolderSync(SX, { bound: [], state: "failed", detail: "x" }, { at: 2_000_000_001_000 }));
  chk("S5 기록이 쓰기 직전의 값을 돌려준다 — 처음은 null · 다음은 앞 기록(bound · state)",
    rw1.written === true && rw1.prev === null && rw2.written === true && J(rw2.prev) === J({ bound: ["crm"], state: "ok" }), J({ rw1, rw2 }));
  const rw3 = await inC(() => SA.recordAppFolderSync(SX, { bound: ["stale"], state: "ok" }, { at: 2_000_000_002_000, ifOlderThan: 2_000_000_000_500 }));
  const afterRw3 = cOf(await folderRows(SX));
  const rw4 = await inC(() => SA.recordAppFolderSync(SX, { bound: ["fresh"], state: "ok" }, { at: 2_000_000_003_000, ifOlderThan: 2_000_000_002_500 }));
  const afterRw4 = cOf(await folderRows(SX));
  chk("S6 «이 시각보다 새 기록» 은 덮지 않는다(쓰지 않았다고 말한다) · 그보다 오래된 기록이면 덮는다",
    rw3.written === false && afterRw3?.state === "failed" && J(afterRw3?.bound) === "[]" && rw4.written === true && J(afterRw4?.bound) === J(["fresh"]),
    J({ rw3, afterRw3, rw4, afterRw4 }));

  //  Q1 정리 — 끝났거나 이어졌거나 세션 행이 없는 세션의 기록만(C) · B 그대로
  await seedFolder(TC, T.exited, ["crm"], "ok", 0);
  await seedFolder(TC, T.superseded, ["crm"], "ok", 0);
  await seedFolder(TC, S("p-norow"), ["crm"], "ok", 0);
  await seedFolder(TB, S("p-norow"), ["crm"], "ok", 0);
  const p1n = await inC(() => SA.pruneAppFolderSyncRecords());
  const leftC = (await dbc.query(`SELECT session_id FROM org_session_app_folder WHERE tenant_id=$1 ORDER BY session_id`, [TC])).rows.map((r) => r.session_id);
  const leftB = (await dbc.query(`SELECT session_id FROM org_session_app_folder WHERE tenant_id=$1 AND session_id=$2`, [TB, S("p-norow")])).rows.length;
  chk("Q1 끝난 · 이어진 · 세션 행 없는 세션의 기록만 지운다(3) · 산 세션의 기록 · B 의 기록은 그대로",
    p1n === 3 && !leftC.includes(T.exited) && !leftC.includes(T.superseded) && !leftC.includes(S("p-norow")) && leftC.includes(T.bound) && leftC.includes(SR) && leftB === 1,
    J({ p1n, leftC, leftB }));

  // ── G1b — 가짜 tmux 가 실제로 불렸다(O2 · O4 · F5 의 폴백이 장식이 아니다) ──
  const tmuxLog = existsSync(TMUX_LOG) ? readFileSync(TMUX_LOG, "utf8") : "";
  chk("G1b 가짜 tmux 가 실제로 불렸다(show-options @box_owner)", new RegExp(`show-options .*-t ${TMUX_SID} .*@box_owner`).test(tmuxLog), tmuxLog.slice(0, 300));
} catch (e) {
  fail++; console.error("FAIL (예외)", e);
} finally {
  if (itemsPool) await itemsPool.end().catch(() => {});
  if (dbc) await dbc.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  await su.end();
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

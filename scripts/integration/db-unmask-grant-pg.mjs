// P4(#746) raw-PII 언마스크 grant 통합 검증 — 실 Postgres 로 grant→해소→정책반영→감사→회수 전 경로.
//  단위테스트로는 policy 스냅샷(refreshPolicy=DB 의존) 주입이 어려워, 이 경로는 실 pg 로만 의미있게 검증된다.
//
// 실행: npm run build && ITEMS_DATABASE_URL='postgresql://postgres@localhost/audit_test?host=/tmp/pgXXX&port=54329' \
//        node scripts/integration/db-unmask-grant-pg.mjs   (스크래치 DB 필수 — 운영 금지)
import { fileURLToPath } from "node:url";
import path from "node:path";

if (!process.env.ITEMS_DATABASE_URL) {
  console.error("ITEMS_DATABASE_URL 미설정 — 스크래치 pg 를 가리키게 하고 다시 실행하세요(운영 DB 금지)");
  process.exit(2);
}
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
const { initOrgSchema } = await import(path.join(DIST, "org/schema.js"));
const { itemsPool } = await import(path.join(DIST, "items/store.js"));
const store = await import(path.join(DIST, "org/store.js"));
const policy = await import(path.join(DIST, "db/policy.js"));

const SRC = "prod";
let step = "";
const ok = (m) => console.log("ok  " + m);
try {
  step = "① initOrgSchema + 마스킹 컬럼 2개 심기(users.ssn·users.name)";
  await initOrgSchema();
  await store.upsertColumnMask({ source: SRC, table_name: "users", column_name: "ssn", style: "full" }, "test");
  await store.upsertColumnMask({ source: SRC, table_name: "users", column_name: "name", style: "partial" }, "test");
  await policy.refreshPolicy(true);
  ok(step);

  step = "② 기본(grant 없음) — 두 컬럼 모두 마스킹 대상";
  let unmask = await policy.resolveUnmaskKeys("u1", SRC);
  if (unmask.keys.size !== 0) throw new Error("grant 없는데 언마스크 " + unmask.keys.size);
  let pol = policy.getSourcePolicy(SRC, unmask.keys);
  if (!pol.hasMasks || pol.maskedCols.size !== 2) throw new Error("기본 마스킹 " + pol.maskedCols.size);
  ok(step);

  step = "③ 특정 컬럼 grant(users.ssn) → u1 만 ssn 언마스크, name 은 유지";
  await store.createUnmaskGrant({ member_id: "u1", source: SRC, table_name: "users", column_name: "ssn", reason: "심사", approved_by: "admin", expires_at: new Date(Date.now() + 3600_000).toISOString() }, "admin");
  policy._resetPolicyCacheForTest(); await policy.refreshPolicy(true);
  unmask = await policy.resolveUnmaskKeys("u1", SRC);
  if (!(unmask.keys.has("users.ssn") && !unmask.keys.has("users.name"))) throw new Error("언마스크 키 " + [...unmask.keys]);
  if (unmask.grantsByKey.get("users.ssn")?.length !== 1) throw new Error("grantsByKey(ssn) " + JSON.stringify([...unmask.grantsByKey]));
  pol = policy.getSourcePolicy(SRC, unmask.keys);
  if (pol.maskedCols.has("users.ssn") || !pol.maskedCols.has("users.name")) throw new Error("정책 반영 오류 " + [...pol.maskedCols]);
  // 다른 멤버(u2)는 여전히 전부 마스킹
  const um2 = await policy.resolveUnmaskKeys("u2", SRC);
  if (um2.keys.size !== 0) throw new Error("u2 격리 실패 " + [...um2.keys]);
  ok(step);

  step = "④ '*' grant(users.* ) → 그 테이블 모든 마스킹 컬럼 언마스크";
  await store.createUnmaskGrant({ member_id: "u3", source: SRC, table_name: "users", column_name: "*", reason: "감사", approved_by: "admin", expires_at: new Date(Date.now() + 3600_000).toISOString() }, "admin");
  policy._resetPolicyCacheForTest(); await policy.refreshPolicy(true);
  const um3 = await policy.resolveUnmaskKeys("u3", SRC);
  if (!(um3.keys.has("users.ssn") && um3.keys.has("users.name"))) throw new Error("'*' 확장 실패 " + [...um3.keys]);
  ok(step);

  step = "⑤ 만료(과거 expires) grant → 무효(언마스크 안 됨)";
  await store.createUnmaskGrant({ member_id: "u4", source: SRC, table_name: "users", column_name: "ssn", expires_at: new Date(Date.now() - 1000).toISOString() }, "admin");
  policy._resetPolicyCacheForTest(); await policy.refreshPolicy(true);
  const um4 = await policy.resolveUnmaskKeys("u4", SRC);
  if (um4.keys.size !== 0) throw new Error("만료 grant 가 활성 " + [...um4.keys]);
  ok(step);

  step = "⑥ 회수(revoke) → 즉시 재마스킹";
  const grants = await store.listUnmaskGrants({ memberId: "u1", source: SRC, activeOnly: true });
  if (grants.length !== 1) throw new Error("u1 활성 grant " + grants.length);
  await store.revokeUnmaskGrant(String(grants[0].id), "admin");
  policy._resetPolicyCacheForTest(); await policy.refreshPolicy(true);
  const um1b = await policy.resolveUnmaskKeys("u1", SRC);
  if (um1b.keys.size !== 0) throw new Error("회수 후에도 언마스크 " + [...um1b.keys]);
  ok(step);

  step = "⑦ 회수 멱등 + 감사(org_content_audit 에 grant insert/update 기록)";
  await store.revokeUnmaskGrant(String(grants[0].id), "admin"); // 멱등(재호출 무해)
  const audit = await itemsPool.query(
    "SELECT op, count(*)::int AS c FROM org_content_audit WHERE entity='org_db_unmask_grant' GROUP BY op ORDER BY op");
  const byOp = Object.fromEntries(audit.rows.map((r) => [r.op, r.c]));
  if (!(byOp.insert >= 3 && byOp.update >= 1)) throw new Error("감사 기록 " + JSON.stringify(byOp));
  ok(step + ` (insert=${byOp.insert}, update=${byOp.update})`);

  console.log("\nUNMASK-GRANT INTEGRATION ALL GREEN");
} catch (e) {
  console.error("FAIL @ " + step + " — " + e.message);
  process.exitCode = 1;
} finally {
  await itemsPool.end();
}

// P1(#746) per-user 자격 vault 통합 검증 — 실 Postgres + secret-box 로 저장·복호·해소체인·격리·폴백정책.
// 실행: npm run build && CONNECTOR_SECRET_KEY=$(openssl rand -hex 32) \
//        ITEMS_DATABASE_URL='postgresql://postgres@localhost/vault_test?host=/tmp/pgXXX&port=54329' \
//        node scripts/integration/member-secret-pg.mjs   (스크래치 DB 필수 — 운영 금지)
import { fileURLToPath } from "node:url";
import path from "node:path";

if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 미설정(스크래치 pg 필요)"); process.exit(2); }
if (!process.env.CONNECTOR_SECRET_KEY) { console.error("CONNECTOR_SECRET_KEY 미설정(암호화 필요)"); process.exit(2); }
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
const { initOrgSchema } = await import(path.join(DIST, "org/schema.js"));
const { itemsPool } = await import(path.join(DIST, "items/store.js"));
const v = await import(path.join(DIST, "org/member-secret-store.js"));

let step = "";
const ok = (m) => console.log("ok  " + m);
try {
  step = "① initOrgSchema(member_secret 생성)";
  await initOrgSchema();
  ok(step);

  step = "② 저장·복호 왕복 — member 자격(gitlab_pat)";
  await v.setMemberSecret(v.memberOwner("u1"), "gitlab_pat", "git.honestfund.kr",
    { secret: "glpat-SECRET-u1", meta: { username: "u1" }, label: "u1 PAT" }, "u1");
  const got = await v.getMemberSecret(v.memberOwner("u1"), "gitlab_pat", "git.honestfund.kr");
  if (got?.secret !== "glpat-SECRET-u1" || got?.meta?.username !== "u1") throw new Error("복호 불일치 " + JSON.stringify(got));
  ok(step);

  step = "③ 시크릿 비노출 — public 목록엔 has_secret 만(값 없음)";
  const pub = await v.listMemberSecretsPublic(v.memberOwner("u1"));
  if (pub.length !== 1 || pub[0].has_secret !== true || JSON.stringify(pub[0]).includes("glpat-")) throw new Error("public 누출 " + JSON.stringify(pub));
  ok(step);

  step = "④ 해소 체인 — member 우선";
  await v.setMemberSecret(v.GATEWAY_OWNER, "gitlab_pat", "git.honestfund.kr", { secret: "glpat-GATEWAY" }, "admin");
  const r1 = await v.resolveMemberSecret("u1", "gitlab_pat", { scopeKey: "git.honestfund.kr", allowFallback: true });
  if (r1?.secret !== "glpat-SECRET-u1") throw new Error("member 우선 실패 " + r1?.secret);
  ok(step);

  step = "⑤ 해소 체인 — member 없고 allowFallback=true → gateway 통합 폴백";
  const r2 = await v.resolveMemberSecret("u2", "gitlab_pat", { scopeKey: "git.honestfund.kr", allowFallback: true });
  if (r2?.secret !== "glpat-GATEWAY") throw new Error("gateway 폴백 실패 " + r2?.secret);
  ok(step);

  step = "⑥ 해소 체인 — write 경로(allowFallback=false) → member 없으면 null(통합 폴백 금지)";
  const r3 = await v.resolveMemberSecret("u2", "gitlab_pat", { scopeKey: "git.honestfund.kr", allowFallback: false });
  if (r3 !== null) throw new Error("write 폴백 금지 위반 — " + JSON.stringify(r3));
  // 단, member 자격이 있으면 write 경로도 그걸로 해소
  const r3b = await v.resolveMemberSecret("u1", "gitlab_pat", { scopeKey: "git.honestfund.kr", allowFallback: false });
  if (r3b?.secret !== "glpat-SECRET-u1") throw new Error("write member 해소 실패 " + r3b?.secret);
  ok(step);

  step = "⑦ 멤버 격리 — u1 자격이 u3 에게 안 샘(member 없고 fallback 금지)";
  const r4 = await v.resolveMemberSecret("u3", "gitlab_pat", { scopeKey: "git.honestfund.kr", allowFallback: false });
  if (r4 !== null) throw new Error("격리 위반 — u3 가 자격 획득 " + JSON.stringify(r4));
  ok(step);

  step = "⑧ secret 생략 갱신 — meta 만 바꾸고 기존 secret 유지(COALESCE)";
  await v.setMemberSecret(v.memberOwner("u1"), "gitlab_pat", "git.honestfund.kr", { meta: { username: "u1-renamed" } }, "u1");
  const g2 = await v.getMemberSecret(v.memberOwner("u1"), "gitlab_pat", "git.honestfund.kr");
  if (g2?.secret !== "glpat-SECRET-u1" || g2?.meta?.username !== "u1-renamed") throw new Error("secret 유지 실패 " + JSON.stringify(g2));
  ok(step);

  step = "⑨ meta 전용 kind(aws_role_arn) — secret 없이 meta 만";
  await v.setMemberSecret(v.memberOwner("u1"), "aws_role_arn", "", { meta: { role_arn: "arn:aws:iam::425515538094:role/lively-ro" } }, "u1");
  const aws = await v.resolveMemberSecret("u1", "aws_role_arn", { allowFallback: false });
  if (aws?.secret !== null || aws?.meta?.role_arn !== "arn:aws:iam::425515538094:role/lively-ro") throw new Error("meta-only 실패 " + JSON.stringify(aws));
  ok(step);

  step = "⑩ 삭제 → 해소 null";
  const del = await v.deleteMemberSecret(v.memberOwner("u1"), "gitlab_pat", "git.honestfund.kr");
  if (!del) throw new Error("삭제 실패");
  const after = await v.resolveMemberSecret("u1", "gitlab_pat", { scopeKey: "git.honestfund.kr", allowFallback: false });
  if (after !== null) throw new Error("삭제 후에도 해소 " + JSON.stringify(after));
  ok(step);

  console.log("\nMEMBER-SECRET VAULT INTEGRATION ALL GREEN");
} catch (e) {
  console.error("FAIL @ " + step + " — " + e.message);
  process.exitCode = 1;
} finally {
  await itemsPool.end();
}

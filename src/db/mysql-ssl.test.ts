// mysql ssl 옵션 조립(#743) 단위 체크 — RDS CA 번들 기반 서버 인증서 검증 모드(require|verify-ca|verify-identity).
// 실행: npm run build && node dist/db/mysql-ssl.test.js
import assert from "node:assert/strict";
import { buildMysqlSsl } from "./mysql-engine.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

type SslObj = { ca: string[]; rejectUnauthorized: boolean; verifyIdentity: boolean };

t("buildMysqlSsl: 모드 없음 → undefined(평문)", () => {
  assert.equal(buildMysqlSsl(undefined), undefined);
});
t("buildMysqlSsl: require → 암호화 전용(CA 미검증, 하위호환)", () => {
  assert.deepEqual(buildMysqlSsl("require"), { rejectUnauthorized: false });
});
t("buildMysqlSsl: verify-ca → CA 체인 검증·hostname 미검증", () => {
  const ssl = buildMysqlSsl("verify-ca") as SslObj;
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.verifyIdentity, false);
  assert.ok(Array.isArray(ssl.ca) && ssl.ca.length > 0, "RDS CA 번들이 실려야 함");
  assert.ok(ssl.ca.some((c) => c.includes("BEGIN CERTIFICATE")), "PEM 인증서 형식");
});
t("buildMysqlSsl: verify-identity → CA + hostname 검증", () => {
  const ssl = buildMysqlSsl("verify-identity") as SslObj;
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.verifyIdentity, true);
  assert.ok(ssl.ca.length > 0);
});
t("buildMysqlSsl: verify 계열은 동일 RDS 번들 공유", () => {
  const a = buildMysqlSsl("verify-ca") as SslObj;
  const b = buildMysqlSsl("verify-identity") as SslObj;
  assert.equal(a.ca.length, b.ca.length);
  assert.ok(a.ca.length >= 100, "RDS 전 리전 CA(수십~수백)면 100+ 기대");
});

console.log(`\n${pass} checks passed`);

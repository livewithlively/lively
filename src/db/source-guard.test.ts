// DB 소스 보안 가드 단위 체크 — SSRF(IP 차단) + 시크릿 참조 화이트리스트.
// 실행: npm run build && node dist/db/source-guard.test.js
import assert from "node:assert/strict";
import { hostOfUrl, isHostBlocked, isSecretRefAllowed, inspectConnString } from "./source-guard.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};
const at = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};

// ── hostOfUrl ──
t("hostOfUrl: postgres url → host", () => assert.equal(hostOfUrl("postgres://ro@db.example.com:5432/app"), "db.example.com"));
t("hostOfUrl: 대문자 host 소문자화", () => assert.equal(hostOfUrl("postgres://ro@DB.EXAMPLE.COM/app"), "db.example.com"));
t("hostOfUrl: ?host= 쿼리파라미터가 실제 host(pg 기준 — new URL 우회 차단)", () =>
  assert.equal(hostOfUrl("postgres://ro@pub.example.com/app?host=10.0.0.5"), "10.0.0.5"));

// ── inspectConnString(pg 파서 — new URL 이 놓치는 쿼리파라미터까지) ──
t("inspectConnString: userinfo 비번 인식", () => assert.equal(inspectConnString("postgres://u:pw@h/db").hasPassword, true));
t("inspectConnString: ?password= 쿼리 비번 인식(new URL 우회)", () => assert.equal(inspectConnString("postgres://ro@h/app?password=secret").hasPassword, true));
t("inspectConnString: 비번 없으면 false", () => assert.equal(inspectConnString("postgres://ro@h/db").hasPassword, false));
t("inspectConnString: ?host= 가 실제 host", () => assert.equal(inspectConnString("postgres://ro@pub.com/app?host=127.0.0.1").host, "127.0.0.1"));

// ── isHostBlocked — IP 리터럴(DNS 불요) ──
await at("isHostBlocked: 127.0.0.1(loopback) → 차단", async () => assert.equal(await isHostBlocked("127.0.0.1"), true));
await at("isHostBlocked: 169.254.169.254(메타데이터) → 차단", async () => assert.equal(await isHostBlocked("169.254.169.254"), true));
await at("isHostBlocked: 10.0.0.5(사설) → 차단", async () => assert.equal(await isHostBlocked("10.0.0.5"), true));
await at("isHostBlocked: 192.168.1.1(사설) → 차단", async () => assert.equal(await isHostBlocked("192.168.1.1"), true));
await at("isHostBlocked: 8.8.8.8(공인) → 통과", async () => assert.equal(await isHostBlocked("8.8.8.8"), false));

// ── isSecretRefAllowed(deny-all 기본) ──
t("isSecretRefAllowed: 화이트리스트에 있으면 true", () => assert.equal(isSecretRefAllowed("ANALYTICS_PW", ["ANALYTICS_PW", "OPS_PW"]), true));
t("isSecretRefAllowed: 인프라 시크릿(미허용) → false", () => assert.equal(isSecretRefAllowed("ITEMS_DATABASE_URL", ["ANALYTICS_PW"]), false));
t("isSecretRefAllowed: 빈 화이트리스트 → false", () => assert.equal(isSecretRefAllowed("X", []), false));

// ── 통합: ?host= 위장 우회 시도가 차단되는지(검증=접속 일치) ──
await at("우회 시도: 공인 host 로 위장한 ?host=127.0.0.1 → 추출 host 차단", async () => {
  const h = hostOfUrl("postgres://ro@pub.example.com/app?host=127.0.0.1");
  assert.equal(h, "127.0.0.1");
  assert.equal(await isHostBlocked(h ?? ""), true);
});

console.log(`\n${pass} checks passed`);

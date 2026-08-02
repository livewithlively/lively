// DB 소스 보안 가드 단위 체크 — SSRF(IP 차단) + 시크릿 참조 화이트리스트.
// 실행: npm run build && node dist/db/source-guard.test.js
import assert from "node:assert/strict";
import { hostOfUrl, isHostBlocked, isSecretRefAllowed, inspectConnString, inspectMysqlUrl, pinHost } from "./source-guard.js";

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

// ── pinHost(검증된 공인 IP 핀 — DNS 리바인딩/멀티앤서 우회 차단) ──
await at("pinHost: 공인 IP 리터럴 → 그대로", async () => assert.equal(await pinHost("8.8.8.8"), "8.8.8.8"));
await at("pinHost: 사설 IP → 거부", async () => { await assert.rejects(() => pinHost("10.0.0.5"), /차단/); });
await at("pinHost: 메타데이터 IP → 거부", async () => { await assert.rejects(() => pinHost("169.254.169.254"), /차단/); });

// ── allowedHosts 화이트리스트(운영자 명시 — 사설/localhost SSRF 면제) ──
await at("isHostBlocked: 허용목록 127.0.0.1 → 통과(차단 안 함)", async () => assert.equal(await isHostBlocked("127.0.0.1", ["127.0.0.1"]), false));
await at("isHostBlocked: 허용목록 대소문자 무시", async () => assert.equal(await isHostBlocked("DB.INTERNAL", ["db.internal"]), false));
await at("isHostBlocked: 허용목록 밖 사설 IP → 여전히 차단", async () => assert.equal(await isHostBlocked("10.0.0.5", ["127.0.0.1"]), true));
await at("pinHost: 허용목록 사설 IP → 그대로 핀", async () => assert.equal(await pinHost("10.0.0.5", ["10.0.0.5"]), "10.0.0.5"));
await at("pinHost: 허용목록 127.0.0.1 → 그대로 핀", async () => assert.equal(await pinHost("127.0.0.1", ["127.0.0.1"]), "127.0.0.1"));
await at("pinHost: 허용목록 밖 사설 IP → 여전히 거부", async () => { await assert.rejects(() => pinHost("10.0.0.5", ["127.0.0.1"]), /차단/); });

// ── inspectMysqlUrl(#715 — mysql 소스 url 엄격 검사) ──
t("inspectMysqlUrl: 정상(포트·스키마·유저)", () => {
  const m = inspectMysqlUrl("mysql://wikibot_ro@prod-x.cluster-ro.rds.amazonaws.com:3306/hf");
  assert.equal(m.ok, true);
  assert.equal(m.host, "prod-x.cluster-ro.rds.amazonaws.com");
  assert.equal(m.port, 3306);
  assert.equal(m.user, "wikibot_ro");
  assert.equal(m.database, "hf");
  assert.equal(m.ssl, false);
});
t("inspectMysqlUrl: 포트 생략 → 3306", () => assert.equal(inspectMysqlUrl("mysql://u@h/db").port, 3306));
t("inspectMysqlUrl: 대문자 host 소문자화", () => assert.equal(inspectMysqlUrl("mysql://u@RDS.EXAMPLE.COM/db").host, "rds.example.com"));
t("inspectMysqlUrl: 비번 인라인 거부", () => {
  const m = inspectMysqlUrl("mysql://u:pw@h/db");
  assert.equal(m.ok, false);
  assert.equal(m.hasPassword, true);
});
t("inspectMysqlUrl: database(스키마) 없으면 거부", () => assert.equal(inspectMysqlUrl("mysql://u@h:3306").ok, false));
t("inspectMysqlUrl: 다단 path 거부", () => assert.equal(inspectMysqlUrl("mysql://u@h/db/extra").ok, false));
t("inspectMysqlUrl: 스킴 오류 거부", () => assert.equal(inspectMysqlUrl("postgres://u@h/db").ok, false));
t("inspectMysqlUrl: ssl=require 인식", () => {
  const m = inspectMysqlUrl("mysql://u@h/db?ssl=require");
  assert.equal(m.ok, true);
  assert.equal(m.ssl, true);
  assert.equal(m.sslMode, "require");
});
t("inspectMysqlUrl: ssl=1|true → require(하위호환)", () => {
  assert.equal(inspectMysqlUrl("mysql://u@h/db?ssl=1").sslMode, "require");
  assert.equal(inspectMysqlUrl("mysql://u@h/db?ssl=TRUE").sslMode, "require");
});
t("inspectMysqlUrl: ssl=verify-ca 인식(#743)", () => {
  const m = inspectMysqlUrl("mysql://u@h/db?ssl=verify-ca");
  assert.equal(m.ok, true);
  assert.equal(m.ssl, true);
  assert.equal(m.sslMode, "verify-ca");
});
t("inspectMysqlUrl: ssl=verify-identity 인식(#743)", () => {
  const m = inspectMysqlUrl("mysql://u@h/db?ssl=verify-identity");
  assert.equal(m.ok, true);
  assert.equal(m.sslMode, "verify-identity");
});
t("inspectMysqlUrl: ssl 파라미터 없으면 평문(sslMode undefined)", () => {
  const m = inspectMysqlUrl("mysql://u@h/db");
  assert.equal(m.ok, true);
  assert.equal(m.ssl, false);
  assert.equal(m.sslMode, undefined);
});
t("inspectMysqlUrl: 미지 파라미터 거부(옵션 주입 차단)", () => assert.equal(inspectMysqlUrl("mysql://u@h/db?connectTimeout=1").ok, false));
t("inspectMysqlUrl: ssl 이상값 거부", () => assert.equal(inspectMysqlUrl("mysql://u@h/db?ssl=disable").ok, false));
t("inspectMysqlUrl: ssl=verify_ca(언더스코어) 거부 — 정확 매칭", () => assert.equal(inspectMysqlUrl("mysql://u@h/db?ssl=verify_ca").ok, false));

console.log(`\n${pass} checks passed`);

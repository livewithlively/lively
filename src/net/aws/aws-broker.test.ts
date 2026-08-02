// AWS STS 브로커 단위 체크 — 세션명/기간/ARN 검증 + AssumeRole 요청 구성·응답 파싱(STS 주입 목).
// 실행: npm run build && node dist/net/aws/aws-broker.test.js
//  실 STS 연결(SigV4 정확성)은 aws-sigv4.test + scratch 의 GetCallerIdentity E2E 로 별도 검증됨.
import assert from "node:assert/strict";
import {
  assumeRole, roleSessionName, clampDuration, toCredentialProcessJson,
  STS_MIN_DURATION, STS_MAX_DURATION, type StsHttp,
  fetchImdsBaseCreds, resolveGatewayBaseCreds, __resetImdsCache, type ImdsHttp,
} from "./aws-broker.js";

let pass = 0;
const t = (name: string, fn: () => void | Promise<void>): Promise<void> | void => {
  const r = fn();
  if (r instanceof Promise) return r.then(() => { pass++; console.log(`ok  ${name}`); });
  pass++; console.log(`ok  ${name}`);
};

t("roleSessionName: 멤버ID 정제 + lively- 접두 + 64자 상한", () => {
  assert.equal(roleSessionName("yoon"), "lively-yoon");
  assert.equal(roleSessionName("a b/c"), "lively-a-b-c"); // 비허용문자 → -
  assert.ok(roleSessionName("x".repeat(100)).length <= 64);
  assert.equal(roleSessionName(""), "lively-member");
});
t("clampDuration: 900~3600 클램프, 비정상 → 3600", () => {
  assert.equal(clampDuration(100), STS_MIN_DURATION);
  assert.equal(clampDuration(99999), STS_MAX_DURATION);
  assert.equal(clampDuration(1800), 1800);
  assert.equal(clampDuration("bad"), STS_MAX_DURATION);
});
t("toCredentialProcessJson: AWS 규격(Version 1 + 4필드)", () => {
  const j = JSON.parse(toCredentialProcessJson({ accessKeyId: "AKIA", secretAccessKey: "s", sessionToken: "tok", expiration: "2026-07-09T01:00:00Z" }));
  assert.equal(j.Version, 1);
  assert.equal(j.AccessKeyId, "AKIA");
  assert.equal(j.SecretAccessKey, "s");
  assert.equal(j.SessionToken, "tok");
  assert.equal(j.Expiration, "2026-07-09T01:00:00Z");
});

const base = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const okXml = `<AssumeRoleResponse><AssumeRoleResult><Credentials>
  <AccessKeyId>ASIATEMP</AccessKeyId><SecretAccessKey>tempsecret</SecretAccessKey>
  <SessionToken>tempsession</SessionToken><Expiration>2026-07-09T01:00:00Z</Expiration>
</Credentials></AssumeRoleResult></AssumeRoleResponse>`;

interface Captured { url: string; headers: Record<string, string>; body: string }
await t("assumeRole: 요청 구성(AssumeRole·RoleSessionName·서명헤더) + 응답 파싱", async () => {
  const captured: Captured[] = [];
  const mock: StsHttp = async (url, headers, body) => { captured.push({ url, headers, body }); return { status: 200, body: okXml }; };
  const creds = await assumeRole({
    roleArn: "arn:aws:iam::123456789012:role/lively-ro", region: "ap-northeast-2",
    memberId: "yoon", durationSeconds: 3600, baseCreds: base, now: new Date("2026-07-09T00:00:00Z"),
  }, mock);
  assert.equal(creds.accessKeyId, "ASIATEMP");
  assert.equal(creds.sessionToken, "tempsession");
  assert.equal(creds.expiration, "2026-07-09T01:00:00Z");
  assert.equal(captured.length, 1);
  const c = captured[0];
  assert.equal(c.url, "https://sts.ap-northeast-2.amazonaws.com/");
  assert.ok(c.body.includes("Action=AssumeRole"));
  assert.ok(c.body.includes("RoleSessionName=lively-yoon"));
  assert.ok(c.body.includes("RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Flively-ro"));
  assert.ok(c.headers.Authorization?.startsWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"));
  assert.ok(!c.body.includes(base.secretAccessKey), "시크릿은 바디에 없어야");
});

await t("assumeRole: ExternalId 전달 시 바디에 포함", async () => {
  let body = "";
  const mock: StsHttp = async (_u, _h, b) => { body = b; return { status: 200, body: okXml }; };
  await assumeRole({ roleArn: "arn:aws:iam::123456789012:role/r", region: "ap-northeast-2", memberId: "u", externalId: "ext-123", baseCreds: base, now: new Date("2026-07-09T00:00:00Z") }, mock);
  assert.ok(body.includes("ExternalId=ext-123"), body);
});

await t("assumeRole: 잘못된 ARN·region → 호출 전 throw", async () => {
  const never: StsHttp = async () => { throw new Error("should not call"); };
  await assert.rejects(() => assumeRole({ roleArn: "not-an-arn", region: "ap-northeast-2", memberId: "u", baseCreds: base, now: new Date() }, never), /ARN 형식/);
  await assert.rejects(() => assumeRole({ roleArn: "arn:aws:iam::123456789012:role/r", region: "bad", memberId: "u", baseCreds: base, now: new Date() }, never), /region 형식/);
});

await t("assumeRole: STS 에러(403) → 안전 메시지(자격 미노출)", async () => {
  const mock: StsHttp = async () => ({ status: 403, body: "<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>" });
  await assert.rejects(
    () => assumeRole({ roleArn: "arn:aws:iam::123456789012:role/r", region: "ap-northeast-2", memberId: "u", baseCreds: base, now: new Date() }, mock),
    /AssumeRole 실패\(AccessDenied\)/,
  );
});

await t("assumeRole: Credentials 누락 응답 → 파싱 실패 throw", async () => {
  const mock: StsHttp = async () => ({ status: 200, body: "<AssumeRoleResponse></AssumeRoleResponse>" });
  await assert.rejects(() => assumeRole({ roleArn: "arn:aws:iam::123456789012:role/r", region: "ap-northeast-2", memberId: "u", baseCreds: base, now: new Date() }, mock), /파싱 실패/);
});

// ── IMDSv2 베이스-크레드 폴백(#746 imp#4) — mock ImdsHttp 로 실 네트워크 없이 ──
const imdsOk = (opts?: { code?: string }): ImdsHttp => async (method, path) => {
  if (method === "PUT" && path === "/latest/api/token") return { status: 200, body: "TOKENVAL" };
  if (path === "/latest/meta-data/iam/security-credentials/") return { status: 200, body: "my-role\n" };
  if (path.startsWith("/latest/meta-data/iam/security-credentials/")) {
    return { status: 200, body: JSON.stringify({ Code: opts?.code ?? "Success", AccessKeyId: "ASIAIMDS", SecretAccessKey: "imdssecret", Token: "imdstoken", Expiration: "2026-07-09T01:00:00Z" }) };
  }
  return { status: 404, body: "" };
};

await t("fetchImdsBaseCreds: IMDSv2 토큰→role→creds (토큰헤더·role경로 확인)", async () => {
  __resetImdsCache();
  const calls: { m: string; p: string; h: Record<string, string> }[] = [];
  const mock: ImdsHttp = async (m, p, h) => { calls.push({ m, p, h }); return imdsOk()(m, p, h); };
  const c = await fetchImdsBaseCreds(mock);
  assert.equal(c?.accessKeyId, "ASIAIMDS");
  assert.equal(c?.sessionToken, "imdstoken");
  assert.equal(calls[0].m, "PUT");                       // IMDSv2: 토큰 먼저
  assert.equal(calls[0].p, "/latest/api/token");
  assert.ok(calls[0].h["X-aws-ec2-metadata-token-ttl-seconds"]);
  assert.equal(calls[1].h["X-aws-ec2-metadata-token"], "TOKENVAL"); // 이후 GET 에 토큰 헤더
  assert.ok(calls[2].p.endsWith("/my-role"));
});

await t("fetchImdsBaseCreds: 비EC2(토큰 획득 실패) → null", async () => {
  __resetImdsCache();
  const mock: ImdsHttp = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await fetchImdsBaseCreds(mock), null);
});

await t("fetchImdsBaseCreds: creds Code!=Success → null(자격 미사용)", async () => {
  __resetImdsCache();
  assert.equal(await fetchImdsBaseCreds(imdsOk({ code: "AssumeRoleUnauthorizedAccess" })), null);
});

await t("resolveGatewayBaseCreds: env 우선 — IMDS 미호출", async () => {
  __resetImdsCache();
  process.env.AWS_ACCESS_KEY_ID = "AKIAENV"; process.env.AWS_SECRET_ACCESS_KEY = "envsecret";
  const never: ImdsHttp = async () => { throw new Error("IMDS should not be called when env present"); };
  const c = await resolveGatewayBaseCreds(never);
  assert.equal(c?.accessKeyId, "AKIAENV");
  delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY;
});

await t("resolveGatewayBaseCreds: env 없으면 IMDS 폴백", async () => {
  __resetImdsCache();
  delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY;
  const c = await resolveGatewayBaseCreds(imdsOk());
  assert.equal(c?.accessKeyId, "ASIAIMDS");
});

console.log(`\naws-broker tests: ${pass} passed`);

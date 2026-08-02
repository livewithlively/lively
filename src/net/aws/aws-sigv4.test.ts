// SigV4 서명 단위 체크 — AWS 공개 테스트벡터(aws-sig-v4-test-suite 'get-vanilla')로 정확성을 못박는다.
// 실행: npm run build && node dist/net/aws/aws-sigv4.test.js
//  벡터: https://docs.aws.amazon.com/general/latest/gr/signature-v4-test-suite.html
//   key AKIDEXAMPLE / secret wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY / 2015-08-30T12:36:00Z / region us-east-1 / service service
import assert from "node:assert/strict";
import { signRequestV4, amzDate } from "./aws-sigv4.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("amzDate: ISO → 20150830T123600Z / 20150830", () => {
  const { amzDate: a, dateStamp: d } = amzDate(new Date("2015-08-30T12:36:00Z"));
  assert.equal(a, "20150830T123600Z");
  assert.equal(d, "20150830");
});

// get-vanilla: GET https://example.amazonaws.com/ , 헤더 host+x-amz-date 만. AWS 문서의 기대 Authorization.
t("get-vanilla 벡터 — Authorization 정확 일치", () => {
  const headers = signRequestV4({
    method: "GET", host: "example.amazonaws.com", path: "/", region: "us-east-1", service: "service",
    body: "", now: new Date("2015-08-30T12:36:00Z"),
    creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
  });
  assert.equal(headers["X-Amz-Date"], "20150830T123600Z");
  assert.equal(
    headers.Authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
    "SignedHeaders=host;x-amz-date, " +
    "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

t("sessionToken 있으면 x-amz-security-token 이 서명 헤더에 포함", () => {
  const headers = signRequestV4({
    method: "POST", host: "sts.amazonaws.com", path: "/", region: "us-east-1", service: "sts",
    body: "Action=GetCallerIdentity&Version=2011-06-15",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    now: new Date("2015-08-30T12:36:00Z"),
    creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "TOKEN123" },
  });
  assert.ok(headers.Authorization.includes("x-amz-security-token"), headers.Authorization);
  assert.ok(headers.Authorization.includes("content-type"), "content-type 도 서명 헤더");
  assert.equal(headers["X-Amz-Security-Token"], "TOKEN123");
});

t("서명은 결정론적(같은 입력 → 같은 서명)", () => {
  const mk = () => signRequestV4({
    method: "POST", host: "sts.ap-northeast-2.amazonaws.com", path: "/", region: "ap-northeast-2", service: "sts",
    body: "Action=AssumeRole&Version=2011-06-15", headers: { "content-type": "application/x-www-form-urlencoded" },
    now: new Date("2026-07-09T00:00:00Z"),
    creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
  }).Authorization;
  assert.equal(mk(), mk());
});

console.log(`\naws-sigv4 tests: ${pass} passed`);

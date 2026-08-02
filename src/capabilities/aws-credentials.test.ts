// AWS 자격 권한 경계 회귀(리뷰 blocking) — me_credential_set 은 aws_role_arn 개인 등록을 거부한다(이중 방어).
//  이 가드는 DB 호출 전에 throw 하므로 순수 단위검증 가능. (org-only role 해소는 member-secret-pg 통합에서 검증.)
// 실행: npm run build && node dist/capabilities/aws-credentials.test.js
import assert from "node:assert/strict";
import { memberSecretCapabilities } from "./member-secret.js";

let pass = 0;
const t = (name: string, fn: () => Promise<void>): Promise<void> => fn().then(() => { pass++; console.log(`ok  ${name}`); });

const meSet = memberSecretCapabilities.find((c) => c.name === "me_credential_set")!;
const user = { userId: "attacker", email: "a@x", scopes: [], projects: ["*"] } as any;

await t("me_credential_set: aws_role_arn 개인 등록 거부(403) — 게이트웨이 신원 confused-deputy 방지", async () => {
  await assert.rejects(
    () => meSet.handler({ kind: "aws_role_arn", meta: { role_arn: "arn:aws:iam::999999999999:role/evil", region: "ap-northeast-2" } }, user) as Promise<unknown>,
    (e: any) => e && e.status === 403 && /aws_role_arn/.test(e.message),
  );
});

await t("me_credential_set: 대문자 우회(AWS_ROLE_ARN)도 거부", async () => {
  await assert.rejects(
    () => meSet.handler({ kind: "AWS_ROLE_ARN", secret: "x" }, user) as Promise<unknown>,
    (e: any) => e && e.status === 403,
  );
});

console.log(`\naws-credentials tests: ${pass} passed`);

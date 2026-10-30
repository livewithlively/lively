// 내 자격 등록 — 시크릿 길이·codex 로그인 파일 형식 (#4012 T2) — 사양 spec-codex-parity 의 G 행.
//  검사는 DB 호출 **전에** 던지므로 DB 없이 잰다(aws-credentials.test 와 같은 방식). 받아들이는 쪽은 순수 함수로 잰다.
import { strict as assert } from "node:assert";
import { memberSecretCapabilities, validateMemberSecret } from "./member-secret.js";

const meSet = memberSecretCapabilities.find((c) => c.name === "me_credential_set")!;
const user = { userId: "sm", email: "sm@x", scopes: [], projects: ["*"] } as never;
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p: Record<string, unknown>): string => `${b64({})}.${b64(p)}.${"s".repeat(10)}`;
const codexFile = (pad = 0): string => JSON.stringify({
  tokens: {
    id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-A" }, email: "sm@x", pad: "p".repeat(pad) }),
    access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-A" }, exp: 1_900_000_000 }),
    refresh_token: "rt",
  },
  last_refresh: "2026-09-01T00:00:00Z",
});
const rejects400 = (input: Record<string, unknown>, re: RegExp, label: string) =>
  assert.rejects(() => meSet.handler(input, user) as Promise<unknown>, (e: any) => e?.status === 400 && re.test(String(e.message)), label);

// G1 — 형식 밖 codex 파일은 저장 전에 거절한다.
for (const bad of ["{broken", JSON.stringify({ tokens: {} }), '"just a string"', "sk-ant-oat01-xxxx", JSON.stringify({ tokens: { access_token: "x" } })]) {
  await rejects400({ kind: "codex_auth_json", secret: bad }, /auth\.json/, `G1 ${bad.slice(0, 30)}`);
  assert.throws(() => validateMemberSecret("codex_auth_json", bad), (e: any) => e?.status === 400, `G1 순수 ${bad.slice(0, 20)}`);
}
await rejects400({ kind: "CODEX_AUTH_JSON", secret: "{broken" }, /auth\.json/, "G1 대문자 종류도 같은 검사");

// G2 — 형식 안 codex 파일은 4KB 를 넘어도 온전히 통과한다(자르지 않는다).
{
  const big = codexFile(6000);
  assert.ok(big.length > 4096 && big.length < 16384, `G2 시험 파일 크기 ${big.length}`);
  assert.equal(validateMemberSecret("codex_auth_json", big), big, "G2 통과 · 원문 그대로");
  assert.equal(validateMemberSecret("codex_auth_json", JSON.stringify({ OPENAI_API_KEY: "sk-proj" })), JSON.stringify({ OPENAI_API_KEY: "sk-proj" }), "G2 키 방식");
}

// G3 — 16384 자는 통과, 16385 자는 거절(모든 종류). 거절은 저장 전이다.
{
  assert.equal(validateMemberSecret("github_pat", "x".repeat(16384))?.length, 16384, "G3 경계 통과");
  assert.throws(() => validateMemberSecret("github_pat", "x".repeat(16385)), (e: any) => e?.status === 400 && /16384/.test(e.message), "G3 경계+1 거절");
  await rejects400({ kind: "github_pat", secret: "x".repeat(16385) }, /16384/, "G3 핸들러도 저장 전에 거절");
  //  종전 4096 상한이 사라졌다 — 4097 자는 이제 검사를 통과한다.
  assert.equal(validateMemberSecret("github_pat", "y".repeat(4097))?.length, 4097, "G3 4097 자");
}

// G4 — 다른 종류는 형식을 보지 않는다 · 없으면 null(기존 유지) · aws_role_arn 거절은 그대로.
assert.equal(validateMemberSecret("github_pat", "{not json at all"), "{not json at all", "G4 다른 종류는 형식 검사 없음");
assert.equal(validateMemberSecret("codex_auth_json", undefined), null, "G4 없으면 null");
assert.equal(validateMemberSecret("codex_auth_json", null), null, "G4 null");
assert.equal(validateMemberSecret("codex_auth_json", "   "), "   ", "G4 공백뿐은 «변경 안 함» 으로 스토어가 접는다(형식 검사 안 함)");
await assert.rejects(() => meSet.handler({ kind: "aws_role_arn", secret: "x" }, user) as Promise<unknown>, (e: any) => e?.status === 403, "G4 aws 거절 유지");

console.log("✓ member-secret-codex — 시크릿 길이·codex 로그인 파일 형식 (G1~G4)");
process.exit(0);

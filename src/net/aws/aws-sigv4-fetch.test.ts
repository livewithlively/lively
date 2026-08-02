// SigV4 프록시 fetch(#746) 단위 — 서명 헤더 부착 + inner 위임 검증. 서명 자체 정확성은 aws-sigv4.test(AWS get-vanilla 벡터).
// 실행: npm run build && node dist/net/aws/aws-sigv4-fetch.test.js
import assert from "node:assert/strict";
import { makeSigv4Fetch } from "./aws-sigv4-fetch.js";

let pass = 0;
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "SESSION-TOKEN-XYZ" };

await ta("makeSigv4Fetch: AWS4-HMAC-SHA256 서명 헤더 부착 + inner 위임(SDK 헤더 보존)", async () => {
  let captured: Headers | undefined;
  const inner = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    captured = new Headers(init?.headers as HeadersInit | undefined);
    return new Response("ok", { status: 200 });
  };
  const f = makeSigv4Fetch({ creds, region: "us-east-1", service: "execute-api", inner });
  const res = await f("https://aws-mcp.us-east-1.api.aws/mcp", { method: "POST", body: '{"jsonrpc":"2.0","method":"tools/list"}', headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" } });
  assert.equal(res.status, 200);
  const auth = captured!.get("authorization") || "";
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/execute-api\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
  assert.ok(captured!.get("x-amz-date"), "X-Amz-Date 있어야");
  assert.equal(captured!.get("x-amz-security-token"), "SESSION-TOKEN-XYZ", "세션토큰 헤더");
  assert.ok((captured!.get("authorization") || "").includes("host;x-amz-date"), "host·x-amz-date 서명 포함");
  assert.equal(captured!.get("content-type"), "application/json", "SDK 헤더 보존(미서명)");
  assert.ok(captured!.get("accept"), "accept 보존");
});

await ta("makeSigv4Fetch: 세션토큰 없으면 X-Amz-Security-Token 미부착", async () => {
  let captured: Headers | undefined;
  const inner = async (_i: string | URL, init?: RequestInit): Promise<Response> => { captured = new Headers(init?.headers as HeadersInit | undefined); return new Response("", { status: 200 }); };
  const f = makeSigv4Fetch({ creds: { accessKeyId: "AKID", secretAccessKey: "secretsecretsecret" }, region: "ap-northeast-2", service: "execute-api", inner });
  await f("https://x.api.aws/mcp", { method: "GET" });
  assert.equal(captured!.get("x-amz-security-token"), null);
  assert.match(captured!.get("authorization") || "", /ap-northeast-2\/execute-api/);
});

console.log(`\nAWS-SIGV4-FETCH UNIT: ${pass} passed`);

import { strict as assert } from "node:assert";
import test from "node:test";
import { webhookSecretFor } from "./webhook.js";

// ★★ 공유 게이트웨이에서 웹훅 비밀을 **공유하면 교차 쓰기**가 된다. A 가 자기 비밀로 서명해
//  B 의 웹훅 URL 로 보내면 B 의 데이터가 바뀐다 — 라우팅은 호스트명으로 갈리지만 서명은 안 갈린다.
//  "남의 데이터가 보인다" 가 아니라 **"남의 데이터를 쓴다"** 라, 유출보다 나쁠 수 있다.

test("★★ 워크스페이스마다 다른 비밀이 나온다", () => {
  const a = webhookSecretFor("base-secret", "11111111-1111-1111-1111-111111111111");
  const b = webhookSecretFor("base-secret", "22222222-2222-2222-2222-222222222222");
  assert.notEqual(a, b);
  assert.notEqual(a, "base-secret", "설정값이 그대로 나오면 공유된 것이다");
});

test("같은 워크스페이스면 항상 같다(저장 없이 재현된다)", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  assert.equal(webhookSecretFor("base-secret", id), webhookSecretFor("base-secret", id));
});

// ★ 단일 테넌트(자가호스팅)는 설정값 그대로여야 한다 — 이미 깃허브에 등록된 비밀이 바뀌면
//  그 순간 모든 웹훅이 401 이 된다.
test("★ 컨텍스트가 없으면 설정값 그대로(OSS 무회귀)", () => {
  assert.equal(webhookSecretFor("base-secret", null), "base-secret");
});

test("설정이 비어 있으면 비어 있다(503 fail-closed 를 유지한다)", () => {
  assert.equal(webhookSecretFor("", "11111111-1111-1111-1111-111111111111"), "");
});

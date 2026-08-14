import { strict as assert } from "node:assert";
import test from "node:test";
import { tenantScopedKey } from "./embedding-provider.js";

// ★ 프로세스 하나가 여러 워크스페이스를 서비스하면 env 는 키를 하나만 담을 수 있다. 그 하나를
//  그대로 쓰면 모든 워크스페이스가 같은 키로 상류에 붙는다 — 상류는 키로 사용량을 계량하고
//  rate limit 을 거는데, 그러면 누구의 사용량인지 사라지고 하나가 전체 한도를 태울 수 있다.

test("★ 워크스페이스마다 다른 키가 나온다", () => {
  const a = tenantScopedKey("lve_base", "11111111-1111-1111-1111-111111111111");
  const b = tenantScopedKey("lve_base", "22222222-2222-2222-2222-222222222222");
  assert.notEqual(a, b);
  assert.notEqual(a, "lve_base");
});

test("같은 워크스페이스면 항상 같다(저장 없이 재현된다)", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  assert.equal(tenantScopedKey("lve_base", id), tenantScopedKey("lve_base", id));
});

// ★★ 자가호스팅은 값이 그대로여야 한다 — 유도된 값을 보내면 기존 상류(OpenAI 등)가 401 을 준다.
test("★★ 컨텍스트가 없으면 값 그대로(OSS 무회귀)", () => {
  assert.equal(tenantScopedKey("sk-real-openai-key", null), "sk-real-openai-key");
});

test("키가 없으면 빈 문자열 — 헤더를 생략하는 종전 동작을 유지한다", () => {
  assert.equal(tenantScopedKey(undefined, "11111111-1111-1111-1111-111111111111"), "");
  assert.equal(tenantScopedKey("", null), "");
});

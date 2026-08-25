import assert from "node:assert/strict";
import test from "node:test";
import { urlHostAllowed } from "./ssrf.js";

test("SSRF allowlist는 호스트와 선택적 포트를 정확히 대조한다", () => {
  assert.equal(urlHostAllowed(new URL("https://api.example.com/v1"), ["api.example.com"]), true);
  assert.equal(urlHostAllowed(new URL("https://api.example.com:443/v1"), ["api.example.com:443"]), true);
  assert.equal(urlHostAllowed(new URL("https://api.example.com:8443/v1"), ["api.example.com:443"]), false);
  assert.equal(urlHostAllowed(new URL("https://api.example.com:8443/v1"), ["api.example.com"]), true);
});

test("점 접두사는 루트와 하위 도메인만 허용하고 유사 접미사는 거부한다", () => {
  assert.equal(urlHostAllowed(new URL("https://example.com"), [".example.com"]), true);
  assert.equal(urlHostAllowed(new URL("https://a.example.com"), [".example.com"]), true);
  assert.equal(urlHostAllowed(new URL("https://notexample.com"), [".example.com"]), false);
});

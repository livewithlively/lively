import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceEnterRequest, workspaceExchange, accountHomeNavigation } from "./account-workspace.mjs";

const cp = "https://app.lvly.io";
const id = "244ae282-255c-4cdb-843c-26c250e366a8";
const enter = `${cp}/ws/${id}/enter`;
const exchange = "https://soltimal-adce.app.lvly.io/api/ui/session/exchange?code=secret";

test("계정 서버가 지정한 워크스페이스만 앱 안으로 들어간다", () => {
  assert.deepEqual(workspaceEnterRequest(enter, cp), { id, hash: null });
  assert.deepEqual(workspaceEnterRequest(`${enter}?to=%23%2Fs%2Fabc`, cp), { id, hash: "#/s/abc" });
  assert.deepEqual(workspaceEnterRequest(`${enter}?to=https%3A%2F%2Fevil.example`, cp), { id, hash: null });
  assert.equal(workspaceEnterRequest("", cp), null);
  assert.equal(workspaceEnterRequest(`https://evil.example/ws/${id}/enter`, cp), null);
  assert.equal(workspaceEnterRequest(`https://user:pass@app.lvly.io/ws/${id}/enter`, cp), null);
  assert.equal(workspaceEnterRequest(`${cp}/ws/${id}/delete`, cp), null);
  assert.equal(workspaceEnterRequest(`${cp}/ws/not-an-id/enter`, cp), null);
  assert.deepEqual(workspaceEnterRequest(`${enter}?to=${encodeURIComponent('#/' + 'a'.repeat(498))}`, cp), { id, hash: '#/' + 'a'.repeat(498) });
  assert.deepEqual(workspaceEnterRequest(`${enter}?to=${encodeURIComponent('#/' + 'a'.repeat(499))}`, cp), { id, hash: null });
});

test("계정 서버가 만든 테넌트 세션 교환 주소만 앱 창에 싣는다", () => {
  assert.deepEqual(workspaceExchange(exchange, cp), {
    exchangeUrl: exchange, gatewayUrl: "https://soltimal-adce.app.lvly.io", uiUrl: "https://soltimal-adce.app.lvly.io/ui/",
  });
  for (const bad of ["", `${cp}/api/ui/session/exchange?code=x`, "https://evil.example/api/ui/session/exchange?code=x",
    "https://soltimal-adce.app.lvly.io/ui/?code=x", "https://soltimal-adce.app.lvly.io/api/ui/session/exchange",
    "https://nested.soltimal-adce.app.lvly.io/api/ui/session/exchange?code=x",
    "https://soltimal-adce.app.lvly.io:444/api/ui/session/exchange?code=x",
    "https://user:pass@soltimal-adce.app.lvly.io/api/ui/session/exchange?code=x"]) {
    assert.equal(workspaceExchange(bad, cp), null, bad);
  }
  assert.deepEqual(workspaceExchange("http://127.0.0.1:9001/api/ui/session/exchange?code=x", "http://127.0.0.1:9000"), {
    exchangeUrl: "http://127.0.0.1:9001/api/ui/session/exchange?code=x", gatewayUrl: "http://127.0.0.1:9001", uiUrl: "http://127.0.0.1:9001/ui/",
  });
});

test("계정 로그인 완료는 계정 홈으로 이동했을 때만 인정한다", () => {
  assert.equal(accountHomeNavigation(`${cp}/home`, cp), true);
  assert.equal(accountHomeNavigation(`${cp}/home?tab=workspaces`, cp), true);
  for (const bad of [`${cp}/homepage`, `${cp}/login`, `https://evil.example/home`,
    `https://user:pass@app.lvly.io/home`, "not a url"]) {
    assert.equal(accountHomeNavigation(bad, cp), false, bad);
  }
});

// 로컬 MCP import 분류 단위 체크 — DB/네트워크 불요. 실행: npm run build && node dist/org/local-mcp-import.test.js
import assert from "node:assert/strict";
import { classifyLocalMcp, importedKind } from "./local-mcp-import.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const cfg = {
  mcpServers: {
    "acme-api": { url: "https://mcp.acme.com/mcp", headers: { Authorization: "Bearer sk-LIVE", "X-Trace": "1" } },
    "gitlab": { url: "https://git.co/api/v4/mcp", headers: { "PRIVATE-TOKEN": "glpat-xxx" } },
    "notion": { url: "https://mcp.notion.com/mcp" },                         // 정적토큰 없음 → oauth 추정
    "local-fs": { command: "node", args: ["fs.mjs"], env: { API_TOKEN: "tok", HOME: "/x" } }, // stdio+env
    "broken": { foo: "bar" },                                                 // url/command 없음
  },
};

t("classifyLocalMcp: http + Authorization → upload(정적토큰)", () => {
  const m = classifyLocalMcp(cfg).find((x) => x.name === "acme-api")!;
  assert.equal(m.transport, "http");
  assert.equal(m.importable, true);
  assert.equal(m.action, "upload");
  assert.equal(m.tokenHeader, "Authorization"); // 시크릿 헤더 채택(비시크릿 X-Trace 아님)
});
t("classifyLocalMcp: http + PRIVATE-TOKEN → upload", () => {
  const m = classifyLocalMcp(cfg).find((x) => x.name === "gitlab")!;
  assert.equal(m.action, "upload"); assert.equal(m.tokenHeader, "PRIVATE-TOKEN");
});
t("classifyLocalMcp: http + 정적토큰 없음 → reconnect(oauth 추정)", () => {
  const m = classifyLocalMcp(cfg).find((x) => x.name === "notion")!;
  assert.equal(m.importable, false); assert.equal(m.oauthLikely, true); assert.equal(m.action, "reconnect");
});
t("classifyLocalMcp: stdio + env 토큰 → broker(프록시 아님)", () => {
  const m = classifyLocalMcp(cfg).find((x) => x.name === "local-fs")!;
  assert.equal(m.transport, "stdio"); assert.equal(m.action, "broker"); assert.equal(m.tokenEnv, "API_TOKEN");
});
t("classifyLocalMcp: url/command 없음 → skip", () => {
  const m = classifyLocalMcp(cfg).find((x) => x.name === "broken")!;
  assert.equal(m.action, "skip");
});
t("classifyLocalMcp: mcpServers 없음 → []", () => {
  assert.deepEqual(classifyLocalMcp({}), []);
  assert.deepEqual(classifyLocalMcp(null), []);
});
t("importedKind: imported_ 접두 + slug", () => {
  assert.equal(importedKind("acme-api"), "imported_acme_api");
  assert.equal(importedKind("My Server!"), "imported_my_server");
  assert.equal(importedKind(""), "imported_mcp");
});

console.log(`\nlocal-mcp-import tests: ${pass} passed`);

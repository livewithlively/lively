// 로컬 하네스 MCP 정적토큰 → 라이블리 vault 이관(#746). 헤비 유저가 로컬에 이미 넣어둔 토큰을 재입력 없이 올린다.
//  정책(external-mcp-auth-matrix-746): 정적 토큰(http header)만 값 이관. OAuth 는 refresh 가 발급 client 에 묶여 이관 불가 → [연결] 재수행.
//  ⚠ 토큰 '값'은 절대 출력하지 않는다(kind/이름만). dry-run 기본 — 실제 업로드는 --apply.
//
//  실행(로컬 머신, kit 설치본): node deploy/import-local-mcp.mjs [--config <경로>] [--apply]
//   게이트웨이: env LIVELY_GATEWAY_URL / LIVELY_TOKEN 또는 ~/.lively/gateway-url + ~/.lively/token.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyLocalMcp, importedKind } from "../dist/org/delivery/local-mcp-import.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const ci = args.indexOf("--config");
const cfgPath = (ci >= 0 && args[ci + 1]) ? args[ci + 1] : path.join(os.homedir(), ".claude.json");

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const readFirst = (paths) => { for (const p of paths) { try { const v = fs.readFileSync(p, "utf8").trim(); if (v) return v; } catch { /* skip */ } } return null; };

const cfg = readJson(cfgPath);
if (!cfg) { console.error(`설정을 읽지 못했습니다: ${cfgPath} (다른 파일이면 --config <경로>)`); process.exit(1); }

const gw = (process.env.LIVELY_GATEWAY_URL || readFirst([path.join(os.homedir(), ".lively/gateway-url")]) || "").replace(/\/$/, "").replace(/\/mcp$/, "");
const tok = process.env.LIVELY_TOKEN || readFirst([path.join(os.homedir(), ".lively/token")]);

const items = classifyLocalMcp(cfg);
console.log(`\n로컬 MCP ${items.length}개  (${cfgPath})\n`);
for (const m of items) console.log(`  [${m.action.toUpperCase().padEnd(9)}] ${m.name}${m.url ? "  " + m.url : ""}\n              ${m.note}`);

const uploads = items.filter((m) => m.action === "upload");
const reconnect = items.filter((m) => m.action === "reconnect").map((m) => m.name);

if (!apply) {
  console.log(`\n(dry-run) 정적토큰 업로드 대상 ${uploads.length}개 — 실제 이관: --apply`);
  if (reconnect.length) console.log(`OAuth 재연결 필요(라이블리 웹 [연결]): ${reconnect.join(", ")}`);
  process.exit(0);
}
if (!gw || !tok) { console.error("게이트웨이 URL/토큰 없음 — env LIVELY_GATEWAY_URL/LIVELY_TOKEN 또는 ~/.lively/{gateway-url,token} 필요"); process.exit(1); }

let ok = 0;
for (const m of uploads) {
  const s = (cfg.mcpServers || {})[m.name] || {};
  const val = String((s.headers || {})[m.tokenHeader] || "").trim();
  if (!val) { console.log(`  · ${m.name}: 토큰 값 비어있음 — 건너뜀`); continue; }
  const kind = importedKind(m.name);
  const body = JSON.stringify({ kind, secret: val, meta: { auth_header: m.tokenHeader, token_prefix: "" }, label: `imported:${m.name}` });
  try {
    const res = await fetch(`${gw}/api/ui/me/credential`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body });
    if (res.ok) { ok++; console.log(`  ✓ ${m.name} → vault kind=${kind}  (값 미표시)`); }
    else console.log(`  ✗ ${m.name}: HTTP ${res.status}`);
  } catch (e) { console.log(`  ✗ ${m.name}: ${e && e.message}`); }
}
console.log(`\n업로드 ${ok}/${uploads.length}.`);
if (ok) console.log("관리자 등록(각 서버): 관리탭 ▸ MCP 서버 ▸ proxy · auth_mode=bearer · auth_kind=imported_<name> · url=<위 url> → 그래야 그 토큰으로 툴이 뜹니다.");
if (reconnect.length) console.log(`OAuth 커넥터는 이관 대신 라이블리 웹 [연결] 재수행: ${reconnect.join(", ")}`);
process.exit(0);

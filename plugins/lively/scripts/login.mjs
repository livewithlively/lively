#!/usr/bin/env node
// 플러그인 로그인(#1473) — 디바이스 코드 흐름으로 접속 토큰을 받아 `~/.lively/token` 에 굳힌다.
//
// 왜 필요한가: 플러그인은 `lively` CLI 를 깔지 못한다(PATH·bin 을 건드릴 수 없다). 그런데 훅과 MCP 헤더 헬퍼는
//   토큰 파일을 전제로 한다(이유는 bin/mcp-headers.mjs 주석 참조 — sensitive userConfig 는 훅 env 로 안 온다).
//   그래서 CLI 의 `lively login` 과 **같은 서버 흐름**(POST /cli/device/start → /cli/device/poll)을 이 스크립트가
//   자체완결로 재현한다. 서버 계약이 하나라 CLI 와 갈라질 여지가 없다.
//
// 사용: node <플러그인루트>/bin/login.mjs [게이트웨이주소]
//   주소를 안 주면 CLAUDE_PLUGIN_OPTION_GATEWAY_URL(플러그인 설정) → ~/.lively/gateway-url 순으로 찾는다.
// 토큰은 화면에 출력하지 않는다. 파일은 0600 으로 쓴다.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const LIVELY = join(homedir(), ".lively");
const readLocal = (f) => { try { return readFileSync(join(LIVELY, f), "utf8").trim() || null; } catch { return null; } };
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s256 = (v) => crypto.createHash("sha256").update(v).digest("base64url");

const gw = (process.argv[2] || process.env.CLAUDE_PLUGIN_OPTION_GATEWAY_URL || readLocal("gateway-url") || "")
  .trim().replace(/\/+$/, "").replace(/\/mcp$/, "");
if (!gw) die("게이트웨이 주소를 찾지 못했습니다 — 플러그인 설정(/plugin)에서 주소를 넣거나 인자로 주세요.");

// 소유권 규칙(session-preload 의 자격 미러와 동일 계약) — 키트가 깐 토큰은 건드리지 않는다.
//  키트가 설치돼 있으면 `lively login` 이 정식 경로다. 두 설치 경로를 섞으면 훅이 두 벌 돈다.
const markerPath = join(LIVELY, "plugin-managed.json");
const owned = (() => { try { const m = JSON.parse(readFileSync(markerPath, "utf8")); return Array.isArray(m?.files) ? m.files : []; } catch { return []; } })();
if (existsSync(join(LIVELY, "token")) && !owned.includes("token")) {
  die("이미 키트가 설치한 토큰이 있습니다 — 그 환경에서는 `lively login` 을 쓰세요(플러그인과 키트를 함께 쓰지 않습니다).");
}

const openBrowser = (url) => {
  // CLI 와 **같은 스위치**를 본다(#1717) — 서버 계약이 하나이듯 부작용 계약도 하나여야 갈라지지 않는다.
  //  사람이 안 보는 자리(테스트·CI)에서 남의 화면에 탭을 띄우지 않기 위한 것. URL·코드는 위에서 이미 찍었다.
  if (process.env.LIVELY_NO_BROWSER || process.env.CI) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try { spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref(); } catch { /* 부가기능 */ }
};

const verifier = crypto.randomBytes(32).toString("base64url");
const label = `claude-plugin@${String(hostname()).split(".")[0] || "내PC"}`;

let start;
try {
  const res = await fetch(`${gw}/cli/device/start`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code_challenge: s256(verifier), label }),
  });
  const text = await res.text();
  try { start = JSON.parse(text); } catch { die(`게이트웨이 응답을 이해하지 못했습니다(주소를 확인하세요): ${gw}`); }
  if (!res.ok || !start.device_code) die(`로그인을 시작하지 못했습니다 (HTTP ${res.status}) — 주소가 라이블리 게이트웨이가 맞는지 확인하세요.`);
} catch (e) {
  die(`게이트웨이에 연결하지 못했습니다 (${e.message}) — 주소·네트워크를 확인하세요: ${gw}`);
}

console.log(`\n라이블리 로그인  ${gw}`);
console.log("  아래 주소를 브라우저에서 열어 승인하세요:");
console.log(`    ${start.verification_uri}`);
console.log(`    코드: ${start.user_code}`);
openBrowser(start.verification_uri_complete || start.verification_uri);
console.log("  · 승인을 기다리는 중…");

let interval = Math.max(2, Number(start.interval) || 5);
const deadline = Date.now() + (Number(start.expires_in) || 900) * 1000;
for (;;) {
  await sleep(interval * 1000);
  if (Date.now() > deadline) die("코드가 만료됐습니다 — 다시 실행하세요.");
  let status, body;
  try {
    const res = await fetch(`${gw}/cli/device/poll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: start.device_code, code_verifier: verifier }),
    });
    status = res.status;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = null; }
  } catch { status = 0; body = null; }             // 일시 오류(게이트웨이 재시작 등) → 계속 폴
  if (status === 200 && body?.token) {
    mkdirSync(LIVELY, { recursive: true });
    writeFileSync(join(LIVELY, "token"), body.token + "\n");
    try { chmodSync(join(LIVELY, "token"), 0o600); } catch { /* 권한 설정 실패는 비치명 */ }
    if (!existsSync(join(LIVELY, "gateway-url"))) writeFileSync(join(LIVELY, "gateway-url"), gw + "\n");
    const files = [...new Set([...owned, "token", "gateway-url"])];
    writeFileSync(markerPath, JSON.stringify({ files }, null, 2) + "\n");
    console.log("\n✓ 로그인됐습니다. 새 세션을 열면 조직 맥락과 스킬이 함께 옵니다.");
    process.exit(0);
  }
  if (status === 202) continue;                                                    // 승인 대기
  if (status === 429) { interval = (Number(body?.interval) || interval) + 5; continue; } // 폴 간격 상향
  if (status === 403) die("승인이 거부됐습니다.");
  if (status === 410 || status === 401) die("코드가 만료됐습니다 — 다시 실행하세요.");
  // 그 외(0·5xx) = 일시 오류 → 계속 폴
}

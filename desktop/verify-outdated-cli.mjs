// 구 CLI 가 깔린 PC 에서 앱이 스스로 알아채는가 (#1541) — **수동 실행**(Electron 필요).
//   실행:  cd desktop && node verify-outdated-cli.mjs
//
// 왜 따로 있나: 이건 신규 설치가 아니라 **가장 흔한 실사용 경로**다 — 앱보다 먼저 CLI 를 깔아 둔 PC
//  (=지금까지 CLI 로 쓰던 모든 사람). 그 구 CLI 는 `--json-events` 를 조용히 무시하고 exit 0 으로 끝내서,
//  앱은 이벤트를 하나도 못 받고 아무 설명 없이 멈춘다. verify-app.mjs 는 **빈 홈**(새 PC)을 재므로 이 층을 못 본다.
//
// 판정: 화면이 '설치 완료' 라고 거짓말하지 않고 '업데이트 필요' 를 말하는가.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const DESKTOP = dirname(fileURLToPath(import.meta.url));
const require = createRequire(DESKTOP + "/package.json");
const electron = require("electron");
const WebSocket = createRequire(DESKTOP + "/../package.json")("ws");

let fail = 0;
const chk = (ok, l, d = "") => { console.log(`[${ok ? "PASS" : "FAIL"}] ${l}${d ? "\n        " + d : ""}`); if (!ok) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 구 CLI 가 깔린 홈을 만든다 ────────────────────────────────────────────────
// 구 CLI 의 본질적 성질만 흉내낸다: **모르는 플래그를 무시하고, 평범한 JSON 을 뱉고, 0 으로 끝난다.**
//  (실측으로 확인한 그 동작 — #1541 이전 kit/cli/lively.mjs 를 실제로 돌려 봤다.)
const BOX = mkdtempSync(join(tmpdir(), "lively-oldcli-"));
const BIN = join(BOX, ".lively", "bin");
mkdirSync(BIN, { recursive: true });
const isWin = process.platform === "win32";
const shim = join(BIN, isWin ? "lively.cmd" : "lively");
writeFileSync(shim, isWin
  ? "@echo off\r\necho {\"cli\":\"1.0.0\"}\r\nexit /b 0\r\n"
  : "#!/bin/sh\nprintf '{\"cli\":\"1.0.0\"}\\n'\nexit 0\n");
if (!isWin) chmodSync(shim, 0o755);
// 이 홈은 '이미 로그인·설치까지 끝난 것처럼' 보이게 둔다 — 그래야 종전 코드가 '설치 완료' 로 그리던
//  바로 그 상태가 되고, 이 검증이 실제 회귀를 잡는다.
writeFileSync(join(BOX, ".lively", "gateway-url"), "https://gw.example\n");
writeFileSync(join(BOX, ".lively", "token"), "dummy\n");
writeFileSync(join(BOX, ".lively", "kit-version"), "old000000\n");

const p = spawn(electron, [DESKTOP, "--remote-debugging-port=9334"], {
  env: { ...process.env, LIVELY_HOME: BOX, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
p.stdout.on("data", (d) => { out += d; });
p.stderr.on("data", (d) => { out += d; });

// 렌더러에 붙는다 — 타깃 목록에 뜨는 시점 ≠ 문서가 파싱된 시점이라 **폴링**한다.
let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500);
  try {
    const r = await fetch("http://127.0.0.1:9334/json/list");
    target = (await r.json()).find((t) => t.type === "page" && /index\.html/.test(t.url || ""));
  } catch { /* 아직 안 떴다 */ }
}
chk(!!target, "① 창이 떴다", target ? target.url : "원격 디버깅 타깃 없음");
if (!target) { p.kill(); rmSync(BOX, { recursive: true, force: true }); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.once("open", r));
let seq = 0;
const evaluate = (expr) => new Promise((resolve) => {
  const id = ++seq;
  const on = (raw) => {
    const m = JSON.parse(raw);
    if (m.id !== id) return;
    ws.off("message", on);
    resolve(m.result?.result?.value);
  };
  ws.on("message", on);
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
});

// 상태 폴링이 한 바퀴 돌 시간을 준다(구 CLI 를 실제로 띄워 봐야 판정이 나온다).
await sleep(4000);

const st = await evaluate("window.lively.getState().then(r=>JSON.stringify(r.state))");
let parsed = null; try { parsed = JSON.parse(st); } catch { /* */ }
chk(parsed?.cliFound === true, "② CLI 는 '있다'고 본다(파일은 실제로 있다)", `cliFound=${parsed?.cliFound}`);
chk(parsed?.cliOutdated === true, "③ ★ 그런데 '쓸 수 없다'는 것도 안다", `cliOutdated=${parsed?.cliOutdated}`);

const label = await evaluate("document.getElementById('status').textContent");
chk(/업데이트/.test(String(label)), "④ ★ 화면이 '설치 완료' 라고 거짓말하지 않는다", JSON.stringify(label));

// 빠져나갈 길 — 주소를 이미 아는데 다시 치게 하면 안 된다(프리필) + 버튼 문구가 무엇을 할지 말한다.
const gwShown = await evaluate("!document.getElementById('gw-card').classList.contains('hidden')");
chk(gwShown === true, "⑤ 업데이트로 이끄는 카드가 보인다", `보임=${gwShown}`);
const gwVal = await evaluate("document.getElementById('gw').value");
chk(gwVal === "https://gw.example", "⑥ 아는 주소는 채워 준다(다시 치게 하지 않는다)", JSON.stringify(gwVal));
const goLabel = await evaluate("document.getElementById('gw-go').textContent");
chk(/업데이트/.test(String(goLabel)), "⑦ 버튼이 무엇을 할지 말한다", JSON.stringify(goLabel));

// 평상시 화면(노드·점검)은 아직 뜨면 안 된다 — 눌러도 아무 일도 안 나는 버튼을 보여주는 셈이다.
const nodeHidden = await evaluate("document.getElementById('node-card').classList.contains('hidden')");
chk(nodeHidden === true, "⑧ 쓸 수 없는 상태에선 노드 카드를 안 보여준다", `hidden=${nodeHidden}`);

ws.close(); p.kill();
try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ }
await sleep(300);
console.log(`\n${fail === 0 ? "✓ 구 CLI 자가 인식 확인" : `✗ ${fail}건 실패`}`);
if (fail && out.trim()) console.log("--- electron 로그 ---\n" + out.slice(0, 800));
process.exit(fail === 0 ? 0 : 1);

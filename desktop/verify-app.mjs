// 데스크톱 앱 실동작 검증 (#1541 T2) — **수동 실행**(Electron 이 필요해 루트 테스트 체인엔 안 들어간다).
//   실행:  cd desktop && npm install && node verify-app.mjs
//
// 왜 필요한가: 부팅이 무오류라고 앱이 뜬 게 아니다(창이 안 떠도 무오류다). 원격 디버깅으로 렌더러에 붙어
//  DOM·preload 브리지·격리·IPC 왕복을 **부작용으로** 확인한다. desktop-core.test.mjs 가 못 덮는 마지막 층이다.
//
// 데스크톱 앱이 **실제로 뜨는가** — 부팅 무오류로는 부족하다(창이 안 떠도 무오류다).
//  원격 디버깅으로 렌더러에 붙어 DOM·preload 브리지·IPC 왕복을 직접 확인한다.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const DESKTOP = dirname(fileURLToPath(import.meta.url));
const require = createRequire(DESKTOP + "/package.json");
const electron = require("electron");
// ws 는 레포 루트에 이미 있다(게이트웨이가 쓴다) — 검증 하나 때문에 desktop 에 의존성을 늘리지 않는다.
const WebSocket = createRequire(DESKTOP + "/../package.json")("ws");

const BOX = mkdtempSync(join(tmpdir(), "lively-desktop-probe-"));
let fail = 0;
const chk = (ok, l, d = "") => { console.log(`[${ok ? "PASS" : "FAIL"}] ${l}${d ? "\n        " + d : ""}`); if (!ok) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// LIVELY_HOME 을 빈 폴더로 → '아무것도 설치 안 된 새 PC' 가 되어 앱이 창을 먼저 띄운다(첫 실행 경로).
const p = spawn(electron, [DESKTOP, "--remote-debugging-port=9333"], {
  env: { ...process.env, LIVELY_HOME: BOX, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });

let targets = [];
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    const r = await fetch("http://127.0.0.1:9333/json/list");
    if (r.ok) { targets = await r.json(); if (targets.some((t) => t.type === "page")) break; }
  } catch { /* 아직 안 뜸 */ }
}
const page = targets.find((t) => t.type === "page");
chk(!!page, "① 창(렌더러)이 실제로 떴다", page ? `title=${JSON.stringify(page.title)} url=${page.url.split("/").pop()}` : `타깃 ${targets.length}개: ${targets.map((t) => t.type).join(",")}`);
if (!page) { console.log(out.slice(0, 800)); p.kill(); rmSync(BOX, { recursive: true, force: true }); process.exit(2); }

// CDP 로 붙어 평가
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on("open", r));
let id = 0;
const pending = new Map();
ws.on("message", (m) => { const o = JSON.parse(m); const cb = pending.get(o.id); if (cb) { pending.delete(o.id); cb(o); } });
const evaluate = (expr) => new Promise((resolve) => {
  const n = ++id;
  pending.set(n, (o) => resolve(o.result?.result?.value ?? o.result?.result?.description ?? null));
  ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
});

// ⚠ 타깃이 목록에 뜨는 시점 ≠ 문서가 파싱된 시점이다. 안 기다리면 아래 전부가 산발적으로 빨간불이 된다
//  (실제로 첫 실행에서 document.title 이 "" 로 나와 제품 결함으로 오인할 뻔했다).
let ready = "";
for (let i = 0; i < 40; i++) { ready = await evaluate("document.readyState"); if (ready === "complete") break; await sleep(250); }
const title = await evaluate("document.title");
chk(ready === "complete" && title === "라이블리", "② 렌더러 문서가 로드됐다", `readyState=${ready} title=${JSON.stringify(title)}`);

const bridge = await evaluate("Object.keys(window.lively||{}).sort().join(',')");
const want = ["answer", "cancel", "getState", "onLog", "onProgress", "onState", "openExternal", "run", "setAppAutoLaunch", "setGateway"].join(",");
chk(bridge === want, "③ preload 브리지가 정확히 그 함수들만 노출한다", `실제=${bridge}`);

const noRaw = await evaluate("typeof window.require + '/' + typeof window.ipcRenderer + '/' + typeof window.process");
chk(noRaw === "undefined/undefined/undefined", "④ ★ 렌더러에 Node·ipcRenderer 원본이 없다(sandbox·contextIsolation)", `require/ipcRenderer/process = ${noRaw}`);

// IPC 왕복 — 메인이 실제로 응답하나(배선 확인). 빈 홈이라 cliFound 는 false 여야 정상.
const st = await evaluate("window.lively.getState().then(r=>JSON.stringify(r.state))");
let parsed = null; try { parsed = JSON.parse(st); } catch { /* */ }
chk(!!parsed && typeof parsed.cliFound === "boolean", "⑤ ★ IPC 왕복이 된다(렌더러 → 메인 → 응답)", st ? String(st).slice(0, 160) : "응답 없음");
chk(parsed?.cliFound === false, "⑥ 빈 홈에서는 'CLI 없음' 으로 판정(추측한 경로를 쓰지 않는다)", `cliFound=${parsed?.cliFound} cliPath=${parsed?.cliPath}`);

const statusText = await evaluate("document.getElementById('status').textContent");
chk(/CLI 없음/.test(String(statusText)), "⑦ 그 상태가 화면에 그려졌다", `status=${JSON.stringify(statusText)}`);
const gwVisible = await evaluate("!document.getElementById('gw-card').classList.contains('hidden')");
chk(gwVisible === true, "⑧ 첫 실행이면 게이트웨이 주소 입력이 먼저 보인다", `gw-card 표시=${gwVisible}`);

// 잘못된 주소를 넣으면 메인이 거부하나(렌더러가 argv 를 못 만든다는 계약의 실측)
const bad = await evaluate("window.lively.setGateway('--token X').then(r=>JSON.stringify(r))");
chk(/형식/.test(String(bad)), "⑨ ★ 렌더러가 준 이상한 주소를 메인이 거부한다", String(bad).slice(0, 140));

// ── T3 마법사 ───────────────────────────────────────────────────────────────
// 입력하는 동안 '무엇을 실행할지' 를 보여준다 — 설치는 원격 코드 실행이라 숨기면 안 된다.
await evaluate("(()=>{const i=document.getElementById('gw'); i.value='https://gw.example'; i.dispatchEvent(new Event('input')); return 1;})()");
const preview = await evaluate("document.getElementById('gw-preview').textContent");
chk(/gw\.example\/cli/.test(String(preview)), "⑩ 실행할 명령을 미리 보여준다", JSON.stringify(preview));

// 거부 사유는 로그가 아니라 **입력칸 옆**에 뜬다(사람이 보는 자리).
await evaluate("(()=>{const i=document.getElementById('gw'); i.value='ftp://nope'; i.dispatchEvent(new Event('input')); document.getElementById('gw-go').click(); return 1;})()");
await sleep(600);
const err = await evaluate("document.getElementById('gw-err').textContent");
chk(/형식/.test(String(err)), "⑪ 잘못된 주소는 입력칸 옆에서 알려준다", JSON.stringify(err));

// 아직 설치 전이면 완료 화면은 뜨지 않는다(앱 열 때마다 "설치 끝" 이 뜨면 소음이다).
const doneHidden = await evaluate("document.getElementById('done-card').classList.contains('hidden')");
chk(doneHidden === true, "⑫ 설치 전엔 완료 화면이 안 뜬다", `done-card hidden=${doneHidden}`);

ws.close(); p.kill();
try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ }
await sleep(300);
console.log(`\n${fail === 0 ? "✓ 앱 뼈대 실동작 확인" : `✗ ${fail}건 실패`}`);
if (out.trim()) console.log("--- electron 로그 ---\n" + out.slice(0, 600));
process.exit(fail === 0 ? 0 : 1);

// Windows 실기기 검증 (#1541 T2/T6) — **Windows 박스에서 실행**한다(맥에서는 안 돈다).
//   1) 맥에서: cd desktop && npx electron-builder --win --x64 --dir --publish never
//   2) release/win-unpacked 를 Windows 박스 C:\\agent\\win-unpacked 로 복사
//   3) Windows 에서: node verify-win-app.mjs
// 실측으로 잡은 것: 설치기 없는(--dir) 빌드에서 electron-updater 가 ENOENT app-update.yml 로 죽었다 → ⑤ 가 그 게이트.
//
// Windows 실기기에서 데스크톱 앱이 실제로 뜨는가 (#1541) — 원격 디버깅 타깃으로 판정.
//  ⚠ SSH 세션은 대화형 데스크톱이 아니다 — Electron 이 윈도우 스테이션을 못 잡으면 여기서 드러난다.
//  ⚠ 타깃이 목록에 뜨는 시점 ≠ 문서가 파싱된 시점이다(맥에서 실제로 오진할 뻔했다) → 제목은 폴링해서 읽는다.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = "C:\\agent\\win-unpacked\\Lively.exe";
const BOX = mkdtempSync(join(tmpdir(), "livelyapp-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const chk = (ok, l, d = "") => { console.log(`[${ok ? "PASS" : "FAIL"}] ${l}${d ? "  " + d : ""}`); if (!ok) fail++; };
const ps = (s) => new Promise((r) => {
  const q = spawn("powershell", ["-NoProfile", "-Command", s], { stdio: ["ignore", "pipe", "ignore"] });
  let o = ""; q.stdout.on("data", (d) => { o += d; }); q.on("close", () => r(o.trim()));
});
const targets = async () => { try { const r = await fetch("http://127.0.0.1:9345/json/list"); return r.ok ? await r.json() : []; } catch { return []; } };

const p = spawn(EXE, ["--remote-debugging-port=9345", "--no-sandbox"], { env: { ...process.env, LIVELY_HOME: BOX }, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
p.stdout.on("data", (d) => { log += d; }); p.stderr.on("data", (d) => { log += d; });
p.on("error", (e) => { log += "SPAWN ERR " + e.message; });

let page = null;
for (let i = 0; i < 50; i++) { await sleep(600); page = (await targets()).find((x) => x.type === "page"); if (page) break; }
chk(!!page, "① Windows 에서 앱 창이 뜬다", page ? "" : "타깃 없음 · 로그: " + log.slice(0, 400));

if (page) {
  // 제목은 문서 파싱이 끝나야 채워진다 — 채워질 때까지 폴링(최대 10초).
  let title = page.title;
  for (let i = 0; i < 20; i++) {
    if (title) break;
    await sleep(500);
    title = (await targets()).find((x) => x.type === "page")?.title || "";
  }
  chk(/라이블리|Lively/.test(title), "② 창 제목이 우리 앱(문서 로드 완료 후)", `title=${JSON.stringify(title)}`);
  chk(/index\.html/.test(page.url || ""), "③ 렌더러가 우리 HTML 을 로드", page.url);
}
const procs = await ps("@(Get-Process Lively -EA SilentlyContinue).Count");
chk(Number(procs) > 0, "④ 프로세스가 살아 있다(트레이 상주)", `Lively 프로세스 ${procs}개`);

// ★ 자동 업데이트가 **배포처 없는 빌드에서 시도하지 않는가** — 실기기가 잡았던 결함의 회귀 게이트.
chk(!/app-update\.yml/.test(log), "⑤ ★ 설치기 없는 빌드에서 업데이트를 시도하지 않는다(ENOENT 없음)",
  /app-update\.yml/.test(log) ? "여전히 시도한다" : "");

try { p.kill(); } catch { /* */ }
await ps("Get-Process Lively -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue");
try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ }
console.log(`\n${fail === 0 ? "✓ Windows 실기기에서 앱 실행 확인" : `✗ ${fail}건 실패`}`);
if (log.trim()) console.log("--- 앱 로그 ---\n" + log.slice(0, 600));
process.exit(fail ? 1 : 0);

// scripts/headless-chrome.mjs — 헤드리스 크롬으로 페이지 하나를 끝까지 돌리고 DOM 을 받는 한 벌 (#3890).
//
// 런타임 테스트(ctx-rclick-runtime · tab-landing)가 이 코드를 각자 복사해 들고 있었고, **같은 결함을 둘 다** 가졌다:
//  결과 표지를 받자마자 크롬을 SIGKILL 하고 곧바로 임시 프로필을 지우면, 크롬 보조 프로세스가 아직 프로필에
//  쓰는 판에 `rmSync` 가 ENOTEMPTY 로 던진다 — 그 자리가 `finally` 라 **단언을 하나도 못 돌린 채** 테스트가 죽는다.
//  실측(2026-09-11): ctx-rclick-runtime 을 동시 10개로 40회 돌리자 2회가 그렇게 죽었다(병렬 러너 -j 8 과 같은 부하).
//  그래서 한 자리로 모으고, 치우기를 셋으로 나눈다:
//   ① 파이프를 쥔 프로세스가 전부 끝나기를 잠깐 기다린다(`close` — 보조 프로세스도 파이프를 물려받아 쥔다)
//   ② 재시도하며 지운다   ③ 그래도 못 지우면 알리기만 한다(임시 디렉터리다 — 테스트를 실패시킬 이유가 없다).
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** 쓸 수 있는 크롬 — CHROME_BIN 이 먼저다. 없으면 null(호출자가 런타임 절을 건너뛴다). */
export function findChrome() {
  return CANDIDATES.filter(Boolean).find((p) => existsSync(p)) || null;
}

/**
 * `html` 을 임시 디렉터리의 page.html 로 쓰고(`copy` 의 파일은 같은 이름으로 옆에 둔다) 크롬 `--dump-dom` 으로 돌린다.
 *  stdout 에 `marker` 가 보이는 순간 끊는다 — ⚠ 종료를 기다리면 매달리는 페이지가 있다(ctx-rclick-runtime 실측:
 *  DOM 을 다 뱉고도 단독 2초, 러너 안에서는 45초 상한까지). 그 대기가 그대로 테스트 시간이 된다.
 * @returns dump 된 DOM — 표지 없이 끝났으면 그때까지 받은 것(판정은 호출자가 한다). 30초 안에 안 끝나면 던진다.
 */
export async function dumpDom(chrome, { html, copy = [], marker = "ENDRESULT", prefix = "headless-", virtualTimeBudget = 15000 }) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  let closed = Promise.resolve();
  try {
    for (const src of copy) copyFileSync(src, path.join(dir, path.basename(src)));
    writeFileSync(path.join(dir, "page.html"), html);
    return await new Promise((resolve, reject) => {
      const child = spawn(chrome, [
        "--headless=old", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
        // 신선한 프로필로 뜨면 크롬이 컴포넌트 갱신·백그라운드 네트워킹을 기다린다 — 전부 끈다
        "--disable-background-networking", "--disable-component-update", "--disable-sync",
        "--disable-default-apps", "--disable-extensions", "--metrics-recording-only", "--mute-audio",
        "--disable-client-side-phishing-detection", "--no-pings", "--disable-domain-reliability",
        "--disable-breakpad", "--disable-crash-reporter",
        // ⚠ user-data-dir 을 반드시 temp 로 — 없으면 크롬이 실 HOME 을 건드려 러너의 HOME 가드가 깨진다
        `--user-data-dir=${path.join(dir, "profile")}`,
        // --timeout 은 **실시간** 상한이다. 이게 없으면 페이지가 타이머를 계속 걸 때 가상시간이 더디게 흘러
        //  --virtual-time-budget 만으로는 안 끝난다(ctx-rclick-runtime 실측 90초).
        "--timeout=20000", `--virtual-time-budget=${virtualTimeBudget}`, "--dump-dom", `file://${path.join(dir, "page.html")}`,
      ], { env: { ...process.env, HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
      closed = new Promise((r) => child.once("close", r));
      let out = "", errOut = "", settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch (_) { /* 이미 끝났다 */ } fn(v); };
      const timer = setTimeout(() => done(reject, new Error("크롬이 30초 안에 결과를 안 냈다\n" + errOut.slice(0, 800))), 30_000);
      child.stdout.on("data", (b) => { out += b; if (out.includes(marker)) done(resolve, out); });
      child.stderr.on("data", (b) => { errOut += b; });
      child.on("error", (e) => done(reject, e));
      child.on("close", () => done(resolve, out));
    });
  } finally {
    await new Promise((r) => { const t = setTimeout(r, 3000); closed.then(() => { clearTimeout(t); r(); }); });
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (e) { console.log(`note  임시 디렉터리를 못 지웠습니다(${e.code}) — ${dir}`); }
  }
}

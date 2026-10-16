// scripts/headless-chrome.mjs — 헤드리스 크롬으로 페이지 하나를 끝까지 돌리고 DOM 을 받는 한 벌 (#3890).
//
// 런타임 테스트(ctx-rclick-runtime · tab-landing)가 이 코드를 각자 복사해 들고 있었고, **같은 결함을 둘 다** 가졌다:
//  결과 표지를 받자마자 크롬을 SIGKILL 하고 곧바로 임시 프로필을 지우면, 크롬 보조 프로세스가 아직 프로필에
//  쓰는 판에 `rmSync` 가 ENOTEMPTY 로 던진다 — 그 자리가 `finally` 라 **단언을 하나도 못 돌린 채** 테스트가 죽는다.
//  실측(2026-09-11): ctx-rclick-runtime 을 동시 10개로 40회 돌리자 2회가 그렇게 죽었다(병렬 러너 -j 8 과 같은 부하).
//  그래서 한 자리로 모으고, 치우기를 셋으로 나눈다:
//   ① 파이프를 쥔 프로세스가 전부 끝나기를 잠깐 기다린다(`close` — 보조 프로세스도 파이프를 물려받아 쥔다)
//   ② 재시도하며 지운다   ③ 그래도 못 지우면 알리기만 한다(임시 디렉터리다 — 테스트를 실패시킬 이유가 없다).
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
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
 * 가상 시간 «숨 고르기» 자리 — 페이지 html 에 이 글자가 있으면 dumpDom 이 127.0.0.1 에 작은 서버를 띄우고
 *  그 주소로 바꿔 싣는다. 페이지는 기다리는 자리(폴링·고정 대기)마다 이 주소를 진짜 fetch 로 한 번 부른다.
 *
 *  왜: `--virtual-time-budget` 의 가상 시간은 **진짜 비동기**(blob 읽기 · createImageBitmap · canvas.toBlob)를
 *   기다려 주지 않는다. 그동안 페이지가 sleep(20) 으로 폴링하면 가상 시계만 빨리 흘러, 4초(가상) 대기가 실시간
 *   수십 ms 만에 끝난다 — 부하가 걸린 CI 에서는 그 사이 작업이 안 끝나 시험이 빨갛다(side-files-finder R23·R28).
 *   타이머 없이 진짜 비동기만 기다리면 가상 시계가 예산 끝으로 뛰어 결과를 쓰기 전에 DOM 을 뜬다(PENDING).
 *   크롬은 **네트워크 요청이 걸려 있는 동안 가상 시간을 멈춘다**(pauseIfNetworkFetchesPending) — 대기마다 실시간
 *   몇 ms 짜리 요청을 끼우면 가상 대기 한도가 실시간 진척과 함께 간다(실측 2026-10-14: blob 읽기 8MB×20 을
 *   4초 폴링이 sleep(20) 만으로는 놓쳤고 · 요청을 끼우니 360ms(가상)에 잡았다 · headless-chrome-breathe.test.mjs).
 *  페이지는 가짜 서버로 window.fetch 를 바꾸기 **전에** 진짜 fetch 를 쥐어 둬야 한다.
 */
export const BREATHE_URL = "__LV_BREATHE_URL__";
const BREATHE_MS = 5;   // 한 번 숨 고를 때 실시간으로 쉬는 몫 — 작업이 다른 스레드에서 진척할 틈

async function startBreather() {
  const srv = http.createServer((q, r) => {
    setTimeout(() => { r.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" }); r.end("ok"); }, BREATHE_MS);
  });
  await new Promise((res, rej) => { srv.once("error", rej); srv.listen(0, "127.0.0.1", res); });
  return {
    url: `http://127.0.0.1:${srv.address().port}/breathe`,
    close: () => { try { srv.closeAllConnections(); } catch (_) { /* 이미 닫혔다 */ } srv.close(); },
  };
}

/** dumpDom serve — 그 디렉터리의 파일만(이름 하나 — 하위 경로 없음) 내어 주는 정적 서버. 쿼리는 무시한다(액자 주소의 ?session=… 등). */
async function startStatic(dir) {
  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  const srv = http.createServer((q, r) => {
    let name = "";
    try { name = path.basename(decodeURIComponent(new URL(q.url || "/", "http://x").pathname)); } catch (_) { name = ""; }
    const f = name ? path.join(dir, name) : "";
    if (!f || !existsSync(f)) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
    r.end(readFileSync(f));
  });
  await new Promise((res, rej) => { srv.once("error", rej); srv.listen(0, "127.0.0.1", res); });
  return {
    url: `http://127.0.0.1:${srv.address().port}/`,
    close: () => { try { srv.closeAllConnections(); } catch (_) { /* 이미 닫혔다 */ } srv.close(); },
  };
}

/**
 * `html` 을 임시 디렉터리의 page.html 로 쓰고(`copy` 의 파일은 같은 이름으로 옆에 둔다) 크롬 `--dump-dom` 으로 돌린다.
 *  stdout 에 `marker` 가 보이는 순간 끊는다 — ⚠ 종료를 기다리면 매달리는 페이지가 있다(ctx-rclick-runtime 실측:
 *  DOM 을 다 뱉고도 단독 2초, 러너 안에서는 45초 상한까지). 그 대기가 그대로 테스트 시간이 된다.
 *  serve — 참이면 그 임시 디렉터리를 127.0.0.1 의 작은 정적 서버로 내어 http 로 싣는다(#4794). file:// 로 실으면 크롬이
 *   문서마다 출처를 갈라(액자의 location.origin 은 "file://" · 받는 쪽 ev.origin 은 "null") 같은 출처 액자·대상 출처를 지정한
 *   postMessage 를 잴 수 없다 — 세션 화면과 터미널 액자가 주고받는 시험이 그렇다. 기본은 종전 그대로(file://).
 * @returns dump 된 DOM — 표지 없이 끝났으면 그때까지 받은 것(판정은 호출자가 한다). 30초 안에 안 끝나면 던진다.
 */
export async function dumpDom(chrome, { html, copy = [], marker = "ENDRESULT", prefix = "headless-", virtualTimeBudget = 15000, args = [], serve = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  let closed = Promise.resolve();
  let breather = null;
  let server = null;
  try {
    if (html.includes(BREATHE_URL)) { breather = await startBreather(); html = html.split(BREATHE_URL).join(breather.url); }
    for (const src of copy) copyFileSync(src, path.join(dir, path.basename(src)));
    writeFileSync(path.join(dir, "page.html"), html);
    if (serve) server = await startStatic(dir);
    const pageUrl = server ? server.url + "page.html" : `file://${path.join(dir, "page.html")}`;
    return await new Promise((resolve, reject) => {
      const child = spawn(chrome, [
        "--headless=old", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
        // ⚠ 맥에서 세션(launchd Background 도메인)이 새 프로필로 크롬을 띄우면 «키체인 발견할 수 없음» 모달이 **사람 화면**에
        //  뜰 수 있다(지식 headless-chrome-keychain-dialog-macos) — OS 키체인 대신 목 키체인·기본 저장소를 쓴다.
        "--use-mock-keychain", "--password-store=basic",
        // 신선한 프로필로 뜨면 크롬이 컴포넌트 갱신·백그라운드 네트워킹을 기다린다 — 전부 끈다
        "--disable-background-networking", "--disable-component-update", "--disable-sync",
        "--disable-default-apps", "--disable-extensions", "--metrics-recording-only", "--mute-audio",
        "--disable-client-side-phishing-detection", "--no-pings", "--disable-domain-reliability",
        "--disable-breakpad", "--disable-crash-reporter",
        // ⚠ user-data-dir 을 반드시 temp 로 — 없으면 크롬이 실 HOME 을 건드려 러너의 HOME 가드가 깨진다
        `--user-data-dir=${path.join(dir, "profile")}`,
        // --timeout 은 **실시간** 상한이다. 이게 없으면 페이지가 타이머를 계속 걸 때 가상시간이 더디게 흘러
        //  --virtual-time-budget 만으로는 안 끝난다(ctx-rclick-runtime 실측 90초).
        //  args — 부르는 쪽이 더하는 인자(예: `--window-size=1400,900` — 넓은 폭 미디어 쿼리를 재야 하는 시험, #4443).
        ...args,
        "--timeout=20000", `--virtual-time-budget=${virtualTimeBudget}`, "--dump-dom", pageUrl,
      ], { env: { ...process.env, HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
      closed = new Promise((r) => child.once("close", r));
      let out = "", errOut = "", settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch (_) { /* 이미 끝났다 */ } fn(v); };
      const timer = setTimeout(() => done(reject, new Error("크롬이 30초 안에 결과를 안 냈다\n" + errOut.slice(0, 800))), 30_000);
      //  ⚠ 글자로 받는다(setEncoding) — 조각(Buffer)마다 따로 바꾸면 조각 경계에 걸친 한글이 깨진다
      //   (CI 실측 2026-10-09: «기타» → «���타», session-history-side-runtime H9 가 무작위로 빨갰다 · headless-chrome-decode.test.mjs).
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (b) => { out += b; if (out.includes(marker)) done(resolve, out); });
      child.stderr.on("data", (b) => { errOut += b; });
      child.on("error", (e) => done(reject, e));
      child.on("close", () => done(resolve, out));
    });
  } finally {
    breather?.close();
    server?.close();
    await new Promise((r) => { const t = setTimeout(r, 3000); closed.then(() => { clearTimeout(t); r(); }); });
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (e) { console.log(`note  임시 디렉터리를 못 지웠습니다(${e.code}) — ${dir}`); }
  }
}

/**
 * dump 된 DOM 에서 `<pre id="out">` 의 결과 본문을 꺼내 엔티티를 되돌린다.
 *  ⚠ 본문은 `[^<]` 로만 잡는다 — `[\s\S]*?` 로 잡으면 페이지가 결과를 쓰기 전에 덤프됐을 때(본문이 아직 PENDING)
 *   `</pre>` 를 넘어 인라인 스크립트 속 marker 문자열까지 건너가 그 사이 HTML 을 결과로 집는다. 그러면 «결과 없음» 이
 *   JSON 파싱 오류로 둔갑해 원인을 가린다. 텍스트 노드의 `<` 는 직렬화에서 `&lt;` 가 되므로 결과 본문에 `<` 는 없다.
 *  여는 태그에 속성이 붙어도 된다(`<pre id="out" style="…">` — 화면 밖으로 치운 결과 칸). `[^>]*` 는 태그 밖으로 못 나간다.
 * @returns {{ text: string | null, out: string | null }} text = 결과 본문(marker 앞까지) · 못 찾으면 null 이고
 *   out 에 `<pre id="out">` 의 지금 내용(예: "PENDING")을 실어 호출자가 실패 사유로 쓰게 한다.
 */
export function readOut(dom, marker = "ENDRESULT") {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<pre id="out"[^>]*>([^<]*?)${esc}`).exec(dom);
  if (m) return { text: decodeText(m[1]), out: null };
  const p = /<pre id="out"[^>]*>([^<]*)/.exec(dom);
  return { text: null, out: p ? decodeText(p[1]) : null };
}

function decodeText(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, "\u00a0").replace(/&amp;/g, "&");
}

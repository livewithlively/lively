#!/usr/bin/env node
// 앱↔CLI 계약(#1541 T1) 통합 — **실제 CLI 프로세스**를 띄워 stdout NDJSON 계약을 잰다.
//  json-events.test.mjs 가 인코딩·채널 층을 덮고, 여긴 "진짜로 그렇게 나오나"(배선)를 본다.
//  실제 ~/.lively 는 안 건드린다(LIVELY_HOME 샌드박스). 네트워크는 127.0.0.1 픽스처뿐.
//
// ⚠ CLI 는 **비동기(spawn)** 로 띄운다 — 픽스처 게이트웨이가 이 프로세스에서 도니까 동기 실행으로 막으면
//  이벤트 루프가 멈춰 자식의 fetch 가 전부 타임아웃하고, 무동작을 기대하는 케이스가 공허하게 통과한다.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closedPath, writeStubBin, noBrowserEnv, sandboxEnv, WIN } from "../testlib/os-sandbox.mjs";   // 실제 claude·codex 를 PATH 에서 가린다(#1431 관례)

const CLI = join(fileURLToPath(import.meta.url), "..", "lively.mjs");
// 플러그인 로그인 — CLI 와 **같은 서버 흐름**을 자체완결로 재현하는 스크립트(#1473). D8 에서 '터미널형' 경로의
//  표본으로 쓴다: PROMPTER 개념이 없어 언제나 자기가 브라우저를 열고, 끄는 수단은 LIVELY_NO_BROWSER 뿐이다.
const PLUGIN_LOGIN = join(fileURLToPath(import.meta.url), "..", "..", "..", "plugins", "lively", "scripts", "login.mjs");
const BOX = mkdtempSync(join(tmpdir(), "lively-ev-test-"));

// ── 브라우저 가로채기 — 이 파일은 device-code 로그인을 **실 프로세스로** 여러 번 완주시킨다. CLI 는 승인 URL 을
//  `open`(darwin)·`xdg-open`(linux) 으로 띄우므로 막지 않으면 **사람의 진짜 브라우저에** 픽스처 URL 탭이 뜬다
//  (#1717). PATH 만으론 못 막으니(closedPath 가 /usr/bin 을 남긴다 — os-sandbox.mjs noBrowserEnv 주석) 스텁으로
//  가로채고, 호출 여부까지 **세어서** 아래 D8 이 판정한다. 가로채기가 있어 억제가 깨져도 실 탭은 안 뜬다(이중 방어).
//  윈도우는 cmd.exe 를 가로채지 않는다(그 자리를 스텁으로 덮으면 다른 시스템 호출까지 먹는다) → D8 은 스킵.
const BIN = join(BOX, "bin");
const BROWSER_CMD = process.platform === "darwin" ? "open" : "xdg-open";
const OPENED = join(BOX, "browser-opened.log");
if (!WIN) {
  writeStubBin(BIN, BROWSER_CMD, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(OPENED)}, process.argv.slice(2).join(" ") + "\\n");`);
}
const openedCount = () => (existsSync(OPENED) ? readFileSync(OPENED, "utf8").split("\n").filter((l) => l.trim()).length : 0);
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

const TOKEN = "lvk_test_secret_do_not_leak_0123456789";
const USER_CODE = "WXYZ-8899";

// ── 픽스처 게이트웨이 — device-code 로그인 최소 구현 ─────────────────────────
let approved = false;
const srv = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (path === "/cli/device/start") { return json(200, { device_code: "dev-abc", user_code: USER_CODE, verification_uri: "http://127.0.0.1/device", verification_uri_complete: "http://127.0.0.1/device?c=" + USER_CODE, interval: 1, expires_in: 900 }); }
  if (path === "/cli/device/poll") {
    if (!approved) { approved = true; return json(202, { error: "authorization_pending" }); }  // 한 번은 대기 → 승인 대기 단계가 실제로 관측된다
    return json(200, { token: TOKEN, scopes: ["read"] });
  }
  if (path === "/api/ui/me/profile") { return json(200, { id: "yoon", display_name: "윤상민", email: "yoon@lively.kr" }); }
  return json(404, { error: "not found" });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${srv.address().port}`;

/**
 * CLI 1회 실행. answers: prompt 이벤트를 받아 답(value)을 돌려주는 함수(undefined 면 무응답).
 * closeStdinOnPrompt: 답 대신 stdin 을 닫는다(= 앱이 죽은 상황 재현).
 * allowBrowser: 브라우저 억제를 끈다 — D8 의 **대조군 전용**(스텁 가로채기가 살아 있는지 확인). 평시엔 끄지 않는다.
 *   ⚠ 안 얹는 것만으론 부족해 **명시적으로 지운다**: 러너가 자식 env 에 LIVELY_NO_BROWSER=1 을 미리 걸고(#1717
 *   run-tests.mjs), CI 러너엔 CI=1 이 있다. 그대로 상속하면 대조군이 조용히 억제돼 D8-a 가 깨지고,
 *   그러면 D8-b 의 '0건' 도 근거를 잃는다(실측: 단독 실행은 통과 · `npm test` 경로에서만 exit 1).
 * ⚠ killed 를 함께 돌려준다 — 타임아웃 SIGKILL 로 끝난 걸 '정상 종료'로 읽으면 무한대기 결함을 놓친다.
 */
function runCli(args, { home, answers, closeStdinOnPrompt = false, timeoutMs = 20000, cliPath = CLI, allowBrowser = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cliPath, ...args], {
      // PATH: 닫힌 PATH — 사람의 로컬 하네스 설치·MCP 설정에 결과와 시간이 의존하지 않게(#1431).
      // DISPLAY 는 **일부러 세운다** — linux 의 헤드리스 no-op 에 가려지면 "억제가 먹어서 0건"인지
      //  "$DISPLAY 가 없어서 0건"인지 구분이 안 돼 D8 이 공허해진다(darwin·win 은 무시하는 값).
      env: { ...process.env, PATH: closedPath(BIN), LIVELY_HOME: home || join(BOX, "h"), LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "", NO_COLOR: "1", DISPLAY: ":0", ...(allowBrowser ? { LIVELY_NO_BROWSER: "", CI: "" } : noBrowserEnv()) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "", buf = "", killed = false;
    const events = [];
    const timer = setTimeout(() => { killed = true; try { p.kill("SIGKILL"); } catch { /* */ } }, timeoutMs);
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => {
      out += d; buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let e = null;
        try { e = JSON.parse(line); } catch { /* NDJSON 이 아닌 줄 — events 에 안 담고 out 으로만 남긴다 */ }
        if (e) {
          events.push(e);
          if (e.t === "prompt") {
            if (closeStdinOnPrompt && e.kind === "confirm") { try { p.stdin.end(); } catch { /* */ } }
            else if (answers) {
              const v = answers(e);
              if (v !== undefined) { try { p.stdin.write(JSON.stringify({ t: "answer", id: e.id, value: v }) + "\n"); } catch { /* */ } }
            }
          }
        }
      }
    });
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, killed, out, err, events, lines: out.split("\n").filter((l) => l.trim()) }); });
  });
}

/**
 * 플러그인 로그인 1회. CLI 와 달리 이벤트·프롬프트가 없어 **터미널형 부작용**을 그대로 낸다.
 * ⚠ 이 스크립트는 LIVELY_HOME 이 아니라 homedir() 를 본다 — 홈 격리는 sandboxEnv 로 해야 실기기를 안 건드린다.
 */
function runPluginLogin(home, { noBrowser }) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [PLUGIN_LOGIN, GW], {
      env: {
        ...process.env, ...sandboxEnv({ home }), PATH: closedPath(BIN), NO_COLOR: "1", DISPLAY: ":0",
        CLAUDE_PLUGIN_OPTION_GATEWAY_URL: "",
        ...(noBrowser ? noBrowserEnv() : { LIVELY_NO_BROWSER: "", CI: "" }),   // 대조군은 러너·CI 의 억제를 명시적으로 지운다
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* */ } }, 20000);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// ── D1. 플래그가 없으면 stdout 은 종전대로 비어 있다 ─────────────────────────
{
  const r = await runCli(["version"]);
  check("D1 --json-events 없으면 stdout 0바이트(기존 파이프 사용처 무회귀)", r.out === "", `stdout=${JSON.stringify(r.out.slice(0, 120))}`);
  check("D1-b 사람용 출력은 stderr 로 그대로 나온다", /lively \d/.test(r.err), `stderr=${JSON.stringify(r.err.slice(0, 120))}`);
}

// ── D2. start 로 시작해 end 로 끝난다 ───────────────────────────────────────
{
  const r = await runCli(["version", "--json-events"]);
  const first = r.events[0], last = r.events[r.events.length - 1];
  check("D2 첫 이벤트는 start(cmd·cli 포함)", first?.t === "start" && first.cmd === "version" && !!first.cli, JSON.stringify(first));
  check("D2-b 마지막 이벤트는 end", last?.t === "end", JSON.stringify(last));
  check("D2-c 모든 줄이 유효 NDJSON(비-JSON 오염 0)", r.events.length === r.lines.length, `줄 ${r.lines.length} vs 이벤트 ${r.events.length}`);
  check("D2-d 모든 이벤트에 봉투(v·t·ts)", r.events.every((e) => e.v === 1 && e.t && typeof e.ts === "number"), "봉투 누락");
  // ★ killed 를 함께 본다 — 이벤트 모드는 답을 받으려고 stdin 을 열어 두는데, 끝나고 그 핸들을 놓지 않으면
  //  **명령이 성공 보고를 하고도 프로세스가 안 죽는다**(앱이 영원히 매달린다). 종료코드만 보면 안 잡힌다.
  check("D3 성공은 end.ok=true·code=0 이고 종료코드와 일치", last?.ok === true && last?.code === 0 && r.code === 0, `end=${JSON.stringify(last)} exit=${r.code}`);
  check("D3-a ★ 끝나면 스스로 종료한다(stdin 핸들을 놓는다 — 강제종료 아님)", !r.killed, "타임아웃 SIGKILL 로 끝났다 = 무한대기");
}

// ── D3. 실패도 반드시 end 로 닫는다(앱이 종료코드만으로 추측하지 않게) ───────
{
  const r = await runCli(["zzz-unknown", "--json-events"]);
  const last = r.events[r.events.length - 1];
  check("D3-b 알 수 없는 명령 → end.ok=false 이고 code 가 종료코드와 일치", last?.t === "end" && last.ok === false && last.code === r.code && r.code !== 0,
    `end=${JSON.stringify(last)} exit=${r.code}`);
}
{
  // die() 경로 — 게이트웨이 주소 없이 login. 사람용 메시지가 notice(error)로도 나가야 GUI 가 이유를 보여준다.
  const r = await runCli(["login", "--json-events"]);
  const last = r.events[r.events.length - 1];
  const notice = r.events.find((e) => e.t === "notice" && e.level === "error");
  check("D4 die 는 notice(error) + end(ok=false) 를 남기고 죽는다", !!notice && last?.t === "end" && last.ok === false && last.code === r.code,
    `notice=${JSON.stringify(notice)} end=${JSON.stringify(last)} exit=${r.code}`);
  check("D4-b 같은 문구가 stderr 에도 그대로 있다(터미널·GUI 둘 다 벙어리 아님)", /게이트웨이 주소가 없습니다/.test(r.err), r.err.slice(-200));
  check("D4-c 이벤트 문구엔 ANSI 색코드가 없다", !!notice && !/\[/.test(notice.message), JSON.stringify(notice?.message));
}

// ── D5. --json 결과는 raw 가 아니라 result 이벤트로 ──────────────────────────
{
  const r = await runCli(["status", "--json", "--json-events"]);
  const res = r.events.find((e) => e.t === "result");
  check("D5 status --json 은 result 이벤트로 실린다", !!res && !!res.data && typeof res.data.cli === "string", JSON.stringify(res)?.slice(0, 160));
  check("D5-b stdout 에 NDJSON 아닌 줄이 섞이지 않는다", r.events.length === r.lines.length, `줄 ${r.lines.length} vs 이벤트 ${r.events.length}`);
}

// ── D6·D7. device-code 로그인 — GUI 가 대신 물어보고, 토큰은 절대 안 샌다 ────
{
  const home = join(BOX, "login-home");
  const seen = [];
  const r = await runCli(["login", "--gateway", GW, "--json-events"], {
    home,
    answers: (e) => { seen.push(e); return e.kind === "confirm" ? true : undefined; },
  });
  const dev = seen.find((e) => e.kind === "device-code");
  check("D7 --json-events 면 TTY 없이도 대화형 — '비대화형' 으로 안 죽는다", !/비대화형/.test(r.err), r.err.slice(-200));
  check("D6 device-code 가 이벤트로 온다(user_code·verification_uri)", dev?.user_code === USER_CODE && /device/.test(dev?.verification_uri || ""), JSON.stringify(dev));
  check("D6-b device_code(비밀)는 이벤트에 안 실린다", !r.out.includes("dev-abc"), "device_code 유출");
  const confirm = seen.find((e) => e.kind === "confirm");
  check("D6-c 신원확인이 prompt 로 GUI 에 올라온다", !!confirm && /윤상민|yoon/.test(confirm.label || ""), JSON.stringify(confirm));
  const approve = r.events.filter((e) => e.t === "step" && e.id === "device-approve");
  check("D6-d 승인 대기 단계가 start→done 으로 보고된다", approve.length === 2 && approve[0].status === "start" && approve[1].status === "done", JSON.stringify(approve));
  check("D6-e ★ 토큰이 stdout 에 한 글자도 안 나온다", !r.out.includes(TOKEN), "토큰 유출 — 앱 로그·크래시 리포트로 자격이 샌다");
  const tokenFile = join(home, ".lively", "token");
  check("D6-f 그래도 로그인은 실제로 완료됐다(배선 확인 — 토큰 파일)", existsSync(tokenFile) && readFileSync(tokenFile, "utf8").trim() === TOKEN,
    `exists=${existsSync(tokenFile)}`);
  check("D6-g 정상 종료(end.ok=true) + 스스로 종료", r.events[r.events.length - 1]?.ok === true && r.code === 0 && !r.killed, `exit=${r.code} killed=${r.killed}`);
}

// ── C4 통합 — 앱이 죽어 답이 안 오면 기본값 승인이 아니라 실패한다 ──────────
{
  approved = false;
  const home = join(BOX, "noanswer-home");
  const r = await runCli(["login", "--gateway", GW, "--json-events"], { home, closeStdinOnPrompt: true, timeoutMs: 20000 });
  const tokenFile = join(home, ".lively", "token");
  check("C4-통합 ★ 확인 중 앱이 끊기면 토큰을 저장하지 않는다(fail-closed)", !existsSync(tokenFile), "무응답인데 로그인이 저장됐다");
  check("C4-b 그리고 실패로 끝난다(성공으로 위장하지 않는다)", r.code !== 0 && !r.killed, `exit=${r.code} killed=${r.killed}`);
}

// ── D8. ★ 로그인이 실행한 사람의 브라우저를 열지 않는다(#1717) ──────────────
// 두 경로를 **따로** 잰다 — 원인이 다르면 처방도 다르고, 한쪽만 보면 다른 쪽이 조용히 열린다.
//  · 터미널형(플러그인 로그인): 여는 게 정상이다. 끄는 수단은 LIVELY_NO_BROWSER 하나뿐.
//  · 앱 모드(--json-events): 이벤트를 받은 앱이 shell.openExternal 로 연다(desktop/main/main.mjs 의 askUser)
//    → **CLI 는 열면 안 된다.** 둘 다 열면 같은 URL 탭이 두 개 뜬다.
// 터미널형이 대조군을 겸한다: 거기서 실제로 1건이 잡혀야 나머지 '0건'들이 공허하지 않다
//  (os-sandbox.mjs 머리 주석 ②의 함정 — 가로채기가 조용히 실패하면 아무것도 안 잡히고 전부 통과한다).
if (WIN) {
  console.log("skip D8 — 윈도우는 cmd.exe 를 가로채지 않는다(억제·중복회피 코드 자체는 플랫폼 공통이다)");
} else {
  approved = false;
  let base = openedCount();
  const opened = await runPluginLogin(join(BOX, "plugin-open"), { noBrowser: false });
  // openBrowser 는 detached·unref 라 프로세스 종료와 스텁의 기록 사이에 레이스가 있다 — 늘 때까지 기다린다.
  for (let i = 0; i < 60 && openedCount() === base; i++) await new Promise((r) => setTimeout(r, 50));
  check("D8-a 대조군: 터미널형 경로는 실제로 브라우저를 연다(= 가로채기가 살아 있다)",
    openedCount() > base, `호출 ${openedCount() - base}건 exit=${opened.code} — 여기서 0 이면 아래 판정은 전부 공허하다`);

  approved = false;
  base = openedCount();
  const quiet = await runPluginLogin(join(BOX, "plugin-quiet"), { noBrowser: true });
  await new Promise((r) => setTimeout(r, 1000));      // 대조군과 같은 여유를 주고도 0 이어야 한다
  check("D8-b ★ LIVELY_NO_BROWSER 를 켜면 터미널형 경로도 안 연다",
    openedCount() === base, `호출 ${openedCount() - base}건 exit=${quiet.code}`);

  approved = false;
  base = openedCount();
  const home = join(BOX, "app-mode");
  // ★ 억제를 **꺼고도** 0 이어야 한다 — 여기서 안 여는 이유는 억제가 아니라 '앱이 열기 때문' 이다.
  const r = await runCli(["login", "--gateway", GW, "--json-events"],
    { home, answers: (e) => (e.kind === "confirm" ? true : undefined), allowBrowser: true });
  await new Promise((res) => setTimeout(res, 1000));
  check("D8-c ★ 앱이 몰 때는 CLI 가 안 연다(앱이 연다 — 둘 다 열면 같은 URL 탭이 두 개)",
    openedCount() === base, `호출 ${openedCount() - base}건 — main.mjs 의 askUser 와 중복된다`);
  check("D8-d 안 여는 것과 못 하는 것은 다르다 — 로그인은 그대로 완주한다",
    r.code === 0 && existsSync(join(home, ".lively", "token")), `exit=${r.code}`);
}

// ── B. ★ 부트스트랩 단계 — lively.mjs **한 파일만** 있어도 동작하나 ─────────
// 부트스트랩은 게이트웨이의 `/cli/lively.mjs` 한 파일만 내려받아 `lively setup` 을 실행한다(lively.mjs 맨 위 불변식).
//  형제 모듈이 필요한 코드를 그 경로에 두면 **설치 이전 명령이 통째로 깨진다** — 그리고 그건 데스크톱 앱이
//  이 계약을 가장 필요로 하는 순간이다(실측: ERR_MODULE_NOT_FOUND json-events.mjs → 설치 마법사가 첫 단계에서 멈춤).
//  그래서 파일 하나만 떼어 낸 환경에서 직접 돌려 본다.
{
  const solo = mkdtempSync(join(BOX, "solo-"));
  copyFileSync(CLI, join(solo, "lively.mjs"));
  const r = await runCli(["version", "--json-events"], { cliPath: join(solo, "lively.mjs") });
  const first = r.events[0], last = r.events[r.events.length - 1];
  check("B1 ★ lively.mjs 단독(형제 모듈 0개)에서도 --json-events 가 동작한다",
    first?.t === "start" && last?.t === "end" && last.ok === true && r.code === 0,
    `events=${r.events.length} first=${first?.t} last=${JSON.stringify(last)} exit=${r.code}\n${r.err.slice(-300)}`);
  check("B1-b 형제 모듈을 찾지 못했다는 오류가 없다", !/ERR_MODULE_NOT_FOUND|Cannot find module/.test(r.err), r.err.slice(-200));
}

srv.close();
try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ }
console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// 온보딩 이음매 e2e (#1541 T3) — **앱의 구동기(cli-runner)가 진짜 lively CLI 를 몰아** 로그인을 완주하는가.
//
// 왜 이 층이 필요한가: 스텁 spawn 테스트는 "앱이 이벤트를 잘 읽는가"까지만 본다. 진짜 CLI 와 붙여 봐야
//  ① 이벤트 순서·형태가 실제로 그런가 ② 프롬프트에 답하면 CLI 가 실제로 진행하는가 ③ 앱이 답을 안 주면
//  실제로 fail-closed 인가를 안다. GUI 없이 그 seam 만 정확히 잰다(Electron 불요 → 루트 테스트 체인에서 돈다).
//
// 실제 ~/.lively 는 안 건드린다(LIVELY_HOME 샌드박스). 네트워크는 127.0.0.1 픽스처뿐.
// PATH: 실제 하네스를 가린다(#1431 관례 — CLI 를 프로세스로 띄우므로).
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, reduceProgress } from "./cli-runner.mjs";
import { argvFor } from "./ipc-contract.mjs";
import { closedPath, writeStubBin, noBrowserEnv, WIN } from "../../kit/testlib/os-sandbox.mjs";

const CLI = join(fileURLToPath(import.meta.url), "..", "..", "..", "kit", "cli", "lively.mjs");
const BOX = mkdtempSync(join(tmpdir(), "lively-onboard-e2e-"));

// 브라우저 가로채기 — 이 파일도 device-code 로그인을 **실 프로세스로** 세 번 완주시킨다(#1717).
//  1차 방어는 억제 env(noBrowserEnv), 2차가 이 스텁이다: 억제가 깨져도 사람 화면 대신 여기 기록만 남고
//  아래 ⑫ 가 그걸 잡는다. 억제 자체의 본 판정은 kit/cli/lively-json-events.test.mjs 의 D8(대조군 포함)이 한다.
const BIN = join(BOX, "bin");
const OPENED = join(BOX, "browser-opened.log");
if (!WIN) {
  writeStubBin(BIN, process.platform === "darwin" ? "open" : "xdg-open",
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(OPENED)}, process.argv.slice(2).join(" ") + "\\n");`);
}
// POSIX 에선 억제를 **끄고** 돌린다 — 그래야 ⑫ 의 '0건' 이 "억제 덕분" 이 아니라 "앱이 몰 때 CLI 는 안 연다"는
//  증거가 된다(러너·CI 가 걸어 둔 값을 상속하지 않도록 명시적으로 비운다). 혹시 열어도 스텁이 받아 실 탭은 없다.
//  윈도우는 cmd.exe 를 안 가로채므로 실기기 보호를 우선해 억제를 유지한다(그쪽 판정은 ⑫ 를 건너뛴다).
const BROWSER_ENV = WIN ? noBrowserEnv() : { LIVELY_NO_BROWSER: "", CI: "" };
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, c, why) => (c ? ok(n) : bad(n, why || "조건 불만족"));

const TOKEN = "lvk_e2e_secret_never_in_events";
const USER_CODE = "QRST-4455";
let pollCount = 0;
const srv = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const json = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (path === "/cli/device/start") return json(200, { device_code: "dc-1", user_code: USER_CODE, verification_uri: "http://127.0.0.1/d", verification_uri_complete: "http://127.0.0.1/d?c=" + USER_CODE, interval: 1, expires_in: 900 });
  if (path === "/cli/device/poll") return ++pollCount < 2 ? json(202, { error: "authorization_pending" }) : json(200, { token: TOKEN, scopes: ["read"] });
  if (path === "/api/ui/me/profile") return json(200, { id: "yoon", display_name: "윤상민", email: "yoon@lively.kr" });
  return json(404, { error: "not found" });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${srv.address().port}`;

/** 앱이 실제로 하는 그대로 — argvFor 로 인자를 만들고 runCli 로 몬다. */
function driveLogin(home, { answer = true, ignorePrompt = false } = {}) {
  const seen = [];
  let prog = null;
  return runCli({
    cli: process.execPath,
    // ⚠ 앱은 `lively` 심을 띄우지만 테스트는 node + lively.mjs 로 같은 코드를 띄운다(심 설치를 전제하지 않게).
    args: [CLI, ...argvFor("login", { gateway: GW })],
    // DISPLAY 를 일부러 세운다 — linux 의 헤드리스 no-op 에 가려지면 ⑫ 의 '0건'이 억제 덕인지 구분되지 않는다.
    env: { ...process.env, PATH: closedPath(BIN), LIVELY_HOME: home, LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "", NO_COLOR: "1", DISPLAY: ":0", ...BROWSER_ENV },
    onEvent: (e) => { prog = reduceProgress(prog, e); },
    onPrompt: (p) => { seen.push(p); if (ignorePrompt) return undefined; return p.kind === "confirm" ? answer : undefined; },
    timeoutMs: 30_000,
  }).then((r) => ({ ...r, seen, prog }));
}

// ── ① 사람이 '예' → 로그인 완주 ─────────────────────────────────────────────
{
  const home = join(BOX, "yes");
  const r = await driveLogin(home);
  check("① 앱 구동기가 진짜 CLI 로그인을 완주한다", r.ok === true, `error=${r.error}\n${r.stderr.slice(-300)}`);
  const dev = r.seen.find((p) => p.kind === "device-code");
  check("② device-code 가 앱까지 온다(코드·주소)", dev?.user_code === USER_CODE && !!dev?.verification_uri, JSON.stringify(dev));
  const cf = r.seen.find((p) => p.kind === "confirm");
  check("③ 신원확인이 앱까지 온다(사람 이름이 보인다)", /윤상민|yoon/.test(cf?.label || ""), JSON.stringify(cf));
  check("④ ★ 토큰은 이벤트 어디에도 없다", !JSON.stringify(r.events).includes(TOKEN), "토큰이 이벤트 스트림에 실렸다");
  const tok = join(home, ".lively", "token");
  check("⑤ 그래도 로그인은 실제로 됐다(부작용: 토큰 파일)", existsSync(tok) && readFileSync(tok, "utf8").trim() === TOKEN, `exists=${existsSync(tok)}`);
  check("⑥ 진행 상태가 '승인 대기 → 완료' 로 그려진다", r.prog?.steps?.some((s) => s.id === "device-approve" && s.status === "done"), JSON.stringify(r.prog?.steps));
  check("⑦ end 로 정상 종료(강제종료 아님)", r.signal === null && r.code === 0, `code=${r.code} signal=${r.signal}`);
}

// ── ② 사람이 '아니오' → 저장하지 않는다 ─────────────────────────────────────
{
  pollCount = 0;
  const home = join(BOX, "no");
  const r = await driveLogin(home, { answer: false });
  check("⑧ '아니오' 면 로그인이 저장되지 않는다", !existsSync(join(home, ".lively", "token")), "거부했는데 저장됐다");
  check("⑨ 그리고 실패로 끝난다(성공으로 위장 안 함)", r.ok === false && r.code !== 0, `ok=${r.ok} code=${r.code} error=${r.error}`);
}

// ── ③ 앱이 답을 안 주면 fail-closed ─────────────────────────────────────────
{
  pollCount = 0;
  const home = join(BOX, "silent");
  // 답을 안 주고 **취소**(stdin 닫기) — 앱이 죽거나 사용자가 창을 닫은 상황.
  const seen = [];
  const r = await runCli({
    cli: process.execPath,
    args: [CLI, ...argvFor("login", { gateway: GW })],
    env: { ...process.env, PATH: closedPath(BIN), LIVELY_HOME: home, LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "", NO_COLOR: "1", DISPLAY: ":0", ...BROWSER_ENV },
    onPrompt: (p) => { seen.push(p); return undefined; },
    onHandle: (h) => { setTimeout(() => h.cancel(), 4000); },
    timeoutMs: 30_000,
  });
  check("⑩ ★ 답 없이 끊기면 토큰을 저장하지 않는다(fail-closed)", !existsSync(join(home, ".lively", "token")), "무응답인데 저장됐다");
  check("⑪ 그 사실이 실패로 보고된다", r.ok === false, `ok=${r.ok} error=${r.error}`);
}

// ── ⑫ 부작용 — 위 세 번의 로그인이 사람 화면에 탭을 띄우지 않았다(#1717) ────
{
  const opened = !WIN && existsSync(OPENED) ? readFileSync(OPENED, "utf8").trim() : "";
  // 억제를 끈 상태다 — 그래도 0 이어야 한다. 여는 쪽은 앱(main.mjs 의 askUser → shell.openExternal)이고,
  //  CLI 까지 열면 같은 URL 탭이 두 개 뜬다(#1717).
  if (!WIN) check("⑫ 앱이 CLI 를 세 번 모는 동안 CLI 는 브라우저를 안 열었다(여는 건 앱 몫)", !opened, `열린 URL: ${opened.slice(0, 200)}`);
}

srv.close();
try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ }
console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);

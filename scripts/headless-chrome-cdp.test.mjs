// scripts/headless-chrome-cdp.test.mjs — launchCdp(scripts/headless-chrome.mjs) 계약.
//
// 정책은 하나다: **띄운 프로세스가 어떤 식으로 끝나든 크롬은 남지 않는다.**
//  종전 방식(`--remote-debugging-port`)으로 띄운 크롬은 띄운 프로세스가 SIGKILL·상한·세션 종료로 죽으면 살아남았다 —
//  치우기가 호출자의 `finally` 한 곳뿐이었기 때문이다(실측 2026-11-23: 부모가 죽은 헤드리스 크롬 3개가 34시간 떠 있었고
//  그 박스의 스왑 16GB 가 다 찼다).
//
//  E1  띄우고 식을 돌린다                         E7  크롬이 먼저 죽으면 명령은 매달리지 않고 던진다
//  E2  치우면 크롬도 임시 디렉터리도 없다           E8  크롬 실행파일이 없으면 던지고 임시 디렉터리를 안 남긴다
//  E3  두 번 치워도 된다                          E9  페이지 대상이 상한 안에 안 서면 던지고 아무것도 안 남긴다
//  E4  띄운 프로세스가 SIGKILL → 크롬이 끝난다       E10 크고 한글인 답이 안 깨진다
//  E5  띄운 프로세스가 치우기 없이 exit → 끝난다     E11 호출자가 준 임시 디렉터리를 쓰고 · 치운다
//  E6  대조: 종전 방식은 같은 SIGKILL 뒤 살아 있다   E12 정적: scripts/ 에 종전 방식으로 띄우는 코드가 없다
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findChrome, launchCdp } from "./headless-chrome.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 살아 있나 — 끝났는데 아직 안 거둬진 프로세스(좀비)는 «끝났다» 로 센다. 컨테이너 러너처럼 PID 1 이 고아를 안 거두는 자리에서
 *   신호 0 은 좀비에게도 성공해, 스스로 끝난 크롬이 «살아 있다» 로 보인다. */
const alive = (pid) => {
  try { process.kill(pid, 0); } catch (_) { return false; }
  try { return !/^Z/.test(execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()); } catch (_) { return false; }
};
const goneWithin = async (pid, ms) => { const t0 = Date.now(); while (alive(pid) && Date.now() - t0 < ms) await sleep(100); return !alive(pid); };
/** 그 임시 디렉터리를 프로필로 쥔 프로세스 수 — pid 를 모르는 자리(띄우다 던진 판)에서 «크롬이 안 남았다» 를 잰다. */
const holding = (dir) => execFileSync("ps", ["-axo", "args="], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter((l) => l.includes(dir)).length;
const settleWithin = (p, ms) => Promise.race([p.then(() => "resolved", () => "rejected"), sleep(ms).then(() => "hung")]);
let pass = 0, fail = 0;
//  멈추지 않고 센다 — fail-first 에서 빨간 줄이 다 보이게.
const ok = (cond, name, info) => { if (cond) { pass++; console.log(`ok  ${name}  ${JSON.stringify(info)}`); } else { fail++; console.error(`FAIL  ${name}  ${JSON.stringify(info)}`); } };
const finish = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };

// ── E12 정적 ───────────────────────────────────────────────────────────────────
{
  //  이 파일은 대조(E6)로 종전 인자를 직접 쓴다 — 자기 자신만 뺀다. 주석 줄은 세지 않는다.
  const PORT_FLAG = "--remote-debugging-" + "port";
  const self = path.basename(fileURLToPath(import.meta.url));
  const files = readdirSync(HERE, { recursive: true }).map(String)
    .filter((f) => /\.(mjs|js|ts)$/.test(f) && !f.split(path.sep).includes("node_modules") && path.basename(f) !== self);
  const hits = files.filter((f) => readFileSync(path.join(HERE, f), "utf8").split("\n").some((line) => line.includes(PORT_FLAG) && !/^\s*(\/\/|\*)/.test(line)));
  ok(files.length > 50, "E12 관측 장치 — scripts/ 의 파일을 실제로 훑었다", { files: files.length });
  ok(hits.length === 0, "E12 scripts/ 에 종전 방식(포트)으로 크롬을 띄우는 코드가 없다", { hits });
}

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 런타임 절(E1~E11)을 건너뜁니다(CHROME_BIN 으로 지정)"); finish(); }

// ── E1·E2·E3·E10 ───────────────────────────────────────────────────────────────
{
  const b = await launchCdp(chrome, { prefix: "cdp-test-", args: ["--no-sandbox"] });
  const BIG = "가나다라마바사".repeat(40000);
  let value, han;
  const hadDir = existsSync(b.dir), wasAlive = alive(b.child.pid);
  try {
    value = (await b.cdp("Runtime.evaluate", { expression: "6 * 7", returnByValue: true })).result?.result?.value;
    han = (await b.cdp("Runtime.evaluate", { expression: "'가나다라마바사'.repeat(40000)", returnByValue: true })).result?.result?.value;
  } finally { await b.close(); }
  ok(value === 42 && /\d+\.\d+/.test(String(b.version)), "E1 띄우고 식을 돌린다", { value, version: b.version });
  ok(han === BIG, "E10 크고 한글인 답이 안 깨진다", { length: han?.length, want: BIG.length });
  ok(hadDir && wasAlive && !alive(b.child.pid) && !existsSync(b.dir) && holding(b.dir) === 0, "E2 치우면 크롬도 임시 디렉터리도 없다", { hadDir, wasAlive, alive: alive(b.child.pid), dir: existsSync(b.dir), holding: holding(b.dir) });
  ok(await settleWithin(b.close(), 5000) === "resolved", "E3 두 번 치워도 된다", {});
}

// ── E7 크롬이 먼저 죽는다 ────────────────────────────────────────────────────────
{
  const b = await launchCdp(chrome, { prefix: "cdp-test-", args: ["--no-sandbox"] });
  let during, after;
  try {
    const hanging = b.cdp("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true });
    await sleep(200);
    process.kill(b.child.pid, "SIGKILL");
    during = await settleWithin(hanging, 5000);
    after = await settleWithin(b.cdp("Runtime.evaluate", { expression: "1" }), 5000);
  } finally { await b.close(); }
  ok(during === "rejected" && after === "rejected", "E7 크롬이 먼저 죽으면 걸려 있던 명령도 그 뒤 명령도 던진다", { during, after });
}

// ── E8 크롬 실행파일이 없다 ──────────────────────────────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "cdp-test-nochrome-"));
  const r = await settleWithin(launchCdp(path.join(dir, "no-such-chrome"), { dir, startTimeoutMs: 5000 }), 15_000);
  ok(r === "rejected" && !existsSync(dir), "E8 크롬 실행파일이 없으면 던지고 임시 디렉터리를 안 남긴다", { r, dir: existsSync(dir) });
  rmSync(dir, { recursive: true, force: true });
}

// ── E11 호출자가 준 디렉터리 ─────────────────────────────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "cdp-test-given-"));
  const b = await launchCdp(chrome, { dir, args: ["--no-sandbox"] });
  let seen;
  try { seen = holding(dir); } finally { await b.close(); }
  ok(b.dir === dir && seen > 0 && !existsSync(dir), "E11 호출자가 준 임시 디렉터리를 크롬이 프로필로 쓰고 · 치우기가 지운다", { same: b.dir === dir, seen, dir: existsSync(dir) });
  rmSync(dir, { recursive: true, force: true });
}

// ── E9 페이지 대상이 안 선다 ─────────────────────────────────────────────────────
{
  //  상한은 짧게(3초) — 크롬이 그 안에 답을 못 해도(부하) 기대는 같다: 던지고 · 아무것도 안 남긴다.
  const dir = mkdtempSync(path.join(tmpdir(), "cdp-test-nopage-"));
  const r = await settleWithin(launchCdp(chrome, { dir, args: ["--no-sandbox"], pickPage: () => false, startTimeoutMs: 3000 }), 20_000);
  await sleep(500);
  ok(r === "rejected" && holding(dir) === 0 && !existsSync(dir), "E9 페이지 대상이 상한 안에 안 서면 던지고 크롬도 임시 디렉터리도 안 남긴다", { r, holding: holding(dir), dir: existsSync(dir) });
  rmSync(dir, { recursive: true, force: true });
}

// ── E4·E5·E6 띄운 프로세스가 치우기 없이 끝난다 ─────────────────────────────────────
/** 크롬을 띄우고 `{ pid, dir }` 한 줄을 낸 뒤 그대로 머무는 프로세스. 죽이는 건 부르는 쪽이다. */
async function holder(code) {
  const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  p.stdout.setEncoding("utf8");
  const info = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("띄우는 프로세스가 60초 안에 크롬 pid 를 안 냈다")), 60_000);
    p.stdout.on("data", (b) => { out += b; const m = /^(\{.*\})$/m.exec(out); if (m) { clearTimeout(t); resolve(JSON.parse(m[1])); } });
    p.once("close", (c) => { clearTimeout(t); reject(new Error("띄우는 프로세스가 먼저 끝났다 — code " + c)); });
  });
  return { p, ...info };
}
const sweep = async (pid, dir) => {
  if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch (_) { /* 이미 끝났다 */ } await goneWithin(pid, 3000); }
  await sleep(300);
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { console.log(`note  임시 디렉터리를 못 지웠습니다(${e.code}) — ${dir}`); }
};
const helperUrl = pathToFileURL(path.join(HERE, "headless-chrome.mjs")).href;
//  stdin 에 한 줄이 오면 치우기 없이 스스로 끝난다(E5). 안 오면 머문다(E4 — 밖에서 SIGKILL).
const WITH_HELPER = `
  import { launchCdp } from ${JSON.stringify(helperUrl)};
  const b = await launchCdp(${JSON.stringify(chrome)}, { prefix: "cdp-test-orphan-", args: ["--no-sandbox"] });
  console.log(JSON.stringify({ pid: b.child.pid, dir: b.dir }));
  process.stdin.once("data", () => process.exit(0));
  setInterval(() => {}, 1000);`;

{
  const h = await holder(WITH_HELPER);
  let before, gone;
  try { before = alive(h.pid); h.p.kill("SIGKILL"); gone = await goneWithin(h.pid, 10_000); }
  finally { await sweep(h.pid, h.dir); }
  ok(before && gone, "E4 띄운 프로세스가 SIGKILL 로 죽으면 크롬이 10초 안에 끝난다", { before, gone });
}
{
  const h = await holder(WITH_HELPER);
  let before, gone;
  try { before = alive(h.pid); h.p.stdin.write("exit\n"); gone = await goneWithin(h.pid, 10_000); }
  finally { await sweep(h.pid, h.dir); try { h.p.kill("SIGKILL"); } catch (_) { /* 이미 끝났다 */ } }
  ok(before && gone, "E5 띄운 프로세스가 치우기 없이 스스로 끝나도 크롬이 10초 안에 끝난다", { before, gone });
}
{
  const dir = mkdtempSync(path.join(tmpdir(), "cdp-test-port-"));
  const h = await holder(`
    import { spawn } from "node:child_process";
    import { existsSync } from "node:fs";
    const dir = ${JSON.stringify(dir)};
    const c = spawn(${JSON.stringify(chrome)}, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--use-mock-keychain", "--password-store=basic", "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--disable-default-apps", "--disable-extensions", "--mute-audio", "--disable-breakpad",
      "--user-data-dir=" + dir + "/profile", "--remote-debugging-port=0", "about:blank"], { env: { ...process.env, HOME: dir }, stdio: ["ignore", "ignore", "ignore"] });
    for (let i = 0; i < 600 && !existsSync(dir + "/profile/DevToolsActivePort"); i++) await new Promise((r) => setTimeout(r, 50));
    console.log(JSON.stringify({ pid: c.pid, dir }));
    setInterval(() => {}, 1000);`);
  let before, survived;
  try { before = alive(h.pid); h.p.kill("SIGKILL"); await sleep(3000); survived = alive(h.pid); }
  finally { await sweep(h.pid, h.dir); }
  ok(before && survived, "E6 대조 — 종전 방식(포트)으로 띄운 크롬은 같은 SIGKILL 뒤에도 살아 있다", { before, survived });
  ok(!alive(h.pid) && !existsSync(dir), "E6 대조에 쓴 크롬과 임시 디렉터리를 치웠다", { alive: alive(h.pid), dir: existsSync(dir) });
}

finish();

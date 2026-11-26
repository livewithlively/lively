// scripts/headless-chrome.mjs 의 **치우기** 계약 (#3890) — 가짜 크롬으로 결정적으로 잰다.
//
// 무엇이 문제였나: 런타임 테스트가 결과 표지를 받자마자 크롬을 SIGKILL 하고 곧바로 임시 프로필을 지웠다.
//  크롬 보조 프로세스는 부모의 파이프를 물려받아 쥔 채 잠깐 더 살며 프로필에 쓴다 — 그 사이에 지우면 ENOTEMPTY 로
//  `finally` 가 던져 **단언을 하나도 못 돌린 채** 테스트가 죽었다. 실측: ctx-rclick-runtime 동시 10 × 40회 중 2회.
//  진짜 크롬으로는 드물게만 나서(같은 조건 80회 0건인 판도 있었다) 회귀를 못 잡는다 — 그래서 **보조 프로세스를
//  흉내 내는 가짜 크롬**으로 그 경주를 매번 만든다.
//
// 표(행 = 시나리오):
//  H1 표지가 오면 받은 DOM 을 돌려주고 임시 디렉터리를 지운다
//  H2 표지 뒤에도 보조 프로세스가 프로필에 계속 쓴다 → 던지지 않고, 끝난 뒤 디렉터리가 사라져 있다   ← 이번 결함
//  H3 표지 없이 끝나면 받은 것을 그대로 돌려준다(판정은 호출자 몫) — 던지지 않는다
//  H4 보조 프로세스가 파이프를 오래 쥐어도 기다림은 상한이 있다(끝없이 매달리지 않는다)
//  H5 끝내 못 지우는 디렉터리면 알리기만 하고 던지지 않는다(임시 디렉터리 때문에 테스트를 죽이지 않는다)
//  H6 예열(warmChrome) — 예열 표지가 오면 ok · 표지 없이 끝나거나 크롬이 안 뜨면 ok=false 로 알리고 **던지지 않는다**
//     (러너는 예열이 실패해도 시험을 그대로 띄운다 — 판정은 시험이 제 상한으로 한다)
//  H6‴ 예열을 거두면(signal) 매달린 크롬을 죽이고 곧바로 ok=false — 러너가 중단·--fail-fast 에서 남은 예열을 안 기다린다
//  H7 진짜 크롬이 있으면 — 예열 페이지가 정말 표지를 낸다(페이지가 깨지면 예열이 매번 «실패» 로 헛돌아도 시험은 초록이다)
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dumpDom, findChrome, warmChrome, WARM_MARK } from "./headless-chrome.mjs";

if (process.platform === "win32") { console.log("skip  가짜 크롬은 셔뱅 실행이라 POSIX 전용"); process.exit(0); }

let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };

//  보조 프로세스 흉내 — 부모 stdout 을 물려받아 쥔다(부모를 SIGKILL 해도 산다).
//   writer: 프로필 안에 파일을 쉬지 않고 만든다(크롬이 캐시·상태를 쓰는 모양) · holder: 쓰지 않고 쥐고만 있다.
const HELPER = `
const fs = require('fs'); const path = require('path');
const [profile, mode, ms] = process.argv.slice(1);
if (mode === 'holder') { setTimeout(() => {}, Number(ms)); }
else {
  //  ⚠ 한 층씩 만든다(recursive 금지) — 호출자가 프로필을 지운 뒤 되살려 임시 디렉터리를 새게 하지 않으려고.
  const d1 = path.join(profile, 'Default'), d2 = path.join(d1, 'Cache');
  const end = Date.now() + Number(ms);
  let i = 0;
  while (Date.now() < end) {
    try { fs.mkdirSync(d1); } catch (_) {}
    try { fs.mkdirSync(d2); } catch (_) {}
    try { fs.writeFileSync(path.join(d2, 'f' + (i++)), 'x'); } catch (_) {}
  }
}`;
const FAKE_SRC = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : ''; };
const profile = arg('--user-data-dir');
const mode = process.env.FAKE_MODE || 'plain';
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'Local State'), '{}');
if (mode === 'locked') { const d = path.join(profile, 'locked'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'f'), 'x'); fs.chmodSync(d, 0o000); }
if (mode === 'writer') {
  spawn(process.execPath, ['-e', ${JSON.stringify(HELPER)}, profile, 'writer', '1500'], { stdio: ['ignore', 'inherit', 'inherit'] });
  //  보조 프로세스가 **실제로 쓰기 시작한 뒤에** 표지를 낸다 — 진짜 크롬도 DOM 을 뱉을 땐 보조 프로세스가 이미 돌고 있다.
  const first = path.join(profile, 'Default', 'Cache', 'f0');
  const until = Date.now() + 5000;
  while (!fs.existsSync(first) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
if (mode === 'holder') spawn(process.execPath, ['-e', ${JSON.stringify(HELPER)}, profile, 'holder', '5000'], { stdio: ['ignore', 'inherit', 'inherit'] });
if (mode === 'hang') { setTimeout(() => {}, 60000); return; }   // 아무것도 안 낸 채 매달린다 — 첫 기동이 막힌 크롬 흉내
process.stdout.write('DIR=' + path.dirname(profile) + '\\n' + (mode === 'nomarker' ? 'NO-MARKER' : mode === 'warm' ? '<pre id="out">' + process.env.FAKE_PRINT + '</pre>' : '<pre>RESULT[]ENDRESULT</pre>') + '\\n');
if (mode === 'nomarker') process.exit(0);
setTimeout(() => {}, 20000);   // 진짜 크롬처럼 다 뱉고도 매달린다 — 호출자가 SIGKILL 로 끊는다
`;

const bin = mkdtempSync(path.join(tmpdir(), "fake-chrome-"));
const fake = path.join(bin, "fake-chrome.cjs");
writeFileSync(fake, FAKE_SRC);
chmodSync(fake, 0o755);
const dirOf = (dom) => (/DIR=(.+)\n/.exec(dom) || [])[1] || "";

async function run(mode) {
  process.env.FAKE_MODE = mode;
  const t0 = Date.now();
  try {
    const dom = await dumpDom(fake, { html: "<p>page</p>", prefix: "hc-test-" });
    return { dom, dir: dirOf(dom), ms: Date.now() - t0, threw: null };
  } catch (e) {
    return { dom: "", dir: "", ms: Date.now() - t0, threw: e };
  } finally {
    delete process.env.FAKE_MODE;
  }
}

try {
  const h1 = await run("plain");
  ok(!h1.threw && h1.dom.includes("RESULT[]ENDRESULT"), "H1 표지가 오면 받은 DOM 을 돌려준다", String(h1.threw || ""));
  ok(!!h1.dir && !existsSync(h1.dir), "H1′ [배선] 돌려준 뒤 임시 디렉터리가 지워져 있다", h1.dir);

  const h2 = await run("writer");
  ok(!h2.threw, "H2 표지 뒤에도 보조 프로세스가 프로필에 쓰고 있어도 던지지 않는다(단언 0개 종료가 없다)",
    h2.threw ? `${h2.threw.code || ""} ${h2.threw.message}` : "");
  ok(!!h2.dir && !existsSync(h2.dir), "H2′ 보조 프로세스가 끝난 뒤 임시 디렉터리가 사라져 있다", h2.dir);

  const h3 = await run("nomarker");
  ok(!h3.threw && h3.dom.includes("NO-MARKER") && !h3.dom.includes("ENDRESULT"), "H3 표지 없이 끝나면 받은 것을 그대로 돌려준다", String(h3.threw || ""));

  //  H5 — 권한을 막은 하위 디렉터리(루트는 권한을 무시하므로 건너뛴다). 알림은 console.log 로 나간다.
  if (process.getuid && process.getuid() === 0) console.log("skip  H5 — 루트는 디렉터리 권한을 무시한다");
  else {
    const said = [];
    const log = console.log;
    console.log = (...a) => { said.push(a.join(" ")); };
    let h5;
    try { h5 = await run("locked"); } finally { console.log = log; }
    ok(!h5.threw && h5.dom.includes("ENDRESULT"), "H5 끝내 못 지우는 디렉터리면 던지지 않고 받은 DOM 을 돌려준다", String(h5.threw || ""));
    ok(said.some((l) => l.startsWith("note") && l.includes(h5.dir)), "H5′ 대신 못 지운 자리를 알린다", JSON.stringify(said));
    if (h5.dir) { try { chmodSync(path.join(h5.dir, "profile", "locked"), 0o755); } catch (_) { /* 이미 없다 */ } rmSync(h5.dir, { recursive: true, force: true }); }
  }

  const h4 = await run("holder");
  ok(!h4.threw && h4.ms < 4500, "H4 파이프를 오래 쥔 보조 프로세스가 있어도 기다림에 상한이 있다(5초를 다 기다리지 않는다)", `${h4.ms}ms`);

  {
    const warmWith = async (mode, bin = fake) => {
      Object.assign(process.env, { FAKE_MODE: mode, FAKE_PRINT: WARM_MARK });
      try { return await warmChrome(bin); } catch (e) { return { threw: e }; } finally { delete process.env.FAKE_MODE; delete process.env.FAKE_PRINT; }
    };
    const w1 = await warmWith("warm");
    ok(w1.ok === true && w1.note === "" && w1.ms >= 0, "H6 예열 표지가 오면 ok", JSON.stringify(w1));
    const w2 = await warmWith("nomarker");
    ok(!w2.threw && w2.ok === false && /표지/.test(w2.note), "H6′ 표지 없이 끝나면 ok=false — 던지지 않는다", JSON.stringify(w2));
    const w3 = await warmWith("warm", path.join(bin, "no-such-chrome"));
    ok(!w3.threw && w3.ok === false && w3.note.length > 0, "H6″ 크롬이 안 뜨면 ok=false 와 까닭 — 던지지 않는다", JSON.stringify(w3));
    process.env.FAKE_MODE = "hang";
    const ac = new AbortController();
    const tA = Date.now();
    setTimeout(() => ac.abort(), 300);
    let w4;
    try { w4 = await warmChrome(fake, { signal: ac.signal }); } catch (e) { w4 = { threw: e }; } finally { delete process.env.FAKE_MODE; }
    ok(!w4.threw && w4.ok === false && /abort/.test(w4.note) && Date.now() - tA < 5000, "H6‴ 예열을 거두면 매달린 크롬을 죽이고 곧바로 ok=false", `${Date.now() - tA}ms ${JSON.stringify(w4)}`);
  }
  {
    const real = findChrome();
    if (!real) console.log("skip  H7 — 진짜 크롬이 없다(CHROME_BIN 으로 지정)");
    else {
      const w = await warmChrome(real);
      ok(w.ok === true, "H7 진짜 크롬에서 예열 페이지가 표지를 낸다", JSON.stringify(w));
    }
  }
} finally {
  rmSync(bin, { recursive: true, force: true });
}

console.log(`\n${pass} passed`);

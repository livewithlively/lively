#!/usr/bin/env node
// #3904 실기기 하네스 — 윈도우 노드(psmux)에서 웹터미널 입력 줄이 **pane 에 무엇으로·언제 도착하나**.
//
//  왜 이걸 재나: 제품(src/terminal/terminal-pty.ts psmuxInputLines)은 한글·이모지를 psmux CLI 프로세스 대신
//   제어 스트림 `send-keys -N 1 -t <id> 0x…` 한 줄로 보낸다. `-N 1` 이 psmux 제어 모드의 send 합치기(3.3.7 에서
//   UTF-8 을 두 번 인코딩하던 자리)를 건너뛴다는 것은 **소스 판독**이다. 판독은 근거일 뿐 증명이 아니다 —
//   psmux 는 CLI 표면과 제어 표면이 갈라져 있어 표면마다 따로 재야 한다(지식 windows-native-node-psmux-1541 §10-4).
//
//  판정은 종료코드가 아니라 **pane 안 raw 리더가 받은 바이트**(hex)와 그 도착 시각이다.
//   · 정확성: 제품 형식 줄(아래 probeLines — 제품과 같다는 것은 terminal-pty.test.ts 가 CI 에서 대조한다)
//   · 비교군: 종전 경로(한글 = CLI 프로세스)와 합치기를 타는 옛 줄 형식(3.3.7 이면 깨져야 원인 재현)
//   · 지연: 보낸 순간 → pane 이 받은 순간, CLI 프로세스 vs 제어 스트림
//
//  실행(윈도우 노드에서):  node scripts/psmux-input-probe.mjs [--bin=<psmux.exe 경로>] [--n=20] [--out=<json>]
//   --bin 을 안 주면 노드 에이전트와 같은 psmux 를 쓴다(~/.lively/node-agent.env 의 TMUX_BIN 한 줄만 읽는다).
//
//  ⚠ 안전: 이 하네스는 **자기가 만든 세션 하나만** 만들고 그것만 지운다. `kill-server` 는 부르지 않는다 —
//   psmux 는 소켓 격리가 없어 kill-server 가 그 PC 의 모든 세션을 죽인다(지식 windows-psmux-kill-server-session-wipe-209).
//   같은 이름의 세션이 이미 있으면 건드리지 않고 멈춘다. warm 서버도 만들지 않는다(PSMUX_NO_WARM=1).
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── 제품과 같은 줄 형식 ─────────────────────────────────────────────────────────
// src/terminal/terminal-pty.ts 의 inputToSendKeysArgv + psmuxInputLines 와 **같아야 한다**(512토큰 청크·2자리 패딩·
//  0xff 초과 토큰이 실린 줄만 `-N 1`). 어긋나면 terminal-pty.test.ts 의 대조 시험이 빨개진다.
export function probeLines(id, d) {
  const toks = [];
  for (const ch of d) toks.push("0x" + ch.codePointAt(0).toString(16).padStart(2, "0"));
  const out = [];
  for (let i = 0; i < toks.length; i += 512) {
    const chunk = toks.slice(i, i + 512);
    out.push((chunk.some((tk) => tk.length > 4) ? ["send-keys", "-N", "1", "-t", id, ...chunk] : ["send-keys", "-t", id, ...chunk]).join(" "));
  }
  return out;
}
const tokens = (d) => [...d].map((ch) => "0x" + ch.codePointAt(0).toString(16).padStart(2, "0"));
const utf8hex = (d) => Buffer.from(d, "utf8").toString("hex");

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const v = hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
  return v;
}

function resolveBin() {
  const given = arg("bin", "");
  if (given) return { bin: given, from: "--bin" };
  try {
    const env = fs.readFileSync(path.join(os.homedir(), ".lively", "node-agent.env"), "utf8");
    const m = /^TMUX_BIN=(.*)$/m.exec(env);   // 이 한 줄만 쓴다 — 같은 파일의 토큰은 읽어도 쓰지도 찍지도 않는다
    if (m) {
      const v = m[1].trim().replace(/^"(.*)"$/, "$1");
      if (v && fs.existsSync(v)) return { bin: v, from: "node-agent.env" };
    }
  } catch { /* 에이전트 env 없음 */ }
  const h = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(h, "AppData", "Local");
  for (const c of [path.join(h, ".lively", "bin", "psmux", "psmux.exe"), path.join(local, "Microsoft", "WinGet", "Links", "psmux.exe")]) {
    if (fs.existsSync(c)) return { bin: c, from: "후보 경로" };
  }
  return { bin: "psmux", from: "PATH" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  return { n: s.length, min: s[0], p50: q(0.5), p90: q(0.9), max: s[s.length - 1] };
};

async function main() {
  if (process.platform !== "win32") {
    console.error("이 하네스는 윈도우 노드(psmux)에서 돈다 — 지금 플랫폼: " + process.platform);
    process.exit(2);
  }
  const N = Math.max(3, Number(arg("n", "20")) || 20);
  const OUT = path.resolve(arg("out", "psmux-input-probe-result.json"));
  const SID = `lively-probe-${process.pid}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lively-probe-"));
  const LOG = path.join(dir, "rx.log");
  const READER = path.join(dir, "reader.cjs");
  const env = { ...process.env, PSMUX_NO_WARM: "1" };
  const { bin, from } = resolveBin();
  const result = { startedAt: new Date().toISOString(), node: process.version, bin, binFrom: from, session: SID, cases: [], latency: null };
  const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch { /* 저장 실패는 판정에 영향 없음 */ } };
  const run = (argv) => new Promise((res) => {
    const t0 = Date.now();
    execFile(bin, argv, { timeout: 10_000, windowsHide: true, env }, (err, stdout, stderr) =>
      res({ ms: Date.now() - t0, err: err ? String(err.message || err) : null, out: String(stdout || "").trim(), errOut: String(stderr || "").trim() }));
  });
  let cc = null;
  let created = false;
  const cleanup = async () => {
    try { cc?.stdin.end(); } catch { /* 이미 닫힘 */ }
    try { cc?.kill(); } catch { /* 이미 종료 */ }
    if (created) result.cleanup = await run(["kill-session", "-t", SID]);   // 이 하네스가 만든 세션만
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 임시폴더 */ }
  };

  try {
    result.binVersion = (await run(["-V"])).out;
    const spawnMs = [];
    for (let i = 0; i < 10; i++) spawnMs.push((await run(["-V"])).ms);
    result.spawnBaseline = stats(spawnMs);

    if (!(await run(["has-session", "-t", SID])).err) throw new Error(`같은 이름의 세션이 이미 있다(${SID}) — 건드리지 않고 멈춘다`);

    // 리더: raw 모드로 받은 바이트를 `<epoch ms> <hex>` 한 줄씩. psmux 는 pane 명령 토큰의 공백·따옴표를 못 나르므로
    //  PowerShell -EncodedCommand(UTF-16LE base64)로 감싼다(제품 winShellArgv 와 같은 이유).
    fs.writeFileSync(READER, [
      "const fs = require('fs'); const log = process.argv[2]; fs.writeFileSync(log, '');",
      "process.stdin.setRawMode(true); process.stdin.resume();",
      "process.stdin.on('data', (b) => fs.appendFileSync(log, Date.now() + ' ' + b.toString('hex') + '\\n'));",
      "setInterval(() => {}, 1 << 30);",
    ].join("\n"));
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const encoded = Buffer.from(`& ${q(process.execPath)} ${q(READER)} ${q(LOG)}`, "utf16le").toString("base64");
    const made = await run(["new-session", "-d", "-s", SID, "powershell", "-NoLogo", "-NoProfile", "-EncodedCommand", encoded]);
    if (made.err) throw new Error(`테스트 세션 생성 실패: ${made.err} ${made.errOut}`);
    created = true;
    for (let i = 0; i < 100 && !fs.existsSync(LOG); i++) await sleep(100);
    if (!fs.existsSync(LOG)) throw new Error("리더가 뜨지 않았다(10초)");
    result.serverVersion = (await run(["display-message", "-p", "-t", SID, "#{version}"])).out;   // 실제로 잰 서버의 버전

    // 제어 모드 클라이언트 — 노드 에이전트와 같은 argv·같은 백엔드(파이프)
    cc = spawn(bin, ["-u", "-CC", "attach", "-t", SID], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    let ccBytes = 0;
    cc.stdout.on("data", (d) => { ccBytes += d.length; });
    cc.stderr.on("data", () => { /* 무시 */ });
    for (let i = 0; i < 50 && !ccBytes; i++) await sleep(100);
    await sleep(300);
    const write = (line) => cc.stdin.write(line + "\n");

    const readLog = () => fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => {
      const sp = l.indexOf(" ");
      return { t: Number(l.slice(0, sp)), hex: l.slice(sp + 1) };
    });
    const expectBytes = async (fromIdx, want, timeoutMs = 4000) => {
      const t0 = Date.now();
      for (;;) {
        const rows = readLog().slice(fromIdx);
        const got = rows.map((r) => r.hex).join("");
        if (got.length >= want.length || Date.now() - t0 > timeoutMs) {
          return { ok: got === want, got, first: rows[0]?.t ?? null, last: rows.at(-1)?.t ?? null };
        }
        await sleep(2);
      }
    };
    const viaStream = async (name, lines, text, { product = true } = {}) => {
      const idx = readLog().length;
      const t0 = Date.now();
      for (const l of lines) write(l);
      const r = await expectBytes(idx, utf8hex(text));
      result.cases.push({ name, product, surface: "stream", lines, ok: r.ok, want: utf8hex(text), got: r.got, ms: r.last ? r.last - t0 : null });
      save();
      await sleep(120);
      return r.ok;
    };

    // 관측 장치 배선 — 이게 안 되면 이하 전부 '빈 델타'로 무의미하다
    if (!(await viaStream("배선 확인('.')", probeLines(SID, "."), ".", { product: false }))) throw new Error("리더 배선 실패 — '.' 이 pane 에 안 닿았다");

    // ── 정확성(제품 형식) ──
    const productCases = [
      ["ASCII", "abc"],
      ["한글", "한글"],
      ["이모지(BMP 밖)", "🚀"],
      ["경계 U+00FF", "ÿ"],
      ["경계 U+0100", "Ā"],
      ["혼합 + Enter", "a한 b\r"],
      ["Tab·ESC[A·BS", "\t\x1b[A\x7f"],
      ["제어문자 0x01~0x1f(0x03 제외)", Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).filter((c) => c !== "\x03").join("")],
    ];
    for (const [name, text] of productCases) await viaStream(name, probeLines(SID, text), text);
    {
      const idx = readLog().length;
      for (const s of ["가", "나", "다"]) for (const l of probeLines(SID, s)) write(l);   // 조합 확정이 음절마다 따로 오는 모양
      const r = await expectBytes(idx, utf8hex("가나다"));
      result.cases.push({ name: "한글 음절 3줄 연속", product: true, surface: "stream", ok: r.ok, want: utf8hex("가나다"), got: r.got });
      save();
    }

    // ── 비교군(판정 대상 아님 — 원인 재현·종전 경로) ──
    await viaStream("옛 줄 형식 한글(-N 없음 = 합치기 경로. 3.3.7 이면 깨져야 원인 재현)", [`send-keys -t ${SID} ${tokens("한글").join(" ")}`], "한글", { product: false });
    {
      const idx = readLog().length;
      const r0 = await run(["send-keys", "-t", SID, ...tokens("한글")]);
      const r = await expectBytes(idx, utf8hex("한글"));
      result.cases.push({ name: "종전 한글 경로(CLI 프로세스)", product: false, surface: "cli", ok: r.ok, want: utf8hex("한글"), got: r.got, err: r0.err });
      save();
      await sleep(120);
    }

    // ── 지연: 보낸 순간 → pane 이 받은 순간(리더가 적은 시각) ──
    const lat = { cliHangul: [], cliProcessExit: [], streamHangul: [], streamAscii: [] };
    const syllables = [..."가각간갇갈감갑강개객거건걸검게겨고구그기"];
    for (let i = 0; i < N; i++) {
      const s = syllables[i % syllables.length];
      let idx = readLog().length; let t0 = Date.now();
      const pending = run(["send-keys", "-t", SID, ...tokens(s)]);
      let r = await expectBytes(idx, utf8hex(s));
      const exited = await pending;
      lat.cliHangul.push(r.ok ? r.last - t0 : null); lat.cliProcessExit.push(exited.ms);
      await sleep(50);
      idx = readLog().length; t0 = Date.now();
      for (const l of probeLines(SID, s)) write(l);
      r = await expectBytes(idx, utf8hex(s));
      lat.streamHangul.push(r.ok ? r.last - t0 : null);
      await sleep(50);
      const a = String.fromCharCode(97 + (i % 26));
      idx = readLog().length; t0 = Date.now();
      for (const l of probeLines(SID, a)) write(l);
      r = await expectBytes(idx, utf8hex(a));
      lat.streamAscii.push(r.ok ? r.last - t0 : null);
      await sleep(50);
    }
    result.latency = { cliHangul: stats(lat.cliHangul), cliProcessExit: stats(lat.cliProcessExit), streamHangul: stats(lat.streamHangul), streamAscii: stats(lat.streamAscii), raw: lat };
    save();

    // Ctrl-C 는 맨 끝에 — 리더를 죽일 수 있어서(그러면 뒤 측정이 전부 빈다). 죽었는지도 따로 잰다.
    await viaStream("Ctrl-C(0x03)", probeLines(SID, "\x03"), "\x03");
    result.readerAliveAfterCtrlC = await viaStream("Ctrl-C 뒤 리더 생존('.')", probeLines(SID, "."), ".", { product: false });
  } catch (e) {
    result.error = String(e?.stack || e);
  } finally {
    await cleanup();
    result.finishedAt = new Date().toISOString();
    save();
  }

  const productCases = result.cases.filter((c) => c.product);
  const allOk = !result.error && productCases.length > 0 && productCases.every((c) => c.ok);
  console.log(`\npsmux 입력 하네스 — bin ${result.bin} (${result.binFrom}) · -V ${result.binVersion ?? "?"} · 잰 서버 ${result.serverVersion ?? "?"}`);
  for (const c of result.cases) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.product ? "[제품]" : "[비교]"} ${c.name}${c.ok ? "" : `  want=${c.want} got=${c.got}`}`);
  if (result.latency) {
    const f = (s) => (s ? `p50 ${s.p50}ms · p90 ${s.p90}ms · max ${s.max}ms (n=${s.n})` : "측정 실패");
    console.log(`\n지연(보냄→pane 도착)\n  종전 한글(CLI 프로세스) ${f(result.latency.cliHangul)}\n  제품 한글(제어 스트림)   ${f(result.latency.streamHangul)}\n  ASCII(제어 스트림)       ${f(result.latency.streamAscii)}`);
  }
  if (result.error) console.log(`\n오류: ${result.error}`);
  console.log(`\n판정: ${allOk ? "PASS — 제품 형식 줄이 전부 바이트 그대로 도착" : "FAIL"} · 결과 파일 ${OUT}`);
  process.exit(allOk ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

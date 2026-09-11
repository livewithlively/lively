#!/usr/bin/env node
// #3904 실측 하네스 — 웹터미널 **키 → 에코** 지연을 사용자와 같은 길(게이트웨이 WS → 노드 → 멀티플렉서 → 셸)로 잰다.
//
//  왜: 윈도우 노드에서 «한글만 늦다» 는 신고를 숫자로 가르기 위해서다. 같은 세션에서 ASCII 와 한글을 번갈아 보내
//   나란히 놓으면, 둘의 차이가 곧 **입력 경로가 글자 종류에 따라 갈리는 비용**이다(#3904 이전엔 한글만 psmux CLI
//   프로세스를 탔다). 네트워크·박스 부하는 두 줄에 똑같이 들어가므로 차이에서 빠진다.
//   브라우저 IME 조합 시간은 재지 않는다 — 조합이 끝나 xterm 이 보내는 순간부터 화면에 되돌아오는 순간까지다
//   (사람이 «글자가 사라져 있던» 바로 그 구간).
//
//  실행:  node scripts/webterm-echo-probe.mjs --node=<노드 id> [--n=20] [--gw=<게이트웨이 URL>] [--out=<json>]
//   · 노드 id 는 GET /api/ui/nodes 의 id(예: hammurabi). 임시 **셸** 세션을 하나 만들고 끝나면 그 세션만 지운다.
//   · 자격은 ~/.lively/token, 주소는 ~/.lively/gateway-url 을 읽는다. 토큰은 헤더로만 쓰고 출력·파일에 남기지 않는다.
//   · 사람이 쓰는 세션에는 붙지 않는다(입력 박스를 건드리지 않는다).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  const r1 = (x) => Math.round(x * 10) / 10;
  return { n: s.length, min: r1(s[0]), p50: r1(q(0.5)), p90: r1(q(0.9)), max: r1(s[s.length - 1]) };
};

// tmux/psmux control-mode `%output %<pane> <값>` 의 값 — 0x20~0x7e 는 그대로, 나머지·백슬래시는 `\ooo`(8진 3자리).
export function unescapeOutput(v) {
  const out = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "\\" && /^[0-7]{3}$/.test(v.slice(i + 1, i + 4))) { out.push(parseInt(v.slice(i + 1, i + 4), 8)); i += 3; }
    else out.push(v.charCodeAt(i) & 0xff);
  }
  return out;
}
const indexOfSeq = (hay, needle, from) => {
  outer: for (let i = Math.max(0, from); i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};

async function main() {
  const NODE = arg("node", "");
  if (!NODE) { console.error("사용법: node scripts/webterm-echo-probe.mjs --node=<노드 id> [--n=20]"); process.exit(2); }
  const N = Math.max(3, Number(arg("n", "20")) || 20);
  const OUT = path.resolve(arg("out", "webterm-echo-probe-result.json"));
  const home = process.env.LIVELY_HOME || os.homedir();
  const gw = (arg("gw", "") || fs.readFileSync(path.join(home, ".lively", "gateway-url"), "utf8")).trim().replace(/\/+$/, "");
  const token = fs.readFileSync(path.join(home, ".lively", "token"), "utf8").trim();
  const auth = { Authorization: `Bearer ${token}` };
  const api = async (method, p, body) => {
    const r = await fetch(gw + p, { method, headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 본문이 JSON 이 아니다 */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const result = { startedAt: new Date().toISOString(), gateway: gw, node: NODE, n: N };
  const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch { /* 저장 실패는 판정과 무관 */ } };

  let sid = null;
  let ws = null;
  try {
    const nodes = await api("GET", "/api/ui/nodes");
    const nodeRow = (nodes.json?.nodes || []).find((n) => n.id === NODE);
    if (!nodeRow) throw new Error(`노드 ${NODE} 를 목록에서 못 찾았다(HTTP ${nodes.status})`);
    result.nodeInfo = { platform: nodeRow.platform, online: nodeRow.online, agent_ver: nodeRow.agent_ver };
    if (!nodeRow.online) throw new Error(`노드 ${NODE} 가 오프라인이다`);

    const made = await api("POST", "/api/ui/terminal/sessions", { node: NODE, harness: "shell", rootKey: "shared", label: "echo-probe" });
    sid = made.json?.session?.id || null;
    if (!sid) throw new Error(`임시 세션 생성 실패: HTTP ${made.status} ${made.text.slice(0, 200)}`);
    result.session = sid;
    save();

    // 수신 바이트(%output 값만 복원) + 도착 시각
    const bytes = [];
    let lastRx = performance.now();
    let lineBuf = "";
    let waiter = null;   // 기다리는 에코 — 도착을 **받은 순간** 시각으로 판정한다(폴링 간격이 지연에 섞이지 않게)
    const feed = (chunk) => {
      lineBuf += Buffer.from(chunk).toString("latin1");
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl).replace(/\r$/, "");
        lineBuf = lineBuf.slice(nl + 1);
        const m = /^(?:\x1bP1000p)?%output %\d+ (.*)$/.exec(line);
        if (m) {
          for (const b of unescapeOutput(m[1])) bytes.push(b);
          lastRx = performance.now();
          if (waiter && indexOfSeq(bytes, waiter.needle, waiter.from) >= 0) { const w = waiter; waiter = null; w.done(lastRx); }
        }
      }
    };
    const connect = async () => {
      const ticket = await api("POST", "/api/ui/terminal/ticket");
      const cookie = (ticket.headers.get("set-cookie") || "").split(";")[0];
      if (!cookie.startsWith("lively_term=")) throw new Error(`터미널 티켓 발급 실패: HTTP ${ticket.status}`);
      const u = new URL(gw);
      const wsUrl = `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}${u.pathname.replace(/\/+$/, "")}/terminal/ws?session=${encodeURIComponent(sid)}&node=${encodeURIComponent(NODE)}`;
      return await new Promise((resolve, reject) => {
        const s = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
        s.binaryType = "arraybuffer";
        const timer = setTimeout(() => { try { s.close(); } catch { /* noop */ } reject(new Error("WS 연결 시간 초과")); }, 15000);
        s.onopen = () => { clearTimeout(timer); resolve(s); };
        s.onerror = () => { clearTimeout(timer); reject(new Error("WS 연결 실패")); };
        s.onmessage = (e) => feed(new Uint8Array(e.data instanceof ArrayBuffer ? e.data : Buffer.from(String(e.data))));
      });
    };
    for (let attempt = 1; attempt <= 10 && !ws; attempt++) {
      try { ws = await connect(); } catch (e) { result.connectError = String(e.message || e); await sleep(1500); }
    }
    if (!ws) throw new Error(`WS 에 붙지 못했다: ${result.connectError}`);
    const send = (msg) => ws.send(JSON.stringify(msg));
    send({ t: "r", c: 120, r: 30 });
    // 셸 프롬프트가 설 때까지: Enter 로 한 번 찔러 출력이 오게 하고(psmux 는 attach 직후 자극이 없으면 조용하다), 1.5초 조용해질 때까지
    await sleep(800);
    send({ t: "i", d: "\r" });
    const readyBy = performance.now() + 40000;
    while (performance.now() < readyBy && !(bytes.length > 0 && performance.now() - lastRx > 1500)) await sleep(50);
    if (!bytes.length) throw new Error("셸 출력이 오지 않았다(40초)");

    const waitEcho = (needle, from, timeoutMs = 5000) => new Promise((resolve) => {
      if (indexOfSeq(bytes, needle, from) >= 0) { resolve(lastRx); return; }
      const timer = setTimeout(() => { waiter = null; resolve(null); }, timeoutMs);
      waiter = { needle, from, done: (t) => { clearTimeout(timer); resolve(t); } };
    });
    const settle = async () => {   // 지운 뒤 화면이 조용해질 때까지(다음 글자의 에코와 섞이지 않게)
      const t0 = performance.now();
      await sleep(80);
      while (performance.now() - t0 < 3000 && performance.now() - lastRx < 250) await sleep(10);
    };
    const hangul = [..."가각간갇갈감갑강개객거건걸검게겨고구그기"];
    const lat = { ascii: [], hangul: [] };
    for (let i = 0; i < N; i++) {
      for (const [kind, ch] of [["ascii", String.fromCharCode(97 + (i % 26))], ["hangul", hangul[i % hangul.length]]]) {
        const from = bytes.length;
        const t0 = performance.now();
        send({ t: "i", d: ch });
        const t1 = await waitEcho([...Buffer.from(ch, "utf8")], from);
        lat[kind].push(t1 === null ? null : t1 - t0);
        send({ t: "i", d: "\x7f" });
        await settle();
      }
    }
    result.echoMs = { ascii: stats(lat.ascii), hangul: stats(lat.hangul), timeouts: { ascii: lat.ascii.filter((x) => x === null).length, hangul: lat.hangul.filter((x) => x === null).length }, raw: lat };
  } catch (e) {
    result.error = String(e?.stack || e);
  } finally {
    try { ws?.close(); } catch { /* noop */ }
    if (sid) {
      const del = await api("DELETE", `/api/ui/terminal/sessions/${encodeURIComponent(sid)}?node=${encodeURIComponent(NODE)}`).catch((e) => ({ status: 0, text: String(e) }));
      result.cleanup = { status: del.status };
    }
    result.finishedAt = new Date().toISOString();
    save();
  }
  const f = (s) => (s ? `p50 ${s.p50}ms · p90 ${s.p90}ms · max ${s.max}ms (n=${s.n})` : "측정 실패");
  console.log(`\n웹터미널 키→에코 — 노드 ${NODE} (${result.nodeInfo?.platform ?? "?"} · agent ${result.nodeInfo?.agent_ver ?? "?"})`);
  if (result.echoMs) console.log(`  ASCII ${f(result.echoMs.ascii)}\n  한글  ${f(result.echoMs.hangul)}\n  시간초과 ASCII ${result.echoMs.timeouts.ascii} · 한글 ${result.echoMs.timeouts.hangul}`);
  if (result.error) console.log(`  오류: ${result.error.split("\n")[0]}`);
  console.log(`  임시 세션 정리: ${result.cleanup ? `HTTP ${result.cleanup.status}` : "만든 세션 없음"} · 결과 ${OUT}`);
  process.exit(result.echoMs && !result.error ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();   // 윈도우 경로에서도 맞게(URL pathname 은 /C:/…)

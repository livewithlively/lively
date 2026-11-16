#!/usr/bin/env node
// lively-mcp-gateway 테스트 (#1079) — 게이트웨이 stdio 프록시.
//  사양의 엣지 표(E1~E18)를 행마다 하나씩 시나리오로 만든다. 단언은 **부작용**으로 한다 —
//  상류 스텁이 받은 요청(메서드·헤더·인증)과 하네스가 받은 JSON-RPC 메시지, 그리고 스냅샷 파일.
//  로그 문구는 단언하지 않는다(구현 미러링·문구 손질에 깨진다).
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";
import { fileURLToPath } from "node:url";   // E24 가 하위프로세스로 진짜 stdio 를 띄우는 데 쓴다

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok  ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

// ── 상류(게이트웨이) 스텁 ──────────────────────────────────────────────────
//  받은 요청을 전부 기록한다(헤더 포함) — 신원·하네스 stamp 단언의 관측 장치.
function startUpstream({ tools = [], sse = true, dripList = false, holdOpen = false, noEol = false } = {}) {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg = {}; try { msg = JSON.parse(body); } catch { /* */ }
      seen.push({ method: msg.method, headers: req.headers, params: msg.params });
      //  오래 걸리는 툴 흉내(E29~E33) — 앱 백그라운드 도구처럼 응답을 붙잡는다.
      //   slow_progress: 3초 동안 진행 알림을 흘린 뒤 결과 · slow_silent: 머리도 안 보내고 3초 뒤 결과 ·
      //   slow_stall: 머리와 진행 알림 하나를 보낸 뒤 침묵 · slow_split: CRLF · 여러 바이트 글자가 든 결과를 한 바이트씩 ·
      //   slow_endless: 진행 알림만 끝없이(전체 상한 시험)
      //  dripList: tools/list 를 SSE 주석 줄로 3초 동안 흘리다 답한다(E34 — 목록은 종전처럼 처음부터 끝까지를 잰다).
      if (dripList && msg.method === "tools/list") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const iv = setInterval(() => res.write(": ka\n"), 300);
        res.on("close", () => clearInterval(iv));
        setTimeout(() => { clearInterval(iv); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: state.tools } })}\n\n`); }, 3000);
        return;
      }
      //  holdOpen: 응답 프레임을 쓰고 연결을 닫지 않는다(E35) · noEol: 응답을 줄끝 없이 쓰고 닫는다(E36).
      if (msg.method === "tools/call" && (holdOpen || noEol)) {
        const data = `data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `called:${msg.params?.name}` }] } })}`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (noEol) { res.end(data); return; }
        res.write(`event: message\n${data}\n\n`);
        const t = setTimeout(() => res.end(), 7000);   // 다리가 끝을 기다리면 시험이 먼저 실패하고, 이 뒤에 스텁이 닫힌다
        res.on("close", () => clearTimeout(t));
        return;
      }
      const slow = ["slow_progress", "slow_silent", "slow_stall", "slow_split", "slow_endless"];
      if (msg.method === "tools/call" && slow.includes(msg.params?.name)) {
        const name = msg.params.name;
        const frame = (o, nl = "\n") => `event: message${nl}data: ${JSON.stringify(o)}${nl}${nl}`;
        const progress = (n) => frame({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: msg.params?._meta?.progressToken, progress: n } });
        const result = (text) => ({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text } ] } });
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (name === "slow_split") {
          const bytes = Buffer.from(frame(result("한글🙂 split"), "\r\n"));
          let i = 0;
          const iv = setInterval(() => { if (i < bytes.length) res.write(bytes.subarray(i, ++i)); else { clearInterval(iv); res.end(); } }, 1);
          return;
        }
        if (name === "slow_stall") { res.flushHeaders(); res.write(progress(1)); setTimeout(() => res.end(frame(result("late"))), 4000); return; }
        let n = 0;
        const iv = name === "slow_silent" ? null : setInterval(() => { n++; res.write(progress(n)); }, name === "slow_endless" ? 300 : 400);
        res.on("close", () => { if (iv) clearInterval(iv); });
        if (name === "slow_endless") return;
        setTimeout(() => { if (iv) clearInterval(iv); res.end(frame(result(`called:${name}`))); }, 3000);
        return;
      }
      let result;
      if (msg.method === "tools/list") result = { tools: state.tools };
      else if (msg.method === "tools/call") result = { content: [{ type: "text", text: `called:${msg.params?.name}` }] };
      else result = {};
      const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
      if (sse) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: message\ndata: ${payload}\n\n`); }
      else { res.writeHead(200, { "content-type": "application/json" }); res.end(payload); }
    });
  });
  const state = { tools, seen, srv, conns: 0 };
  srv.on("connection", () => { state.conns++; });   // 연결 방식(E37~E39)의 관측 장치 — 요청 수가 아니라 TCP 연결 수
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    seen,
    conns: () => state.conns,
    setTools: (t) => { state.tools = t; },
    close: () => new Promise((r) => srv.close(r)),
  })));
}

// ── 프록시 구동 헬퍼 ───────────────────────────────────────────────────────
//  하네스 역할: 줄 단위 JSON-RPC 를 밀어넣고, 나온 메시지를 모은다.
function startProxy(serveMcpGateway) {
  const input = new PassThrough();
  const output = new PassThrough();
  const msgs = [];
  let buf = "";
  output.on("data", (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) { try { msgs.push(JSON.parse(line)); } catch { /* */ } }
    }
  });
  const done = serveMcpGateway({ input, output });
  const send = (o) => input.write(JSON.stringify(o) + "\n");
  const sendRaw = (s) => input.write(s + "\n");
  // id 로 응답을 기다린다(타임아웃이면 undefined — 단언이 실패로 드러난다).
  const waitFor = (id, ms = 4000) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const m = msgs.find((x) => x.id === id);
      if (m) { clearInterval(tick); resolve(m); }
      else if (Date.now() - t0 > ms) { clearInterval(tick); resolve(undefined); }
    }, 10);
  });
  const waitNotify = (method, ms = 3000) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const m = msgs.find((x) => x.method === method);
      if (m) { clearInterval(tick); resolve(m); }
      else if (Date.now() - t0 > ms) { clearInterval(tick); resolve(undefined); }
    }, 20);
  });
  return { send, sendRaw, waitFor, waitNotify, msgs, end: () => { input.end(); return done; } };
}

// real 상류(툴이 있는)에서 tools/list 가 non-empty 를 낼 때까지 새 id 로 짧게 재시도한다.
//  왜: 게이트웨이는 상류 fetch 가 일시 실패하면 [] 로 폴백하고 복구는 list_changed 로 민다(최종일관성).
//  Windows loopback 은 mock 서버 accept 직후 첫 연결이 간헐 reset 돼 그 폴백을 밟는데(E14 실측 flaky),
//  단발 assert 는 이 최종일관성에 취약하다. non-empty 를 기다려 흡수한다(정상 경로는 첫 시도에 바로 반환).
//  ⚠ 상류 미도달(빈 목록이 정답)인 케이스엔 쓰지 않는다 — real 상류 + tools 존재 케이스 전용.
async function listUntilTools(p, startId, tries = 10) {
  let last;
  for (let k = 0; k < tries; k++) {
    p.send({ jsonrpc: "2.0", id: startId + k, method: "tools/list" });
    last = await p.waitFor(startId + k);
    if ((last?.result?.tools || []).length > 0) return last;
  }
  return last;
}

const HOME = mkdtempSync(join(tmpdir(), "mcpgw-"));
const LIVELY = join(HOME, ".lively");
mkdirSync(LIVELY, { recursive: true });
const CACHE = join(LIVELY, "mcp-tools-cache.json");
const setGw = (u) => writeFileSync(join(LIVELY, "gateway-url"), u + "\n");
const setTok = (t) => writeFileSync(join(LIVELY, "token"), t + "\n");
const rmTok = () => { try { unlinkSync(join(LIVELY, "token")); } catch { /* */ } };
const rmCache = () => { try { unlinkSync(CACHE); } catch { /* */ } };
const DEAD = "http://127.0.0.1:1";   // 아무도 안 듣는 주소 = 상류 미도달
const T = (names) => names.map((n) => ({ name: n, description: n, inputSchema: { type: "object", properties: {} } }));

process.env.LIVELY_HOME = HOME;
process.env.LIVELY_MCP_WATCH_MS = "150";      // 워처를 테스트 속도로
process.env.LIVELY_MCP_PROBE_TIMEOUT_MS = "1500";
process.env.LIVELY_MCP_LIST_TIMEOUT_MS = "1500";
process.env.LIVELY_MCP_CALL_TIMEOUT_MS = "1500";
process.env.LIVELY_MCP_CALL_MAX_MS = "4500";        // 전체 상한(E33) — E29 의 3초 붙잡기보다 길게
delete process.env.LIVELY_GATEWAY_URL;
delete process.env.LIVELY_TOKEN;
//  ⚠ 세션 자격도 반드시 지운다(#2251) — 라이블리 세션 **안에서** 테스트를 돌리면 게이트웨이가 그 pane 에
//   심어 준 LIVELY_MCP_TOKEN 이 상속돼, 토큰 우선순위를 재는 E11·E12 가 진짜 토큰을 집는다.
//   실측 2026-08-28: E11 이 `Bearer lvk_…`(실 토큰)로 실패했다. CI 는 깨끗한 env 라 안 잡혔다 —
//   env 를 읽는 테스트는 **자기가 읽는 변수를 전부** 스크럽해야 한다.
delete process.env.LIVELY_MCP_TOKEN;
delete process.env.LIVELY_MCP_CONNECTION;   // E37~E39 가 연결 방식의 우선순위를 잰다

const { serveMcpGateway, callTimeoutFor, sessionHeaderValue } = await import("./lively-mcp-gateway.mjs");

try {
  setTok("tok-file");

  // E1 — initialize 는 상류와 무관하게 즉답하고, listChanged 를 선언한다. 상류 호출 0건.
  {
    const up = await startUpstream({ tools: T(["a"]) });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const r = await p.waitFor(1);
    check("E1 initialize — 즉답 · listChanged=true · 상류 호출 0건",
      !!r && r.result?.capabilities?.tools?.listChanged === true && up.seen.length === 0,
      `r=${JSON.stringify(r)} upstream=${up.seen.length}`);
    await p.end(); await up.close();
  }

  // E2 — 상류 정상: 목록 그대로 + 스냅샷 저장.  E13 — SSE 해석.  E15 — 하네스 stamp.  E11 — 파일 토큰 우선.
  {
    rmCache();
    const up = await startUpstream({ tools: T(["alpha", "beta"]), sse: true });
    setGw(up.url);
    process.env.LIVELY_TOKEN = "tok-env-stale";        // 스테일 env 를 일부러 심는다(#916)
    const p = startProxy(serveMcpGateway);
    const r = await listUntilTools(p, 2);
    const got = (r?.result?.tools || []).map((t) => t.name);
    let cached = null; try { cached = JSON.parse(readFileSync(CACHE, "utf8")); } catch { /* */ }
    const h = up.seen[0]?.headers || {};
    check("E2/E13 tools/list — 상류 목록 그대로(SSE 해석) + 스냅샷 저장",
      JSON.stringify(got) === JSON.stringify(["alpha", "beta"]) && cached?.gateway === up.url && cached?.tools?.length === 2,
      `got=${JSON.stringify(got)} cache=${JSON.stringify(cached?.tools?.length)}`);
    check("E15 상류 요청에 x-lively-harness 가 실린다", !!h["x-lively-harness"], `headers=${JSON.stringify(Object.keys(h))}`);
    check("E11 #916 — 파일 토큰이 스테일 env 를 이긴다",
      h.authorization === "Bearer tok-file", `auth=${h.authorization}`);
    delete process.env.LIVELY_TOKEN;
    await p.end(); await up.close();
  }

  // E14 — JSON(비SSE) 응답도 해석한다.
  {
    const up = await startUpstream({ tools: T(["j1"]), sse: false });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    const r = await listUntilTools(p, 3);
    check("E14 tools/list — JSON 응답 해석", (r?.result?.tools || []).map((t) => t.name).join() === "j1", `r=${JSON.stringify(r?.result)}`);
    await p.end(); await up.close();
  }

  // E27 — 세션 신원 폴백. 라이블리가 띄운 창이 아닌 Claude Code 세션은 CLAUDE_CODE_SESSION_ID 만 갖는다.
  //  이걸 못 읽으면 x-lively-session 이 빠져 게이트웨이가 세션을 특정하지 못한다(session_rename·session_task 거부).
  {
    check("E27 LIVELY_SESSION_ID 가 가장 먼저", sessionHeaderValue({ LIVELY_SESSION_ID: "box-1", CODEX_THREAD_ID: "t", CLAUDE_CODE_SESSION_ID: "u" }) === "box-1");
    check("E27 Codex 스레드 id → codex-", sessionHeaderValue({ CODEX_THREAD_ID: " t1 " }) === "codex-t1");
    check("E27 코덱스 프록시(stamp=codex)는 codex id 가 먼저", sessionHeaderValue({ LIVELY_HARNESS: "codex", CODEX_THREAD_ID: "t1", CLAUDE_CODE_SESSION_ID: "u" }) === "codex-t1");
    check("E27 코덱스 셸에서 띄운 claude(부모 CODEX_THREAD_ID 상속)는 자기 id", sessionHeaderValue({ CODEX_THREAD_ID: "parent", CLAUDE_CODE_SESSION_ID: "child" }) === "claude-child");
    check("E27 Claude Code 자식 env(CLAUDE_CODE_SESSION_ID) → claude-", sessionHeaderValue({ CLAUDE_CODE_SESSION_ID: "u1" }) === "claude-u1");
    check("E27 CLAUDE_SESSION_ID 도 계속 읽는다", sessionHeaderValue({ CLAUDE_SESSION_ID: "c1" }) === "claude-c1");
    check("E27 둘 다 있으면 CLAUDE_CODE_SESSION_ID(훅 stdin 과 같은 값)가 이긴다", sessionHeaderValue({ CLAUDE_SESSION_ID: "stale", CLAUDE_CODE_SESSION_ID: "u2" }) === "claude-u2");
    check("E27 신원이 없으면 빈 값(헤더를 싣지 않는다)", sessionHeaderValue({ CLAUDE_CODE_SESSION_ID: "  " }) === "");

    const keys = ["LIVELY_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    process.env.CLAUDE_CODE_SESSION_ID = "3e0bd20d-aaaa";
    const up = await startUpstream({ tools: T(["s1"]) });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    await listUntilTools(p, 4);
    const h = up.seen[0]?.headers || {};
    check("E27 상류 요청에 x-lively-session=claude-<CLAUDE_CODE_SESSION_ID> 가 실린다",
      h["x-lively-session"] === "claude-3e0bd20d-aaaa", `x-lively-session=${h["x-lively-session"]}`);
    await p.end(); await up.close();
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }

  // E3 — 상류 미도달 + 스냅샷 있음 → 스냅샷 반환(오류 아님).
  {
    writeFileSync(CACHE, JSON.stringify({ gateway: DEAD, tools: T(["cached1", "cached2"]) }));
    setGw(DEAD);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    const r = await p.waitFor(4);
    const got = (r?.result?.tools || []).map((t) => t.name);
    check("E3 상류 미도달 + 스냅샷 → 스냅샷 목록(오류 아님)",
      !r?.error && JSON.stringify(got) === JSON.stringify(["cached1", "cached2"]), `r=${JSON.stringify(r)}`);
    await p.end();
  }

  // E4 — 스냅샷 파일 부재 → 빈 목록(오류 아님).
  {
    rmCache(); setGw(DEAD);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 5, method: "tools/list" });
    const r = await p.waitFor(5);
    check("E4 상류 미도달 + 스냅샷 부재 → 빈 목록(오류 아님)",
      !r?.error && Array.isArray(r?.result?.tools) && r.result.tools.length === 0, `r=${JSON.stringify(r)}`);
    await p.end();
  }

  // E5 — 스냅샷이 **다른 게이트웨이** 것이면 쓰지 않는다(툴 표면 오염 금지).
  {
    writeFileSync(CACHE, JSON.stringify({ gateway: "http://other.example:9999", tools: T(["foreign"]) }));
    setGw(DEAD);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 6, method: "tools/list" });
    const r = await p.waitFor(6);
    check("E5 다른 게이트웨이의 스냅샷은 무시된다",
      (r?.result?.tools || []).length === 0, `r=${JSON.stringify(r?.result)}`);
    await p.end();
  }

  // E6 — 파손된 스냅샷도 무시한다(JSON 아님 / tools 비배열).
  {
    writeFileSync(CACHE, "{ not json");
    setGw(DEAD);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    const r1 = await p.waitFor(7);
    writeFileSync(CACHE, JSON.stringify({ gateway: DEAD, tools: "nope" }));
    p.send({ jsonrpc: "2.0", id: 8, method: "tools/list" });
    const r2 = await p.waitFor(8);
    check("E6 파손 스냅샷(JSON 아님·tools 비배열) 무시 → 빈 목록",
      (r1?.result?.tools || []).length === 0 && (r2?.result?.tools || []).length === 0,
      `r1=${JSON.stringify(r1?.result)} r2=${JSON.stringify(r2?.result)}`);
    await p.end();
  }

  // E7 — tools/call 상류 정상: 결과 그대로.
  {
    const up = await startUpstream({ tools: T(["x"]) });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "whoami", arguments: {} } });
    const r = await p.waitFor(9);
    check("E7 tools/call — 상류 결과 그대로 전달",
      r?.result?.content?.[0]?.text === "called:whoami" && !r.result.isError, `r=${JSON.stringify(r?.result)}`);
    await p.end(); await up.close();
  }

  // E8 — tools/call 상류 미도달: JSON-RPC error 가 아니라 isError 결과(연결 유지).
  {
    setGw(DEAD);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "whoami", arguments: {} } });
    const r = await p.waitFor(10);
    check("E8 tools/call — 상류 미도달은 isError 결과(프로토콜 오류 아님)",
      !r?.error && r?.result?.isError === true, `r=${JSON.stringify(r)}`);
    await p.end();
  }

  // E9 — 상류 부활 + 툴 구성 달라짐 → list_changed 발신.
  {
    rmCache();
    const up = await startUpstream({ tools: T(["one"]) });
    setGw(DEAD);                                   // 죽은 채로 시작
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 11, method: "initialize", params: {} });
    await p.waitFor(11);
    p.send({ jsonrpc: "2.0", id: 12, method: "tools/list" });
    const first = await p.waitFor(12);
    setGw(up.url);                                 // 상류 부활(= VPN 연결)
    const note = await p.waitNotify("notifications/tools/list_changed");
    p.send({ jsonrpc: "2.0", id: 13, method: "tools/list" });
    const second = await p.waitFor(13);
    check("E9 상류 부활 + 툴 달라짐 → list_changed 발신 후 목록 갱신",
      (first?.result?.tools || []).length === 0 && !!note && (second?.result?.tools || []).map((t) => t.name).join() === "one",
      `first=${(first?.result?.tools || []).length} note=${!!note} second=${JSON.stringify((second?.result?.tools || []).map((t) => t.name))}`);
    await p.end(); await up.close();
  }

  // E10 — 상류 부활했지만 툴 구성이 **동일**하면 알림을 보내지 않는다.
  {
    const up = await startUpstream({ tools: T(["same1", "same2"]) });
    writeFileSync(CACHE, JSON.stringify({ gateway: DEAD, tools: T(["same1", "same2"]) }));
    setGw(DEAD);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 14, method: "initialize", params: {} });
    await p.waitFor(14);
    p.send({ jsonrpc: "2.0", id: 15, method: "tools/list" });   // 스냅샷(same1,same2)으로 응답 + upstreamDown 표시
    await p.waitFor(15);
    // 부활시키되 **같은 툴 구성**으로. 캐시 주소도 새 주소로 맞춰 '주소 불일치' 요인을 배제한다.
    writeFileSync(CACHE, JSON.stringify({ gateway: up.url, tools: T(["same1", "same2"]) }));
    setGw(up.url);
    const note = await p.waitNotify("notifications/tools/list_changed", 900);
    check("E10 상류 부활 + 툴 동일 → 알림 없음", !note, `note=${JSON.stringify(note)}`);
    await p.end(); await up.close();
  }

  // E19 — 복구 알림은 **한 번만** 간다. 중복 발신하면 하네스가 tools/list 를 그만큼 폭주시킨다
  //  (워처 재진입·정리 누락이 이걸 만든다 — 로그가 아니라 발신 횟수로 못박는다).
  {
    rmCache();
    const up = await startUpstream({ tools: T(["once"]) });
    setGw(DEAD);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 22, method: "initialize", params: {} });
    await p.waitFor(22);
    p.send({ jsonrpc: "2.0", id: 23, method: "tools/list" });
    await p.waitFor(23);
    setGw(up.url);
    await p.waitNotify("notifications/tools/list_changed");
    await new Promise((r) => setTimeout(r, 800));   // 워처 5주기(150ms) 더 지켜본다
    const n = p.msgs.filter((m) => m.method === "notifications/tools/list_changed").length;
    check("E19 복구 알림은 정확히 1회", n === 1, `n=${n}`);
    await p.end(); await up.close();
  }

  // E24 — #2234 세션 MCP 토큰이 **파일을 이긴다**(홈이 공유인 박스에서 남의 신원으로 나가던 것).
  //  E11 과 짝이다: 셸 rc 가 만든 LIVELY_TOKEN 은 파일의 스냅샷이라 파일이 이기고(E11), 게이트웨이가
  //  pane 에 심은 LIVELY_MCP_TOKEN 은 그 세션 주인 앞으로 발급된 정본이라 파일을 이긴다.
  {
    const up = await startUpstream({ tools: T(["s1"]) });
    setGw(up.url); setTok("tok-file");
    process.env.LIVELY_TOKEN = "tok-env-stale";              // 스테일 셸 export 가 함께 있어도
    process.env.LIVELY_MCP_TOKEN = "tok-session-owner";      // 세션 자격이 최우선이어야 한다
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 17, method: "tools/list" });
    await p.waitFor(17);
    check("E24 #2234 — 세션 MCP 토큰이 파일·스테일 env 를 모두 이긴다",
      up.seen[0]?.headers?.authorization === "Bearer tok-session-owner", `auth=${up.seen[0]?.headers?.authorization}`);
    delete process.env.LIVELY_MCP_TOKEN; delete process.env.LIVELY_TOKEN;
    await p.end(); await up.close();
  }

  // E25 — 세션 토큰이 없으면 종전과 **글자 그대로 같다**(구 게이트웨이·격리 박스·개인 노트북 무회귀).
  {
    const up = await startUpstream({ tools: T(["s2"]) });
    setGw(up.url); setTok("tok-file");
    delete process.env.LIVELY_MCP_TOKEN;
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 18, method: "tools/list" });
    await p.waitFor(18);
    check("E25 세션 토큰 부재 → 종전대로 파일 토큰",
      up.seen[0]?.headers?.authorization === "Bearer tok-file", `auth=${up.seen[0]?.headers?.authorization}`);
    await p.end(); await up.close();
  }

  // E12 — 토큰 파일이 없으면 env 로 떨어진다(프로비저닝·컨테이너 경로 보존).
  {
    const up = await startUpstream({ tools: T(["x"]) });
    setGw(up.url); rmTok();
    process.env.LIVELY_TOKEN = "tok-env-only";
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 16, method: "tools/list" });
    await p.waitFor(16);
    check("E12 토큰 파일 부재 → env 토큰으로 상류 호출",
      up.seen[0]?.headers?.authorization === "Bearer tok-env-only", `auth=${up.seen[0]?.headers?.authorization}`);
    delete process.env.LIVELY_TOKEN; setTok("tok-file");
    await p.end(); await up.close();
  }

  // E16 — 깨진 입력 라인은 무시하고, **이후 요청을 정상 처리**한다(프로세스 생존).
  {
    const up = await startUpstream({ tools: T(["alive"]) });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    p.sendRaw("{ this is not json");
    p.sendRaw("");
    p.send({ jsonrpc: "2.0", id: 17, method: "tools/list" });
    const r = await p.waitFor(17);
    check("E16 깨진 입력 이후에도 다음 요청을 처리한다(생존)",
      (r?.result?.tools || []).map((t) => t.name).join() === "alive", `r=${JSON.stringify(r?.result)}`);
    await p.end(); await up.close();
  }

  // E17 — 알 수 없는 메서드(상류 미도달): JSON-RPC error 를 주되 죽지 않는다.
  {
    const up = await startUpstream({ tools: T(["still-alive"]) });
    setGw(DEAD);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 18, method: "resources/list" });
    const r = await p.waitFor(18);
    setGw(up.url);
    p.send({ jsonrpc: "2.0", id: 19, method: "tools/list" });
    const after = await p.waitFor(19);
    check("E17 알 수 없는 메서드 → error 응답 + 이후 요청 정상(생존)",
      !!r?.error && (after?.result?.tools || []).map((t) => t.name).join() === "still-alive",
      `err=${JSON.stringify(r?.error)} after=${JSON.stringify(after?.result)}`);
    await p.end(); await up.close();
  }

  // E18 — 게이트웨이 주소 자체가 없다(미로그인): 목록은 비고, 호출은 isError, 크래시 없음.
  {
    rmCache();
    writeFileSync(join(LIVELY, "gateway-url"), "\n");
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 20, method: "tools/list" });
    const r1 = await p.waitFor(20);
    p.send({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "whoami" } });
    const r2 = await p.waitFor(21);
    check("E18 게이트웨이 미설정 → 빈 목록 + isError, 크래시 없음",
      !r1?.error && (r1?.result?.tools || []).length === 0 && r2?.result?.isError === true,
      `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);
    await p.end();
  }

  // E20~E23 — tools/call 상류 타임아웃은 **툴별**이다(#1080).
  //  하네스가 주는 건 서버별 타임아웃뿐이지만(툴별 노브는 없다), 프록시는 우리 코드라
  //  '오래 기다리는 게 정상인 툴'만 골라 늘릴 수 있다. 지금 그런 툴은 delegate_run 하나뿐 —
  //  서버가 wait 모드에서 wait_sec 만큼 붙잡는다(src/capabilities/delegate.ts DEFAULT_WAIT_SEC=120).
  //  나머지 라이블리 툴은 실측 0.03~0.36초라 기본값으로 충분하다.
  {
    const base = 1500;          // = 위에서 심은 LIVELY_MCP_CALL_TIMEOUT_MS
    const slack = 30_000;       // 서버 wait 상한을 넘겨 끊지 않기 위한 왕복 여유
    const call = (name, args) => callTimeoutFor(args === undefined ? { name } : { name, arguments: args });
    check("E20 일반 툴 → 기본 CALL 타임아웃", call("whoami") === base, `got=${call("whoami")}`);
    check("E21 delegate_run(wait_sec 미지정) → 서버 기본 120s + 여유",
      call("delegate_run", {}) === 120_000 + slack, `got=${call("delegate_run", {})}`);
    check("E22 delegate_run(wait_sec=600) → 600s + 여유",
      call("delegate_run", { wait_sec: 600 }) === 600_000 + slack, `got=${call("delegate_run", { wait_sec: 600 })}`);
    check("E23 delegate_run(wait=false, 즉시접수) → 기본 CALL 타임아웃(길게 줄 이유 없음)",
      call("delegate_run", { wait: false, wait_sec: 600 }) === base, `got=${call("delegate_run", { wait: false, wait_sec: 600 })}`);
  }
  // E29 — 앱 백그라운드 도구처럼 상류가 응답을 붙잡고 진행 알림을 흘리면, 응답 없음 시한(여기 1.5초)은 알림마다 다시 잰다 —
  //  3초 뒤 온 결과를 받고(종전엔 처음부터 재 1.5초에 끊어 작업 번호를 잃었다), 알림은 하네스에 그 토큰 그대로 넘긴다.
  {
    const up = await startUpstream({ tools: T(["slow_progress"]) });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 271, method: "tools/call", params: { name: "slow_progress", arguments: {}, _meta: { progressToken: "pt-1" } } });
    const r = await p.waitFor(271, 8000);
    const prog = p.msgs.filter((m) => m.method === "notifications/progress");
    const at = (m) => p.msgs.indexOf(m);
    check("E29 진행 알림이 흐르는 동안은 기다려 결과를 받고, 알림을 하네스에 넘긴다(응답보다 먼저)",
      r?.result?.content?.[0]?.text === "called:slow_progress" && !r?.result?.isError && prog.length >= 3
        && prog.every((m) => m.params?.progressToken === "pt-1" && m.id === undefined && at(m) < at(r)),
      `r=${JSON.stringify(r)} progress=${prog.length}`);
    await p.end(); await up.close();
  }
  // E30 — 아무것도 오지 않으면 종전처럼 응답 없음 시한에 끊고 툴 오류로 돌려준다(멎은 게이트웨이를 오래 붙잡지 않는다).
  {
    const up = await startUpstream({ tools: T(["slow_silent"]) });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    const t0 = Date.now();
    p.send({ jsonrpc: "2.0", id: 281, method: "tools/call", params: { name: "slow_silent", arguments: {}, _meta: { progressToken: "pt-2" } } });
    const r = await p.waitFor(281, 6000);
    const ms = Date.now() - t0;
    check("E30 아무것도 오지 않으면 시한에 끊는다(툴 오류 · 연결 유지)",
      r?.result?.isError === true && /응답 없음/.test(r?.result?.content?.[0]?.text || "") && ms < 2800, `ms=${ms} r=${JSON.stringify(r)}`);
    await p.end(); await up.close();
  }
  // E31 — 머리와 진행 알림 하나가 온 뒤 멎으면, 마지막으로 받은 때부터 응답 없음 시한에 끊는다(흘려 읽기 중의 침묵).
  {
    const up = await startUpstream({ tools: T(["slow_stall"]) });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    const t0 = Date.now();
    p.send({ jsonrpc: "2.0", id: 311, method: "tools/call", params: { name: "slow_stall", arguments: {}, _meta: { progressToken: "pt-3" } } });
    const r = await p.waitFor(311, 6000);
    const ms = Date.now() - t0;
    check("E31 알림 하나 뒤 침묵하면 시한에 끊는다(진행 알림은 넘겼다)",
      r?.result?.isError === true && /아무것도 오지 않았습니다/.test(r?.result?.content?.[0]?.text || "") && ms >= 1400 && ms < 3500
        && p.msgs.some((m) => m.method === "notifications/progress" && m.params?.progressToken === "pt-3"),
      `ms=${ms} r=${JSON.stringify(r)}`);
    await p.end(); await up.close();
  }
  // E32 — 프레임이 바이트 단위로 쪼개져 와도(CRLF · 여러 바이트 글자) 응답을 그대로 맞춘다.
  {
    const up = await startUpstream({ tools: T(["slow_split"]) });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 321, method: "tools/call", params: { name: "slow_split", arguments: {} } });
    const r = await p.waitFor(321, 6000);
    check("E32 바이트 단위로 쪼개진 SSE 응답(CRLF · 한글 · 이모지)을 그대로 받는다", r?.result?.content?.[0]?.text === "한글🙂 split" && !r?.result?.isError,
      `r=${JSON.stringify(r)}`);
    await p.end(); await up.close();
  }
  // E33 — 진행 알림만 끝없이 오면 전체 상한(여기 4.5초)에서 끊고, 까닭을 «전체 상한»으로 말한다(«아무것도 오지 않았다»가 아니다).
  {
    const up = await startUpstream({ tools: T(["slow_endless"]) });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    const t0 = Date.now();
    p.send({ jsonrpc: "2.0", id: 331, method: "tools/call", params: { name: "slow_endless", arguments: {}, _meta: { progressToken: "pt-4" } } });
    const r = await p.waitFor(331, 9000);
    const ms = Date.now() - t0;
    const text = r?.result?.content?.[0]?.text || "";
    check("E33 끝없는 진행 알림은 전체 상한에서 끊고 그 까닭을 말한다", r?.result?.isError === true && /전체 상한/.test(text) && !/아무것도 오지 않았습니다/.test(text) && ms >= 4300 && ms < 7000,
      `ms=${ms} r=${JSON.stringify(r)}`);
    await p.end(); await up.close();
  }
  // E34 — tools/list 는 응답 없음을 «아무것도 오지 않은 시간»으로 재지 않는다: 바이트가 흘러와도 목록 시한(여기 1.5초)에 끊고 스냅샷으로 답한다
  //  (하네스가 기다리다 서버를 실패로 표시하기 전에 답해야 한다 — #1079). 흘려 읽기는 도구 부르기에만 켠다.
  {
    const up = await startUpstream({ tools: T(["drip_a"]), dripList: true });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    const t0 = Date.now();
    p.send({ jsonrpc: "2.0", id: 341, method: "tools/list" });
    const r = await p.waitFor(341, 6000);
    const ms = Date.now() - t0;
    check("E34 흘러오는 tools/list 도 목록 시한에 끊고 스냅샷으로 답한다", Array.isArray(r?.result?.tools) && ms < 2600, `ms=${ms} r=${JSON.stringify(r)?.slice(0, 200)}`);
    await p.end(); await up.close();
  }
  // E35 — 응답 프레임이 온 뒤 상류가 연결을 닫지 않아도 거기서 읽기를 멈추고 곧바로 답한다.
  //  시각에 기대지 않으려고 응답 없음 시한이 긴 도구(delegate_run · 50초)로 잰다 — 끝을 기다리면 시험 시한 안에 답이 오지 않는다.
  {
    const up = await startUpstream({ tools: T(["delegate_run"]), holdOpen: true });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 351, method: "tools/call", params: { name: "delegate_run", arguments: { wait_sec: 20 } } });
    const r = await p.waitFor(351, 5000);
    check("E35 응답 뒤 연결이 열려 있어도 곧바로 답한다(끝을 기다리지 않는다)", r?.result?.content?.[0]?.text === "called:delegate_run" && !r?.result?.isError, `r=${JSON.stringify(r)}`);
    await p.end(); await up.close();
  }
  // E36 — 응답이 줄끝 없이 끝나도 받는다(마지막 조각 · 통째로 읽던 때와 같다).
  {
    const up = await startUpstream({ tools: T(["no_eol"]), noEol: true });
    setGw(up.url);
    const p = startProxy(serveMcpGateway);
    p.send({ jsonrpc: "2.0", id: 361, method: "tools/call", params: { name: "no_eol", arguments: {} } });
    const r = await p.waitFor(361, 5000);
    check("E36 줄끝 없이 끝난 응답도 받는다", r?.result?.content?.[0]?.text === "called:no_eol" && !r?.result?.isError, `r=${JSON.stringify(r)}`);
    await p.end(); await up.close();
  }
  // E37~E39 — 상류 연결 방식. fresh 는 호출마다 새 연결이어야 한다 — 호스트 네트워크가 바뀐 뒤 풀에 남은 연결을 집으면
  //  요청이 상류에 닿지 않고 응답 없음 시한을 다 쓴다. 연결 방식은 env > ~/.lively/mcp-connection > fresh 순이고, 모르는 값은 fresh 다.
  //  단언은 상류가 받은 TCP 연결 수와 connection 헤더로 한다(같은 연결로 두 번 오면 reuse, 두 연결이면 fresh).
  {
    const MODE_FILE = join(LIVELY, "mcp-connection");
    const cases = [
      { id: "E37", name: "기본값은 fresh — 호출마다 새 연결", env: undefined, file: undefined, want: "fresh" },
      { id: "E38", name: "파일 reuse — 연결을 재사용(종전 동작)", env: undefined, file: "reuse\n", want: "reuse" },
      { id: "E39", name: "env 가 파일을 이긴다 · 모르는 값은 fresh", env: "nonsense", file: "reuse\n", want: "fresh" },
    ];
    let id = 370;
    try {
      for (const c of cases) {
        if (c.env === undefined) delete process.env.LIVELY_MCP_CONNECTION; else process.env.LIVELY_MCP_CONNECTION = c.env;
        if (c.file === undefined) { try { unlinkSync(MODE_FILE); } catch { /* */ } } else writeFileSync(MODE_FILE, c.file);
        const up = await startUpstream({ tools: T(["ping_tool"]) });
        setGw(up.url);
        const p = startProxy(serveMcpGateway);
        const replies = [];
        for (let k = 0; k < 2; k++) {
          p.send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "ping_tool", arguments: {} } });
          replies.push(await p.waitFor(id));
        }
        const okReplies = replies.every((r) => r?.result?.content?.[0]?.text === "called:ping_tool");
        const calls = up.seen.filter((s) => s.method === "tools/call");
        const wantConns = c.want === "fresh" ? 2 : 1;
        //  reuse 쪽은 «close 가 아님»만 본다 — keep-alive 헤더는 fetch 가 붙이는 기본값이지 이 코드가 싣는 게 아니다.
        const headerOk = (s) => (c.want === "fresh" ? s.headers.connection === "close" : s.headers.connection !== "close");
        //  E38 의 연결 1개는 스텁 기본 분기가 응답을 res.end 한 번에 끝내기 때문에 성립한다(프레임과 끝을 나눠 보내면 fetch 가 연결을 새로 맺는다).
        check(`${c.id} ${c.name}`,
          okReplies && calls.length === 2 && up.conns() === wantConns && calls.every(headerOk),
          `conns=${up.conns()} headers=${calls.map((s) => s.headers.connection)} replies=${JSON.stringify(replies)}`);
        await p.end(); await up.close();
      }
    } finally {   // 실패해도 다음 시나리오(E24 하위프로세스는 process.env 를 물려받는다)로 새지 않게
      delete process.env.LIVELY_MCP_CONNECTION;
      try { unlinkSync(MODE_FILE); } catch { /* */ }
    }
  }
  // ── E24 피어(하네스) 소멸 = 이 프로세스가 죽어야 하는 유일한 경우 (#2213 릭 회귀) ──────────
  //  왜 하위프로세스로 재는가: 이 방어는 **진짜 stdio 로 서빙할 때만** 무장한다(가짜 스트림으로 무장하면
  //  테스트 러너가 exit(0) 으로 끝나 실패가 성공으로 둔갑한다). 그래서 이 한 건만 실제로 띄워서 잰다.
  //  실측 배경(2026-08-28): 이 방어가 없어 고아 19개가 CPU 1,540%(코어 9.4개)를 태웠다 — 최장 1일 11시간.
  //  기전은 재귀였다 — stdout 이 깨진 뒤 write 가 비동기 EPIPE → 리스너 없음 → uncaughtException →
  //  그 핸들러의 log() 가 **역시 깨진 stderr** 로 쓰며 또 EPIPE → 무한 고리.
  {
    const { spawn } = await import("node:child_process");
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const entry = fileURLToPath(new URL("./lively-mcp-gateway.mjs", import.meta.url));
    const child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
      // 부모 감시는 끈다 — 여기서 재는 것은 «깨진 파이프» 축 하나다(부모는 살아 있다).
      env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME, LIVELY_MCP_PARENT_WATCH_MS: "0" },
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    // ⚠ exit 리스너는 **spawn 직후** 단다. 아래 write 들 사이에 이미 죽으면 그 이벤트는 한 번 나고 끝이라,
    //  나중에 달면 영영 못 받는다(그 실수로 통과해야 할 테스트가 FAIL 로 나왔다).
    let exitedFlag = false;
    const exitOnce = new Promise((r) => child.on("exit", () => { exitedFlag = true; r(true); }));
    await nap(1500);
    try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n"); } catch { /* */ }
    await nap(1000);
    // 하네스가 죽은 상황 그대로: 읽는 쪽이 사라진다(stdin 은 형제가 물고 있어 EOF 가 안 온다).
    child.stdout.destroy();
    child.stderr.destroy();
    for (let i = 0; i < 3; i++) {
      try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2 + i, method: "ping" }) + "\n"); } catch { /* */ }
      await nap(150);
    }
    const exited = exitedFlag || await Promise.race([exitOnce, nap(8000).then(() => false)]);
    check("E26 피어가 사라지면 스스로 종료한다(고아 스핀 회귀 #2213)", exited === true, "8초 안에 종료 안 됨 = 릭 재발");
    if (!exited) { try { child.kill("SIGKILL"); } catch { /* */ } }
  }
} finally {
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nlively-mcp-gateway tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);

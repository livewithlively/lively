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
import { fileURLToPath } from "node:url";   // E24 가 하위프로세스로 진짜 stdio 를 띄우는 데 쓴다

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok  ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

// ── 상류(게이트웨이) 스텁 ──────────────────────────────────────────────────
//  받은 요청을 전부 기록한다(헤더 포함) — 신원·하네스 stamp 단언의 관측 장치.
function startUpstream({ tools = [], sse = true } = {}) {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg = {}; try { msg = JSON.parse(body); } catch { /* */ }
      seen.push({ method: msg.method, headers: req.headers, params: msg.params });
      let result;
      if (msg.method === "tools/list") result = { tools: state.tools };
      else if (msg.method === "tools/call") result = { content: [{ type: "text", text: `called:${msg.params?.name}` }] };
      else result = {};
      const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
      if (sse) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: message\ndata: ${payload}\n\n`); }
      else { res.writeHead(200, { "content-type": "application/json" }); res.end(payload); }
    });
  });
  const state = { tools, seen, srv };
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    seen,
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
delete process.env.LIVELY_GATEWAY_URL;
delete process.env.LIVELY_TOKEN;
//  ⚠ 세션 자격도 반드시 지운다(#2251) — 라이블리 세션 **안에서** 테스트를 돌리면 게이트웨이가 그 pane 에
//   심어 준 LIVELY_MCP_TOKEN 이 상속돼, 토큰 우선순위를 재는 E11·E12 가 진짜 토큰을 집는다.
//   실측 2026-08-28: E11 이 `Bearer lvk_…`(실 토큰)로 실패했다. CI 는 깨끗한 env 라 안 잡혔다 —
//   env 를 읽는 테스트는 **자기가 읽는 변수를 전부** 스크럽해야 한다.
delete process.env.LIVELY_MCP_TOKEN;

const { serveMcpGateway, callTimeoutFor } = await import("./lively-mcp-gateway.mjs");

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
    p.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const r = await p.waitFor(2);
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
    p.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const r = await p.waitFor(3);
    check("E14 tools/list — JSON 응답 해석", (r?.result?.tools || []).map((t) => t.name).join() === "j1", `r=${JSON.stringify(r?.result)}`);
    await p.end(); await up.close();
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
      env: { ...process.env, LIVELY_HOME: HOME, LIVELY_MCP_PARENT_WATCH_MS: "0" },
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

#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// lively-mcp-gateway — 게이트웨이 MCP 를 감싸는 로컬 stdio 프록시 (`lively mcp` 가 실행)
// ═══════════════════════════════════════════════════════════════════════════
//
// 무엇 · 왜 (#1079)
//   종전엔 하네스가 게이트웨이 `/mcp` 에 **http 로 직결**했다. 그러면 세션이 뜨는 순간
//   게이트웨이에 못 닿을 때(사내 게이트웨이 + VPN 미접속이 대표 사례) 하네스가 그 서버를
//   **failed 로 마킹**하고, **그 세션 안에서는 다시 붙지 않는다** — 도중에 VPN 을 연결해도
//   lively 툴이 0개인 채로 세션 내내 간다(사람이 `/mcp reconnect lively` 를 직접 쳐야 복구).
//
//   이 프록시는 그 실패 자체를 없앤다. stdio 서버는 하네스가 spawn 한 **로컬 프로세스**라
//   네트워크와 무관하게 항상 connected 다. 상류(게이트웨이)는 툴을 **부를 때** 닿으면 되고,
//   부팅 시 못 닿아도 마지막 성공 스냅샷으로 툴 목록을 세우며, 상류가 살아나면
//   `notifications/tools/list_changed` 를 쏴서 하네스가 목록을 다시 가져가게 한다
//   (클코 2.1.216 실측: 알림 후 8ms 만에 tools/list 재요청).
//
//   ⚠ 이 프로세스는 **죽으면 안 된다** — stdio 서버는 하네스가 자동 재시작해 주지 않는다.
//     그래서 모든 상류 오류는 잡아서 JSON-RPC 결과로 바꾸고, 최상위 예외 핸들러를 단다.
//
// 상류 프로토콜
//   게이트웨이 `/mcp` 는 기본 **무상태**다(src/index.ts — LIVELY_MCP_SESSIONED off).
//   요청마다 새 서버/트랜스포트라 `initialize` 세션 수립이 필요 없고, `tools/list`·`tools/call`
//   을 곧바로 POST 하면 된다(실측). 응답은 SSE(`text/event-stream`) 프레임이라 data: 를 판다.
//
// 전달·업데이트
//   lively-mcp-local 과 같은 레일 — 번들 동봉(build-context.mjs) → lib/ 설치(user-install.mjs)
//   → self-update 가 매 세션 최신화. 등록은 command 절대경로만이라 코드가 바뀌어도 재등록 불요.
//   ⚠ 새 파일을 추가할 땐 그 두 매니페스트 배선을 반드시 함께 넣어라(#905 회귀).
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PROTOCOL = "2025-06-18";
const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
const CACHE_FILE = join(LIVELY, "mcp-tools-cache.json");

// 상류 타임아웃 — tools/list 는 짧게(부팅을 오래 붙잡지 않는다).
//  tools/call 기본 60초의 근거(#1080 실측): 라이블리 툴의 실제 소요는 0.03~0.36초다
//  (tools/list 0.025 · db_query 0.051 · project_list_v6 0.122 · whoami 0.127 · knowledge_search 0.355)
//  → 60초면 150배 이상 여유다. 종전 600초는 "http 직결의 하네스 상한보다 짧으면 회귀"라는 판단이었는데,
//  그 상한은 실측상 **무응답 300초 · 끊김 120초**여서 600초는 오히려 종전보다 길었다 —
//  게이트웨이가 멎으면 10분을 매단다. 짧게 잡되, 오래 걸리는 게 정상인 툴은 아래 callTimeoutFor 가 예외로 뺀다.
const LIST_TIMEOUT_MS = Number(process.env.LIVELY_MCP_LIST_TIMEOUT_MS || 8_000);
const CALL_TIMEOUT_MS = Number(process.env.LIVELY_MCP_CALL_TIMEOUT_MS || 60_000);
// delegate_run 전용 — 서버가 wait 모드에서 wait_sec 만큼 붙잡는다(src/capabilities/delegate.ts).
//  그 상한을 넘겨 우리가 먼저 끊으면 '완주한 위탁의 결과를 잃는' 회귀가 되므로 여유를 얹어 맞춘다.
const DELEGATE_DEFAULT_WAIT_SEC = 120;   // = delegate.ts DEFAULT_WAIT_SEC
const DELEGATE_SLACK_MS = 30_000;        // 서버 wait 상한 + 왕복 여유
const PROBE_TIMEOUT_MS = Number(process.env.LIVELY_MCP_PROBE_TIMEOUT_MS || 4_000);
// 상류 복구 감시 주기 — 상류가 죽어 있을 때만 돈다. 테스트가 짧게 줄여 쓴다.
const WATCH_INTERVAL_MS = Number(process.env.LIVELY_MCP_WATCH_MS || 20_000);

const readLively = (n) => { try { return readFileSync(join(LIVELY, n), "utf8").trim(); } catch { return ""; } };
const normGw = (u) => String(u || "").trim().replace(/\/+$/, "").replace(/\/mcp$/, "").replace(/\/+$/, "");
// ⚠ **파일이 env 를 이긴다(#916 의 런타임 판).** 설치기가 codex 용으로 rc 에
//  `export LIVELY_TOKEN="$(cat ~/.lively/token)"` 를 심으므로, 재로그인 뒤 같은 셸에서 뜬 세션의 env 는
//  **옛 토큰**이다. 종전 http 직결에선 설치가 파일 토큰을 구워 이 문제를 설치 시점에 막았는데(#916),
//  프록시는 매 호출 런타임에 신원을 고르므로 여기서 같은 규칙을 지켜야 한다 — 안 그러면 옛 신원으로
//  조용히 붙는다(둘 다 유효하니 401 도 안 난다 = 조용한 파손). 파일이 없을 때만 env 로 떨어진다
//  (프로비저닝·컨테이너처럼 파일 없이 env 로만 주는 경로 보존).
const gateway = () => normGw(readLively("gateway-url") || process.env.LIVELY_GATEWAY_URL);
const token = () => (readLively("token") || process.env.LIVELY_TOKEN || "").trim();

// stdout 은 JSON-RPC 전용 — 실수로 샌 console.log 가 프로토콜을 깨지 않게 stderr 로 묶는다.
console.log = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");
const log = (m) => process.stderr.write("[lively-mcp] " + m + "\n");

// ── 툴 스냅샷 캐시 ─────────────────────────────────────────────────────────
//  게이트웨이가 안 닿을 때 이 목록으로 툴 표면을 세운다. 게이트웨이 주소를 함께 저장해
//  다른 조직/게이트웨이의 스냅샷을 잘못 쓰지 않게 한다(주소가 다르면 캐시 무시).
function loadCache(gw) {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (!c || c.gateway !== gw || !Array.isArray(c.tools)) return null;
    return c;
  } catch { return null; }
}
function saveCache(gw, tools) {
  try {
    mkdirSync(LIVELY, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ gateway: gw, tools, saved_at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  } catch { /* fail-soft — 캐시를 못 써도 이번 세션엔 영향 없다 */ }
}

// ── 상류 호출 ──────────────────────────────────────────────────────────────
//  헤더 세트는 http 직결 등록과 **같은 의미**를 유지해야 한다(kit/cli/lively.mjs·register-clients.sh).
//   · Authorization  — 종전엔 설정 파일에 리터럴로 박혀 있었다. stdio 는 여기서 ~/.lively/token 을 읽으므로
//                      하네스 설정에서 평문 토큰이 사라진다(부수 효과: 시크릿 노출면 축소).
//   · x-lively-harness — 종전엔 하네스가 제 User-Agent 로 알렸다. 프록시를 거치면 UA 가 우리 것이 되므로
//                      **명시 stamp 가 필수**다(src/org/auth/agent-identity.ts — 헤더가 UA 보다 우선).
//   · x-lively-session / x-lively-mode — 종전엔 하네스가 `${LIVELY_SESSION_ID:-}` 를 제 env 로 확장해 보냈다.
//                      stdio 는 그 env 를 그대로 상속하므로 여기서 읽어 붙이면 같은 값이 된다.
function upstreamHeaders() {
  const h = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-lively-harness": (process.env.LIVELY_HARNESS || "claude-code").trim(),
  };
  const tok = token();
  if (tok) h.authorization = `Bearer ${tok}`;
  const sid = (process.env.LIVELY_SESSION_ID || "").trim();
  if (sid) h["x-lively-session"] = sid;
  const mode = (process.env.LIVELY_MODE || "").trim();
  if (mode) h["x-lively-mode"] = mode;
  // #1750 S3 — 셀프호스트 다중 워크스페이스: 세션 spawn 이 pane env 로 심은 소속(LVLY_TENANT_SLUG)을
  //  그대로 알린다. 게이트웨이 미들웨어가 이 헤더로 그 워크스페이스 컨텍스트를 연다(없으면 primary = 종전).
  const wsSlug = (process.env.LVLY_TENANT_SLUG || "").trim();
  if (wsSlug) h["x-lively-workspace"] = wsSlug;
  return h;
}

// SSE(text/event-stream) 또는 JSON 응답에서 JSON-RPC 메시지를 뽑는다.
//  무상태 단일 요청이라 보통 프레임 하나지만, 여러 개 오면 **응답(result/error)** 인 마지막 것을 쓴다.
function parseUpstreamBody(text, contentType) {
  if (contentType.includes("text/event-stream")) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const m = JSON.parse(payload);
        if (m && (m.result !== undefined || m.error !== undefined)) last = m;
      } catch { /* 부분 프레임 — 무시 */ }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

// 상류로 JSON-RPC 한 건을 보낸다. 반환: {ok:true, message} | {ok:false, reason}
//  네트워크·타임아웃·HTTP 오류를 **전부 여기서 삼킨다**(throw 금지 — 서버가 죽으면 안 된다).
async function callUpstream(body, timeoutMs) {
  const gw = gateway();
  if (!gw) return { ok: false, reason: "게이트웨이 주소를 모릅니다(lively login 필요)" };
  if (!token()) return { ok: false, reason: "로그인이 필요합니다(lively login)" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(gw + "/mcp", { method: "POST", signal: ctl.signal, headers: upstreamHeaders(), body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `게이트웨이 ${res.status}` };
    const msg = parseUpstreamBody(text, String(res.headers.get("content-type") || ""));
    if (!msg) return { ok: false, reason: "게이트웨이 응답을 해석하지 못했습니다" };
    return { ok: true, message: msg };
  } catch (e) {
    const m = String((e && e.message) || e);
    return { ok: false, reason: /abort/i.test(m) ? `게이트웨이 응답 없음(${timeoutMs}ms 초과)` : `게이트웨이에 닿지 못했습니다: ${m}` };
  } finally { clearTimeout(timer); }
}

// 상류 tools/list — 성공 시 툴 배열, 실패 시 null.
async function fetchUpstreamTools(timeoutMs) {
  const r = await callUpstream({ jsonrpc: "2.0", id: "gw-tools", method: "tools/list" }, timeoutMs);
  if (!r.ok || !r.message || !r.message.result || !Array.isArray(r.message.result.tools)) return null;
  return r.message.result.tools;
}

// tools/call 의 상류 타임아웃 — **툴별**로 고른다.
//  하네스가 주는 노브는 서버별 하나뿐이라(툴별은 없다 — #1080 실측), 거기선 "가장 오래 걸리는 툴"에
//  전체를 맞출 수밖에 없었다. 프록시는 우리 코드라 그 트레이드오프를 풀 수 있다 —
//  기본은 짧게(끊기거나 멎은 게이트웨이를 오래 붙잡지 않는다), 오래 기다리는 게 정상인 툴만 길게.
//  지금 그런 툴은 delegate_run 뿐이다(무거운 작업 위탁 — 서버가 wait_sec 만큼 붙잡는다).
export function callTimeoutFor(params) {
  if (!params || params.name !== "delegate_run") return CALL_TIMEOUT_MS;
  const a = params.arguments || {};
  if (a.wait === false) return CALL_TIMEOUT_MS;   // 즉시 접수 모드 — 길게 줄 이유가 없다
  const sec = Number(a.wait_sec);
  return (Number.isFinite(sec) && sec > 0 ? sec : DELEGATE_DEFAULT_WAIT_SEC) * 1000 + DELEGATE_SLACK_MS;
}

const toolKey = (tools) => tools.map((t) => t && t.name).sort().join(" ");

// ═══════════════════════════════════════════════════════════════════════════
//  런타임 — MCP stdio(JSON-RPC 2.0, newline-delimited)
// ═══════════════════════════════════════════════════════════════════════════
export function serveMcpGateway({ input = process.stdin, output = process.stdout } = {}) {
  const send = (m) => { try { output.write(JSON.stringify(m) + "\n"); } catch { /* stdout 닫힘 */ } };
  const okr = (id, result) => send({ jsonrpc: "2.0", id, result });

  let lastTools = null;      // 하네스에 마지막으로 보여준 툴 목록(= list_changed 판정 기준)
  let upstreamDown = false;  // 마지막 상류 접촉이 실패했나 — 워처는 이때만 폴링한다
  let watcher = null;

  // 상류가 살아나면(또는 툴이 바뀌면) 하네스에 목록 재조회를 요청한다.
  //  ⚠ 폴링은 **상류가 죽어 있을 때만** 돈다 — 정상 세션에 배경 트래픽을 만들지 않는다.
  let probing = false;       // 재진입 가드 — 프로브가 주기보다 느리면 알림이 중복 발신된다
  function ensureWatcher() {
    if (watcher) return;
    watcher = setInterval(async () => {
      if (!upstreamDown || probing) return;
      probing = true;
      try { await probeOnce(); } finally { probing = false; }
    }, WATCH_INTERVAL_MS);
    if (typeof watcher.unref === "function") watcher.unref(); // 프로세스 종료를 막지 않는다
  }
  async function probeOnce() {
    const tools = await fetchUpstreamTools(PROBE_TIMEOUT_MS);
    if (!tools) return;                         // 아직 안 닿음 — 조용히 다음 주기
    upstreamDown = false;
    saveCache(gateway(), tools);
    // 툴 구성이 그대로면 알리지 않는다 — 알림 한 번이 하네스의 tools/list 한 번이다.
    if (lastTools && toolKey(tools) === toolKey(lastTools)) { log("상류 복구 — 툴 목록 동일(알림 생략)"); return; }
    lastTools = tools;
    log(`상류 복구 — tools/list_changed 발신(툴 ${tools.length}개)`);
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  const rl = createInterface({ input });
  rl.on("line", async (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        // 상류 없이 즉답한다 — 이 즉답이 이 프록시의 존재 이유다(게이트웨이가 죽어 있어도 connected).
        okr(id, {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL,
          capabilities: { tools: { listChanged: true } },   // ★ 복구 시 목록 갱신을 밀어넣기 위해 필수
          serverInfo: { name: "lively", version: readLively("kit-version") || "0.1.0" },
        });
        ensureWatcher();
        return;
      }
      if (method && method.startsWith("notifications/")) return; // 알림 — 응답 없음
      if (method === "ping") { okr(id, {}); return; }

      if (method === "tools/list") {
        const gw = gateway();
        const tools = await fetchUpstreamTools(LIST_TIMEOUT_MS);
        if (tools) {
          upstreamDown = false;
          saveCache(gw, tools);
          lastTools = tools;
          okr(id, { tools });
          return;
        }
        // 상류 미도달 — 마지막 성공 스냅샷으로 표면을 세운다(없으면 빈 목록).
        //  어느 쪽이든 서버는 connected 로 남고, 상류가 살아나면 워처가 목록을 밀어 넣는다.
        upstreamDown = true;
        ensureWatcher();
        const cached = loadCache(gw);
        const fallback = cached ? cached.tools : [];
        lastTools = fallback;
        log(`상류 미도달 — ${cached ? `캐시 스냅샷 ${fallback.length}개로 응답(${cached.saved_at})` : "캐시 없음 → 빈 목록"}. 복구되면 자동 갱신.`);
        okr(id, { tools: fallback });
        return;
      }

      if (method === "tools/call") {
        const r = await callUpstream({ jsonrpc: "2.0", id: id ?? "gw-call", method: "tools/call", params }, callTimeoutFor(params));
        if (r.ok && r.message) {
          upstreamDown = false;
          if (r.message.error) { okr(id, { content: [{ type: "text", text: `오류: ${r.message.error.message || "게이트웨이 오류"}` }], isError: true }); return; }
          okr(id, r.message.result);
          return;
        }
        // 상류 실패는 **툴 오류**로 돌려준다(JSON-RPC 오류가 아니라) — 세션·연결은 그대로 살아 있고,
        //  VPN 이 붙는 즉시 다음 호출부터 정상 동작한다. 사람이 뭘 해야 하는지도 여기서 알린다.
        upstreamDown = true;
        ensureWatcher();
        okr(id, { content: [{ type: "text", text: `오류: ${r.reason}\n(게이트웨이 연결이 끊긴 상태입니다 — VPN·네트워크를 확인하세요. 연결되면 재시작 없이 그대로 다시 동작합니다.)` }], isError: true });
        return;
      }

      // 그 밖의 메서드(resources/*·prompts/* 등)는 상류에 그대로 위임한다.
      if (id !== undefined) {
        const r = await callUpstream({ jsonrpc: "2.0", id, method, params }, LIST_TIMEOUT_MS);
        if (r.ok && r.message) { send({ ...r.message, jsonrpc: "2.0", id }); return; }
        upstreamDown = true;
        send({ jsonrpc: "2.0", id, error: { code: -32603, message: r.reason } });
      }
    } catch (e) {
      // 여기까지 오면 우리 버그다 — 그래도 프로세스는 살린다(죽으면 하네스가 못 되살린다).
      log(`처리 중 예외(무시하고 계속): ${(e && e.stack) || e}`);
      if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String((e && e.message) || e) } });
    }
  });
  // stdin 이 닫히면(하네스 종료) 감시도 멈춘다 — 실제 프로세스는 곧 끝나지만, 한 프로세스가
  //  여러 서버를 띄우는 경우(테스트)에 죽은 인스턴스의 워처가 계속 도는 것을 막는다.
  return new Promise((resolve) => rl.on("close", () => { if (watcher) { clearInterval(watcher); watcher = null; } resolve(); }));
}

// 최상위 안전망 — 어떤 예외도 이 프로세스를 죽이지 못하게(stdio MCP 는 재시작이 없다).
process.on("uncaughtException", (e) => log(`uncaughtException(무시): ${(e && e.stack) || e}`));
process.on("unhandledRejection", (e) => log(`unhandledRejection(무시): ${(e && e.stack) || e}`));

// direct run — `node lively-mcp-gateway.mjs` (테스트/디버그) 일 때만. lively.mjs 가 import 하면 안 돈다.
const DIRECT_RUN = (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ""); }
  catch { return false; }
})();
if (DIRECT_RUN) serveMcpGateway().then(() => process.exit(0));

export { loadCache, saveCache, parseUpstreamBody, upstreamHeaders, toolKey };

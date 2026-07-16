#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// lively-mcp-local — 로컬 조작 전용 stdio MCP 서버  (`lively mcp-local` 이 실행)
// ═══════════════════════════════════════════════════════════════════════════
//
// 무엇 · 왜
//   lively 본체(http `lively`, `/mcp`)는 **공유 컨텍스트**(지식·프로젝트·DB)를 맡는다.
//   이 서버는 그 반대편 — **그 노트북에서만 할 수 있는 로컬 조작**(git init/push·
//   워크트리·로컬 파일/상태)을 하네스에 노출한다. stdio 라 하네스와 같은 머신·같은
//   유저로 spawn 되어 로컬 리소스에 직접 닿고, MCP 라 툴 스키마가 매 세션 자동
//   주입된다(= 발견성). 판정·근거: 지식 lively-cli-local-stdio-mcp-899.
//
//   전달·업데이트: 이 파일은 /install 번들에 동봉돼 kit_version 지문에 포함된다 →
//   자동 업데이트(#858)가 ~/.lively/lib/lively-mcp-local.mjs 를 매 세션 최신으로
//   유지한다. claude 는 `lively mcp-local` 을 매 세션 새로 spawn 하므로, 코드가
//   바뀌어도 `claude mcp` 재등록은 필요 없다(툴 목록 자체를 바꿀 때만 —
//   registerClaudeMcp 가 add, self-update 는 코드만 갱신).
//
// ───────────────────────────────────────────────────────────────────────────
//  ★ 새 로컬 툴 추가법 — 아래 TOOLS 배열에 항목 하나만 추가하면 끝. ★
//    프로토콜 코드(맨 아래 "런타임")는 건드리지 않는다.
//
//      {
//        name: "lively_local_<동사>",   // 반드시 lively_local_ 접두(네임스페이스)
//        title: "짧은 사람용 제목",       // (선택)
//        description: "하네스가 '언제·왜' 쓸지 판단할 상세 설명. 한국어 OK.",
//        inputSchema: { type:"object", properties:{…}, required:[…], additionalProperties:false },
//        handler: async (args, ctx) => { … }   // 반환값이 곧 결과
//      }
//
//    handler(args, ctx):
//      • args = 하네스가 준 인자(inputSchema 대로). required 필드는 런타임이 존재 검증.
//      • ctx  = { cwd, gateway, token, sh, api, text, json, log } — 아래 makeCtx 참고.
//      • 반환 = 문자열 / 객체 / ctx.text()·ctx.json() / {content:[…]} 아무거나.
//               throw 하면 tool-error(isError)로 하네스에 전달된다(서버는 안 죽는다).
//
//    ⚠ 판정 규칙 — **"하네스가 백그라운드로 기다려야 하는 작업"은 넣지 마라**
//      (예: `delegate` 처럼 오래 걸리는 위탁). MCP 호출은 stdio 든 http 든 하네스에서
//      인라인 동기 블로킹이라 백그라운드가 안 된다 → 그런 건 CLI(`lively delegate`)를
//      Bash(run_in_background)로 남긴다(지식 delegate-background-cli-not-mcp-wait).
//      여기엔 **몇 초 안에 동기 완결되는 로컬 조작만**.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { repoList, repoWorktree, repoWorktreeRemove } from "./repo-worktree-core.mjs"; // #900 코어 공유(CLI `lively repo` 와 동일)

const PROTOCOL = "2025-06-18";
const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
const readLively = (n) => { try { return readFileSync(join(LIVELY, n), "utf8").trim(); } catch { return ""; } };
// gateway-url / token 규약은 lively.mjs 와 동일(/mcp 없이 저장, Bearer 헤더).
const normGw = (u) => String(u || "").trim().replace(/\/+$/, "").replace(/\/mcp$/, "").replace(/\/+$/, "");
const gateway = () => normGw(process.env.LIVELY_GATEWAY_URL || readLively("gateway-url"));
const token = () => (process.env.LIVELY_TOKEN || readLively("token")).trim();

// stdout 은 JSON-RPC 전용이다 — 실수로 새어나간 console.log 가 프로토콜을 깨지 않게 stderr 로 묶는다.
console.log = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");

// ── handler 에 주입되는 컨텍스트 ─────────────────────────────────────────────
function makeCtx(callCwd) {
  // 게이트웨이 REST(Bearer 자동) — 로컬 툴이 공유 데이터가 필요할 때(예: 레포 clone_url 조회).
  const api = async (path, { method = "GET", body, timeoutMs = 15000 } = {}) => {
    const gw = gateway(), tok = token();
    if (!gw) throw new Error("게이트웨이 주소를 모릅니다(lively login 필요)");
    if (!tok) throw new Error("로그인이 필요합니다(lively login)");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const headers = { authorization: `Bearer ${tok}` };
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(gw + path, { method, signal: ctl.signal, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      if (!res.ok) throw new Error(`게이트웨이 ${res.status} (${path})`);
      return await res.json();
    } finally { clearTimeout(timer); }
  };
  // 로컬 셸 명령 — 로컬 조작의 본체. 기본 cwd 는 하네스가 spawn 한 작업 디렉토리.
  const sh = (cmd, args = [], { cwd = callCwd, input, allowFail = false } = {}) => {
    try {
      const stdout = execFileSync(cmd, args, { cwd, input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      return { stdout, stderr: "", code: 0 };
    } catch (e) {
      if (allowFail) return { stdout: e.stdout ? String(e.stdout) : "", stderr: e.stderr ? String(e.stderr) : "", code: e.status ?? 1 };
      throw new Error(`${cmd} 실패: ${((e.stderr && String(e.stderr)) || e.message || "").trim().split("\n")[0]}`);
    }
  };
  return {
    cwd: callCwd,
    gateway: gateway(),
    token: token(),
    api,
    sh,
    text: (s) => ({ content: [{ type: "text", text: String(s) }] }),
    json: (o) => ({ content: [{ type: "text", text: JSON.stringify(o, null, 2) }] }),
    log: (m) => process.stderr.write("[lively-mcp-local] " + m + "\n"),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  TOOLS — ★여기에 추가★   (현재는 스캐폴드라 비어 있음)
//
//  아래 예시는 주석이다. 실제 툴을 붙일 땐 이 형태로 배열에 항목을 넣으면,
//  tools/list · tools/call 이 자동으로 반영한다(런타임 수정 불요).
//
//  // {
//  //   name: "lively_local_git_status",
//  //   title: "로컬 git 상태",
//  //   description: "지정 경로(기본 cwd)의 git 워킹트리 상태를 반환한다 — 중앙 게이트웨이가 못 보는 로컬 상태.",
//  //   inputSchema: { type: "object", properties: { path: { type: "string", description: "레포 경로(기본 cwd)" } }, additionalProperties: false },
//  //   handler: (args, ctx) => ctx.text(ctx.sh("git", ["-C", args.path || ctx.cwd, "status", "--short", "--branch"]).stdout || "(clean)"),
//  // },
// ═══════════════════════════════════════════════════════════════════════════
const TOOLS = [];

// 다른 모듈/테스트가 프로그램적으로 툴을 조립할 때 쓰는 등록 유틸(배열 직접 push 와 동등).
function registerTool(tool) { TOOLS.push(tool); return tool; }

// ═══════════════════════════════════════════════════════════════════════════
//  빌트인 로컬 툴 — 레포/워크트리 셀프서비스 (#900). 로직은 repo-worktree-core.mjs(CLI `lively repo` 와 공유·드리프트 0).
//   어느 실행 환경(박스·로컬PC·워커노드)에서든 cwd 에 최신 워크트리를 떠서 그 위에서 작업하게 한다. base(공유
//   원본)는 규율상 pristine — 코어가 fetch 로 refs 만 갱신하고 origin/<ref> 에서 워크트리를 분기한다.
// ═══════════════════════════════════════════════════════════════════════════

registerTool({
  name: "lively_local_repo_list",
  title: "이 머신에서 워크트리 뜰 수 있는 레포",
  description: "관리탭에 등록된 레포 목록 + 이 머신 로컬 base 클론 상태(클론됨?·현재 브랜치·origin 대비 최신)를 반환한다. "
    + "코드 작업을 시작하기 전에 '어떤 레포를 lively_local_repo_worktree 로 뜰 수 있는지' 확인하는 용도. "
    + "base 는 pristine 공유 원본이니 직접 작업하지 말고 워크트리를 떠서 작업하라.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => ctx.json(await repoList(ctx)),
});

registerTool({
  name: "lively_local_repo_worktree",
  title: "레포 워크트리를 cwd 에 생성(코드 작업 준비)",
  description: "등록된 레포의 최신 코드를 이 머신에 확보(로컬에 없으면 clone·있으면 fetch)한 뒤, 지정 경로(기본 cwd 하위 <repo>)에 "
    + "격리 브랜치로 git worktree 를 만든다. 반환된 worktree 경로에서 코드 작업(편집·커밋·빌드)을 하라 — base(pristine 공유 원본)에서 "
    + "직접 작업하지 말 것. 프로젝트 세션이면 브랜치 기본값은 project/<id>. 몇 초 내 동기 완결. 코드 작업이 필요할 때 먼저 이걸 호출해 작업면을 준비하라.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "레포 이름(lively_local_repo_list 의 name)" },
      path: { type: "string", description: "워크트리를 만들 경로(절대 또는 cwd 상대). 기본 cwd/<repo>" },
      branch: { type: "string", description: "워크트리 브랜치. 기본: 프로젝트 세션이면 project/<id>, 아니면 wt/<repo>" },
      ref: { type: "string", description: "이 ref(origin/<ref>)에서 분기. 기본: origin 기본 브랜치 최신" },
    },
    required: ["repo"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => ctx.json(await repoWorktree(ctx, args)),
});

registerTool({
  name: "lively_local_repo_worktree_remove",
  title: "워크트리 제거",
  description: "lively_local_repo_worktree 로 만든 워크트리를 제거한다(base·다른 워크트리 무영향). 커밋 안 한 변경이 있으면 실패하니 정리 후 재시도하거나 force:true 로.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "레포 이름" },
      path: { type: "string", description: "워크트리 경로(절대 또는 cwd 상대). 기본 cwd/<repo>" },
      force: { type: "boolean", description: "커밋 안 한 변경이 있어도 제거" },
    },
    required: ["repo"],
    additionalProperties: false,
  },
  handler: (args, ctx) => ctx.text(`제거됨: ${repoWorktreeRemove(ctx, args).removed}`),
});

// ═══════════════════════════════════════════════════════════════════════════
//  런타임 — MCP stdio(JSON-RPC 2.0, newline-delimited).  ★툴 추가 시 건드리지 말 것★
// ═══════════════════════════════════════════════════════════════════════════

// tool 반환값을 MCP tools/call result 로 정규화. {content:[…]} 형태면 그대로(isError 포함 가능).
function normalizeResult(v) {
  if (v == null) return { content: [{ type: "text", text: "(완료)" }] };
  if (typeof v === "string") return { content: [{ type: "text", text: v }] };
  if (typeof v === "object" && Array.isArray(v.content)) return v;
  return { content: [{ type: "text", text: JSON.stringify(v, null, 2) }] };
}

function validateArgs(tool, args) {
  const req = (tool.inputSchema && tool.inputSchema.required) || [];
  const missing = req.filter((k) => args == null || args[k] === undefined);
  if (missing.length) throw new Error(`필수 인자 누락: ${missing.join(", ")}`);
}

async function handleCall(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error("알 수 없는 툴: " + name);
  validateArgs(tool, args || {});
  const out = await tool.handler(args || {}, makeCtx(process.cwd()));
  return normalizeResult(out);
}

function toolSpec(t) {
  return { name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description || "", inputSchema: t.inputSchema || { type: "object", properties: {} } };
}

export function serveMcpLocal({ input = process.stdin, output = process.stdout } = {}) {
  const send = (m) => output.write(JSON.stringify(m) + "\n");
  const okr = (id, result) => send({ jsonrpc: "2.0", id, result });
  const errr = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const rl = createInterface({ input });
  rl.on("line", async (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        okr(id, {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lively-local", version: readLively("kit-version") || "0.1.0" },
          instructions: "라이블리 로컬 조작 도구 — 그 노트북에서만 되는 git·워크트리·로컬 파일 작업. 툴 이름은 lively_local_* .",
        });
      } else if (method === "notifications/initialized" || method === "notifications/cancelled") {
        // 알림 — 응답 없음
      } else if (method === "tools/list") {
        okr(id, { tools: TOOLS.map(toolSpec) });
      } else if (method === "tools/call") {
        try {
          okr(id, await handleCall(params && params.name, params && params.arguments));
        } catch (e) {
          // tool 실행 오류는 프로토콜 오류(JSON-RPC error)가 아니라 result.isError 로 — 하네스가 읽고 대처한다.
          okr(id, { content: [{ type: "text", text: "오류: " + String((e && e.message) || e) }], isError: true });
        }
      } else if (method === "ping") {
        okr(id, {});
      } else if (id !== undefined) {
        errr(id, -32601, "지원하지 않는 메서드: " + method);
      }
    } catch (e) {
      if (id !== undefined) errr(id, -32603, String((e && e.message) || e));
    }
  });
  return new Promise((resolve) => rl.on("close", resolve));
}

// direct run — `node lively-mcp-local.mjs` (테스트/디버그) 일 때만. lively.mjs 가 import 하면 안 돈다.
//  realpath 비교: /tmp 는 macOS 서 /private/tmp 심링크라 URL 문자열 비교가 어긋난다(lively.mjs 와 동일 가드).
const DIRECT_RUN = (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ""); }
  catch { return false; }
})();
if (DIRECT_RUN) serveMcpLocal().then(() => process.exit(0));

export { TOOLS, registerTool, makeCtx, handleCall, toolSpec };

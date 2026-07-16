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

import { readFileSync, realpathSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { repoList, repoWorktree, repoWorktreeRemove, repoPin, repoPinRemove } from "./repo-worktree-core.mjs";
import { projectInit } from "./project-init-core.mjs"; // #905 C2a 코어 공유(CLI `lively init` 과 동일) // #900 코어 공유(CLI `lively repo` 와 동일)

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

// alwaysLoad(list·worktree 2종) — 코드 작업의 '작업면 준비' 진입점이라 세션이 스스로 발견해야 한다.
//  #918: 프로젝트 세션은 워크트리 없이 뜰 수 있고(레포 미연결이면 항상), 그때 이 둘을 못 찾으면 공유 base 를
//  ls 로 더듬거나(#906) base 에서 직접 작업하는 사고로 간다. deferred 면 '툴이 있는 줄 알아야 검색한다'는
//  순환이라 발견을 WIKI 인덱스 제목 한 줄의 운에 맡기게 된다 — 그래서 이 둘만 항상 싣는다.
//  pin 계열은 pin-sources 스킬이 이름을 직접 알려주므로 deferred 로 둔다(스키마 상시 점유 최소화).
const ALWAYS_LOAD = { "anthropic/alwaysLoad": true };

registerTool({
  name: "lively_local_repo_list",
  title: "이 머신에서 워크트리 뜰 수 있는 레포",
  description: "관리탭에 등록된 레포 목록 + 이 머신 로컬 base 클론 상태(클론됨?·현재 브랜치·origin 대비 최신)를 반환한다. "
    + "코드 작업을 시작하기 전에 '어떤 레포를 lively_local_repo_worktree 로 뜰 수 있는지' 확인하는 용도 — "
    + "프로젝트에 레포가 연결돼 있지 않아도(또는 cwd 에 코드가 없어도) 이걸로 후보를 확인할 수 있다. "
    + "base 는 pristine 공유 원본이니 직접 작업하지 말고 워크트리를 떠서 작업하라.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  _meta: ALWAYS_LOAD,
  handler: async (_args, ctx) => ctx.json(await repoList(ctx)),
});

registerTool({
  name: "lively_local_repo_worktree",
  title: "레포 워크트리를 cwd 에 생성(코드 작업 준비)",
  description: "등록된 레포의 최신 코드를 이 머신에 확보(로컬에 없으면 clone·있으면 fetch)한 뒤, 지정 경로(기본 cwd 하위 <repo>)에 "
    + "격리 브랜치로 git worktree 를 만든다. 반환된 worktree 경로에서 코드 작업(편집·커밋·빌드)을 하라 — base(pristine 공유 원본)에서 "
    + "직접 작업하지 말 것. 프로젝트 세션이면 브랜치 기본값은 project/<id>. 몇 초 내 동기 완결. 코드 작업이 필요할 때 먼저 이걸 호출해 작업면을 준비하라 "
    + "— 세션이 코드 없는 폴더에서 떴어도 그게 정상이다(워크트리는 세션 생성이 아니라 이 툴이 만든다).",
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
  _meta: ALWAYS_LOAD,
  handler: async (args, ctx) => ctx.json(await repoWorktree(ctx, args)),
});

// ═══════════════════════════════════════════════════════════════════════════
//  프로젝트 자산화 (#905 C2a) — 이 폴더를 라이블리 프로젝트로.
//   로컬에서 도는 이유: 로컬 git origin 을 읽고 **로컬 마커를 심어야** 하므로 중앙이 대신 못 한다.
//   중앙이 아는 것(이 origin 을 쓰는 프로젝트가 있나 / 내 폴더 위치 기록)은 REST 로 묻는다.
// ═══════════════════════════════════════════════════════════════════════════

registerTool({
  name: "lively_local_project_init",
  title: "이 폴더를 라이블리 프로젝트로 (git init 처럼)",
  description: "지금 폴더(기본 cwd)를 라이블리 프로젝트에 연결한다 — **기존 프로젝트에 붙이거나(bind) 새로 만들거나(create)**. "
    + "연결되면 그 폴더에서 뜨는 세션이 프로젝트 맥락(AGENTS.md·태스크·지식)을 갖고, 작업이 그 프로젝트 타임라인에 귀속된다.\n"
    + "**mode=auto(기본)는 아무것도 바꾸지 않고 '무엇을 해야 하는지'만 돌려준다** — 실제 연결은 create/bind 로 명시 호출한다. "
    + "판정은 git origin(멤버 간 동일한 유일 값)으로 하며, 후보가 0개거나 여럿이면 **사람에게 묻는다**(멋대로 새로 만들지 않는다 — "
    + "다른 멤버가 이미 만든 프로젝트를 중복 생성하는 게 가장 흔한 사고다).\n"
    + "⚠ 이미 프로젝트인 폴더(상위 포함)에선 아무것도 하지 않는다 — 프로젝트 중첩은 허용하지 않는다.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["auto", "create", "bind"], description: "auto(기본)=판정만 하고 제안 반환(무변경) · create=새 프로젝트 생성 후 연결 · bind=project_id 의 기존 프로젝트에 연결" },
      project_id: { type: "number", description: "mode=bind 일 때 붙을 프로젝트 id" },
      name: { type: "string", description: "mode=create 일 때 프로젝트 이름(생략 시 폴더명)" },
      path: { type: "string", description: "대상 폴더(절대 또는 cwd 상대). 기본 cwd" },
      list_id: { type: "number", description: "mode=create 일 때 소속 리스트(영역) id — 생략하면 미분류로 두고 나중에 보드에서 분류한다(추측하지 말 것)" },
    },
    additionalProperties: false,
  },
  // ⚠ alwaysLoad 안 함(의도) — repo_list/worktree 와 달리 이건 **매 세션 필요한 게 아니다**(프로젝트가 아닌 폴더에서
  //  한 번뿐). 이름이 deferred 목록에 노출되므로 "이 폴더 프로젝트로 만들어줘" 류 요청에는 검색으로 닿는다.
  //  진짜 '자율'(사람이 말 안 해도 먼저 제안)은 툴 적재가 아니라 **문턱 트리거**의 문제다 — D4 후보 4개(커밋·shared
  //  산출물·N분·2번째 세션)가 현재 전부 관측 불가라 별건이다. 그게 서면 stop-writeback-gate 형 훅이 이 툴을 지목하면 된다.
  handler: async (args, ctx) => ctx.json(await projectInit(ctx, args)), // 로직은 project-init-core(CLI `lively init` 과 공유·드리프트 0)
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

registerTool({
  name: "lively_local_repo_pin",
  title: "코드 근거 분석용 읽기전용 핀(SHA 고정)",
  description: "코드를 근거로 판단하기 전(리뷰·분석·설계) **먼저 호출하라**. 대상 레포를 이 머신에 확보(없으면 clone·있으면 fetch)한 뒤 "
    + "origin/<ref> 를 detached(브랜치 없음 = SHA 고정) 워크트리로 떠서 경로와 SHA 를 돌려준다. 이후 그 레포의 코드 인용·grep 은 "
    + "반드시 이 핀 경로에서만 하라 — stale 클론·남의 작업 브랜치 오독·분석 중 HEAD 드리프트로 잘못된 코드 근거 결론이 나오는 걸 막는다. "
    + "리포트·지식엔 경로가 아니라 repo@sha 로 앵커한다(다음 세션이 그 SHA 로 재핀하면 동일 truth 재현). 끝나면 lively_local_repo_pin_remove.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "레포 이름(lively_local_repo_list 의 name)" },
      ref: { type: "string", description: "핀할 ref(origin/<ref>). 기본: origin 기본 브랜치(main 등)" },
      path: { type: "string", description: "핀 경로(절대 또는 cwd 상대). 기본: OS 임시디렉터리(세션 임시물)" },
    },
    required: ["repo"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => ctx.json(await repoPin(ctx, args)),
});

registerTool({
  name: "lively_local_repo_pin_remove",
  title: "핀 제거",
  description: "lively_local_repo_pin 으로 만든 읽기전용 핀을 제거한다(base·작업 워크트리 무영향). 분석이 끝나면 호출해 정리한다.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "레포 이름" },
      path: { type: "string", description: "핀 경로(생성 때 지정했다면 같은 값). 기본: 생성 때와 동일 기본값" },
    },
    required: ["repo"],
    additionalProperties: false,
  },
  handler: (args, ctx) => ctx.text(`핀 제거됨: ${repoPinRemove(ctx, args).removed}`),
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

// _meta 는 MCP 표준 확장 슬롯 — 하네스별 힌트를 싣는다(모르는 하네스는 무시하므로 무해).
//  현재 용도: anthropic/alwaysLoad(아래 레포 툴 2종) — Claude Code 의 tool search 가 기본 활성이라
//  MCP 툴은 deferred(이름만 실리고 스키마는 ToolSearch 후)인데, 그 두 개만 항상 실리게 뺀다.
function toolSpec(t) {
  return {
    name: t.name, ...(t.title ? { title: t.title } : {}),
    description: t.description || "",
    inputSchema: t.inputSchema || { type: "object", properties: {} },
    ...(t._meta ? { _meta: t._meta } : {}),
  };
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
          // instructions 는 tool search 가 켜진 하네스에서 '언제 이 툴들을 찾아야 하는지'를 알려주는 자리다
          //  (deferred 툴은 이름만 실리므로 — pin 계열이 여기에 기댄다). repo_list·repo_worktree 는 _meta.alwaysLoad 로
          //  스키마가 항상 실리지만, '언제 쓰는지'는 여기서 한 번 더 못박는다(#918: 워크트리 없이 뜬 세션의 첫 수).
          instructions: "라이블리 로컬 조작 도구 — 그 노트북에서만 되는 git·워크트리·로컬 파일 작업. 툴 이름은 lively_local_* . "
            + "코드를 만져야 하는데 지금 폴더에 레포가 없으면 그게 정상이다: lively_local_repo_list 로 후보를 보고 "
            + "lively_local_repo_worktree 로 워크트리를 떠서 그 위에서 작업하라(공유 base 직접작업 금지). "
            + "고치지 않고 읽기만 할 거면 lively_local_repo_pin 으로 SHA 고정 핀을 떠서 인용하라.",
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

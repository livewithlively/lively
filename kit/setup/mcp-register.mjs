#!/usr/bin/env node
// MCP 서버를 Claude Code 설정에 등록한다 — **CLI 를 부르지 않고 파일에 직접 쓴다**.
//
//  ── 왜 파일 쓰기인가 (실측 2026-08-31, 매니지드 프로덕션에서 터진 뒤) ──
//  종전에는 `claude mcp add …` 를 셸에서 불렀다. 그런데 매니지드의 키트 시딩은 **멤버 exec 중계**를 타고,
//  그 중계는 테넌트의 «항상 떠 있는» 컨테이너(`lvly-s-<slug>-tmux`)로 나간다. 그 컨테이너가 tmux 용으로
//  고른 자리일 뿐 «하네스 바이너리가 있는 자리» 라는 보장이 없다는 게 문제였다 — 이미지가 분리되면서
//  tmux 이미지에서 claude·codex·agy·grok 이 전부 빠졌고, 그 순간 키트 시딩이 이 한 줄에서 죽었다:
//
//      setup/register-clients.sh: line 23: claude: command not found
//
//  `set -euo pipefail` 이라 거기서 스크립트가 통째로 끝났다. 결과: 훅·settings.json·lib 까지 **전부** 안 심기고,
//  로그는 «비치명» 한 줄이라 아무도 몰랐다. 새로 시딩되는 멤버만 조용히 반쪽이 됐다.
//
//  근본 원인은 «바이너리가 없다» 가 아니라 **설정 파일 쓰기가 바이너리 존재를 요구한 것**이다.
//  `claude mcp add --scope user` 가 하는 일은 `~/.claude.json` 최상위 `mcpServers` 에 한 항목을 넣는 것뿐이다
//  (실측 — 아래 SHAPE 주석). 키트는 이미 `~/.claude/settings.json`(훅)을 node 로 직접 쓴다. 같은 층으로 내린다.
//
//  이 파일이 생기면서 키트 시딩이 중계 대상 컨테이너에 요구하는 것은 **«홈이 마운트돼 있고 node 가 있다»** 뿐이다.
//
//  ── 실측 스키마 (claude 2.1.x, `--scope user`) ──
//   최상위 `mcpServers` 에 들어간다(`projects` 아래가 아니다 — scope 차이를 실측으로 확인했다).
//     stdio: { "type": "stdio", "command": "<abs>", "args": [...], "env": {} }
//     http : { "type": "http",  "url": "<url>",     "headers": { "<k>": "<v>" } }
//   ⚠ 헤더 값의 `${LIVELY_SESSION_ID:-}` 같은 표기는 **리터럴로 저장**된다 — Claude Code 가 연결 시점에
//    제 env 로 확장한다. 그래서 여기서 확장하면 안 된다(확장하면 세션 밖에서 빈 값이 굳는다).
//
//  ── 하지 않는 것 ──
//  · codex·agy·grok 은 이 스크립트가 건드리지 않는다(종전과 같다 — 각자 배선이 따로 있다).
//  · 사람이 직접 등록한 항목은 **보존**한다. 우리가 넣은 것만 회수한다(managed-mcp-servers.json 대조).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HOME = process.env.HOME || "";
const LIVELY = join(HOME, ".lively");
const CLAUDE_JSON = join(HOME, ".claude.json");
/** 우리가 넣은 이름들 — 다음 실행에서 «빠진 것» 을 회수하는 근거. auto-approve 의 managed-auto-approve.json 과 동형. */
const MANAGED = join(LIVELY, "managed-mcp-servers.json");
/** 설치 전부터 그 이름을 쓰던 사람의 원본 — 제거(uninstall) 때 되돌리려고 **최초 1회만** 찍는다. */
const USER_BACKUP = join(LIVELY, "mcp-user-backup.json");

const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
};

/** 원자적 쓰기 — 반쯤 쓰인 `.claude.json` 은 Claude Code 가 통째로 못 읽어 MCP 가 전부 사라진다. */
function writeJsonAtomic(path, value, mode) {
  const tmp = `${path}.lvly-tmp`;
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* 있으면 그만 */ }
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  renameSync(tmp, path);
}

/**
 * (순수) 지금 등록해야 할 서버 목록을 만든다.
 *  env 와 파일을 **읽기만** 하는 자리와 분리해 두어야 테스트가 프로세스 없이 검사할 수 있다.
 */
export function planServers(o) {
  const out = [];
  // ① lively 본체 — 로컬 stdio 프록시가 원칙(#1079). http 직결은 프록시 미설치·롤백 스위치일 때만.
  //    stdio 는 로컬 프로세스라 항상 connected 이고, 상류가 살아나면 tools/list_changed 로 되살아난다.
  //    http 직결은 세션이 뜨는 순간 게이트웨이에 못 닿으면 Claude Code 가 그 세션 내내 failed 로 굳힌다.
  if (o.shimUsable && o.transportOverride !== "http") {
    out.push({ name: "lively", type: "stdio", command: o.shim, args: ["mcp"], env: {} });
  } else {
    out.push({
      name: "lively", type: "http", url: o.storeUrl,
      headers: {
        Authorization: `Bearer ${o.token}`,
        // ⚠ 리터럴로 남긴다 — Claude Code 가 연결 시 제 env 로 확장한다(위 스키마 주석).
        "x-lively-session": "${LIVELY_SESSION_ID:-}",
        "x-lively-mode": "${LIVELY_MODE:-}",
        "x-lively-workspace": "${LVLY_TENANT_SLUG:-}",
      },
    });
  }
  // ② 조직이 등록한 추가 서버(org_mcp_server). 인증은 auth_env **간접참조** — 토큰 리터럴이 파일에 없다.
  for (const s of o.orgServers || []) {
    const name = String(s.name || "").trim();
    if (!name || name === "lively" || s.enabled === false) continue;
    if ((s.transport || "http") === "stdio") {
      const parts = String(s.command || "").trim().split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      out.push({ name, type: "stdio", command: parts[0], args: parts.slice(1), env: {} });
    } else {
      if (!s.url) continue;
      const tok = s.auth_env ? (o.env?.[s.auth_env] || "") : "";
      out.push({ name, type: "http", url: s.url, ...(tok ? { headers: { Authorization: `Bearer ${tok}` } } : {}) });
    }
  }
  return out;
}

/**
 * (순수) 기존 설정 + 계획 → 새 설정. 사람이 직접 넣은 항목은 **건드리지 않는다.**
 *  prevManaged 에 있는데 이번 계획에 없는 이름만 회수한다(조직이 서버를 끄면 사라져야 한다).
 */
export function mergeMcpServers(cur, servers, prevManaged) {
  const next = { ...(cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {}) };
  const want = new Set(servers.map((s) => s.name));
  for (const name of prevManaged || []) if (!want.has(name)) delete next[name];
  for (const s of servers) {
    const { name, ...entry } = s;
    next[name] = entry;
  }
  return next;
}

// ── 여기부터 부수효과 ────────────────────────────────────────────────────────────────
function main() {
  if (!HOME) { console.error("HOME 이 없습니다 — MCP 등록을 건너뜁니다."); return 0; }
  const token = process.env.LIVELY_TOKEN || "";
  if (!token) { console.error("LIVELY_TOKEN 이 없습니다 — MCP 등록을 건너뜁니다."); return 0; }

  const shim = process.env.LIVELY_SHIM || join(LIVELY, "bin", "lively");
  const servers = planServers({
    shim,
    shimUsable: existsSync(shim) && existsSync(join(LIVELY, "lib", "lively-mcp-gateway.mjs")),
    transportOverride: (readTextOrEmpty(join(LIVELY, "mcp-transport")) || "").trim(),
    storeUrl: process.env.STORE_URL || "http://localhost:8080/mcp",
    token,
    orgServers: (readJson(orgServersPath(), {}) || {}).servers || [],
    env: process.env,
  });

  const cur = readJson(CLAUDE_JSON, {}) || {};
  if (typeof cur !== "object" || Array.isArray(cur)) {
    console.error(`${CLAUDE_JSON} 이 객체가 아닙니다 — 덮어쓰지 않고 건너뜁니다.`);
    return 0;
  }
  // 설치 전부터 있던 남의 항목을 덮기 전에 **최초 1회** 스냅샷(제거 시 원복용). lively.mjs backupUserMcp 와 동형.
  const backup = readJson(USER_BACKUP, {}) || {};
  let backupDirty = false;
  for (const s of servers) {
    if (Object.prototype.hasOwnProperty.call(backup, s.name)) continue;
    backup[s.name] = (cur.mcpServers || {})[s.name] ?? null;
    backupDirty = true;
  }
  if (backupDirty) { try { writeJsonAtomic(USER_BACKUP, backup, 0o600); } catch { /* 백업 실패가 등록을 막지 않는다 */ } }

  cur.mcpServers = mergeMcpServers(cur.mcpServers, servers, readJson(MANAGED, []) || []);
  writeJsonAtomic(CLAUDE_JSON, cur, 0o600);
  try { writeJsonAtomic(MANAGED, servers.map((s) => s.name), 0o600); } catch { /* 다음 회수만 못 한다 */ }

  // 값은 찍지 않는다 — 헤더에 토큰이 들어 있다.
  for (const s of servers) console.log(`  ✓ ${s.name} (${s.type})`);
  return 0;
}

function readTextOrEmpty(p) { try { return readFileSync(p, "utf8"); } catch { return ""; } }
function orgServersPath() {
  const explicit = process.env.MCP_SERVERS_FILE;
  if (explicit && existsSync(explicit)) return explicit;
  //  번들 안(설치 중) → 홈(재실행) 순. 종전 셸의 우선순위를 그대로 옮겼다.
  const bundled = join(dirname(new URL(import.meta.url).pathname), "..", ".lively", "mcp-servers.json");
  if (existsSync(bundled)) return bundled;
  return join(LIVELY, "mcp-servers.json");
}

if (process.argv[1] && process.argv[1].endsWith("mcp-register.mjs")) process.exit(main());

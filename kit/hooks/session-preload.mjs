#!/usr/bin/env node
// SessionStart 훅 — 게이트웨이에서 펜딩 현황을 받아 짧은 한국어 컨텍스트 블록을 세션 컨텍스트로 주입한다.
// 하네스 무관(D5): 출력 형태만 LIVELY_HARNESS 로 분기한다(아래 emitContext). 로직은 단일.
//   - Claude Code: stdout 의 raw 텍스트 + exit 0 = 세션 컨텍스트로 주입(검증된 공식 계약).
//   - Codex(0.138+): SessionStart 출력은 JSON 봉투 필수 —
//       {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}
//     (raw 텍스트는 Codex 가 무시한다. 확인: codex 0.138.0 임베드 스키마 session-start.command.output.)
//   어댑터가 훅 command 에 LIVELY_HARNESS=codex 를 박아 분기를 결정한다(미설정 시 raw=Claude 기본).
// 페일오픈: 토큰/게이트웨이/네트워크 어떤 실패든 조용히 exit 0 — 실제 작업 세션을 절대 막지 않는다.
// stdin 은 읽지 않는다(hang 원천 차단). 토큰 값은 절대 출력/로깅하지 않는다.
// 비활성화(incognito): LIVELY_OFF=1 (구 LIVELY_HOOKS_OFF — back-compat alias). OFF 면 정적·라이브 둘 다 미주입.
// 부수효과(주입 외): 런타임설정 갱신 · auto-approve reconcile · 배선 자기치유/dedup · **키트 자가 업데이트 트리거**
//   (#858 — 게이트웨이 kit_version ≠ 로컬 스탬프면 self-update.mjs 를 detached 로 띄운다. 적용은 다음 세션.)
// 주입물: [정적 org-context (~/.lively/context.md — 어댑터가 설치 시 발행, 토큰/시크릿 없음)]
//        + [라이브 현황 (게이트웨이, 토큰 필요)]. 어느 쪽이든 있으면 주입, 둘 다 없으면 무동작(fail-open).
//   ※ Codex 는 ~/.codex/AGENTS.md 로 정적 org-context 를 네이티브 로드하므로(어댑터가 발행), 본 훅의
//     정적 블록은 Claude 와의 동작 패리티/이중 안전망용이다(중복돼도 무해 — 같은 비밀-없는 텍스트).
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, realpathSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OFF = process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1";
// 읽기전용 세션(#1007+) — 세션 pane 에 -e LIVELY_MODE=readonly 로 주입된다(게이트웨이 헤더 x-lively-mode 와 같은 값).
//  주입 컨텍스트 맨 앞에 배너를 붙여 AI 가 '이 세션은 스토어에 안 쓴다'를 명확히 알게 한다(없는 writeback 툴을 찾는 혼란 방지).
const READONLY = (process.env.LIVELY_MODE || "").trim().toLowerCase() === "readonly";
const RO_BANNER = [
  "## ⚠ 읽기전용 세션 (read-only, #1007)",
  "이 세션은 라이블리 컨텍스트 스토어에 **쓰지 않습니다**. 지식·프로젝트·작업·카테고리·자료·활동·도메인맵의 저장/수정 툴",
  "(knowledge_save·activity_log·project/task 생성·category_update·source_save 등)은 이 세션에서 **비활성**입니다(tools/list 에 없음, REST 는 403).",
  "그러니 세션 마무리의 컨텍스트 스토어 기록(writeback)을 **시도하지 마세요** — WIKI 인덱스·AGENTS.md 의 '기록하라' 규칙은 이 읽기전용 세션엔 적용되지 않습니다.",
  "읽기·검색·분석·코드작업(파일 편집·빌드·커밋)은 정상입니다. 기밀 작업이 끝난 뒤 남길 조직 기록은 읽기전용을 끈 일반 세션에서 하세요.",
].join("\n");
const withRo = (t) => READONLY ? (RO_BANNER + "\n\n" + (t || "")).trimEnd() : t;
// ⚠ OFF 차단은 main() 안에서 한다(모듈 최상단 process.exit 금지) — main-guard(#959) 이후 이 파일은 test 가
//  reconcileExtPullWiring 을 import 한다. 최상단에서 exit 하면 토큰/OFF 상태에 따라 import 가 프로세스를 죽여
//  단언이 0개 실행되고도 exit 0(가짜 통과)이 된다(diff-reviewer #959 지적). 클린룸(OFF 시 토큰 미read)은 아래 TOKEN 가드로 유지.

// 어드민 런타임 설정 — ~/.lively/hooks-config.json 의 hooks[name]===false 면 비활성(fail-open: 못 읽으면 활성).
function hookDisabled(name) {
  try {
    const c = JSON.parse(readFileSync(join(homedir(), ".lively", "hooks-config.json"), "utf8"));
    return !!(c && c.hooks && c.hooks[name] === false);
  } catch { return false; }
}

// 하네스: --harness <name> argv(크로스플랫폼) 우선, 없으면 LIVELY_HARNESS env(back-compat).
//  Windows 는 `env VAR=val` 프리픽스를 못 쓰므로 argv 로 전달받는다.
const HARNESS = (() => {
  const i = process.argv.indexOf("--harness");
  return ((i > -1 ? process.argv[i + 1] : "") || process.env.LIVELY_HARNESS || "").toLowerCase();
})();

// 하네스별 컨텍스트 주입 출력. text 가 비면 아무것도 안 쓴다(무출력 = 무주입).
//   codex → JSON 봉투(additionalContext), 그 외(claude/미설정) → raw 텍스트.
//   opts.reloadSkills(Claude 전용, 자산 sync 자기치유가 이번 세션에 스킬을 materialize 했을 때):
//   raw 텍스트론 신호를 실을 수 없어 JSON 봉투(additionalContext+reloadSkills)로 전환 — 공식 SessionStart 계약.
function emitContext(text, opts = {}) {
  const reload = !!opts.reloadSkills && HARNESS !== "codex";
  if (!text && !reload) return;
  if (HARNESS === "codex" || reload) {
    const out = { hookEventName: "SessionStart" };
    if (text) out.additionalContext = text;
    if (reload) out.reloadSkills = true;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: out }) + "\n");
  } else {
    process.stdout.write(text + "\n");
  }
}

const readLocal = (rel) => {
  try { return readFileSync(join(homedir(), ".lively", rel), "utf8").trim() || null; }
  catch { return null; }
};

// 정적 org-context (토큰 무관 — cross-repo user-level 전달의 핵심). 동기·저렴, 4.5s 네트워크 타임박스 밖.
const STATIC = readLocal("context.md");

// OFF 면 토큰 파일도 안 읽는다(클린룸 유지 — 종전 최상단 exit 이 하던 일). !TOKEN 시 정적만 주입하는 처리는 main() 에서.
const TOKEN = OFF ? "" : ((process.env.LIVELY_TOKEN || "").trim() || readLocal("token"));

const GW = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080").replace(/\/$/, "");

// fetch + 개별 타임아웃 + 실패 시 null (어떤 한 소스가 죽어도 나머지로 진행)
async function jget(path, ms = 2000, auth = true) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`${GW}${path}`, {
      signal: ctl.signal,
      headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

// org-context 동적 로드 — 게이트웨이에서 현재 정적 컨텍스트(강제규칙·회사맥락·메모리 합성)를 받아
//  로컬 ~/.lively/context.md 보다 우선한다. 관리 UI 편집이 재발행/재설치 없이 다음 세션에 즉시 반영된다.
//  실패(게이트웨이 다운/네트워크/토큰)면 null → 호출부가 로컬 STATIC 으로 폴백(오프라인 안전·fail-open).
async function fetchOrgContext() {
  const r = await jget("/api/ui/org/preview", 3000);
  const ctx = r && typeof r.context === "string" && r.context.trim() ? r.context.trim() : null;
  // write-back 캐시 — 성공 fetch 를 ~/.lively/context.md 에 굳힌다. 다음 세션이 게이트웨이 다운/오프라인이면
  //  이 '직전 성공분'을 STATIC 으로 읽어 주입한다(설치 시 베이크하던 정적 floor 를 대체 — 번들은 콘텐츠 0).
  //  멱등·fail-soft: 못 써도 이번 세션 주입엔 영향 없음. 시크릿 없음(preview 가 redact 통과한 텍스트).
  if (ctx) {
    try {
      const dir = join(homedir(), ".lively");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "context.md"), ctx + "\n");
    } catch { /* fail-soft */ }
  }
  return ctx;
}

// auto-approve reconcile(Claude, B) — 게이트웨이 자동승인 목록을 settings.json permissions.allow 에 매 세션 반영.
//  user-install.mergeAutoApprove 와 **동일 알고리즘**(단일 출처 동기화): lively 항목은 ~/.lively/managed-auto-approve.json
//  로 추적해 멤버 본인 항목은 보존하고 lively 가 더는 원치 않는 것만 회수. want 는 호출부에서 'mcp__lively__*' 로 필터됨.
//  보안: 새로 ADD 하는 건 게이트웨이(멤버 본인 토큰)가 명시한 lively-prefixed 툴뿐 — fetch 실패 시 호출 자체가 안 됨(상위 가드).
function reconcileClaudeAutoApprove(dir, want) {
  try {
    const sp = join(homedir(), ".claude", "settings.json");
    if (!existsSync(sp)) return; // claude 미설치/미배선 — 건드리지 않음
    let cur; try { cur = JSON.parse(readFileSync(sp, "utf8")); } catch { return; }
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return;
    cur.permissions = (cur.permissions && typeof cur.permissions === "object" && !Array.isArray(cur.permissions)) ? cur.permissions : {};
    const allow = Array.isArray(cur.permissions.allow) ? cur.permissions.allow : [];
    const prevPath = join(dir, "managed-auto-approve.json");
    let prev = []; try { prev = JSON.parse(readFileSync(prevPath, "utf8")); if (!Array.isArray(prev)) prev = []; } catch { /* */ }
    const wantSet = new Set(want); const prevSet = new Set(prev);
    let next = allow.filter((e) => !(prevSet.has(e) && !wantSet.has(e))); // lively 가 넣었다 뺀 것만 회수(멤버 항목 보존)
    for (const e of want) if (!next.includes(e)) next.push(e);
    if (JSON.stringify(next) === JSON.stringify(allow) && prev.join("\u0000") === want.join("\u0000")) return; // 변화 없으면 미기록
    cur.permissions.allow = next;
    writeFileSync(sp, JSON.stringify(cur, null, 2) + "\n");
    writeFileSync(prevPath, JSON.stringify(want, null, 2));
  } catch { /* fail-soft */ }
}

// kit 훅 중복 dedup(자기치유 확장, #742) — 설치 세대 간 command 표기 드리프트(`node` vs `"node"` vs 번들 런타임
//  절대경로)로 같은 훅이 여러 벌 배선된 settings 를 세션 시작마다 한 벌로 수렴시킨다(v0.1.131 설치기 dedup 과
//  동일 정체성 규칙 = 스크립트 파일명(+인자)+matcher — 설치기는 설치 시에만 돌므로, 재설치 없는 머신은 이게 정리).
//  대상은 `.lively/hooks/*` 를 가리키는 단일-훅 lively 항목만 — 사용자 고유 훅·복합 항목은 불변. 남길 한 벌 =
//  실행 확실성 순(지금 이 훅을 실행 중인 node 와 동일 실행자 > 존재 확인된 절대경로/PATH형 > 나머지, 동점이면
//  가장 뒤 = 최근 설치분). 변화 없으면 무기록, 전 경로 fail-soft.
const kitHookId = (cmd) => {
  const m = typeof cmd === "string" ? cmd.match(/[/\\]\.lively[/\\]hooks[/\\]([^"'\s]+)['"]?\s*(.*)$/) : null;
  return m ? `${m[1]}|${m[2].trim()}` : null;
};
function dedupKitWiring() {
  if (HARNESS === "codex") return false; // codex 배선은 config.toml 센티널 — 이 dedup 은 Claude settings 전용
  try {
    const sp = join(homedir(), ".claude", "settings.json");
    if (!existsSync(sp)) return false;
    let cur; try { cur = JSON.parse(readFileSync(sp, "utf8")); } catch { return false; }
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return false;
    if (!cur.hooks || typeof cur.hooks !== "object" || Array.isArray(cur.hooks)) return false;
    const tokOf = (c) => { const m = String(c).match(/^\s*(?:"([^"]+)"|(\S+))/); return m ? (m[1] || m[2] || "") : ""; };
    let myNode = process.execPath; try { myNode = realpathSync(process.execPath); } catch { /* 그대로 */ }
    const aliveScore = (t) => {
      if (!t) return 0;
      if (!t.includes("/") && !t.includes("\\")) return 1;               // PATH 형(node) — 존재 가정
      try { if (realpathSync(t) === myNode) return 2; } catch { /* 아래로 */ }
      return existsSync(t) ? 1 : 0;                                      // 절대경로 — 파일 존재로 판정
    };
    let changed = false;
    for (const [ev, arr] of Object.entries(cur.hooks)) {
      if (!Array.isArray(arr)) continue;
      const groups = new Map(); // (matcher, kit 정체성) → 항목 인덱스들
      arr.forEach((e, i) => {
        const hs = e && Array.isArray(e.hooks) ? e.hooks : null;
        if (!hs || hs.length !== 1 || typeof hs[0].command !== "string") return; // kit 항목은 단일 훅 — 그 외 불변
        const id = kitHookId(hs[0].command);
        if (!id) return;
        const key = JSON.stringify([e.matcher ?? null, id]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(i);
      });
      const drop = new Set();
      for (const idxs of groups.values()) {
        if (idxs.length < 2) continue;
        let keep = idxs[0], best = -1;
        for (const i of idxs) { const s = aliveScore(tokOf(arr[i].hooks[0].command)); if (s >= best) { best = s; keep = i; } }
        for (const i of idxs) if (i !== keep) drop.add(i);
      }
      if (drop.size) { cur.hooks[ev] = arr.filter((_, i) => !drop.has(i)); changed = true; }
    }
    if (!changed) return false;
    try { copyFileSync(sp, sp + ".bak-hook-dedup"); } catch { /* 백업 실패해도 진행 */ }
    writeFileSync(sp, JSON.stringify(cur, null, 2) + "\n");
    return true;
  } catch { return false; }
}

// 자산 sync 배선 자기치유(#742) — sync-harness-assets 의 SessionStart 배선은 user-install(#636, 2026-07-07)부터
//  설치돼, 그 전에 프로비저닝된 멤버는 kit refresh 로 러너 파일만 최신이고 배선이 없어 조직 스킬·서브에이전트가
//  영영 materialize 안 됐다(재설치 없음 · refresh-member-kits.sh 는 settings 무영향). 전원 배선된 이 훅이 수렴시킨다:
//  배선이 없으면 ① settings.json 에 배선 추가(다음 세션부턴 전용 훅의 정상 경로) ② 이번 세션 몫으로 러너를 직접
//  1회 실행(materialize) 후 true 반환 → 호출부가 reloadSkills 를 실어 스킬을 같은 세션에 동적 로드. 전 경로 fail-soft.
//  Codex 배선은 config.toml 센티넬(설치 시점 관리)이라 제외. 러너 파일이 없는 구형 로컬 kit 은 건드리지 않는다
//  (없는 파일을 배선하면 매 세션 훅 에러) — 그 경우는 kit 재설치가 경로.
function healAssetSyncWiring() {
  if (HARNESS === "codex") return false;
  try {
    const runner = join(homedir(), ".lively", "hooks", "sync-harness-assets.mjs");
    if (!existsSync(runner)) return false;
    const sp = join(homedir(), ".claude", "settings.json");
    if (!existsSync(sp)) return false; // claude 미설치/미배선 멤버 — 건드리지 않음
    let cur; try { cur = JSON.parse(readFileSync(sp, "utf8")); } catch { return false; }
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return false;
    cur.hooks = (cur.hooks && typeof cur.hooks === "object" && !Array.isArray(cur.hooks)) ? cur.hooks : {};
    const ss = Array.isArray(cur.hooks.SessionStart) ? cur.hooks.SessionStart : [];
    if (JSON.stringify(ss).includes("sync-harness-assets")) return false; // 이미 배선 — 정상 경로
    // node 실행자는 기존 session-preload 엔트리의 첫 토큰을 미러(번들 node·플랫폼 형태 유지), 스크립트는
    //  ~/.lively 러너 절대경로로 고정 — 프로젝트 스코프 변형 배선($CLAUDE_PROJECT_DIR)을 잘못 미러하지 않게.
    const pre = ss.find((e) => JSON.stringify(e).includes("session-preload.mjs"));
    const preCmd = pre && pre.hooks && pre.hooks[0] && typeof pre.hooks[0].command === "string" ? pre.hooks[0].command : "";
    const nodeTok = (preCmd.match(/^\s*("[^"]+"|\S+)/) || [])[1] || "node";
    ss.push({ matcher: "startup|resume|clear", hooks: [{ type: "command", command: `${nodeTok} "${runner}"` }] });
    cur.hooks.SessionStart = ss;
    try { copyFileSync(sp, sp + ".bak-asset-wiring"); } catch { /* 백업 실패해도 진행 */ }
    writeFileSync(sp, JSON.stringify(cur, null, 2) + "\n");
    // 이번 세션 몫 — 러너 직접 1회 실행(자체 타임박스·fail-open·hooks-config 자기게이팅 내장).
    try { execFileSync(process.execPath, [runner], { stdio: "ignore", timeout: 8000 }); } catch { /* fail-soft */ }
    return true;
  } catch { return false; }
}

// ── ext-pull 동적 배선(#959) — 구성원 자체설치 MCP 까지 work-flag 가 보게 한다 ──────────────────
//  배경: 게이트웨이는 자체설치 MCP(`mode='client'`·stdio — 하네스 직결)를 **구조적으로 못 본다**. 훅이 유일한
//   관측점이고, work-flag 의 판정 코드는 이미 서버 라벨 무관(pull_tools prefix startsWith)이라 **settings matcher 만**
//   넓히면 열린다. 그런데 `mcp__.*` 로 통째 넓히면 모든 MCP 호출마다 훅이 스폰된다(실측 46ms/회 — playwright 200콜 ≈ 9s).
//  설계: 메인 work-flag 엔트리(matcher `mcp__lively__.*`, user-install 소유·정적·불변)는 우리 툴·ext 프록시를 이미
//   커버(스폰 증가 0). 그 **밖**(자체설치 MCP)은 #906 pull_tools 의 **비-lively prefix** 만 골라 **별도 엔트리**로 배선한다.
//   → 관리자가 pull_tools 에 안 적은 서버(playwright·figma 등)엔 matcher 자체가 안 생겨 스폰 0. 노브는 여전히 하나.
//  회수: matcher 가 pull_tools 따라 매 세션 바뀌므로 회수가 필요하다. 이 엔트리는 명령의 `--ext-pull` **sentinel 토큰**
//   (우리 소유 규약 — 사용자·메인 훅은 안 씀)으로 식별해, **sentinel 을 가진 엔트리를 전부 걷어내고 현재 matcher 로 하나만
//   추가**한다. 이 교체가 사용자 훅(예: Bash matcher 로 직접 단 work-flag)이나 메인 엔트리(sentinel 없음)를 절대 안 건드린다.
//   (그냥 matcher 를 바꾸면 dedup 이 (matcher,정체성) 키라 구·신이 다른 키로 살아남아 2회 실행된다 — 그걸 이 방식이 피한다.)
//   ⚠ 경로 기반 정체성(kitHookId)이 아니라 sentinel 토큰으로 잡는 이유: command 표기(node·경로 형태)가 조금만 달라도
//   경로 정체성은 못 잡아 구 엔트리가 남고 회수가 샌다 — sentinel 은 표기 무관이라 create 와 detect 가 항상 일치한다.
export function reconcileExtPullWiring(hooks, { extPullCmd, pullTools }) {
  // ext 엔트리 = 명령에 `--ext-pull` sentinel 토큰을 가진 것(우리 소유 규약, 경로 표기 무관). 사용자·메인 훅은
  //  이 sentinel 을 안 쓰므로 불침. (경로 기반 정체성으로 잡으면 command 표기가 조금만 달라도 못 잡아 회수가 샌다.)
  const isExt = (e) => {
    const hs = e && Array.isArray(e.hooks) ? e.hooks : null;
    return !!hs && hs.some((h) => h && typeof h.command === "string" && /(^|\s)--ext-pull(\s|$)/.test(h.command));
  };
  const before = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  const kept = before.filter((e) => !isExt(e));
  // 비-lively prefix 만 — mcp__lively__* 는 메인 엔트리(mcp__lively__.*)가 이미 커버한다(ext 프록시 포함).
  const prefixes = (Array.isArray(pullTools) ? pullTools : [])
    .filter((p) => typeof p === "string" && p && !p.startsWith("mcp__lively__"));
  if (prefixes.length) {
    // prefix 는 REST 검증(#906)에서 `[A-Za-z][A-Za-z0-9_-]*` 라 regex-safe. `.*` 는 메인 엔트리 스타일과 일치.
    const matcher = prefixes.map((p) => `${p}.*`).join("|");
    kept.push({ matcher, hooks: [{ type: "command", command: extPullCmd }] });
  }
  const changed = JSON.stringify(before) !== JSON.stringify(kept);
  if (changed) hooks.PostToolUse = kept;
  return changed;
}

// 위 순수 로직을 Claude settings.json 에 적용 — refreshRuntimeConfig 가 pull_tools 받은 뒤 self-heal 들과 나란히 호출.
//  codex 제외(config.toml 센티널 관리 — 동적 matcher 밖, 자체설치 MCP 커버는 Claude 한정). 전 경로 fail-soft.
//  extPullCmd 는 **메인 work-flag 엔트리의 command 를 그대로 재사용** + ' --ext-pull' — node 토큰·경로 표기를 잇는다.
export function applyExtPullWiring(pullTools) {
  if (HARNESS === "codex") return false;
  try {
    const sp = join(homedir(), ".claude", "settings.json");
    if (!existsSync(sp)) return false;
    let cur; try { cur = JSON.parse(readFileSync(sp, "utf8")); } catch { return false; }
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return false;
    if (!cur.hooks || typeof cur.hooks !== "object" || Array.isArray(cur.hooks)) return false;
    // 메인 work-flag 엔트리(matcher mcp__lively__.* + 정체성 work-flag.mjs| , 인자 없음)의 command 를 찾아 미러한다.
    //  matcher 도 확인 — 사용자가 같은 work-flag 를 다른 matcher(예 Bash)로 직접 단 경우 그걸 미러하지 않게(정체성 명확화).
    const ptu = Array.isArray(cur.hooks.PostToolUse) ? cur.hooks.PostToolUse : [];
    let mainCmd = null;
    for (const e of ptu) {
      const hs = e && Array.isArray(e.hooks) ? e.hooks : null;
      if (e && e.matcher === "mcp__lively__.*" && hs && hs.length === 1 && typeof hs[0].command === "string" && kitHookId(hs[0].command) === "work-flag.mjs|") { mainCmd = hs[0].command; break; }
    }
    if (!mainCmd) return false; // 메인 배선이 없으면(비정상 — user-install 이 먼저 깔아야) 손대지 않음
    const changed = reconcileExtPullWiring(cur.hooks, { extPullCmd: `${mainCmd} --ext-pull`, pullTools });
    if (!changed) return false;
    try { copyFileSync(sp, sp + ".bak-ext-pull"); } catch { /* 백업 실패해도 진행 */ }
    writeFileSync(sp, JSON.stringify(cur, null, 2) + "\n");
    return true;
  } catch { return false; }
}

// 런타임 설정 동적 갱신 — 게이트웨이 org_runtime_config 를 받아 ~/.lively/hooks-config.json + work-roots 갱신.
//  어드민의 훅 on/off·너지문구·work-roots 변경이 재설치 없이 다음 세션부터 반영(④ 패턴). 전부 fail-open.
//  주의: session_preload 가 비활성이어도 이건 항상 돌려야 재활성화가 가능(자기-잠금 방지).
async function refreshRuntimeConfig() {
  const rc = await jget("/api/ui/org/runtime-config", 2500);
  if (!rc || typeof rc !== "object") return null;
  try {
    const dir = join(homedir(), ".lively");
    mkdirSync(dir, { recursive: true });
    const hooks = (rc.hooks && typeof rc.hooks === "object" && !Array.isArray(rc.hooks)) ? rc.hooks : {};
    // write_tools(기록 인정 툴 — work-flag 가 읽음): 비었으면 생략 → work-flag 내장 v6 기본목록 사용(오버라이드 해제).
    const writeTools = Array.isArray(rc.write_tools) && rc.write_tools.length ? rc.write_tools : undefined;
    // pull_tools(외부 맥락 인입 prefix — work-flag 가 읽음, #906): 비었으면 생략 = **기능 꺼짐**(내장 폴백 없음).
    //  write_tools 와 시맨틱이 반대다 — 여기선 어드민이 비운 게 곧 '끄기'라 기본값을 되씌우면 안 된다.
    const pullTools = Array.isArray(rc.pull_tools) && rc.pull_tools.length ? rc.pull_tools : undefined;
    // hook_grace_ms(#1008) — run-custom 캐시 유효기간(ms). null/미설정 = 무제한(기본, 마지막 접속 기준 영구). run-custom 이 이 파일에서 읽는다.
    //  게이트웨이가 값을 안 주거나 null 이면 undefined 로 둬 키를 생략 → run-custom.graceMs() 가 무제한으로 처리. 0 도 유효(즉시 만료 = 가장 보수적).
    const graceMs = (typeof rc.hook_grace_ms === "number" && Number.isFinite(rc.hook_grace_ms) && rc.hook_grace_ms >= 0) ? rc.hook_grace_ms : undefined;
    writeFileSync(join(dir, "hooks-config.json"),
      JSON.stringify({ hooks, writeback_notice: rc.writeback_notice || undefined, write_tools: writeTools, pull_tools: pullTools, hook_grace_ms: graceMs }, null, 2));
    // auto-approve(B) — 게이트웨이 자동승인 목록을 캐시(~/.lively/auto-approve.json)에 굳히고, Claude 면 settings.json
    //  permissions.allow 에 reconcile(매 세션 → admin 변경이 재설치 없이 다음 세션 반영). 'mcp__lively__*' 만 통과.
    //  Codex 는 auto-approve 가 config.toml 관리 센티넬 블록 안이라 훅이 매 세션 재생성하지 않는다 — 캐시만 굳히고
    //  적용은 설치/업데이트 시점(원칙적 비대칭). fetch 실패 시 rc 가 null 이라 이 블록 자체가 안 돈다(상위 가드 = fail-closed).
    if (Array.isArray(rc.auto_approve)) {
      const want = rc.auto_approve.filter((s) => typeof s === "string" && s.startsWith("mcp__lively__"));
      writeFileSync(join(dir, "auto-approve.json"), JSON.stringify({ allow: want }, null, 2));
      if (HARNESS !== "codex") reconcileClaudeAutoApprove(dir, want);
    }
    // work-roots 는 동적 갱신하지 않는다 — 디렉토리 경로 노출 회피(scope-null endpoint 가 work_roots 미반환).
    //  중앙 work-roots 는 설치 번들(.lively/work-roots)/재설치로만 적용된다(자동 업데이트가 그 재설치를 돌린다).
  } catch { /* fail-open — 쓰기 실패해도 세션 안 막음 */ }
  return rc; // kit_version(#858) 을 호출부가 읽는다
}

// ── 키트 자가 업데이트 트리거(#858) ──────────────────────────────
// 게이트웨이가 서빙하는 kit_version 이 로컬 스탬프(~/.lively/kit-version)와 다르면 백그라운드 업데이터를
//  **detached** 로 띄우고 즉시 반환한다. 다운로드·설치는 이 훅(과 세션)보다 오래 살아 알아서 끝난다.
//  현재 세션엔 아무 영향이 없다 — 하네스가 훅·설정을 세션 시작에 스냅샷하므로 **다음 세션부터** 적용된다
//  (클로드 코드 오토업데이터와 같은 계약: 체크=시작 시 · 설치=백그라운드 · 적용=다음 실행).
//
// 이 트리거가 session-preload 안에 있는 이유: **전원에게 이미 배선된 훅이 이것뿐**이다. 새 훅을 추가하면
//  그걸 배선하려고 또 수동 업데이트가 필요해진다(닭-달걀). 여기 두면 앞으로의 모든 키트 변경 — 새 훅,
//  새 이벤트 배선, 설치기 수정 — 이 손 안 대고 흐른다.
function maybeSelfUpdate(remoteVersion) {
  try {
    if (!remoteVersion || typeof remoteVersion !== "string") return; // 게이트웨이가 버전을 안 줌 → 무동작
    if (process.env.LIVELY_NO_AUTO_UPDATE === "1") return;
    if (hookDisabled("self_update")) return;                          // 어드민 토글
    if (readLocal("kit-version") === remoteVersion) return;           // 최신 — 대부분의 세션이 여기서 끝
    const runner = join(homedir(), ".lively", "hooks", "self-update.mjs");
    if (!existsSync(runner)) return;                                  // 구형 kit — 수동 업데이트가 경로
    const argv = [runner, "--to", remoteVersion];
    if (HARNESS) argv.push("--harness", HARNESS);
    // stdio:"ignore" 가 핵심 — 자식이 파이프를 물면 하네스가 훅의 stdout EOF 를 기다리다 세션이 늘어진다.
    spawn(process.execPath, argv, { detached: true, stdio: "ignore" }).unref();
  } catch { /* fail-soft — 업데이트 실패가 세션을 막지 않는다 */ }
}

// ── 레포 준비 상태 통지(#1155 실패 · #1180 진행 중) ─────────────────────────
//  work.mjs 는 레포 준비(clone/worktree)에 실패해도 세션을 띄운다(fail-open — 자격 하나 없다고 세션 자체가 안 뜨던 걸
//  고친 것). 그 사실을 **AI 가 읽는 채널**로 옮기는 게 이 블록이다: 터미널 경고는 하네스 화면에 덮여 사라지고,
//  모르는 AI 는 레포를 '원래 없는 것'으로 오해해 엉뚱한 자리에 clone 하거나 공유 base 에서 직접 작업한다.
//  로컬 FS 만 읽는다 — 토큰·네트워크 무관(4.5s 타임박스 밖, 오프라인에서도 뜬다).
//  낡은 경고 방지: 준비됐어야 할 자리(expect)에 지금 코드가 있으면 이미 복구된 것으로 보고 조용히 뺀다
//  (마커는 work.mjs 가 성공 시 키를 지우지만, 세션 안에서 `lively repo worktree` 로 복구한 경우는 마커가 그대로다).
export function repoStatusNotice(cwd = process.cwd()) {
  try {
    // cwd 에서 위로 마커 탐색(.git 발견과 동형) — work.mjs 가 띄운 세션은 깊이 0 에서 바로 찾는다.
    let dir = resolve(cwd), marker = null;
    for (let i = 0; i < 12; i++) {
      const f = join(dir, ".lively", "project.json");
      if (existsSync(f)) { marker = f; break; }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (!marker) return null;
    const m = JSON.parse(readFileSync(marker, "utf8"));
    // 이미 그 자리에 코드가 있으면(사람이 복구했거나 준비가 방금 끝났다) 말하지 않는다 — 실패·대기 공통 규칙.
    const live = (arr) => (Array.isArray(arr) ? arr : [])
      .filter((r) => r && typeof r === "object" && r.name)
      .filter((r) => !(r.expect && existsSync(r.expect)));
    const failed = live(m && m.repos_failed);
    const pending = live(m && m.repos_pending);
    if (!failed.length && !pending.length) return null;
    const lines = [];
    if (pending.length) {
      // #1180 — 세션이 코드보다 먼저 뜨는 게 정상인 모드. 이걸 안 알려주면 AI 가 빈 폴더를 보고 제멋대로 clone 한다.
      lines.push(
        "## ⏳ 코드 레포를 지금 받는 중입니다 (#1180)",
        "세션이 먼저 열렸고 레포 준비(clone/워크트리)는 **백그라운드에서 진행 중**입니다. 아래 자리에 곧 나타납니다 — 지금 비어 있는 건 정상입니다.",
        "",
      );
      for (const p of pending) lines.push(`- **${p.name}** → \`${p.expect}\`${p.at ? `  (시작: ${p.at})` : ""}`);
      lines.push(
        "",
        "코드가 필요하면: 그 경로가 생겼는지 확인하고(몇 초~몇 분), 아직이면 **기다리거나 사용자에게 물어보세요**.",
        "**직접 clone 하지 마세요** — 준비가 끝나면 위 자리에 정본이 생기고, 다른 자리에 받아두면 그때부터 두 벌이 됩니다.",
      );
    }
    if (failed.length) {
      if (lines.length) lines.push("");
      lines.push(
        "## ⚠ 코드 레포 준비 실패 (#1155)",
        "아래 레포를 자동으로 준비하지 못했습니다. **세션은 그대로 시작됐습니다** — 코드가 없는 게 정상 상태가 아닙니다.",
        "",
      );
      for (const f of failed) {
        lines.push(`- **${f.name}** — ${f.reason || "준비 실패"}`);
        if (f.expect) lines.push(`  - 있어야 할 자리: \`${f.expect}\` (지금 없음)`);
        if (f.hint) lines.push(`  - 복구: ${f.hint}`);
      }
      lines.push(
        "",
        "이 레포의 코드가 필요해지면:",
        "1. 위 복구 안내대로 다시 준비하세요(레지스트리 레포면 `lively repo worktree <레포>` 한 줄).",
        "2. **임의로 다른 자리에 clone 하지 마세요** — 위 '있어야 할 자리'가 정본입니다. 공유 base 레포에서 직접 작업하는 것도 금지입니다.",
        "3. 그래도 준비가 안 되면 추측으로 진행하지 말고 사용자에게 상황을 알린 뒤, 레포 없이 가능한 일만 하세요.",
      );
    }
    return lines.join("\n");
  } catch { return null; }   // 마커 파손·권한 등 — 통지 실패가 세션을 막지 않는다
}

// 업데이터가 남긴 1회성 안내를 읽고 지운다(다음 세션엔 안 뜬다).
function takeUpdateNotice() {
  try {
    const p = join(homedir(), ".lively", "update-notice");
    if (!existsSync(p)) return null;
    const t = readFileSync(p, "utf8").trim();
    rmSync(p, { force: true });
    return t || null;
  } catch { return null; }
}

// 전체 하드 타임박스 4.5s — 어느 경로든 exit 0
// 출력 = [정적 org-context(게이트웨이 우선, 로컬 폴백)]. 라이브 현황 블록은 폐기(v6 — 구 item/curate 모델 기반이라 제거).
async function main() {
  if (OFF) process.exit(0);                              // incognito — 아무것도 안 함(클린룸)
  // 레포 준비 실패 통지(#1155) — 로컬 마커만 읽으므로 토큰 유무와 무관하게 항상 계산한다(무토큰 세션도 코드는 필요하다).
  const repoNotice = repoStatusNotice();
  if (!TOKEN) { emitContext(withRo([repoNotice, STATIC].filter(Boolean).join("\n\n"))); process.exit(0); }  // 토큰 없으면 라이브 스킵, 정적 org-context 만 주입(멤버 기본 상태)
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms, null));
    // 런타임설정 갱신 + org-context(동적)를 병렬로 — 전부 4.5s 타임박스 안. 타임아웃이면 null.
    const result = await Promise.race([Promise.all([refreshRuntimeConfig(), fetchOrgContext()]), sleep(4500)]);
    const [rc, orgCtx] = Array.isArray(result) ? result : [null, null];
    // 자산 sync 자기치유 + kit 훅 중복 dedup — 타임박스 밖(로컬 FS + 러너 1회, 러너는 자체 타임박스).
    //  dedup 먼저(깨끗한 베이스 위에 배선 판정) — 둘 다 정상 상태면 즉시 false·무기록.
    dedupKitWiring();
    // ext-pull 배선(#959) — race 밖·다른 self-heal 과 순차(settings.json 쓰기 겹침 회피). rc 없으면(타임아웃) 스킵.
    if (rc) applyExtPullWiring(rc.pull_tools);
    const healed = healAssetSyncWiring();
    // 자가 업데이트는 **맨 마지막**에 띄운다 — 업데이터도 settings.json 을 만지므로, 위 두 자기치유의 쓰기가
    //  끝난 뒤에 시작해야 read-modify-write 가 겹치지 않는다. spawn 은 즉시 반환한다(타임박스 무관).
    const notice = takeUpdateNotice(); // 직전 업데이트 결과 안내(있으면 이번 세션에 1회)
    maybeSelfUpdate(rc && rc.kit_version);
    // 설정 갱신 후 판정 — session_preload 비활성이면 컨텍스트 주입만 스킵(설정은 이미 갱신돼 재활성화 가능).
    if (hookDisabled("session_preload")) { emitContext("", { reloadSkills: healed }); process.exit(0); }
    // 레포 통지는 org-context 앞에 — 길이가 긴 컨텍스트 뒤에 묻히면 안 되는 '지금 이 세션의 상태'다.
    const blocks = [notice, repoNotice, orgCtx || STATIC].filter(Boolean); // 업데이트 안내 → 레포 실패 → org-context(없으면 로컬 STATIC)
    emitContext(withRo(blocks.join("\n\n")), { reloadSkills: healed }); // 읽기전용이면 배너를 맨 앞에(#1007)
  } catch {
    // fail-open — 라이브가 터져도 정적 컨텍스트(로컬)·레포 통지는 내보낸다.
    emitContext(withRo([repoNotice, STATIC].filter(Boolean).join("\n\n")));
  }
  process.exit(0);
}

// main-guard(#959) — 이 파일이 직접 실행될 때만 main() 을 돈다. 테스트가 reconcileExtPullWiring 을 import 할 때
//  최상위 부수효과가 안 나게(user-install.mjs 의 DIRECT_RUN 과 동일 패턴). realpath 비교: 심링크(/tmp→/private/tmp)에서도 일치.
//  판정 불가(realpathSync throw)면 **fail-open = 실행** — 이 파일의 종전 기본 동작이 '항상 최상위 실행'이었고, 훅이
//  안 도는 무주입이 오판보다 나쁘다(user-install 동일 근거). 훅 정상 호출(node "<abs>")에선 argv[1] 이 늘 풀려 안 던진다.
function isMain() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ""); }
  catch { return true; }
}
if (isMain()) main();

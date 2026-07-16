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
import { join } from "node:path";

const OFF = process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1";
if (OFF) process.exit(0); // 모듈 최상단 — 토큰 읽기 전에 차단(클린룸)

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

const TOKEN = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
// 토큰이 없으면 라이브 현황은 건너뛰되, 정적 컨텍스트는 그대로 주입한다(멤버 기본 상태에서도 org-context 는 옴).
if (!TOKEN) {
  emitContext(STATIC);
  process.exit(0);
}

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
    writeFileSync(join(dir, "hooks-config.json"),
      JSON.stringify({ hooks, writeback_notice: rc.writeback_notice || undefined, write_tools: writeTools, pull_tools: pullTools }, null, 2));
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
try {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms, null));
  // 런타임설정 갱신 + org-context(동적)를 병렬로 — 전부 4.5s 타임박스 안. 타임아웃이면 null.
  const result = await Promise.race([Promise.all([refreshRuntimeConfig(), fetchOrgContext()]), sleep(4500)]);
  const [rc, orgCtx] = Array.isArray(result) ? result : [null, null];
  // 자산 sync 자기치유 + kit 훅 중복 dedup — 타임박스 밖(로컬 FS + 러너 1회, 러너는 자체 타임박스).
  //  dedup 먼저(깨끗한 베이스 위에 배선 판정) — 둘 다 정상 상태면 즉시 false·무기록.
  dedupKitWiring();
  const healed = healAssetSyncWiring();
  // 자가 업데이트는 **맨 마지막**에 띄운다 — 업데이터도 settings.json 을 만지므로, 위 두 자기치유의 쓰기가
  //  끝난 뒤에 시작해야 read-modify-write 가 겹치지 않는다. spawn 은 즉시 반환한다(타임박스 무관).
  const notice = takeUpdateNotice(); // 직전 업데이트 결과 안내(있으면 이번 세션에 1회)
  maybeSelfUpdate(rc && rc.kit_version);
  // 설정 갱신 후 판정 — session_preload 비활성이면 컨텍스트 주입만 스킵(설정은 이미 갱신돼 재활성화 가능).
  if (hookDisabled("session_preload")) { emitContext("", { reloadSkills: healed }); process.exit(0); }
  const blocks = [notice, orgCtx || STATIC].filter(Boolean); // 업데이트 안내 → 게이트웨이 org-context(없으면 로컬 STATIC)
  emitContext(blocks.join("\n\n"), { reloadSkills: healed });
} catch {
  // fail-open — 라이브가 터져도 정적 컨텍스트(로컬)는 내보낸다.
  emitContext(STATIC);
}
process.exit(0);

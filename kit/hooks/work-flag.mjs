#!/usr/bin/env node
// PostToolUse 훅 — 세션별 작업 플래그를 플래그 디렉토리에 기록한다(차단 불가 이벤트, 판단 없음).
//  - Edit/Write 류 툴       → <session_id>.worked   (이 세션에서 의미있는 파일 작업을 했다)
//  - lively MCP 쓰기 툴     → <session_id>.writeback (이미 컨텍스트 스토어에 기록했다)
//  - lively MCP 아무 툴      → <session_id>.lively    (이 세션은 'lively work' 세션 — 자가 게이팅 신호, 읽기/쓰기 무관)
// stop-writeback-gate.mjs 가 이 플래그로 종료 시점에 1회 기록 너지를 결정한다(결정적, LLM 호출 0).
//   .lively 는 게이트 자가 게이팅(등록 work-root 밖에서도 lively 세션이면 게이트 작동)에 쓰인다.
// 게이트웨이 호출 없음(경로→도메인 lookup 엔드포인트 부재 — 스코프 fallback 조항대로 플래그만).
// 플래그 디렉토리: os.tmpdir()/lively-hooks (전 플랫폼 동일) — macOS 의 TMPDIR 는 유저별 0700 디렉토리라
// 공유 /tmp 의 심링크 사전심기/스푸핑 표면이 없다. 재부팅 시 자동 소멸, GC 불요.
// 페일오픈: 어떤 실패든 무출력 exit 0. 비활성화(incognito): LIVELY_OFF=1 (구 LIVELY_HOOKS_OFF — alias)
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// 어드민 런타임 설정 — ~/.lively/hooks-config.json 의 hooks[name]===false 면 이 훅 비활성(fail-open: 못 읽으면 활성).
function hookDisabled(name) {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".lively", "hooks-config.json"), "utf8"));
    return !!(cfg && cfg.hooks && cfg.hooks[name] === false);
  } catch { return false; }
}

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/; // 경로조작 차단 화이트리스트
// memory_write 는 의도적 제외 — 현재 no-op 스텁(영속 0)이라 플래그하면 '기록 완료' 오판.
// 실구현되는 커밋에서 여기 + settings-hooks.json matcher 에 동시 추가할 것(런북 §1).
// v6 기록(writeback) 인정 툴 **기본값** — 이 중 하나라도 쓰면 '컨텍스트 스토어에 기록함' 신호(stop 너지 안 함).
//   matcher 는 settings 의 mcp__lively__.* 가 모두 잡으므로 여기 이름만 v6 와 일치시키면 된다.
//   오버라이드: hooks-config.json 의 write_tools(게이트웨이 runtime-config 발, session-preload 가 매 세션 materialize)
//   가 비어있지 않으면 그걸 쓴다 → 온톨로지 변경 시 재배포 없이 웹에서 갱신(writeback_notice 와 동형). effectiveWriteTools() 참고.
const WRITE_TOOLS_DEFAULT = [
  // 지식(맥락의 기록) 저작·갱신
  "knowledge_save", "knowledge_link_category", "knowledge_set_lifecycle", "knowledge_set_wiki",
  // 카테고리(제품=도메인 should/정의) + 도메인 의존(should) 엣지
  "category_create", "category_update", "category_edge_set",
  // 작업(activity) 기록 — 커밋/결정/리뷰 등
  "activity_log",
  // 프로젝트·태스크(맥락의 변화)
  "project_create_v6", "project_set_status_v6", "project_link_knowledge_v6",
  "project_link_category_v6", "project_set_members_v6", "task_create_v6", "task_set_status_v6",
  // 팀 공유 메모리
  "memory_save",
  // 외부 원본 회수(#906) — ext MCP 등으로 끌어온 자료를 SoT 에 남긴 것도 '기록함'이다. 이게 없으면
  //  "노션 읽고 → source_save 로 남기고 종료"한 모범 세션이 기록 안 한 것으로 판정돼 너지를 맞는다.
  "source_save", "source_link_knowledge",
];
// 하네스 무관 파일-편집 툴 집합: Claude(Edit/Write/MultiEdit/NotebookEdit) + Codex(apply_patch).
//   Codex 0.138+ 는 파일 편집을 apply_patch 로 보고한다(tool_name:"apply_patch"). 추가는 가산적·무해 —
//   Claude 는 apply_patch 를 내지 않고, Codex 는 Edit/Write 등을 내지 않으므로 양쪽 모두 정확.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
const FLAG_DIR = join(tmpdir(), "lively-hooks"); // 전 플랫폼 per-user tmp — 공유 /tmp 미사용

// 기록 인정 툴의 effective 목록 — hooks-config.json 의 write_tools 가 비어있지 않으면 그걸, 아니면 내장 기본(fail-open).
function effectiveWriteTools() {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".lively", "hooks-config.json"), "utf8"));
    if (cfg && Array.isArray(cfg.write_tools) && cfg.write_tools.length) {
      const o = cfg.write_tools.filter((t) => typeof t === "string");
      if (o.length) return o;
    }
  } catch { /* 못 읽으면 기본 */ }
  return WRITE_TOOLS_DEFAULT;
}

// 외부 맥락을 '인입했다'로 볼 툴 이름 **prefix** 목록(#906) — hooks-config.json 의 pull_tools 가 유일한 출처.
//   write_tools 와 시맨틱이 반대다: **내장 기본값이 없고, 비면 기능 꺼짐**. DB 기본값('mcp__lively__ext__')이 곧 on 이라
//   어드민이 웹에서 비우면 그대로 꺼지고, 항목을 더하면 범위가 넓어진다 — 노브 하나로 on/off + 범위를 잡는다.
//   게이트웨이가 영영 불가해 설정이 없으면 넛지 안 함(fail-safe — 오넛지보다 미넛지가 안전).
//   prefix 매칭인 이유: 프록시 툴이 mcp__lively__ext__<server>__<tool> 라 앞부분만으로 갈린다. substring 이면
//   'context__' 같은 서버명이 오탐된다. 이 함수 자체는 서버 라벨 무관이라 matcher 만 넓히면 자체설치 MCP 도 잡는다 —
//   다만 지금 matcher 는 mcp__lively__.* 라 그 경로는 아직 안 열려 있다(후속).
function effectivePullTools() {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".lively", "hooks-config.json"), "utf8"));
    if (cfg && Array.isArray(cfg.pull_tools)) return cfg.pull_tools.filter((t) => typeof t === "string" && t);
  } catch { /* 못 읽으면 끔 */ }
  return [];
}

function readStdin(ms = 2000) {
  return new Promise((resolve) => {
    let buf = "";
    const t = setTimeout(() => resolve(buf), ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => { clearTimeout(t); resolve(buf); });
    process.stdin.on("error", () => { clearTimeout(t); resolve(buf); });
  });
}

try {
  if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") process.exit(0);
  if (hookDisabled("work_flag")) process.exit(0); // 어드민이 이 훅 비활성화
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const sid = String(input?.session_id ?? "");
  if (!SID_RE.test(sid)) process.exit(0);
  const tool = String(input?.tool_name ?? "");

  // 한 PostToolUse 가 여러 플래그를 만들 수 있다(예: lively 쓰기 툴 → .lively + .writeback).
  const flags = new Set();
  if (tool.startsWith("mcp__lively__")) {
    flags.add("lively"); // 자가 게이팅 신호 — 읽기/쓰기 무관, 이 세션은 lively work.
    // writeback = **우리 스토어에 썼다** → 그래서 lively 서버로 스코프한다(.lively 와 같은 기준). suffix 만 보면
    //  남의 MCP 의 `...__knowledge_save` 같은 동명 툴이 우리 스토어엔 아무것도 안 쓰고 게이트를 조용히 끈다 —
    //  실패가 '유실' 방향이라 치명적이다. 구 matcher(mcp__lively__.*)일 땐 tool 이 항상 우리 것이라 안 드러나던
    //  잠재 버그였고, #906 이 matcher 를 mcp__.* 로 넓히며 실재화됐다.
    if (effectiveWriteTools().some((w) => tool.endsWith(`__${w}`))) flags.add("writeback");
  } else if (EDIT_TOOLS.has(tool)) {
    flags.add("worked");
  }
  // 외부 맥락 인입(#906) — 파일 편집과 동급의 '의미있는 작업'으로 본다.
  //   .worked 를 쓰는 이유: 종료 게이트 결정표(worked && !writeback)를 그대로 재사용 → 게이트 코드 변경 0.
  //   이 줄이 없으면 "노션만 읽고 논의하고 종료"한 세션은 .worked 가 안 서서 게이트를 조용히 통과한다 —
  //   정작 그 세션이 끌어온 외부 맥락은 프록시가 아무것도 안 남기므로(순수 passthrough) 그대로 증발한다.
  if (effectivePullTools().some((p) => tool.startsWith(p))) flags.add("worked");
  if (flags.size) {
    mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 });
    for (const flag of flags) writeFileSync(join(FLAG_DIR, `${sid}.${flag}`), "");
  }
} catch { /* fail-open */ }
process.exit(0);

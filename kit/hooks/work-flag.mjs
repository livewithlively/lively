#!/usr/bin/env node
// 다중 이벤트 훅 — 배선(user-install)에 따라 PostToolUse·SessionStart·SessionEnd 로 불린다. 이벤트별 동작:
//  - SessionEnd (#1059)  → reason 이 **사용자 정상 종료**(prompt_input_exit=/exit·Ctrl-D, logout)면 게이트웨이에
//      POST …/exited 로 보고 → 복원목록에서 '종료됨(대화 이어보기)'으로 구분(재부팅·강제kill 은 훅이 못 떠 미보고=중단됨).
//      여기서 조기 종료(flag·UUID 로직 무관).
//  - SessionStart/PostToolUse → 아래 플래그 기록 + claude UUID 매핑(#1059 정밀복원). SessionStart 에도 매핑을 붙인 건
//      PostToolUse(편집·MCP 툴)만으론 **편집·MCP 없는 대화**가 UUID 를 못 보고해 복원이 picker 로 폴백했기 때문.
// PostToolUse 세션별 작업 플래그를 플래그 디렉토리에 기록한다(차단 불가 이벤트, 판단 없음).
//  - Edit/Write 류 툴       → <session_id>.worked   (이 세션에서 의미있는 파일 작업을 했다)
//  - lively MCP 쓰기 툴     → <session_id>.writeback (이미 컨텍스트 스토어에 기록했다)
//  - lively MCP 아무 툴      → <session_id>.lively    (이 세션은 'lively work' 세션 — 자가 게이팅 신호, 읽기/쓰기 무관)
// stop-writeback-gate.mjs 가 이 플래그로 종료 시점에 1회 기록 너지를 결정한다(결정적, LLM 호출 0).
//   .lively 는 게이트 자가 게이팅(등록 work-root 밖에서도 lively 세션이면 게이트 작동)에 쓰인다.
// 게이트웨이 호출 없음(경로→도메인 lookup 엔드포인트 부재 — 스코프 fallback 조항대로 플래그만).
// 플래그 디렉토리: os.tmpdir()/lively-hooks (전 플랫폼 동일) — macOS 의 TMPDIR 는 유저별 0700 디렉토리라
// 공유 /tmp 의 심링크 사전심기/스푸핑 표면이 없다. 재부팅 시 자동 소멸, GC 불요.
// 페일오픈: 어떤 실패든 무출력 exit 0. 비활성화(incognito): LIVELY_OFF=1 (구 LIVELY_HOOKS_OFF — alias)
// ⚠ argv 는 안 본다 — session-preload 가 자체설치 MCP 커버용 엔트리를 `work-flag.mjs --ext-pull` 로 배선하는데(#959),
//  그 sentinel 인자는 settings 엔트리를 회수-교체하기 위한 **정체성 discriminator**일 뿐 이 스크립트는 무시한다(판정 동일).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
//   'context__' 같은 서버명이 오탐된다. 이 함수 자체는 서버 라벨 무관이라, session-preload 가 pull_tools 의 비-lively
//   prefix 로 별도 matcher 엔트리(work-flag.mjs --ext-pull)를 배선하면 자체설치 MCP 도 잡힌다(#959 — 그 경로 열림).
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
  const event = String(input?.hook_event_name ?? "");

  // #1059 — SessionEnd(정상 종료) → 이 box 세션을 '사용자 종료'로 게이트웨이에 표시(복원목록 '종료됨' 구분). reason 이
  //  사용자 종료(prompt_input_exit=/exit·Ctrl-D, logout)일 때만 — clear·compact·resume 등은 세션이 이어지므로 제외.
  //  재부팅·강제kill·reaper 회수는 이 훅이 못 떠서(프로세스 사망) 미보고 → '복원 가능(중단됨)'으로 남는다(의도).
  //  ⚠ 토큰은 env/파일에서만(argv·로그 금지). fail-open·1.2s 타임박스(종료 경로 스톨 방지). flag/UUID 로직과 무관 → 여기서 종료.
  //  ⚠ SID_RE 게이트 **앞**에서 처리한다 — 이 분기는 sid 를 쓰지 않는다(경로=boxId, 인증=토큰, 본문=reason). claude 가
  //   비정형 session_id 를 SessionEnd 에 실어 보내도 정상종료 보고가 막히지 않게(sid 검증은 아래 flag/UUID 경로에만 필요).
  if (event === "SessionEnd") {
    try {
      const reason = String(input?.reason ?? "");
      const boxId = (process.env.LIVELY_SESSION_ID || "").trim();
      if ((reason === "prompt_input_exit" || reason === "logout") && boxId && /^box-/.test(boxId)) {
        const readCfg = (rel) => { try { return readFileSync(join(homedir(), ".lively", rel), "utf8").trim(); } catch { return ""; } };
        const token = (process.env.LIVELY_TOKEN || "").trim() || readCfg("token");
        const gw = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readCfg("gateway-url") || "http://localhost:8080").replace(/\/$/, "");
        if (token) {
          const ctl = new AbortController();
          const to = setTimeout(() => ctl.abort(), 1200);
          try {
            await fetch(`${gw}/api/ui/terminal/sessions/${encodeURIComponent(boxId)}/exited`, {
              method: "POST", signal: ctl.signal,
              headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
              body: JSON.stringify({ reason }),
            });
          } catch { /* fail-open — 미보고 시 복원목록에 '복원 가능(중단됨)'으로 남을 뿐(무해) */ }
          finally { clearTimeout(to); }
        }
      }
    } catch { /* fail-open */ }
    process.exit(0);
  }

  // 이하 flag 기록 + claude UUID 매핑(SessionStart·PostToolUse) — 여기서부터는 sid 를 쓰므로 형식 검증 후 진행.
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

  // #1059 정밀 복원 — 이 box 세션이 지금 도는 **claude 자신의 세션 UUID(sid)**를 게이트웨이에 보고한다. box-id(LIVELY_SESSION_ID)
  //  ≠ claude UUID 라, 복원(restore)이 정확히 이어받으려면(--resume <uuid>) 이 매핑이 필요하다(box-id 를 주면 "검색 결과 없음").
  //  UUID 당 1회만 보고(dedup `<sid>.mapped`) — 첫 툴사용 때만 fetch, 이후엔 stat 만(핫패스 부담 최소). branch·resume·/clear 로
  //  UUID 가 바뀌면 새 sid → 새 보고(게이트웨이가 last-write-wins 로 최신 유지). fail-open·시도 1회(게이트웨이 다운 시 매 툴 스톨 방지).
  //  ⚠ 토큰은 env/파일에서만 읽고 argv·로그에 절대 안 싣는다. 셸·코덱스 box 는 restore 가 claude 하네스에서만 --resume 하므로 무해.
  try {
    const boxId = (process.env.LIVELY_SESSION_ID || "").trim();
    const mappedFlag = join(FLAG_DIR, `${sid}.mapped`);
    if (boxId && /^box-/.test(boxId) && !existsSync(mappedFlag)) {
      const readCfg = (rel) => { try { return readFileSync(join(homedir(), ".lively", rel), "utf8").trim(); } catch { return ""; } };
      const token = (process.env.LIVELY_TOKEN || "").trim() || readCfg("token");
      const gw = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readCfg("gateway-url") || "http://localhost:8080").replace(/\/$/, "");
      if (token) {
        mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(mappedFlag, ""); // 시도 1회 표시(성공·실패 무관 — 게이트웨이 다운 시 매 PostToolUse 스톨 방지)
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 1200);
        try {
          await fetch(`${gw}/api/ui/terminal/sessions/${encodeURIComponent(boxId)}/claude-uuid`, {
            method: "POST", signal: ctl.signal,
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ uuid: sid }),
          });
        } catch { /* fail-open — 미보고 시 복원은 picker 로 폴백 */ }
        finally { clearTimeout(to); }
      }
    }
  } catch { /* fail-open */ }
} catch { /* fail-open */ }
process.exit(0);

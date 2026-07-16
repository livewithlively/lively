#!/usr/bin/env node
// Stop 훅 — "파일 작업은 했는데 컨텍스트 스토어 기록이 없는" 세션을 종료 시점에 정확히 1회 붙잡는다.
// 자가 게이팅(D4): user-level 훅이라 모든 레포에서 뜨므로, 'lively work' 세션에서만 게이트가 작동한다.
//   isLivelyWork = (cwd 가 등록 work-root prefix 아래) OR (<sid>.lively 신호 — 이 세션에서 lively MCP 툴 사용).
//   cwd = stdin JSON 의 cwd 필드 우선(하네스 무관), 없으면 process.cwd() 폴백.
//   아니면 exit 0 silent — 개인/타 레포에서 절대 너지하지 않는다(fail-closed for the nag).
//   work-root 레지스트리: ~/.lively/work-roots (줄당 절대경로 prefix; # 주석·빈줄 무시) + env LIVELY_WORK_ROOTS(path-delim).
// 결정표(전부 결정적, LLM/모델 API 호출 0 — 판단은 살아있는 세션이 인-컨텍스트로):
//   LIVELY_OFF                   → exit 0 (incognito — 구 LIVELY_HOOKS_OFF alias)
//   stop_hook_active===true     → exit 0 (필수 루프가드 — 공식 계약)
//   !isLivelyWork                → exit 0 (자가 게이팅 — lively work 세션 아님)
//   <sid>.writeback 존재         → exit 0 (이미 기록함)
//   <sid>.worked 부재            → exit 0 (의미있는 작업 없음)
//   <sid>.blocked 존재           → exit 0 (이미 1회 너지함 — 세션당 1회)
//   그 외                        → .blocked 를 O_EXCL 원자 생성(병렬 중복 등록 대비) + {"decision":"block",…} 출력, exit 0
// 페일오픈: 어떤 실패든 무출력 exit 0. 비활성화(incognito): LIVELY_OFF=1 (구 LIVELY_HOOKS_OFF — alias)
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, sep, delimiter } from "node:path";

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FLAG_DIR = join(tmpdir(), "lively-hooks"); // 전 플랫폼 per-user tmp(work-flag.mjs 와 동일) — 공유 /tmp 미사용

// work-root 레지스트리 로드: ~/.lively/work-roots (줄 단위) + env LIVELY_WORK_ROOTS (path-delim 또는 ':').
function loadWorkRoots() {
  const roots = [];
  try {
    const txt = readFileSync(join(homedir(), ".lively", "work-roots"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) roots.push(t);
    }
  } catch { /* 없으면 무시 */ }
  const env = (process.env.LIVELY_WORK_ROOTS || "").trim();
  if (env) {
    for (const p of env.split(env.includes(delimiter) ? delimiter : ":")) {
      const t = p.trim();
      if (t) roots.push(t);
    }
  }
  return roots.map((r) => resolve(r));
}

// cwd 가 어느 work-root prefix 아래인가 (경계는 sep 또는 정확히 같은 경로 — /foo 가 /foobar 를 매치 않게).
function cwdUnderRoot(cwd, roots) {
  const c = resolve(cwd);
  return roots.some((r) => c === r || c.startsWith(r.endsWith(sep) ? r : r + sep));
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

// 어드민 런타임 설정(~/.lively/hooks-config.json) — 비활성 토글 + 커스텀 너지 문구. fail-open(못 읽으면 기본).
function readHooksConfig() {
  try { return JSON.parse(readFileSync(join(homedir(), ".lively", "hooks-config.json"), "utf8")); }
  catch { return null; }
}

// REASON = 게이트웨이가 영영 불가(최초 설치 전·완전 오프라인)일 때만 쓰는 짧은 last-resort 스텁(#270).
//  정상 경로의 너지 '전문'은 게이트웨이가 매 세션 서빙해 ~/.lively/hooks-config.json 에 기록되는 writeback_notice
//  (= 어드민 오버라이드 || 서버 DEFAULT_WRITEBACK_NOTICE, src/org/hook-defaults.ts)에서 온다 — readHooksConfig()?.writeback_notice
//  가 그것이고 거의 항상 존재한다. 그래서 여기 전문을 박지 않는다(DEFAULT_WRITEBACK_NOTICE 가 라이브 단일소스 — 동기화 불요).
const REASON =
  "이 세션에서 파일 작업을 했거나 외부 툴에서 맥락을 끌어왔는데 컨텍스트 스토어 기록이 없습니다. 마무리 전에 한 일을 " +
  "activity_log·knowledge_save 등으로 컨텍스트 스토어에 기록하세요(외부에서 끌어온 원문 중 SoT 에 없는 건 source_save — " +
  "세부 항목은 조직 너지 설정 참조). 기록할 것이 없으면 그대로 다시 종료하면 됩니다(이 알림은 세션당 1회).";

try {
  if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") process.exit(0);
  if (readHooksConfig()?.hooks?.stop_writeback_gate === false) process.exit(0); // 어드민이 이 훅 비활성화
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (input?.stop_hook_active === true) process.exit(0); // 루프가드(필수)
  const sid = String(input?.session_id ?? "");
  if (!SID_RE.test(sid)) process.exit(0);

  const flag = (name) => join(FLAG_DIR, `${sid}.${name}`);

  // 자가 게이팅: cwd 가 등록 work-root 아래 OR 이 세션에서 lively MCP 툴 사용(<sid>.lively).
  // 둘 다 아니면 게이트 작동 안 함 — 개인/타 레포에서 너지 금지.
  // cwd 는 stdin JSON 의 cwd 우선(하네스 무관 계약 — Codex R2 가 다른 작업디렉로 spawn 해도 정확).
  //   없으면 process.cwd() 폴백(Claude Code 는 프로젝트 디렉에서 훅 실행).
  const cwd = (typeof input?.cwd === "string" && input.cwd) || process.cwd();
  const isLivelyWork = cwdUnderRoot(cwd, loadWorkRoots()) || existsSync(flag("lively"));
  if (!isLivelyWork) process.exit(0);

  if (existsSync(flag("writeback"))) process.exit(0); // 이미 기록함
  if (!existsSync(flag("worked"))) process.exit(0);   // 의미있는 작업 없음
  if (existsSync(flag("blocked"))) process.exit(0);   // 이미 1회 너지함(순차 fast-path)

  mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 });
  // 세션당 1회 '원자적' 점유 — 같은 Stop 이벤트에 이 훅이 여러 settings(유저 ~/.claude + 프로젝트
  //   $CLAUDE_PROJECT_DIR/.claude)에서 병합·중복 등록되면 클코가 이를 '병렬' 실행한다. 위 existsSync
  //   사전체크는 TOCTOU 라 병렬 중복을 못 막는다(둘 다 부재로 보고 둘 다 block → 너지 N회). O_EXCL("wx")
  //   로 .blocked 생성을 원자화하면 동시 N개 중 정확히 1개만 성공, 나머지는 EEXIST → 침묵(세션당 1회 보장).
  try { writeFileSync(flag("blocked"), "", { flag: "wx" }); }
  catch { process.exit(0); } // 이미 누군가 점유(EEXIST) — 중복 너지 금지
  const reason = readHooksConfig()?.writeback_notice || REASON; // 어드민 커스텀 너지 우선
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
} catch { /* fail-open */ }
process.exit(0);

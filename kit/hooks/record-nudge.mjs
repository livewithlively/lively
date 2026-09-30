// 기록 넛지(#4219) — work-flag.mjs 가 import 하는 모듈(훅이 아니다). 기록 묶음 스킬(record-batch)을 결정적 신호로 받친다.
//
// ① 교정 넛지(PostToolUse) — 메인이 라이블리 텍스트 기록을 한 턴에 합계 1,000자 이상 **직접** 썼으면 «남은 기록과 다음 턴부터는
//    보고 직전 fork 하나로 묶어라»를 additionalContext 로 준다. 막지 않는다 — 본문 생성은 이미 끝났고 막으면 시간만 버린다.
//    1,000자 미만 인라인은 스킬이 권하는 정상 동작이라 넛지하지 않는다(record-batch §1). 턴당 1회 · 세션당 2회.
// ② 압축 넛지 — 두 하네스 모두 PreCompact 로는 모델에 말을 걸 수 없다(#4219 실측):
//    · claude 2.1.285 — PreCompact 는 막기만 하고, 막은 이유는 모델이 아니라 사람 화면 경고·로그로 간다. 대신 **성공한 훅의
//      stdout 이 압축 요약 지시문(newCustomInstructions)에 붙는다** → 요약에 미기록 사실을 원문대로 남기게 한다.
//    · codex 0.154.0 — PreCompact 출력은 continue:false(턴 중단)뿐이다(hooks/src/events/compact.rs). 주입 없음.
//    · 둘 다 압축 직후 SessionStart(source=compact)가 컨텍스트를 주입할 수 있다 → «요약에 남은 사실로 지금 기록하라».
//    압축 **전에** fork 로 비우게 하는 건 이 훅들로는 불가능하다 — 그 한계를 요약 보존(claude) + 직후 알림(둘 다)으로 메운다.
//
// 상태 파일(플래그 디렉터리, work-flag 와 같은 곳):
//   <sid>.inline-write.<tool_use_id>  이번 턴 메인의 인라인 기록 1건의 인자 글자 수. **호출마다 파일 하나** — 병렬 툴콜의 훅이
//                                      겹쳐도 합이 유실되지 않고, 같은 호출에 훅이 두 벌 배선돼 있어도(유저·프로젝트 settings)
//                                      같은 파일을 덮어써 두 번 세지 않는다. UserPromptSubmit(턴 시작)에 전부 지운다.
//   <sid>.inline-nudged                이번 턴에 이미 넛지함(O_EXCL — 동시에 넘은 두 훅 중 하나만 낸다). 턴 시작에 지운다.
//   <sid>.inline-nudge.<n>             세션당 넛지 횟수(n = 1..상한, O_EXCL 로 한 칸씩 점유).
//   <sid>.compact-nudge.<pre|resume>.<분>  압축 넛지를 이 1분 칸에 이미 냈음(두 벌 배선의 중복 출력 방지, claimCompactOnce).
// 페일오픈: 어떤 실패든 null(무출력). 판단은 전부 결정적이다(LLM 호출 0).
import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { join } from "node:path";
import { canRecordFork, isHeadlessRun, recordPendingPrefix, RECORD_PENDING_TTL_MS } from "./harness-registry.mjs";

// 넛지 대상 = 스킬이 fork 로 넘기라는 «쏘고 잊는 긴 쓰기»(record-batch §2 왼쪽 칸). 생성(project_create_v6·task_create_v6)은
//  반환 id 를 곧바로 써야 해서 스킬이 메인에 남기라는 쪽이라 세지 않는다.
export const INLINE_NUDGE_TOOLS = new Set(["knowledge_save", "project_update_v6", "task_update_v6", "task_comment_v6", "activity_log"]);
// 문턱 = 인자 JSON 글자 수의 턴 합계. #4201 실측이 잰 양(in_ch)과 같은 단위라 스킬의 «약 1,000자»와 맞물린다.
export const INLINE_TURN_THRESHOLD = 1000;
export const INLINE_NUDGE_MAX_PER_SESSION = 2;

const INLINE_PREFIX = (sid) => `${sid}.inline-write.`;
const safeName = (s) => String(s || "").replace(/[^A-Za-z0-9._-]/g, (c) => `%${c.codePointAt(0).toString(16)}`).slice(0, 120);

// 서브에이전트(fork 포함) 안의 호출인가 — 부모 session_id 에 agent_id 가 붙어 온다(claude 문서 «Present only when the hook fires
//  inside a subagent call» · #4201 §11-2 실측, codex hooks/src/schema.rs 의 선택 필드). fork 의 기록에는 넛지하지 않는다.
export const isSubagentPayload = (payload) => String(payload?.agent_id ?? "").trim() !== "";

// 라이블리가 띄운 기계 세션(위탁·증류 등)인가 — 서버가 pane 에 싣는 LIVELY_SESSION_KIND 축(#2162). 값이 없으면(그 축 이전에 뜬
//  세션) 위탁 워커 작업 폴더(LIVELY_TASK_WS)로 한 번 더 보고, 그것도 없으면 사람 세션으로 본다(session-name-ask 와 같은 관례).
const isMachineSession = (env) => {
  const k = String(env?.LIVELY_SESSION_KIND ?? "").trim().toLowerCase();
  if (k) return k !== "human";
  return String(env?.LIVELY_TASK_WS ?? "").trim() !== "";
};

// 파일 앞부분만 읽는다(codex 대화 파일 첫 줄의 session_meta — 파일 전체는 수십 MB 일 수 있다).
export function readHead(path, bytes = 4096) {
  const fd = openSync(path, "r");
  try { const buf = Buffer.alloc(bytes); const n = readSync(fd, buf, 0, bytes, 0); return buf.subarray(0, n).toString("utf8"); }
  finally { closeSync(fd); }
}

// 이 세션에서 기록 fork 를 권해도 되나 — fork 가 있는 하네스 · 사람이 대화하는 실행 · 라이블리 기계 세션 아님.
export function forkAdvisable(harnessId, payload, env) {
  return canRecordFork(harnessId) && !isMachineSession(env) && !isHeadlessRun(harnessId, payload, env, (p) => readHead(p));
}

// 턴 시작 — 이번 턴 합계와 턴 넛지 표시를 지운다. 서브에이전트의 턴 시작(codex 자식도 UserPromptSubmit 을 낸다)은 부모 턴이 아니다.
export function resetInlineTurn(flagDir, sid, payload) {
  if (isSubagentPayload(payload)) return;
  try {
    const prefix = INLINE_PREFIX(sid);
    for (const f of readdirSync(flagDir)) if (f.startsWith(prefix)) { try { unlinkSync(join(flagDir, f)); } catch { /* 경합 — 이미 지워짐 */ } }
  } catch { /* 디렉터리 없음 */ }
  try { unlinkSync(join(flagDir, `${sid}.inline-nudged`)); } catch { /* 없었다 */ }
}

function claimOnce(path) {
  try { writeFileSync(path, "", { flag: "wx" }); return true; } catch { return false; }
}

// ① 교정 넛지 — 메인의 인라인 텍스트 기록 1건을 세고, 이번 턴 합계가 문턱을 처음 넘었으면 넛지 문구를 돌려준다(아니면 null).
//  bare = 서버 접두어를 뗀 라이블리 툴 이름(work-flag 가 harness-registry.mcpToolName 으로 구한다).
export function inlineWriteNudge({ flagDir, sid, harnessId, bare, payload, env }) {
  if (!INLINE_NUDGE_TOOLS.has(String(bare || "")) || isSubagentPayload(payload)) return null;
  if (!forkAdvisable(harnessId, payload, env)) return null;
  const chars = JSON.stringify(payload?.tool_input ?? {}).length;
  const id = safeName(payload?.tool_use_id || `t${Date.now()}`);
  writeFileSync(join(flagDir, INLINE_PREFIX(sid) + id), String(chars));
  let total = 0;
  const prefix = INLINE_PREFIX(sid);
  for (const f of readdirSync(flagDir)) {
    if (!f.startsWith(prefix)) continue;
    try { total += Number(readFileSync(join(flagDir, f), "utf8")) || 0; } catch { /* 경합 — 턴 시작에 지워짐 */ }
  }
  if (total < INLINE_TURN_THRESHOLD) return null;
  if (!claimOnce(join(flagDir, `${sid}.inline-nudged`))) return null;             // 이번 턴에 이미 냈다
  let slot = 0;
  for (let n = 1; n <= INLINE_NUDGE_MAX_PER_SESSION && !slot; n++) if (claimOnce(join(flagDir, `${sid}.inline-nudge.${n}`))) slot = n;
  if (!slot) return null;                                                          // 세션 상한
  return inlineNudgeText(harnessId, total);
}

export function inlineNudgeText(harnessId, total) {
  const codex = harnessId === "codex"
    ? " codex 의 fork 는 사용자 메시지와 최종 답만 물려받으므로 message 에 사실 메모(수치·경로·id·결정)를 함께 싣습니다(스킬 §4)."
    : "";
  return `[라이블리 기록 교정] 이번 턴에 메인이 라이블리 텍스트 기록(지식·본문 append·댓글·작업 기록)을 직접 ${total.toLocaleString("en-US")}자 썼습니다. ` +
    "메인이 본문을 생성하는 동안 사람은 기다립니다(knowledge_save 1건 p50 46초). 이미 쓴 것은 다시 쓰지 마세요. " +
    "이번 턴에 남은 기록과 다음 턴부터의 기록은 record-batch 스킬대로 사람에게 보고하기 직전 fork 하나(이름 머리 `기록:`)에 묶어 넘기세요. " +
    `한 턴 합계 ${INLINE_TURN_THRESHOLD.toLocaleString("en-US")}자 미만의 짧은 기록은 지금처럼 바로 써도 됩니다.${codex}`;
}

// 마지막 라이블리 기록 뒤에 한 작업이 있나 — .worked(파일 작업·외부 인입)가 .writeback(기록)보다 나중이면 참.
//  이 세션이 라이블리를 쓰는 세션일 때만(.lively — 종료 게이트의 자가 게이팅 신호와 같다). 기록 fork 가 도는 중이면 거짓
//  (그 fork 가 곧 기록한다 — 여기서 또 권하면 중복 기록이 된다).
export function hasUnrecordedWork(flagDir, sid) {
  const mtime = (name) => { try { return statSync(join(flagDir, `${sid}.${name}`)).mtimeMs; } catch { return null; } };
  if (!existsSync(join(flagDir, `${sid}.lively`))) return false;
  const worked = mtime("worked");
  if (worked === null) return false;
  const wb = mtime("writeback");
  if (wb !== null && wb >= worked) return false;
  try {
    const prefix = recordPendingPrefix(sid);
    const inFlight = readdirSync(flagDir).some((f) => {
      if (!f.startsWith(prefix)) return false;
      try { return Date.now() - statSync(join(flagDir, f)).mtimeMs <= RECORD_PENDING_TTL_MS; } catch { return false; }
    });
    if (inFlight) return false;
  } catch { /* 디렉터리 없음 */ }
  return true;
}

// 압축 한 번에 한 번만 — 같은 이벤트에 이 훅이 유저·프로젝트 settings 두 벌로 배선돼 있으면(명령 문자열이 달라 하네스가 합치지 않는다)
//  둘이 나란히 돌아 같은 지시문이 두 번 붙는다. 페이로드에 압축마다 다른 id 가 없어 1분 칸으로 가르고 O_EXCL 로 하나만 낸다
//  (압축은 수십 초가 걸려 같은 1분에 두 번 일어나지 않는다).
function claimCompactOnce(flagDir, sid, kind) {
  return claimOnce(join(flagDir, `${sid}.compact-nudge.${kind}.${Math.floor(Date.now() / 60_000)}`));
}

// ② claude PreCompact — stdout 이 그대로 압축 요약 지시문에 붙는다(모델에게 직접 가지 않는다). 사람 화면에도 한 줄로 보이므로 짧게.
export function preCompactInstructions({ flagDir, sid, payload }) {
  if (isSubagentPayload(payload) || !hasUnrecordedWork(flagDir, sid) || !claimCompactOnce(flagDir, sid, "pre")) return null;
  return "라이블리 기록 보존: 이 대화에는 라이블리(knowledge_save·activity_log·task_comment_v6 등)에 아직 기록하지 않은 작업이 있다. " +
    "요약에 «미기록 — 라이블리에 남길 것» 절을 따로 두고, 기록해야 할 결정·수치·파일 경로·커밋·태스크/프로젝트 번호·지식 이름·오류 원문을 원문 그대로 항목으로 남겨라. " +
    "이미 라이블리에 기록한 것은 넣지 않는다.";
}

// ② 압축 직후 SessionStart(source=compact) — 모델에게 주입된다(claude·codex 공통 봉투).
export function compactResumeContext({ flagDir, sid, harnessId, payload, env }) {
  if (isSubagentPayload(payload) || String(payload?.source ?? "") !== "compact" || !hasUnrecordedWork(flagDir, sid)) return null;
  if (!claimCompactOnce(flagDir, sid, "resume")) return null;
  const how = forkAdvisable(harnessId, payload, env)
    ? `합계 ${INLINE_TURN_THRESHOLD.toLocaleString("en-US")}자 이상이면 record-batch 스킬대로 사람에게 보고하기 직전 fork 하나(이름 머리 \`기록:\`)에 묶고, 그보다 짧으면 바로 쓰세요. fork 도 압축된 요약만 물려받으니 지시문에 요약의 해당 항목을 가리키세요.`
    : "fork 없이 바로 쓰세요.";
  const where = harnessId === "claude" ? "요약의 «미기록 — 라이블리에 남길 것» 절과 " : "요약과 ";
  return "[라이블리 압축 직후] 방금 대화가 압축됐고, 압축 전에 한 작업 중 라이블리에 아직 기록하지 않은 것이 있습니다(마지막 기록 뒤의 파일 작업·외부 인입). " +
    `이번 턴 안에 ${where}파일·git·라이블리 조회로 확인되는 사실만으로 기록하세요 — 요약에 없는 수치·경로는 지어내지 말고 다시 확인합니다. ${how}`;
}

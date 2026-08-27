// org_hook(event=UserPromptSubmit, harness=all) — 첫 실질 지시 턴에 **그 세션 자신에게** 이름을 지으라고 시킨다.
//  ★ #2031 부터는 두 가지를 함께 시킨다: **이 세션의 이름**과, 이 세션의 첫 지시로 **자동 생성된 프로젝트의 이름**.
//   둘은 같은 순간에 같은 재료(첫 지시 + 주입된 AGENTS.md·팀 지식)로 정해지므로 훅을 둘로 나눌 이유가 없다 —
//   프로세스도 플래그도 하나다. 자격 없는 대상(사람이 지은 프로젝트 등)은 **서버 걸쇠**가 조용히 흡수한다.
//
// 왜 이 훅이 존재하나(#1979 · 발의 윤상민 2026-08-25):
//  종전(#1719)엔 서버가 하네스를 **헤드리스로 따로 스폰**해 이름을 지었다(구 src/terminal/session-name-ai.ts).
//  그 스폰이 `{ ...process.env }` 로 부모 세션의 LIVELY_SESSION_ID·LIVELY_TOKEN·훅 배선을 상속했고,
//  project-auto-bind 가 **이름짓기 프롬프트를 사람의 첫 실질 지시로 오인**해 프로젝트를 만들어 부모에 붙였다
//  (프로덕션 실측 2026-08-25: #1946·#1957 — 제목이 이름짓기 프롬프트 첫 줄 그대로, 후자는 실사용자 세션).
//  스폰이 0이면 그 오염은 완화가 아니라 **구조적으로 없다**. 그래서 이름은 이미 도는 세션이 짓는다 —
//  그 세션에는 첫 지시뿐 아니라 **주입된 프로젝트 AGENTS.md·팀 지식**까지 이미 들어와 있어 헤드리스보다 잘 짓는다.
//
// ⚠ **네트워크를 한 번도 안 쓴다.** UserPromptSubmit 훅은 사람의 프롬프트 앞을 막고 서 있다 — 여기서 조회를 하면
//  그게 곧 첫 응답 지연이다. "이미 이름이 있나"는 서버가 판정한다(걸쇠 = org_session_state.label_source,
//  session-label-source.ts). 훅은 tmp 플래그로 **세션당 한 번만** 안내하고 그대로 빠진다(실질 0ms).
//  중복 안내는 걸쇠가 흡수한다(두 번째 session_rename 은 applied:false 로 조용히 무시된다).
//
// 불변식: 절대 막지 않는다(additionalContext 만, 어떤 실패든 무출력 exit 0).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FLAG_DIR = path.join(os.tmpdir(), "lively-hooks");   // 다른 시드 훅과 같은 per-user tmp
// 이 프롬프트로 이름을 지을 만한가.
//  ⚠ **프로젝트 생성 규칙과 일부러 다르다.** #1867 후속(2026-08-25)에서 프로젝트 쪽은 길이 게이트를 없앴다 —
//   짧게 말을 건 세션도 작업 폴더(cwd)가 필요한데 cwd 는 한 번 정하면 못 바꾸기 때문이다. 이름은 그 반대다:
//   여기엔 **걸쇠**가 있어서(label_source, agent 는 agent 를 못 덮는다) "ㄱㄱ" 로 지은 이름이 그대로 굳고,
//   그 뒤로는 사람이 손으로 고쳐야 한다. 되돌리기 비싼 쪽이 게이트를 갖는다.
//  자격 미달이면 **플래그를 소모하지 않고** 빠진다 — 다음의 제대로 된 지시에서 다시 본다.
const MIN_PROMPT_CHARS = 12;

const readStdin = () => new Promise((resolve) => {
  let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
  try {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); });
    process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 600);
  } catch { fin(); }
});

// 실행 세션 id — project-auto-bind 와 같은 규약(관리형은 env, 외부 codex/claude 는 훅 stdin 의 native id).
function executionSessionId(input = {}, env = process.env) {
  const direct = String(env.LIVELY_SESSION_ID || "").trim();
  if (direct && SID_RE.test(direct)) return direct;
  const native = String(input.session_id || input.sessionId || "").trim();
  const harness = String(env.LIVELY_HARNESS || "claude").trim().toLowerCase();
  if (native && harness === "codex" && SID_RE.test(`codex-${native}`)) return `codex-${native}`;
  if (native && harness === "claude" && SID_RE.test(`claude-${native}`)) return `claude-${native}`;
  const codex = String(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || "").trim();
  if (codex && SID_RE.test(`codex-${codex}`)) return `codex-${codex}`;
  const claude = String(env.CLAUDE_SESSION_ID || "").trim();
  if (claude && SID_RE.test(`claude-${claude}`)) return `claude-${claude}`;
  return null;
}

/** 이 프롬프트로 이름을 지을 만한가(순수 — project-auto-bind 의 자격 규칙과 같은 형태). */
export function namingPromptOk(promptRaw) {
  const p = String(promptRaw ?? "").trim();
  if (p.length < MIN_PROMPT_CHARS) return false;              // "ㄱㄱ"·"응"·"계속" — 세션이 무엇인지 말해주지 않는다
  if (p.startsWith("/") || p.startsWith("!") || p.startsWith("<")) return false;  // 슬래시·뱅 커맨드·하네스 주입물
  return true;
}

const GUIDE =
  "[라이블리 — 이름짓기(세션당 1회): 이 세션 · 이 세션이 만든 프로젝트]\n" +
  "① **세션 이름** — 이 세션이 **무엇을 하는 자리인지** 드러나는 이름을 지어 `session_rename {name: \"…\"}` " +
  "(lively MCP — session_id 는 생략, 이 세션 자신)로 한 번 등록하세요.\n" +
  "  · 한국어 명사구 한 줄 · 공백 포함 10자 이내 · 조사·서술어 없이 (예: `결제 백오프`, `한글 자모분리`)\n" +
  "  · ⚠ **프로젝트 이름을 그대로 쓰지 마세요.** 소속은 트리·칩이 이미 말합니다. 한 프로젝트 아래 세션이 " +
  "전부 같은 이름이면 목록에서 서로 구분되지 않습니다(실측: 프로젝트 세션 147건 중 104건이 그랬습니다). " +
  "세션 이름은 '어디에 속하나'가 아니라 **'여기서 무엇을 시켰나'** 입니다.\n" +
  "② **프로젝트 이름** — 지금 주입된 프로젝트 AGENTS.md 가 «세션의 첫 지시에서 **자동 생성**된 프로젝트»라고 " +
  "말하고 있으면, ①에서 지은 세션 이름이 그 프로젝트에도 **자동으로 승계**됩니다(서버가 합니다). " +
  "그 이름이 **이 일 전체의 이름**으로는 좁다면, 더 나은 이름을 지어 `project_rename_v6 {name: \"…\"}` " +
  "(id 생략 = 이 세션이 붙어 있는 프로젝트)로 한 번 등록하세요 — 승계된 이름을 한 번 이깁니다.\n" +
  "  · 한국어 명사구 · 공백 포함 20자 안팎 · **무슨 일인지**를 말합니다(예: `프로젝트 자동 이름짓기`, " +
  "`앱 한글 자모분리 수정`). 세션 이름이 이미 그 일을 잘 말하고 있으면 **그냥 두세요**(부를 필요 없습니다).\n" +
  "  · 자동 생성이 아닌 프로젝트(사람이 만든 것·이미 이름이 지어진 것)라면 **아무것도 하지 마세요** — " +
  "그래도 불렀다면 서버가 `applied:false` 로 조용히 무시합니다(사람이 지은 이름은 덮이지 않습니다).\n" +
  "  · 사람이 대화에서 **직접** 이름을 지시했다면 그건 이 툴이 아니라 `project_update_v6 {id, name}` 입니다.\n" +
  "· 둘 다 **답변을 막지 마세요** — 지금 받은 지시를 먼저 처리하고, 그 턴 안에서 아무 때나 한 번씩 부르면 됩니다. " +
  "길이 초과·따옴표는 서버가 다듬고, 이미 이름이 있으면 `applied:false` 로 조용히 무시됩니다(에러가 아니니 재시도 마세요).\n" +
  "· 위 지시문뿐 아니라 **지금 주입된 프로젝트 맥락(AGENTS.md)·팀 지식까지 함께 보고** 지으세요 — " +
  "그게 따로 이름을 짓던 종전 방식보다 이 자리가 나은 이유입니다.\n";

(async () => {
  if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") return;
  // 읽기전용·인코그니토 — 세션 이름도 조직에 남는 쓰기다(읽기전용에선 어차피 툴이 막힌다). 안내 자체를 하지 않는다.
  const mode = String(process.env.LIVELY_MODE || "").trim().toLowerCase();
  if (mode === "readonly" || mode === "incognito") return;
  // ⚠ **위탁(task) 세션은 제외한다**(#1979 항목4). project-auto-bind 와 같은 표식·같은 이유다.
  //  ① 위탁 워커의 이름은 이미 정해져 있다 — `위탁 #<taskId>`(src/node/tasks.ts:376). 그게 세션 목록에서
  //   "이건 배치다"를 말해 주는 유일한 신호인데, 걸쇠상 agent 가 rule 을 이기므로 이 훅이 그 신호를 덮는다.
  //   실측(2026-08-26~27): 위탁이 만든 프로젝트가 «내 컴퓨터 자료 증류 배치»·«도메인맵 미분류 매핑» 처럼
  //   **멀쩡한 이름**을 달아 보드에서 진짜 작업과 구분되지 않았다 — 쓰레기가 위장된 셈이다.
  //  ② 배치마다 이름짓기 툴콜이 한 번씩 붙는다. 사람이 기다리는 턴이 아니라 순수 낭비다.
  if (String(process.env.LIVELY_TASK_WS || "").trim()) return;

  const stdinData = await readStdin();
  let input = {}; try { input = JSON.parse(stdinData || "{}"); } catch { return; }
  const boxId = executionSessionId(input);
  if (!boxId) return;
  if (!namingPromptOk(input.prompt)) return;

  // 세션당 1회 — O_EXCL 원자 생성(병렬 턴 대비). 이게 이 훅의 **유일한** I/O 다.
  const flag = path.join(FLAG_DIR, `${boxId}.sessname`);
  try {
    if (fs.existsSync(flag)) return;
    fs.mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(flag, "", { flag: "wx" });
  } catch { return; }                              // 이미 누가 만들었다(또는 tmp 를 못 쓴다) — 중복 안내 안 함

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: GUIDE },
  }) + "\n");
})().then(() => process.exit(0)).catch(() => process.exit(0));

// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=PreToolUse, harness=claude) — 관리탭 ▸ 커스텀 훅으로 등록.
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 세션 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//
//  하는 일(#1824 로 역할이 바뀌었다): 세션이 처음으로 '남는 것을 만드는 툴'(라이블리 쓰기 · 파일 편집)을 부르기
//   직전, 딱 한 번 붙잡아 **이 세션이 붙은 프로젝트를 정련**시킨다 — 첫 쓰기 = 무엇을 하는 일인지 드러난 시점이다.
//    (a) 자동 생성 껍데기(project-auto-bind 가 첫 지시로 만든 것)에 붙어 있으면 → 제목·분류·관계·지식을 보강
//    (b) 지금 하는 일이 **명백히** 다른 미완료 프로젝트 소속이면 → 정보 손실 없이 그리로 이관
//    (c) 아직 미연결이면(자동 생성 훅이 꺼졌거나 실패한 폴백) → 종전대로 새 프로젝트를 만들어 붙이게
//   정상 소속(사람이 고른 프로젝트·이미 정련된 프로젝트)이면 **아무 말도 하지 않는다**.
//
//  역할 이동의 배경:
//   · #1762 — 미연결 세션에 '연결하라'고 권고. 임베딩 유사 후보를 제시했다.
//   · #1798 — 후보 제시가 오연결·맥락낭비를 낳아 폐기하고 '새 프로젝트 생성'을 기본 권고로.
//   · #1824 — 권고로는 미연결이 안 사라져서 **생성 자체를 기계(project-auto-bind, UserPromptSubmit)로** 내렸다.
//     그래서 이 훅은 이제 '붙였나?'가 아니라 **'제대로 된 프로젝트인가?'**를 본다.
//
//  기존 프로젝트로 옮기는 판정은 여전히 **결정론·사람 지목만**이다(유사도 매칭 부활 금지 — #1798 실측 오연결):
//   0층 결정론 — 지금 호출하려는 툴 입력이 프로젝트를 가리키면(task_create_v6.projectId · activity_log.project_id ·
//   파일 경로의 project/<id>/ 슬롯) 그게 이관 후보다. 그 외엔 사람이 대화에서 직접 지목했을 때만.
//
//  불변식:
//   · **절대 막지 않는다** — permissionDecision 을 내지 않는다(additionalContext 만). 어떤 실패든 무출력 exit 0.
//   · **세션당 1회** — tmp 플래그를 O_EXCL 로 원자 생성(병렬 툴콜 대비). 판정이 '침묵'이어도 소모한다(그것도 결론이다).
//     단 **판정에 필요한 조회가 실패하면 소모하지 않는다** — 다음 쓰기 툴에서 다시 본다.
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// #1750 — 세션 소속 신호: 게이트웨이가 x-lively-session(→ 세션 정본 gw_session_map)·x-lively-workspace 로
//  이 세션의 워크스페이스 컨텍스트를 되찾는다. 안 실으면 primary 로 간주되므로(폴백) secondary 세션의
//  훅 호출이 조용히 primary 데이터를 읽고 쓴다.
const FLAG_DIR = path.join(os.tmpdir(), "lively-hooks");   // work-flag.mjs·stop-writeback-gate 와 같은 per-user tmp
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FETCH_MS = 4000;
// project-auto-bind 가 본문 끝에 남기는 표식 — 이 문자열이 두 훅과 GC 의 유일한 계약이다(바꾸려면 셋 다 함께).
const AUTO_MARK = "lively:auto-created-from-first-prompt";

const readStdin = () => new Promise((resolve) => {
  let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
  try {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); });
    process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 600);
  } catch { fin(); }
});

function executionSessionId(input = {}, env = process.env) {
  const direct = String(env.LIVELY_SESSION_ID || "").trim();
  if (direct && SID_RE.test(direct)) return direct;
  const native = String(input.session_id || input.sessionId || "").trim();
  // 러너 규약(harness-registry.resolveHarness)과 같이 미지정=claude — 외부 Claude Code(--harness 없는 배선)도 실행 ID 를 갖는다.
  const harness = String(env.LIVELY_HARNESS || "claude").trim().toLowerCase();
  if (native && harness === "codex" && SID_RE.test(`codex-${native}`)) return `codex-${native}`;
  if (native && harness === "claude" && SID_RE.test(`claude-${native}`)) return `claude-${native}`;
  const codex = String(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || "").trim();
  if (codex && SID_RE.test(`codex-${codex}`)) return `codex-${codex}`;
  const claude = String(env.CLAUDE_SESSION_ID || "").trim();
  if (claude && SID_RE.test(`claude-${claude}`)) return `claude-${claude}`;
  return null;
}

// ── 0층 결정론: 지금 호출하려는 툴 입력에서 프로젝트 id 를 뽑는다(유일하게 믿을 수 있는 기존-프로젝트 신호). ──
//  · task_create_v6 → projectId · activity_log → project_id (그 프로젝트에 남기려는데 세션은 딴 데 붙어 있는 상황)
//  · 파일 편집 → file_path 가 워크스페이스 프로젝트 슬롯(project/<id>/…)을 지나면 그 id.
//    (project/<id>-suffix 같은 브랜치명 디렉터리는 \d+ 바로 뒤 / 가 아니라 안 잡힌다.)
function projectIdFromToolInput(toolName, ti) {
  if (!ti || typeof ti !== "object") return null;
  const n = String(toolName || "");
  let v = null;
  if (/task_create_v6$/.test(n)) v = ti.projectId;
  else if (/activity_log$/.test(n)) v = ti.project_id;
  const id = Number(v);
  if (Number.isInteger(id) && id > 0) return id;
  const fp = typeof ti.file_path === "string" ? ti.file_path : "";
  const m = /(?:^|\/)project\/(\d+)(?:\/|$)/.exec(fp);
  if (m) { const pid = Number(m[1]); if (Number.isInteger(pid) && pid > 0) return pid; }
  return null;
}

(async () => {
  if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") return;
  const stdinData = await readStdin();
  let input = {}; try { input = JSON.parse(stdinData || "{}"); } catch { return; }
  const boxId = executionSessionId(input);
  if (!boxId) return;

  // 세션당 1회 — 이미 봤으면 끝.
  const flag = path.join(FLAG_DIR, `${boxId}.projbind`);
  try { if (fs.existsSync(flag)) return; } catch { return; }
  const consume = () => {
    try { fs.mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(flag, "", { flag: "wx" }); return true; }
    catch { return false; }                        // 이미 누가 만들었다 → 중복 안내 안 함
  };

  const detId = projectIdFromToolInput(input.tool_name, input.tool_input);
  const emit = (text) => process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text },
  }) + "\n");
  const moveHint = (from) =>
    "\n⚠ 지금 하는 일이 실은 **기존 미완료 프로젝트**의 일부인 것이 명백하면" +
    (detId != null ? `(지금 호출하려는 툴 입력이 **#${detId}** 를 가리킵니다 — 결정론 신호)` : "(사람이 그 프로젝트를 직접 지목했을 때만 — 검색·유사도로 추측하지 마세요)") +
    ", 여기서 정련하지 말고 그리로 옮기세요. **정보를 잃지 않는 순서**로:\n" +
    `  1) 지금 프로젝트(#${from})의 본문(첫 지시 원문)을 대상에 옮겨 붙입니다 — \`project_update_v6(id: <대상>, append_description: …)\`\n` +
    `  2) 이미 #${from} 에 붙은 산출/필요지식이 있으면 대상에도 \`project_link_knowledge_v6\` 로 잇습니다\n` +
    "  3) `session_set_project {project_id: <대상>}` 로 세션을 옮깁니다 — 지나간 작업 귀속은 시간구간으로 남아 사라지지 않습니다\n" +
    `  4) 빈 껍데기 #${from} 에는 어디로 갔는지 한 줄 남깁니다 — \`project_update_v6 {id: ${from}, append_description: "→ #<대상> 으로 이관됨(이 프로젝트는 비어 있습니다)."}\`\n` +
    "     (자동 삭제 장치는 없습니다 — 사람이 보드에서 보고 지웁니다. 그래서 '어디로 갔는지'가 본문에 남아 있어야 합니다.)\n";

  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");
  const SCOPE_HDRS = {
    "x-lively-session": boxId,
    ...(String(process.env.LVLY_TENANT_SLUG || "").trim() ? { "x-lively-workspace": String(process.env.LVLY_TENANT_SLUG).trim() } : {}),
  };
  let binding = null;
  {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
    try {
      const res = await fetch(`${base}/api/ui/execution-sessions/${encodeURIComponent(boxId)}/project-context?knownRevision=-1`, { signal: ctl.signal, headers: { authorization: "Bearer " + token, ...SCOPE_HDRS } });
      if (res.ok) binding = await res.json();
    } catch { /* 다음 쓰기에서 재시도 */ }
    finally { clearTimeout(t); }
  }
  if (!binding) return;
  const pid = Number(binding.project_id || 0);

  // ── (c) 미연결 — project-auto-bind 가 꺼졌거나 실패한 폴백. 종전대로 붙이라고 안내한다. ──
  if (!(pid > 0)) {
    if (!consume()) return;
    emit(
      "[이 세션은 라이블리 프로젝트에 안 붙어 있습니다 — 세션당 1회 안내]\n" +
      "지금 무언가를 남기려 합니다. 미연결 상태로 남기면 그 지식·작업기록·산출물이 **어느 프로젝트에도 귀속되지 않습니다**.\n" +
      (detId != null
        ? `지금 호출하려는 툴 입력이 **프로젝트 #${detId}** 를 가리킵니다(결정론 신호). 이 세션을 거기에 붙이세요: \`session_set_project {project_id: ${detId}}\` (lively MCP — session_id 는 생략, 이 세션 자신).\n`
        : "**기본 동작은 새 프로젝트 생성입니다.** 기존 프로젝트를 검색해 골라 붙이려 하지 마세요 — 유사도 매칭은 오연결이 잦고 후보 검토로 맥락만 낭비합니다. 기존 프로젝트에 붙이는 건 사람이 그 프로젝트를 직접 지목했을 때만 하세요.\n" +
          "`project_create_v6` 로 새 프로젝트를 만들되 ① 소속 리스트(`project_list_index_v6` 의 `list_id`, 필수) ② 선행·후속(`follow_up` 또는 `project_link_project_v6`) ③ 필요·산출지식(`project_link_knowledge_v6`)을 함께 챙기고, " +
          "`session_set_project {project_id: <새 id>}` 로 이 세션을 붙이세요.\n") +
      "프로젝트를 붙이면 다음 턴에 해당 AGENTS.md가 동적으로 주입됩니다.\n" +
      "지금 호출하려던 툴은 그대로 진행하면 됩니다(이 안내는 아무것도 막지 않습니다).");
    return;
  }
  // ── 붙은 프로젝트가 '자동 생성 껍데기'인지 본다. 조회 실패면 판정 불가 → 플래그를 쓰지 않고 다음 기회에. ──
  let proj = null;
  {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
    try {
      const res = await fetch(`${base}/api/ui/v6/projects/${pid}`, { signal: ctl.signal, headers: { authorization: "Bearer " + token, ...SCOPE_HDRS } });
      if (res.ok) { const j = await res.json(); proj = (j && j.project) || null; }
    } catch { /* 네트워크 → 아래에서 재시도로 남긴다 */ }
    finally { clearTimeout(t); }
  }
  if (!proj) return;                               // 판정 불가 — 플래그 미소모(다음 쓰기 툴에서 다시 본다)

  const isShell = String(proj.description || "").includes(AUTO_MARK);
  if (!isShell) {                                  // 사람이 고른 프로젝트 · 이미 정련된 프로젝트 → 할 말 없음
    consume();
    return;
  }

  // ── (a) 자동 생성 껍데기 — 지금이 정련 시점이다. ──
  if (!consume()) return;
  const nm = String(proj.name || "");
  // 제목은 이제 첫 지시 턴에 세션이 스스로 짓는다(#2031 — session-name-ask 안내 ② + project_rename_v6 걸쇠).
  //  그래서 여기서는 **아직 기계값인 경우에만**(name_source='rule') 제목을 다시 꺼낸다. 이미 지어진 이름을
  //  다섯 줄짜리 정련 목록에 또 올리면, 방금 잘 지은 이름을 모델이 한 번 더 갈아치운다.
  const nameIsMachine = String(proj.name_source || "human") === "rule";
  emit(
    `[라이블리 — 프로젝트 정련 안내(세션당 1회)]\n` +
    `이 세션이 붙은 **프로젝트 #${pid} «${nm.length > 60 ? nm.slice(0, 59).trimEnd() + "…" : nm}»** 는 세션 첫 지시에서 자동 생성된 **임시 껍데기**입니다 ` +
    `(${nameIsMachine ? "제목이 아직 지시문을 자른 기계값이고 " : ""}분류·관계·지식이 비어 있습니다). 지금 본격적인 작업이 시작되니, **지금까지 알게 된 것으로 이 프로젝트를 정련하세요**:\n` +
    (nameIsMachine ? `  ① 제목 — 무엇을 하는 일인지 드러나게: \`project_update_v6 {id: ${pid}, name: "…"}\`\n` : "") +
    `  ② 소속 리스트(영역) — \`project_list_index_v6\` 로 목록을 보고: \`project_set_list_v6 {id: ${pid}, list_id: <id>}\`\n` +
    `  ③ 선행·후속 — 이 일이 기존 프로젝트의 후속이면: \`project_link_project_v6 {id: ${pid}, to: <선행 id>}\` (후보는 검색이 아니라 **대화에서 사람이 언급한 것·직전에 하던 일**에서 찾고, 애매하면 사람에게 물어보세요)\n` +
    `  ④ 필요·산출지식 — \`project_recommend_knowledge_v6 {id: ${pid}}\` 로 확인해 \`project_link_knowledge_v6(required)\`, 이 세션이 만드는 지식은 끝나기 전 \`produced\` 로\n` +
    `  ⑤ 본문 — 목표·범위를 \`project_update_v6 {id: ${pid}, append_description: "…"}\` 로 보탭니다(**첫 지시 원문은 지우지 마세요** — append 는 원문을 보존합니다)\n` +
    moveHint(pid) +
    "지금 호출하려던 툴은 그대로 진행하면 됩니다(이 안내는 아무것도 막지 않습니다).");
})().then(() => process.exit(0)).catch(() => process.exit(0));

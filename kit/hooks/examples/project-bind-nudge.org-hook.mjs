// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=PreToolUse, harness=claude) — 관리탭 ▸ 커스텀 훅으로 등록.
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 세션 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: **프로젝트에 안 붙은 세션**이 처음으로 '남는 것을 만드는 툴'(라이블리 쓰기 · 파일 편집)을 부르기
//   직전, 딱 한 번 붙잡아 ① 미연결 사실 ② **새 프로젝트를 만들어 붙이라는 기본 동작** ③ 만들 때 반드시
//   챙길 것(소속 리스트 · 선행-후속 엣지 · 필요/산출지식)을 알린다.
//  왜 이 시점인가: 세션 시작 때는 무슨 일을 할지 아직 모른다. 첫 쓰기 직전이면 대화에 맥락이 쌓여 있고,
//   아직 아무것도 남기지 않아 늦지 않았다.
//  ★ 기본 = 새 프로젝트 생성(#1798, 2026-08-19 발의 윤상민) — 종전(#1762)의 임베딩 유사 후보 제시는 제거했다.
//   실측 근거: 유사도 매칭이 오연결을 유도했고(홈 자동매칭이 이 결정 세션 자체를 무관한 #521 에 붙였다),
//   후보 검토가 세션 맥락을 낭비했다. 기존 프로젝트에 붙이는 건 이제 두 경우뿐 —
//   · 0층 결정론 — 지금 호출하려는 툴 입력이 프로젝트를 가리키면(task_create_v6.projectId ·
//     activity_log.project_id · 파일 경로의 project/<id>/ 슬롯) 그 프로젝트가 곧 답이다(신호가 입력에 있다).
//   · 사람 지목 — 사람이 대화에서 특정 프로젝트를 직접 가리켰을 때.
//   그 외엔 임베딩·검색 호출 없이(맥락·비용 0) 새 프로젝트 생성을 안내한다.
//  불변식:
//   · **절대 막지 않는다** — permissionDecision 을 내지 않는다(additionalContext 만). 미연결로 일하는 정당한
//     경우(임시 실험·읽기 전용)를 막으면 안 된다. 어떤 실패든 무출력 exit 0.
//   · **세션당 1회** — tmp 플래그를 O_EXCL 로 원자 생성(병렬 툴콜 대비). 안내는 항상 나가고 항상 소모한다.
//   · **네트워크 무의존** — 게이트웨이 API 를 부르지 않는다(종전 /projects/similar 호출 제거). 판단 재료는
//     stdin(tool_name·tool_input·cwd)뿐이다.
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const FLAG_DIR = path.join(os.tmpdir(), "lively-hooks");   // work-flag.mjs·stop-writeback-gate 와 같은 per-user tmp
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const readStdin = () => new Promise((resolve) => {
  let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
  try {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); });
    process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 600);
  } catch { fin(); }
});

// cwd 에서 위로 올라가며 .lively/project.json 을 찾는다 — 세션 폴더 마커(kind:"session")든 프로젝트 폴더 마커든
//  하나라도 있으면 이 세션은 이미 프로젝트 안이다(CLI·훅이 쓰는 그 탐색과 같은 계약).
function boundToProject(startDir) {
  let dir = startDir;
  for (let i = 0; i < 40; i++) {
    try { if (fs.existsSync(path.join(dir, ".lively", "project.json"))) return true; } catch { /* 권한 등 → 계속 */ }
    const up = path.dirname(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return false;
}

// ── 0층 결정론: 지금 호출하려는 툴 입력에서 프로젝트 id 를 뽑는다(유일하게 믿을 수 있는 기존-프로젝트 신호). ──
//  · task_create_v6 → projectId · activity_log → project_id (그 프로젝트에 남기려면서 세션은 미연결인 상황)
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
  const boxId = (process.env.LIVELY_SESSION_ID || "").trim();
  if (!boxId || !SID_RE.test(boxId)) return;      // 라이블리 세션이 아니다(붙일 대상 자체가 없다) → 조용히 끝

  const stdinData = await readStdin();
  let input = {}; try { input = JSON.parse(stdinData || "{}"); } catch { return; }
  const cwd = String(input.cwd || process.cwd() || "");
  if (!cwd) return;
  if (boundToProject(cwd)) return;                // 이미 프로젝트 안 → 할 말 없음

  // 세션당 1회 — 이미 나갔으면 끝.
  const flag = path.join(FLAG_DIR, `${boxId}.projbind`);
  try { if (fs.existsSync(flag)) return; } catch { return; }

  // 0층 — 지금 호출하려는 툴 입력이 프로젝트를 가리키는가(결정론·유일한 기존-프로젝트 신호).
  const detId = projectIdFromToolInput(input.tool_name, input.tool_input);

  // 여기서 1회 소모(원자적) — 병렬 툴콜이 동시에 들어와도 한 번만 나간다.
  try { fs.mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(flag, "", { flag: "wx" }); }
  catch { return; }                                // 이미 누가 만들었다 → 중복 안내 안 함

  // 붙이기 = MCP `session_set_project`(#1798 후속 — session_id 생략 시 이 요청의 세션 자신). REST 는 폴백으로만 언급.
  const body = detId != null
    // 결정론 신호 — 툴 입력이 이미 특정 프로젝트를 가리킨다. 이때만 기존 프로젝트 연결을 안내한다.
    ? `지금 호출하려는 툴 입력이 **프로젝트 #${detId}** 를 가리킵니다(결정론 신호 — 그 프로젝트에 남기면서 세션은 미연결). 이 세션을 그 프로젝트에 붙이세요: \`session_set_project {project_id: ${detId}}\` (lively MCP — session_id 는 생략, 이 세션 자신).\n`
      + `지금 하는 일이 #${detId} 소속이 아니라 새로운 일이면 새 프로젝트를 만들어 붙이세요 — \`project_create_v6\`(\`list_id\` 필수 · 선행 프로젝트가 있으면 \`follow_up\`) 로 만들고, 필요·산출지식을 \`project_link_knowledge_v6\` 로 이은 뒤 \`session_set_project {project_id: <새 id>}\` 로 붙입니다.\n`
    // 기본 — 새 프로젝트 생성. 기존 프로젝트 검색·유사도 매칭은 하지 않는다(오연결·맥락 낭비 실측).
    : "**기본 동작은 새 프로젝트 생성입니다.** 기존 프로젝트를 검색해 골라 붙이려 하지 마세요 — 유사도 매칭은 오연결이 잦고 후보 검토로 맥락만 낭비합니다. 기존 프로젝트에 붙이는 건 사람이 그 프로젝트를 직접 지목했을 때만 하세요.\n"
      + "`project_create_v6` 로 새 프로젝트를 만들되, 다음 세 가지를 반드시 함께 챙기세요:\n"
      + "  ① **소속 리스트** — `project_list_index_v6` 로 리스트(영역) 목록을 보고 이 일이 속한 리스트의 `list_id` 로 만듭니다(`list_id` 는 필수입니다).\n"
      + "  ② **선행·후속 관계** — 이 일이 기존 프로젝트의 후속이면 생성 시 `follow_up=<선행 프로젝트 id>` 를 주거나, 만든 뒤 `project_link_project_v6(id=새 프로젝트, to=선행)` 로 잇습니다. 선행 후보는 검색이 아니라 **대화에서 사람이 언급한 프로젝트·직전에 하던 일**에서 찾고, 애매하면 사람에게 물어보세요.\n"
      + "  ③ **필요·산출지식** — 생성 응답의 `prior_art` 와 `project_recommend_knowledge_v6` 로 관련 지식을 확인해 `project_link_knowledge_v6(required)` 로 잇고, 이 세션이 만드는 지식은 세션이 끝나기 전 `produced` 로 잇습니다.\n"
      + "만든 뒤 이 세션을 붙입니다: `session_set_project {project_id: <새 프로젝트 id>}` (lively MCP — session_id 는 생략, 이 세션 자신. MCP 가 안 되면 REST `POST /api/ui/terminal/sessions/" + boxId + "/project {\"projectId\":<id>}`).\n";

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        "[이 세션은 라이블리 프로젝트에 안 붙어 있습니다 — 세션당 1회 안내]\n" +
        "지금 무언가를 남기려 합니다. 미연결 상태로 남기면 그 지식·작업기록·산출물이 **어느 프로젝트에도 귀속되지 않습니다**.\n" +
        body +
        "⚠ 붙인 직후 `AGENTS.md` 와 `project/AGENTS.md` 를 **직접 읽으세요** — 실행 중 세션은 CLAUDE.md 를 다시 읽지 않아, 파일은 바뀌어도 당신의 맥락엔 안 들어옵니다.\n" +
        "판단이 서지 않으면 사람에게 물어보세요. 지금 호출하려던 툴은 그대로 진행하면 됩니다(이 안내는 아무것도 막지 않습니다).",
    },
  }) + "\n");
})().then(() => process.exit(0)).catch(() => process.exit(0));

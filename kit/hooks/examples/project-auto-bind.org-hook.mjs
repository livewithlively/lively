// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=UserPromptSubmit, harness=all) — 관리탭 ▸ 커스텀 훅으로 등록.
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 세션 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행하고,
//   **stdout 을 그대로 additionalContext 로 주입**한다(SessionStart 와 동형 — knowledge-recall 과 같은 계약).
//
//  하는 일: **프로젝트에 안 붙은 세션의 첫 실질 지시**에서 프로젝트를 기계적으로 만들고 이 세션을 붙인다.
//   제목·본문은 그 지시문에서 만든 임시값이고, 정련(제목 교정·리스트·선행후속·필요/산출지식)은 첫 쓰기 시점의
//   project-bind-nudge(PreToolUse)가 맡는다. 여기서는 **귀속을 먼저 세우는 것**만 한다.
//
//  왜 권고가 아니라 기계인가 (#1824, 발의 윤상민 2026-08-20):
//   #1798 에서 "미연결이면 새 프로젝트를 만들어 붙여라"를 훅으로 **권고**했지만, 권고는 모델이 안 따르면 그만이라
//   미연결 세션이 계속 쌓였다. 귀속은 매번 내리는 판단이 아니라 **기본값**이어야 한다 — 그래서 훅이 직접 만든다.
//   잘못 만든 껍데기는 정련·이관으로 싸게 되돌지만, 안 만들어진 귀속은 아무도 나중에 복원하지 못한다.
//
//  ⚠ 빈 껍데기 자동 삭제(GC)는 **의도적으로 두지 않는다**(#1824 판단, 상민님 지적):
//   껍데기에는 **정의상 항상 세션이 붙어 있다**(그 세션의 첫 지시로 만들어진 것이므로). 그래서 "살아 있는 세션이
//   붙어 있으면 보호"라는 안전조건을 넣으면 아무것도 못 지우고, 빼려면 '마지막 활동 N일' 같은 **임의 임계**를
//   만들어야 한다 — 근거가 아니라 취향이 되는 자리다. 게다가 껍데기는 비어 보여도 **첫 지시 원문**을 담고 있어
//   정보가치가 0이 아니고, 되돌릴 수 없는 삭제는 맥락을 아는 사람이 하는 것이 이 제품의 원칙이다.
//   → 안 쓰는 껍데기는 보드에서 사람이 지운다(휴지통·복원 가능). 실제로 쌓이는 것이 관측되면 그때 '정리 큐'를
//     사람이 보는 화면으로 만든다.
//
//  왜 UserPromptSubmit 인가 (SessionStart 도, 서버측 선생성도 아니고):
//   · SessionStart 엔 프롬프트가 없다 — 제목·본문을 뽑을 재료가 없다.
//   · **홈 입력창 세션도 이 훅을 탄다.** 홈의 첫 지시는 서버가 send-keys 로 하네스 입력창에 넣고 Enter 를 누르므로
//     (session-first-prompt.ts) 사람 타이핑과 같은 경로다. 2026-08-20 실측 — 홈에서 연 세션(box-yoon-10979a32)의
//     첫 프롬프트에 knowledge-recall(UserPromptSubmit) 주입이 실제로 붙어 있었다. → 서버측 분기가 필요 없다.
//   · **AGENTS.md 주입 경합이 없다.** additionalContext 는 **같은 턴에** 모델에 실리므로 생성→바인딩→고지가 한 턴에
//     끝난다. "실행 중 하네스는 CLAUDE.md 를 다시 안 읽는다"(#1762)를 우회할 일 자체가 생기지 않는다.
//   · **하네스 무관.** stdin JSON 의 prompt 를 그대로 쓴다(트랜스크립트 파싱 없음) → harness=all.
//
//  불변식:
//   · **절대 막지 않는다** — 어떤 실패든 무출력 exit 0. 프롬프트는 그대로 하네스로 간다.
//   · **읽기전용·인코그니토 세션엔 아무것도 만들지 않는다**(LIVELY_MODE=readonly / LIVELY_OFF=1).
//   · **세션당 1회** — tmp 플래그를 O_EXCL 로 원자 생성. 단 **실패하면 플래그를 되돌린다**(다음 프롬프트에 재시도).
//   · 짧은 지시·슬래시커맨드는 **플래그를 소모하지 않고 미룬다** — UserPromptSubmit 은 매 프롬프트마다 오므로
//     다음 기회가 실제로 온다(#1762 의 "다음 기회가 영영 안 온다"는 PreToolUse 라서 생긴 함정이다).
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// #1750 — 세션 소속 신호: 게이트웨이가 x-lively-session(→ 세션 정본 gw_session_map)·x-lively-workspace 로
//  이 세션의 워크스페이스 컨텍스트를 되찾는다. 안 실으면 primary 로 간주되므로(폴백) secondary 세션의
//  훅 호출이 조용히 primary 데이터를 읽고 쓴다.
const SCOPE_HDRS = {
  ...(String(process.env.LIVELY_SESSION_ID || "").trim() ? { "x-lively-session": String(process.env.LIVELY_SESSION_ID).trim() } : {}),
  ...(String(process.env.LVLY_TENANT_SLUG || "").trim() ? { "x-lively-workspace": String(process.env.LVLY_TENANT_SLUG).trim() } : {}),
};

const FLAG_DIR = path.join(os.tmpdir(), "lively-hooks");   // work-flag.mjs·stop-writeback-gate 와 같은 per-user tmp
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIN_PROMPT_CHARS = 12;   // 이보다 짧은 지시는 제목이 될 수 없다("ㄱㄱ"·"응"·"계속") → 미룬다(플래그 미소모)
const MAX_TITLE = 70;          // 프로젝트 이름 상한(스키마는 200 — 목록에서 읽히는 길이로 더 좁게 자른다)
const MAX_BODY = 3500;         // description 은 스키마 4000 — 머리말·마커 자리를 빼고 지시문에 이만큼 준다
const FETCH_MS = 5000;         // UserPromptSubmit 은 사람 입력을 지연시킨다 — 짧게 끊는다
// 자동 생성 표식 — 기계(정련 훅·GC)가 "이건 아직 임시 껍데기"를 판별하는 유일한 근거. 문자열을 바꾸면 그 둘도 함께 바꿔야 한다.
const AUTO_MARK = "<!-- lively:auto-created-from-first-prompt -->";

const readStdin = () => new Promise((resolve) => {
  let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
  try {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); });
    process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 600);
  } catch { fin(); }
});

/** cwd 에서 위로 올라가며 .lively/project.json 을 찾는다 — 세션 폴더 마커(kind:"session")든 프로젝트 폴더 마커든
 *  하나라도 있으면 이 세션은 이미 프로젝트 안이다(CLI·훅이 쓰는 그 탐색과 같은 계약). */
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

/** 지시문 → 한 줄 제목. 첫 비어있지 않은 줄을 공백 정규화해 자른다(LLM 호출 없는 결정론 — 교정은 정련 훅의 몫). */
function titleFrom(prompt) {
  const first = prompt.split(/\r?\n/).map((s) => s.trim()).find((s) => s) || prompt.trim();
  const t = first.replace(/\s+/g, " ").trim();
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1).trimEnd() + "…" : t;
}

const post = async (base, token, url, body) => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const res = await fetch(base + url, {
      method: "POST", signal: ctl.signal,
      headers: { authorization: "Bearer " + token, "content-type": "application/json", ...SCOPE_HDRS },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
};

(async () => {
  if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") return;   // 인코그니토 — 아무것도 안 남긴다
  if ((process.env.LIVELY_MODE || "").trim().toLowerCase() === "readonly") return;      // 읽기전용 세션 — 쓰기 금지(#1007)
  const boxId = (process.env.LIVELY_SESSION_ID || "").trim();
  if (!boxId || !SID_RE.test(boxId)) return;      // 라이블리 세션이 아니다(붙일 대상 자체가 없다) → 조용히 끝

  const stdinData = await readStdin();
  let input = {}; try { input = JSON.parse(stdinData || "{}"); } catch { return; }
  const cwd = String(input.cwd || process.cwd() || "");
  if (!cwd || boundToProject(cwd)) return;        // 이미 프로젝트 안 → 할 일 없음

  // 세션당 1회 — 이미 만들었으면 끝.
  const flag = path.join(FLAG_DIR, `${boxId}.projauto`);
  try { if (fs.existsSync(flag)) return; } catch { return; }

  const prompt = String(input.prompt || "").trim();
  // 미룸(플래그 미소모) — 다음 프롬프트에 다시 본다. 슬래시·뱅 커맨드와 하네스 주입물은 사람의 지시가 아니다.
  if (!prompt || prompt.length < MIN_PROMPT_CHARS) return;
  if (prompt.startsWith("/") || prompt.startsWith("!") || prompt.startsWith("<")) return;

  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");

  // 여기서 1회 소모(원자적) — 같은 순간 다른 프롬프트가 겹쳐도 한 번만 만든다.
  try { fs.mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(flag, "", { flag: "wx" }); }
  catch { return; }                                // 이미 누가 만들었다 → 중복 생성 안 함
  // 이후 어떤 실패든 플래그를 되돌린다 — 안 그러면 이 세션은 영영 미연결로 남는다(네트워크 순간 장애로도).
  const undo = () => { try { fs.unlinkSync(flag); } catch { /* 이미 없음 */ } };

  const title = titleFrom(prompt);
  const description = [
    "> ⚙ 세션의 첫 지시에서 **자동 생성**된 프로젝트입니다 — 제목·본문·분류는 작업이 구체화되면 보강됩니다.",
    "",
    "## 첫 지시(원문)",
    "",
    prompt.length > MAX_BODY ? prompt.slice(0, MAX_BODY) + "\n\n…(이하 생략)" : prompt,
    "",
    AUTO_MARK,
  ].join("\n");

  // 리스트(영역)는 일부러 비운다 — 무엇을 하는 일인지가 아직 한 줄 지시뿐이라 여기서 고르면 오분류가 된다.
  //  분류는 맥락이 쌓인 첫 쓰기 시점(project-bind-nudge)이 정한다.
  const created = await post(base, token, "/api/ui/v6/projects", { name: title, description });
  const pid = Number(created && created.project && created.project.id);
  if (!Number.isInteger(pid) || pid <= 0) { undo(); return; }

  const bound = await post(base, token, `/api/ui/terminal/sessions/${encodeURIComponent(boxId)}/project`, { projectId: pid });
  if (!bound || bound.ok !== true) {
    // 붙이지 못했으면 방금 만든 것을 **되돌린다**(보상 트랜잭션) — 자동 삭제 장치가 없는 설계라, 여기서 안 거두면
    //  누구도 안 쓰는 고아 프로젝트가 영구히 남는다. 지우는 대상은 방금 내가 만든 빈 프로젝트뿐이고,
    //  삭제는 감사 스냅샷을 남겨 휴지통에서 복원된다. 실패해도(권한·네트워크) 무시 — 플래그는 어차피 되돌린다.
    await post(base, token, `/api/ui/v6/projects/${pid}/delete`, {});
    undo();
    return;
  }

  process.stdout.write(
    `[라이블리] 이 세션은 프로젝트에 안 붙어 있어서, 방금 지시로 **프로젝트 #${pid}** 를 만들고 이 세션을 붙였습니다 — ` +
    `여기서 남기는 지식·작업기록·산출물이 #${pid} 에 귀속됩니다.\n` +
    "제목·본문은 지시문에서 기계적으로 만든 임시값이고 분류(리스트)는 아직 비어 있습니다 — 본격적인 작업이 시작될 때 " +
    "정련 안내가 한 번 더 나갑니다. 지금은 **요청받은 일을 그대로 진행하세요**(이 안내 때문에 하던 일을 바꾸지 마세요).\n"
  );
})().then(() => process.exit(0)).catch(() => process.exit(0));

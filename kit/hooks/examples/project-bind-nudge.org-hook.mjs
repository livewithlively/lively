// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=PreToolUse, harness=claude) — 관리탭 ▸ 커스텀 훅으로 등록.
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 세션 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: **프로젝트에 안 붙은 세션**이 처음으로 '남는 것을 만드는 툴'(라이블리 쓰기 · 파일 편집)을 부르기
//   직전, 딱 한 번 붙잡아 ① 미연결 사실 ② 지금까지의 대화와 의미적으로 가까운 프로젝트 후보 ③ 붙이는 방법을 알린다.
//  왜 이 시점인가: 세션 시작 때는 무슨 일을 할지 아직 모른다(후보를 못 고른다). 첫 쓰기 직전이면 대화에 맥락이
//   쌓여 있고, 아직 아무것도 남기지 않아 늦지 않았다.
//  후보 신호 3층(#1762 후속 — 2026-08-19 미발동 실측 box-yoon-f57dbbb0):
//   0층 결정론 — **지금 호출하려는 툴 입력이 프로젝트를 가리키면** 그게 곧 후보다(task_create_v6.projectId ·
//        activity_log.project_id · 파일 경로의 project/<id>/ 슬롯). 임베딩 호출 자체를 생략한다(맥락·비용 0).
//        실측: 미발동 세션의 첫 매처 호출이 task_create_v6{projectId:1719} 였다 — 신호가 입력에 그대로 있었다.
//   1층 질의 보강 — 사람 발화가 짧아도(한 줄 지시로 완주하는 자율 세션) tool_input 의 텍스트(태스크 이름·설명·
//        지식 제목·본문 앞부분)와 어시스턴트 초반 발화를 질의에 보탠다. 종전엔 발화 23자 < 40 게이트로
//        세션 내내 침묵했다(가장 흔한 홈-입력창 세션이 정확히 이 모양).
//   2층 폴백 — 그래도 질의가 짧으면 후보 없이 **미연결 사실만** 알린다(안내는 항상 세션당 1회 나간다 —
//        종전의 '40자 미만이면 다음 기회'는 그 다음 기회가 영영 안 와 안내 자체가 죽었다).
//  불변식:
//   · **절대 막지 않는다** — permissionDecision 을 내지 않는다(additionalContext 만). 미연결로 일하는 정당한
//     경우(임시 실험·읽기 전용)를 막으면 안 된다. 어떤 실패든 무출력 exit 0.
//   · **세션당 1회** — tmp 플래그를 O_EXCL 로 원자 생성(병렬 툴콜 대비). 안내는 항상 나가고 항상 소모한다
//     (맥락이 짧으면 후보만 생략 — 위 2층).
//   · **후보는 절대 유사도로만** — /api/ui/v6/projects/similar(min_score)는 코사인 유사도라 "관련 없으면 빈 결과"가
//     성립한다. project_search 의 RRF 점수(순위 역수)로는 무관해도 상위 N 이 늘 나와 오연결을 유도한다(#1762 실측).
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// #1750 — 세션 소속 신호: 게이트웨이가 x-lively-session(→ 세션 정본 gw_session_map)·x-lively-workspace 로
//  이 세션의 워크스페이스 컨텍스트를 되찾는다. 안 실으면 primary 로 간주되므로(폴백) secondary 세션의
//  훅 호출이 조용히 primary 데이터를 읽고 쓴다 — dev '다온' 실측이 정확히 그 사고다.
const SCOPE_HDRS = {
  ...(String(process.env.LIVELY_SESSION_ID || "").trim() ? { "x-lively-session": String(process.env.LIVELY_SESSION_ID).trim() } : {}),
  ...(String(process.env.LVLY_TENANT_SLUG || "").trim() ? { "x-lively-workspace": String(process.env.LVLY_TENANT_SLUG).trim() } : {}),
};


const MIN_SCORE = 0.55;        // 이 코사인 유사도 이상만 후보로 — #1762 실측 캘리브레이션(2026-08-18, bge-m3):
//   정답 프로젝트 0.79 · 인접하지만 붙일 곳은 아닌 것 0.63~0.64 · **완전 무관 질의의 최고점 0.508**(짧은 제목
//   프로젝트가 아무 데나 잘 붙는다) · 무관 대부분 0.38~0.43. 0.55 = 무관 최고점 위 + 정답·인접은 통과.
const LIMIT = 5;               // 후보 최대 건수
const REL_CUT = 0.85;          // 1위 대비 이 비율 미만은 버린다 — 절대 임계를 넘겨도 1위와 뚜렷이 벌어지면 그건
//   '인접 주제'지 붙일 곳이 아니다(실측: 정답 0.79 vs 인접 0.65~0.66 — 갭이 크다). 후보가 고만고만하면
//   비율 컷에 다 걸리지 않아 여럿 그대로 남는다(진짜 애매한 경우엔 사람이 고르도록).
const MIN_CTX_CHARS = 40;      // 이보다 질의가 짧으면 **후보 검색만** 생략(임베딩이 불안정해 무관 매칭이 임계를 넘는다) — 안내는 나간다
const MAX_QUERY_CHARS = 2000;  // 임베딩에 보낼 최대 길이
const MAX_USER_MSGS = 8;       // 트랜스크립트에서 볼 유저 발화 수(초반이 주제를 가장 잘 말한다)
const MAX_ASSIST_MSGS = 3;     // 함께 볼 어시스턴트 발화 수(각 300자 컷) — 한 줄 지시 세션의 질의 보강용
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const FETCH_MS = 4000;
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

// Claude Code 트랜스크립트(JSONL)에서 발화를 뽑는다. tool_result 도 type:"user" 로 들어오므로
//  content 배열에서 text 파트만 취한다(안 그러면 툴 출력이 질의를 오염시킨다).
//  어시스턴트 초반 발화도 함께 — 한 줄 지시 세션에선 AI 의 첫 응답("~작업을 시작합니다")이 주제를 제일 잘 말한다.
function userPromptsFrom(transcriptPath) {
  try {
    const st = fs.statSync(transcriptPath);
    let raw;
    if (st.size > MAX_TRANSCRIPT_BYTES) {
      const fd = fs.openSync(transcriptPath, "r");
      const buf = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
      fs.readSync(fd, buf, 0, MAX_TRANSCRIPT_BYTES, 0); fs.closeSync(fd);
      raw = buf.toString("utf8");
    } else raw = fs.readFileSync(transcriptPath, "utf8");
    const users = []; const assistants = [];
    for (const line of raw.split("\n")) {
      if (users.length >= MAX_USER_MSGS && assistants.length >= MAX_ASSIST_MSGS) break;
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const c = o.message && o.message.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
      text = String(text || "").trim();
      if (!text) continue;
      if (o.type === "assistant" && assistants.length < MAX_ASSIST_MSGS) { assistants.push(text.slice(0, 300)); continue; }
      if (o.type !== "user" || o.isMeta || users.length >= MAX_USER_MSGS) continue;
      if (text.startsWith("/") || text.startsWith("!")) continue;          // 슬래시·뱅 커맨드
      if (text.startsWith("<") || text.includes("<system-reminder>")) continue; // 하네스 주입물
      users.push(text);
    }
    return { users, assistants };
  } catch { return { users: [], assistants: [] }; }
}

// ── 0층: 지금 호출하려는 툴 입력에서 프로젝트 id 를 결정론으로 뽑는다(임베딩 불요·최강 신호). ──
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

// ── 1층: 질의 보강 — tool_input 의 사람이 읽는 산문 필드(태스크 이름·설명, 지식 제목·본문 앞부분 등)만. ──
//  ⚠ file_path 는 넣지 않는다 — 절대경로(긴 tmp 경로)가 혼자 40자 게이트를 넘겨 무관 후보를 물어온다
//   (실측: 경로만으로 질의가 서자 임계 위 57% 무관 매칭). 경로는 0층 슬롯 판정에만 쓴다.
function toolInputText(ti) {
  if (!ti || typeof ti !== "object") return "";
  const KEYS = ["name", "title", "summary", "description", "body_md", "body"];
  const parts = [];
  for (const k of KEYS) { const v = ti[k]; if (typeof v === "string" && v.trim()) parts.push(v.trim().slice(0, 400)); }
  return parts.join("\n");
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

  // 세션당 1회 — 이미 나갔으면 끝. 소모(원자 생성)는 안내 직전에 한다(아래) — 병렬 툴콜 대비.
  const flag = path.join(FLAG_DIR, `${boxId}.projbind`);
  try { if (fs.existsSync(flag)) return; } catch { return; }

  // 0층 — 지금 호출하려는 툴 입력이 프로젝트를 가리키는가(결정론·최강). 있으면 임베딩 검색 자체를 생략한다.
  const detId = projectIdFromToolInput(input.tool_name, input.tool_input);

  // 1층 — 질의: 사람 발화 + 지금 남기려는 것의 텍스트(tool_input) + 어시스턴트 초반 발화. 발화 한 줄로 완주하는
  //  자율 세션(실측 23자)에서도 질의가 서게 한다. 순서 = 신호 강한 것부터(뒤는 2000자 컷에 먼저 잘린다).
  const tr = userPromptsFrom(String(input.transcript_path || ""));
  const query = [...tr.users, toolInputText(input.tool_input), ...tr.assistants]
    .filter(Boolean).join("\n\n").slice(0, MAX_QUERY_CHARS).trim();

  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");

  // 후보 회수 — 절대 코사인 게이팅. 0층이 잡혔으면 생략(결정론 신호가 있는데 임베딩을 또 돌릴 이유가 없다).
  //  질의가 아직 짧아도 생략(짧은 질의는 임베딩이 불안정해 무관 매칭이 임계를 넘는다) — 안내는 어느 쪽이든 나간다.
  let cands = [];
  if (detId == null && query.length >= MIN_CTX_CHARS) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
    try {
      const qs = new URLSearchParams({ text: query, level: "project", min_score: String(MIN_SCORE), limit: String(LIMIT) });
      const res = await fetch(`${base}/api/ui/v6/projects/similar?${qs}`, { signal: ctl.signal, headers: { authorization: "Bearer " + token, ...SCOPE_HDRS } });
      if (res.ok) { const j = await res.json(); cands = Array.isArray(j && j.projects) ? j.projects : []; }
    } catch { /* 네트워크·임베딩 off → 후보 없이 진행 */ }
    finally { clearTimeout(t); }
    // 상대 컷 — 1위와 뚜렷이 벌어진 꼬리를 자른다(위 REL_CUT 주석 참조). 응답은 유사도 내림차순이다.
    if (cands.length) {
      const top = Number(cands[0].similarity) || 0;
      cands = cands.filter((p) => (Number(p.similarity) || 0) >= top * REL_CUT);
    }
  }

  // 여기서 1회 소모(원자적) — 병렬 툴콜이 동시에 들어와도 한 번만 나간다.
  try { fs.mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(flag, "", { flag: "wx" }); }
  catch { return; }                                // 이미 누가 만들었다 → 중복 안내 안 함

  const lines = cands.map((p) => {
    const pct = Math.round((Number(p.similarity) || 0) * 100);
    const snip = String(p.snippet || "").replace(/\s+/g, " ").trim().slice(0, 110);
    return `- #${p.id} «${p.name}» · 유사도 ${pct}%` + (snip ? `\n  ${snip}` : "");
  });
  const candBlock = detId != null
    ? `지금 호출하려는 툴 입력이 **프로젝트 #${detId}** 를 가리킵니다(결정론 신호 — 그 프로젝트에 남기면서 세션은 미연결). 그 프로젝트가 곧 후보입니다.\n`
    : lines.length
      ? "지금까지의 대화와 의미적으로 가까운 진행 중 프로젝트(코사인 유사도):\n" + lines.join("\n") + "\n"
      : query.length < MIN_CTX_CHARS
        ? "대화가 아직 짧아 후보는 못 골랐습니다 — `project_search` 로 직접 찾거나 사람에게 물어보세요.\n"
        : "지금까지의 대화와 의미적으로 가까운 진행 중 프로젝트는 없습니다(임계 미달) — 새로 만드는 쪽이 맞을 수 있습니다.\n";
  const bindCmd = `curl -s -X POST "$(cat ~/.lively/gateway-url)/api/ui/terminal/sessions/${boxId}/project" `
    + `-H "authorization: Bearer $(cat ~/.lively/token)" -H "content-type: application/json" -d '{"projectId":<ID>}'`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        "[이 세션은 라이블리 프로젝트에 안 붙어 있습니다 — 세션당 1회 안내]\n" +
        "지금 무언가를 남기려 합니다. 미연결 상태로 남기면 그 지식·작업기록·산출물이 **어느 프로젝트에도 귀속되지 않습니다**.\n" +
        candBlock +
        (detId != null || lines.length
          ? "\n지금 하는 일이 위 중 하나에 속하는지 판단하고, **사람에게 확인받은 뒤** 붙이세요:\n"
          : "\n붙일 프로젝트를 정해 **사람에게 확인받은 뒤** 붙이세요:\n") +
        `  ${bindCmd}\n` +
        "맞는 것이 없으면 `project_create_v6`(리스트 id 는 `project_list_index_v6`)로 만들고 같은 방법으로 붙입니다.\n" +
        "⚠ 붙인 직후 `AGENTS.md` 와 `project/AGENTS.md` 를 **직접 읽으세요** — 실행 중 세션은 CLAUDE.md 를 다시 읽지 않아, 파일은 바뀌어도 당신의 맥락엔 안 들어옵니다.\n" +
        "판단이 서지 않으면 사람에게 물어보세요. 지금 호출하려던 툴은 그대로 진행하면 됩니다(이 안내는 아무것도 막지 않습니다).",
    },
  }) + "\n");
})().then(() => process.exit(0)).catch(() => process.exit(0));

// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=PreToolUse, harness=claude) — 관리탭 ▸ 커스텀 훅으로 등록.
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 세션 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: **프로젝트에 안 붙은 세션**이 처음으로 '남는 것을 만드는 툴'(라이블리 쓰기 · 파일 편집)을 부르기
//   직전, 딱 한 번 붙잡아 ① 미연결 사실 ② 지금까지의 대화와 의미적으로 가까운 프로젝트 후보 ③ 붙이는 방법을 알린다.
//  왜 이 시점인가: 세션 시작 때는 무슨 일을 할지 아직 모른다(후보를 못 고른다). 첫 쓰기 직전이면 대화에 맥락이
//   쌓여 있고, 아직 아무것도 남기지 않아 늦지 않았다.
//  불변식:
//   · **절대 막지 않는다** — permissionDecision 을 내지 않는다(additionalContext 만). 미연결로 일하는 정당한
//     경우(임시 실험·읽기 전용)를 막으면 안 된다. 어떤 실패든 무출력 exit 0.
//   · **세션당 1회** — tmp 플래그를 O_EXCL 로 원자 생성(병렬 툴콜 대비). 맥락이 모자라 안내를 못 하면 플래그를
//     **소모하지 않는다**(다음 기회에 다시 본다).
//   · **후보는 절대 유사도로만** — /api/ui/v6/projects/similar(min_score)는 코사인 유사도라 "관련 없으면 빈 결과"가
//     성립한다. project_search 의 RRF 점수(순위 역수)로는 무관해도 상위 N 이 늘 나와 오연결을 유도한다(#1762 실측).
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MIN_SCORE = 0.55;        // 이 코사인 유사도 이상만 후보로 — #1762 실측 캘리브레이션(2026-08-18, bge-m3):
//   정답 프로젝트 0.79 · 인접하지만 붙일 곳은 아닌 것 0.63~0.64 · **완전 무관 질의의 최고점 0.508**(짧은 제목
//   프로젝트가 아무 데나 잘 붙는다) · 무관 대부분 0.38~0.43. 0.55 = 무관 최고점 위 + 정답·인접은 통과.
const LIMIT = 5;               // 후보 최대 건수
const REL_CUT = 0.85;          // 1위 대비 이 비율 미만은 버린다 — 절대 임계를 넘겨도 1위와 뚜렷이 벌어지면 그건
//   '인접 주제'지 붙일 곳이 아니다(실측: 정답 0.79 vs 인접 0.65~0.66 — 갭이 크다). 후보가 고만고만하면
//   비율 컷에 다 걸리지 않아 여럿 그대로 남는다(진짜 애매한 경우엔 사람이 고르도록).
const MIN_CTX_CHARS = 40;      // 이보다 대화 맥락이 짧으면 이번엔 넘긴다(플래그 미소모 — 아직 고를 근거가 없다)
const MAX_QUERY_CHARS = 2000;  // 임베딩에 보낼 최대 길이
const MAX_USER_MSGS = 8;       // 트랜스크립트에서 볼 유저 발화 수(초반이 주제를 가장 잘 말한다)
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

// Claude Code 트랜스크립트(JSONL)에서 **사람이 친 발화만** 뽑는다. tool_result 도 type:"user" 로 들어오므로
//  content 배열에서 text 파트만 취한다(안 그러면 툴 출력이 질의를 오염시킨다).
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
    const out = [];
    for (const line of raw.split("\n")) {
      if (out.length >= MAX_USER_MSGS) break;
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== "user" || o.isMeta) continue;
      const c = o.message && o.message.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
      text = String(text || "").trim();
      if (!text) continue;
      if (text.startsWith("/") || text.startsWith("!")) continue;          // 슬래시·뱅 커맨드
      if (text.startsWith("<") || text.includes("<system-reminder>")) continue; // 하네스 주입물
      out.push(text);
    }
    return out;
  } catch { return []; }
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

  // 세션당 1회 — 아직 소모하지 않는다(맥락이 모자라면 다음 기회에 다시 본다).
  const flag = path.join(FLAG_DIR, `${boxId}.projbind`);
  try { if (fs.existsSync(flag)) return; } catch { return; }

  const prompts = userPromptsFrom(String(input.transcript_path || ""));
  const query = prompts.join("\n\n").slice(0, MAX_QUERY_CHARS).trim();
  if (query.length < MIN_CTX_CHARS) return;       // 아직 고를 근거가 없다 → 플래그 미소모

  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");

  // 후보 회수 — 절대 코사인 게이팅. 실패·빈 결과여도 안내는 한다(미연결 사실 자체가 알릴 값이다).
  let cands = [];
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const qs = new URLSearchParams({ text: query, level: "project", min_score: String(MIN_SCORE), limit: String(LIMIT) });
    const res = await fetch(`${base}/api/ui/v6/projects/similar?${qs}`, { signal: ctl.signal, headers: { authorization: "Bearer " + token } });
    if (res.ok) { const j = await res.json(); cands = Array.isArray(j && j.projects) ? j.projects : []; }
  } catch { /* 네트워크·임베딩 off → 후보 없이 진행 */ }
  finally { clearTimeout(t); }
  // 상대 컷 — 1위와 뚜렷이 벌어진 꼬리를 자른다(위 REL_CUT 주석 참조). 응답은 유사도 내림차순이다.
  if (cands.length) {
    const top = Number(cands[0].similarity) || 0;
    cands = cands.filter((p) => (Number(p.similarity) || 0) >= top * REL_CUT);
  }

  // 여기서 1회 소모(원자적) — 병렬 툴콜이 동시에 들어와도 한 번만 나간다.
  try { fs.mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(flag, "", { flag: "wx" }); }
  catch { return; }                                // 이미 누가 만들었다 → 중복 안내 안 함

  const lines = cands.map((p) => {
    const pct = Math.round((Number(p.similarity) || 0) * 100);
    const snip = String(p.snippet || "").replace(/\s+/g, " ").trim().slice(0, 110);
    return `- #${p.id} «${p.name}» · 유사도 ${pct}%` + (snip ? `\n  ${snip}` : "");
  });
  const bindCmd = `curl -s -X POST "$(cat ~/.lively/gateway-url)/api/ui/terminal/sessions/${boxId}/project" `
    + `-H "authorization: Bearer $(cat ~/.lively/token)" -H "content-type: application/json" -d '{"projectId":<ID>}'`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        "[이 세션은 라이블리 프로젝트에 안 붙어 있습니다 — 세션당 1회 안내]\n" +
        "지금 무언가를 남기려 합니다. 미연결 상태로 남기면 그 지식·작업기록·산출물이 **어느 프로젝트에도 귀속되지 않습니다**.\n" +
        (lines.length
          ? "지금까지의 대화와 의미적으로 가까운 진행 중 프로젝트(코사인 유사도):\n" + lines.join("\n") + "\n"
          : "지금까지의 대화와 의미적으로 가까운 진행 중 프로젝트는 없습니다(임계 미달) — 새로 만드는 쪽이 맞을 수 있습니다.\n") +
        "\n지금 하는 일이 위 중 하나에 속하는지 판단하고, **사람에게 확인받은 뒤** 붙이세요:\n" +
        `  ${bindCmd}\n` +
        "맞는 것이 없으면 `project_create_v6`(리스트 id 는 `project_list_index_v6`)로 만들고 같은 방법으로 붙입니다.\n" +
        "⚠ 붙인 직후 `AGENTS.md` 와 `project/AGENTS.md` 를 **직접 읽으세요** — 실행 중 세션은 CLAUDE.md 를 다시 읽지 않아, 파일은 바뀌어도 당신의 맥락엔 안 들어옵니다.\n" +
        "판단이 서지 않으면 사람에게 물어보세요. 지금 호출하려던 툴은 그대로 진행하면 됩니다(이 안내는 아무것도 막지 않습니다).",
    },
  }) + "\n");
})().then(() => process.exit(0)).catch(() => process.exit(0));

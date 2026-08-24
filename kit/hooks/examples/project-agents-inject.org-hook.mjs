// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=UserPromptSubmit, harness=all) — 관리탭 ▸ 커스텀 훅으로 등록(#1856 B).
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 프롬프트마다 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행하고,
//   **stdout 을 그대로 additionalContext 로 주입**한다(knowledge-recall·project-auto-bind 와 같은 계약).
//
//  하는 일: 이 세션이 속한 프로젝트의 **AGENTS.md 전문**을 실행 중 세션에 주입한다.
//
//  왜 파일(셔틀)로는 안 되나 — 두 가지가 각각 막는다:
//   ① **시간** — Claude Code 는 CLAUDE.md 를 시작 때 한 번 읽는다. 세션 도중 프로젝트에 붙거나 다른
//      프로젝트로 옮기면 셔틀 파일을 다시 써도 도는 하네스엔 닿지 않는다(#1762). 그리고 홈 입력창 세션은
//      **첫 지시에서** project-auto-bind 가 프로젝트를 만들어 붙이므로, 정확히 이 케이스가 기본 경로다.
//   ② **공간** — 프로젝트 폴더가 그 머신에 아직 없을 수 있다. #1856 A 가 폴더 확보를 고쳤지만, 그건
//      '다음 세션'을 위한 것이다. 지금 도는 세션은 여전히 못 읽는다.
//  → 그래서 서버가 전문을 실어 보내 additionalContext 로 넣는다. 파일 경로와 무관하게 성립한다.
//
//  왜 UserPromptSubmit 인가: **변경을 감지할 수 있는 유일한 자리**다. SessionStart 는 세션 도중의
//   바인딩 변경을 못 본다. 매 턴 발화하는 이 이벤트에서 마커를 보면 붙음·바뀜·떼임이 그 턴에 잡힌다.
//
//  비용: 상태 파일과 마커가 일치하면 **네트워크를 안 탄다**(턴당 비용 ≈ 파일 2번 읽기). 실제 fetch 는
//   프로젝트가 붙거나 바뀐 턴에만 일어난다 — 세션당 보통 1회.
//
//  ⚠ 한 번 실린 컨텍스트는 회수할 수 없다. 그래서 프로젝트가 바뀌면 새 본문 위에 **옛 규칙 무효화**를
//   먼저 적는다 — 안 그러면 모델의 컨텍스트엔 두 프로젝트의 규칙이 함께 남아 어느 쪽이 유효한지 알 수 없다.
//
//  불변식:
//   · **절대 막지 않는다** — 어떤 실패든 무출력 exit 0.
//   · **인코그니토/읽기전용에서도 읽기는 한다**(주입은 조회일 뿐 아무것도 안 남긴다) — 단 상태파일은 tmp 에만.
//   · 프로젝트 폴더에서 직접 뜬 세션엔 주입하지 않는다 — cwd 의 AGENTS.md 를 하네스가 이미 읽었다(중복).
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// #1750 — 세션 소속 신호. 안 실으면 primary 로 간주돼 secondary 세션이 남의 데이터를 읽는다.
const SCOPE_HDRS = {
  ...(String(process.env.LIVELY_SESSION_ID || "").trim() ? { "x-lively-session": String(process.env.LIVELY_SESSION_ID).trim() } : {}),
  ...(String(process.env.LVLY_TENANT_SLUG || "").trim() ? { "x-lively-workspace": String(process.env.LVLY_TENANT_SLUG).trim() } : {}),
};

const FLAG_DIR = path.join(os.tmpdir(), "lively-hooks");   // 다른 훅과 같은 per-user tmp
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FETCH_MS = 5000;        // UserPromptSubmit 은 사람 입력을 지연시킨다 — 짧게 끊는다
const MAX_INJECT = 24 * 1024; // 주입 상한. 넘으면 앞부분만 싣고 전문은 MCP 로 안내(태스크가 수백 개인 프로젝트 대비)

const readStdin = () => new Promise((resolve) => {
  let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
  try {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); });
    process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 600);
  } catch { fin(); }
});

/** cwd 에서 위로 .lively/project.json 을 찾는다(다른 훅과 같은 계약). 못 찾으면 null. */
function findMarker(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 40; i++) {
    const m = path.join(dir, ".lively", "project.json");
    try { if (fs.existsSync(m)) return { file: m, dir }; } catch { /* 권한 등 → 계속 */ }
    const up = path.dirname(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return null;
}

(async () => {
  const boxId = (process.env.LIVELY_SESSION_ID || "").trim();
  if (!boxId || !SID_RE.test(boxId)) return;      // 라이블리 세션이 아니다

  const stdinData = await readStdin();
  let input = {}; try { input = JSON.parse(stdinData || "{}"); } catch { return; }
  const cwd = String(input.cwd || process.cwd() || "");
  if (!cwd) return;

  const statePath = path.join(FLAG_DIR, `${boxId}.projagents`);
  const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return null; } };
  const writeState = (o) => {
    try { fs.mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(statePath, JSON.stringify(o)); }
    catch { /* 못 적으면 다음 턴에 한 번 더 주입될 뿐 — 무해 */ }
  };

  const found = findMarker(cwd);
  const meta = found ? (() => { try { return JSON.parse(fs.readFileSync(found.file, "utf8")); } catch { return null; } })() : null;
  const prev = readState();

  // ── 떼어냄 — 마커가 사라졌는데 우리가 주입한 적이 있다. 이미 실린 규칙을 **말로 취소**한다(회수는 불가). ──
  if (!meta || !meta.project_id) {
    if (prev && prev.project_id) {
      writeState({});
      process.stdout.write(
        `[라이블리] 이 세션은 프로젝트 #${prev.project_id} 에서 떼어졌습니다 — 앞서 주입된 #${prev.project_id} 의 ` +
        "프로젝트 규칙·태스크 맥락은 **더 이상 적용되지 않습니다**. 그 규칙을 근거로 판단하지 마세요.\n"
      );
    }
    return;
  }

  // 프로젝트 폴더에서 직접 뜬 세션(kind 가 "session" 이 아님) — cwd 의 AGENTS.md 를 하네스가 이미 읽었다.
  if (meta.kind !== "session") return;

  const projectId = Number(meta.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) return;
  // 상태키 = 프로젝트 + 바인딩 시각. 재바인딩은 bound_at 이 갱신되므로 같은 프로젝트로 다시 붙여도 잡힌다.
  const key = `${projectId}@${String(meta.bound_at || "")}`;
  if (prev && prev.key === key) return;           // 이미 이 바인딩을 주입했다 → 네트워크 없이 종료(턴당 비용의 핵심)

  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");

  let body = null;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
    try {
      const r = await fetch(`${base}/api/ui/v6/projects/${projectId}/agents`, {
        signal: ctl.signal, headers: { authorization: "Bearer " + token, ...SCOPE_HDRS },
      });
      if (!r.ok) return;                          // 상태를 안 적는다 → 다음 턴에 재시도(일시 장애로 영영 못 받지 않게)
      body = await r.json();
    } finally { clearTimeout(t); }
  } catch { return; }

  const content = String((body && body.content) || "").trim();
  if (!content) { writeState({ key, project_id: projectId }); return; }   // 빈 프로젝트 — 재시도할 것이 없다
  const clipped = content.length > MAX_INJECT
    ? content.slice(0, MAX_INJECT) + `\n\n…(이하 생략 — 전문은 \`project_get_v6(${projectId})\` 로 조회)`
    : content;

  // 프로젝트가 **바뀐** 경우에만 무효화 문장을 앞에 단다(첫 주입엔 취소할 것이 없다).
  const switched = prev && prev.project_id && prev.project_id !== projectId;
  const head = switched
    ? `[라이블리] 이 세션이 프로젝트 #${prev.project_id} → **#${projectId}** 로 옮겨졌습니다. ` +
      `앞서 주입된 #${prev.project_id} 의 규칙은 **더 이상 적용되지 않습니다** — 아래 것으로 대체하세요.\n\n`
    : `[라이블리] 이 세션이 속한 프로젝트 **#${projectId}** 의 AGENTS.md 입니다 — 이 프로젝트에서 일하는 동안의 규칙·맥락입니다.\n\n`;

  writeState({ key, project_id: projectId });
  process.stdout.write(head + clipped + "\n");
})().then(() => process.exit(0)).catch(() => process.exit(0));

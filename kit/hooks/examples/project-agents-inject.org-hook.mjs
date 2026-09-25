// org_hook(event=UserPromptSubmit, harness=all) — 실행 세션의 프로젝트 AGENTS.md를 동적으로 주입한다.
// 프로젝트 소속의 정본은 DB execution_session이다. cwd·project.json·루트 AGENTS/CLAUDE 셔틀은 보지 않고 쓰지도 않는다.
// 매 턴 revision만 조회하고, 바뀐 턴에만 본문을 받는다. 어떤 실패도 프롬프트를 막지 않는다.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FETCH_MS = 5000;
const MAX_INJECT = 24 * 1024;
const FLAG_DIR = path.join(os.tmpdir(), "lively-hooks");


// ── 첨부 좌표 해석(#3787) — 지시에 실린 자료 표시를 **이 노드의 실제 절대경로**로 편다. ──
//  왜 필요한가: 컴포저는 이제 절대경로 대신 **노드 무관 좌표**를 적는다 — `- <보여줄 이름>  [lively:<ref>]`,
//  ref 는 서버가 업로드 응답으로 준 자료 신원(`project:<id>/<rel>` · `personal:<멤버>/<rel>`) 그대로다.
//  모델은 읽을 절대경로가 필요하고, 그 절대경로는 세션이 어디서 도느냐에 따라 다르다 — 그 변환이 여기다
//  (매니지드면 게이트웨이 경로, 로컬 노드면 `~/workspace/project/<id>/…`).
//  그리고 **없으면 크게 말한다**: 이 버그의 실제 피해는 파일이 안 온 것이 아니라, 없는데 있다고 믿은 AI 가
//  근처의 다른 파일을 집어 자신 있게 답한 것(무음 오답)이었다.
//  구 클라이언트·다른 입구(터미널 드롭·liv kickoff)는 여전히 게이트웨이 절대경로나 맨 상대경로를 실으므로 그것도 접는다.
//  ⚠ 헤더는 두 꼴을 다 받는다 — 새 판 `첨부한 자료:`, 구 판 `첨부한 자료(프로젝트 #12 공유 폴더):`.
//   구 클라이언트가 한동안 남아 있고(브라우저 캐시), 그 세션이 조용히 좌표를 잃으면 정확히 이 버그가 재발한다.
const ATTACH_HEAD = /첨부한 자료(?:\([^)]*\))?:\s*\n((?:\s*-\s*.+\n?)+)/g;
/** `- 이름  [lively:project:12/a.png]` → ref 만. 좌표 표기가 없으면 null(구 판 = 경로가 본문에 그대로 있다). */
const REF_LINE = /\[lively:([^\]]+)\]\s*$/;

function sharedRootOf() {
  return process.env.TERMINAL_ROOT_SHARED || path.join(os.homedir(), "workspace");
}

/** 게이트웨이 절대경로를 이 노드 좌표로 접는다 — `…/project/<id>/<나머지>` 의 뒤쪽만 살린다. 못 접으면 null. */
function refoldAbs(p, projDir) {
  const m = String(p).replace(/\\/g, "/").match(/\/project\/[^/]+\/(.+)$/);
  return m ? path.join(projDir, m[1]) : null;
}

/** `project:12/a/b.png` → { kind, id, rel }. 모르는 꼴이면 null. */
function parseRef(ref) {
  const i = String(ref).indexOf("/");
  if (i < 0) return null;
  const key = ref.slice(0, i), rel = ref.slice(i + 1);
  if (!rel || rel.split("/").some((x) => x === "..")) return null;
  const m = key.match(/^project:(\d+)$/);
  if (m) return { kind: "project", id: Number(m[1]), rel };
  if (/^personal:/.test(key)) return { kind: "personal", rel };
  if (key === "shared") return { kind: "shared", rel };
  return null;
}

/**
 * 좌표 → 이 노드의 절대경로 후보. **규칙으로만** 만든다(여러 루트를 훑어 이름으로 찾지 않는다 —
 *  그 탐색이 곧 「엉뚱한 동명 파일을 자신 있게 읽는」 이 버그의 재발이다).
 *   ① 이 세션의 프로젝트 좌표 → 그 프로젝트 폴더 아래. 가장 흔하고 유일하게 확실한 경우다.
 *   ② 그 외 좌표 → cwd 아래 같은 상대경로. 개인 폴더 세션(cwd = 개인 루트)에서 `personal:<나>/uploads/x.png`
 *      가 정확히 그 자리에 있다 — **구성상 같은 자리**이고, 아래에서 existsSync 로 확인한 것만 「있다」고 말한다.
 *   ③ 어느 쪽도 실물이 없으면 null → 호출부가 «이 컴퓨터에 없습니다» 로 크게 말한다.
 */
function absForRef(ref, projDir, cwd) {
  const p = parseRef(ref);
  if (!p) return null;
  const cands = [];
  if (p.kind === "project" && projDir) cands.push(path.join(projDir, p.rel));
  if (cwd) cands.push(path.join(cwd, p.rel));
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* */ } }
  return cands[0] || null;    // 없으면 **첫 후보**를 돌려준다 — 「어디를 찾았는지」를 사람에게 말해 주기 위해
}

/** 프롬프트의 첨부 표시 → [{ shown, abs, exists }]. 없으면 빈 배열. */
function resolveAttachments(prompt, projDir, cwd) {
  const out = [];
  const seen = new Set();
  const add = (shown, abs) => {
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    out.push({ shown, abs, exists: fs.existsSync(abs) });
  };
  let m;
  ATTACH_HEAD.lastIndex = 0;
  while ((m = ATTACH_HEAD.exec(String(prompt || ""))) !== null) {
    for (const line of m[1].split("\n")) {
      const v = line.replace(/^\s*-\s*/, "").trim();
      if (!v) continue;
      const r = v.match(REF_LINE);
      if (r) {                                   // 새 판 — 좌표가 명시돼 있다
        const shown = v.slice(0, r.index).trim() || r[1];
        add(shown, absForRef(r[1], projDir, cwd));
        continue;
      }
      if (path.isAbsolute(v)) { add(v, fs.existsSync(v) || !projDir ? v : (refoldAbs(v, projDir) || v)); continue; }
      if (!projDir) continue;          // 상대경로인데 펼 좌표가 없다 — 말할 수 있는 게 없으니 조용히 넘긴다
      add(v, path.join(projDir, v));
    }
  }
  return out;
}

const readStdin = () => new Promise((resolve) => {
  let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
  try {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); });
    process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 600);
  } catch { fin(); }
});

const writeStdout = (body) => new Promise((resolve) => {
  try { process.stdout.write(body, () => resolve()); } catch { resolve(); }
});

/** Lively 관리 세션을 우선하고, 외부 하네스는 훅 stdin의 정식 session_id를 namespace한다. */
export function executionSessionId(input = {}, env = process.env) {
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

(async () => {
  if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") return;
  const stdinData = await readStdin(); // cwd는 소속 판정에 쓰지 않는다.
  let input = {}; try { input = JSON.parse(stdinData || "{}"); } catch { return; }
  const executionId = executionSessionId(input);
  if (!executionId) return;

  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = String(process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = String(process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080";
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");

  const statePath = path.join(FLAG_DIR, `${executionId}.projagents`);
  const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return null; } };
  const writeState = (o) => {
    try { fs.mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(statePath, JSON.stringify(o)); }
    catch { /* 상태를 못 쓰면 다음 턴에 재주입될 뿐이다. */ }
  };
  const prev = readState();
  const known = Number.isSafeInteger(prev?.revision) ? prev.revision : -1;
  const headers = {
    authorization: "Bearer " + token,
    "x-lively-session": executionId,
    ...(String(process.env.LVLY_TENANT_SLUG || "").trim() ? { "x-lively-workspace": String(process.env.LVLY_TENANT_SLUG).trim() } : {}),
  };
  const acknowledge = async (revision) => {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
      try {
        await fetch(`${base}/api/ui/execution-sessions/${encodeURIComponent(executionId)}/project-context/applied`, {
          method: "POST", signal: ctl.signal, headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ revision }),
        });
      } finally { clearTimeout(t); }
    } catch { /* 다음 unchanged 조회에서 ACK를 재시도한다. */ }
  };

  let body;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
    try {
      // node — 이 세션이 도는 노드. 주면 서버가 그 노드에서의 폴더(folder·folder_abs_path)까지 답한다(#3787).
      const r = await fetch(`${base}/api/ui/execution-sessions/${encodeURIComponent(executionId)}/project-context`
        + `?knownRevision=${known}&node=${encodeURIComponent(String(process.env.LIVELY_NODE_ID || ""))}`, { signal: ctl.signal, headers });
      if (!r.ok) return;
      body = await r.json();
    } finally { clearTimeout(t); }
  } catch { return; }
  if (!body) return;

  // ── 첨부 좌표 — revision(changed) 과 **무관하게 매 턴** 판정한다. 첨부는 아무 턴에나 실려 온다. ──
  const attachPid = Number(body.project_id || 0);
  {
    // 프로젝트가 없어도 판정한다 — 그때는 펴 줄 좌표가 없어 **절대경로의 존재 확인만** 하지만, 그거면 충분하다.
    //  이 버그의 피해는 «파일이 안 온 것» 이 아니라 «없는데 있다고 믿고 근처 것을 읽은 것» 이라, 어느 분기에서든
    //  «없다» 는 말이 나오는 쪽이 «조용히 틀리는» 쪽보다 낫다.
    //  폴더 우선순위는 동기화 훅과 같다 — 명시 바인딩(folder_abs_path) > 세션 행의 폴더(session_dir, #4135) > env 로 조립한 슬롯.
    const projDir = (attachPid > 0 && (body.folder || body.folder_abs_path || body.session_dir))
      ? (body.folder_abs_path ? String(body.folder_abs_path)
        : body.session_dir ? String(body.session_dir)
        : path.join(sharedRootOf(), String(body.folder)))
      : null;
    const cwd = (input && typeof input.cwd === "string" && input.cwd) ? input.cwd : null;
    const found = resolveAttachments(input.prompt ?? input.user_prompt ?? "", projDir, cwd);
    if (found.length) {
      const have = found.filter((f) => f.exists), miss = found.filter((f) => !f.exists);
      const lines = [];
      if (have.length) lines.push("[라이블리] 지시에 실린 자료의 **이 컴퓨터 경로**입니다 — 이 경로로 읽으세요:\n"
        + have.map((f) => `- ${f.shown} → ${f.abs}`).join("\n"));
      if (miss.length) lines.push("⚠ [라이블리] 아래 자료가 **이 컴퓨터에 없습니다** — 아직 안 내려왔거나 지워졌습니다:\n"
        + miss.map((f) => `- ${f.shown} (찾은 자리: ${f.abs})`).join("\n")
        + "\n\n**근처의 다른 파일을 대신 읽지 마세요.** 그 파일을 봤다고 말하지도 마세요 — 없으면 없다고 하고, "
        + (attachPid > 0
          ? `필요하면 \`project_get_v6(${attachPid})\` 의 자료나 웹 자료함을 확인하도록 사람에게 요청하세요.`
          : "필요하면 사람에게 파일을 다시 올려 달라고 요청하세요."));
      if (lines.length) await writeStdout(lines.join("\n\n") + "\n");
    }
  }

  if (body.changed !== true) {
    const revision = Number(body.revision || 0);
    const applied = Number(body.applied_revision || 0);
    if (body.found === true && Number.isSafeInteger(revision) && revision >= 0 && applied < revision && known === revision) {
      await acknowledge(revision);
    }
    return;
  }

  const revision = Number(body.revision || 0);
  const projectId = Number(body.project_id || 0);
  if (!Number.isSafeInteger(revision) || revision < 0) return;
  if (!Number.isInteger(projectId) || projectId <= 0) {
    if (prev?.project_id) {
      await writeStdout(
        `[라이블리] 이 세션은 프로젝트 #${prev.project_id} 에서 떼어졌습니다 — 앞서 주입된 #${prev.project_id} 의 ` +
        "프로젝트 규칙·태스크 맥락은 **더 이상 적용되지 않습니다**. 그 규칙을 근거로 판단하지 마세요.\n");
    }
    writeState({ revision, project_id: null });
    await acknowledge(revision);
    return;
  }

  const content = String(body.content || "").trim();
  if (!content) return;
  const clipped = content.length > MAX_INJECT
    ? content.slice(0, MAX_INJECT) + `\n\n…(이하 생략 — 전문은 \`project_get_v6(${projectId})\` 로 조회)`
    : content;
  const switched = prev?.project_id && prev.project_id !== projectId;
  const head = switched
    ? `[라이블리] 이 세션이 프로젝트 #${prev.project_id} → **#${projectId}** 로 옮겨졌습니다. 앞서 주입된 #${prev.project_id} 의 규칙은 **더 이상 적용되지 않습니다** — 아래 것으로 대체하세요.\n\n`
    : `[라이블리] 이 세션이 속한 프로젝트 **#${projectId}** 의 AGENTS.md 입니다 — 이 프로젝트에서 일하는 동안의 규칙·맥락입니다.\n\n`;
  await writeStdout(head + clipped + "\n");
  writeState({ revision, project_id: projectId });
  await acknowledge(revision);
})().then(() => process.exit(0)).catch(() => process.exit(0));

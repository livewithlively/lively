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
  const harness = String(env.LIVELY_HARNESS || "").trim().toLowerCase();
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
      const r = await fetch(`${base}/api/ui/execution-sessions/${encodeURIComponent(executionId)}/project-context?knownRevision=${known}`, { signal: ctl.signal, headers });
      if (!r.ok) return;
      body = await r.json();
    } finally { clearTimeout(t); }
  } catch { return; }
  if (!body) return;
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

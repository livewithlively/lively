// org_hook(event=UserPromptSubmit, harness=all) — 미연결 실행 세션의 첫 실질 지시로 프로젝트를 만들고 DB에 붙인다.
// cwd의 project.json은 보지 않는다. 관리형 세션은 LIVELY_SESSION_ID, 외부 Codex는 훅 stdin session_id가 신원이다.
// 어떤 실패든 무출력 exit 0. 생성 후 바인딩 실패 시 방금 만든 프로젝트만 휴지통으로 보내고 다음 턴에 재시도한다.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FLAG_DIR = path.join(os.tmpdir(), "lively-hooks");
const MIN_PROMPT_CHARS = 12;
const MAX_TITLE = 70;
const MAX_BODY = 3500;
const FETCH_MS = 5000;
const AUTO_MARK = "<!-- lively:auto-created-from-first-prompt -->";

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
  const harness = String(env.LIVELY_HARNESS || "").trim().toLowerCase();
  if (native && harness === "codex" && SID_RE.test(`codex-${native}`)) return `codex-${native}`;
  if (native && harness === "claude" && SID_RE.test(`claude-${native}`)) return `claude-${native}`;
  const codex = String(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || "").trim();
  if (codex && SID_RE.test(`codex-${codex}`)) return `codex-${codex}`;
  const claude = String(env.CLAUDE_SESSION_ID || "").trim();
  if (claude && SID_RE.test(`claude-${claude}`)) return `claude-${claude}`;
  return null;
}

function titleFrom(prompt) {
  const first = prompt.split(/\r?\n/).map((s) => s.trim()).find((s) => s) || prompt.trim();
  const title = first.replace(/\s+/g, " ").trim();
  return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE - 1).trimEnd() + "…" : title;
}

async function request(base, token, executionId, url, method = "GET", body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const res = await fetch(base + url, {
      method, signal: ctl.signal,
      headers: {
        authorization: "Bearer " + token, "x-lively-session": executionId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(String(process.env.LVLY_TENANT_SLUG || "").trim() ? { "x-lively-workspace": String(process.env.LVLY_TENANT_SLUG).trim() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

(async () => {
  if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") return;
  if (String(process.env.LIVELY_MODE || "").trim().toLowerCase() === "readonly") return;
  const stdinData = await readStdin();
  let input = {}; try { input = JSON.parse(stdinData || "{}"); } catch { return; }
  const executionId = executionSessionId(input);
  if (!executionId) return;
  const prompt = String(input.prompt || "").trim();
  if (!prompt || prompt.length < MIN_PROMPT_CHARS || prompt.startsWith("/") || prompt.startsWith("!") || prompt.startsWith("<")) return;

  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = String(process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = String(process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080";
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");

  const current = await request(base, token, executionId, `/api/ui/execution-sessions/${encodeURIComponent(executionId)}/project-context?knownRevision=-1`);
  if (!current || (current.found && Number(current.project_id) > 0)) return;

  // revision별 single-flight. 예전 성공 플래그가 detach 뒤의 새 미연결 epoch까지 영구 차단하면 안 된다.
  const revision = Number.isSafeInteger(Number(current.revision)) && Number(current.revision) >= 0 ? Number(current.revision) : 0;
  const flag = path.join(FLAG_DIR, `${executionId}.${revision}.projauto`);
  try { if (fs.existsSync(flag)) return; fs.mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(flag, "", { flag: "wx" }); }
  catch { return; }
  const undo = () => { try { fs.unlinkSync(flag); } catch { /* 없음 */ } };
  const title = titleFrom(prompt);
  const description = [
    "> ⚙ 세션의 첫 지시에서 **자동 생성**된 프로젝트입니다 — 제목·본문·분류는 작업이 구체화되면 보강됩니다.",
    "", "## 첫 지시(원문)", "", prompt.length > MAX_BODY ? prompt.slice(0, MAX_BODY) + "\n\n…(이하 생략)" : prompt, "", AUTO_MARK,
  ].join("\n");
  const created = await request(base, token, executionId, "/api/ui/v6/projects", "POST", { name: title, description });
  const pid = Number(created?.project?.id);
  if (!Number.isInteger(pid) || pid <= 0) { undo(); return; }
  const bound = await request(base, token, executionId, `/api/ui/terminal/sessions/${encodeURIComponent(executionId)}/project`, "POST", { projectId: pid });
  if (!bound?.ok) {
    await request(base, token, executionId, `/api/ui/v6/projects/${pid}/delete`, "POST", {});
    undo(); return;
  }
  process.stdout.write(
    `[라이블리] 이 실행 세션은 프로젝트에 안 붙어 있어서, 방금 지시로 **프로젝트 #${pid}** 를 만들고 붙였습니다 — ` +
    `cwd와 무관하게 여기서 남기는 지식·작업기록이 #${pid}에 귀속됩니다. 제목·본문은 임시값이며 작업이 구체화되면 정련하세요.\n`);
})().then(() => process.exit(0)).catch(() => process.exit(0));

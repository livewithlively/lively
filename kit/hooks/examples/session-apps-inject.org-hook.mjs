// org_hook(event=UserPromptSubmit, harness=all) — **이 세션에 붙은 앱이 바뀌었으면** 그 사실을 세션의 AI 에게 알린다(#4225).
//
// 왜 이 훅이 존재하나(9/21 상민·원준 회의):
//  사람이 세션 오른쪽에 앱을 붙이면(웹 곁칸 [앱] → 세션 옆 앱 칸) 그 앱은 **사람과 AI 가 같이 보는 화면**이 된다.
//  그런데 AI 는 사람이 화면에서 한 일을 모른다 — 붙었다는 것도, 그 앱에 어떤 테이블이 있는지도. 모르면 «이 사람
//  기록해 줘» 를 받고도 앱이 아니라 지식이나 파일에 남긴다. 그래서 붙은 앱 목록이 **바뀐 턴에만** 한 번 알린다.
//
// 비용: 매 턴 조회 한 번(짧은 제한시간). 목록이 그대로면 **아무것도 주입하지 않는다**(맥락 0). 조회가 실패하면
//  마지막으로 알린 상태를 건드리지 않고 조용히 빠진다 — 다음 턴에 다시 본다.
//  ⚠ 이 훅은 판정하지 않는다. 붙은 앱으로 무엇을 쓸 수 있는지는 서버가 매 호출 다시 본다(세션 주인 × 붙어 있음 × 동의 범위,
//   src/apps/session-apps.ts). 여기서 «붙어 있다» 고 말한 뒤 사람이 떼면, 그 다음 호출부터 서버가 막는다.
//
// 불변식: 절대 막지 않는다(additionalContext 만, 어떤 실패든 무출력 exit 0).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FLAG_DIR = path.join(os.tmpdir(), "lively-hooks");   // 다른 시드 훅과 같은 per-user tmp
const FETCH_MS = 1500;                                    // 사람의 프롬프트 앞을 막고 선 자리다 — 짧게

// #2162 — 사람의 작업 세션만(위탁·상시·앱 세션엔 사람이 앱을 붙이지 않는다). session-name-ask 와 같은 판정·폴백.
function isWorkSessionEnv(env) {
  const kind = String(env.LIVELY_SESSION_KIND || "").trim().toLowerCase();
  if (kind) return kind === "human";
  return !String(env.LIVELY_TASK_WS || "").trim();
}

const readStdin = () => new Promise((resolve) => {
  let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
  try {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); });
    process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 600);
  } catch { fin(); }
});

// 붙이기는 라이블리가 연 세션(box-…)에만 있다 — 외부 하네스의 native id 로는 붙을 자리가 없다.
function boxSessionId(env = process.env) {
  const direct = String(env.LIVELY_SESSION_ID || "").trim();
  return direct && SID_RE.test(direct) ? direct : null;
}

const colNames = (cols) => (Array.isArray(cols) ? cols : []).map((c) => String((c && c.name) || c || "")).filter(Boolean);

function describe(apps) {
  return apps.map((a) => {
    const tables = (Array.isArray(a.tables) ? a.tables : []).map((t) => {
      const cols = colNames(t.columns);
      return `${t.name}${cols.length ? `(${cols.slice(0, 12).join("·")}${cols.length > 12 ? "…" : ""})` : ""}`;
    });
    return `  · 「${a.title || a.app_id}」 app_id: ${a.app_id}` + (a.has_ui ? " — 화면 있음" : " — 화면 없음(데이터만)")
      + (tables.length ? `\n    테이블: ${tables.join(", ")}` : "");
  }).join("\n");
}

(async () => {
  if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") return;
  const mode = String(process.env.LIVELY_MODE || "").trim().toLowerCase();
  if (mode === "incognito") return;                // 라이블리 도구가 하나도 없는 세션 — 알려 봐야 쓸 수 없다
  if (!isWorkSessionEnv(process.env)) return;
  await readStdin();                               // 페이로드는 안 쓴다(목록은 서버가 정본) — 파이프만 비운다
  const sid = boxSessionId();
  if (!sid) return;

  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");   // run-custom 이 세션 신원 토큰을 실어 준다
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");
  const headers = {
    authorization: "Bearer " + token,
    "x-lively-session": sid,
    ...(String(process.env.LVLY_TENANT_SLUG || "").trim() ? { "x-lively-workspace": String(process.env.LVLY_TENANT_SLUG).trim() } : {}),
  };

  let apps = null;
  {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
    try {
      const res = await fetch(`${base}/api/ui/terminal/sessions/${encodeURIComponent(sid)}/apps`, { signal: ctl.signal, headers });
      if (res.ok) { const j = await res.json(); if (j && Array.isArray(j.apps)) apps = j.apps; }
    } catch { /* 다음 턴에 다시 */ }
    finally { clearTimeout(t); }
  }
  if (!apps) return;                               // 판정 불가 — 마지막으로 알린 상태를 그대로 둔다

  // 마지막으로 알린 목록(id → 제목). 파일이 없으면 «아무것도 안 붙어 있다고 알고 있다» 로 본다.
  const flag = path.join(FLAG_DIR, `${sid}.apps.json`);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(flag, "utf8")) || {}; } catch { prev = {}; }
  const next = Object.fromEntries(apps.map((a) => [String(a.app_id), String(a.title || a.app_id)]));
  const same = Object.keys(prev).sort().join(",") === Object.keys(next).sort().join(",");
  if (same) return;
  try { fs.mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(flag, JSON.stringify(next)); } catch { return; }   // 못 적으면 매 턴 같은 말을 한다 — 차라리 침묵

  const gone = Object.keys(prev).filter((id) => !(id in next)).map((id) => `「${prev[id]}」`);
  const lines = [];
  if (apps.length) {
    lines.push("[라이블리 — 이 세션에 붙은 앱이 바뀌었습니다]");
    lines.push("사람이 이 세션 오른쪽에 앱을 붙여 두었습니다. 사람도 같은 앱 화면을 보고 있습니다:");
    lines.push(describe(apps));
    lines.push("붙어 있는 동안 `store_query` · `store_insert` · `store_update` · `store_delete` · `store_tables` (lively MCP)로 이 앱의 테이블을 읽고 쓸 수 있습니다"
      + (apps.length === 1 ? "(붙은 앱이 하나라 app_id 는 생략해도 됩니다)." : " — 앱이 여럿이니 app_id 를 지정하세요."));
    lines.push("여기 쓴 내용은 사람이 보는 앱 화면에 바로 반영됩니다. 사람이 이 앱이 다루는 일(기록·조회·정리)을 말하면 지식·파일이 아니라 이 앱의 데이터에 남기세요.");
    lines.push("같은 목록은 `session_apps` 로 언제든 다시 볼 수 있습니다.");
  }
  if (gone.length) lines.push(`${apps.length ? "" : "[라이블리] "}이 세션에서 ${gone.join(", ")} 이(가) 떨어졌습니다 — 이제 그 앱의 테이블은 쓸 수 없습니다(앱의 데이터는 남아 있습니다).`);
  if (!lines.length) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") + "\n" },
  }) + "\n");
})().then(() => process.exit(0)).catch(() => process.exit(0));

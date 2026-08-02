// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=PostToolUse, matcher="Read|Grep|Glob", harness=claude) — #637 Stage2. 관리탭 ▸ 커스텀 훅.
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 세션 게이트웨이에서 fetch 해 임시 .mjs 로 실행한다.
//  하는 일: 방금 연(Read/Grep/Glob) 코드파일 경로를 게이트웨이 /api/ui/recall/route 로 보내, 그 파일이 속한
//   도메인 leaf 지식을 **즉시(같은 턴)** 포인터로 주입한다. Stage1(UserPromptSubmit)의 "다음 프롬프트 지연"을
//   실시간화한 것 — 담당자 wiki-action-router 의 라이블리 등가.
//  ★ PostToolUse 는 raw stdout 이 컨텍스트로 안 들어간다 → run-custom.mjs(#637 Stage2 패치)가 이 훅 stdout 을
//   hookSpecificOutput.additionalContext JSON 으로 래핑해 주입한다. 이 훅은 raw 텍스트만 쓰면 된다(Stage1 과 동형).
//  불변식: 절대 세션을 막지 않는다(무조건 exit 0). 본문 아님(포인터). 세션 dedup(Stage1 과 캐시 공유).
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LEAF_CAP = 2;
const FETCH_MS = 4000;
const CACHE_MAX = 500;

function cacheFile(sid) {
  const safe = String(sid || "nosession").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return path.join(os.tmpdir(), `lively-recall-${safe}.json`); // Stage1(domain-recall)과 동일 파일 — 통합 dedup
}

(async () => {
  // 1) PostToolUse stdin — tool_name, tool_input.file_path(Read) 또는 .path(Grep/Glob), session_id
  const stdinData = await new Promise((resolve) => {
    let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
    try { process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); }); process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 600); }
    catch { fin(); }
  });
  let filePath = "", sessionId = "", toolName = "";
  try {
    const o = JSON.parse(stdinData || "{}");
    toolName = String(o.tool_name || o.toolName || "");
    const ti = o.tool_input || o.toolInput || {};
    filePath = String(ti.file_path || ti.path || "");
    sessionId = String(o.session_id || "");
  } catch { return; }
  if (!/^(Read|Grep|Glob)$/.test(toolName)) return;   // 매처 방어(러너가 이미 필터하지만 이중)
  if (!filePath) return;

  // 2) base + token
  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");

  // 3) 세션 dedup 캐시(Stage1 과 공유) — 이미 주입한 name 은 exclude
  const cf = cacheFile(sessionId);
  let injected = [];
  try { const a = JSON.parse(fs.readFileSync(cf, "utf8")); if (Array.isArray(a)) injected = a; } catch { /* 없음 */ }

  // 4) 라우터 호출 — paths=[방금 연 파일], text 없음(프롬프트 아님) → HUB 0, leaf 만
  let out;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const res = await fetch(`${base}/api/ui/recall/route`, {
      method: "POST", signal: ctl.signal,
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ paths: [filePath], exclude: injected, budget: { hubs: 0, leaves: LEAF_CAP } }),
    });
    if (!res.ok) return;
    out = await res.json();
  } catch { return; }
  finally { clearTimeout(t); }

  const leaves = out && Array.isArray(out.leaves) ? out.leaves : [];
  const lines = [];
  const fresh = [];
  for (const lf of leaves) {
    const ks = Array.isArray(lf.knowledge) ? lf.knowledge : [];
    if (!ks.length) continue;
    lines.push(`  [${lf.category_name || lf.category_key}]`);
    for (const k of ks) { lines.push(`    • ${k.title || k.name} (${k.name})`); fresh.push(k.name); }
  }
  if (!lines.length) return;  // 매핑 없음/전부 dedup → 무주입

  // 5) raw 텍스트 방출 — run-custom.mjs 가 PostToolUse hookSpecificOutput.additionalContext 로 래핑
  process.stdout.write(
    "[도메인 컨텍스트 — 방금 연 코드의 도메인 지식(#637)]\n" +
    "관련되면 knowledge_get(name)으로 본문을 확인하고, 무관하면 무시하세요.\n" +
    lines.join("\n") + "\n");

  // 6) 캐시 갱신(Stage1 과 공유)
  try {
    const merged = [...injected, ...fresh].slice(-CACHE_MAX);
    fs.writeFileSync(cf, JSON.stringify(merged));
  } catch { /* best-effort */ }
})().then(() => process.exit(0)).catch(() => process.exit(0));

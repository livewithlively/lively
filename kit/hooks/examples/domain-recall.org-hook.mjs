// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=UserPromptSubmit, harness=claude) — 관리탭 ▸ 커스텀 훅으로 등록. (#637)
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 세션 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: 작업맥락(이 프롬프트 + transcript tail 의 최근 Read 파일경로)을 게이트웨이 /api/ui/recall/route 로
//   보내 (a) 도메인 키워드→그 도메인 HUB 지식, (b) 열린 코드파일→그 도메인 leaf 지식 을 **포인터**로 주입한다.
//   담당자 wiki-router 의 라이블리 등가 — 다만 파일경로 대신 knowledge name 을 가리키고 knowledge_get 으로 연다.
//  불변식: 절대 세션을 막지 않는다(무조건 exit 0). **본문 아님** — 제목·소환키(name)만(본문은 knowledge_get).
//   run-custom.mjs 가 UserPromptSubmit stdout 을 additionalContext 로 주입. (b) 는 "이번 프롬프트"엔 직전 Read 를
//   반영하는 지연주입(실시간 PostToolUse 는 Stage 2 — 게이트웨이 전파 검증 후).
//  세션 dedup: 이미 주입한 지식 name 은 tmp 캐시로 재주입 억제(세션 안 부풀리기의 핵심).
//  구 knowledge-recall(프롬프트 의미유사 인덱스) 훅과 병존 — 서로 altitude 가 다르다(특정지식 vs 도메인맵 라우팅).
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MIN_PROMPT_CHARS = 12;   // (a) HUB 은 이보다 짧은 프롬프트에선 스킵(노이즈·낭비 방지). (b) 는 최근 Read 있으면 진행.
const HUB_CAP = 2;
const LEAF_CAP = 3;
const TAIL_BYTES = 65536;      // transcript 끝 ~64KB 만 바운드 읽기
const MAX_PATHS = 5;           // 최근 Read 파일 최대 개수
const FETCH_MS = 4500;
const CACHE_MAX = 500;

// transcript(.jsonl) 끝에서부터 최근 assistant 의 tool_use(Read/Grep/Glob) file_path 를 뽑는다(바운드).
function recentReadPaths(transcriptPath) {
  if (!transcriptPath) return [];
  try {
    const st = fs.statSync(transcriptPath);
    const start = Math.max(0, st.size - TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    const paths = [];
    for (let i = lines.length - 1; i >= 0 && paths.length < MAX_PATHS; i--) {
      let msg;
      try { msg = JSON.parse(lines[i]); } catch { continue; } // seek 로 잘린 첫 줄 등은 스킵
      if (!msg || msg.type !== "assistant" || !msg.message || !Array.isArray(msg.message.content)) continue;
      for (const b of msg.message.content) {
        if (b && b.type === "tool_use" && /^(Read|Grep|Glob)$/.test(b.name || "")) {
          const p = b.input && (b.input.file_path || b.input.path);
          if (typeof p === "string" && p && !paths.includes(p)) paths.push(p);
        }
      }
    }
    return paths;
  } catch { return []; }
}

function cacheFile(sid) {
  const safe = String(sid || "nosession").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return path.join(os.tmpdir(), `lively-recall-${safe}.json`);
}

(async () => {
  // 1) stdin — UserPromptSubmit JSON: prompt, transcript_path, session_id
  const stdinData = await new Promise((resolve) => {
    let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
    try { process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); }); process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 600); }
    catch { fin(); }
  });
  let prompt = "", transcriptPath = "", sessionId = "";
  try {
    const o = JSON.parse(stdinData || "{}");
    prompt = String(o.prompt || "").trim();
    transcriptPath = String(o.transcript_path || "");
    sessionId = String(o.session_id || "");
  } catch { return; }
  if (prompt.startsWith("/") || prompt.startsWith("!")) return; // 슬래시·뱅 커맨드 스킵

  const paths = recentReadPaths(transcriptPath);
  // (a) 는 프롬프트가 짧으면 스킵하되, (b) 신호(최근 Read)가 있으면 진행. 둘 다 없으면 종료.
  const wantHub = prompt.length >= MIN_PROMPT_CHARS;
  if (!wantHub && !paths.length) return;

  // 2) base + token (run-custom/session-preload 와 동일 출처)
  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");

  // 3) 세션 dedup 캐시 로드(이미 주입한 name → exclude)
  const cf = cacheFile(sessionId);
  let injected = [];
  try { const a = JSON.parse(fs.readFileSync(cf, "utf8")); if (Array.isArray(a)) injected = a; } catch { /* 없음 */ }

  // 4) 컨텍스트 라우터 호출 — (a) HUB + (b) leaf 포인터
  let out;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const res = await fetch(`${base}/api/ui/recall/route`, {
      method: "POST", signal: ctl.signal,
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        text: wantHub ? prompt.slice(0, 4000) : "",
        paths, exclude: injected,
        budget: { hubs: HUB_CAP, leaves: LEAF_CAP },
      }),
    });
    if (!res.ok) return;
    out = await res.json();
  } catch { return; }
  finally { clearTimeout(t); }
  if (!out || typeof out !== "object") return;

  const hubs = Array.isArray(out.hubs) ? out.hubs : [];
  const leaves = Array.isArray(out.leaves) ? out.leaves : [];
  const blocks = [];
  const fresh = [];

  // (a) HUB — index 가 비면(전부 dedup) 생략(같은 도메인 반복 억제)
  const hubLines = [];
  for (const h of hubs) {
    const idx = Array.isArray(h.index) ? h.index : [];
    if (!idx.length) continue;
    const gist = h.should_gist ? ` — ${String(h.should_gist).slice(0, 120)}` : "";
    hubLines.push(`  [${h.category_name || h.category_key}]${gist}`);
    for (const k of idx) { hubLines.push(`    • ${k.title || k.name} (${k.name})`); fresh.push(k.name); }
  }
  if (hubLines.length) blocks.push("▸ 도메인 HUB (프롬프트 키워드 매칭):\n" + hubLines.join("\n"));

  // (b) leaf — 최근 연 코드가 속한 도메인의 관련 지식
  const leafLines = [];
  for (const lf of leaves) {
    const ks = Array.isArray(lf.knowledge) ? lf.knowledge : [];
    if (!ks.length) continue;
    leafLines.push(`  [${lf.category_name || lf.category_key}]`);
    for (const k of ks) { leafLines.push(`    • ${k.title || k.name} (${k.name})`); fresh.push(k.name); }
  }
  if (leafLines.length) blocks.push("▸ 최근 연 코드의 도메인 지식 (leaf):\n" + leafLines.join("\n"));

  if (!blocks.length) return; // 라우팅 결과 없음 → 무주입(게이팅)

  process.stdout.write(
    "[도메인 컨텍스트 — Lively 자동 라우팅(#637)]\n" +
    "작업맥락으로 찾아온 관련 도메인 지식입니다. 관련되면 knowledge_get(name)으로 본문을 확인하고, 무관하면 무시하세요.\n" +
    blocks.join("\n") + "\n");

  // 5) 캐시 갱신(재주입 억제) — 무조건 exit 0
  try {
    const merged = [...injected, ...fresh].slice(-CACHE_MAX);
    fs.writeFileSync(cf, JSON.stringify(merged));
  } catch { /* best-effort */ }
})().then(() => process.exit(0)).catch(() => process.exit(0));

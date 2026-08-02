// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=UserPromptSubmit, harness=claude) — 관리탭 ▸ 커스텀 훅으로 등록.
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 세션 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: 입력 프롬프트와 **의미적으로 가까운 팀 지식 인덱스**를 주입(벡터검색 #172, proactive 회수).
//   게이트웨이 /api/ui/knowledge/similar(text, min_score) 로 **절대 관련도 게이팅** → 무관 프롬프트엔 무주입(노이즈 억제).
//  불변식: 절대 세션을 막지 않는다(무조건 exit 0). **본문 아님** — 제목·소환키·유사도·1줄 스니펫 인덱스만(본문은 knowledge_get).
//  run-custom.mjs(2026-06-26~)가 UserPromptSubmit stdout 을 additionalContext 로 주입(SessionStart 와 동형).
// ───────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MIN_SCORE = 0.6;        // 이 코사인 유사도 이상만 — 게이팅(관련 없으면 아무것도 안 함). bge-m3 기준 0.5는 모호질문에 턱걸이 노이즈가 새서 0.6으로 상향(2026-06-26).
const LIMIT = 4;              // 주입 최대 건수(인덱스이므로 적게)
const MIN_PROMPT_CHARS = 12;  // 너무 짧은 프롬프트(ok/네/yes 등)는 스킵(노이즈·낭비 방지)
const FETCH_MS = 4000;

(async () => {
  // 1) 프롬프트 — UserPromptSubmit stdin JSON 의 prompt
  const stdinData = await new Promise((resolve) => {
    let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
    try { process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); }); process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 600); }
    catch { fin(); }
  });
  let prompt = "";
  try { const o = JSON.parse(stdinData || "{}"); prompt = String(o.prompt || "").trim(); } catch { return; }
  if (prompt.length < MIN_PROMPT_CHARS) return;                 // 짧음 → 스킵
  if (prompt.startsWith("/") || prompt.startsWith("!")) return; // 슬래시·뱅 커맨드 → 스킵

  // 2) 게이트웨이 base + 토큰 (run-custom/session-preload 와 동일 출처)
  const HOME = process.env.LIVELY_HOME || os.homedir();
  const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!token) return;
  let base = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080");
  base = base.replace(/\/?(mcp)?\/*$/i, "").replace(/\/+$/, "");

  // 3) 의미 유사 지식 회수(절대 관련도 게이팅) — knowledge_similar(text, min_score). 무관/임베딩 off → 빈 결과.
  let entries = [];
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const qs = new URLSearchParams({ text: prompt.slice(0, 2000), min_score: String(MIN_SCORE), limit: String(LIMIT) });
    const res = await fetch(`${base}/api/ui/knowledge/similar?${qs}`, { signal: ctl.signal, headers: { authorization: "Bearer " + token } });
    if (!res.ok) return;
    const j = await res.json();
    entries = Array.isArray(j && j.entries) ? j.entries : [];
  } catch { return; }
  finally { clearTimeout(t); }
  if (!entries.length) return;   // 관련 지식 없음 → 무주입(게이팅의 핵심 — 모든 프롬프트를 오염시키지 않는다)

  // 4) 인덱스만 주입(본문 아님). 제목·소환키(name)·유사도·1줄 스니펫.
  const lines = entries.map((e) => {
    const pct = Math.round((Number(e.similarity) || 0) * 100);
    const snip = String(e.snippet || "").replace(/\s+/g, " ").trim().slice(0, 100);
    return `- ${e.title || e.name} (${e.name}) · 유사도 ${pct}%` + (snip ? `\n  ${snip}` : "");
  });
  process.stdout.write(
    "[관련 팀 지식 — Lively 컨텍스트 저장소(자동 검색)]\n" +
    "아래는 이 요청과 의미적으로 가까운 기존 팀 지식입니다. 관련되면 knowledge_get(name)으로 본문을 확인하고, 무관하면 무시하세요.\n" +
    lines.join("\n") + "\n");
})().then(() => process.exit(0)).catch(() => process.exit(0));

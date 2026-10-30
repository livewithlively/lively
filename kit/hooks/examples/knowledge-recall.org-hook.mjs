// ───────────────────────────────────────────────────────────────────────────
// org_hook 소스 (event=UserPromptSubmit·PreCompact, harness=all) — 시드 훅 knowledge-recall · knowledge-recall-compact.
//  ⚠ 키트 번들 파일 아님. run-custom.mjs 가 매 세션 게이트웨이에서 fetch 해 임시 .mjs(ESM)로 실행한다.
//  하는 일: 입력 프롬프트와 **의미적으로 가까운 팀 지식 인덱스**를 주입(벡터검색 #172, proactive 회수).
//   게이트웨이 /api/ui/knowledge/similar(text, min_score) 로 **절대 관련도 게이팅** → 무관 프롬프트엔 무주입(노이즈 억제).
//  불변식: 절대 세션을 막지 않는다(무조건 exit 0). **본문 아님** — 제목·소환키·유사도·1줄 스니펫 인덱스만(본문은 knowledge_get).
//  run-custom.mjs(2026-06-26~)가 UserPromptSubmit stdout 을 additionalContext 로 주입(SessionStart 와 동형).
//  #5197 — 사람 프롬프트에만 소환하고, 같은 대화에 이미 넣은 지식은 다시 넣지 않는다. 같은 소스가 PreCompact 로도 등록된다
//   (knowledge-recall-compact) — 압축되면 주입 내용이 대화에서 사라지므로 그 대화의 기록을 비운다. 훅 본문이 stdin 의
//   hook_event_name 으로 두 판을 구분한다. PreCompact 를 쓰는 까닭: 주입이 되는 세 하네스(claude·codex·cursor)에 다 있는
//   이벤트다(cursor 엔 PostCompact 가 없다). 압축이 실패해도 그 지식이 한 번 더 들어올 뿐이다.
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


const MIN_SCORE = 0.6;        // 이 코사인 유사도 이상만 — 게이팅(관련 없으면 아무것도 안 함). bge-m3 기준 0.5는 모호질문에 턱걸이 노이즈가 새서 0.6으로 상향(2026-06-26).
const LIMIT = 4;              // 주입 최대 건수(인덱스이므로 적게)
const MIN_PROMPT_CHARS = 12;  // 너무 짧은 프롬프트(ok/네/yes 등)는 스킵(노이즈·낭비 방지)
const FETCH_MS = 4000;
// 사람이 쓰지 않은 입력 — 작업 완료 알림·서브에이전트 보고·세션 간 메시지(#5197). 주입 턴의 86%가 여기 붙었고 같은 턴 열람률은
//  0.1~0.2%였다(사람 프롬프트 6.4%). 훅 입력에 출처 칸이 없어 글머리로 가른다. 앞 세 꼴이 stdin 에 그대로 온다(Claude Code 2.1.314 실측).
//  «Another Claude session…» 은 대화 기록(jsonl)에 저장될 때 붙는 머리말이다 — stdin 에 와도 걸리게 함께 둔다.
//  화면이 «사람이 친 말» 을 가르는 넓은 목록은 web/lib/ask-text.ts INJECTED_RE 다. 여기엔 stdin 에서 잰 것만 둔다.
const NOT_HUMAN = /^(?:<task-notification>|<agent-message[\s>]|<cross-session-message[\s>]|Another Claude session sent a message)/;
const SEEN_DIR = path.join(os.tmpdir(), "lively-hooks");   // 다른 시드 훅과 같은 per-user tmp
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// 이 대화에 주입한 지식의 기록 파일 — 열쇠는 하네스의 session_id 다. LIVELY_SESSION_ID 는 pane 에 고정이라 쓰면 안 된다:
//  /clear 는 같은 pane 에서 새 대화를 열고 새 session_id 를 주므로(실측), 그 순간 기록이 저절로 새로 시작돼야 한다.
//  열쇠를 못 정하면 null — 기록 없이 종전처럼 매번 주입한다. 서브에이전트 호출도 null 이다: 부모 session_id 에 agent_id 가 붙어 오는데
//  자식과 부모는 컨텍스트가 달라서, 같은 기록을 쓰면 한쪽이 받은 지식을 다른 쪽이 못 받고 자식의 압축이 부모 기록을 지운다.
const seenFileOf = (input) => {
  if (String(input.agent_id ?? "").trim()) return null;
  const sid = String(input.session_id || "");
  return SID_RE.test(sid) ? path.join(SEEN_DIR, `${sid}.recall-seen`) : null;
};
const readSeen = (file) => { try { return new Set(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)); } catch { return new Set(); } };

(async () => {
  // 1) 프롬프트 — UserPromptSubmit stdin JSON 의 prompt
  const stdinData = await new Promise((resolve) => {
    let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
    try { process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; if (d.length > 262144) fin(); }); process.stdin.on("end", fin); process.stdin.on("error", fin); setTimeout(fin, 600); }
    catch { fin(); }
  });
  let input = {};
  try { input = JSON.parse(stdinData || "{}"); } catch { return; }
  const seenFile = seenFileOf(input);
  if (input.hook_event_name === "PreCompact") {                 // 압축 → 이 대화의 기록을 비워 압축 뒤에 다시 소환되게 한다
    if (seenFile) {
      try { fs.rmSync(seenFile, { force: true }); } catch { /* 못 지우면 압축 뒤 재주입이 빠질 뿐이다 */ }
    }
    return;
  }
  const prompt = String(input.prompt || "").trim();
  if (prompt.length < MIN_PROMPT_CHARS) return;                 // 짧음 → 스킵
  if (prompt.startsWith("/") || prompt.startsWith("!")) return; // 슬래시·뱅 커맨드 → 스킵
  if (NOT_HUMAN.test(prompt)) return;                           // 알림·메시지 → 스킵

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
    const res = await fetch(`${base}/api/ui/knowledge/similar?${qs}`, { signal: ctl.signal, headers: { authorization: "Bearer " + token, ...SCOPE_HDRS } });
    if (!res.ok) return;
    const j = await res.json();
    entries = Array.isArray(j && j.entries) ? j.entries : [];
  } catch { return; }
  finally { clearTimeout(t); }
  if (!entries.length) return;   // 관련 지식 없음 → 무주입(게이팅의 핵심 — 모든 프롬프트를 오염시키지 않는다)

  // 4) 이 대화에 이미 넣은 지식은 뺀다. 뺀 자리를 더 낮은 순위로 채우지 않는다 — 무작위 문서 쌍의 31.6%가 기준선을 넘어서(#1617 0단계)
  //  채우면 턴마다 새 문서 4건이 들어온다. 주입은 종전 상위 4건의 부분집합으로 남는다.
  if (seenFile) { const seen = readSeen(seenFile); entries = entries.filter((e) => !seen.has(e.name)); }
  if (!entries.length) return;

  // 5) 인덱스만 주입(본문 아님). 제목·소환키(name)·유사도·1줄 스니펫.
  const lines = entries.map((e) => {
    const pct = Math.round((Number(e.similarity) || 0) * 100);
    const snip = String(e.snippet || "").replace(/\s+/g, " ").trim().slice(0, 100);
    return `- ${e.title || e.name} (${e.name}) · 유사도 ${pct}%` + (snip ? `\n  ${snip}` : "");
  });
  const body =
    "[관련 팀 지식 — Lively 컨텍스트 저장소(자동 검색)]\n" +
    "아래는 이 요청과 의미적으로 가까운 기존 팀 지식입니다. 관련되면 knowledge_get(name)으로 본문을 확인하고, 무관하면 무시하세요.\n" +
    lines.join("\n") + "\n";
  // 읽는 쪽이 닫혔으면 콜백이 오류를 받고 error 이벤트도 터진다 — 삼켜서 exit 0 을 지키고, 못 나간 지식은 적지 않는다.
  process.stdout.on("error", () => {});
  const wrote = await new Promise((resolve) => { try { process.stdout.write(body, (err) => resolve(!err)); } catch { resolve(false); } });
  // 출력이 나간 뒤에 적는다 — 반대 순서면 그 사이 훅이 끊겼을 때 넣지 못한 지식이 «넣음» 으로 남아 이 대화엔 다시 안 온다.
  if (seenFile && wrote) {
    try { fs.mkdirSync(SEEN_DIR, { recursive: true, mode: 0o700 }); fs.appendFileSync(seenFile, entries.map((e) => e.name).join("\n") + "\n"); }
    catch { /* 못 적으면 다음 턴에 다시 주입될 뿐이다 */ }
  }
})().then(() => process.exit(0)).catch(() => process.exit(0));

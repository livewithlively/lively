// 세션 대화 트랜스크립트 → '사용자 질문(프롬프트)만' 추출 (#745 카드 '내 질문' 팝아웃).
//  Claude Code 는 세션 대화를 ~/.claude/projects/<cwd 인코딩>/<sessionUuid>.jsonl 에 append 한다.
//  인코딩: cwd 의 '/' 와 '.' 를 '-' 로 (예: /Users/lively/.openclaw/workspace/project/657 → -Users-lively--openclaw-workspace-project-657).
//  ⚠ 접근 전제: 격리 OFF(현재 macOS 박스) = 세션이 게이트웨이 유저(lively)로 실행 → 트랜스크립트 직접 읽기 가능.
//   격리 ON(리눅스 box_ 700홈)이면 이 경로가 안 읽히므로, 향후 drop-priv(wrapAsMember)로 확장해야 한다(지금은 빈 결과 폴백).
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EmbeddingProvider } from "./v6/embedding-provider.js";

const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");

function projectDirFor(cwd: string): string {
  return path.join(CLAUDE_PROJECTS, cwd.replace(/[/.]/g, "-"));
}

export interface Prompt { text: string; ts: string; }

// 사용자 질문이 아닌 '주입/노이즈' 메시지 — 슬래시커맨드 래퍼·태스크알림·시스템리마인더·caveat·중단표시 등.
const INJECTED_RE = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|\[Request interrupted|Caveat:|This session is being continued)/;

// 한 세션(cwd)의 사용자 프롬프트를 시간순(오래된→최신)으로. '이 세션의 현재 대화' = 가장 최근 수정된 jsonl 기준.
//  접근통제는 라우트(canAttach)에서 — 여기선 파일만 읽는다. 실패·미격리불가 = 빈 결과(비치명).
export async function sessionPrompts(cwd: string, limit = 300): Promise<{ prompts: Prompt[]; total: number; found: boolean }> {
  if (!cwd) return { prompts: [], total: 0, found: false };
  const dir = projectDirFor(cwd);
  let files: string[];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".jsonl")); }
  catch { return { prompts: [], total: 0, found: false }; }   // 프로젝트 디렉토리 없음(대화 기록 없음)
  if (!files.length) return { prompts: [], total: 0, found: false };
  // 최신 대화 = 가장 최근 수정된 jsonl.
  let newest = ""; let newestMt = -1;
  for (const f of files) {
    try { const st = await fsp.stat(path.join(dir, f)); if (st.mtimeMs > newestMt) { newestMt = st.mtimeMs; newest = f; } }
    catch { /* skip */ }
  }
  if (!newest) return { prompts: [], total: 0, found: false };
  let raw: string;
  try { raw = await fsp.readFile(path.join(dir, newest), "utf8"); }
  catch { return { prompts: [], total: 0, found: true }; }
  const out: Prompt[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== "user" || o.isMeta || o.isSidechain) continue;
    const c = o.message && o.message.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.filter((x: any) => x && x.type === "text").map((x: any) => x.text || "").join("\n");
    text = (text || "").trim();
    if (!text || INJECTED_RE.test(text)) continue;   // 툴결과·주입 메시지 제외 → 사람이 친 질문만
    out.push({ text, ts: o.timestamp || "" });
  }
  const total = out.length;
  return { prompts: out.slice(-limit), total, found: true };
}

// 여러 세션 통합 검색(#745) — 접근 가능한 세션들의 트랜스크립트에서 질문을 찾아 어느 세션인지와 함께 반환.
//  단순 부분문자열이 아니라 **토큰(공백분리) AND + 관련도 랭킹**: 모든 단어를 포함한 질문(순서·조사 무관)을
//  경계·빈도·근접·정확구문 점수로 정렬. 전부 매치되는 게 없으면 **부분(일부 단어) 폴백**으로 그래도 결과를 준다.
export interface SearchHit { sessionId: string; label: string; projectId: number; text: string; ts: string; }
// 질문 텍스트(소문자) 관련도 점수. 반환 matched = 매치된 단어 수(AND 판정용).
const BOUNDARY_RE = /[\s.,!?()[\]{}"'“”‘’·\-—:;/\\]/;
export function scoreText(textLower: string, terms: string[], phrase: string): { score: number; matched: number } {
  let score = 0, matched = 0;
  const positions: number[] = [];
  for (const t of terms) {
    const idx = textLower.indexOf(t);
    if (idx === -1) continue;
    matched++; positions.push(idx);
    score += 10;
    if (idx === 0 || BOUNDARY_RE.test(textLower[idx - 1])) score += 5;   // 단어 경계에서 시작(조사 앞 등)
    let c = 0, i: number = idx; while (i !== -1 && c < 5) { c++; i = textLower.indexOf(t, i + t.length); }
    score += Math.min(c - 1, 3);                                          // 빈도(캡)
  }
  if (matched === 0) return { score: 0, matched: 0 };
  if (terms.length > 1) {
    if (matched === terms.length && positions.length) {
      const span = Math.max(...positions) - Math.min(...positions);
      if (span < 30) score += 20; else if (span < 100) score += 8;       // 단어들이 가까이 = 관련↑
    }
    if (textLower.includes(phrase)) score += 50;                          // 정확 구문(연속) = 최상
  }
  return { score, matched };
}
export function queryTerms(q: string): string[] {
  return [...new Set((q || "").trim().toLowerCase().split(/\s+/).filter(Boolean))];
}
export async function searchPrompts(sessions: Array<{ id: string; label: string; dir: string; projectId?: number }>, q: string, limit = 120): Promise<{ results: SearchHit[]; total: number; truncated: boolean; partial: boolean }> {
  const query = (q || "").trim();
  if (!query) return { results: [], total: 0, truncated: false, partial: false };
  const phrase = query.toLowerCase();
  const terms = queryTerms(query);
  const all: Array<SearchHit & { score: number; matched: number }> = [];
  for (const s of sessions) {
    const { prompts } = await sessionPrompts(s.dir, 1000);
    for (const p of prompts) {
      const { score, matched } = scoreText(p.text.toLowerCase(), terms, phrase);
      if (matched >= 1) all.push({ sessionId: s.id, label: s.label || s.id, projectId: Number(s.projectId) || 0, text: p.text, ts: p.ts, score, matched });
    }
  }
  const strict = all.filter((h) => h.matched === terms.length);          // 모든 단어 포함(정밀)
  const partial = strict.length === 0 && terms.length > 1;               // 전부 매치 없으면 부분 폴백(일부 단어)
  const pool = partial ? all : strict;
  pool.sort((a, b) => b.score - a.score || (b.ts || "").localeCompare(a.ts || ""));  // 관련도 → 최신
  const results = pool.slice(0, limit).map(({ score, matched, ...r }) => r);
  return { results, total: pool.length, truncated: pool.length > limit, partial };
}

// ── 의미(임베딩) 하이브리드 검색(#745) — 렉시컬(정확 단어) ∪ 시맨틱(bge-m3 코사인)을 RRF 로 융합. ──
//  단어가 달라도 뜻이 비슷하면(예: '버튼 크게' ↔ '버튼 사이즈 키우기') 찾는다. provider off/실패면 라우트가 렉시컬 폴백.
//  프롬프트 임베딩은 인메모리 캐시(내용 해시=텍스트키) — 첫 검색만 임베딩(최신순 예산 내), 이후 캐시 재사용.
const RRF_K = 60, SIM_FLOOR = 0.50, SEM_TOPN = 25;
const promptEmbedCache = new Map<string, number[]>();
const EMBED_CACHE_MAX = 6000;
function cacheEmb(text: string, vec: number[]): void {
  if (promptEmbedCache.size >= EMBED_CACHE_MAX) { const k = promptEmbedCache.keys().next().value; if (k !== undefined) promptEmbedCache.delete(k); }
  promptEmbedCache.set(text, vec);
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
interface Doc { sessionId: string; label: string; projectId: number; text: string; ts: string; lexScore: number; lexMatched: boolean; sim: number; }
export async function searchPromptsHybrid(sessions: Array<{ id: string; label: string; dir: string; projectId?: number }>, q: string, provider: EmbeddingProvider, limit = 120, embedBudget = 500): Promise<{ results: SearchHit[]; total: number; truncated: boolean; partial: boolean; semantic: boolean }> {
  const query = (q || "").trim();
  if (!query) return { results: [], total: 0, truncated: false, partial: false, semantic: false };
  const phrase = query.toLowerCase();
  const terms = queryTerms(query);
  const docs: Doc[] = [];
  for (const s of sessions) {
    const { prompts } = await sessionPrompts(s.dir, 500);
    for (const p of prompts) {
      const { score, matched } = scoreText(p.text.toLowerCase(), terms, phrase);
      docs.push({ sessionId: s.id, label: s.label || s.id, projectId: Number(s.projectId) || 0, text: p.text, ts: p.ts, lexScore: score, lexMatched: matched === terms.length && matched > 0, sim: 0 });
    }
  }
  if (!docs.length) return { results: [], total: 0, truncated: false, partial: false, semantic: true };
  // 쿼리 임베딩(실패 시 렉시컬로 폴백 신호 = semantic:false 로 라우트가 처리하도록 예외 throw 하지 않고 빈 sim)
  let qEmb: number[] | null = null;
  try { qEmb = (await provider.embed([query]))[0] || null; } catch { qEmb = null; }
  if (qEmb) {
    // 캐시 안 된 프롬프트를 최신순으로 예산만큼 임베딩(배치) — 첫 검색만 비용, 이후 캐시.
    const uncached = docs.filter((d) => d.text && !promptEmbedCache.has(d.text))
      .sort((a, b) => (b.ts || "").localeCompare(a.ts || "")).slice(0, embedBudget).map((d) => d.text);
    const uniq = [...new Set(uncached)];
    const BATCH = 128;
    for (let i = 0; i < uniq.length; i += BATCH) {
      const chunk = uniq.slice(i, i + BATCH);
      try { const vecs = await provider.embed(chunk); chunk.forEach((t, j) => { if (vecs[j]) cacheEmb(t, vecs[j]); }); } catch { /* 이 배치 스킵 → 렉시컬만 */ }
    }
    for (const d of docs) { const e = promptEmbedCache.get(d.text); if (e) d.sim = cosine(qEmb, e); }
  }
  // 채널별 랭크 → RRF 융합. 후보 = 렉시컬 전부(AND) ∪ 시맨틱 상위(SIM_FLOOR 이상).
  const byLex = docs.filter((d) => d.lexMatched).sort((a, b) => b.lexScore - a.lexScore);
  const bySim = docs.filter((d) => d.sim >= SIM_FLOOR).sort((a, b) => b.sim - a.sim).slice(0, SEM_TOPN);
  const lexRank = new Map<Doc, number>(); byLex.forEach((d, i) => lexRank.set(d, i + 1));
  const simRank = new Map<Doc, number>(); bySim.forEach((d, i) => simRank.set(d, i + 1));
  const cand = new Set<Doc>([...byLex, ...bySim]);
  const scored = [...cand].map((d) => {
    const lr = lexRank.get(d), sr = simRank.get(d);
    const rrf = (lr ? 1 / (RRF_K + lr) : 0) + (sr ? 1 / (RRF_K + sr) : 0);
    return { d, rrf };
  });
  scored.sort((a, b) => b.rrf - a.rrf || b.d.sim - a.d.sim || (b.d.ts || "").localeCompare(a.d.ts || ""));
  const results = scored.slice(0, limit).map(({ d }) => ({ sessionId: d.sessionId, label: d.label, projectId: d.projectId, text: d.text, ts: d.ts }));
  return { results, total: scored.length, truncated: scored.length > limit, partial: false, semantic: !!qEmb };
}

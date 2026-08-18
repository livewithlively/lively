// 세션 대화 트랜스크립트 → '사용자 질문(프롬프트)만' 추출 (#745 카드 '내 질문' 팝아웃).
//  Claude Code 는 세션 대화를 ~/.claude/projects/<cwd 인코딩>/<sessionUuid>.jsonl 에 append 한다.
//  인코딩: cwd 의 '/' 와 '.' 를 '-' 로 (예: /Users/lively/.openclaw/workspace/project/657 → -Users-lively--openclaw-workspace-project-657).
//  ⚠ 접근 전제: 격리 OFF(현재 macOS 박스) = 세션이 게이트웨이 유저(lively)로 실행 → 트랜스크립트 직접 읽기 가능.
//   격리 ON(리눅스 box_ 700홈)이면 이 경로가 안 읽히므로, 향후 drop-priv(wrapAsMember)로 확장해야 한다(지금은 빈 결과 폴백).
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EmbeddingProvider } from "../v6/embedding-provider.js";

const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");

function projectDirFor(cwd: string): string {
  return path.join(CLAUDE_PROJECTS, cwd.replace(/[/.]/g, "-"));
}

export interface Prompt { text: string; ts: string; author?: string; }

// 대화 기록이 실제로 쌓이는 뿌리들 — 공유 ~/.claude + **멤버별 프로필**(#1014 이후 웹터미널 세션은 항상
//  CLAUDE_CONFIG_DIR=<PROFILES_ROOT>/<슬러그>/claude 로 실행된다). 예전엔 공유 하나만 봐서, 세션에서 오간
//  질문 대부분이(특히 남이 던진 것) 팝업에 아예 안 떴다 — 실측: project/1045 는 공유 7 + yoon 프로필 3 = 대화
//  10개인데 공유의 최신 1개만 읽고 있었다.
const PROFILES_ROOT = process.env.LIVELY_PROFILES_ROOT || path.join(os.homedir(), ".lively", "profiles");
const MAX_TRANSCRIPT_FILES = 20;   // 한 세션(cwd)당 읽을 대화 파일 상한 — 최근 수정순. 통합검색이 전 세션을 훑으므로 상한을 둔다.
const MEMBER_HOME_BASE = process.env.LIVELY_MEMBER_HOME_BASE || "/home";   // 격리 ON(리눅스): useradd -m -d /home/box_<slug>
async function transcriptRoots(): Promise<Array<{ dir: string; author: string }>> {
  const roots = [{ dir: CLAUDE_PROJECTS, author: "" }];   // author='' = 공유(누구 프로필인지 알 수 없음)
  let slugs: string[] = [];
  try { slugs = await fsp.readdir(PROFILES_ROOT); } catch { /* 프로필 루트 없음(단일 프로필 박스) */ }
  for (const slug of slugs) roots.push({ dir: path.join(PROFILES_ROOT, slug, "claude", "projects"), author: slug });
  // 격리 ON 박스(멤버별 OS 유저·홈 700)에서는 기록이 그 홈에 떨어질 수 있다 → 후보에만 넣는다.
  //  ⚠ 홈이 700 이면 게이트웨이가 못 읽고 조용히 건너뛴다(권한 상승은 하지 않는다 — 그 경우 이 경로의 질문은
  //   여전히 안 보이며, 해결하려면 drop-priv 읽기가 필요하다. 여기선 '읽을 수 있으면 포함'까지만).
  //  ⚠⚠ 리눅스(또는 경로를 명시한 박스)에서만 훑는다 — macOS 의 /home 은 autofs 자동마운트 지점이라
  //   서비스 프로세스에서 readdir 하면 automountd 응답을 기다리며 **요청이 통째로 멈춘다**(실측: dev :8080 에서
  //   /prompts 가 20초+ 무응답. CLI 로는 즉시 0건이라 재현이 안 돼 오진하기 쉽다). 격리는 리눅스 전용 기능이다.
  const scanMemberHomes = process.platform === "linux" || !!process.env.LIVELY_MEMBER_HOME_BASE;
  if (scanMemberHomes) {
    let homes: string[] = [];
    try { homes = (await fsp.readdir(MEMBER_HOME_BASE)).filter((h) => h.startsWith("box_")); } catch { /* 격리 미사용·접근 불가 */ }
    for (const h of homes) roots.push({ dir: path.join(MEMBER_HOME_BASE, h, ".claude", "projects"), author: h.replace(/^box_/, "") });
  }
  return roots;
}

// 트랜스크립트 원문에서 **첫 cwd**(세션이 실행된 절대경로)를 뽑는다 — 이어받기(#905 C1)에서 그 경로로 세션을 열어야
//  claude --resume 이 로컬 jsonl(경로=cwd 인코딩)을 찾는다. 세션 row 엔 cwd 가 없어 본문에서 회수한다.
export function firstTranscriptCwd(jsonl: string): string | null {
  for (const line of jsonl.split("\n")) {
    if (!line.trim() || line.indexOf('"cwd"') < 0) continue;
    let o: { cwd?: unknown };
    try { o = JSON.parse(line); } catch { continue; }
    if (o && typeof o.cwd === "string" && o.cwd.trim()) return o.cwd.trim();
  }
  return null;
}

// #1059 — 이 소유자로 실행되는 세션이 **자기 홈에서 볼 수 있는** 뿌리만 남긴다.
//  ⚠ 이걸 안 걸면 남의 홈에 있는 대화를 골라 `--resume <uuid>` 를 걸고, 그 세션은 그 파일을 못 봐서
//   claude 가 "No conversation found with session ID: …" 로 즉시 죽는다(2026-07-28 마이크 실측 사고).
//   격리(#524)에서는 멤버마다 홈이 따로라 **같은 작업 폴더의 대화도 사람별로 다른 파일**이다.
//  포함: author==='' (공유 ~/.claude — 비격리 세션이 쓰는 곳) + author===그 소유자(프로필·격리 홈).
function rootsForOwner(roots: Array<{ dir: string; author: string }>, owner: string): Array<{ dir: string; author: string }> {
  const me = String(owner || "").trim().toLowerCase();
  if (!me) return roots.filter((r) => !r.author);          // 소유자 미상이면 공유만(남의 것 절대 안 봄)
  return roots.filter((r) => !r.author || r.author.toLowerCase() === me);
}

// #1059 — 이 UUID 의 대화 기록이 **실제로 있나**. restore 가 `--resume <uuid>` 를 걸기 전에 확인한다.
//  없는 UUID 로 resume 하면 claude 가 "No conversation found with session ID: …" 를 뱉고 **즉시 종료**하는데,
//  box-spawn 이 `exec claude` 라 그 순간 tmux 세션도 사라진다 → 웹터미널이 4410 을 받아 다시 복원을 시도하며
//  **복원 루프**가 돈다(2026-07-28 실측 신고: "계속 새로고침"). 매핑이 있어도 그 대화가 없을 수 있다 —
//  SessionStart 훅은 대화가 한 줄도 쌓이기 전에 UUID 를 보고하므로(세션을 열고 아무 말도 안 하면 파일이 없다).
//  0바이트 파일도 없는 것으로 본다(claude 가 못 읽는다). 뿌리(공유·프로필·격리홈) 전부를 훑는다 — access 뿐이라 싸다.
export async function transcriptExists(cwd: string, sessionUuid: string, owner = ""): Promise<boolean> {
  if (!cwd || !sessionUuid) return false;
  const enc = cwd.replace(/[/.]/g, "-");
  // owner 를 주면 그 사람이 볼 수 있는 뿌리만 — 남의 홈에 있는 동명 파일로 '있다'고 오판하지 않게.
  for (const { dir } of rootsForOwner(await transcriptRoots(), owner)) {
    try {
      const st = await fsp.stat(path.join(dir, enc, `${sessionUuid}.jsonl`));
      if (st.isFile() && st.size > 0) return true;
    } catch { /* 이 뿌리엔 없음 — 다음 */ }
  }
  return false;
}

// #1719 세션 대화창 — 이 UUID 의 대화 파일 **경로**를 찾는다(transcriptExists 와 같은 뿌리·같은 소유자 스코프).
//  존재 여부만으로는 모자라다: 대화창이 그 파일을 오프셋부터 이어 읽어야 한다(터미널 대신 말풍선으로 라이브 세션을 보인다).
//  못 찾으면 null — 호출자가 '아직 기록 없음'으로 다룬다(추측 폴백 없음, 위 주석의 원칙 그대로).
export async function findTranscriptFile(cwd: string, sessionUuid: string, owner = ""): Promise<{ file: string; size: number } | null> {
  if (!cwd || !sessionUuid) return null;
  const enc = cwd.replace(/[/.]/g, "-");
  for (const { dir } of rootsForOwner(await transcriptRoots(), owner)) {
    const file = path.join(dir, enc, `${sessionUuid}.jsonl`);
    try {
      const st = await fsp.stat(file);
      if (st.isFile()) return { file, size: st.size };
    } catch { /* 이 뿌리엔 없음 — 다음 */ }
  }
  return null;
}

// ⚠ '그 폴더의 가장 최근 대화'로 resume 을 추측하는 함수가 여기 있었다가 제거됐다(2026-07-28).
//  왜 다시 만들지 말아야 하나: ① 격리(#524)는 멤버마다 홈이 따로라 남의 홈 대화를 집으면 그 세션이 못 읽어
//  claude 가 즉시 죽는다(실측 사고) ② 소유자로 스코프해도 같은 폴더의 다른 대화를 '최신'이라며 집을 수 있다.
//  추측해서 틀리는 것보다 후보 picker 로 사용자가 고르게 하는 편이 낫다 — 매핑(work-flag 훅 보고)이 정답 경로다.

// 중앙 트랜스크립트를 이 박스의 claude 프로젝트 경로로 물질화 — **없을 때만**(라이브 로컬 기록을 덮지 않는다).
//  이어받기가 로컬 기록이 이미 있으면 그대로, 리핑/타지 유입이면 중앙본으로 채운다. 비격리 박스(공유 ~/.claude) 전제.
export async function materializeTranscriptIfMissing(cwd: string, sessionId: string, data: Buffer): Promise<boolean> {
  const dir = projectDirFor(cwd);
  const file = path.join(dir, `${sessionId}.jsonl`);
  try { await fsp.access(file); return false; }   // 이미 있음 → 안 건드림
  catch { /* 없음 → 물질화 */ }
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, data);
  return true;
}

// 사용자 질문이 아닌 '주입/노이즈' 메시지 — 슬래시커맨드 래퍼·태스크알림·시스템리마인더·caveat·중단표시 등.
const INJECTED_RE = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|\[Request interrupted|Caveat:|This session is being continued)/;
// 사용자가 보내고 esc 로 취소한 표식('[Request interrupted by user]' / '...for tool use'). 그 앞 턴을 폐기하는 신호.
const INTERRUPT_RE = /^\s*\[Request interrupted/;

// 한 세션(폴더)에서 **사람이 AI 에게 던진 질문 전부**를 시간순(오래된→최신)으로.
//  이전엔 '공유 ~/.claude 의 최신 jsonl 하나' = 그 폴더의 마지막 대화, 그것도 공유 트리에 있는 것만이라
//  같은 세션에서 오간 질문의 대부분이 누락됐다. 이제 (1) 공유 + 멤버 프로필 트리를 모두 훑고
//  (2) 그 폴더의 대화 파일을 전부 합친다. 각 질문엔 어느 프로필에서 왔는지(author=멤버 슬러그)를 달아
//  프론트가 '누가 물었는지'를 보여줄 수 있게 한다(공유 트리 출처는 author='').
//  접근통제는 라우트(canAttach)에서 — 여기선 파일만 읽는다. 실패·읽기불가 = 빈 결과(비치명).
export async function sessionPrompts(cwd: string, limit = 300): Promise<{ prompts: Prompt[]; total: number; found: boolean }> {
  if (!cwd) return { prompts: [], total: 0, found: false };
  const enc = path.basename(projectDirFor(cwd));
  // 후보 파일 수집(뿌리 × 그 폴더의 모든 jsonl) → 최근 수정순 상한.
  const cands: Array<{ file: string; author: string; mt: number }> = [];
  for (const root of await transcriptRoots()) {
    const dir = path.join(root.dir, enc);
    let names: string[];
    try { names = (await fsp.readdir(dir)).filter((f) => f.endsWith(".jsonl")); }
    catch { continue; }   // 이 뿌리엔 이 폴더의 대화가 없음
    for (const f of names) {
      try { const st = await fsp.stat(path.join(dir, f)); cands.push({ file: path.join(dir, f), author: root.author, mt: st.mtimeMs }); }
      catch { /* skip */ }
    }
  }
  if (!cands.length) return { prompts: [], total: 0, found: false };
  cands.sort((a, b) => b.mt - a.mt);
  const files = cands.slice(0, MAX_TRANSCRIPT_FILES);
  const out: Prompt[] = [];
  //  같은 대화가 두 뿌리에 있을 수 있다(이어받기 물질화 materializeTranscriptIfMissing) → (시각+본문)으로 중복 제거.
  const seen = new Set<string>();
  for (const f of files) {
    let raw: string;
    try { raw = await fsp.readFile(f.file, "utf8"); }
    catch { continue; }
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
      const ts = o.timestamp || "";
      const key = ts + "\u0000" + text;   // 리터럴 NUL 금지 — git 이 바이너리 취급하고 grep 이 파일을 통째로 건너뛴다
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text, ts, author: f.author });
    }
  }
  // 파일을 가로질러 합쳤으므로 시간순으로 다시 세운다(빈 timestamp 는 맨 앞).
  out.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
  const total = out.length;
  return { prompts: out.slice(-limit), total, found: true };
}

// 세션이력 웹뷰 렌더(#905 C1 슬⑤b) — 중앙에서 받은 트랜스크립트 JSONL **원문**을 사람이 읽을 항목으로 파싱한다.
//  "채널필터"(설계 §5 — 의미 있는 4.2%만): **사람 발화 + 어시스턴트 산문 + 툴콜 이름**만 남기고
//  툴결과·서명·토큰통계·주입노이즈는 버린다. 순수함수(파일·DB 무관) — 원문 문자열만 받아 단위검증 가능.
export interface TranscriptItem { role: "user" | "assistant" | "tool"; text: string; ts?: string; tool?: string }

// 툴 입력 한 줄 요약 — 흔한 필드(명령·경로·패턴) 우선, 없으면 첫 문자열 값. 길면 자른다(렌더 노이즈 억제).
function toolSummary(input: unknown): string {
  if (input == null) return "";
  const o = input as Record<string, unknown>;
  const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url ?? o.description;
  let s = typeof pick === "string" ? pick : "";
  if (!s) { for (const v of Object.values(o)) { if (typeof v === "string" && v.trim()) { s = v; break; } } }
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

// opts.includeSidechain — 서브에이전트 트랜스크립트(#905 C1 슬⑥)는 모든 줄이 isSidechain 이라, 그 파일을 렌더할 땐 포함해야 한다.
export function renderTranscript(jsonl: string, limit = 5000, opts?: { includeSidechain?: boolean }): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  let pendingUserIdx = -1;   // 진행 중 턴의 사람 발화 위치(out 내). 중단(esc)되면 여기부터 끝까지 폐기.
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.isMeta || (o.isSidechain && !opts?.includeSidechain)) continue;
    const ts: string = o.timestamp || "";
    if (o.type === "user") {
      const c = o.message && o.message.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.filter((x: any) => x && x.type === "text").map((x: any) => x.text || "").join("\n");
      text = (text || "").trim();
      // 취소된 턴 — 사용자가 보내고 esc 로 끊은 질문 + 그 부분답변을 통째로 버린다(재작성본만 남게, 사용자 요청).
      if (INTERRUPT_RE.test(text)) { if (pendingUserIdx >= 0) out.length = pendingUserIdx; pendingUserIdx = -1; continue; }
      // 그 외 주입/노이즈(슬래시·bash·리마인더)는 표시 안 하되 '이전 턴 종료' 경계로만 삼는다 — 뒤의 중단표식이
      //  이미 끝난 앞 턴을 잘못 지우지 않도록 pendingUserIdx 를 무효화(예: 완료턴 → bash 실행 → esc).
      if (!text || INJECTED_RE.test(text)) { pendingUserIdx = -1; continue; }
      pendingUserIdx = out.length;
      out.push({ role: "user", text, ts });
    } else if (o.type === "assistant") {
      const c = o.message && o.message.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ role: "assistant", text: b.text.trim(), ts });
        else if (b && b.type === "tool_use" && b.name) out.push({ role: "tool", tool: String(b.name), text: toolSummary(b.input), ts });
      }
    }
    if (out.length >= limit) break;
  }
  return out;
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

// 세션 대화 검색 — 순수 규칙(#4517, 원준 2026-09-30). DB·파일 무접촉이라 단위검증한다.
//  원준: «cmd+K 검색 안에 세션의 대화내용으로도 세션을 검색하고 싶어. 그리고 지금 완전 관련도 순으로만 나오는데
//   최신순이 아예 안 되더라. 슬랙 참고해서 고쳐 줘.»
//
//  ── 무엇을 찾나 ──
//  세션 대화 중 **사람이 한 말(지시)과 AI 가 한 말(답)** 만. 도구 호출·도구 결과·생각(thinking)·주입 메시지는 뺀다.
//   실측(2026-09-30, 이 박스 대화 파일 96개 1,068MB): 사람 말 0.63MB + AI 말 2.23MB = 원본의 0.27%. 나머지는 도구 결과다.
//   도구 결과까지 찾으면 «그 파일을 읽은 적 있는 세션» 이 전부 걸려 대화를 찾는 검색이 아니게 된다.
//
//  ── 슬랙에서 가져온 것(출처: slack.engineering «Search at Slack», docs.slack.dev search.messages) ──
//   · 최신순(Recent) = 모든 낱말이 든 메시지를 **시각 역순**으로. 관련도순(Relevant) = 일치 점수 + 메시지 나이 등으로.
//   · 슬랙 관련도 모델의 신호 첫째가 «메시지 나이» 다 — 그래서 관련도순에도 최근일수록 조금 얹는다(recencyBoost).
//   · «찾는 사람이 쓴 메시지인가» 도 신호다 — 사람 말(지시)과 내 세션에 조금 얹는다.
//  결과는 메시지가 아니라 **세션** 이다(원준: «대화내용으로 세션을 검색»). 한 세션에 맞은 메시지가 여럿이면 한 줄로
//   묶고, 대표 발췌문 하나와 맞은 수를 싣는다.
//
//  ── 2차(#4530, 원준 2026-10-01) — «어렴풋하게 쳐서 그 세션을 찾는다» ──
//   원준: «세션 내부의 대화 내용의 일부나 내가 그 세션에서 고쳤던 대상을 어렴풋하게 쳐서 그걸 가지고 내가 떠들던 세션을 찾고 싶은
//    경우에 많이 쓰이는데, 검색 퀄리티가 너무 형편없음» · «관련도가 적당히 있는 걸 시간순으로 보여 줘야지».
//   실측(원준 세션 80개에서 뽑은 질의 344개 · 매니지드): 낱말이 **서로 다른 말**에 있으면 1위 5% · 고친 파일 이름을 섞으면 2% ·
//    조사를 붙이면 4%. 종전 규칙이 «모든 낱말이 **한 말 안에**» 였고, 고친 대상은 색인에 없었고, 조사를 떼지 않았기 때문이다.
//   그래서 바꾼 것 셋:
//    ① 맞음의 단위를 **세션**으로 — 낱말마다 그 세션의 어느 자리(이름·첫 지시·프로젝트 이름·사람 말·AI 말·고친 파일)에든 있으면 된다.
//       한 말 안에 다 모여 있으면 더 맞는 것으로 친다(관련도에 얹는다).
//    ② 조사를 뗀 꼴로도 맞춘다(query-terms.ts) — «검색을» 이 «검색» 만 든 말과 맞는다.
//    ③ 고친 파일 경로를 색인한다(role 'edit') — 도구 결과 전체가 아니라 «무엇을 고쳤나» 한 줄만.
//   순서(슬랙 Recent + Top Results): 맨 위에 가장 맞는 것 셋, 그 아래는 **모든 낱말이 맞은 세션을 최근 것부터**.
//   같은 질의 시험에서 1위 47% → 98%, 흔한 낱말이 섞인 질의 240개에서 5위 안 16% → 98%.
import { INJECTED_RE } from "../terminal/terminal-transcript.js";
import type { ChatLine } from "../terminal/harness-io/chat-line.js";
import { termStrength, type QueryTerm } from "./query-terms.js";

/** 색인 한 줄의 자리 — 사람 말 · AI 말 · 고친 파일(#4530). */
export type ConvRole = "user" | "assistant" | "edit";
export interface ConvMsg { role: ConvRole; ts: string; text: string }

//  한 메시지를 색인에 담을 때의 상한. 회의 전사본을 통째로 붙여 넣고 끝에 «정리해 줘» 를 쓰는 일이 흔해서
//   앞만 남기면 정작 시킨 말이 잘린다 — 앞뒤를 함께 남긴다(chat-line.ts clipEnds 와 같은 판단, #762).
export const CONV_BODY_MAX = 20_000;
export function clipBody(text: string, max = CONV_BODY_MAX): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return text.slice(0, head) + "\n…\n" + text.slice(text.length - tail);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => !!b && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * 공통 ChatLine(하네스 어댑터가 번역한 모양) → 색인할 메시지. 순서는 입력 순서 그대로.
 *  · 사람 말 — user 줄의 text 블록. isMeta(주입)·isSidechain(서브에이전트)·주입 문구(INJECTED_RE)는 뺀다.
 *    tool_result 블록만 있는 user 줄은 text 가 비어 저절로 빠진다(도구 결과는 사람 말이 아니다).
 *  · AI 말 — assistant 줄의 text 블록만(thinking·tool_use 는 뺀다). 서브에이전트 가지는 뺀다.
 *  · 고친 파일(#4530) — assistant 줄의 파일 고치는 도구(EDIT_TOOLS)의 경로. role 'edit', 글은 경로 그대로.
 */
export function extractConvMessages(lines: ChatLine[]): ConvMsg[] {
  const out: ConvMsg[] = [];
  const seenEdit = new Set<string>();
  for (const l of lines) {
    if (!l || typeof l !== "object") continue;
    if (l.type === "user") {
      if (l.isMeta || l.isSidechain) continue;
      const text = textOf(l.message?.content).trim();
      if (!text || INJECTED_RE.test(text)) continue;
      out.push({ role: "user", ts: String(l.timestamp || ""), text: clipBody(text) });
    } else if (l.type === "assistant") {
      if (l.isSidechain) continue;
      const text = textOf(l.message?.content).trim();
      if (text) out.push({ role: "assistant", ts: String(l.timestamp || ""), text: clipBody(text) });
      //  고친 파일(#4530) — 사람은 «그 세션에서 omni.ts 고쳤던 거» 로 기억한다. 같은 묶음 안에서 같은 경로는 한 번만.
      for (const p of editedPaths(l.message?.content)) {
        if (seenEdit.has(p)) continue;
        seenEdit.add(p);
        out.push({ role: "edit", ts: String(l.timestamp || ""), text: p });
      }
    }
  }
  return out;
}

/** 파일을 고치는 도구 이름 — 클로드(Edit·Write·MultiEdit·NotebookEdit). 코덱스 어댑터도 파일 변경을 «Edit» 로 옮긴다(codex-app-server-events). */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** 경로 한 줄의 상한 — 이보다 길면 경로가 아니다(도구 입력이 깨진 것). */
const EDIT_PATH_MAX = 400;
/** assistant 블록에서 고친 파일 경로들. file_path(클로드)·notebook_path·paths[](코덱스) 를 본다. */
export function editedPaths(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content as Array<{ type?: unknown; name?: unknown; input?: unknown }>) {
    if (!b || b.type !== "tool_use" || typeof b.name !== "string" || !EDIT_TOOLS.has(b.name)) continue;
    const inp = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
    const cand = [inp.file_path, inp.notebook_path, ...(Array.isArray(inp.paths) ? inp.paths : [])];
    for (const c of cand) {
      const p = typeof c === "string" ? c.trim() : "";
      if (p && p.length <= EDIT_PATH_MAX && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** 모든 낱말이 들어 있나 — 슬랙 Recent 의 «match all terms». 대소문자 무시(호출자가 소문자로 넘긴다). */
export function hasAllTerms(textLower: string, terms: string[]): boolean {
  return terms.length > 0 && terms.every((t) => textLower.includes(t));
}

//  발췌문 — 첫 일치 앞을 조금 남기고 자른다. 목록 한 줄이 «왜 이 세션이 떴나» 를 글자로 말해야 한다.
//  ⚠ UTF-16 짝(이모지)을 가운데서 자르지 않는다 — 반쪽 글자는 화면에 �로 선다.
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
export function snippetAround(text: string, terms: string[], max = 140, lead = 36): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const low = flat.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = t ? low.indexOf(t) : -1; if (i >= 0 && (at < 0 || i < at)) at = i; }
  let start = at <= lead ? 0 : at - lead;
  let end = Math.min(flat.length, start + max);
  if (end - start < max) start = Math.max(0, end - max);
  if (start > 0 && isLowSurrogate(flat.charCodeAt(start))) start++;
  if (end < flat.length && isLowSurrogate(flat.charCodeAt(end))) end--;
  return (start > 0 ? "…" : "") + flat.slice(start, end).trim() + (end < flat.length ? "…" : "");
}

// ── 나이 가산 ──────────────────────────────────────────────────────────────────────────────
//  최근일수록 조금 얹는다(오늘 30 · 7일 15 · 30일 약 1.5). 세션 관련도(convRelevance)는 이 값의 1/5 만 쓴다 —
//   #4530 부터는 «최근 것부터» 가 기본 순서라 관련도에 나이를 크게 실을 까닭이 없다(맨 위 셋을 고르는 데만 거든다).
export const RECENCY_MAX = 30;
export const RECENCY_HALF_LIFE_DAYS = 7;
const DAY_MS = 86_400_000;
export function recencyBoost(tsMs: number, nowMs: number): number {
  if (!Number.isFinite(tsMs)) return 0;
  const ageDays = Math.max(0, nowMs - tsMs) / DAY_MS;   // 앞선 시계(미래)는 «지금» 으로 본다
  return RECENCY_MAX * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

export type ConvSort = "relevance" | "recent";
export const parseConvSort = (v: unknown): ConvSort => (v === "recent" ? "recent" : "relevance");

// ── 세션 단위 관련도(#4530) ───────────────────────────────────────────────────────────────
//  SQL(conv-index-store searchConversations)이 세션마다 «낱말 i 가 사람 말·AI 말·고친 파일 어디에, 그대로/조사 뗀 꼴로 들었나»,
//   «한 말에 함께 든 낱말 수의 최댓값», «맞은 말 수», «맞은 말 중 가장 늦은 시각» 을 모아 온다. 이름·첫 지시·프로젝트 이름은
//   여기서 잰다(세션마다 한 줄이라 싸다). 낱말마다 **가장 센 자리**의 세기를 잡고, 모든 낱말이 어딘가에 있어야 결과에 선다
//   (슬랙 Recent 의 «모든 낱말» 을 세션 단위로).

/** 자리별 무게 — 이름·첫 지시 > 사람 말 = 고친 파일 > AI 말 > 프로젝트 이름. 사람이 기억하는 건 제가 한 말과 고친 것이다. */
export const FIELD_WEIGHT = { name: 1.3, user: 1.0, edit: 1.0, assistant: 0.8, project: 0.6 } as const;
export type ConvField = keyof typeof FIELD_WEIGHT;

export interface ConvSessionAgg {
  node_id: string; session_id: string; owner: string | null;
  /** 사람·에이전트가 지은 이름 · 첫 지시(session.title) · 지금 묶인 프로젝트 이름. */
  label: string | null; title: string | null; project: string | null;
  /** 낱말 i 마다 사람 말·AI 말·고친 파일 자리의 세기(0 · 0.8 = 조사 뗀 꼴만 · 1 = 친 그대로). */
  strength: Array<{ user: number; assistant: number; edit: number }>;
  /** 한 말(사람·AI)에 함께 든 낱말 수의 최댓값. */
  maxCo: number;
  /** 모든 낱말이 함께 든 말 수. */
  coAll: number;
  /** 친 글 그대로 이어진 구절이 든 말이 있나(낱말 둘 이상일 때만 뜻이 있다). */
  phrase: boolean;
  /** 낱말이 하나라도 든 말·고친 파일 수. */
  hits: number;
  /** 맞은 것 중 가장 늦은 시각(ISO). 모르면 null. */
  lastHit: string | null;
}
export interface ConvRanked {
  agg: ConvSessionAgg;
  /** 관련도 — 세션끼리만 비교되는 값(화면은 순서로만 쓴다). */
  rel: number;
  /** 줄의 시각(ms) — 맞은 것 중 가장 늦은 때. 최신순의 축. */
  at: number | null;
  /** 맨 위 «가장 맞는 결과» 에 섰나(최신순일 때만 true 가 있다). */
  top: boolean;
  /** 낱말이 맞은 자리들 — 화면이 «이름 · 지시 · AI · 고친 파일» 로 보여 준다. */
  fields: ConvField[];
}

/** 세션 하나의 관련도. 모든 낱말이 어딘가에 있으면 all=true. */
export function convRelevance(a: ConvSessionAgg, terms: QueryTerm[], opts: { nowMs: number; requester?: string }): { all: boolean; rel: number; fields: ConvField[] } {
  const n = terms.length;
  if (!n) return { all: false, rel: 0, fields: [] };
  const nameLow = [a.label, a.title].filter(Boolean).join(" \n ").toLowerCase();
  const projLow = String(a.project || "").toLowerCase();
  const fields = new Set<ConvField>();
  let sum = 0, matched = 0;
  terms.forEach((t, i) => {
    const st = a.strength[i] || { user: 0, assistant: 0, edit: 0 };
    const cand: Array<[ConvField, number]> = [
      ["name", termStrength(nameLow, t)], ["project", termStrength(projLow, t)],
      ["user", st.user], ["assistant", st.assistant], ["edit", st.edit],
    ];
    let best = 0;
    for (const [f, v] of cand) { if (v > 0) { fields.add(f); best = Math.max(best, v * FIELD_WEIGHT[f]); } }
    if (best > 0) matched++;
    sum += best;
  });
  const co = n ? Math.min(1, a.maxCo / n) : 0;
  const lastMs = a.lastHit ? Date.parse(a.lastHit) : NaN;
  const rel = (sum / n) * 40                       // 낱말마다 가장 센 자리(이름에 든 낱말이 가장 무겁다)
    + co * co * 30                                  // 한 말에 함께 모여 있을수록
    + (a.coAll > 0 && n > 1 ? 10 : 0)               // 모든 낱말이 한 말에
    + (a.phrase && n > 1 ? 30 : 0)                  // 친 그대로 이어진 구절
    + 3 * Math.log2(1 + Math.max(0, a.hits))        // 여러 번 이야기한 세션
    + recencyBoost(lastMs, opts.nowMs) * 0.2        // 슬랙 관련도의 첫 신호 «나이» — 작게(최대 6)
    + (opts.requester && a.owner === opts.requester ? 2 : 0);
  return { all: matched === n, rel, fields: [...fields] };
}

/** 맨 위 «가장 맞는 결과» 의 수와 문턱 — 1등의 80% 이상만(멀리 떨어진 2·3등은 시각 순서 쪽에 둔다). */
export const CONV_TOP_MAX = 3;
export const CONV_TOP_RATIO = 0.8;

/**
 * 세션 집계 → 화면 순서.
 *  · 모든 낱말이 맞은 세션만 남긴다(관련도의 문턱).
 *  · relevance — 관련도 내림차순.
 *  · recent(기본, 슬랙 Recent + Top Results) — 맨 위에 관련도 앞 셋(1등의 80% 이상), 그 아래는 맞은 때가 늦은 것부터.
 */
export function rankConvAggs(aggs: ConvSessionAgg[], opts: { terms: QueryTerm[]; sort: ConvSort; nowMs: number; requester?: string; limit: number }): ConvRanked[] {
  const rows: ConvRanked[] = [];
  for (const a of aggs) {
    const r = convRelevance(a, opts.terms, opts);
    if (!r.all) continue;
    const ms = a.lastHit ? Date.parse(a.lastHit) : NaN;
    rows.push({ agg: a, rel: r.rel, at: Number.isFinite(ms) ? ms : null, top: false, fields: r.fields });
  }
  const atOf = (x: ConvRanked): number => (x.at == null ? -Infinity : x.at);
  const byRel = [...rows].sort((x, y) => y.rel - x.rel || atOf(y) - atOf(x));
  const limit = Math.max(0, opts.limit);
  if (opts.sort === "relevance") return byRel.slice(0, limit);
  const top = byRel.slice(0, CONV_TOP_MAX).filter((x, i) => i === 0 || x.rel >= byRel[0].rel * CONV_TOP_RATIO);
  for (const x of top) x.top = true;
  const rest = rows.filter((x) => !x.top).sort((x, y) => atOf(y) - atOf(x) || y.rel - x.rel);
  return [...top, ...rest].slice(0, limit);
}

/** 대표 발췌문에서 색칠·자를 낱말 — 친 그대로와 조사 뗀 꼴 둘 다. */
export function snippetTerms(terms: QueryTerm[]): string[] {
  const out: string[] = [];
  for (const t of terms) { out.push(t.t); if (t.stem !== t.t && t.stem.length >= 2) out.push(t.stem); }
  return out;
}

/** 고친 파일 경로 → 화면에 보일 꼴(파일 이름 + 바로 위 폴더). */
export function editLabel(path: string): string {
  const parts = String(path || "").split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join("/");
}

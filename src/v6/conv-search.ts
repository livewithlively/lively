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
import { INJECTED_RE, scoreText, queryTerms } from "../terminal/terminal-transcript.js";
import type { ChatLine } from "../terminal/harness-io/chat-line.js";

export type ConvRole = "user" | "assistant";
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
 */
export function extractConvMessages(lines: ChatLine[]): ConvMsg[] {
  const out: ConvMsg[] = [];
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
      if (!text) continue;
      out.push({ role: "assistant", ts: String(l.timestamp || ""), text: clipBody(text) });
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

// ── 관련도 ────────────────────────────────────────────────────────────────────────────────
//  메시지 점수 = scoreText(경계·빈도·근접·정확 구절 — 종전 질문 검색과 같은 자) + 사람 말 가산.
//  세션 점수 = 가장 잘 맞은 메시지 + 맞은 수(로그) + 최근 가산 + 내 세션 가산.
//  ⚠ 최근 가산의 크기: 한 낱말 질의의 만점(10+5+3=18, 사람 말이면 26)과 맞먹게 두었다(오늘 30 · 7일 15 · 30일 약 1.5).
//   그래서 한 낱말로 찾으면 **최근에 말한 세션이 위로** 오고, 여러 낱말이 구절 그대로 맞은 세션(+50)은 오래됐어도 위에 남는다.
export const USER_MSG_BONUS = 8;
export const OWN_SESSION_BONUS = 4;
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

export interface ConvRow {
  node_id: string; session_id: string; role: ConvRole; ts: string | null; body: string;
  owner: string | null;
}
export interface ConvSessionHit {
  node_id: string; session_id: string; owner: string | null;
  /** 이 세션에서 모든 낱말이 든 메시지 수(조회 상한 안에서). */
  hits: number;
  /** 맞은 메시지 중 가장 늦은 시각(ISO) — 최신순의 축이자 화면의 시각. 모르면 null. */
  at: string | null;
  /** 대표 메시지 — 관련도순이면 가장 잘 맞은 것, 최신순이면 가장 늦은 것. text 는 발췌문. */
  best: { role: ConvRole; ts: string | null; text: string };
  score: number;
}

const tsMsOf = (ts: string | null | undefined): number => { const n = ts ? Date.parse(ts) : NaN; return Number.isFinite(n) ? n : NaN; };

/** 메시지 행(모든 낱말이 든 것) → 세션 줄. 순서는 sort 가 정한다. rows 는 SQL 이 이미 좁혀 온 것이지만 여기서도 다시 잰다. */
export function rankConvSessions(rows: ConvRow[], opts: { q: string; sort: ConvSort; nowMs: number; requester: string; limit: number }): ConvSessionHit[] {
  const terms = queryTerms(opts.q);
  if (!terms.length) return [];
  const phrase = opts.q.trim().toLowerCase();
  interface Acc { hit: ConvSessionHit; bestScore: number; bestMs: number; bestRow: ConvRow; lastMs: number; lastRow: ConvRow }
  const by = new Map<string, Acc>();
  for (const r of rows) {
    const low = String(r.body || "").toLowerCase();
    if (!hasAllTerms(low, terms)) continue;
    const s = scoreText(low, terms, phrase).score + (r.role === "user" ? USER_MSG_BONUS : 0);
    const ms = tsMsOf(r.ts);
    const key = r.node_id + "\u0001" + r.session_id;
    const a = by.get(key);
    if (!a) {
      by.set(key, {
        hit: { node_id: r.node_id, session_id: r.session_id, owner: r.owner, hits: 1, at: null, best: { role: r.role, ts: r.ts, text: "" }, score: 0 },
        bestScore: s, bestMs: ms, bestRow: r, lastMs: ms, lastRow: r,
      });
      continue;
    }
    a.hit.hits++;
    //  같은 점수면 더 늦은 말을 대표로 — 사람은 최근 대화를 더 잘 기억한다.
    if (s > a.bestScore || (s === a.bestScore && (ms > a.bestMs || (!Number.isFinite(a.bestMs) && Number.isFinite(ms))))) { a.bestScore = s; a.bestMs = ms; a.bestRow = r; }
    if (ms > a.lastMs || (!Number.isFinite(a.lastMs) && Number.isFinite(ms))) { a.lastMs = ms; a.lastRow = r; }
  }
  const out: ConvSessionHit[] = [];
  for (const a of by.values()) {
    const rep = opts.sort === "recent" ? a.lastRow : a.bestRow;
    a.hit.at = Number.isFinite(a.lastMs) ? new Date(a.lastMs).toISOString() : null;
    a.hit.best = { role: rep.role, ts: rep.ts, text: snippetAround(rep.body, terms) };
    a.hit.score = a.bestScore
      + 6 * Math.log2(1 + a.hit.hits)
      + recencyBoost(a.lastMs, opts.nowMs)
      + (opts.requester && a.hit.owner === opts.requester ? OWN_SESSION_BONUS : 0);
    out.push(a.hit);
  }
  const atMs = (h: ConvSessionHit): number => { const n = tsMsOf(h.at); return Number.isFinite(n) ? n : -Infinity; };
  out.sort(opts.sort === "recent"
    ? (x, y) => atMs(y) - atMs(x) || y.score - x.score
    : (x, y) => y.score - x.score || atMs(y) - atMs(x));
  return out.slice(0, Math.max(0, opts.limit));
}

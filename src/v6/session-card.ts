// v6/session-card.ts — 세션 요약 카드(#4530 검색 품질 «뜻으로 찾기», 원준 2026-10-05 «결국 세션을 해야함 … 다를 전부 하도록»).
//
//  왜 — 세션은 글자가 맞아야만 찾혔다. 사람은 «세션 지우면 깜빡거리던 거» 처럼 **다른 말로** 기억한다(매니지드 실측: 어렴풋한 말 15개 중
//   세션은 7개만 5위 안, 같은 말로 지식을 뜻 검색하면 13개). 지식·프로젝트에는 뜻 검색(임베딩)이 있는데 세션에는 없었다.
//  무엇을 — 세션마다 «이 세션이 무엇이었나» 를 한 덩이 글로 만든다. 그 글을 임베딩해 검색어의 뜻과 견준다(v6/session-card-store.ts).
//   재료는 대화 색인(session_msg)에 이미 있는 것뿐이다: 세션 이름 · 프로젝트 · **사람이 한 말** · 고친 파일 · 마지막 답.
//   사람이 한 말이 세션의 주제를 가장 잘 말한다(AI 말은 서너 배 길고 곁가지가 많다). 마지막 답은 «무엇을 했나» 의 요약인 때가 많다.
//  AI 로 요약을 따로 만들지 않는다 — 서버에는 AI 를 부르는 길이 열려 있지 않고(키 없음), 있는 글을 모으는 것만으로 뜻 검색의 재료가 된다.
//   요약을 만들 길이 생기면 이 카드의 맨 위에 한 줄 얹으면 된다(CARD_VER 를 올려 다시 만든다).
//
//  순수 함수(DB 무접촉) — 시험이 그대로 부른다.

/** 카드 글의 판 — 만드는 규칙이 바뀌면 올린다(정비가 옛 카드를 다시 만든다). */
import { redactTokenShapes } from "../org/ingest/redact.js";

export const CARD_VER = 2;
/** 카드 전체의 글자 상한 — 임베딩 입력 상한(8,000자) 안쪽. */
export const CARD_MAX = 6000;
const FIRST_MAX = 700;      // 처음 시킨 말
const SAID_MAX = 260;       // 이어서 한 말 하나
const LAST_MAX = 500;       // 마지막 답
const FILES_MAX = 40;       // 고친 파일 수
const SAID_MIN = 6;         // 이보다 짧은 말(«응» · «ㅇㅋ»)은 주제를 말하지 않는다

export interface CardMsg { role: "user" | "assistant" | "edit"; text: string }
export interface CardInput {
  /** 사람·에이전트가 지은 이름(없으면 첫 지시에서 뽑은 이름). */
  name?: string | null;
  project?: string | null;
  /** 대화 순서의 말들 — 사람 말 · 고친 파일(경로 끝 세 마디). AI 말은 마지막 것 하나만 쓴다. */
  msgs: CardMsg[];
  /** 마지막 AI 말(따로 읽어 넘길 수 있다 — msgs 에 AI 말을 싣지 않아도 되게). */
  lastAnswer?: string | null;
}

const flat = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max).trimEnd() + "…" : s);
/** 경로 끝 두 마디 — 화면에 보이는 꼴(conv-search editLabel 과 같다). */
const fileLabel = (p: string): string => p.split(/[\\/]+/).filter(Boolean).slice(-2).join("/");

/**
 * 카드 글. 사람이 한 말이 하나도 없으면 빈 글(그런 세션은 카드를 만들지 않는다).
 *  말이 많아 상한을 넘으면 **앞쪽 절반과 뒤쪽 절반**을 남긴다 — 세션은 처음에 주제를 말하고 끝에 마무리를 말한다.
 */
/**
 * 세션 요약 카드. 사람이 한 말이 없으면 빈 글.
 *  ⚠ 카드 글은 임베딩 서버로 나간다(벡터를 받으려고) — 대화에 붙여 넣은 토큰·키가 섞여 있을 수 있어 **토큰 모양은 가린다**
 *   (redactTokenShapes — 산문은 건드리지 않고 값 자체가 토큰 모양인 것만). 격리 리뷰.
 */
export function buildSessionCard(input: CardInput): string {
  return redactTokenShapes(buildCardRaw(input));
}
function buildCardRaw(input: CardInput): string {
  const said: string[] = [];
  const files: string[] = [];
  let last = flat(input.lastAnswer);
  for (const m of input.msgs || []) {
    if (m.role === "user") { const t = flat(m.text); if (t) said.push(t); }
    else if (m.role === "edit") { const f = fileLabel(flat(m.text)); if (f && !files.includes(f)) files.push(f); }
    else if (m.role === "assistant" && !input.lastAnswer) { const t = flat(m.text); if (t) last = t; }
  }
  if (!said.length) return "";
  const head: string[] = [];
  const name = flat(input.name);
  if (name) head.push("세션 이름: " + clip(name, 120));
  const project = flat(input.project);
  if (project) head.push("프로젝트: " + clip(project, 120));
  head.push("처음 시킨 말: " + clip(said[0]!, FIRST_MAX));
  const tail: string[] = [];
  if (files.length) tail.push("고친 파일: " + files.slice(0, FILES_MAX).join(", "));
  if (last) tail.push("마지막 답: " + clip(last, LAST_MAX));
  //  이어서 한 말 — 짧은 맞장구와 같은 말의 되풀이는 뺀다.
  const rest: string[] = [];
  for (const t of said.slice(1)) {
    if (t.length < SAID_MIN) continue;
    const c = clip(t, SAID_MAX);
    if (!rest.includes(c)) rest.push(c);
  }
  const fixed = head.join("\n").length + tail.join("\n").length + 20;
  let budget = Math.max(0, CARD_MAX - fixed);
  const pick = (xs: string[], room: number): string[] => { const out: string[] = []; let used = 0; for (const x of xs) { if (used + x.length + 3 > room) break; out.push(x); used += x.length + 3; } return out; };
  let middle: string[];
  const total = rest.reduce((n, x) => n + x.length + 3, 0);
  if (total <= budget) middle = rest;
  else {
    const front = pick(rest, Math.floor(budget / 2));
    budget -= front.reduce((n, x) => n + x.length + 3, 0);
    const back = pick([...rest.slice(front.length)].reverse(), budget).reverse();
    middle = [...front, ...back];
  }
  const lines = [...head];
  if (middle.length) lines.push("이어서 한 말: " + middle.join(" / "));
  lines.push(...tail);
  return lines.join("\n").slice(0, CARD_MAX);
}

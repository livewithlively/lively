// 파서 상태 이어달리기 (#1746) — 화면은 창(window)마다 요청하는데, 어떤 하네스(antigravity 의 도구 짝짓기 등)는 줄 사이 상태가 있다.
//  창의 끝(to)에서 파서 상태를 잠깐 기억해 두고, 다음 요청의 from 이 그 to 와 같으면 이어 쓴다. 안 맞으면(꼬리부터 새로 열기·위로 읽기)
//  빈 상태에서 시작한다 — 그 창의 첫머리에서 짝을 못 찾는 결과가 조금 있을 뿐, 틀린 짝은 만들지 않는다.
//  키 = 소스(세션·파일) + 오프셋. 작은 LRU + TTL — 잊혀도 무해(다음 창이 빈 상태로 시작한다).
import type { ParseState } from "./chat-line.js";

const MAX = 512;
const TTL_MS = 15 * 60_000;
const cache = new Map<string, { state: ParseState; at: number }>();

export function parseStateAt(source: string, offset: number): ParseState {
  const k = `${source}|${offset}`;
  const hit = cache.get(k);
  if (!hit) return {};
  if (Date.now() - hit.at > TTL_MS) { cache.delete(k); return {}; }
  return hit.state;
}

export function rememberParseState(source: string, offset: number, state: ParseState): void {
  const k = `${source}|${offset}`;
  cache.delete(k);
  cache.set(k, { state, at: Date.now() });
  while (cache.size > MAX) { const first = cache.keys().next().value; if (first === undefined) break; cache.delete(first); }
}

/** 창 하나를 파싱하고 상태를 잇는다 — 라우트가 이것만 부른다. 상태 없는 파서(claude)도 같은 경로(빈 상태 왕복). */
export function parseWindow(
  parse: (text: string, state: ParseState) => { lines: import("./chat-line.js").ChatLine[]; state: ParseState },
  source: string, from: number, to: number, text: string,
): import("./chat-line.js").ChatLine[] {
  const r = parse(text, parseStateAt(source, from));
  rememberParseState(source, to, r.state);
  return r.lines;
}

// 액자(클래식 화면) → 셸 «이 주소의 탭을 열어 줘» 메시지(`lively:open-route`) — 보내는 쪽과 받는 쪽이 한 모양을 쓴다(#4906, 순수).
//
//  세션 주소(`#/s/<id>`)면 그 세션의 **첫 지시**를 함께 싣는다. 프로젝트 보드(액자)의 [세션 열기]가 만든 세션의 첫 지시는 액자 문서의
//  기억(v2/quick-session.ts firstPrompts)에만 있고, 셸 문서는 그것을 못 읽는다 — 문서마다 모듈이 따로다. 그래서 그 세션 화면이
//  첫 지시를 몰라 #4794 의 «숨겨 붙였다가 그 말이 실제로 제출된 뒤 터미널로» 를 못 타고 빈 터미널부터 보였다.
//  셸은 받은 첫 지시를 탭을 열기 **전에** 제 기억에 옮기고(rememberFirstPrompt), 세션 화면이 마운트될 때 꺼내 쓴다(v2/views.ts).
export const OPEN_ROUTE = 'lively:open-route';
/** 받아 둘 첫 지시의 상한 — 서버의 첫 지시(사람 글 20,000자 + 태스크 머리)보다 넉넉하다. 넘으면 기억하지 않는다(자른 글은 맞추기를 빗나가게 한다). */
export const FIRST_PROMPT_MAX = 64_000;

export interface OpenRouteMsg { type: typeof OPEN_ROUTE; href: string; firstPrompt?: string }

/** 보내는 쪽 — 첫 지시가 없거나 비었으면 싣지 않는다(종전 모양 그대로). */
export function openRouteMsg(href: string, firstPrompt?: string | null): OpenRouteMsg {
  return typeof firstPrompt === 'string' && firstPrompt.trim() ? { type: OPEN_ROUTE, href, firstPrompt } : { type: OPEN_ROUTE, href };
}

/** 받는 쪽 — 세션 주소에 실린 첫 지시면 { sid, text }, 아니면 null(세션 주소 아님 · 첫 지시 없음 · 문자열 아님 · 공백뿐 · 상한 넘음). */
export function openRouteFirstPrompt(m: unknown): { sid: string; text: string } | null {
  const o = (m && typeof m === 'object') ? m as Record<string, unknown> : null;
  if (!o || o.type !== OPEN_ROUTE || typeof o.href !== 'string') return null;
  const hit = /^#\/s\/([^/?#]+)/.exec(o.href);
  if (!hit) return null;
  let sid = '';
  try { sid = decodeURIComponent(hit[1]); } catch { return null; }
  const text = o.firstPrompt;
  if (!sid || typeof text !== 'string' || !text.trim() || text.length > FIRST_PROMPT_MAX) return null;
  return { sid, text };
}

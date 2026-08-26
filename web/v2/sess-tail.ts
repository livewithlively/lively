// v2/sess-tail.ts — 세션 대화 **꼬리**를 읽는 한 자리(#2016 6차). 세션 카드(panes-parts)와 사이드바 둘째 줄
//  (last-ask)이 같은 길로 같은 파일을 읽으므로, 그 길의 집을 **되짚지 않는 리프**로 내렸다 —
//  이전엔 last-ask 가 panes-parts 를 물어 last-ask → panes-parts → side → last-ask 순환이 났다.
//  ndjson 은 공통 ChatLine(src/terminal/harness-io/chat-line.ts) — 박스 파일이든 중앙 기록이든 파서 하나로 읽힌다.
import { apiUrl } from '../core.js';
import { authHeaders } from './panes-kit.js';
import type { Sess } from './views.js';

export interface Turn { who: 'me' | 'ai'; text: string }
const INJ_RE = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|\[Request interrupted|Caveat:|This session is being continued)/;

const tailCache = new Map<string, { turns: Turn[]; prompts: string[]; ok: boolean; at: number }>();

/** 대화 꼬리를 읽을 자리들 — 앞에서부터 시도해 처음 글이 나오는 곳을 쓴다(#2016 6차에 좌표 후보로 넓힘).
 *  ① 이 박스에서 도는 세션은 박스의 대화 파일 ② 중앙 기록(#1752) — 좌표는 **(노드, 대화 uuid)**. 둘 다 공통 ChatLine
 *  ndjson 을 준다(src/terminal/harness-io/chat-line.ts) — 아래 파서 하나로 읽힌다.
 *  ⚠ uuid 는 접힌 기록(logId)이 없어도 터미널 행의 claudeSessionId 로 안다 — v6 목록이 200행에서 잘려 오래된 세션은
 *   logId 가 비어 있고, 그때 `box-…` id 로 물으면 200/0바이트, 박스 파일 경로는 409 'node' 였다(dev 실측 2026-08-26). */
function tailUrls(s: Sess, maxBytes: number): string[] {
  const urls: string[] = [];
  if (s.live && !s.node) urls.push('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '/transcript?tail=' + maxBytes);
  const raw: any = s.raw || {};
  const uuid = String(s.logId || raw.claudeSessionId || raw.chatId || '');
  const node = String(s.logNode ?? s.node ?? '');
  const log = (sid: string, nd: string): string =>
    '/api/ui/v6/sessions/' + encodeURIComponent(sid) + '/log?fmt=chat&tail=' + maxBytes + '&node=' + encodeURIComponent(nd);
  if (uuid) urls.push(log(uuid, node));
  if (uuid && node) urls.push(log(uuid, ''));   // 노드 표식이 어긋나 있어도 게이트웨이 박스 좌표('')에 있을 수 있다
  if (!uuid && s.id) urls.push(log(s.id, node));
  return urls;
}

/** 대화 꼬리(ChatLine ndjson → 나/AI 턴). 사이드바 둘째 줄(last-ask.ts)도 이 길로 '내 마지막 말'을 받는다. */
export async function fetchTurns(s: Sess, maxBytes: number): Promise<Turn[]> { return (await fetchTail(s, maxBytes)).turns; }
/** 내가 마지막으로 시킨 말(#2016 6차) — 클로드 코드가 대화 파일에 남기는 `last-prompt` 레코드가 정본(세션 id 가 붙어 있어
 *  같은 폴더의 다른 세션과 섞이지 않는다). 없으면(코덱스 등) 사람 텍스트 턴의 마지막 것. 둘 다 없으면 null. */
export async function fetchLastAsk(s: Sess, maxBytes: number): Promise<{ text: string | null; ok: boolean }> {
  const t = await fetchTail(s, maxBytes);
  //  "y"·"r" 같은 한두 글자 답은 질문이 아니다 — 그 앞의 제대로 된 말을 쓴다(없으면 그거라도).
  const pick = (arr: string[]): string | null => [...arr].reverse().find((x) => x.length >= 4) || arr[arr.length - 1] || null;
  const text = pick(t.prompts) || pick(t.turns.filter((x) => x.who === 'me').map((x) => x.text));
  return { text, ok: t.ok };
}
async function fetchTail(s: Sess, maxBytes: number): Promise<{ turns: Turn[]; prompts: string[]; ok: boolean }> {
  const hit = tailCache.get(s.id);
  if (hit && Date.now() - hit.at < 7000 && hit.turns.length) return hit;
  let got = { turns: [] as Turn[], prompts: [] as string[] };
  let ok = false;
  for (const url of tailUrls(s, maxBytes)) {
    try {
      const res = await fetch(apiUrl(url), { headers: authHeaders(), credentials: 'same-origin' });
      if (!res.ok) continue;
      ok = true;
      got = parseTurns(await res.text());
      if (got.turns.length || got.prompts.length) break;   // 글이 나온 자리가 정답 — 빈 200(좌표 어긋남)은 다음 후보로
    } catch (_) { /* 못 읽으면 다음 후보 — 다 실패하면 카드는 상태만 보여 준다 */ }
  }
  const entry = { ...got, ok, at: Date.now() };
  tailCache.set(s.id, entry);
  return entry;
}
function parseTurns(text: string): { turns: Turn[]; prompts: string[] } {
  const turns: Turn[] = [];
  const prompts: string[] = [];   // 클로드 코드 last-prompt 레코드들 — 파일 순서 = 시간 순서
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.isSidechain || o.isMeta) continue;
    //  클로드 코드의 `{"type":"last-prompt","lastPrompt":"…","sessionId":…}` — 사람이 친 마지막 말을 하네스가 스스로 적어 둔다.
    //  카드의 턴 목록엔 넣지 않는다(같은 말이 user 줄로도 있으므로 두 번 뜬다) — 둘째 줄(last-ask.ts)만 쓴다.
    if (o.type === 'last-prompt') { const lp = String(o.lastPrompt || '').replace(/\s+/g, ' ').trim(); if (lp && !INJ_RE.test(lp)) prompts.push(lp); continue; }
    const c = o.message?.content;
    if (o.type === 'user') {
      const txt = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text || '')).join(' ') : '').replace(/\s+/g, ' ').trim();
      if (txt && !INJ_RE.test(txt)) turns.push({ who: 'me', text: txt });
    } else if (o.type === 'assistant') {
      const txt = (Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text || '')).join('\n') : '').trim();
      if (!txt) continue;
      const last = turns[turns.length - 1];
      if (last && last.who === 'ai') last.text = txt;
      else turns.push({ who: 'ai', text: txt });
    }
  }
  return { turns, prompts };
}

// v2/liv-open.ts — 리브에게 일을 맡기는 화면 쪽 문 한 벌(#4970 «리브 = 세션 하나»). 서버 문은 me_liv_open(POST /api/ui/me/liv/open).
//
//  입구는 하나, 일감만 다르다 — 레일 [리브](점검) · 처음 설정 [연결할게요] · [외부 앱 연결] [연결 도와줘](외부 앱 연결) ·
//   리브 칸·리브 화면의 [제가 해 드릴게요](그 카드의 말)가 모두 여기로 온다.
//  · 리브 세션이 없으면 서버가 그 말로 연다 → 세션 화면이 첫 지시를 먼저 그릴 수 있게 남긴다(quick-session 과 같은 길).
//  · 있으면 서버가 그 세션에 말을 넣는다 → 못 넣었으면(멈춘 세션 등) 그 말을 입력칸에 돌려 둔다 — 보내면 대화창이 되살리며 넣는다.
//  · 로그인한 AI 가 없으면 ai:false — 부르는 쪽이 «쓰는 AI 에서 하기» 를 그린다.
//  리브 세션 id 도 여기 둔다 — 셸이 어떤 세션이 리브 세션인지(오른쪽 «리브» 칸 · 물음 자리) 알아보는 재료다(보기는 #4940 부터 일반 세션).
import { api } from '../core.js';
import { rememberCreated } from './created-cache.js';
import { rememberFirstPrompt, rememberUnsentDraft } from './quick-session.js';
import { putIntoSession } from './sess-input.js';

/** delivered — 그 말이 리브 세션에 들어갔나(새로 열었으면 첫 지시라 참). 거짓이면 그 말은 그 세션 입력칸에 담아 두었다(아래 openLiv).
 *  reason(ai:false) — 'no-session' 은 onlyExisting 인데 리브 세션이 없다 · 그 밖은 로그인된 AI 가 없다. */
export type LivOpen = { ai: true; href: string; sessionId: string; created: boolean; delivered: boolean } | { ai: false; reason?: string };

/**
 * 리브에게 일을 맡긴다. 실패는 던진다 — 부르는 쪽이 사람에게 이유를 말한다.
 *  onlyExisting — 있는 리브 세션에만 넣는다(카드의 맞장구가 새 리브 세션의 첫 지시가 되지 않게).
 *  못 넣었으면(멈춘 세션) 그 말을 **그 세션 입력칸**에 담는다: 그 세션 화면이 어느 탭에든 떠 있으면 지금 그 입력칸에(숨은 탭도 화면이 살아 있다),
 *   안 떠 있으면 다음에 열 때 입력칸으로 돌아오게 남긴다. 보내면 대화창이 세션을 되살리며 넣는다(격리 리뷰 — 열린 화면은 다시 그려지지 않아
 *   남겨 둔 글을 안 읽는다).
 */
export async function openLiv(body: { job?: 'liv' | 'connect'; text?: string; onlyExisting?: boolean; fromWelcome?: boolean }): Promise<LivOpen> {
  //  fromWelcome(#5060) — 처음 설정의 [연결할게요]. 서버가 이 세션을 «연결을 마치면 정리 지시(2턴)를 받을 대화» 로 묶는다.
  const payload = { job: body.job, text: body.text, ...(body.onlyExisting ? { only_existing: true } : {}), ...(body.fromWelcome ? { from: 'welcome' } : {}) };
  const r: any = await api('/api/ui/me/liv/open', { method: 'POST', body: JSON.stringify(payload) });
  if (!(r && r.ai === true && r.session_id)) return { ai: false, reason: r && r.reason ? String(r.reason) : undefined };
  const id = String(r.session_id);
  rememberLivSessionId(id);
  try {
    if (r.created) {
      rememberCreated(r.session);
      if (r.initialPrompt) rememberFirstPrompt(id, String(r.initialPrompt));
    } else if (r.delivered === false && r.text) {
      if (!putIntoSession([id], String(r.text))) rememberUnsentDraft(id, String(r.text));
    }
  } catch (_) { /* 비치명 — 화면은 목록이 오면 그린다 */ }
  return { ai: true, href: String(r.href || `#/s/${encodeURIComponent(id)}`), sessionId: id, created: !!r.created, delivered: !!r.created || r.delivered !== false };
}

// ── 리브 세션 id ──────────────────────────────────────────────────────────────
//  셸이 세션 화면을 그릴 때마다 묻지 않게 잠깐 기억한다. 새로 열었거나 맡겼으면 그 응답이 곧 정답이다(rememberLivSessionId).
const TTL_MS = 30_000;
let cached: { id: string | null; at: number } | null = null;
let inflight: Promise<string | null> | null = null;

export function rememberLivSessionId(id: string | null): void { cached = { id: id || null, at: Date.now() }; }
/** 기억해 둔 리브 세션 id(물어보지 않는다) — 그림을 그리는 그 순간에 쓴다. 모르면 null. */
export function knownLivSessionId(): string | null { return cached ? cached.id : null; }
/** 리브 세션 id — o.fresh 면 기억을 건너뛰고 서버에 묻는다. 못 물으면 기억한 값(없으면 null). */
export async function livSessionId(o: { fresh?: boolean } = {}): Promise<string | null> {
  //  묻는 중이면 그 답을 기다린다 — 되살리기 뒤 새로 묻는 중(resumedInTab)에 셸이 기억한 옛 id 로 그리지 않게.
  if (inflight) return inflight;
  if (!o.fresh && cached && Date.now() - cached.at < TTL_MS) return cached.id;
  inflight = api('/api/ui/me/liv/session')
    .then((r: any) => { const id = r && r.session_id ? String(r.session_id) : null; rememberLivSessionId(id); return id; })
    .catch(() => (cached ? cached.id : null))
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * 리브 세션 id 를 **잠깐만** 기다린다 — 세션 화면을 그리기 전에 «이 세션이 리브 세션인가» 를 알아야 하지만(물음 자리 · 곁칸 «리브»),
 *  그 물음이 느리면 화면 전체가 빈 채로 선다(#3537 이 걷어낸 흰 화면과 같은 꼴 — 격리 리뷰). ms 가 지나면 기억한 값으로 간다.
 */
export async function livSessionIdWithin(ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<string | null>((res) => { timer = setTimeout(() => res(knownLivSessionId()), ms); });
  try { return await Promise.race([livSessionId(), late]); }
  finally { if (timer) clearTimeout(timer); }
}

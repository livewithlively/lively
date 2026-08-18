// v2/quick-session.ts — 홈 입력창에서 **프로젝트를 묻지 않고** 세션을 연다 (#1719).
//  Enter → POST terminal/sessions { sessionDir: true, initialPrompt } → 세션 대화 화면(#/s/<id>)으로.
//   · sessionDir — cwd 는 세션 전용 폴더(<개인 루트>/sessions/<id>). 프로젝트는 나중에 언제든 붙인다(우측 '이 세션' ▸ 프로젝트).
//   · initialPrompt — 서버가 하네스 입력창이 뜬 뒤 넣는다(session-first-prompt.ts). 화면은 낙관적으로 그 턴을 먼저 그린다.
//  하네스·모델 플래그·자동 승인은 클래식 '새 AI 세션' 폼이 기억해 둔 마지막 값을 그대로 쓴다(같은 localStorage 키 —
//  terminal/session-form.ts termCreatePrefs). 없으면 claude 기본.
import { api, state, toast } from '../core.js';

// terminal/session-form.ts 의 저장 키와 같다(사용자별 → 옛 전역 키 폴백). 그 모듈을 import 하지 않는 이유: v2 → terminal 폼 방향의
//  런타임 의존을 만들지 않으려고(check-imports 순환 게이트) — 키 규약만 공유한다.
const PREFS_KEY = 'lively_term_create_prefs';
function createPrefs(): { harness?: string; flags?: Record<string, unknown>; autoApprove?: boolean } {
  try {
    const me = state.me || {};
    const raw = localStorage.getItem(PREFS_KEY + '::' + (me.userId || me.email || 'anon')) || localStorage.getItem(PREFS_KEY) || '{}';
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : {};
  } catch { return {}; }
}

/** 이 화면이 만든 세션의 첫 지시 — 세션 화면이 마운트될 때 꺼내 낙관적으로 그린다(서버가 실제 주입). */
const firstPrompts = new Map<string, string>();
export function takeFirstPrompt(sessionId: string): string | null {
  const t = firstPrompts.get(sessionId) ?? null;
  firstPrompts.delete(sessionId);
  return t;
}

/** 라벨 = 첫 지시의 앞부분(문장부호·개행 정리). 서버 cleanLabel 이 한 번 더 다듬는다. */
export function labelFromPrompt(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim().replace(/[.。!?？…]+$/, '');
  return one.length > 28 ? one.slice(0, 27) + '…' : one;
}

let creating = false;
export function isCreatingQuickSession(): boolean { return creating; }

/**
 * 프로젝트 없는 세션을 열고 그 화면으로 간다. 실패하면 toast 로 이유를 말하고 false(입력은 호출자가 돌려준다).
 */
export async function openQuickSession(text: string): Promise<boolean> {
  const t = String(text || '').trim();
  if (!t || creating) return false;
  creating = true;
  try {
    const p = createPrefs();
    const harness = p.harness && p.harness !== 'shell' ? p.harness : 'claude';
    const out: any = await api('/api/ui/terminal/sessions', {
      method: 'POST',
      body: JSON.stringify({
        label: labelFromPrompt(t), harness, flags: p.flags && typeof p.flags === 'object' ? p.flags : {},
        autoApprove: !!p.autoApprove, sessionDir: true, initialPrompt: t,
      }),
    });
    const id = out && out.session && out.session.id ? String(out.session.id) : '';
    if (!id) throw new Error('세션 id 를 받지 못했습니다');
    firstPrompts.set(id, t);
    location.hash = '#/s/' + encodeURIComponent(id);
    return true;
  } catch (e: any) {
    toast('세션을 열지 못했습니다 — ' + (e && e.message ? e.message : e), true);
    return false;
  } finally { creating = false; }
}

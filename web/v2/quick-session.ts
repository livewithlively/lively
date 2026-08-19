// v2/quick-session.ts — 홈 입력창에서 **프로젝트를 묻지 않고** 세션을 연다 (#1719).
//  Enter → POST terminal/sessions { sessionDir: true, initialPrompt } → 세션 대화 화면(#/s/<id>)으로.
//   · sessionDir — cwd 는 세션 전용 폴더(<개인 루트>/sessions/<id>). 프로젝트는 나중에 언제든 붙인다(우측 '이 세션' ▸ 프로젝트).
//   · initialPrompt — 서버가 하네스 입력창이 뜬 뒤 넣는다(session-first-prompt.ts). 화면은 낙관적으로 그 턴을 먼저 그린다.
//  자동 승인은 클래식 '새 AI 세션' 폼이 기억해 둔 마지막 값을 그대로 쓴다(같은 localStorage 키 — v2/run-picker.ts
//  runPrefs). 제공자(하네스)·모델·추론강도는 홈 입력창의 세 칸이 정해 넘긴다(#1758) — 안 넘기면 그 기억이 기본이다.
import { api, toast } from '../core.js';
import { runPrefs, type RunPick } from './run-picker.js';
import { rememberCreated } from './created-cache.js';

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
 * 세션을 열고 그 화면으로 간다. 실패하면 toast 로 이유를 말하고 false(입력은 호출자가 돌려준다).
 *  opts.projectId — 홈 런처가 고른 행선지(#1719). 생성 API 는 프로젝트를 받지 않으므로(catalog 계약: 소속은 나중에)
 *  만들고 나서 POST /sessions/:id/project 로 붙인다. 붙이기가 실패해도 세션은 유효하다 — 말하고 계속 간다.
 *  opts.run — 입력창 옆 세 칸(제공자·모델·추론강도)이 고른 값(#1758). 없으면 저장된 직전 설정 그대로 연다.
 */
export async function openQuickSession(text: string, opts?: { projectId?: number | null; projectName?: string; run?: RunPick | null }): Promise<boolean> {
  const t = String(text || '').trim();
  if (!t || creating) return false;
  creating = true;
  try {
    const p = runPrefs();
    const run = opts && opts.run;
    const harness = run?.harness || (p.harness && p.harness !== 'shell' ? p.harness : 'claude');
    const flags = run ? run.flags : (p.flags && typeof p.flags === 'object' ? p.flags : {});
    // 실행 노드(#1744) — '' = 중앙 컴퓨터(기본, 필드 생략). 노드면 그 PC 에서 세션이 뜨고 첫 지시는 노드가 로컬로 넣는다
    //  (server createSession 이 노드에선 injectFirstPrompt 로, DB 아웃박스 대신). 노드가 없거나 안 고른 경우 run.node 는 ''.
    const node = run ? run.node : '';
    const out: any = await api('/api/ui/terminal/sessions', {
      method: 'POST',
      body: JSON.stringify({
        label: labelFromPrompt(t), harness, flags,
        autoApprove: !!p.autoApprove, sessionDir: true, initialPrompt: t,
        ...(node ? { node } : {}),
      }),
    });
    const id = out && out.session && out.session.id ? String(out.session.id) : '';
    if (!id) throw new Error('세션 id 를 받지 못했습니다');
    rememberCreated(out.session);   // 노드 세션은 목록 반영이 한 박자 늦다 — 라우트가 이 전문으로 먼저 그린다(created-cache 머리말)
    firstPrompts.set(id, t);
    const pid = opts && opts.projectId ? Number(opts.projectId) : 0;
    if (pid > 0) {
      try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(id) + '/project', { method: 'POST', body: JSON.stringify({ projectId: pid }) }); }
      catch (e: any) { toast(`세션은 열렸는데 「${opts?.projectName || '프로젝트'}」에 붙이지 못했어요 — 우측 '이 세션'에서 다시 붙일 수 있어요. (${e && e.message ? e.message : e})`, true); }
    }
    location.hash = '#/s/' + encodeURIComponent(id);
    return true;
  } catch (e: any) {
    toast('세션을 열지 못했습니다 — ' + (e && e.message ? e.message : e), true);
    return false;
  } finally { creating = false; }
}

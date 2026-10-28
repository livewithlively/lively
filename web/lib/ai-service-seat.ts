// ai-service-seat.ts — 앱 AI 공용 시트(#5081) 화면 두 조각. 판정 · 저장은 서버(ai-runs/plan.serviceSeatChange · app_ai_service_seat_set)가 한다.
//  · 관리자 카드(serviceSeatAdminCard) — [관리 ▸ 서비스 로그인] 에 둔다: 지정 상태 · 승인 · 빼기 · 어느 자리(워크스페이스 기본 · 앱 · 작업)가 쓰나 · 거는 일.
//  · 본인 안내(myServiceSeatNotice) — [내 AI 계정] 에 둔다: 내 계정이 지정됐을 때만 보이고, 동의 · 거두기를 받는다.
//  두 쪽 다 /api/ui/ai-account(service_seats · settings)를 읽고, 바꾸는 것은 /api/ui/ai-service-seats · /api/ui/ai-account 뿐이다.
//  ★ 켜는 데는 두 사람이 필요하다(관리자 승인 + 그 계정 본인 동의) — 한쪽만으로는 켜지지 않는다. 그래서 화면도 «기다리는 쪽» 을 말한다.
//  lib/ 는 페이지 층(core · ui-primitives)을 모른다(scripts/check-imports R28/R29) — 원 출처에서 직접 받는다.
import { api } from './net.js';
import { el } from './dom.js';
import { toast } from './overlay.js';
import { relTime } from './format.js';
import { uiText } from './uitext.js';
import { cardHead, errorNote, memberCombo } from './widgets.js';

/** 라벨 + 컨트롤 한 칸 — ui-primitives.field 와 같은 꼴(lib 는 그 파일을 import 하지 않는다). */
function field(label: string, control: HTMLElement): HTMLElement {
  return el('div', { class: 'field' }, el('label', { class: 'field-label', text: label }), control);
}

interface SeatRow {
  member: string; on: boolean; state: string;
  admin_approved: { by: string; at: string } | null; member_consented: { at: string } | null;
}

/** 상태 → 한 줄(어미까지). 서버 capabilities/ai-runs.seatState 의 값과 짝이다. */
export const SEAT_STATE_TEXT: Record<string, string> = {
  on: '켜져 있습니다',
  admin_pending: '관리자 승인을 기다립니다',
  member_pending: '그 계정 본인의 동의를 기다립니다',
  admin: '관리자 권한이 있는 계정이라 공용으로 쓰지 않습니다',
  inactive: '활성 구성원이 아니라 쓰지 않습니다',
  unknown: '상태를 확인하지 못했습니다',
};

/** (순수) 이 시트를 실행 계정으로 건 자리들 — 워크스페이스 기본 · 앱 · 앱의 작업. */
export function seatPlaces(settings: any, member: string): string[] {
  const out: string[] = [];
  const isSeat = (a: any): boolean => !!a && a.kind === 'subscription' && a.member === member;
  if (isSeat(settings?.default)) out.push('워크스페이스 기본');
  for (const [appId, v] of Object.entries<any>(settings?.apps || {})) {
    if (isSeat(v?.default)) out.push(`앱 ${appId}`);
    for (const [job, a] of Object.entries<any>(v?.jobs || {})) if (isSeat(a)) out.push(`앱 ${appId} 작업 ${job}`);
  }
  return out;
}

const WARNINGS = [
  '한 구독으로 여러 사람의 요청을 처리하는 것은 Anthropic 약관상 Team · Enterprise 플랜에서 회색이고, Pro · Max 개인 구독에서는 금지 쪽입니다. 전용 팀플랜 시트에만 쓰세요.',
  '공용 시트로 도는 작업은 누구의 지시든 그 계정의 홈(Claude 로그인)에서 돕니다. 그래서 관리자 권한이 없는 전용 계정만 지정할 수 있고, 그 계정으로 사람 세션을 열지 않아야 합니다(열면 그 홈에 그 계정의 라이블리 토큰이 심깁니다).',
  '공용 시트 실행은 앱 폴더에서만 돌고, 작업 AI 는 물은 사람의 라이블리 권한으로 움직입니다. 다만 앞 작업의 대화 기록이 같은 홈에 남으므로, 구성원마다 보이는 자료가 다른 앱에는 쓰지 마세요.',
];

async function postSeat(member: string, on: boolean): Promise<void> {
  await api('/api/ui/ai-service-seats', { method: 'POST', body: JSON.stringify({ member, on }) });
}

/** 관리자 카드 — [관리 ▸ 서비스 로그인]. 바꾼 뒤엔 스스로 다시 읽어 그린다. */
export function serviceSeatAdminCard(): HTMLElement {
  const body = el('div');
  const card = el('div', { class: 'card', style: 'padding:12px; margin-top:18px;' },
    cardHead('앱 AI 공용 시트', '관리자가 지정하고 그 계정 본인이 동의한 Claude 구독은 워크스페이스 구성원 누구의 앱 AI 요청이든 받습니다. 앱 서버가 물은 사람의 신원을 실어 보낸 요청도 받습니다.'),
    ...WARNINGS.map((w) => el('p', { class: 'admin-hint', style: 'margin:4px 0' }, ...uiText('⚠ ' + w))),
    body);
  const load = async (): Promise<void> => {
    body.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
    let snap: any;
    try { snap = await api('/api/ui/ai-account'); }
    catch (e) { body.replaceChildren(errorNote(e, '공용 시트 상태를 불러오지 못했습니다')); return; }
    const seats: SeatRow[] = (snap && snap.service_seats) || [];
    const rows: HTMLElement[] = seats.map((s) => seatAdminRow(s, snap.settings || {}, load));
    if (!seats.length) rows.push(el('p', { class: 'admin-hint' }, ...uiText('지정한 공용 시트가 없습니다.')));
    const who = memberCombo({ placeholder: '공용 시트로 쓸 전용 계정을 이름으로 찾아 고르기' });
    const add = el('button', { class: 'btn btn-primary btn-sm', text: '공용 시트로 승인하기' }) as HTMLButtonElement;
    add.addEventListener('click', async () => {
      const m = who.value();
      if (!m) { toast('공용 시트로 쓸 계정을 고르세요', true); return; }
      add.disabled = true;
      try { await postSeat(m, true); toast('승인했습니다. 그 계정 본인이 [내 AI 계정] 에서 동의하면 켜집니다.'); await load(); }
      catch (e: any) { add.disabled = false; toast((e && e.message) || '승인하지 못했습니다', true); }
    });
    rows.push(el('div', { class: 'card', style: 'padding:10px 12px; margin-top:10px;' },
      field('공용 시트로 쓸 계정', who.el),
      el('p', { class: 'admin-hint', style: 'margin:4px 0 8px' }, ...uiText('관리자 승인만으로는 켜지지 않습니다. 그 계정으로 로그인한 사람이 [내 AI 계정] 에서 동의해야 켜집니다.')),
      el('div', { class: 'admin-actions' }, add)));
    body.replaceChildren(...rows);
  };
  void load();
  return card;
}

function seatAdminRow(s: SeatRow, settings: any, reload: () => Promise<void>): HTMLElement {
  const places = seatPlaces(settings, s.member);
  const meta: string[] = [];
  if (s.admin_approved) meta.push(`승인 ${s.admin_approved.by} · ${relTime(s.admin_approved.at)}`);
  if (s.member_consented) meta.push(`본인 동의 · ${relTime(s.member_consented.at)}`);
  const act = (label: string, fn: () => Promise<void>, ok: string, ghost = true, ask?: string): HTMLElement => {
    const b = el('button', { class: ghost ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm', text: label }) as HTMLButtonElement;
    b.addEventListener('click', async () => {
      if (ask && !confirm(ask)) return;
      b.disabled = true;
      try { await fn(); toast(ok); await reload(); }
      catch (e: any) { b.disabled = false; toast((e && e.message) || '바꾸지 못했습니다', true); }
    });
    return b;
  };
  const acts: HTMLElement[] = [];
  if (s.state === 'admin_pending') acts.push(act('승인하기', () => postSeat(s.member, true), '승인했습니다', false));
  if (s.on && !places.includes('워크스페이스 기본')) {
    acts.push(act('워크스페이스 기본 실행 계정으로 걸기', () => api('/api/ui/ai-account', { method: 'POST', body: JSON.stringify({ kind: 'subscription', member: s.member }) }),
      '워크스페이스 기본 실행 계정으로 걸었습니다'));
  }
  acts.push(act('공용 시트에서 빼기', () => postSeat(s.member, false), '공용 시트에서 뺐습니다', true,
    `${s.member} 계정을 공용 시트에서 뺄까요? 관리자 승인과 본인 동의가 둘 다 지워지고, 돌고 있는 공용 시트 작업은 곧 멈춥니다.`));
  //  앱 하나에 걸기 — 실행 계정 화면이 따로 없어 여기서 받는다(도구 app_ai_account_set 과 같은 길).
  let appRow: HTMLElement | null = null;
  if (s.on) {
    const appIn = el('input', { type: 'text', placeholder: '앱 id (예: policy)', style: 'max-width:200px' }) as HTMLInputElement;
    appRow = el('div', { style: 'display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;' }, appIn,
      act('이 앱의 실행 계정으로 걸기', async () => {
        const appId = appIn.value.trim();
        if (!appId) throw new Error('앱 id 를 적으세요');
        await api('/api/ui/ai-account', { method: 'POST', body: JSON.stringify({ kind: 'subscription', member: s.member, app_id: appId }) });
      }, '그 앱의 실행 계정으로 걸었습니다'));
  }
  return el('div', { class: 'card', style: 'padding:9px 12px; margin:6px 0;' },
    el('div', { style: 'display:flex; gap:10px; align-items:center; flex-wrap:wrap;' },
      el('span', { style: 'font-weight:650', text: s.member }),
      el('span', { class: s.on ? 'pill pill-ok' : 'pill pill-warn', text: SEAT_STATE_TEXT[s.state] || s.state }),
      ...meta.map((m) => el('span', { class: 'mini-meta', text: m })),
      el('span', { style: 'margin-left:auto; display:flex; gap:6px; flex-wrap:wrap;' }, ...acts)),
    el('p', { class: 'admin-hint', style: 'margin:6px 0 0' }, ...uiText(places.length
      ? `이 시트를 실행 계정으로 쓰는 자리: ${places.join(' · ')}`
      : '아직 이 시트를 실행 계정으로 건 자리가 없습니다. 켜진 뒤 워크스페이스 기본이나 앱에 걸어야 요청이 이 시트로 갑니다.')),
    appRow);
}

/**
 * 본인 안내 — [내 AI 계정]. 내 계정이 지정됐을 때만 보인다(없으면 null). 동의 · 거두기를 받는다.
 *  meId = 지금 로그인한 구성원 id. 못 읽으면 조용히 빠진다(이 화면의 부가 정보다).
 */
export async function myServiceSeatNotice(meId: string, reload: () => void): Promise<HTMLElement | null> {
  if (!meId) return null;
  let snap: any;
  try { snap = await api('/api/ui/ai-account'); } catch { return null; }
  const s: SeatRow | undefined = ((snap && snap.service_seats) || []).find((x: SeatRow) => x.member === meId);
  if (!s) return null;
  const btn = (label: string, on: boolean, ok: string, primary = false): HTMLElement => {
    const b = el('button', { class: primary ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm', text: label }) as HTMLButtonElement;
    b.addEventListener('click', async () => {
      if (!on && !confirm('내 계정을 공용 시트에서 뺄까요? 관리자 승인도 함께 지워집니다.')) return;
      b.disabled = true;
      try { await postSeat(meId, on); toast(ok); reload(); }
      catch (e: any) { b.disabled = false; toast((e && e.message) || '바꾸지 못했습니다', true); }
    });
    return b;
  };
  const by = s.admin_approved ? s.admin_approved.by : '';
  let text: string;
  const acts: HTMLElement[] = [];
  if (s.state === 'member_pending') {
    text = `관리자(${by})가 내 계정을 앱 AI 공용 시트로 지정하려 합니다. 동의하면 워크스페이스 구성원 누구의 앱 AI 요청이든 내 Claude 구독과 내 홈에서 돕니다. 이 계정이 개인 계정이라면 동의하지 마세요.`;
    acts.push(btn('동의하기', true, '동의했습니다. 이제 공용 시트가 켜졌습니다.', true), btn('거절하기', false, '거절했습니다'));
  } else if (s.state === 'admin_pending') {
    text = '내 동의는 적혔고, 관리자 승인을 기다립니다. 관리자가 승인하면 공용 시트가 켜집니다.';
    acts.push(btn('동의 거두기', false, '동의를 거두었습니다'));
  } else if (s.state === 'on') {
    text = '내 계정은 앱 AI 공용 시트로 쓰이고 있습니다. 워크스페이스 구성원 누구의 앱 AI 요청이든 내 Claude 구독과 내 홈에서 돕니다.';
    acts.push(btn('공용 시트 그만두기', false, '공용 시트에서 빠졌습니다'));
  } else {
    text = `내 계정은 공용 시트로 지정됐지만 ${SEAT_STATE_TEXT[s.state] || s.state}.`;
    acts.push(btn('지정 지우기', false, '지정을 지웠습니다'));
  }
  return el('div', { class: 'card', style: 'padding:10px 12px; margin-top:10px;' },
    el('div', { class: 'field-label', style: 'margin-bottom:6px', text: '앱 AI 공용 시트' }),
    el('p', { class: 'admin-hint', style: 'margin:0 0 6px' }, ...uiText(text)),
    el('p', { class: 'admin-hint', style: 'margin:0 0 8px' }, ...uiText('⚠ ' + WARNINGS[0])),
    el('div', { class: 'admin-actions' }, ...acts));
}

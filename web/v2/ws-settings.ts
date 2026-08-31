// v2/ws-settings.ts — **워크스페이스 설정 모달** (#2188, 2026-08-31 장원준)
//
// 지시 원문: "워크스페이스 [팝오버] 밑에 설정 버튼 하나 만들어서 누르면 모달이 뜨고, 격리된 각
//  워크스페이스에 각각 해야 하는 설정들을 — 기능적인 것 + 아바타나 이름이나 초대까지 — 거기서".
//
// ── 왜 «지금 워크스페이스» 하나만 다루나 ────────────────────────────────────
// 여기 모이는 축(연결한 팀·승격 승인·기능 설정=관리탭)은 전부 **현재 테넌트**에 묶인 API 다.
//  다른 워크스페이스 것을 여기서 흉내내면 반은 되고 반은 안 되는 창이 된다 — 다른 워크스페이스는
//  거기로 전환해서 연다(격리된 각각의 설정이라는 지시와도 맞다). 행 단위 조작(치우기)은 목록의 ✕ 가 한다.
//
// ── 떠나는 문(나가기·삭제)은 여기 없다 ──────────────────────────────────────
// #1875 D5″ 에서 «떠나는 문은 목록 행의 ✕ 하나»로 모았다(문이 둘이면 어느 것이 진짜인지 사라진다).
//  설정 모달이 그 문을 다시 열면 같은 실수를 되풀이하는 것이다.
//
// ── 권한 갈래 ───────────────────────────────────────────────────────────────
//  · 일반 워크스페이스: 이름·아바타 = owner. 구성원·초대 = peopleSection 이 스스로 가른다(can_invite).
//  · primary(박스): 이름 = **조직 이름 그 자체**라 org 프로필(admin)로 간다. 아바타 = 등록부 행의
//    표시값이라 admin 이 바꾼다(registry 활성일 때만 — 저장소가 gw_workspace 라서).
//  · 매니지드: 권위는 CP — 서버(workspace_update)가 묻고 전달한다. 화면 갈래는 role 만 본다.
import { api, el, state, toast } from '../core.js';
import { icon } from './icons.js';
import {
  activeWorkspaceSlug, managedWorkspaces, saveWorkspaceSettings, workspaceFace, type WsFace,
  linkTeam, linkedTeams, pendingPromotions, resolvePromotion, setAutoPromote, unlinkTeam,
} from './switcher.js';
import { openMemberModal, peopleSection } from './ws-people.js';

interface WsRowLike {
  slug: string; name: string; kind: string; is_primary?: boolean;
  role?: string | null; face?: WsFace | null; kind_effective?: string;
}

// 색 후보 — 프로젝트/아바타 계열에서 이미 쓰는 톤과 어울리는 8색. «기본» 은 지움(파생값으로 복귀)이다.
const PALETTE = ['#2d6bf0', '#0ea5a3', '#16a34a', '#d97706', '#dc2626', '#9333ea', '#db2777', '#475569'];

const isAdmin = (): boolean => {
  const sc = (state.me as { scopes?: string[] } | null)?.scopes;
  return Array.isArray(sc) && sc.includes('admin');
};
const registryReallyActive = (): boolean =>
  !!((state.me as { workspace_registry?: { active?: boolean } } | null)?.workspace_registry?.active);

let openBack: HTMLElement | null = null;

export function openWsSettings(w: WsRowLike): void {
  if (openBack) return;
  const primary = !!w.is_primary || w.slug === 'primary';
  const owner = primary ? isAdmin() : w.role === 'owner';
  //  primary 아바타의 저장소는 gw_workspace 행 — registry 가 없으면 저장할 자리가 없다.
  //   그때는 편집기를 그리지 않는다(눌렀더니 400 나는 문을 그리지 않는다).
  const canFace = primary ? (owner && registryReallyActive()) : owner;

  const close = (): void => { openBack?.remove(); openBack = null; document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent): void => {
    //  위에 다른 창(확인창·구성원 모달·⋯ 메뉴)이 떠 있으면 Esc 는 그쪽 몫이다.
    if (e.key !== 'Escape' || document.querySelector('.ov-back, .pn-ctx, .v2mem-back')) return;
    e.stopPropagation(); close();
  };

  // ── 프로필(아바타 + 이름) — 미리보기가 입력을 따라간다 ────────────────────
  const cur: WsFace = { ...(w.face || {}) };
  const preview = el('span', { class: 'v2wss-preview' }) as HTMLElement;
  const paintPreview = (): void => {
    preview.replaceChildren(workspaceFace({ name: nameIn.value.trim() || w.name, kind: w.kind_effective || w.kind, slug: w.slug,
      face: (cur.color || cur.char) ? cur : null }, 'v2-wscard-big'));
  };
  const nameIn = el('input', { class: 'v2-wspop-in', type: 'text', value: w.name, 'aria-label': '워크스페이스 이름',
    ...(owner ? {} : { disabled: 'disabled' }), oninput: () => paintPreview() }) as HTMLInputElement;
  const charIn = el('input', { class: 'v2-wspop-in v2wss-char', type: 'text', value: cur.char || '',
    placeholder: (w.name || '?').trim().slice(0, 1), 'aria-label': '아바타 글자(1~2자)', maxlength: '4',
    ...(canFace ? {} : { disabled: 'disabled' }),
    oninput: () => { const t = Array.from(charIn.value.trim()).slice(0, 2).join(''); if (t) cur.char = t; else delete cur.char; paintPreview(); } }) as HTMLInputElement;

  const swatches = el('div', { class: 'v2wss-swatches', role: 'radiogroup', 'aria-label': '아바타 색' }) as HTMLElement;
  const paintSwatches = (): void => {
    swatches.replaceChildren(
      el('button', { class: 'v2wss-swatch v2wss-swatch--none' + (cur.color ? '' : ' on'), type: 'button',
        title: '기본 — 지금처럼 자동(개인=내 아바타, 팀=첫 글자)', 'aria-label': '기본 색',
        ...(canFace ? {} : { disabled: 'disabled' }),
        onclick: () => { delete cur.color; paintSwatches(); paintPreview(); } }, icon('x')),
      ...PALETTE.map((c) => el('button', { class: 'v2wss-swatch' + (cur.color === c ? ' on' : ''), type: 'button',
        style: 'background:' + c, title: c, 'aria-label': '색 ' + c,
        ...(canFace ? {} : { disabled: 'disabled' }),
        onclick: () => { cur.color = c; paintSwatches(); paintPreview(); } })),
      //  팔레트 밖 색 — 네이티브 색 고르기. 값은 항상 #rrggbb 라 서버 규칙(hex만)과 어긋날 일이 없다.
      el('input', { class: 'v2wss-swatch v2wss-swatch--pick', type: 'color', value: cur.color || '#2d6bf0',
        title: '직접 고르기', 'aria-label': '직접 고르기', ...(canFace ? {} : { disabled: 'disabled' }),
        oninput: (e: Event) => { cur.color = (e.target as HTMLInputElement).value; paintSwatches(); paintPreview(); } }));
  };

  const note = el('span', { class: 'v2-wspop-note' });
  const save = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '저장', onclick: async () => {
    const newName = nameIn.value.trim();
    const nameChanged = owner && !!newName && newName !== w.name;
    const faceChanged = canFace && JSON.stringify(cur) !== JSON.stringify(w.face || {});
    if (!nameChanged && !faceChanged) { note.textContent = '바뀐 것이 없어요.'; return; }
    (save as HTMLButtonElement).disabled = true; note.textContent = '';
    try {
      if (primary && nameChanged) {
        //  primary 이름 = 조직 이름. 워크스페이스 축이 아니라 조직 프로필이 정본이다(admin 전용).
        await api('/api/ui/org/profile', { method: 'POST', body: JSON.stringify({ name: newName }) });
      }
      if ((!primary && nameChanged) || faceChanged) {
        await saveWorkspaceSettings(w.slug, {
          ...(!primary && nameChanged ? { name: newName } : {}),
          ...(faceChanged ? { face: cur } : {}),
        });
      }
      toast('저장했어요.');
      close();
      //  얼굴·이름은 문패·레일·사이드바 여러 자리에 그려진다 — 자리마다 다시 그리게 쫓아다니는 대신
      //   통째로 새로 연다(종전 이름 바꾸기와 같은 선택).
      location.reload();
    } catch (e) { (save as HTMLButtonElement).disabled = false; note.textContent = (e as Error)?.message || String(e); }
  } });

  const profileSec = el('section', { class: 'v2wss-sec' },
    el('h3', { class: 'v2wss-sec-t', text: '아바타 · 이름' }),
    el('div', { class: 'v2wss-profile' },
      preview,
      el('div', { class: 'v2wss-profile-f' },
        el('label', { class: 'v2wss-lb', text: '이름' }), nameIn,
        el('label', { class: 'v2wss-lb', text: '아바타 글자' }), charIn,
        el('label', { class: 'v2wss-lb', text: '아바타 색' }), swatches)),
    owner
      ? el('div', { class: 'v2-wspop-actions' }, save, note)
      : el('p', { class: 'v2-wspop-hint', text: primary
          ? '조직 이름·아바타는 관리자가 바꿉니다.'
          : '이름·아바타는 이 워크스페이스를 만든 분이 바꿉니다.' }),
    primary && owner ? el('p', { class: 'v2-wspop-hint', text: '이 워크스페이스의 이름은 조직 이름이기도 해요 — 바꾸면 모두에게 그렇게 보입니다.' }) : null,
    primary && owner && !canFace ? el('p', { class: 'v2-wspop-hint', text: '아바타 저장은 다중 워크스페이스가 켜진 뒤에 쓸 수 있어요.' }) : null);

  // ── 구성원·초대 ────────────────────────────────────────────────────────────
  //  일반 워크스페이스는 명부 덩어리(peopleSection — 초대 폼 포함, 스스로 갱신)를 그대로 심는다.
  //  primary 는 명부가 없고(박스 로그인 = 접근) 초대 = 계정 생성이라 **기존 구성원 창**이 그 일을 안다 —
  //   같은 일을 하는 창을 두 벌 만들지 않고 그 문을 연다.
  const peopleSec = el('section', { class: 'v2wss-sec' },
    el('h3', { class: 'v2wss-sec-t', text: '구성원 · 초대' }),
    primary
      ? el('button', { class: 'v2-wspop-row', type: 'button', onclick: () => { close(); openMemberModal(w.slug, w.name, { primary: true, face: workspaceFace(w, 'v2-wscard-big') }); } },
          el('span', { class: 'v2-wspop-ic' }, icon('adduser')),
          el('span', { class: 'v2-wspop-tt' }, el('b', { text: '구성원 관리' }), el('span', { text: '박스 계정 전원이에요 — 부르기 = 계정 만들기' })))
      : peopleSection(w.slug));

  // ── 연결한 팀 · 팀으로 올릴 것 (셀프호스트, #1750 승격 경로) ─────────────────
  //  종전 「워크스페이스 설정」 판에서 그대로 옮겨 왔다. 매니지드엔 이 축이 없다(워크스페이스 간 승격은
  //   CP 밖 게이트웨이 연결 개념이라).
  const teamsSec = (!managedWorkspaces() && !primary) ? buildTeamsSec() : null;

  // ── 기능 설정 — 관리탭이 이미 워크스페이스(테넌트)마다 따로 저장된다 ────────
  //  수집기·증류기·연결·알림 같은 «기능» 설정판을 여기 복제하면 같은 화면이 두 벌이 된다.
  //  이 모달은 입구만 잇는다 — 관리탭의 저장은 전부 지금 워크스페이스에만 적힌다.
  const advSec = el('section', { class: 'v2wss-sec' },
    el('h3', { class: 'v2wss-sec-t', text: '기능 설정' }),
    el('button', { class: 'v2-wspop-row', type: 'button', onclick: () => { close(); location.hash = '#/system/profile'; } },
      el('span', { class: 'v2-wspop-ic' }, icon('sliders')),
      el('span', { class: 'v2-wspop-tt' }, el('b', { text: '관리탭 열기' }),
        el('span', { text: '수집·증류·연결·알림… 전부 이 워크스페이스에만 저장돼요' }))));

  const head = el('header', { class: 'v2wss-h' },
    el('span', { class: 'v2wss-h-face' }, workspaceFace(w, 'v2-wscard-big')),
    el('div', { class: 'v2wss-h-txt' },
      el('h2', { class: 'v2wss-h-title', text: '워크스페이스 설정' }),
      el('div', { class: 'v2wss-h-sub', text: `${w.name} · ${(w.kind_effective || w.kind) === 'personal' ? '개인' : '팀'} 워크스페이스` })),
    el('button', { class: 'v2mem-x', type: 'button', 'aria-label': '닫기', title: '닫기 (Esc)', onclick: close }, icon('x')));

  const box = el('div', { class: 'v2wss', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${w.name} 설정` },
    head, el('div', { class: 'v2wss-b' }, profileSec, peopleSec, teamsSec, advSec));
  const back = el('div', { class: 'v2wss-back' }, box) as HTMLElement;
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  openBack = back;
  paintSwatches(); paintPreview();
  nameIn.focus();
}

/** 지금 워크스페이스의 행 재료로 모달을 연다 — 레일 팝오버의 「워크스페이스 설정」 줄이 부른다. */
export function openCurrentWsSettings(rows: WsRowLike[]): void {
  const slug = activeWorkspaceSlug();
  const me = rows.find((r) => (r as { active?: boolean }).active) || rows.find((r) => r.slug === slug);
  openWsSettings(me || { slug: 'primary', name: '워크스페이스', kind: 'team', is_primary: true });
}

// ── 연결한 팀 · 승격 승인 — 종전 rail.openSettingsPanel 에서 이관(#1750) ──────
function buildTeamsSec(): HTMLElement {
  const field = (ph: string, type = 'text'): HTMLInputElement =>
    el('input', { class: 'v2-wspop-in', type, placeholder: ph, 'aria-label': ph, autocomplete: 'off' }) as HTMLInputElement;
  const hint = (t: string): HTMLElement => el('p', { class: 'v2-wspop-hint', text: t });

  const teamWrap = el('div', { class: 'v2-wspop-teams' });
  const linkForm = el('div', { class: 'v2-wspop-form', hidden: true }) as HTMLElement;
  const url = field('팀 워크스페이스 주소 (https://…)', 'url');
  const tok = field('그 워크스페이스에서 발급한 내 토큰 (lvk_…)');
  const lNote = el('span', { class: 'v2-wspop-note' });
  const link = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '연결', onclick: async () => {
    if (!url.value.trim() || !tok.value.trim()) { lNote.textContent = '주소와 토큰을 모두 입력하세요.'; return; }
    link.setAttribute('disabled', ''); lNote.textContent = '연결 확인 중…';
    try { const r = await linkTeam(url.value.trim(), tok.value.trim()); toast(`'${r.name}' 에 연결했어요.`); url.value = ''; tok.value = ''; linkForm.hidden = true; await paint(); }
    catch (e) { lNote.textContent = (e as Error)?.message || String(e); }
    finally { link.removeAttribute('disabled'); }
  } }) as HTMLButtonElement;
  linkForm.append(url, tok, el('div', { class: 'v2-wspop-actions' }, link, lNote),
    hint('팀 워크스페이스에서 [내 토큰 발급](memory·context)으로 만든 토큰을 붙여넣으세요. 여기서 만든 지식·프로젝트를 그 팀에 올릴 때 그 토큰으로만 올립니다.'));

  const promoWrap = el('div', { class: 'v2-wspop-teams' });
  const sec = el('section', { class: 'v2wss-sec', hidden: true },
    el('h3', { class: 'v2wss-sec-t', text: '연결한 팀' }),
    teamWrap,
    el('button', { class: 'v2-wspop-row', type: 'button', onclick: () => { linkForm.hidden = !linkForm.hidden; if (!linkForm.hidden) url.focus(); } },
      el('span', { class: 'v2-wspop-ic' }, icon('plus')),
      el('span', { class: 'v2-wspop-tt' }, el('b', { text: '팀 워크스페이스 연결' }), el('span', { text: '주소와 토큰으로 — 여기 것을 그 팀에 올립니다' }))),
    linkForm, promoWrap) as HTMLElement;

  const paint = async (): Promise<void> => {
    const links = await linkedTeams();
    //  종전 판(개인만 노출)과 달리 늘 보인다 — 설정 모달은 «이 워크스페이스가 할 수 있는 것»의 목차라,
    //   숨기면 팀에서 이미 연결해 둔 것을 관리할 문이 사라진다.
    sec.hidden = false;
    teamWrap.replaceChildren(...(links.length ? links.map((l: any) => el('div', { class: 'v2-wspop-team' },
      el('a', { class: 'v2-wspop-team-open', href: l.base_url, target: '_blank', rel: 'noopener', title: '새 탭으로 엽니다' },
        el('b', { text: String(l.name || l.scope_key) }),
        l.state === 'error' ? el('span', { class: 'v2-wspop-err', title: l.last_error || '연결 오류', text: '연결 오류' }) : null),
      el('button', { class: 'v2-wspop-act' + (l.auto_promote ? ' on' : ''), type: 'button',
        title: l.auto_promote ? '자동 올리기 켜짐 — AI 승격을 바로 반영합니다(눌러서 끔)' : '자동 올리기 꺼짐 — AI 승격은 승인 대기(눌러서 켬)',
        text: l.auto_promote ? '자동 ✓' : '자동',
        onclick: async () => { try { await setAutoPromote(l.base_url, !l.auto_promote); await paint(); } catch (e) { toast('바꾸지 못했어요 — ' + ((e as Error)?.message || e), true); } } }),
      el('button', { class: 'v2-wspop-act', type: 'button', title: '연결 해제', text: '해제',
        onclick: async () => { try { await unlinkTeam(String(l.scope_key)); await paint(); } catch (e) { toast('해제하지 못했어요 — ' + ((e as Error)?.message || e), true); } } })))
      : [hint('아직 연결한 팀이 없어요.')]));
    const ps = await pendingPromotions();
    promoWrap.replaceChildren(...(ps.length ? [el('div', { class: 'v2-wspop-sub', text: `팀으로 올릴 것 · 승인 대기 ${ps.length}` }), ...ps.map((p: any) => {
      const go = async (decision: 'approve' | 'reject'): Promise<void> => {
        try { const r = await resolvePromotion(p.id, decision);
          toast(decision === 'reject' ? '올리기를 취소했어요.' : r.state === 'done' ? '팀 워크스페이스에 올렸어요.' : r.state === 'failed' ? ('올리지 못했어요 — ' + (r.error || '')) : '처리했어요.', r.state === 'failed');
          await paint(); }
        catch (e) { toast('처리하지 못했어요 — ' + ((e as Error)?.message || e), true); }
      };
      return el('div', { class: 'v2-wspop-team' },
        el('span', { class: 'v2-wspop-team-open' }, el('b', { text: String(p.title || p.target_ref) }), el('span', { class: 'v2-wspop-kind', text: p.kind === 'knowledge' ? '지식' : '프로젝트' })),
        el('button', { class: 'btn btn-primary btn-xs', type: 'button', text: '올리기', onclick: () => void go('approve') }),
        el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: '취소', onclick: () => void go('reject') }));
    })] : []));
  };
  void paint();
  return sec;
}

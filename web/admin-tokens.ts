// admin-tokens.ts — #1405 W3: admin-members.ts 분할 ②.
//  내 프로필 편집 + 액세스 토큰 발급·폐기 패널.
import { api, cardHead, el, relTime, state, toast, withTip, uiText } from './core.js';
import { fieldWithHelp } from './ui-primitives.js';
import { loadAdmin, rerenderPanel } from './admin-rerender.js';
import { sectionHead } from './admin-widgets.js';
import { installMinterBlock } from './admin-install.js';
import { tuPageNumbers } from './admin-audit.js';

// ── 조직 · 연결 ──
function profileEditor(detail, data) {
  const canEdit = state.admin.canEdit;
  const p = data.profile;
  const dnIn = el('input', { type: 'text', value: p.display_name || '', placeholder: '조직 표시명' });
  const gwIn = el('input', { type: 'text', value: p.gateway_url || '', placeholder: 'http://게이트웨이:포트' });
  // 조직 시간대(#778) — 비우면 서버가 기본값(Asia/Seoul)으로 되돌린다. 흔한 존은 datalist 로 제안하되 자유 입력 허용(IANA 검증은 서버).
  const tzIn = el('input', { type: 'text', value: p.timezone || '', placeholder: 'Asia/Seoul (비우면 기본값)', list: 'org-tz-list' });
  const tzList = el('datalist', { id: 'org-tz-list' },
    ...['Asia/Seoul', 'UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'America/New_York', 'Europe/London'].map((z) => el('option', { value: z })));
  if (!canEdit) { dnIn.disabled = true; gwIn.disabled = true; tzIn.disabled = true; }
  const body = [
    fieldWithHelp('조직 표시명', dnIn, data.meaning['display_name']),
    fieldWithHelp('게이트웨이 주소', gwIn, data.meaning['gateway-url']),
    fieldWithHelp('조직 시간대', tzIn, data.meaning['timezone']), tzList,
  ];
  if (canEdit) {
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const r = await api('/api/ui/org/profile', { method: 'POST', body: JSON.stringify({ display_name: dnIn.value.trim(), gateway_url: gwIn.value.trim(), timezone: tzIn.value.trim() }) });
        data.profile = r.profile; tzIn.value = r.profile.timezone || ''; toast('저장됨'); status.textContent = '저장됨';
      } catch (e) { toast(e.message, true); }
      saveBtn.disabled = false;
    });
    body.push(el('div', { class: 'admin-actions' }, saveBtn, status));
  }
  detail.replaceChildren(
    sectionHead('조직 정보', '조직 이름·접속 주소·시간대처럼 이 조직 전체에 적용되는 기본 정보를 정합니다.'),
    el('div', { class: 'card admin-form-narrow' }, cardHead('조직 기본 정보'), ...body));
}

// ── 구성원 토큰 관리 — 접속 열쇠(토큰) 발급 + 발급 현황 보기 + 접속 해제. admin 전용. (발급 블록은 [구성원 추가]에서 이관 #613 후속) ──
function tokensPanel(detail, data) {
  const gw = (data.profile.gateway_url || window.location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
  const tokens = data.tokens || [];
  const active = tokens.filter((t) => !t.revoked_at);
  const revoked = tokens.filter((t) => t.revoked_at);
  const tokenRow = (t, isActive) => {
    // 권한이 7개까지 붙어 메타가 화면을 넘겼다 → 앞 3개만 보이고 나머지는 +N(전체는 마우스 올리면).
    const sc = t.scopes || [];
    const scText = sc.length ? (sc.length > 3 ? sc.slice(0, 3).join('/') + ' +' + (sc.length - 3) : sc.join('/')) : '';
    const meta = (t.user_id || '') + (scText ? ' · ' + scText : '')
      + ' · 발급 ' + (t.created_at ? t.created_at.slice(0, 10) : '?')
      + (t.last_used_at ? ' · 마지막 ' + relTime(t.last_used_at) : ' · 미사용');
    const right = isActive
      ? el('button', { class: 'btn btn-ghost btn-sm', text: '접속 해제', onclick: async (e) => {
          if (!confirm(`'${t.label || t.user_id}' 님의 접속을 해제할까요? 이 토큰은 즉시 무효화됩니다(되돌릴 수 없음).`)) return;
          e.target.disabled = true;
          try {
            // #2646 — 응답을 읽는다. 서버는 이제 «이번에 껐다»(revoked)와 «이미 꺼져 있었다»를 구분해 답하고,
            //  그런 토큰이 없으면 404 로 던진다(아래 catch 가 토스트로 띄운다). 종전엔 셋 다 {ok:true} 라
            //  화면이 언제나 '해제됨'이라고 말했다 — 안 꺼졌는데도.
            const r = await api('/api/ui/org/token/revoke', { method: 'POST', body: JSON.stringify({ tokenHash: t.token_hash }) });
            await loadAdmin(true);
            toast(r && r.revoked === false ? '이미 해제돼 있던 토큰입니다' : '접속 해제됨 — 즉시 무효');
            rerenderPanel(detail, 'tokens', state.admin.data);
          } catch (err) { toast(err.message, true); e.target.disabled = false; }
        } })
      : el('span', { class: 'pill', text: t.revoked_at ? '해제 ' + String(t.revoked_at).slice(0, 10) : '해제됨' });
    return el('div', { class: 'token-row' + (isActive ? '' : ' token-revoked') },
      el('div', { class: 'token-main' },
        el('div', { class: 'token-label', text: t.label || t.user_id || '(무라벨)' }),
        withTip(el('div', { class: 'mini-meta' }, ...uiText(meta)), sc.length ? '권한: ' + sc.join(' / ') : '권한 없음')),
      right);
  };
  // 목록이 수십 줄로 길어져 한 화면을 넘겼다(사용자 지적) → **검색 + 페이지네이션**(페이지당 개수 선택).
  //  발급 폼과 목록은 소제목으로 구분한다 — 전에는 둘이 붙어 어디부터 목록인지 안 보였다.
  const listBox = el('div');
  const q = el('input', { type: 'search', class: 'tok-search', placeholder: '이름·아이디·권한으로 찾기' });
  const perSel = el('select', { class: 'tok-per' }, ...[10, 20, 50, 100].map((n) => el('option', { value: String(n), text: n + '개씩' })));
  perSel.value = String(Number(localStorage.getItem('adm:tokPer')) || 10);
  let page = 1;
  const match = (t) => {
    const k = q.value.trim().toLowerCase();
    if (!k) return true;
    return [t.label, t.user_id, (t.scopes || []).join(' ')].some((v) => String(v || '').toLowerCase().includes(k));
  };
  const drawList = () => {
    const per = Number(perSel.value) || 10;
    const act = active.filter(match); const rev = revoked.filter(match);
    const rows = [...act.map((t) => ({ t, on: true })), ...rev.map((t) => ({ t, on: false }))];
    const totalPages = Math.max(1, Math.ceil(rows.length / per));
    if (page > totalPages) page = totalPages;
    const slice = rows.slice((page - 1) * per, page * per);
    const kids: any[] = [];
    if (!rows.length) {
      kids.push(el('p', { class: 'admin-hint', text: tokens.length ? '검색과 맞는 토큰이 없습니다.' : '아직 발급된 접속 토큰이 없습니다 — 위에서 구성원을 골라 발급하세요.' }));
    } else {
      let lastOn: boolean | null = null;
      for (const r of slice) {
        if (r.on !== lastOn) { kids.push(el('div', { class: 'token-section-h', text: r.on ? '사용 중 (' + act.length + ')' : '해제됨 (' + rev.length + ')' })); lastOn = r.on; }
        kids.push(tokenRow(r.t, r.on));
      }
    }
    const pager = el('div', { class: 'oa-pager' });
    if (totalPages > 1) {
      const pg = (label, n, kind?) => el('button', { class: 'oa-pg' + (kind === 'on' ? ' oa-pg-on' : '') + (kind === 'off' ? ' oa-pg-off' : ''),
        text: String(label), ...(kind ? {} : { onclick: () => { page = n; drawList(); } }) });
      pager.append(pg('‹', page - 1, page <= 1 ? 'off' : undefined));
      for (const pn of tuPageNumbers(page, totalPages)) pager.append(pn === '…' ? el('span', { class: 'oa-pg-gap', text: '…' }) : pg(pn, pn, pn === page ? 'on' : undefined));
      pager.append(pg('›', page + 1, page >= totalPages ? 'off' : undefined));
      pager.append(el('span', { class: 'oa-pg-info', text: rows.length + '개 중 ' + ((page - 1) * per + 1) + '–' + Math.min(page * per, rows.length) }));
    }
    listBox.replaceChildren(...kids, pager);
  };
  q.addEventListener('input', () => { page = 1; drawList(); });
  perSel.addEventListener('change', () => { localStorage.setItem('adm:tokPer', perSel.value); page = 1; drawList(); });
  drawList();

  const children = [
    el('p', { class: 'admin-hint' }, ...uiText('구성원이 라이블리 게이트웨이에 로그인할 때 쓰는 접속 토큰입니다.')),
    installMinterBlock(data, gw, { title: '토큰 발급' }),
    el('div', { class: 'tok-listhead' },
      el('h4', { class: 'admin-subhead-2', text: '발급된 토큰' }),
      el('div', { class: 'tok-tools' }, q, perSel)),
    el('p', { class: 'admin-hint', style: 'margin:0 0 8px' }, ...uiText('지금 누가 게이트웨이에 접속할 수 있는지 보여줍니다. 퇴사·기기 분실처럼 접속을 끊어야 할 때 [접속 해제]를 누르면 그 즉시 막힙니다. 한 번 해제한 토큰은 다시 살릴 수 없고, 필요하면 새로 발급합니다.')),
    listBox,
  ];
  detail.replaceChildren(el('div', { class: 'card' }, cardHead('접속 토큰'), ...children));
}

export { profileEditor, tokensPanel };

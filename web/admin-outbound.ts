// admin-outbound.ts — 아웃바운드(우리 → 외부) 두 패널 (#1313 R40, admin.ts 에서 verbatim 분리).
//  ① 위키 아웃바운드(피드, #976) — 정본 지식 → 노션 등 '지식 피드' DB 카드 투영.
//  ② 프로젝트 아웃바운드 — 프로젝트·과업 변경을 외부 협업 도구로 내보내기(on/off 전용).
//  둘 다 인바운드(admin-connectors.ts)의 역방향이라 한 파일에 둔다 — 토큰·컨테이너 설정은 인바운드 쪽 소관.
//  ⚠ 두 패널은 셸의 재렌더 레지스트리를 쓰지 않고 **자기 지역 rerender 클로저**로 자기를 다시 그린다
//   (feed-targets 는 전용 GET /api/ui/feed-targets 로 자체 조회 — /api/ui/org 페이로드를 오염시키지 않는다).
import { api, busy, cardHead, el, toast, uiText } from './core.js';
import { embeddedHost, sectionHead } from './admin-widgets.js';

// #976 위키 아웃바운드(피드) 패널 — 정본 지식 → 노션 등 '지식 피드' DB 카드 투영. 커넥터(인바운드)의 역방향.
//  피드 목적지(feed_target) 목록 + 카테고리 N:M 매핑(발행 게이트) + all_categories + 새 피드 부트스트랩/등록.
//  전용 GET /api/ui/feed-targets 로 자체 조회(연결 패널처럼) — /api/ui/org 페이로드 오염 안 시킴.
async function feedTargetsEditor(detail, data) {
  const meaning = data.meaning && data.meaning['feed-targets'];
  //  #2556 — 노션 앱 상세(새 셸 [외부 앱 연결] ▸ 노션 ▸ 내보내기)가 이 패널을 자기 칸 안에 편다. 그 칸은 이미
  //   제목을 갖고 있으므로 머리만 접는다(화면은 둘, **로직·저장경로는 하나**). 표식은 호스트에 붙인다 —
  //   인자로 받으면 이 패널이 저장 뒤 자기를 다시 그릴 때(rerender·rerenderPanel) 그 값이 떨어져 머리가 되살아난다.
  const head = () => (embeddedHost(detail) ? [] : [sectionHead('위키 아웃바운드(피드)', '우리 위키의 지식을 외부 도구로 내보냅니다. 어떤 카테고리를 어디로 보낼지 정합니다.', meaning)]);
  busy(detail, ...head(), el('div', { class: 'card' }, el('p', { class: 'admin-hint' }, ...uiText('피드 목적지 불러오는 중…'))));
  let res;
  try { res = await api('/api/ui/feed-targets'); }
  catch (e) { detail.replaceChildren(...head(), el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '로드 실패: ' + e.message }))); return; }
  const targets = res.targets || [];
  const categories = res.categories || [];
  const rerender = () => { void feedTargetsEditor(detail, data); };

  const body = el('div', {});

  // 소개 + 전체 발행(드레인) — 상시 갱신은 cron push-wiki-notion(자동화 탭).
  const drainAll = el('button', { class: 'btn btn-ghost btn-sm', text: '지금 전체 발행' });
  drainAll.addEventListener('click', async () => {
    drainAll.disabled = true;
    try { await api('/api/ui/feed-targets/drain', { method: 'POST', body: '{}' }); toast('발행 시작 — 잠시 후 노션 피드에 반영됩니다(멱등 · 변경분만).'); }
    catch (e) { toast(e.message, true); }
    drainAll.disabled = false;
  });
  //  #2556 — 이 칸이 노션 앱 상세에도 뜨면서 관리자 말(투영·정본·authored·인바운드)이 그대로 사용자 앞에 왔다.
  //   사실은 그대로 두고 말만 바꾼다: 무엇이 어디로 가는지 · 되돌아오지는 않는지 · 사람 페이지는 안전한지.
  body.append(el('p', { class: 'admin-hint' },
    el('span', { text: '우리가 쓴 지식을 노션에 만든 전용 피드 DB로 보내 카드로 쌓습니다. 보내기만 하고 되받지는 않으며, 원본은 라이블리에 남습니다. 사람이 쓰는 노션 페이지는 건드리지 않고 이 피드 DB에만 올립니다. ' }),
    el('span', { text: '바뀔 때마다 저절로 보내려면 자동화의 ' }), el('b', { text: 'push-wiki-notion' }), el('span', { text: ' 잡을 켜세요.  ' }), drainAll));

  if (!targets.length) body.append(el('p', { class: 'admin-hint' }, ...uiText('아직 등록된 피드가 없습니다. 아래에서 새 피드를 만드세요.')));
  for (const t of targets) body.append(feedTargetCard(t, categories, rerender));
  body.append(newFeedForm(rerender));

  detail.replaceChildren(...head(), body);
}

// 피드 목적지 카드 1개 — 상태·카드수·노션 링크 + all_categories 토글 + 카테고리 매핑 + 삭제.
function feedTargetCard(t, categories, rerender) {
  const notionUrl = 'https://notion.so/' + String(t.target_id || '').replace(/-/g, '');
  const card = el('div', { class: 'card', style: 'margin-top:12px' });
  card.append(el('div', { class: 'mini-title' },
    el('span', { text: t.title || ('피드 #' + t.id) }),
    el('span', { class: 'pill' + (t.state === 'active' ? ' pill-ok' : ''), text: t.state === 'active' ? '활성' : '일시중지' }),
    el('span', { class: 'pill', text: '카드 ' + (t.card_count || 0) })));
  card.append(el('div', { class: 'mini-meta' },
    el('a', { href: notionUrl, target: '_blank', rel: 'noopener', text: '노션에서 열기 ↗' }),
    el('span', { text: t.exclude_registered ? '  · 인바운드 제외됨(안전)' : '  · ⚠ 인바운드 제외 미등록 — 재수집 위험' })));

  // all_categories 토글
  const allChk = el('input', { type: 'checkbox' });
  allChk.checked = !!t.all_categories;
  allChk.addEventListener('change', async () => {
    try { await api('/api/ui/feed-targets/' + t.id, { method: 'POST', body: JSON.stringify({ all_categories: allChk.checked }) }); toast('저장됨'); rerender(); }
    catch (e) { toast(e.message, true); allChk.checked = !allChk.checked; }
  });
  card.append(el('label', { class: 'field-label', style: 'display:block;margin-top:10px' }, allChk, el('span', { text: ' 모든 카테고리 발행(매핑 무시 · 새 카테고리 자동 포함)' })));

  // 카테고리 매핑(all 아닐 때만) — 체크박스 + 저장.
  if (!t.all_categories) {
    const mappedIds = new Set((t.categories || []).map((c) => c.id));
    const boxes: any[] = [];
    const grid = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin:8px 0' });
    for (const c of categories) {
      const cb = el('input', { type: 'checkbox', value: String(c.id) });
      cb.checked = mappedIds.has(c.id); boxes.push(cb);
      grid.append(el('label', { class: 'pill' }, cb, el('span', { text: ' ' + (c.name || c.key) })));
    }
    const saveMap = el('button', { class: 'btn btn-ghost btn-sm', text: '매핑 저장' });
    saveMap.addEventListener('click', async () => {
      const ids = boxes.filter((b) => b.checked).map((b) => Number(b.value));
      saveMap.disabled = true;
      try { await api('/api/ui/feed-targets/' + t.id + '/categories', { method: 'POST', body: JSON.stringify({ category_ids: ids }) }); toast('매핑 저장됨 — 다음 발행부터 반영'); rerender(); }
      catch (e) { toast(e.message, true); saveMap.disabled = false; }
    });
    card.append(el('div', { class: 'field-label', text: '발행할 카테고리' }), grid, saveMap);
  }

  const del = el('button', { class: 'btn-text', text: '삭제' });
  del.addEventListener('click', async () => {
    if (!confirm('이 피드 등록을 삭제할까요? (노션 DB와 이미 발행된 카드는 남습니다)')) return;
    try { await api('/api/ui/feed-targets/' + t.id + '/delete', { method: 'POST', body: '{}' }); toast('삭제됨'); rerender(); }
    catch (e) { toast(e.message, true); }
  });
  card.append(el('div', { style: 'margin-top:10px' }, del));
  return card;
}

// 새 피드 만들기 — 부모 페이지 하위에 DB 생성(부트스트랩) 또는 기존 노션 DB id 등록. 둘 다 exclude_pages 자동 등록.
function newFeedForm(rerender) {
  const wrap = el('div', { class: 'card', style: 'margin-top:14px' }, cardHead('새 피드 만들기'));
  const titleIn = el('input', { class: 'input', type: 'text', value: 'Lively 지식 피드' });
  const parentIn = el('input', { class: 'input', type: 'text', placeholder: '노션 부모 페이지 URL 또는 id — 여기 하위에 피드 DB 생성' });
  const dbIn = el('input', { class: 'input', type: 'text', placeholder: '또는: 이미 만든 노션 DB id 를 등록' });
  const allChk = el('input', { type: 'checkbox' });
  const create = el('button', { class: 'btn', text: '피드 만들기' });
  create.addEventListener('click', async () => {
    const payload: any = { title: titleIn.value.trim() || undefined, all_categories: allChk.checked };
    if (dbIn.value.trim()) payload.database_id = dbIn.value.trim();
    else if (parentIn.value.trim()) payload.parent_page_id = parentIn.value.trim();
    else { toast('노션 부모 페이지 또는 기존 DB id 중 하나를 입력하세요', true); return; }
    create.disabled = true;
    try {
      const r = await api('/api/ui/feed-targets', { method: 'POST', body: JSON.stringify(payload) });
      toast('피드 생성됨' + (r && r.exclude_registered ? ' · 인바운드 제외 등록됨' : ' · ⚠ 인바운드 제외 수동 등록 필요'));
      rerender();
    } catch (e) { toast(e.message, true); create.disabled = false; }
  });
  wrap.append(el('div', { class: 'field-label', text: '＋ 새 피드 만들기' }),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '제목' }), titleIn),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '노션 부모 페이지 (새로 만들 때)' }), parentIn),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '기존 DB 등록 (선택)' }), dbIn),
    el('label', { class: 'field-label', style: 'display:block;margin-top:6px' }, allChk, el('span', { text: ' 모든 카테고리 발행' })),
    el('div', { style: 'margin-top:10px' }, create));
  return wrap;
}

// #975/#978 프로젝트 아웃바운드 패널 — 우리 프로젝트·과업 편집 → 외부 PM(ClickUp) push, 소스별 on/off.
//  on/off = push-clickup 크론 enabled(cron_set). 컨테이너 리스트는 커넥터 설정(외부 자료 수집 ▸ ClickUp).
//  GitHub Issues·Jira 는 아웃바운드 어댑터 미구현(#975 예정) — 자리만 표시. 스키마·백엔드 변경 없이 기존 엔드포인트 orchestrate.
async function projectOutboundEditor(detail, data) {
  const meaning = data.meaning && data.meaning['project-outbound'];
  const canEdit = !!data.canEdit;
  //  #2556 — 클릭업 앱 상세 ▸ 내보내기 칸에서도 편다. feedTargetsEditor 와 같은 규약(머리만 접는다).
  const head = () => (embeddedHost(detail) ? [] : [sectionHead('프로젝트 아웃바운드', '우리 프로젝트와 과업의 변경을 외부 협업 도구로 내보냅니다.', meaning)]);
  busy(detail, ...head(), el('div', { class: 'card' }, el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…'))));
  let jobs: any[] = [];
  try { const cron = await api('/api/ui/cron'); jobs = (cron && cron.jobs) || []; } catch (e) { /* 크론 로드 실패 — 빈 목록으로 진행 */ }
  const pushClickup = jobs.find((j) => j.id === 'push-clickup');
  const clickup = (data.connectors || []).find((c) => c.system === 'clickup') || {};
  const container = (clickup.config && clickup.config.container_list_id) || '';
  const rerender = () => { void projectOutboundEditor(detail, data); };

  const body = el('div', {});
  //  #2556 — 클릭업 앱 상세에도 뜨는 칸이라 관리자 말(미러·아웃바운드 push·master)을 걷었다. 사실은 그대로다.
  body.append(el('p', { class: 'admin-hint' }, ...uiText('라이블리에서 프로젝트와 과업을 고치면 그 변경을 외부 협업 도구에도 그대로 옮깁니다. 원본은 라이블리에 있고 외부에는 사본이 생깁니다. 도구마다 따로 켜고 끕니다.')));

  const table = el('table', { class: 'fields-table' });
  table.append(el('tr', {}, el('th', { text: '소스' }), el('th', { text: '상태' }), el('th', { text: '설정' })));

  // ClickUp — 유일한 구현 소스. on/off = push-clickup 크론.
  const enabled = !!(pushClickup && pushClickup.enabled);
  const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: enabled ? '끄기' : '켜기' });
  if (!canEdit) toggle.disabled = true;
  toggle.addEventListener('click', async () => {
    if (!enabled && !container) { toast('먼저 수집 설정에서 ClickUp 컨테이너 리스트를 고르세요.', true); return; }
    toggle.disabled = true;
    try {
      await api('/api/ui/cron', { method: 'POST', body: JSON.stringify({ id: 'push-clickup', action: 'connector_push', interval_sec: (pushClickup && pushClickup.interval_sec) || 120, params: { system: 'clickup' }, enabled: !enabled }) });
      toast(!enabled ? 'ClickUp push 켜짐 — 로컬 편집이 미러에 반영됩니다' : 'ClickUp push 꺼짐'); rerender();
    } catch (e) { toast(e.message, true); toggle.disabled = false; }
  });
  table.append(el('tr', {},
    el('td', {}, el('span', { class: 'mini-title', text: 'ClickUp' })),
    el('td', {}, el('span', { class: 'pill' + (enabled ? ' pill-ok' : ''), text: enabled ? '켜짐 · 2분마다' : '꺼짐' }), ' ', toggle),
    el('td', {},
      container ? el('span', { class: 'mini-meta', text: '컨테이너 리스트: ' + container }) : el('span', { class: 'pill', text: '⚠ 컨테이너 미설정' }),
      //  종전 링크는 #/system/connectors 였다 — 그 화면은 #1419 에서 없어졌고 옛 URL 이 리다이렉트로 여기 오고 있었다.
      //   앱 상세에서도 뜨는 칸이라 한 번 더 튕기지 않게 도착지를 바로 가리킨다.
      el('span', { text: '  ' }), el('a', { href: '#/context/sources/collectors', text: '수집 설정 열기 →' }))));

  // GitHub Issues · Jira — 아웃바운드 어댑터 미구현. **관리 화면에서만** 알린다: 여기는 '어느 도구로 내보낼 수
  //  있나'를 한눈에 보는 자리라 아직 없는 것도 알 값어치가 있지만, 클릭업 앱 상세(#2556)에서는 남의 앱 이야기다.
  if (!embeddedHost(detail)) {
    for (const s of ['GitHub Issues', 'Jira']) {
      table.append(el('tr', {},
        el('td', {}, el('span', { class: 'mini-title', text: s })),
        el('td', {}, el('span', { class: 'pill', text: '아직 없음' })),
        el('td', {}, el('span', { class: 'mini-meta' }, ...uiText('내보내기를 아직 만들지 않았습니다(#975).')))));
    }
  }
  body.append(table);
  body.append(el('p', { class: 'admin-hint', style: 'margin-top:10px' }, ...uiText(embeddedHost(detail)
    ? '반대 방향(ClickUp의 것을 우리 자료함으로 가져오기)은 위 [가져올 자료 정하기]에 있습니다. 여기서는 내보내기를 켜고 끄기만 합니다.'
    : '반대 방향(외부의 것을 우리 자료함으로 가져오기)과 토큰·리스트 설정은 [맥락 관리 ▸ 수집]에 있습니다. 여기서는 내보내기를 켜고 끄기만 합니다.')));

  detail.replaceChildren(...head(), el('div', { class: 'card' }, cardHead('내보내는 항목'), body));
}

export {
  feedTargetsEditor,
  projectOutboundEditor,
};

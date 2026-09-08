// projects/list-forms.ts — #1313 R34: web/projects.ts 분해 ⑤.
//  리스트·폴더의 **폼 계열**(생성/수정 모달)과 그 폼이 쓰는 도메인 프리미티브 —
//   위치(스페이스 › 폴더) 선택 필드 · 폴더/스페이스 폼 · 색·아이콘 팔레트 · 리스트 폼(카테고리·공개범위·멤버) ·
//   리스트 상태 체계 편집기 + 상태 템플릿 저장 · 프로젝트를 다른 리스트로 옮기는 팝오버.
//  ⚠ 경계 방향은 **sidebar.ts → list-forms.ts 단방향**이다(순환 금지). 그래서 사이드바와 폼이 함께 쓰는
//   폴더 종류 판정(pjvFolderIsSpace·pjvFolderIsArchive)과 리스트 멤버 저장(pjvSaveListMembers)은
//   '아래'인 이 파일이 소유한다 — 사이드바 메뉴가 폼을 여는(위→아래) 호출 방향과 반대가 되지 않게.
//  소비자 import 는 web/projects.ts 배럴 재수출로 무변경(openListForm 은 dashboard-home 도 쓴다).
import { api, el, toast, visAxisOn } from '../core.js';
import { overlayBox } from '../learn.js';
import { avatarColor, memberPicker, pjvTeamPicker } from './files.js';
import { compactPicker, pjvPopover } from './popover.js';
import { pjvLoadStatusTemplates, pjvNormStatusDefs, pjvStatusTemplatesCache } from './status.js';
import { PJV_LIST_COLORS, PJV_LIST_ICONS, pjvLocationField } from './list-forms-folder.js';

// 리스트 멤버 저장(조용히 — 팝오버 안에서 연속 토글, reload 없음). 멤버십 변화는 다음 렌더에 펼침/접힘으로 반영.
function pjvSaveListMembers(id, ids) {
  return api('/api/ui/v6/project-lists/' + id + '/members', { method: 'POST', body: JSON.stringify({ members: ids }) })
    .catch((e) => toast('리스트 멤버 저장 실패 — ' + e.message, true));
}

// 리스트 카테고리 단일 선택 필드(#541 후속) — 카테고리는 리스트 소유, 소속 프로젝트가 상속.
//  #1128 — '미분류(카테고리 없음)' 선택지를 없앴다. 리스트는 반드시 카테고리 하나를 이어야 소속 프로젝트가 물려받는다.
//  빈 값은 '아직 안 고름'(플레이스홀더)일 뿐 저장 가능한 값이 아니다 — 호출부가 저장 전에 ready()/getSelected() 로 막는다.
function pjvListCategoryField(currentId) {
  const cur = currentId != null && Number(currentId) > 0 ? Number(currentId) : null;
  const selectEl: any = el('select', { class: 'pjv-cat-select', disabled: 'disabled' }); // 옵션 로드 전 잠금(오클리어 방지)
  selectEl.append(el('option', { value: '', text: '불러오는 중…' }));
  let loaded = false;
  let count = 0; // 고를 수 있는 카테고리 수 — 0이면 관리탭에서 먼저 만들어야 한다(안내 문구가 달라진다)
  (async () => {
    let cats: any[] = [];
    //  #1631: 리스트에 걸 축도 활성만.
    try { cats = await api('/api/ui/categories').then((d) => ((d && d.categories) || []).filter((c: any) => (c.state ?? 'active') === 'active')); } catch (_) { /* 실패 시 loaded=false 유지 → 저장이 현재값 보존 */ return; }
    selectEl.replaceChildren(el('option', { value: '', text: cats.length ? '카테고리를 선택하세요' : '고를 수 있는 카테고리가 없어요' }));
    //  #1631: 종전엔 space(사업/제품/시스템) optgroup 으로 묶었다. 그 축이 없어져 평면 목록이다.
    for (const c of cats) {
      const o: any = el('option', { value: String(c.id), text: c.name || c.key });
      if (cur === Number(c.id)) o.selected = true;
      selectEl.append(o);
    }
    count = cats.length;
    selectEl.disabled = false;
    loaded = true;
  })();
  const row = el('div', { class: 'field', style: 'margin-top:12px' },
    el('label', { class: 'field-label', text: '카테고리' }),
    selectEl,
    el('div', { class: 'field-hint', text: '이 리스트의 프로젝트가 이 카테고리를 물려받아요. 하나는 반드시 골라야 해요 — 카테고리는 관리탭 ▸ 분류 체계에서 만들어요.' }));
  // getSelected: 옵션 로드 전/실패면 undefined → 저장 body 에서 category_id 를 아예 빼 현재값 보존(오클리어 방지 F5).
  //  로드 후엔 선택값(빈 문자열 = 아직 안 고름 = null). 호출부는 undefined·null 둘 다 '저장 불가'로 막는다.
  return {
    row, select: selectEl,
    ready: () => loaded,
    empty: () => loaded && count === 0,
    getSelected: () => { if (!loaded) return undefined; const v = selectEl.value; return v ? Number(v) : null; },
  };
}

function openListForm(reload, list?, opts?) {
  opts = opts || {};
  const editing = !!list;
  // opts.name = 다른 화면(대시보드 '+ 새 리스트' 인라인 입력)에서 이미 친 이름 — 두 번 타이핑하지 않게 프리필.
  const nameIn = el('input', { type: 'text', value: editing ? list.name : (opts.name || ''), placeholder: '리스트 이름 (예: 컨텍스트 저장소)', maxlength: '120' });
  let color = editing ? (list.color || '') : '';
  const swatches = el('div', { class: 'pjv-color-swatches' });
  const paintSw = () => {
    const none = el('button', { class: 'pjv-sw pjv-sw-none' + (color ? '' : ' on'), type: 'button', title: '자동(이름 해시색)', text: 'A' });
    none.onclick = () => { color = ''; paintSw(); };
    swatches.replaceChildren(none, ...PJV_LIST_COLORS.map((c) => {
      const s = el('button', { class: 'pjv-sw' + (color === c ? ' on' : ''), type: 'button', style: 'background:' + c, title: c });
      s.onclick = () => { color = c; paintSw(); };
      return s;
    }));
  };
  paintSw();
  // 아이콘(이모지) — settings.icon. 빈값=색 체크글리프(기본).
  let icon = editing ? ((list.settings && list.settings.icon) || '') : '';
  const iconRow = el('div', { class: 'pjv-icon-swatches' });
  const paintIcon = () => {
    const none = el('button', { class: 'pjv-sw pjv-sw-none' + (icon ? '' : ' on'), type: 'button', title: '기본(색 체크)', text: '∅' });
    none.onclick = () => { icon = ''; paintIcon(); };
    iconRow.replaceChildren(none, ...PJV_LIST_ICONS.map((em) => {
      const s = el('button', { class: 'pjv-sw pjv-sw-emoji' + (icon === em ? ' on' : ''), type: 'button', text: em, title: em });
      s.onclick = () => { icon = em; paintIcon(); };
      return s;
    }));
  };
  paintIcon();
  // 공개범위 — open(전원) / members(리스트 멤버만). 기본 open. 폼 톤에 맞춘 카드형 토글(#500).
  //  카드 전체가 스위치(role=switch) — 안의 스위치는 시각 표시만(중첩 button 회피).
  let visibility = editing ? (list.visibility || 'open') : 'open';
  const visSw = el('span', { class: 'pjv-switch' + (visibility === 'members' ? ' on' : '') }, el('span', { class: 'pjv-switch-knob' }));
  const visRow = el('div', { class: 'pjv-visrow' + (visibility === 'members' ? ' on' : ''), role: 'switch', tabindex: '0',
    'aria-checked': visibility === 'members' ? 'true' : 'false' },
    el('span', { class: 'pjv-visrow-txt' },
      el('span', { class: 'pjv-visrow-title', text: '공개범위를 멤버로 제한' }),
      el('span', { class: 'pjv-visrow-hint', text: '켜면 멤버가 아닌 사람에겐 이 리스트와 프로젝트가 보이지 않아요.' })),
    visSw);
  const toggleVis = () => {
    visibility = visibility === 'members' ? 'open' : 'members';
    const on = visibility === 'members';
    visRow.classList.toggle('on', on);
    visSw.classList.toggle('on', on);
    visRow.setAttribute('aria-checked', on ? 'true' : 'false');
    teamField.style.display = on ? '' : 'none';
  };
  visRow.onclick = (e) => { e.stopPropagation(); toggleVis(); };
  visRow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleVis(); } });
  // 카테고리(도메인) 소유(#541 후속) — 리스트가 카테고리를 이고 소속 프로젝트가 상속(프로젝트 단위 지정 폐지).
  const catField = pjvListCategoryField(editing ? (list.category_id ?? null) : (opts.categoryId ?? null));
  // 위치(#1067) — 새 리스트는 반드시 스페이스(또는 그 안 폴더) 안에. 폴더 메뉴에서 열었으면 그 폴더가 기본 선택.
  //  수정 폼엔 두지 않는다 — 이동은 리스트 ⋯ '폴더로 이동' 이 담당(중복 진입점 방지).
  const locField = editing ? null : pjvLocationField(opts.folderId ?? null);
  // 멤버 — 생성뿐 아니라 수정 때도 편집(만든 뒤에도 속성 수정). 수정이면 현재 멤버를 프리필.
  //  #1128 — 전체 명단을 폼에 그대로 펼치면 사람 수만큼 세로로 늘어져 모달이 스크롤 덩어리가 된다.
  //  새 프로젝트 폼 '팀원'과 같은 컴팩트 피커로: 평소엔 선택된 사람만 칩으로 요약하고, 누르면 팝오버에서 검색·토글.
  const picker = compactPicker('참여 멤버',
    (onChange) => memberPicker(editing ? (list.members || []).map((m) => m.member_id) : [], { includeMe: !editing, onChange }),
    { emptyText: '참여 멤버 없음', avatars: true, maxChips: 6 });
  // 공개 대상 팀(#1291 v2) — 사람을 한 명씩 고르는 대신 부서로 잠근다. 팀원이 바뀌면 대상도 따라간다.
  //  잠갔을 때만 의미가 있어 토글에 연동해 보였다 숨긴다(열려 있으면 '참여 멤버'가 표시용인 것과 같은 맥락).
  const teamPicker = compactPicker('공개 대상 팀',
    (onChange) => pjvTeamPicker(editing ? ((list.teams || []).map((t) => t.team_id)) : [], onChange),
    { emptyText: '팀 미지정', maxChips: 6 });
  const teamField = el('div', { class: 'field', style: 'margin-top:12px' + (visibility === 'members' ? '' : ';display:none') }, teamPicker.row);
  // #729 새 리스트 상태 체계 — 스페이스 기본 상속(기본, 재생성 불필요) 또는 저장된 템플릿에서 시작.
  let statusTmplSelect: any = null;
  let statusTmplField: any = null;
  if (!editing) {
    statusTmplSelect = el('select', { class: 'pjv-newlist-tmpl' });
    const paintTmplOpts = () => {
      statusTmplSelect.replaceChildren(el('option', { value: '', text: '스페이스 기본 상속 (권장)' }));
      for (const t of pjvStatusTemplatesCache) statusTmplSelect.append(el('option', { value: String(t.id), text: t.name + (t.is_default ? '  ★ 기본' : '') }));
    };
    paintTmplOpts();
    if (!pjvStatusTemplatesCache.length) pjvLoadStatusTemplates().then(paintTmplOpts).catch(() => {});
    statusTmplField = el('div', { class: 'field', style: 'margin-top:12px' },
      el('label', { class: 'field-label', text: '상태 체계' }), statusTmplSelect,
      el('div', { class: 'field-hint', text: '기본은 스페이스 기본 상태를 물려받아요(리스트마다 다시 만들 필요 없음). 저장된 템플릿으로 시작할 수도 있어요.' }));
  }
  const saveBtn = el('button', { class: 'btn btn-primary', text: editing ? '저장' : '만들기' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const rows: any[] = [
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '색' }), swatches),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '아이콘' }), iconRow),
    locField ? locField.row : null,
    catField.row,
    el('div', { class: 'field', style: 'margin-top:12px' },
      el('label', { class: 'field-label', text: '참여 멤버' }), picker.trigger),
    statusTmplField,
    // 축이 꺼져 있으면 공개범위 컨트롤 자체를 안 그린다(#1291) — 설정해도 강제되지 않는 컨트롤을 남기면
    //  "설정했는데 왜 안 걸리지"가 된다. 기존에 저장된 값은 그대로 두고(다시 켜면 살아난다) 화면에서만 감춘다.
    visAxisOn('project') ? el('div', { class: 'field', style: 'margin-top:12px' }, visRow) : null,
    visAxisOn('project') ? teamField : null,
  ];
  const back = overlayBox(editing ? '리스트 설정' : '새 리스트', ...rows, el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
  let busy = false; // 재진입 가드 — Enter 키반복/Enter+클릭 이중 제출로 2개 생성되던 버그 방지(버튼 disabled 는 keydown 경로를 못 막음).
  const go = async () => {
    if (busy) return;
    const nm = nameIn.value.trim();
    if (!nm) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    // 스페이스 미지정 금지(#1067) — 위치를 못 고른 채로는 만들지 않는다.
    if (locField && locField.getSelected() == null) { toast(locField.ready() ? '이 리스트를 둘 스페이스·폴더를 골라 주세요' : '위치를 불러오는 중이에요 — 잠시 후 다시 눌러 주세요', true); locField.select.focus(); return; }
    // 카테고리 미지정 금지(#1128) — 미분류 리스트는 만들지 않는다(소속 프로젝트가 물려받을 카테고리가 없어진다).
    //  getSelected(): undefined=아직 로딩/로드실패 · null=안 고름 — 둘 다 저장 불가.
    if (catField.getSelected() == null) {
      toast(catField.empty() ? '고를 수 있는 카테고리가 없어요 — 관리탭 ▸ 분류 체계에서 먼저 만들어 주세요'
        : catField.ready() ? '이 리스트의 카테고리를 골라 주세요' : '카테고리를 불러오는 중이에요 — 잠시 후 다시 눌러 주세요', true);
      catField.select.focus(); return;
    }
    busy = true; saveBtn.disabled = true;
    try {
      if (editing) {
        await api('/api/ui/v6/project-lists/' + list.id, { method: 'POST', body: JSON.stringify({ name: nm, color: color || null, visibility, category_id: catField.getSelected() }) });
        await api('/api/ui/v6/project-lists/' + list.id + '/settings', { method: 'POST', body: JSON.stringify({ settings: { icon: icon || null } }) }).catch(() => {});
        await pjvSaveListMembers(list.id, picker.getSelected());
        await api('/api/ui/v6/project-lists/' + list.id + '/teams', { method: 'POST', body: JSON.stringify({ teams: teamPicker.getSelected().map(Number) }) }).catch(() => {});
      } else {
        const res = await api('/api/ui/v6/project-lists', { method: 'POST', body: JSON.stringify({ name: nm, color: color || null, members: picker.getSelected(), category_id: catField.getSelected() }) });
        const created = (res && res.list) || null;
        if (created && created.id) {
          if (visibility !== 'open') await api('/api/ui/v6/project-lists/' + created.id, { method: 'POST', body: JSON.stringify({ visibility }) }).catch(() => {});
          const tsel = teamPicker.getSelected().map(Number);
          if (tsel.length) await api('/api/ui/v6/project-lists/' + created.id + '/teams', { method: 'POST', body: JSON.stringify({ teams: tsel }) }).catch(() => {});
          if (icon) await api('/api/ui/v6/project-lists/' + created.id + '/settings', { method: 'POST', body: JSON.stringify({ settings: { icon } }) }).catch(() => {});
          // #729 상태 체계 — 템플릿 선택 시 그 스킴을 커스텀으로 적용(미선택=스페이스 기본 상속, settings 미변경).
          if (statusTmplSelect && statusTmplSelect.value) {
            const t = pjvStatusTemplatesCache.find((x) => String(x.id) === statusTmplSelect.value);
            const statuses = t ? pjvNormStatusDefs(t.statuses) : [];
            if (statuses.length) await api('/api/ui/v6/project-lists/' + created.id + '/settings', { method: 'POST', body: JSON.stringify({ settings: { statusMode: 'custom', statuses } }) }).catch(() => {});
          }
          const locId = locField ? locField.getSelected() : (opts.folderId ?? null);
          if (locId != null) await api('/api/ui/v6/project-lists/' + created.id + '/folder', { method: 'POST', body: JSON.stringify({ folder_id: locId }) }).catch(() => {});
        }
        if (opts.onCreated) opts.onCreated(created);
      }
      back.remove(); toast(editing ? '리스트를 수정했습니다' : '리스트를 만들었습니다'); if (reload) reload();
    } catch (e) { toast('실패 — ' + e.message, true); busy = false; saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  return back;
}

// 프로젝트를 다른 리스트로 이동(또는 미분류로) — 행 ⋯ 메뉴에서 호출. 리스트 목록을 그 자리에서 fetch.
function pjvMoveProjectList(anchor, p, reload) {
  const menu = el('div', { class: 'pjv-menu pjv-listmove-pop' });
  const close = pjvPopover(anchor, menu);
  const head = el('div', { class: 'pjv-menu-head', text: '리스트로 이동' });
  menu.append(head, el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  api('/api/ui/v6/project-lists').then((d) => {
    const lists = (d && d.lists) || [];
    menu.replaceChildren(head);
    const mkItem = (label, listId, color) => {
      const cur = (p.list_id == null ? listId == null : String(p.list_id) === String(listId));
      const item = el('button', { class: 'pjv-menu-item' + (cur ? ' sel' : ''), type: 'button' },
        el('span', { class: 'pjv-list-dot sm', style: 'background:' + (color || 'var(--line)') }),
        el('span', { class: 'pjv-asg-mname', text: label }),
        el('span', { class: 'pjv-asg-check', text: cur ? '✓' : '' }));
      item.onclick = async (e) => {
        e.stopPropagation(); close();
        if (cur) return;
        try { await api('/api/ui/v6/projects/' + p.id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listId }) }); toast(listId == null ? '미분류로 옮겼습니다' : '리스트로 옮겼습니다'); if (reload) reload(); }
        catch (err) { toast('이동 실패 — ' + err.message, true); }
      };
      return item;
    };
    menu.append(mkItem('기타 (미분류)', null, null));
    for (const l of lists) menu.append(mkItem(l.name, l.id, l.color || avatarColor('list' + l.id)));
    const addNew = el('button', { class: 'pjv-menu-item pjv-sess-add', type: 'button' },
      el('span', { class: 'pjv-sess-add-ico', text: '＋' }), el('span', { text: '새 리스트…' }));
    addNew.onclick = (e) => { e.stopPropagation(); close(); openListForm(reload); };
    menu.append(el('div', { class: 'pjv-bulk-sep-h' }), addNew);
  }).catch((err) => menu.replaceChildren(head, el('div', { class: 'pjv-menu-empty', text: '리스트를 불러오지 못했어요 — ' + err.message })));
}


export {
  openListForm,
  pjvMoveProjectList,
  pjvSaveListMembers,
};
export { PJV_LIST_COLORS, openFolderForm, pjvFolderIsArchive, pjvFolderIsSpace, pjvHarmonizeColor } from './list-forms-folder.js';
export { pjvListStatusEditor } from './list-status-editor.js';

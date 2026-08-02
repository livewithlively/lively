// projects/detail-meta.ts — #1313 R35: web/projects.ts 분해 ⑥.
//  프로젝트 상세 헤더의 **클릭업식 메타데이터 패널** 한 벌 — 태스크 모달의 pjv-tm-fields 와 동형이다.
//   · 상태 pill(pjvProjStatusPill) · 기간(pjvProjDatesField) · 태그 팝오버(PJV_TAG_PALETTE·pjvProjTagsField)
//   · 리스트 필드(pjvProjListField) · 조립자(pjvProjMetaPanel) · 선행/후속 엣지(pjvProjEdgesField·pjvProjEdgePicker)
//  ⚠ 모달 싱글턴 _pjvPmOpen 은 **소유 모듈(detail.ts)에서 import 바인딩으로 읽는다** — 엣지 칩 드릴인(#804)이
//   '지금 열린 모달'을 알아야 해서다. 사본을 두면 이미 닫힌 모달을 붙잡는다(live binding 유지).
//  ⚠ PJV_TAG_NONE 은 배럴(../projects.js) 경유로 받는다 — R33 과 같은 이유(projects↔taskmodal 순환에 새 가지 금지).
import { api, el, toast } from '../core.js';
// 배럴 경유(../projects.js) — PJV_TAG_NONE 은 taskmodal 소유, pjvSaveProjMembers 는 세 면(벌크바·행·상세 메타패널)이
//  공유하는 쓰기 경로라 #1313 R36 이후 projects/board.ts 소유다. 둘 다 배럴을 거쳐야 순환이 늘지 않는다.
import { PJV_TAG_NONE, pjvSaveProjMembers } from '../projects.js';
import { _pjvPmOpen, pjvOpenProjectModal } from './detail.js';
import { pjvFieldControl } from './fields.js';
import { avatarColor } from './files.js';
import { pjvCheckMini, pjvTagBackIcon, pjvTagGearIcon, pjvTagNoneIcon, pjvTagTrashIcon } from './icons.js';
import { openListForm } from './list-forms.js';
import { pjvPopover } from './popover.js';
import { openProjectV2Form } from './project-form.js';
import { pjvProjTeamControl, pjvSetProjStatus, projPatch } from './rows.js';
import { pjvReloadKeepScroll } from './state.js';
import { pjvFmtDate, pjvIsOverdue, pjvProjStatusMeta, pjvStatusIconStd } from './status.js';
import { pjvPriorityControl } from './task-controls.js';

// ── 프로젝트 클릭업식 메타데이터 패널 (상세 헤더, 이름 아래) — 태스크 모달의 pjv-tm-fields 동형 ──
//  상태·담당자·기간·우선순위는 /api/ui/v6/projects/:id(updateProject) 로, 태그·시간추적은 /tasks/:id/(tags|time) 를
//  프로젝트 id 로 호출(같은 task_tag_link/task_time_entry 테이블, 레벨 제약 없음). getProject 가 p.tags·p.time 부여.
function pjvProjStatusPill(p, reload) {
  const meta = pjvProjStatusMeta(p.status);
  const btn = el('button', { class: 'pjv-tm-statuspill ' + meta.cls, type: 'button' },
    pjvStatusIconStd(p.status, 'sm'),
    el('span', { text: meta.label }));
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    for (const st of ['todo', 'in_progress', 'done']) {
      const m = pjvProjStatusMeta(st);
      const cur = pjvProjStatusMeta(p.status).key === st;
      const item = el('button', { class: 'pjv-menu-item' + (cur ? ' sel' : ''), type: 'button' },
        pjvStatusIconStd(st, 'sm'),
        el('span', { text: m.label }));
      item.onclick = () => { close(); if (!cur) pjvSetProjStatus(p.id, st, reload); };
      menu.append(item);
    }
  };
  return btn;
}
function pjvProjDatesField(p, reload) {
  const wrap = el('div', { class: 'pjv-tm-dates' });
  const mk = (field, ph) => {
    const val = p[field];
    const overdue = field === 'due_date' && pjvIsOverdue(p);
    const b = el('button', { class: 'pjv-tm-datebtn' + (val ? '' : ' empty') + (overdue ? ' overdue' : ''), type: 'button' },
      el('span', { text: val ? pjvFmtDate(val) : ph }));
    b.onclick = (e) => {
      e.stopPropagation();
      const input = el('input', { type: 'date', class: 'pjv-date-input', value: val || '' });
      const wrapPop = el('div', { class: 'pjv-menu pjv-date-pop' }, input,
        val ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '지우기',
          onclick: () => { close(); projPatch(p.id, { [field]: null }, reload); } }) : null);
      const close = pjvPopover(b, wrapPop);
      setTimeout(() => { input.focus(); if (input.showPicker) { try { input.showPicker(); } catch (_) { /* noop */ } } }, 0);
      input.onchange = () => { const v = input.value || null; close(); projPatch(p.id, { [field]: v }, reload); };
    };
    return b;
  };
  wrap.append(mk('start_date', 'Start'), el('span', { class: 'pjv-tm-datearrow', text: '→' }), mk('due_date', 'Due'));
  return wrap;
}
// 태그 팝오버 헬퍼 — 태스크 모달과 동일한 아이콘/색 팔레트(프로젝트도 같은 /tags 엔드포인트·CSS 공유).
const PJV_TAG_PALETTE = ['#8b7fd6', '#6b8fff', '#4aa3e0', '#2bb3a3', '#56b877', '#e0b341', '#e8853a', '#e98aa8', '#d96bb0', '#b07fd6', '#a98e7d', '#cfd6e0', '#98a3b5'];
// 프로젝트 태그 — 태스크 모달과 동일한 클릭업식 팝오버(선택칩 + 검색/생성 + 토글 + 행별 ⚙ + '모든 태그 관리').
//  프로젝트도 task_tag_link 를 p.id 로 공유 → 엔드포인트(/tasks/:id/tags · /tags/:id)·CSS 모두 태스크와 동일.
function pjvProjTagsField(p, reload) {
  const wrap = el('div', { class: 'pjv-tm-tags' });
  const save = async (body) => {
    try { const d = await api('/api/ui/v6/tasks/' + p.id + '/tags', { method: 'POST', body: JSON.stringify(body) }); p.tags = d.tags || []; return true; }
    catch (e) { toast('태그 저장 실패 — ' + e.message, true); return false; }
  };
  const tagChip = (tg, onRemove) => {
    const chip = el('span', { class: 'pjv-tm-tag', style: '--tag:' + (tg.color || PJV_TAG_NONE) }, el('span', { class: 'pjv-tm-tag-name', text: tg.name }));
    if (onRemove) { const x = el('button', { class: 'pjv-tm-tag-x', type: 'button', title: '제거', text: '✕' }); x.onclick = (e) => { e.stopPropagation(); onRemove(); }; chip.append(x); }
    return chip;
  };
  const render = () => {
    wrap.replaceChildren();
    for (const tg of (p.tags || [])) wrap.append(tagChip(tg, async () => { if (await save({ tag_id: tg.id, remove: true })) render(); }));
    const add = el('button', { class: 'pjv-tm-valbtn' + ((p.tags || []).length ? '' : ' empty'), type: 'button', text: (p.tags || []).length ? '＋' : 'Empty' });
    add.onclick = (e) => { e.stopPropagation(); openPop(add); };
    wrap.append(add);
  };
  async function openPop(anchor) {
    const pop = el('div', { class: 'pjv-menu pjv-tm-tagpop' });
    pjvPopover(anchor, pop);
    let all: any[] = [];
    const loadAll = async () => { try { all = await api('/api/ui/v6/tags').then((r) => (r && r.tags) || []); } catch (_) { all = []; } };
    const selIds = () => new Set((p.tags || []).map((x) => x.id));
    await loadAll();

    function showList(query) {
      const input = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '태그 검색…', maxlength: '40', value: query || '' });
      const chips = el('div', { class: 'pjv-tm-tagpop-chips' });
      const list = el('div', { class: 'pjv-tm-tagresults' });
      const manageBtn = el('button', { class: 'pjv-tm-tagmanage-btn', type: 'button' }, pjvTagGearIcon(), el('span', { text: '모든 태그 관리' }));
      manageBtn.onclick = () => showManageAll();
      pop.replaceChildren(
        el('div', { class: 'pjv-tm-tagpop-top' }, chips, input),
        el('div', { class: 'pjv-tm-tagpop-head' }, el('span', { text: 'Select an option' })),
        list, manageBtn);
      setTimeout(() => { input.focus(); }, 0);
      const renderChips = () => chips.replaceChildren(...(p.tags || []).map((tag) => tagChip(tag, () => persistRemove(tag.id))));
      const persistAdd = async (x) => { if (await save({ tag_id: x.id })) { render(); renderChips(); renderList(); } };
      const persistRemove = async (tagId) => { if (await save({ tag_id: tagId, remove: true })) { render(); renderChips(); renderList(); } };
      const renderList = () => {
        const qq = input.value.trim();
        const have = selIds();
        const cand = all.filter((x) => (!qq || x.name.toLowerCase().includes(qq.toLowerCase())));
        list.replaceChildren();
        for (const x of cand.slice(0, 40)) {
          const on = have.has(x.id);
          const row = el('button', { class: 'pjv-tm-tagrow' + (on ? ' sel' : ''), type: 'button' },
            pjvCheckMini(on),
            el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (x.color || PJV_TAG_NONE) }),
            el('span', { class: 'pjv-tm-tagrow-name', text: x.name }));
          row.onclick = () => (on ? persistRemove(x.id) : persistAdd(x));
          const gear = el('button', { class: 'pjv-tm-tagrow-gear', type: 'button', title: '태그 편집' }, pjvTagGearIcon());
          gear.onclick = (e) => { e.stopPropagation(); showColor(x, input.value); };
          row.append(gear);
          list.append(row);
        }
        // 새 태그 생성은 '모든 태그 관리'에서만 — 검색창은 검색·토글 전용(Create 행 없음).
        if (!list.children.length) list.append(el('div', { class: 'pjv-menu-empty', text: qq ? '검색 결과가 없습니다 — 새 태그는 아래 ‘모든 태그 관리’에서 만드세요.' : '태그가 없습니다 — ‘모든 태그 관리’에서 만드세요.' }));
      };
      input.addEventListener('input', renderList);
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const v = input.value.trim(); if (!v) return;
        const exact = all.find((x) => x.name.toLowerCase() === v.toLowerCase());
        if (exact && !selIds().has(exact.id)) { persistAdd(exact); input.value = ''; renderList(); }
        // 일치하는 기존 태그만 추가 — 새 태그 생성은 '모든 태그 관리'에서만.
      });
      renderChips(); renderList();
    }

    function showColor(tag, backQuery, onBack?) {
      const goBack = onBack || (() => showList(backQuery));
      const back = el('button', { class: 'pjv-tm-tagcolor-back', type: 'button', title: '뒤로' }, pjvTagBackIcon());
      back.onclick = goBack;
      const nameIn = el('input', { type: 'text', class: 'pjv-tm-tagcolor-name', value: tag.name, maxlength: '40' });
      const grid = el('div', { class: 'pjv-tm-tagcolor-grid' });
      const syncLocal = () => {
        all = all.map((a) => (a.id === tag.id ? { ...a, name: tag.name, color: tag.color } : a));
        p.tags = (p.tags || []).map((x) => (x.id === tag.id ? { ...x, name: tag.name, color: tag.color } : x));
      };
      const renderGrid = () => {
        grid.replaceChildren();
        for (const c of PJV_TAG_PALETTE) {
          const sw = el('button', { class: 'pjv-tm-swatch' + (tag.color === c ? ' sel' : ''), type: 'button', style: 'background:' + c + ';color:' + c, 'aria-label': '색상' });
          sw.onclick = () => applyColor(c);
          grid.append(sw);
        }
        const none = el('button', { class: 'pjv-tm-swatch none' + (!tag.color ? ' sel' : ''), type: 'button', title: '색 없음' }, pjvTagNoneIcon());
        none.onclick = () => applyColor(null);
        grid.append(none);
      };
      const applyColor = async (c) => {
        tag.color = c; renderGrid(); syncLocal(); render();
        try { await api('/api/ui/v6/tags/' + tag.id, { method: 'POST', body: JSON.stringify({ color: c }) }); }
        catch (e) { toast('실패 — ' + e.message, true); }
      };
      const rename = async () => {
        const v = nameIn.value.trim(); if (!v || v === tag.name) return;
        try { const r = await api('/api/ui/v6/tags/' + tag.id, { method: 'POST', body: JSON.stringify({ name: v }) }).then((x) => x.tag); tag.name = r.name; syncLocal(); render(); }
        catch (e) { toast('이름 변경 실패 — ' + e.message, true); nameIn.value = tag.name; }
      };
      const del = el('button', { class: 'pjv-tm-tagdelete', type: 'button' }, pjvTagTrashIcon(), el('span', { text: 'Delete' }));
      del.onclick = async () => {
        if (!confirm("'" + tag.name + "' 태그를 삭제할까요?\n모든 항목에서 제거됩니다.")) return;
        try { await api('/api/ui/v6/tags/' + tag.id + '/delete', { method: 'POST', body: JSON.stringify({}) }); p.tags = (p.tags || []).filter((x) => x.id !== tag.id); await loadAll(); render(); goBack(); }
        catch (e) { toast('삭제 실패 — ' + e.message, true); }
      };
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } });
      nameIn.addEventListener('blur', rename);
      pop.replaceChildren(
        el('div', { class: 'pjv-tm-tagcolor-top' }, back, nameIn),
        grid,
        el('div', { class: 'pjv-tm-tagcolor-sep' }),
        del);
      renderGrid();
      setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
    }

    function showManageAll() {
      const back = el('button', { class: 'pjv-tm-tagcolor-back', type: 'button', title: '뒤로' }, pjvTagBackIcon());
      back.onclick = () => showList('');
      const list = el('div', { class: 'pjv-tm-tagresults' });
      // 새 태그 생성은 여기('모든 태그 관리')에서만. 정의만 만들고 이 프로젝트엔 적용하지 않는다(생성 직후 링크 해제).
      const createIn = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '＋ 새 태그 이름 입력 후 Enter', maxlength: '40' });
      const doCreate = async () => {
        const v = createIn.value.trim(); if (!v) return;
        if (all.some((x) => x.name.toLowerCase() === v.toLowerCase())) { toast('이미 있는 태그입니다', true); return; }
        createIn.disabled = true;
        const color = PJV_TAG_PALETTE[all.length % PJV_TAG_PALETTE.length];
        if (await save({ name: v, color })) {
          const created = (p.tags || []).find((x) => x.name.toLowerCase() === v.toLowerCase());
          if (created) await save({ tag_id: created.id, remove: true }); // 정의만 — 현재 프로젝트엔 미적용
          await loadAll(); render(); showManageAll();
        } else { createIn.disabled = false; }
      };
      createIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doCreate(); } });
      pop.replaceChildren(
        el('div', { class: 'pjv-tm-tagcolor-top' }, back, el('div', { class: 'pjv-tm-tagmanage-title', text: '모든 태그 관리' })),
        el('div', { class: 'pjv-tm-tagpop-top' }, createIn),
        el('div', { class: 'pjv-tm-tagpop-head' }, el('span', { text: all.length + '개 · 클릭해 이름·색상·삭제 (모든 항목 반영)' })),
        list);
      setTimeout(() => createIn.focus(), 0);
      if (!all.length) { list.append(el('div', { class: 'pjv-menu-empty', text: '아직 태그가 없습니다 — 위 칸에서 만들어보세요.' })); return; }
      for (const x of all) {
        const row = el('button', { class: 'pjv-tm-tagrow', type: 'button' },
          el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (x.color || PJV_TAG_NONE) }),
          el('span', { class: 'pjv-tm-tagrow-name', text: x.name }),
          el('span', { class: 'pjv-tm-tagrow-gear' }, pjvTagGearIcon()));
        row.onclick = () => showColor(x, '', showManageAll);
        list.append(row);
      }
    }

    showList('');
  }
  render();
  return wrap;
}
// 패널 — 좌(상태·기간) 우(담당자·우선순위·태그) 2열, 태스크 모달과 동일 결.
// 상세 '리스트' 필드 — 소속 리스트(색점+이름, 미분류면 안내) 표시 + 클릭해 변경(리스트 선택/미분류). getProject 가 p.list 부여.
function pjvProjListField(p, reload) {
  const cur = p.list || null; // { id, name, color } | null
  const btn = el('button', { class: 'pjv-cell-btn' + (cur ? '' : ' empty'), type: 'button', title: '소속 리스트' });
  const paint = () => {
    if (cur) btn.replaceChildren(
      el('span', { class: 'pjv-list-dot sm', style: 'background:' + (cur.color || avatarColor('list' + cur.id)) }),
      el('span', { class: 'pjv-asg-mname', text: cur.name }));
    else btn.replaceChildren(el('span', { class: 'pjv-cell-ph', text: '미분류 — 리스트 지정' }));
  };
  paint();
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu pjv-listmove-pop' });
    const close = pjvPopover(btn, menu);
    const headEl = el('div', { class: 'pjv-menu-head', text: '리스트' });
    menu.append(headEl, el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
    api('/api/ui/v6/project-lists').then((d) => {
      const lists = (d && d.lists) || [];
      menu.replaceChildren(headEl);
      const mkItem = (label, listId, color) => {
        const isCur = (p.list_id == null ? listId == null : String(p.list_id) === String(listId));
        const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' },
          el('span', { class: 'pjv-list-dot sm', style: 'background:' + (color || 'var(--line, #2a2a33)') }),
          el('span', { class: 'pjv-asg-mname', text: label }),
          el('span', { class: 'pjv-asg-check', text: isCur ? '✓' : '' }));
        item.onclick = async (ev) => {
          ev.stopPropagation(); close();
          if (isCur) return;
          try { await api('/api/ui/v6/projects/' + p.id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listId }) }); toast(listId == null ? '미분류로 옮겼습니다' : '리스트로 옮겼습니다'); if (reload) reload(); }
          catch (err) { toast('이동 실패 — ' + err.message, true); }
        };
        return item;
      };
      menu.append(mkItem('기타 (미분류)', null, null));
      for (const l of lists) menu.append(mkItem(l.name, l.id, l.color || avatarColor('list' + l.id)));
      const addNew = el('button', { class: 'pjv-menu-item pjv-sess-add', type: 'button' },
        el('span', { class: 'pjv-sess-add-ico', text: '＋' }), el('span', { text: '새 리스트…' }));
      addNew.onclick = (ev) => { ev.stopPropagation(); close(); openListForm(reload); };
      menu.append(el('div', { class: 'pjv-bulk-sep-h' }), addNew);
    }).catch((err) => menu.replaceChildren(headEl, el('div', { class: 'pjv-menu-empty', text: '리스트를 불러오지 못했어요 — ' + err.message })));
  };
  return btn;
}

function pjvProjMetaPanel(p, members, reload) {
  const row = (glyph, label, control) => el('div', { class: 'pjv-tm-field' },
    el('span', { class: 'pjv-tm-field-ico', 'aria-hidden': 'true', text: glyph }),
    el('span', { class: 'pjv-tm-field-label', text: label }),
    el('div', { class: 'pjv-tm-field-val' }, control));
  // 선행/후속 프로젝트 — 프로퍼티 '첫 줄'(좌=선행, 우=후속). #340 의 별도 박스를 프로퍼티로 이관(#359) 후,
  //  사용자 요청으로 맨 위 첫 줄로 이동. 예전엔 풀폭 래퍼(pjv-proj-meta-edges, align-items:start)로 감쌌는데
  //  그 override 때문에 라벨 세로선이 다른 행과 어긋나 보였음 → 일반 row 로 통일(부모 2열 그리드에 그대로
  //  흘러 상태·폴더 등과 아이콘/라벨/값 세로선이 정확히 정렬됨).
  return el('div', { class: 'pjv-tm-fields pjv-proj-meta' },
    row('←', '선행 프로젝트', pjvProjEdgesField(p, reload, 'out')),
    row('→', '후속 프로젝트', pjvProjEdgesField(p, reload, 'in')),
    row('◎', '상태', pjvProjStatusPill(p, reload)),
    // 소속 리스트(클릭업 List) — 클릭해 변경. 미분류면 '리스트 지정' 안내.
    row('🗂', '리스트', pjvProjListField(p, reload)),
    // 팀원 = 담당자 — 프로퍼티 팝아웃에서 바로 검색·토글로 넣고 뺀다(#req — 옛 보기전용 pjvProjTeamView 폐기).
    //  보드 행/리스트 헤더의 팀원 셀과 동일 컴포넌트(pjvProjTeamControl) + 조용한 저장(토글마다 즉시 저장,
    //  리로드 없음 — 리로드하면 팝아웃이 닫혀 다중 토글이 안 됨. 아바타는 컨트롤이 자체 갱신).
    row('👤', '팀원', pjvProjTeamControl(members, (ids) => pjvSaveProjMembers(p.id, ids))),
    row('🗓', '기간', pjvProjDatesField(p, reload)),
    row('⚑', '우선순위', pjvPriorityControl(p, (patch) => projPatch(p.id, patch, reload))),
    // (⏱ 시간 추적 필드 제거 — #473 후속, 프로젝트엔 불필요한 속성.)
    row('🏷', '태그', pjvProjTagsField(p, reload)),
    // #541 무손실 이관 가산 — ①프로젝트 자신의 커스텀필드 값(ClickUp 최상위 태스크 값의 표시 표면 = 여기)
    //  ②원본(ClickUp 등) 링크. 둘 다 있을 때만 행 추가(네이티브 프로젝트 UI 는 불변).
    ...((p.fields || []).filter((f) => f && (p.field_values || {})[String(f.id)] !== undefined)
      .map((f) => row('▦', f.name, pjvFieldControl(p, f, () => pjvReloadKeepScroll(reload))))),
    ...(p.external_url ? [row('↗', '원본', el('a', {
      class: 'pjv-proj-extlink', target: '_blank', rel: 'noopener noreferrer',
      href: /^https?:\/\//i.test(String(p.external_url)) ? String(p.external_url) : '#',
      text: (p.external_system === 'clickup' ? 'ClickUp' : (p.external_system || '원본')) + '에서 열기',
    }))] : []));
}

// 선행/후속 프로젝트 필드(프로퍼티) — dir='out'=선행(이 프로젝트가 뒤따르는 앞 프로젝트, edges.outgoing),
//  dir='in'=후속(이 프로젝트를 뒤따르는 뒤 프로젝트, edges.incoming). 칩(상세 링크 + ✕ 해제) + ＋로 검색·추가.
//  방향 의미(#340): from --follow_up--> to = from 이 to 의 후속. 선행 추가=this→pick, 후속 추가=pick→this.
function pjvProjEdgesField(p, reload, dir) {
  const edges = p.edges || { outgoing: [], incoming: [] };
  const list = (dir === 'out' ? edges.outgoing : edges.incoming) || [];
  const wrap = el('div', { class: 'pjv-proj-edges' });
  for (const e of list) {
    const link = el('a', { class: 'pjv-edge-chip-link', href: '#/projects2/p/' + e.project_id,
      title: '#' + e.project_id + ' ' + (e.project_name || ''), text: e.project_name || ('#' + e.project_id) });
    // 모달 안에서 누르면 그 프로젝트 모달로 '교체'(드릴인) — 같은 탭 해시 이동은 모달 뒤에서 라우트만 바꿔
    //  '클릭해도 아무 일 없는' 죽은 클릭이 된다(#804). 태스크 모달의 하위 태스크 드릴인과 동일 결.
    //  전체 페이지에선 기본 동작(같은 탭 이동) 유지 — 거기선 모달이 없어 정상 작동한다.
    link.onclick = (ev) => {
      const pm = _pjvPmOpen;
      if (!pm || !link.closest('.pjv-pm')) return;
      ev.preventDefault();
      pm.close('swap');  // 교체일 뿐이니 뒤 화면(보드) 재렌더는 생략 — 새 모달이 곧 그 위를 덮는다. URL 항목은 새 모달이 이어받는다(#808)
      pjvOpenProjectModal(e.project_id, pm.pageReload);
    };
    const chip = el('span', { class: 'pjv-edge-chip' }, link);
    const x = el('button', { class: 'pjv-edge-chip-x', type: 'button', title: '관계 해제', text: '✕' });
    x.onclick = async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const fromId = dir === 'out' ? p.id : e.project_id;
      const toId = dir === 'out' ? e.project_id : p.id;
      try {
        await api('/api/ui/v6/projects/' + fromId + '/link', { method: 'POST', body: JSON.stringify({ to: toId, relation: e.relation || 'follow_up', unlink: true }) });
        toast('관계를 해제했습니다'); pjvReloadKeepScroll(reload);
      } catch (err) { toast('해제 실패 — ' + err.message, true); }
    };
    chip.append(x);
    wrap.append(chip);
  }
  const addBtn = el('button', { class: 'pjv-edge-add' + (list.length ? '' : ' empty'), type: 'button',
    title: dir === 'out' ? '선행 프로젝트 추가' : '후속 프로젝트 추가',
    text: list.length ? '＋' : ('＋ ' + (dir === 'out' ? '선행' : '후속')) });
  addBtn.onclick = (e) => { e.stopPropagation(); pjvProjEdgePicker(addBtn, p, dir, reload); };
  wrap.append(addBtn);
  return wrap;
}

// 선행/후속 추가 팝오버 — 프로젝트 검색(이름/번호) → 선택 시 엣지 연결. 이미 연결된 것·자기 자신 제외.
function pjvProjEdgePicker(anchor, p, dir, reload) {
  const edges = p.edges || { outgoing: [], incoming: [] };
  const existing = new Set([...(edges.outgoing || []).map((e) => e.project_id), ...(edges.incoming || []).map((e) => e.project_id), p.id]);
  const menu = el('div', { class: 'pjv-menu pjv-edge-pick' });
  const search = el('input', { type: 'search', class: 'pjv-edge-pick-search', placeholder: '프로젝트 검색(이름/번호)' });
  const results = el('div', { class: 'pjv-edge-pick-results' });
  menu.append(
    el('div', { class: 'pjv-edge-pick-hint', text: dir === 'out' ? '이 프로젝트가 뒤따르는 선행 프로젝트를 고르세요' : '이 프로젝트를 뒤따르는 후속 프로젝트를 고르세요' }),
    search, results);
  // 기존 프로젝트를 고르는 것 외에, '새 프로젝트 만들기'(#519) — 새 프로젝트 폼을 열되 현재 프로젝트를 선행/후속으로 프리필하고,
  //  현재 프로젝트의 본문(설명)·연결된 지식도 새 폼에 이어받게(#519/C). dir='in'=현재가 새 프로젝트의 선행이 됨.
  const createNew = el('button', { class: 'pjv-menu-item pjv-edge-pick-new', type: 'button' },
    el('span', { class: 'pjv-edge-pick-name', text: '＋ 새 프로젝트 만들기' }),
    el('span', { class: 'pjv-edge-pick-id', text: dir === 'out' ? '이 프로젝트의 선행으로' : '이 프로젝트의 후속으로' }));
  createNew.onclick = () => {
    close();
    const kdefs = [...(((p.knowledge || {}).required) || []), ...(((p.knowledge || {}).produced) || [])];
    openProjectV2Form(reload, { edgeWith: p.id, edgeDir: dir, listId: p.list_id, description: p.description || '', knowledge: kdefs });
  };
  menu.append(createNew);
  const close = pjvPopover(anchor, menu);
  let all: any[] = [];
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const items = all.filter((pr) => !existing.has(pr.id) && (!q || (pr.name || '').toLowerCase().includes(q) || String(pr.id).includes(q))).slice(0, 30);
    results.replaceChildren(...(items.length ? items.map((pr) => {
      const b = el('button', { class: 'pjv-menu-item pjv-edge-pick-item', type: 'button' },
        el('span', { class: 'pjv-edge-pick-name', text: pr.name || '제목 없음' }),
        el('span', { class: 'pjv-edge-pick-id', text: '#' + pr.id }));
      b.onclick = async () => {
        b.disabled = true;
        const fromId = dir === 'out' ? p.id : pr.id;
        const toId = dir === 'out' ? pr.id : p.id;
        try {
          await api('/api/ui/v6/projects/' + fromId + '/link', { method: 'POST', body: JSON.stringify({ to: toId, relation: 'follow_up' }) });
          toast('연결했습니다'); close(); pjvReloadKeepScroll(reload);
        } catch (e) { b.disabled = false; toast('연결 실패 — ' + e.message, true); }
      };
      return b;
    }) : [el('div', { class: 'pjv-menu-empty', text: q ? '결과 없음' : '연결할 다른 프로젝트가 없어요' })]));
  };
  search.addEventListener('input', paint);
  results.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  (async () => { try { all = await api('/api/ui/v6/projects').then((d) => (d && d.projects) || []); } catch (_) { all = []; } paint(); })();
  setTimeout(() => { try { search.focus(); } catch (_) { /* noop */ } }, 0);
}

export { pjvProjMetaPanel };

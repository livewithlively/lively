// projects/list-forms-folder.ts — #1405 W2: list-forms.ts 분할 ①.
//  폴더(스페이스·아카이브 포함) 판별과 폴더 만들기/고치기 폼 + 위치 선택 필드,
//  그리고 리스트·폴더가 공유하는 색/아이콘 팔레트(레거시 색 보정 포함).
//  순수 잎 — 리스트 폼과 상태 편집기가 이쪽을 본다.
import { api, el, toast, visAxisOn } from '../core.js';
import { overlayBox } from '../learn.js';
import { memberPicker } from './files.js';
import { compactPicker } from './popover.js';

// 스페이스 판정(#766) — 커넥터 미러(external_id 'space:…', #541) 또는 네이티브(settings.kind==='space'). 백엔드 folderIsSpace 와 동형.
function pjvFolderIsSpace(f): boolean {
  return !!(f && ((typeof f.external_id === 'string' && f.external_id.startsWith('space:')) || (f.settings && f.settings.kind === 'space')));
}

// 아카이브 판정 — 백엔드 folderIsArchive 와 동형(settings.kind==='archive').
function pjvFolderIsArchive(f): boolean {
  return !!(f && f.settings && f.settings.kind === 'archive');
}

// 새 폴더/스페이스 · 폴더 수정 폼 — 이름·색(정리용, 멤버 없음).
//  #766 opts.kind='space' → 스페이스 생성(최상위 구획). 일반 폴더는 '상위 스페이스' 선택으로 스페이스
//  하위에 생성/이동(opts.parentId = 초기 상위). 수정 시 folder 가 스페이스면 상위 선택 숨김(최상위 전용).
// ── 위치(스페이스 › 폴더) 선택 필드(#1067) ─────────────────────────────────
//  불변식: **리스트·폴더는 반드시 어떤 스페이스 아래에 있다.** '최상위(스페이스 미지정)' 선택지를 없앤 이유 —
//  스페이스 밖에 리스트가 쌓이면 사이드바에 소속 없는 덩어리가 생기고, 브레드크럼도 '프로젝트 / 리스트' 로 끊겨
//  이 리스트가 어느 제품·조직의 것인지 화면에서 알 수 없다. (기존 최상위 리스트 11개는 #1067 에서 폴더로 정리했다.)
//  옵션은 스페이스를 optgroup 으로, 그 안에 하위 폴더를 '└' 들여쓰기로. 아카이브는 후보에서 뺀다(치워두는 곳이지 만드는 곳이 아니다).
function pjvLocationField(currentId, opts?: any) {
  opts = opts || {};
  const sel: any = el('select', { class: 'pjv-cat-select', disabled: 'disabled' });
  sel.append(el('option', { value: '', text: '불러오는 중…' }));
  let loaded = false;
  const setDefault = () => { if (!sel.value && sel.options.length) sel.selectedIndex = 0; };
  (async () => {
    let folders: any[] = [];
    try { folders = await api('/api/ui/v6/project-folders').then((d) => (d && d.folders) || []); }
    catch (_) { sel.replaceChildren(el('option', { value: '', text: '불러오지 못했어요 — 다시 시도해 주세요' })); return; }
    const byParent = new Map<any, any[]>();
    for (const f of folders) { const k = f.parent_id ?? null; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k)!.push(f); }
    const roots = (byParent.get(null) || []).filter((f) => !pjvFolderIsArchive(f));
    sel.replaceChildren();
    const addUnder = (f, depth, group) => {
      if (pjvFolderIsArchive(f)) return;
      if (!(opts.excludeId != null && String(opts.excludeId) === String(f.id))) {
        const o: any = el('option', { value: String(f.id), text: (depth ? '\u00a0\u00a0'.repeat(depth) + '└ ' : '') + f.name });
        if (currentId != null && String(currentId) === String(f.id)) o.selected = true;
        (group || sel).append(o);
      }
      for (const c of (byParent.get(f.id) || [])) addUnder(c, depth + 1, group);
    };
    for (const r of roots) {
      const og: any = el('optgroup', { label: r.name });
      addUnder(r, 0, og);
      sel.append(og);
    }
    if (!sel.options.length) sel.append(el('option', { value: '', text: '스페이스가 없어요 — 먼저 스페이스를 만들어 주세요' }));
    sel.disabled = false;
    loaded = true;
    setDefault();
  })();
  const row = el('div', { class: 'field', style: 'margin-top:12px' },
    el('label', { class: 'field-label', text: opts.label || '위치 (스페이스 · 폴더)' }),
    sel,
    el('div', { class: 'field-hint', text: opts.hint || '모든 리스트는 스페이스 안에 있어야 해요 — 어디에 둘지 골라 주세요.' }));
  return { row, select: sel, ready: () => loaded, getSelected: () => { const v = sel.value; return v ? Number(v) : null; } };
}

function openFolderForm(reload, folder?, opts?) {
  opts = opts || {};
  const editing = !!folder;
  const isSpace = editing ? pjvFolderIsSpace(folder) : (opts.kind === 'space');
  const kindLabel = isSpace ? '스페이스' : '폴더';
  const nameIn = el('input', { type: 'text', value: editing ? folder.name : '', placeholder: kindLabel + ' 이름 (예: ' + (isSpace ? 'Lively 제품' : '개인신용대출') + ')', maxlength: '120' });
  let color = editing ? (folder.color || '') : '';
  const swatches = el('div', { class: 'pjv-color-swatches' });
  const paintSw = () => {
    const none = el('button', { class: 'pjv-sw pjv-sw-none' + (color ? '' : ' on'), type: 'button', title: '자동(이름 해시색)', text: 'A' });
    none.onclick = () => { color = ''; paintSw(); };
    const curSw = pjvHarmonizeColor(color); // 옛 고채도 값이 저장돼 있어도 대응 스와치가 선택돼 보이게
    swatches.replaceChildren(none, ...PJV_LIST_COLORS.map((c) => {
      const s = el('button', { class: 'pjv-sw' + (curSw === c ? ' on' : ''), type: 'button', style: 'background:' + c, title: c });
      s.onclick = () => { color = c; paintSw(); };
      return s;
    }));
  };
  paintSw();
  // 상위 스페이스 선택(#766) — 일반 폴더만(스페이스는 최상위 전용이라 숨김). 스페이스 목록을 비동기 로드.
  const initialParent: number | null = editing ? (folder.parent_id ?? null) : (opts.parentId != null ? Number(opts.parentId) : null);
  const parentSel: any = el('select', { class: 'pjv-cat-select' });
  const parentField = el('div', { class: 'field', style: 'margin-top:12px' },
    el('label', { class: 'field-label', text: '상위 스페이스' }), parentSel,
    el('div', { class: 'field-hint', text: '모든 폴더는 스페이스 안에 있어야 해요 — 어느 스페이스에 둘지 골라 주세요.' }));
  if (!isSpace) {
    parentSel.append(el('option', { value: '', text: '불러오는 중…' }));
    parentSel.disabled = true;
    (async () => {
      let folders: any[] = [];
      try { folders = await api('/api/ui/v6/project-folders').then((d) => (d && d.folders) || []); }
      catch (_) { parentSel.replaceChildren(el('option', { value: '', text: '불러오지 못했어요 — 다시 시도해 주세요' })); return; }
      // 스페이스만 상위 후보(자기 자신 제외 — 편집 중 폴더는 스페이스가 아니므로 자동 제외됨).
      //  '없음(최상위)' 선택지 폐지(#1067) — 폴더도 반드시 스페이스 안에 있어야 한다(스페이스 미지정 금지).
      const spaces = folders.filter((f) => pjvFolderIsSpace(f) && !pjvFolderIsArchive(f));
      if (!spaces.length) { parentSel.replaceChildren(el('option', { value: '', text: '스페이스가 없어요 — 먼저 스페이스를 만들어 주세요' })); return; }
      parentSel.replaceChildren(
        ...spaces.map((s) => { const o: any = el('option', { value: String(s.id), text: s.name }); if (initialParent != null && Number(initialParent) === Number(s.id)) o.selected = true; return o; }));
      parentSel.disabled = false;
    })();
  }
  // 공개범위(#1291) — 스페이스에만. 여기서 잠그면 **안의 리스트·프로젝트가 모두 상속**한다(하위가 더 넓어질 수 없다).
  //  리스트 폼과 같은 카드형 토글을 쓴다 — 두 화면에서 같은 개념이 다르게 보이지 않게.
  let spaceVis = (editing && isSpace) ? (folder.visibility || 'open') : 'open';
  const spaceVisSw = el('span', { class: 'pjv-switch' + (spaceVis === 'members' ? ' on' : '') }, el('span', { class: 'pjv-switch-knob' }));
  const spaceMemberPicker = compactPicker('공개 대상',
    (onChange) => memberPicker((editing && isSpace ? (folder.members || []) : []).map((m: any) => m.member_id), { includeMe: !editing, onChange }),
    { emptyText: '대상 없음 — 관리자만 볼 수 있어요', avatars: true, maxChips: 6 });
  const spaceMemberField = el('div', { class: 'field', style: 'margin-top:12px' + (spaceVis === 'members' ? '' : ';display:none') }, spaceMemberPicker.row);
  const spaceVisRow = el('div', { class: 'pjv-visrow' + (spaceVis === 'members' ? ' on' : ''), role: 'switch', tabindex: '0',
    'aria-checked': spaceVis === 'members' ? 'true' : 'false' },
    el('span', { class: 'pjv-visrow-txt' },
      el('span', { class: 'pjv-visrow-title', text: '공개범위를 지정한 사람으로 제한' }),
      el('span', { class: 'pjv-visrow-hint', text: '켜면 이 스페이스와 그 안의 리스트·프로젝트·파일·AI 세션이 대상 외에는 보이지 않아요.' })),
    spaceVisSw);
  const toggleSpaceVis = () => {
    spaceVis = spaceVis === 'members' ? 'open' : 'members';
    const on = spaceVis === 'members';
    spaceVisRow.classList.toggle('on', on); spaceVisSw.classList.toggle('on', on);
    spaceVisRow.setAttribute('aria-checked', on ? 'true' : 'false');
    spaceMemberField.style.display = on ? '' : 'none';
  };
  spaceVisRow.onclick = (e: any) => { e.stopPropagation(); toggleSpaceVis(); };
  spaceVisRow.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSpaceVis(); } });
  //  축이 꺼져 있으면 스페이스 공개범위도 감춘다(리스트와 같은 이유 — 강제 안 되는 컨트롤을 남기지 않는다).
  const spaceVisField = visAxisOn('project')
    ? el('div', { class: 'field', style: 'margin-top:12px' }, spaceVisRow)
    : el('div', { style: 'display:none' });

  const saveBtn = el('button', { class: 'btn btn-primary', text: editing ? '저장' : '만들기' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox(editing ? (kindLabel + ' 수정') : ('새 ' + kindLabel),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '색' }), swatches),
    isSpace ? spaceVisField : null,
    isSpace ? spaceMemberField : null,
    isSpace ? null : parentField,
    el('div', { class: 'pjv-side-nav-hint', style: 'margin-top:10px', text: isSpace ? '스페이스는 최상위 구획이에요 — 안에 폴더·리스트를 담아요.' : '폴더는 정리용이에요 — 멤버·공개범위·상태는 리스트에서 설정해요.' }),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
  let busy = false; // 재진입 가드 — Enter 키반복/Enter+클릭 이중 제출로 2개 생성되던 버그 방지.
  const go = async () => {
    if (busy) return;
    const nm = nameIn.value.trim();
    if (!nm) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    const pid = isSpace ? null : (parentSel.value ? Number(parentSel.value) : null); // 폴더의 상위 스페이스
    // 스페이스 미지정 금지(#1067) — 폴더는 반드시 어느 스페이스 안에.
    if (!isSpace && pid == null) { toast('이 폴더를 둘 스페이스를 골라 주세요', true); parentSel.focus(); return; }
    busy = true; saveBtn.disabled = true;
    try {
      if (editing) {
        const body: any = { name: nm, color: color || null };
        if (!isSpace) body.parent_id = pid;  // 폴더면 상위 반영(이동 포함). 스페이스는 최상위 전용이라 건드리지 않음.
        if (isSpace) { body.visibility = spaceVis; body.members = spaceVis === 'members' ? spaceMemberPicker.getSelected() : []; }
        await api('/api/ui/v6/project-folders/' + folder.id, { method: 'POST', body: JSON.stringify(body) });
      } else {
        const body: any = { name: nm, color: color || null };
        if (isSpace) body.kind = 'space';
        else if (pid != null) body.parent_id = pid;
        const newSpaceVis = isSpace && spaceVis === 'members' ? { visibility: 'members', members: spaceMemberPicker.getSelected() } : null;
        // 새 폴더/스페이스는 맨 위로(#473 후속) — 배치 재정렬 엔드포인트(#541 — 서버가 1..n 재부여).
        const r = await api('/api/ui/v6/project-folders', { method: 'POST', body: JSON.stringify(body) });
        const newId = r && (r.folder ? r.folder.id : r.id);
        // 생성 API 는 공개범위를 받지 않는다(리스트와 같은 계약) — 만든 뒤 한 번 더 보내 잠근다.
        if (newId != null && newSpaceVis) {
          try { await api('/api/ui/v6/project-folders/' + newId, { method: 'POST', body: JSON.stringify(newSpaceVis) }); }
          catch (_) { toast('스페이스는 만들었지만 공개범위 설정에 실패했어요 — 설정에서 다시 시도해 주세요', true); }
        }
        if (newId != null) {
          try {
            const d = await api('/api/ui/v6/project-folders');
            const others = ((d && d.folders) || []).map((x) => x.id).filter((x) => x !== newId);
            if (others.length) await api('/api/ui/v6/project-folders-reorder', { method: 'POST', body: JSON.stringify({ ids: [newId, ...others] }) });
          } catch (_) { /* 재정렬 실패해도 생성은 됨 */ }
        }
      }
      back.remove(); toast(editing ? (kindLabel + '를 수정했습니다') : (kindLabel + '를 만들었습니다')); if (reload) reload();
    } catch (e) { toast('실패 — ' + e.message, true); busy = false; saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  return back;
}

// 리스트 색 팔레트(생성/수정 폼). 빈값='자동'(pjvListAutoColor).
//  #1067 재조정 — 예전 팔레트는 Tailwind 500 급 고채도(#ec4899 핫핑크·#a855f7 바이올렛·#22c55e 형광초록)라
//  상태 칩(진행 중 #f59e0b · 할 일 #94a3b8)과 나란히 두면 채도가 튀어 화면이 색에 끌려갔다.
//  커스텀 필드 옵션에서 이미 쓰던 '차분한 톤' 팔레트(PJV_FIELD_PALETTE)와 같은 계열로 통일한다.
//  (PJV_FIELD_PALETTE 와 같은 값 — 그 상수는 파일 뒤쪽에 선언돼 있어 여기서 참조하면 TDZ 라 값을 그대로 둔다.)
const PJV_LIST_COLORS = ['#6b7cff', '#2bb3a3', '#e6913a', '#e0688e', '#9268d6', '#3f9ae0', '#56b877', '#dd6450', '#7f8aa3'];

// 옛 고채도 값 → 같은 계열의 차분한 톤. 저장된 데이터는 그대로 두고 **그릴 때만** 바꿔 준다
//  (색은 사람이 고른 것이라 DB 를 임의로 덮어쓰지 않는다 — 다시 고르면 새 팔레트 값이 저장된다).
const PJV_LEGACY_LIST_COLORS = {
  '#6c8cff': '#6b7cff', '#22c55e': '#56b877', '#f59e0b': '#e6913a', '#ef4444': '#dd6450',
  '#a855f7': '#9268d6', '#06b6d4': '#3f9ae0', '#ec4899': '#e0688e', '#64748b': '#7f8aa3',
};

function pjvHarmonizeColor(c) {
  if (!c) return c;
  return PJV_LEGACY_LIST_COLORS[String(c).toLowerCase()] || c;
}

// 새 리스트 / 리스트 수정 폼 — 이름·색 (+ 생성 시 참여 멤버). 저장 후 reload.
//  opts.onCreated(list) — 생성(수정 아님) 성공 시 새로 만든 영역(서버 응답 { list })을 넘긴다.
//  새 프로젝트 모달의 분류(영역) 피커가 인라인으로 영역을 만들고 곧장 선택하는 데 쓴다(#337).
// 리스트 설정 아이콘 후보(이모지) — 색 체크글리프 대신 리스트마다 이모지 지정(#475 Color & Icon).
const PJV_LIST_ICONS = ['📁', '📗', '📘', '📙', '💎', '⚙️', '🚀', '🧭', '🧱', '🗂️', '📊', '🔒', '💡', '🎯', '🧪'];

export { PJV_LIST_COLORS, PJV_LIST_ICONS, openFolderForm, pjvFolderIsArchive, pjvFolderIsSpace, pjvHarmonizeColor, pjvLocationField };

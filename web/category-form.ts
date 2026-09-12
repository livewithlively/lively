// category-form.ts — 카테고리 CRUD 폼(#764 재구축에서 knowledge.ts 로부터 이관 — 동작 그대로).
//  소비자: admin.ts(관리 탭 카테고리 설정). WIKI 표면과 무관한 공용 폼이라 별도 모듈로 분리.
import { el, api, toast } from './core.js';
import { overlayBox } from './learn.js';

// ⚠ #1631: 분류축 위의 고정 서랍장(사업·제품·시스템)을 걷어냈다 — SPACE_SUBS 하위 탭도 함께 사라졌다.
//  분류축은 쓰는 사람의 일에서 나온다(학생·양조장 대표에게 「제품/시스템」은 고를 이유가 없는 칸이었다).

// 이름 → 슬러그 키(소문자 a-z0-9-). 한글 등 비-ASCII 는 제거되므로, 결과가 비면 사용자가 키를 직접 입력해야 한다.
function slugifyKey(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s_-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// opts.repos = 레포 레지스트리 이름 목록(관리탭 ▸ 레포). 주어지면 '연결 레포' 다중선택을 띄운다(#1153).
//  카테고리↔레포 명시 매핑 — 지금까지 도메인↔레포는 mapping→code_unit→repo 역산 파생값이라 스캔 표류에
//  흔들리고 부트스트랩 전엔 비어 있었다. "이 분류는 이 레포에 산다"는 사람이 직접 선언할 수 있어야 한다.
// 연결 레포 저장(전체 교체) — 분류 본문 저장과 별개 엔드포인트라 따로 부른다.
function saveRepos(categoryId, repos) {
  return api('/api/ui/categories/' + categoryId + '/repos', {
    method: 'POST', body: JSON.stringify({ repos }),
  });
}

// ════════ 카테고리 묶음(#1631) — **화면에서만 보이는 2단**. 데이터는 1단 그대로다. ════════
//  지식은 여전히 카테고리 **하나**에만 속하고, 묶음은 분류기 후보에도 증류기 목적지에도 검색·소환에도
//  들어가지 않는다. 있는 이유는 하나다 — 카테고리가 10개를 넘으면 한눈에 구조가 안 보인다.
//  그래서 묶음이 틀려도 지식은 한 건도 안 움직인다(화면에서 한 칸 옆에 보일 뿐이다).
//
//  ⚠ 계약(타입·조회·고르는 칸)이 **여기 한 벌만** 사는 이유: 소비자가 셋인데(분류체계 탭 web/categories.ts ·
//   WIKI 사이드바 web/wiki-side.ts · 이 폼) 그중 아무도 되짚지 않는 리프가 이 파일이다.
//   categories.ts 가 쥐면 categories → category-form → categories 로 순환이 된다.
interface CatGroup {
  id?: number;
  key: string;
  name?: string;
  sort?: number;
  state?: string;
  category_count?: number;
  hint?: string;
}

/** 묶음의 화면 이름 — 이름이 비면 key 로 떨어진다(이름표가 통째로 사라지지 않게). */
function catGroupName(g: CatGroup): string {
  return (g && (g.name || g.key)) || '';
}

/**
 * 묶음 목록. **서버에 이 API 가 아직 없거나 실패하면 빈 배열**을 준다 — 호출부는 빈 배열을
 *  «묶음이 없다» 로 읽어 종전 평면 화면으로 그대로 떨어진다(이 레포 관례의 graceful).
 *  그래서 이 함수는 절대 throw 하지 않는다.
 */
async function fetchCategoryGroups(): Promise<CatGroup[]> {
  try {
    const d = await api('/api/ui/category-groups');
    const raw = (d && d.groups) || [];
    if (!Array.isArray(raw)) return [];
    //  sort 가 비었거나 서로 겹치면 서버가 준 차례가 그대로 남는다(Array.sort 는 안정 정렬).
    return raw.filter((g: any) => g && typeof g.key === 'string' && g.key.trim())
      .sort((a: any, b: any) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
  } catch (_) { return []; }
}

/**
 * 묶음 고르는 칸 — 폼과 목록 행이 **같은 선택지**를 쓰도록 옵션 만드는 자리를 하나로 둔다.
 *  «— 묶음 없음 —» 은 지금 값이 어느 묶음도 아닐 때만 끼운다: 그건 「기타」 같은 영구 서랍이 아니라
 *  «아직 안 정함» 이라서, 한 번 정하고 나면 되돌아갈 칸으로 남겨 두지 않는다.
 */
function categoryGroupSelect(groups: CatGroup[], cur: any, attrs?: any): HTMLSelectElement {
  const has = groups.some((g) => g.key === cur);
  const sel = el('select', Object.assign({ class: 'wikicat-bundle-sel' }, attrs || {}),
    has ? null : el('option', { value: '', text: '— 묶음 없음 —' }),
    ...groups.map((g) => el('option', { value: g.key, text: catGroupName(g), ...(g.hint ? { title: g.hint } : {}) }))) as HTMLSelectElement;
  sel.value = has ? String(cur) : '';
  return sel;
}

function openCategoryForm(existing, reload, opts) {
  const editing = !!existing;
  const repoOptions = (opts && opts.repos) || [];
  const linkedRepos = new Set((editing && Array.isArray(existing.repos)) ? existing.repos : []);
  const nameIn = el('input', { type: 'text', placeholder: '카테고리 이름', maxlength: '200',
    value: editing ? (existing.name || '') : '' });
  const keyIn = el('input', { type: 'text', placeholder: '키 (소문자 영문·숫자·-, 비우면 이름에서 자동)', maxlength: '120',
    value: editing ? (existing.key || '') : '' });
  if (editing) keyIn.disabled = true; // 키는 생성 후 불변(엔드포인트가 수정 지원 안 함)
  // ⚠ textarea 는 value 를 setAttribute 로 못 받는다(el 헬퍼) — 프로퍼티로 직접 대입.
  const shouldIn = el('textarea', { rows: '4', placeholder: '정의·범위·규칙 (should)', maxlength: '8000' });
  shouldIn.value = editing ? (existing.should || '') : '';
  const descIn = el('textarea', { rows: '2', placeholder: '한 줄 설명 (선택)', maxlength: '2000' });
  descIn.value = editing ? (existing.description || '') : '';
  const saveBtn = el('button', { class: 'btn btn-primary', text: editing ? '저장' : '만들기' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });

  // 연결 레포 — 체크박스 나열(레포 수는 조직당 소수라 다중선택 <select> 보다 읽기 쉽다).
  //  레포 레지스트리가 비어 있으면 필드 자체를 띄우지 않는다(고를 게 없는 빈 컨트롤은 소음).
  const repoBoxes: any[] = [];
  let repoField: any = null;
  if (repoOptions.length) {
    const wrap = el('div', { class: 'catform-repos' });
    for (const r of repoOptions) {
      const cb = el('input', { type: 'checkbox', value: r });
      cb.checked = linkedRepos.has(r);
      repoBoxes.push(cb);
      wrap.append(el('label', { class: 'catform-repo' }, cb, el('span', { text: r })));
    }
    repoField = el('div', { class: 'field', style: 'margin-top:12px' },
      el('label', { class: 'field-label', text: '연결 레포 (선택)' }),
      wrap,
      el('p', { class: 'admin-hint', style: 'margin:6px 0 0' },
        '이 분류가 사는 코드 레포입니다. 코드 스캔이 추정하는 것과 별개로, 여기서 직접 정합니다.'));
  }

  // 묶음(#1631) — 화면에서만 보이는 2단. 고를 묶음이 없으면(서버 미지원·빈 목록) **칸 자체를 숨긴다**:
  //  고를 게 없는 빈 컨트롤은 소음이고, 그 상태가 곧 종전 평면 화면이다.
  //  새로 만들 때의 기본값은 첫 묶음 — 비워 두면 만들자마자 「묶음을 정해 주세요」 구획으로 떨어진다.
  const groups: CatGroup[] = (opts && opts.groups) || [];
  const groupSel = groups.length
    ? categoryGroupSelect(groups, editing ? (existing.group || '') : groups[0].key, { 'aria-label': '묶음' })
    : null;
  const groupField = groupSel
    ? el('div', { class: 'field', style: 'margin-top:12px' },
        el('label', { class: 'field-label', text: '묶음' }),
        groupSel,
        el('p', { class: 'admin-hint', style: 'margin:6px 0 0' },
          '분류를 화면에서 갈라 보여 주는 이름표입니다. 분류·검색에는 쓰이지 않으니, 나중에 바꿔도 지식은 움직이지 않습니다.'))
    : null;

  const back = overlayBox(editing ? '분류 수정' : '새 분류',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '키' }), keyIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '정의 — 무엇을 담고 무엇을 담지 않나 (필수)' }), shouldIn,
      el('p', { class: 'admin-hint', style: 'margin:6px 0 0' },
        '이 분류로 무엇이 들어오고 무엇은 옆 분류로 가는지 적어 주세요. 이 글이 없으면 분류가 이름의 어감으로만 판정합니다. 400~600자 권장.')),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '설명 (선택)' }), descIn),
    groupField,
    repoField,
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => nameIn.focus(), 0);

  const go = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    const pickedRepos = repoBoxes.filter((cb) => cb.checked).map((cb) => cb.value);
    try {
      if (editing) {
        await api('/api/ui/categories/' + existing.id, { method: 'POST', body: JSON.stringify({
          name, should: shouldIn.value.trim() || undefined, description: descIn.value.trim() || undefined,
          //  빈 값(= «묶음 없음» 그대로)은 싣지 않는다 — 미변경이지 «비우기» 가 아니다.
          group: (groupSel && groupSel.value) || undefined,
        }) });
        if (repoField) await saveRepos(existing.id, pickedRepos);
        toast('저장했습니다');
      } else {
        const key = (keyIn.value.trim() || slugifyKey(name));
        if (!key) { saveBtn.disabled = false; keyIn.focus(); toast('키를 입력하세요(이름에 영문이 없으면 자동 생성이 안 됩니다)', true); return; }
        //  정의는 **만들 때 필수**다(#1631) — 서버도 40자 하한으로 막지만, 여기서 먼저 막아야
        //   사람이 «왜 실패했는지» 를 그 칸 옆에서 안다(서버 오류 토스트는 어느 칸인지 안 알려 준다).
        if (shouldIn.value.trim().length < 40) {
          saveBtn.disabled = false; shouldIn.focus();
          toast('정의를 40자 이상 적어 주세요 — 무엇을 담고 무엇을 담지 않는지가 있어야 분류가 됩니다', true);
          return;
        }
        const r = await api('/api/ui/categories', { method: 'POST', body: JSON.stringify({
          key, name, should: shouldIn.value.trim(), description: descIn.value.trim() || undefined,
          group: (groupSel && groupSel.value) || undefined,
        }) });
        // 레포는 생성 응답의 id 로 이어 저장. id 를 못 받으면(응답 형태 변화) 분류 생성 자체는 성공했으므로
        //  실패로 되돌리지 않고 레포만 건너뛴다 — 사용자는 [수정]에서 다시 지정할 수 있다.
        const newId = r && r.category && r.category.id;
        if (repoField && newId && pickedRepos.length) await saveRepos(newId, pickedRepos);
        toast('분류를 만들었습니다');
      }
      back.remove();
      reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) go(); });   // IME 가드(#505)
}

export { catGroupName, categoryGroupSelect, fetchCategoryGroups, openCategoryForm, slugifyKey, type CatGroup };

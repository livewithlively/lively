// categories.ts — 분류체계 탭(#1153). 구 '도메인 맵' 탭(web/domainmap.ts)의 자리를 대체한다.
//
//  ★ 이 탭의 첫 번째 목표: **분류체계 정의가 아웃데이티드되지 않게 관리하는 것.**
//   그래서 드러내는 것이 debt(should↔is 코드 괴리)가 아니라 **정의 표류**(정의를 고친 뒤 그 아래 새로 쌓인 맥락량)다.
//   근거·결정 전문 = 지식 taxonomy-tab-redesign-1153 (상위 결정 #1045 domain-map-demote-to-light-role-2026-07).
//
//  구 탭에서 걷어낸 것과 그 이유:
//   - 의존 그래프 · should/is 레이어 토글 · PO/개발자 관점: **is 엣지가 0건이고 imports 자동수집 경로가 없다**
//     (생성 경로는 domainmap_ingest payload 하나 — reconcile.ts:116, "하네스가 imports 공급"). 그릴 데이터가 없다.
//   - should 엣지 CRUD: 실사용 2건, 소비자는 그 그래프 하나였다. 테이블·API 는 존치(가드레일 프로토타입 기반).
//   - debt 축: #1045 에서 제품 일급 제외 결정.
//  가져온 것: 관리탭 [카테고리(분류 체계)] 의 CRUD 전체(admin.ts wikiCategoriesPanel) — 분류체계 정립은
//   조직 '설정'이 아니라 상시 업무라, 주인을 관리탭에서 이 탭으로 옮겼다(#837 의 일원화 지점을 이동).
//
//  패턴 = Settings(목록 + 폼 모달). 컴포넌트는 wikicat-* 를 그대로 재사용한다(신규 CSS 최소).
import { api, busy, el, errorNote, fmtNum, pageHead, toast, uiText } from './core.js';
import { skeleton } from './learn.js';
import { confirmDialog, hasScope } from './admin.js';
import { copyText } from './ui-primitives.js';
import { openCategoryForm } from './category-form.js';

// 분류축이 0개인 조직에 줄 착지점(#1618) — AI 에게 맡기는 프롬프트.
//  스킬 이름을 문장에 박는 이유: 하네스가 그 이름으로 절차(정의 규격·경계 문장·이동 규칙)를 찾아간다.
//  '확인을 받아'를 넣는 이유: 분류축은 한번 세우면 지식이 그 위에 쌓여서, 말없이 만들어지면 되돌리기가 비싸다.
const TAXONOMY_PROMPT =
  "우리 조직의 분류체계(카테고리)를 처음부터 세워줘. `lively-taxonomy` 스킬을 따라서 — " +
  "우리가 무슨 일을 하는지 먼저 파악하고(지식·프로젝트·레포를 훑어), 사업·제품·시스템 아래 " +
  "하위 분류를 제안해줘. 각 분류에는 범위·포함·경계가 드러나는 정의를 붙이고, " +
  "만들기 전에 목록을 보여주고 내 확인을 받아.";

// 어긋남 판정 — 정의(should) 벡터에서 먼 소속 지식이 몇 건인가. 절대 기준이 없으니 보수적으로 잡는다
//  (거짓 경보가 반복되면 배지 자체가 무시되고, 그러면 진짜 어긋남도 함께 묻힌다).
const MISMATCH_WARN = 5;   // 이 이상이면 정의를 다시 볼 때가 됐다
const MISMATCH_NOTE = 1;   // 한 건이라도 있으면 참고 표시

// 'unmeasured' = 재지 못한 상태(정의 없음 · 임베딩 off · 백필 대기). **0 과 뭉개면 거짓 초록불이 된다.**
function mismatchLevel(c: any): 'unmeasured' | 'none' | 'note' | 'warn' {
  if (!c.mismatch_measurable || c.mismatch_count == null) return 'unmeasured';
  const n = Number(c.mismatch_count);
  if (n >= MISMATCH_WARN) return 'warn';
  if (n >= MISMATCH_NOTE) return 'note';
  return 'none';
}

/**
 * 분류축 목록 본문(#1419 T6) — 페이지 머리 없이 목록만 그린다.
 *  [맥락 관리 ▸ 분류 ▸ 분류축] 서브탭이 이걸 부른다. 구 전체페이지(renderCategories)는 이 함수를
 *  머리와 함께 감싸는 얇은 껍데기가 됐다 — **본문 구현은 하나**다(두 화면이 같은 CRUD 를 각자 갖지 않게).
 */
async function renderCategoryList(view: any) {
  return renderCategoriesInner(view, false);
}

async function renderCategories(view: any) {
  return renderCategoriesInner(view, true);
}

async function renderCategoriesInner(view: any, withHead: boolean) {
  const canEdit = hasScope('context');
  view.replaceChildren(skeleton('분류체계를 불러오는 중'));

  let cats: any[] = [], teams: any[] = [], repos: string[] = [];
  try {
    const [catRes, teamRes, repoRes] = await Promise.all([
      api('/api/ui/categories'),
      api('/api/ui/teams').then((d) => (d && d.teams) || []).catch(() => []),
      api('/api/ui/repos').then((d) => (d && d.repos) || []).catch(() => []),
    ]);
    cats = (catRes && catRes.categories) || [];
    teams = teamRes; repos = repoRes;
  } catch (e) {
    view.replaceChildren(...[
      withHead ? pageHead('분류체계', null, [], '분류체계') : null,
      errorNote(e, '분류체계를 불러오지 못했습니다'),
    ].filter(Boolean));
    return;
  }

  const reload = () => renderCategoriesInner(view, withHead);
  const head = withHead
    ? pageHead('분류체계',
        '지식과 프로젝트를 어떤 갈래로 나눌지 정합니다. 정의가 오래되면 여기서 먼저 드러납니다.', [], '분류체계')
    : el('p', { class: 'admin-hint' },
        '지식과 프로젝트를 어떤 갈래로 나눌지 정합니다. 분류기는 여기 적힌 정의(범위·규칙)를 기준으로 판단하므로, 정의가 비면 분류 기준도 없습니다.');

  // ── 정의가 비었거나 내용과 어긋난 것을 상단에 모아 보여준다 — 이 탭이 존재하는 이유라 목록보다 먼저 온다. ──
  const noDef = cats.filter((c) => !(c.should || '').trim());
  const mismatched = cats.filter((c) => (c.should || '').trim() && mismatchLevel(c) === 'warn');
  const summary = el('div', { class: 'wikicat-summary' });
  if (noDef.length || mismatched.length) {
    const bits: any[] = [];
    if (noDef.length) bits.push(el('span', { class: 'pill pill-warn', text: `정의 없음 ${noDef.length}` }));
    if (mismatched.length) bits.push(el('span', { class: 'pill pill-warn', text: `분류 어긋남 ${mismatched.length}` }));
    summary.append(el('div', { class: 'wikicat-summary-row' }, ...bits,
      el('span', { class: 'wikicat-summary-txt' },
        ...uiText('정의(범위·규칙)가 비어 있거나, 담긴 지식이 다른 분류의 정의에 더 가깝습니다. 행을 눌러 무엇인지 보고 — 정의를 넓히거나, 그 지식을 옮기세요.'))));
  } else if (cats.length) {
    summary.append(el('div', { class: 'wikicat-summary-row' },
      el('span', { class: 'pill pill-ok', text: '정의와 내용 일치' }),
      el('span', { class: 'wikicat-summary-txt', text: '모든 분류에 정의가 있고, 정의에서 크게 벗어난 지식도 없습니다.' })));
  }

  //  #1631: 종전엔 사업/제품/시스템 3묶음으로 갈라 그렸다. 그 축이 없어져 한 묶음이다.
  const list = el('div', { class: 'wikicat' });
  {
    const items = cats;
    const groupHead = el('div', { class: 'wikicat-grouphead' },
      el('span', { class: 'wikicat-grouptitle', text: '분류축' }),
      el('span', { class: 'wikicat-groupcount', text: String(items.length) }));
    if (canEdit) {
      groupHead.append(el('button', {
        class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 추가',
        onclick: () => openCategoryForm(null, reload, { repos }),
      }));
    }

    const rows = el('div', { class: 'wikicat-rows' });
    if (!items.length) {
      rows.append(el('div', { class: 'wikicat-empty', text: '아직 없습니다.' }));
    } else {
      for (const c of items) rows.append(categoryRow(c, { canEdit, teams, repos, reload }));
    }
    list.append(el('div', { class: 'wikicat-group' }, groupHead, rows));
  }

  view.replaceChildren(...[
    head,
    canEdit ? null : el('p', { class: 'admin-hint' },
      el('span', { class: 'pill', text: '읽기 전용' }), ' 편집은 context 권한이 필요합니다.'),
    // 분류축이 **하나도** 없을 때만 착지점을 준다(#1618).
    cats.length === 0 ? emptyTaxonomyCard(canEdit) : null,
    summary,
    list,
  ].filter(Boolean));
}

/**
 * 분류축 0개 — 이 화면에서 가장 중요한 순간이다.
 *
 *  왜 특별 취급하나: 분류축이 없으면 들어오는 지식이 전부 미분류가 되고, **미분류 지식은 AI 가 검색해도
 *  안 나온다**(소환 질의가 분류를 타고 조인한다). 즉 지식을 아무리 쌓아도 안 쓰이는 상태인데, 종전 화면은
 *  공간마다 '아직 없습니다' 한 줄만 보여줘서 그 사실도, 무엇을 해야 하는지도 알 수 없었다.
 *
 *  왜 AI 경로를 1순위로 두나: 처음 세우는 사람에게 "사업·제품·시스템 아래 하위 분류를 만드세요"는 백지다.
 *  분류축 설계는 정의 규격·인접 축 경계·이동 규칙이 얽힌 일이라 이미 스킬(lively-taxonomy)로 정리돼 있는데,
 *  그 존재가 웹에서는 전혀 발견되지 않았다. 여기서 프롬프트를 그대로 쥐여준다.
 *  (업종별 템플릿을 심는 대안은 택하지 않았다 — 조직마다 축이 달라서 잘못된 축을 굳힐 위험이 더 크다.)
 */
function emptyTaxonomyCard(canEdit: boolean) {
  const card = el('div', { class: 'card ctx-empty', style: 'margin:14px 0' },
    el('p', { class: 'ctx-empty-t', text: '분류축이 아직 없습니다' }),
    el('p', { class: 'admin-hint' },
      ...uiText('분류축은 지식과 프로젝트를 담는 갈래입니다. 갈래가 없으면 새로 들어오는 지식이 전부 「미분류」가 되고, 미분류 지식은 AI 가 검색해도 나오지 않습니다 — 쌓이기는 하는데 쓰이지 않습니다.')));

  if (!canEdit) {
    card.append(el('p', { class: 'admin-hint', text: '분류축을 만들 권한이 없습니다 — 관리자에게 요청하세요.' }));
    return card;
  }

  const pre = el('pre', { class: 'mono', style: 'white-space:pre-wrap;font-size:12px;margin:10px 0 0;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg-tint)', text: TAXONOMY_PROMPT });
  const copy = el('button', { class: 'btn btn-primary btn-sm', text: '프롬프트 복사' });
  copy.addEventListener('click', async () => {
    toast(await copyText(TAXONOMY_PROMPT) ? 'AI 에게 줄 문장을 복사했습니다' : '복사하지 못했습니다 — 아래 문장을 직접 선택해 복사하세요', false);
  });
  card.append(
    el('p', { class: 'admin-hint', style: 'margin-top:10px' },
      el('b', { text: 'AI 에게 맡기기 (권장) — ' }),
      el('span', { text: '아래 문장을 그대로 주면 우리가 하는 일을 훑어 분류축을 제안합니다. 만들기 전에 목록을 보여주고 확인을 받습니다.' })),
    el('div', { class: 'mini-meta', style: 'gap:8px;margin-top:8px' },
      copy,
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/terminal', target: '_blank', rel: 'noopener', text: 'AI 세션 열기 ↗' })),
    pre,
    el('p', { class: 'admin-hint', style: 'margin-top:12px', text: '직접 만들려면 아래 공간별 [+ 추가] 를 쓰세요.' }));
  return card;
}

// 한 행 — 이름·키·오너 팀·정의 한 줄 + 표류 배지 + 연결 레포. 액션은 hover 시 진해진다(wikicat-row-acts).
function categoryRow(c: any, ctx: { canEdit: boolean; teams: any[]; repos: string[]; reload: () => void }) {
  const { canEdit, teams, repos, reload } = ctx;
  const should = (c.should || '').trim();

  // 정의(should) — 편집에 들어가기 전에도 항상 노출. 비었으면 '있고 채울 수 있다'를 알리는 placeholder.
  const shouldLine = should
    ? el('span', { class: 'wikicat-should', title: should },
        el('span', { class: 'wikicat-should-label', text: '정의·범위·규칙' }), should)
    : el('span', { class: 'wikicat-should wikicat-should-empty' },
        el('span', { class: 'wikicat-should-label', text: '정의·범위·규칙' }),
        canEdit ? uiText('미설정 — 오른쪽 [수정]에서 입력할 수 있어요') : '미설정');

  // 어긋남 배지 — 이 탭의 핵심 신호. 정의가 없으면 어긋남을 잴 대상이 없으니 생략(정의 없음이 더 강한 신호).
  let mismatchEl: any = null;
  if (should) {
    const lv = mismatchLevel(c);
    const n = Number(c.mismatch_count || 0);
    if (lv === 'unmeasured') {
      // 못 잰 것을 '이상 없음'으로 보이게 하지 않는다 — 거짓 초록불이 이 탭 전체의 신뢰를 깎는다.
      mismatchEl = el('span', { class: 'wikicat-drift', title: '정의와 내용의 대조는 의미 검색(임베딩)이 켜져 있어야 합니다. 켜져 있다면 아직 계산 대기 중입니다.' },
        el('span', { class: 'wikicat-drift-date', text: '대조 전' }));
    } else if (lv === 'none') {
      mismatchEl = el('span', { class: 'wikicat-drift', title: '이 분류의 지식이 모두 다른 어떤 분류의 정의보다 이 정의에 가깝습니다.' },
        el('span', { class: 'wikicat-drift-date', text: '정의와 일치' }));
    } else {
      // 경보 색은 기존 .pill-warn 을 그대로 얹는다(새 색 리터럴을 만들지 않는다 — DS 컬러 예산).
      mismatchEl = el('span', { class: 'wikicat-drift' + (lv === 'warn' ? ' pill pill-warn' : ''),
        title: '이 분류의 정의보다 다른 분류의 정의에 더 가까운 지식입니다. 눌러서 무엇인지 보고 — 정의를 넓히거나 그 지식을 옮기세요.' },
        el('span', { class: 'wikicat-drift-date', text: '다른 분류에 더 가까움' }),
        el('span', { class: 'wikicat-drift-n', text: fmtNum(n) + '건' }));
    }
  }

  // 오너 팀 — 카테고리 소유(표면화·주입의 '우리 팀' 기준). 오너십=우선순위이지 접근제한이 아니다.
  let ownerEl: any = null;
  if (canEdit) {
    const ownerSel = el('select', { class: 'wikicat-owner-sel', 'aria-label': '오너 팀' },
      el('option', { value: '', text: '— 오너 없음 —' }),
      ...teams.map((t) => el('option', { value: String(t.id), text: t.name || t.key }))) as HTMLSelectElement;
    ownerSel.value = c.owner_team_id ? String(c.owner_team_id) : '';
    ownerSel.addEventListener('change', async () => {
      const prev = c.owner_team_id ? String(c.owner_team_id) : '';
      try {
        await api('/api/ui/categories/' + c.id + '/owner', { method: 'POST',
          body: JSON.stringify({ team_id: ownerSel.value ? Number(ownerSel.value) : null }) });
        c.owner_team_id = ownerSel.value ? Number(ownerSel.value) : null;
        toast('오너 팀을 변경했습니다');
      } catch (e) { toast((e as Error).message, true); ownerSel.value = prev; }
    });
    ownerEl = el('span', { class: 'wikicat-owner' },
      el('span', { class: 'wikicat-owner-label', text: '오너 팀' }), ownerSel);
  } else if (c.owner_team_name) {
    ownerEl = el('span', { class: 'wikicat-owner' },
      el('span', { class: 'wikicat-owner-label', text: '오너 팀' }),
      el('span', { class: 'wikicat-owner-name', text: c.owner_team_name }));
  }

  // 연결 레포(명시) — 스캔 역산이 아니라 사람이 선언한 것. 없으면 표시하지 않는다(빈 라벨은 소음).
  const linked: string[] = Array.isArray(c.repos) ? c.repos : [];
  const repoEl = linked.length
    ? el('span', { class: 'wikicat-repos', title: '이 분류가 사는 코드 레포(명시 설정)' },
        el('span', { class: 'wikicat-repos-label', text: '레포' }),
        el('span', { class: 'wikicat-repos-v', text: linked.join(' · ') }))
    : null;

  const main = el('div', { class: 'wikicat-row-main' },
    el('span', { class: 'wikicat-name', text: c.name || c.key }),
    el('span', { class: 'wikicat-key mono', text: c.key }),
    c.cross_cutting ? el('span', { class: 'dm-tag', text: '횡단' }) : null,
    mismatchEl, ownerEl, repoEl, shouldLine);

  const acts = canEdit ? el('div', { class: 'wikicat-row-acts' },
    el('button', { class: 'btn btn-ghost btn-sm', text: '수정',
      onclick: () => openCategoryForm(c, reload, { repos }) }),
    el('button', { class: 'btn btn-ghost btn-sm btn-text-danger', text: '삭제',
      onclick: () => deleteCategory(c, reload) })) : null;

  const row = el('div', { class: 'wikicat-row' }, main, acts);

  // 어긋난 게 있으면 행을 펼쳐 **무엇이** 어긋났는지 보여준다 — 숫자만으론 정의를 넓힐지 지식을 옮길지 못 정한다.
  if (should && Number(c.mismatch_count || 0) > 0) {
    const wrap = el('div', { class: 'wikicat-rowwrap' }, row);
    const detail = el('div', { class: 'wikicat-mismatch', hidden: 'hidden' });
    let loaded = false;
    const toggle = el('button', { class: 'btn btn-ghost btn-sm wikicat-expand', type: 'button',
      'aria-expanded': 'false', text: '어긋난 지식 보기' });
    toggle.addEventListener('click', async () => {
      const open = detail.hasAttribute('hidden');
      if (!open) { detail.setAttribute('hidden', 'hidden'); toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = '어긋난 지식 보기'; return; }
      detail.removeAttribute('hidden'); toggle.setAttribute('aria-expanded', 'true'); toggle.textContent = '접기';
      if (loaded) return;
      busy(detail, el('div', { class: 'wikicat-mismatch-loading', text: '불러오는 중…' }));
      try {
        const r = await api('/api/ui/categories/' + c.id);
        const items: any[] = (r && r.mismatches) || [];
        loaded = true;
        if (!items.length) { detail.replaceChildren(el('div', { class: 'wikicat-empty', text: '어긋난 지식이 없습니다.' })); return; }
        const list = el('div', { class: 'wikicat-mismatch-list' });
        for (const m of items) {
          list.append(el('div', { class: 'wikicat-mismatch-row' },
            el('a', { class: 'wikicat-mismatch-t', href: '#/k/' + encodeURIComponent(m.name), text: m.title || m.name }),
            m.nearest_name ? el('span', { class: 'wikicat-mismatch-to', text: '→ ' + m.nearest_name }) : null,
            el('span', { class: 'wikicat-mismatch-d', title: '이 분류의 정의보다 저 분류의 정의에 이만큼 더 가깝습니다', text: String(m.margin) })));
        }
        detail.replaceChildren(
          el('p', { class: 'admin-hint', style: 'margin:0 0 8px' },
            ...uiText('이 분류의 정의보다 다른 분류의 정의에 더 가까운 지식입니다. 정의가 이들을 품어야 하면 [수정]에서 정의를 넓히고, 아니면 화살표가 가리키는 분류로 옮기세요.')),
          list);
      } catch (e) {
        detail.replaceChildren(errorNote(e, '어긋난 지식을 불러오지 못했습니다'));
      }
    });
    (acts || main).append(toggle);
    wrap.append(detail);
    return wrap;
  }
  return row;
}

// 삭제 — 지식 매핑·카테고리 간 엣지가 함께 사라지므로 무엇이 지워지는지 명시하고 확인받는다.
async function deleteCategory(c: any, reload: () => void) {
  const ok = await confirmDialog({
    title: `‘${c.name || c.key}’ 분류를 삭제할까요?`,
    lines: [
      '이 분류에 연결된 지식 매핑과 분류 간 연결이 함께 삭제됩니다.',
      ...(Number(c.knowledge_count) > 0 ? [`현재 지식 ${fmtNum(c.knowledge_count)}건이 이 분류에 있습니다.`] : []),
    ],
    confirmText: '삭제', danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/ui/categories/' + c.id + '/delete', { method: 'POST' });
    toast('삭제했습니다'); reload();
  } catch (e) { toast('실패 — ' + (e as Error).message, true); }
}

export { renderCategories, renderCategoryList };

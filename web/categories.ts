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
import { api, busy, el, errorNote, fmtNum, pageHead, toast, uiText, wsKey } from './core.js';
import { skeleton } from './learn.js';
import { confirmDialog, hasScope } from './admin.js';
import { copyText } from './ui-primitives.js';
import { catGroupName, categoryGroupSelect, fetchCategoryGroups, openCategoryForm, type CatGroup } from './category-form.js';

// 분류축이 0개인 조직에 줄 착지점(#1618) — AI 에게 맡기는 프롬프트.
//  스킬 이름을 문장에 박는 이유: 하네스가 그 이름으로 절차(정의 규격·경계 문장·이동 규칙)를 찾아간다.
//  '확인을 받아'를 넣는 이유: 분류축은 한번 세우면 지식이 그 위에 쌓여서, 말없이 만들어지면 되돌리기가 비싸다.
const TAXONOMY_PROMPT =
  "우리 조직의 분류체계(카테고리)를 처음부터 세워줘. `lively-taxonomy` 스킬을 따라서 — " +
  "우리가 무슨 일을 하는지 먼저 파악하고(지식·프로젝트·레포를 훑어), 우리 일에서 나오는 " +
  "분류축을 제안해줘. 각 분류에는 범위·포함·경계가 드러나는 정의를 붙이고(정의는 필수야), " +
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

  let cats: any[] = [], teams: any[] = [], repos: string[] = [], groups: CatGroup[] = [];
  try {
    const [catRes, teamRes, repoRes, grpRes] = await Promise.all([
      api('/api/ui/categories'),
      api('/api/ui/teams').then((d) => (d && d.teams) || []).catch(() => []),
      api('/api/ui/repos').then((d) => (d && d.repos) || []).catch(() => []),
      //  묶음(#1631) — 서버에 아직 없거나 실패하면 빈 배열이다(fetchCategoryGroups 는 throw 하지 않는다).
      //   즉 이 한 줄이 안 되더라도 분류 목록은 **종전 평면 그대로** 그려진다.
      fetchCategoryGroups(),
    ]);
    cats = (catRes && catRes.categories) || [];
    teams = teamRes; repos = repoRes; groups = grpRes;
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

  //  #1631: 종전엔 사업/제품/시스템 3묶음으로 갈라 그렸다(분류의 층). 그 축이 없어져 평면 한 묶음이 됐고,
  //   그 위에 **화면에서만 보이는 묶음**(category group)을 다시 올린다 — 표시의 층이라 분류·검색엔 안 낀다.
  const ctx: CatCtx = { canEdit, teams, repos, reload, groups };
  const list = el('div', { class: 'wikicat' });
  //  ★ 무회귀 보증: 묶음이 없으면(서버 미지원·빈 목록·조회 실패 — 셋 다 groups=[] 로 온다) **종전 평면 그대로**.
  //   판정 기준은 묶음 **하나**뿐이다 — 분류가 0개여도 묶음이 있으면 구획을 세운다. 방금 만든 묶음이
  //   «아무 일도 안 일어난 것» 처럼 보이면 안 되고(addBundleBtn), 빈 구획은 채울 자리를 보여 주는 값이다.
  if (groups.length) list.append(...bundleSections(cats, groups, ctx));
  else list.append(flatSection(cats, ctx));

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
 *  '아직 없습니다' 한 줄만 보여줘서 그 사실도, 무엇을 해야 하는지도 알 수 없었다.
 *
 *  왜 AI 경로를 1순위로 두나: 처음 세우는 사람에게 "우리 분류축을 만드세요"는 백지다.
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

//  치우기·되살리기(#1631) — 서버가 «지식 N건이 남아 있다» 로 거절하면 그 문장을 그대로 띄운다
//   (여기서 요약하면 사람이 무엇을 옮겨야 하는지 모른다).
async function setCategoryState(c: any, state: string, reload: () => void) {
  try {
    await api('/api/ui/categories/' + c.id, { method: 'POST', body: JSON.stringify({ state }) });
    toast(state === 'active' ? '되살렸습니다' : '치웠습니다 — 분류 후보에서 빠집니다');
    reload();
  } catch (e: any) { toast(e?.message || '실패', true); }
}

/** 목록 전체가 들고 다니는 것 — 권한·선택지(팀·레포·묶음)와 다시 그리기. */
interface CatCtx { canEdit: boolean; teams: any[]; repos: string[]; reload: () => void; groups: CatGroup[] }

// 분류 만들기 버튼 — 구획마다 두면 «어느 묶음으로 들어가나» 를 버튼마다 다시 물어야 해서, 만들기는
//  머리 한 자리에 두고 묶음은 폼 안에서 고르게 한다.
function addCategoryBtn(ctx: CatCtx) {
  return el('button', { class: 'btn btn-ghost btn-sm wikicat-add', type: 'button', text: '+ 추가',
    onclick: () => openCategoryForm(null, ctx.reload, { repos: ctx.repos, groups: ctx.groups }) });
}

/**
 * 평면 목록 — 묶음이 없을 때의 착지점. 목록 자체는 **종전 화면 그대로**이고, 이 경로가 무회귀의 보증이다.
 *  머리에만 [묶음으로 묶어 보기] 가 선다 — 묶음이 0개인 화면에도 들어가는 문이 없으면, 마지막 묶음을
 *  지운 사람에게 그 층을 되살릴 길이 화면에서 영영 사라진다.
 */
function flatSection(items: any[], ctx: CatCtx) {
  const groupHead = el('div', { class: 'wikicat-grouphead' },
    el('span', { class: 'wikicat-grouptitle', text: '분류축' }),
    el('span', { class: 'wikicat-groupcount', text: String(items.length) }));
  if (ctx.canEdit) groupHead.append(addCategoryBtn(ctx), addBundleBtn(ctx));
  //  안내는 나눌 것이 실제로 있을 때만 — 분류가 0개인 화면은 위의 착지점 카드가 할 말을 이미 하고 있다.
  const intro = ctx.canEdit && items.length
    ? el('p', { class: 'admin-hint wikicat-bundle-intro' },
        ...uiText('분류가 늘어나면 [묶음으로 묶어 보기]로 화면에서만 갈라 볼 수 있습니다 — 묶음은 이름표라 지식은 한 건도 움직이지 않습니다.'))
    : null;
  const rows = el('div', { class: 'wikicat-rows' });
  if (!items.length) rows.append(el('div', { class: 'wikicat-empty', text: '아직 없습니다.' }));
  else for (const c of items) rows.append(categoryRow(c, ctx));
  return el('div', { class: 'wikicat-group' }, groupHead, intro, rows);
}

/**
 * 묶음 만들기 — 이름만 받아 **맨 뒤에** 붙인다(key 는 서버가 이름에서 슬러그로 만든다).
 *
 *  ★ 왜 이 단추가 묶음 0개인 화면에도 서나: 지우기·이름 고치기·순서 바꾸기만 있으면 화면이 **한 방향**이
 *   된다 — 사람이 묶음을 하나씩 지워 0개가 되는 순간 그 층을 되살릴 자리가 아무 데도 없다.
 *  입력은 이 화면의 이름 고치기(startBundleRename)와 **같은 결**로 제자리 인라인이다 — 이름 한 칸을
 *   받자고 모달을 띄우지 않는다.
 */
function addBundleBtn(ctx: CatCtx) {
  const host = el('span', { class: 'wikicat-bundle-add' });
  const first = !ctx.groups.length;   // 평면 화면(묶음 0개)에서는 «무엇이 일어나는지» 를 라벨이 말해야 한다
  function shut() {
    host.replaceChildren(el('button', { class: 'btn btn-ghost btn-sm', type: 'button',
      text: first ? '묶음으로 묶어 보기' : '+ 묶음 추가',
      title: first ? '분류를 화면에서 갈라 보여 줄 이름표를 만듭니다' : '새 묶음을 맨 뒤에 만듭니다',
      onclick: open }));
  }
  function open() {
    const inp = el('input', { class: 'wikicat-bundle-input', type: 'text', maxlength: '60',
      placeholder: '묶음 이름', 'aria-label': '새 묶음 이름' }) as HTMLInputElement;
    const okBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '만들기' });
    const noBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소', onclick: shut });
    const save = async () => {
      const name = inp.value.trim();
      if (!name) { inp.focus(); toast('묶음 이름을 입력하세요', true); return; }
      okBtn.disabled = true;
      //  맨 뒤 — 있는 묶음의 순서를 한 칸도 건드리지 않는다(0개면 0).
      const sort = ctx.groups.reduce((n, g) => Math.max(n, Number(g.sort) || 0), -1) + 1;
      try {
        //  서버는 같은 슬러그면 **덮어쓴다**(upsert 한 창구로 이름 바꾸기·순서 바꾸기도 돈다). 그래서 만든 것과
        //   고친 것을 응답의 created 로 가른다 — 안 가르면 개수가 안 느는데 «만들었습니다» 라고 말하게 된다.
        const made = await api('/api/ui/category-groups', { method: 'POST', body: JSON.stringify({ name, sort }) });
        toast(made && (made as { created?: boolean }).created === false
          ? '같은 이름의 묶음이 이미 있어 그 묶음을 고쳤습니다'
          : '묶음을 만들었습니다');
        //  다시 그리면 그 구획이 (비어 있어도) 서고, 행의 묶음 칸에도 곧바로 선택지로 들어온다.
        ctx.reload();
      } catch (e) { toast('실패 — ' + (e as Error).message, true); okBtn.disabled = false; }
    };
    okBtn.addEventListener('click', save);
    inp.addEventListener('keydown', (e: any) => {
      if (e.key === 'Escape') { shut(); return; }
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) save();   // IME 가드(#505)
    });
    host.replaceChildren(inp, okBtn, noBtn);
    setTimeout(() => inp.focus(), 0);
  }
  shut();
  return host;
}

// ════════ 묶음 구획(#1631) ════════════════════════════════════════════════════
//  «카테고리가 10개를 넘으면 한눈에 구조가 안 보인다» 가 이 구획이 있는 유일한 이유다.
//  묶음은 표시 전용이라 지식은 한 건도 안 움직인다 — 그래서 이름을 바꾸고 순서를 바꾸고 지우는 일이
//  전부 되돌릴 수 있는 일이고, 확인창도 그 사실을 그대로 말한다.

//  접힘은 이 브라우저의 취향이 아니라 **그 워크스페이스의 묶음**을 가리키므로 워크스페이스별로 갈린다(#1875).
const BUNDLE_COLLAPSE_KEY = wsKey('cat:bundles:collapsed');
//  수선 구획의 자리표 — 묶음 key 는 슬러그라 '*' 로 시작하는 이름과 겹치지 않는다.
const BUNDLE_FIX_KEY = '*none';

function readCollapsedBundles(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(BUNDLE_COLLAPSE_KEY) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x: any) => typeof x === 'string') : []);
  } catch (_) { return new Set(); }   // 프라이빗 모드·깨진 값 — 전부 펼친 채로 시작한다
}
function writeCollapsedBundles(s: Set<string>): void {
  try { localStorage.setItem(BUNDLE_COLLAPSE_KEY, JSON.stringify(Array.from(s))); }
  catch (_) { /* 못 남겨도 이번 화면은 그대로 돈다 */ }
}

/** 카테고리를 묶음별로 담는다 — 어느 묶음에도 안 걸린 것은 따로 모아 수선 구획으로 올린다. */
function splitByBundle(cats: any[], groups: CatGroup[]) {
  const byKey = new Map<string, any[]>();
  for (const g of groups) byKey.set(g.key, []);
  const loose: any[] = [];
  for (const c of cats) {
    const bucket = typeof c.group === 'string' ? byKey.get(c.group) : undefined;
    if (bucket) bucket.push(c); else loose.push(c);
  }
  return { byKey, loose };
}

function bundleSections(cats: any[], groups: CatGroup[], ctx: CatCtx) {
  const { byKey, loose } = splitByBundle(cats, groups);
  const collapsed = readCollapsedBundles();
  const out: any[] = [];
  const top = el('div', { class: 'wikicat-grouphead wikicat-tophead' },
    el('span', { class: 'wikicat-grouptitle', text: '분류축' }),
    el('span', { class: 'wikicat-groupcount', text: String(cats.length) + '개' }));
  if (ctx.canEdit) top.append(addCategoryBtn(ctx), addBundleBtn(ctx));
  out.push(top);
  //  수선 구획이 맨 위 — 여기 남아 있는 동안 그 분류는 어느 묶음 구획에도 안 보인다. 0개면 아예 안 그린다.
  if (loose.length) out.push(bundleSection(null, loose, collapsed, ctx, 0));
  for (let i = 0; i < groups.length; i++) {
    out.push(bundleSection(groups[i], byKey.get(groups[i].key) || [], collapsed, ctx, i));
  }
  return out;
}

/**
 * 구획 하나 — 머리(이름·개수·접기·손보기) + 행들.
 *  g=null 이면 **수선 구획**이다. 제목을 «묶음을 정해 주세요» 로 두는 건 제품 결정이다 —
 *  「기타」·「그 밖」 이라고 부르면 영구 서랍처럼 보여서 비우려는 손이 안 간다.
 */
function bundleSection(g: CatGroup | null, items: any[], collapsed: Set<string>, ctx: CatCtx, idx: number) {
  const isFix = !g;
  const key = g ? g.key : BUNDLE_FIX_KEY;
  const nm = g ? catGroupName(g) : '묶음을 정해 주세요';
  const inactive = !!g && (g.state ?? 'active') !== 'active';

  //  머리의 개수 — «분류 N개 · 지식 N건». 지식 수는 그 묶음이 실제로 얼마나 무거운지를 보여 주는 값이라,
  //   셀 수 있을 때만 싣는다(못 잰 것을 0 으로 쓰면 «비었다» 는 거짓말이 된다).
  const hasCounts = items.some((c) => Number.isFinite(Number(c.knowledge_count)));
  const kn = items.reduce((n, c) => n + (Number(c.knowledge_count) || 0), 0);
  const countTxt = '분류 ' + items.length + '개' + (hasCounts ? ' · 지식 ' + fmtNum(kn) + '건' : '');

  const tw = el('button', { class: 'wikicat-bundle-tw', type: 'button', 'aria-expanded': 'true',
    title: '이 구획을 접거나 폅니다', 'aria-label': nm + ' 구획 접기·펼치기', text: '▾' });
  const title = el('span', { class: 'wikicat-grouptitle', text: nm,
    ...(g && g.hint ? { title: g.hint } : {}) });
  const nameWrap = el('span', { class: 'wikicat-bundle-name' }, title);
  const acts = el('div', { class: 'wikicat-bundle-acts' });
  const head = el('div', { class: 'wikicat-bundlehead' },
    tw, nameWrap,
    el('span', { class: 'wikicat-groupcount', text: countTxt }),
    inactive ? el('span', { class: 'pill', title: '치워 둔 묶음입니다.', text: '비활성' }) : null,
    acts);

  const note = isFix
    ? el('p', { class: 'admin-hint wikicat-bundle-note' },
        ...uiText('아래 분류는 아직 어느 묶음에도 들어 있지 않습니다. 행의 「묶음」 칸에서 고르면 그 구획으로 옮겨집니다.'))
    : null;
  const rows = el('div', { class: 'wikicat-rows' });
  if (!items.length) {
    rows.append(el('div', { class: 'wikicat-empty', text: '아직 없습니다 — 분류 행의 묶음 칸에서 이 묶음을 고르면 여기로 옵니다.' }));
  } else {
    for (const c of items) rows.append(categoryRow(c, ctx));
  }

  const setOpen = (open: boolean) => {
    rows.hidden = !open;
    if (note) note.hidden = !open;
    tw.textContent = open ? '▾' : '▸';
    tw.setAttribute('aria-expanded', String(open));
  };
  setOpen(!collapsed.has(key));
  const toggle = () => {
    const open = rows.hidden;   // 지금 닫혀 있으면 연다
    setOpen(open);
    if (open) collapsed.delete(key); else collapsed.add(key);
    writeCollapsedBundles(collapsed);
  };
  tw.addEventListener('click', toggle);
  //  머리 아무 데나 눌러도 접힌다 — 단 안에 있는 컨트롤을 누른 것은 그 컨트롤의 몫이다.
  head.addEventListener('click', (ev: any) => {
    if (ev.target && ev.target.closest && ev.target.closest('button, input, select, a')) return;
    toggle();
  });

  if (ctx.canEdit && g) {
    acts.append(
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '이름 고치기',
        onclick: () => startBundleRename(g, nameWrap, title, acts, ctx) }),
      el('button', { class: 'btn btn-ghost btn-sm wikicat-bundle-move', type: 'button', text: '▲',
        title: '위로 올립니다', 'aria-label': nm + ' 위로 올리기',
        disabled: idx === 0, onclick: () => moveBundle(ctx.groups, idx, -1, ctx.reload) }),
      el('button', { class: 'btn btn-ghost btn-sm wikicat-bundle-move', type: 'button', text: '▼',
        title: '아래로 내립니다', 'aria-label': nm + ' 아래로 내리기',
        disabled: idx === ctx.groups.length - 1, onclick: () => moveBundle(ctx.groups, idx, 1, ctx.reload) }),
      el('button', { class: 'btn btn-ghost btn-sm btn-text-danger', type: 'button', text: '지우기',
        onclick: () => deleteBundle(g, items.length, ctx) }));
  }

  return el('div', { class: 'wikicat-group wikicat-bundle' + (isFix ? ' wikicat-bundle-fix' : '') },
    head, note, rows);
}

/** 묶음 이름 인라인 편집 — 이름은 사람 말이라 자주 바뀐다. 저장하면 목록을 다시 그린다. */
function startBundleRename(g: CatGroup, nameWrap: any, title: any, acts: any, ctx: CatCtx) {
  const inp = el('input', { class: 'wikicat-bundle-input', type: 'text', maxlength: '60',
    value: catGroupName(g), 'aria-label': '묶음 이름' }) as HTMLInputElement;
  const okBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '저장' });
  const noBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소' });
  const restore = () => { nameWrap.replaceChildren(title); acts.hidden = false; };
  const save = async () => {
    const name = inp.value.trim();
    if (!name) { inp.focus(); toast('이름을 입력하세요', true); return; }
    if (name === catGroupName(g)) { restore(); return; }
    okBtn.disabled = true;
    try {
      await api('/api/ui/category-groups', { method: 'POST', body: JSON.stringify({ key: g.key, name }) });
      toast('묶음 이름을 바꿨습니다');
      ctx.reload();
    } catch (e) { toast('실패 — ' + (e as Error).message, true); okBtn.disabled = false; }
  };
  okBtn.addEventListener('click', save);
  noBtn.addEventListener('click', restore);
  inp.addEventListener('keydown', (e: any) => {
    if (e.key === 'Escape') { restore(); return; }
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) save();   // IME 가드(#505)
  });
  acts.hidden = true;
  nameWrap.replaceChildren(inp, okBtn, noBtn);
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}

/**
 * 순서 바꾸기 — **자리(index)로 전부 다시 매긴다.** 서버가 준 sort 가 비었거나 서로 겹치면 두 개만
 *  맞바꿔서는 어느 쪽이 앞인지 정해지지 않기 때문이다. 값이 실제로 달라지는 것만 보낸다(보통 두 건).
 *  실패해도 다시 그린다 — 화면이 서버보다 앞서 있으면 다음 ▲▼ 가 엉뚱한 자리를 민다.
 */
async function moveBundle(groups: CatGroup[], idx: number, delta: number, reload: () => void) {
  const to = idx + delta;
  if (to < 0 || to >= groups.length) return;
  const order = groups.slice();
  order.splice(to, 0, order.splice(idx, 1)[0]);
  try {
    for (let i = 0; i < order.length; i++) {
      if (Number(order[i].sort) === i) continue;
      await api('/api/ui/category-groups', { method: 'POST',
        body: JSON.stringify({ key: order[i].key, name: catGroupName(order[i]), sort: i }) });
    }
    reload();
  } catch (e) { toast('순서를 바꾸지 못했습니다 — ' + (e as Error).message, true); reload(); }
}

/**
 * 묶음 지우기 — 분류가 남아 있으면 **먼저 «어디로 옮길까요» 를 고르게 한 뒤** 보낸다(서버도
 *  reassign_to 없이는 거절한다). 묻는 자리에 답할 컨트롤이 함께 있어야 하므로 확인창 안에 고르는 칸을 같이 낸다.
 */
async function deleteBundle(g: CatGroup, shown: number, ctx: CatCtx) {
  const nm = catGroupName(g);
  //  화면에 보이는 수와 서버가 센 수 중 큰 쪽 — 한쪽만 믿으면 «0인 줄 알았는데 거절» 이 난다.
  const count = Math.max(shown, Number(g.category_count) || 0);
  const others = ctx.groups.filter((x) => x.key !== g.key && (x.state ?? 'active') === 'active');
  if (count > 0 && !others.length) {
    //  막다른 길을 만들지 않는다 — 지금 화면에서 실제로 할 수 있는 다음 손을 가리킨다(#묶음 추가).
    toast('옮길 다른 묶음이 없습니다 — 머리의 [+ 묶음 추가]로 하나 만든 뒤에 지워 주세요', true);
    return;
  }
  const sel = count > 0 ? categoryGroupSelect(others, others[0].key, { 'aria-label': '옮길 묶음' }) : null;
  const ok = await confirmDialog({
    title: '‘' + nm + '’ 묶음을 지울까요?',
    lines: [
      count > 0
        ? '이 묶음에 분류 ' + fmtNum(count) + '개가 있습니다. 고른 묶음으로 함께 옮깁니다.'
        : '이 묶음에는 분류가 없습니다.',
      '묶음은 화면에서 갈라 보여 주는 이름표라, 지식은 한 건도 움직이지 않습니다.',
    ],
    extra: sel ? el('label', { class: 'wikicat-reassign' },
      el('span', { class: 'wikicat-reassign-label', text: '어디로 옮길까요' }), sel) : null,
    confirmText: '지우기', danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/ui/category-groups/' + encodeURIComponent(g.key) + '/delete', {
      method: 'POST', body: JSON.stringify(sel ? { reassign_to: sel.value } : {}) });
    toast('묶음을 지웠습니다'); ctx.reload();
  } catch (e) { toast('실패 — ' + (e as Error).message, true); }
}

// 한 행 — 이름·키·오너 팀·묶음·정의 한 줄 + 표류 배지 + 연결 레포. 액션은 hover 시 진해진다(wikicat-row-acts).
function categoryRow(c: any, ctx: CatCtx) {
  const { canEdit, teams, repos, reload, groups } = ctx;
  const should = (c.should || '').trim();
  const inactive = (c.state ?? 'active') !== 'active';

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

  // 묶음 고르기(#1631) — 고르면 곧바로 저장하고 목록을 다시 그린다(그 행이 고른 구획으로 옮겨진다).
  //  읽기 전용이거나 묶음이 없으면 칸 자체를 안 띄운다 — 그 화면엔 구획도 없으므로 물을 것이 없다.
  let bundleEl: any = null;
  if (canEdit && groups.length) {
    const cur = typeof c.group === 'string' ? c.group : '';
    const sel = categoryGroupSelect(groups, cur, { 'aria-label': '묶음' });
    sel.addEventListener('change', async () => {
      if (sel.value === cur) return;   // «묶음 없음» 을 도로 고른 것 — 바꿀 게 없다
      sel.disabled = true;
      try {
        await api('/api/ui/categories/' + c.id, { method: 'POST', body: JSON.stringify({ group: sel.value }) });
        toast('묶음을 옮겼습니다');
        reload();
      } catch (e) { toast((e as Error).message, true); sel.value = cur; sel.disabled = false; }
    });
    bundleEl = el('span', { class: 'wikicat-bundle-pick' },
      el('span', { class: 'wikicat-bundle-label', text: '묶음' }), sel);
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
    //  #1631: 비활성 축은 «치워 둔 것» 이라 분류 후보에서 빠진다 — 목록에는 남되 그 사실이 보여야 한다.
    inactive ? el('span', { class: 'pill', title: '치워 둔 축입니다 — 새 지식의 분류 후보에서 빠집니다(이미 든 지식은 그대로).', text: '비활성' }) : null,
    mismatchEl, bundleEl, ownerEl, repoEl, shouldLine);

  const acts = canEdit ? el('div', { class: 'wikicat-row-acts' },
    el('button', { class: 'btn btn-ghost btn-sm', text: '수정',
      onclick: () => openCategoryForm(c, reload, { repos, groups }) }),
    //  치우기·되살리기(#1631) — 삭제는 비가역이라 마지막 수단이고, 보통 필요한 건 «분류 후보에서 빼기» 다.
    el('button', { class: 'btn btn-ghost btn-sm', text: inactive ? '되살리기' : '치우기',
      title: inactive ? '다시 분류 후보에 넣습니다' : '분류 후보에서 뺍니다 — 지식이 남아 있으면 거절됩니다(먼저 옮기세요)',
      onclick: () => setCategoryState(c, inactive ? 'active' : 'deprecated', reload) }),
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

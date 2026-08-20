// projects/selection.ts — #1313 R33: web/projects.ts 분해 ④.
//  클릭업식 **다중선택 + 일괄작업** 한 벌 — 선택 모델(pjvSel) · 하단 벌크바(pjvSelRenderBar) · 일괄 액션
//  (상태·담당자·마감·우선순위·태그·복제·삭제·리스트 이동 + '클로드로 실행' 일괄) · 체크박스 드래그 페인트(pjvDrag) ·
//  행 드래그 재정렬(pjvReorder) · 그룹 내 프로젝트 수동 재정렬 · 행 호버 컨트롤(체크·그립·액션 아이콘) · 행 태그 팝오버.
//  ⚠ **document 리스너 1회 등록 불변식**이 이 모듈에 산다 — 플래그와 addEventListener 가 같은 모듈 스코프에
//   있어야만 성립한다(모듈 인스턴스가 둘이 되면 리스너가 두 벌 붙어 드래그 페인트가 두 번 칠해진다):
//    · pjvBulkBarEl — 최초 1회 바를 만들 때 keydown(Esc=선택 해제)을 함께 등록
//    · pjvDrag._init — pjvDragInit() 이 pointerover/pointerup 을 1회만
//    · pjvReorder._init — pjvReorderInit() 이 pointermove/pointerup 을 1회만
//   따라서 플래그(pjvDrag·pjvReorder·pjvBulkBarEl)와 그 init 함수는 절대 갈라놓지 않는다.
import { api, el, infoPop, personFace, state, sv, toast } from '../core.js';
import { sessionTermUrl } from '../lib/session-open.js';   // #1820 — 세션 주소는 한 곳에서만 만든다
import { overlayBox } from '../learn.js';
//  ⚠ 배럴(../projects.js) 경유 — copyText·openLocalWorkModal 의 소유는 projects/detail-sections.ts(R35) 지만
//   그쪽은 detail.ts 를 되짚는 상세 서브트리라, 직결하면 selection→detail-sections→detail→selection 순환이
//   새로 생긴다. 그래서 이 둘만은 배럴을 거친다(scripts/check-imports.mjs 실측 참조).
//   (#1404 로 셋이 이 줄을 떠났다 — pjvFolderDrag→state.js · pjvSaveProjMembers→task-controls.js ·
//    PJV_TAG_NONE→taskmodal/tags.js. 셋 다 되짚지 않는 리프라 직결해도 순환이 늘지 않는다.)
import { copyText, openLocalWorkModal } from '../projects.js';
import { PJV_TAG_NONE } from '../taskmodal/tags.js';
import { avatarColor } from './files.js';
import { pjvIcon } from './icons.js';
import { pjvPopover } from './popover.js';
import { pjvFolderDrag, pjvLocalSortOverride, pjvSortCtx } from './state.js';
import { PJV_PRIORITY, PJV_PRIORITY_ORDER, pjvStatusIconStd } from './status.js';
import { pjvAssigneeWrite, pjvSaveProjMembers } from './task-controls.js';
import { termAutoApprovePref } from '../terminal.js';
import { effortKo, flagChoices, providerLabel, runCatalog, type RunHarness } from '../v2/run-picker.js';   // #1758 — 제공자·모델·추론강도(홈 입력창과 같은 말·같은 표)

// ════════════════════════════════════════════════════════════════════════════
// 클릭업식 다중선택 — 행 호버 시 좌측 체크박스 + 제목 우측 아이콘 3개(추가·태그·이름변경),
//  체크박스로 1개 이상 선택하면 화면 하단 일괄작업 바(상태·담당자·마감·우선순위·태그·복제·삭제).
//  선택은 종류(project|task)별로 분리(혼합 금지). 한 화면 안에서만 유효 — 재렌더/이동 시 비운다.
// ════════════════════════════════════════════════════════════════════════════
const pjvSel: any = { kind: null, ids: new Set(), items: new Map(), ctx: null };
let pjvSelLastEl: any = null;   // 마지막으로 클릭한 체크박스 — Shift+클릭 범위선택의 앵커(#366)
let pjvSelSilent = false;       // 드래그/범위 페인트 중엔 하단 바 재렌더를 억제하고 끝에서 1회만(#366)

function pjvSelDomClear() {
  document.querySelectorAll('.pjv-row-check.on').forEach((c) => c.classList.remove('on'));
  document.querySelectorAll('.pjv-trow-wrap.pjv-row-selected').forEach((w) => w.classList.remove('pjv-row-selected'));
}
function pjvSelReset() {
  pjvSelDomClear();
  pjvSel.kind = null; pjvSel.ids.clear(); pjvSel.items.clear(); pjvSel.ctx = null;
  pjvSelLastEl = null;
  pjvSelRenderBar();
}
function pjvSelToggle(kind, item, ctx) {
  if (pjvSel.kind && pjvSel.kind !== kind) { pjvSelDomClear(); pjvSel.ids.clear(); pjvSel.items.clear(); } // 종류 전환 — 기존 비움
  pjvSel.kind = kind; pjvSel.ctx = ctx;
  if (pjvSel.ids.has(item.id)) { pjvSel.ids.delete(item.id); pjvSel.items.delete(item.id); }
  else { pjvSel.ids.add(item.id); pjvSel.items.set(item.id, item); }
  if (!pjvSel.ids.size) pjvSel.kind = null;
  if (!pjvSelSilent) pjvSelRenderBar();
}
function pjvSelReloadAfter() { const r = pjvSel.ctx && pjvSel.ctx.reload; pjvSelReset(); if (r) r(); }
const pjvSelIds = () => [...pjvSel.ids];
const pjvSelPatchUrl = (id) => (pjvSel.kind === 'task' ? '/api/ui/v6/tasks/' + id : '/api/ui/v6/projects/' + id);
async function pjvBulkApply(perId, okMsg) {
  const ids = pjvSelIds();
  const res = await Promise.allSettled(ids.map(perId));
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  const fail = res.length - ok;
  toast(fail ? (ok + '개 적용 · ' + fail + '개 실패') : (okMsg || (ok + '개 적용됨')), fail > 0);
  pjvSelReloadAfter();
}

// 하단 일괄작업 바 — 선택 1개 이상일 때만. document.body 에 고정.
let pjvBulkBarEl: any = null;
function pjvSelRenderBar() {
  if (!pjvBulkBarEl) {
    pjvBulkBarEl = el('div', { class: 'pjv-bulkbar' });
    document.body.append(pjvBulkBarEl);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pjvSel.ids.size) pjvSelReset(); });
  }
  const n = pjvSel.ids.size;
  if (!n) { pjvBulkBarEl.classList.remove('show'); pjvBulkBarEl.replaceChildren(); return; }
  pjvBulkBarEl.classList.add('show');
  const isTask = pjvSel.kind === 'task';
  const mk = (label, icon, fn, danger?) => {
    const b = el('button', { class: 'pjv-bulk-btn' + (danger ? ' danger' : ''), type: 'button' }, pjvBulkIcon(icon), el('span', { text: label }));
    b.onclick = (e) => { e.stopPropagation(); fn(b); };
    return b;
  };
  // native replaceChildren 는 null 을 'null' 텍스트로 넣으므로 falsy 를 걸러서 넘긴다(태스크 전용 버튼들).
  pjvBulkBarEl.replaceChildren(...[
    el('div', { class: 'pjv-bulk-count' },
      el('span', { class: 'pjv-bulk-n', text: String(n) }),
      el('span', { class: 'pjv-bulk-lbl', text: (isTask ? '태스크' : '프로젝트') + ' 선택됨' }),
      el('button', { class: 'pjv-bulk-x', type: 'button', title: '선택 해제 (Esc)', text: '✕', onclick: () => pjvSelReset() })),
    el('div', { class: 'pjv-bulk-actions' },
      mk('상태', 'status', pjvBulkStatus),
      mk('담당자', 'assignee', pjvBulkAssignee),
      mk('마감일', 'due', pjvBulkDue),
      mk('우선순위', 'priority', pjvBulkPriority),
      isTask ? mk('태그', 'tag', pjvBulkTags) : null,
      !isTask ? mk('리스트', 'list', pjvBulkList) : null,
      mk('복제', 'dup', () => pjvBulkDuplicate()),
      mk('삭제', 'trash', () => pjvBulkDelete(), true)),
    isTask ? el('button', { class: 'pjv-bulk-run', type: 'button', title: '선택한 태스크로 내 새 클로드 세션을 만들고 바로 실행을 맡깁니다',
      onclick: (e) => { e.stopPropagation(); pjvBulkRunClaude(e.currentTarget); } },
      pjvBulkIcon('run'), el('span', { text: '클로드로 실행' })) : null,
    // '클로드로 실행' 오른쪽의 보조 버튼 — 원클릭 실행이 쓰는 기본값(레포·워크트리·실행기·모델·실행 위치)을 보고 수정. 실행 버튼보다 덜 강조.
    isTask ? el('button', { class: 'pjv-bulk-cfg', type: 'button', title: '클로드로 실행 기본값 — 레포·워크트리·실행기·모델·실행 위치를 설정',
      onclick: (e) => { e.stopPropagation(); pjvBulkRunDefaultsModal(pjvSel.ctx); } },
      pjvBulkIcon('settings'), el('span', { text: '기본값' })) : null,
  ].filter(Boolean));
}
function pjvBulkIcon(kind) {
  if (kind === 'assignee') return pjvIcon('assignee');
  if (kind === 'due') return pjvIcon('due');
  if (kind === 'priority') return pjvIcon('priority');
  const svg = (...k) => sv('svg', { class: 'pjv-bulk-ic', viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...k);
  if (kind === 'status') return svg(sv('circle', { cx: '12', cy: '12', r: '8.2' }), sv('path', { d: 'M8.5 12.2l2.4 2.4 4.6-5' }));
  if (kind === 'tag') return svg(sv('path', { d: 'M4 4h7l9 9-7 7-9-9z' }), sv('circle', { cx: '8.2', cy: '8.2', r: '1.3' }));
  if (kind === 'dup') return svg(sv('rect', { x: '8', y: '8', width: '12', height: '12', rx: '2' }), sv('path', { d: 'M4 16V5a1 1 0 0 1 1-1h11' }));
  if (kind === 'trash') return svg(sv('path', { d: 'M5 7h14M10 7V5.5h4V7M6.5 7l1 12.5h9l1-12.5' }));
  if (kind === 'list') return svg(sv('path', { d: 'M8 6h12M8 12h12M8 18h12' }), sv('circle', { cx: '4', cy: '6', r: '1.2' }), sv('circle', { cx: '4', cy: '12', r: '1.2' }), sv('circle', { cx: '4', cy: '18', r: '1.2' }));
  if (kind === 'run') return svg(sv('path', { d: 'M8 5.4v13.2l11-6.6z', fill: 'currentColor', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }));
  if (kind === 'settings') return svg(sv('path', { d: 'M4 8h9M17 8h3M4 16h3M11 16h9' }), sv('circle', { cx: '15', cy: '8', r: '2.2' }), sv('circle', { cx: '9', cy: '16', r: '2.2' }));
  return svg();
}

// 선택한 태스크 → 내 새 클로드 세션을 만들고(내 이름·태스크 기반 라벨) 새 탭으로 열어, 그 태스크들을 클로드에게 실행 요청까지 원클릭.
//  세션은 autoApprove(=claude --dangerously-skip-permissions)로 만들어 멈춤 없이 실행. 프롬프트 주입은 terminal.js 가 부팅 후 1회(localStorage 핸드오프).
async function pjvBulkRunClaude(btn?) {
  if (pjvSel.kind !== 'task' || !pjvSel.ids.size) return;
  const ctx = pjvSel.ctx || {};
  const pid = ctx.projectId;
  if (!pid) { toast('프로젝트를 찾을 수 없어요', true); return; }
  const ids = [...pjvSel.ids];
  const B = '/api/ui/v6/projects/' + pid;
  const meId = (state.me && (state.me.userId || state.me.email)) || '';
  const meName = (((ctx.members || []).find((m) => m.member_id === meId) || {}).display_name) || meId || '나';
  const labelSpan = btn ? btn.querySelector('span') : null;
  const origLabel = labelSpan ? labelSpan.textContent : '';
  if (btn) btn.disabled = true;
  if (labelSpan) labelSpan.textContent = '내용 준비 중…';

  // 팝업 전체 내용을 모은다: 상세(본문·체크리스트·댓글/주석) + 첨부 파일 경로(이미지는 클로드가 직접 열어 확인) + 하위태스크(재귀로 동일하게).
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i;
  const detailOf = (tid) => api('/api/ui/v6/tasks/' + tid + '/detail').catch(() => null);
  const attsOf = (tid) => api(B + '/files?path=' + encodeURIComponent('_attachments/task-' + tid))
    .then((r) => ((r && r.items) || []).filter((it) => it.type === 'file').map((it) => it.name)).catch(() => []);
  const blockOf = async (t, depth) => {
    const ind = '  '.repeat(depth);
    const out = [ind + (depth ? '◦ ' : '■ ') + (t.name || ('태스크 ' + t.id))
      + (t.status ? ' [' + t.status + ']' : '') + (t.priority ? ' (우선순위:' + t.priority + ')' : '') + (t.due_date ? ' (마감:' + t.due_date + ')' : '')];
    const desc = (t.description || '').trim();
    out.push(ind + '  본문: ' + (desc ? desc.replace(/\n/g, '\n' + ind + '  ') : '(없음)'));
    const atts = await attsOf(t.id);
    if (atts.length) {
      const hasImg = atts.some((n) => IMG_RE.test(n));
      out.push(ind + '  첨부: ' + atts.map((n) => '_attachments/task-' + t.id + '/' + n).join(', ') + (hasImg ? '  ← 이미지는 직접 열어 확인할 것' : ''));
    }
    return out.join('\n');
  };
  const extrasOf = (d, ind) => {
    const out: string[] = [];
    for (const cl of ((d && d.checklists) || [])) {
      const its = (cl.items || []);
      if (its.length) out.push(ind + '체크리스트' + (cl.name ? '(' + cl.name + ')' : '') + ': ' + its.map((i) => (i.done ? '[x]' : '[ ]') + (i.text || i.name || '')).join(' / '));
    }
    const cm = ((d && d.feed) || []).filter((f) => f.kind === 'comment' && f.body).map((f) => String(f.body).trim().replace(/\n/g, ' '));
    if (cm.length) out.push(ind + '댓글/주석: ' + cm.map((c) => '“' + c + '”').join('  '));
    return out;
  };

  let prompt = '', projName = '';
  try {
    const blocks: string[] = [];
    for (const id of ids) {
      const d = await detailOf(id);
      if (d && d.project && !projName) projName = d.project.name || '';
      const t = (d && d.task) || pjvSel.items.get(id) || { id, name: '태스크 ' + id };
      const parts = [await blockOf(t, 0), ...extrasOf(d, '  ')];
      const subs = (t.subtasks || []);
      if (subs.length) {
        parts.push('  하위태스크 (' + subs.length + '):');
        for (const s0 of subs) {
          const sd = await detailOf(s0.id);
          const s = (sd && sd.task) || s0;
          parts.push(await blockOf(s, 1), ...extrasOf(sd, '    '));
        }
      }
      blocks.push(parts.join('\n'));
    }
    prompt = (projName ? ('프로젝트: ' + projName + '. ') : '')
      + '아래 태스크들을 진행해줘. 각 태스크의 본문·체크리스트·댓글(주석)·첨부·하위태스크를 모두 반영하고, 첨부 이미지는 경로를 직접 열어 확인해. 각 태스크를 끝내면 무엇을 했는지 보고하고, 막히면 질문해줘.\n\n' + blocks.join('\n\n');
  } catch (e) {
    if (btn) btn.disabled = false; if (labelSpan) labelSpan.textContent = origLabel || '클로드로 실행';
    toast('태스크 내용을 불러오지 못했어요 — ' + e.message, true); return;
  }

  // 이 프로젝트의 '클로드로 실행' 기본값(실행 위치·실행기·모델·자동승인·워크트리·레포). 설정 팝업(pjvBulkRunDefaultsModal)에서 바꾼다.
  const proj0 = await api(B).then((dd) => dd && (dd.project || dd)).catch(() => null);
  const projRepos = ((proj0 && proj0.repos) || []).filter(Boolean);
  const rd = pjvRunDefaults(pid, projRepos);
  // 실행 위치 = 내 PC(로컬): 박스 세션을 만들지 않고, 태스크 내용을 클립보드에 복사한 뒤 '내 PC에서 작업' 안내 모달을 기본값으로 선주입해 연다.
  //  로컬은 work.mjs 한 줄이 코드 준비(clone/worktree)까지 겸하는 셋업이라 레포·워크트리 기본값을 그대로 넘긴다 — 아래 박스 세션과 다르다(#918).
  if (rd.where === 'local') {
    const chosenRepos = (rd.repos === null) ? projRepos : projRepos.filter((n) => rd.repos.includes(n));
    try { copyText(prompt); } catch (_) { /* */ }
    if (btn) btn.disabled = false; if (labelSpan) labelSpan.textContent = origLabel || '클로드로 실행';
    openLocalWorkModal(pid, { id: pid, name: projName || (proj0 && proj0.name) || '', repos: chosenRepos },
      { harness: rd.harness, model: rd.model, autoApprove: rd.autoApprove, worktree: rd.worktree, branch: rd.branch, repos: chosenRepos });
    toast('태스크 내용을 클립보드에 복사했어요 — 안내대로 내 PC에서 세션을 열고 붙여넣어 실행하세요');
    pjvSelReset();
    return;
  }

  const first = pjvSel.items.get(ids[0]);
  const firstName = (first && (first.name || first.title)) || ('태스크 ' + ids[0]);
  const label = meName + ' · ' + firstName + (ids.length > 1 ? (' 외 ' + (ids.length - 1) + '건') : '');
  // 세션은 프로젝트 폴더에서 연다 — 코드를 미리 provision 하지 않는다(#918).
  //  이전엔 세션 전에 레포를 워크트리로 provision 하고 '단일 레포일 때만' cwd 를 거기로 뒀다. 그건 보장이 아니었다:
  //  멀티레포·provision 실패·다른 진입 경로면 어차피 맨 프로젝트 폴더에서 떴고(실측: 코드 프로젝트의 40%), 실패는
  //  .catch 로 삼켜 무음이었고, 회수된 워크트리 경로가 마커에 남아 오히려 에이전트를 속였다.
  //  지금은 세션이 코드가 필요해진 시점에 스스로 뜬다 — 발견은 AGENTS.md '코드 작업' 섹션(프로젝트 폴더에 항상)과
  //  lively_local_repo_worktree 의 _meta.alwaysLoad(스키마 상시 노출)가 보장한다. 미리 받아두고 싶으면 세션 생성
  //  모달의 '레포 준비'(POST /provision)를 쓴다 — 지금은 비동기 시작(#1180)이라 거기서도 안 기다리고,
  //  결과(성공·실패)는 폴링 토스트 + 세션 컨텍스트 주입(#1155 마커)으로 표면화된다.
  if (labelSpan) labelSpan.textContent = '세션 여는 중…';
  try {
    const sbody: any = { label, harness: rd.harness || 'claude', autoApprove: rd.autoApprove === true };   // #782 기본 꺼짐 — 켠 사람만 켜짐
    // 모델·추론강도는 **고른 것만** 넘긴다 — 빈 값은 '지난번 그대로'(그 AI 가 자기 설정으로 뜬다)라서 안 넘기는 게 곧 그 뜻이다(#1758).
    const rdFlags: Record<string, string> = {};
    if (rd.model) rdFlags['--model'] = rd.model;
    if (rd.effort) rdFlags['--effort'] = rd.effort;
    if (Object.keys(rdFlags).length) sbody.flags = rdFlags;
    const r = await api(B + '/sessions', { method: 'POST', body: JSON.stringify(sbody) });
    const sid = r && r.session && r.session.id;
    if (!sid) throw new Error('세션 생성 실패');
    try { localStorage.setItem('lively:autosend:' + sid, prompt); } catch (_) { /* */ }
    window.open(sessionTermUrl(sid, { label: (r.session && r.session.label) || label, autosend: true }), '_blank');
    toast(ids.length + '개 태스크(본문·하위·첨부 포함)를 클로드에게 맡겼어요 — 새 탭에서 실행됩니다');
    pjvSelReset();
  } catch (e) {
    if (btn) btn.disabled = false; if (labelSpan) labelSpan.textContent = origLabel || '클로드로 실행';
    toast('실패 — ' + e.message, true);
  }
}
// ── '클로드로 실행' 기본값(실행 위치·실행기·모델·자동승인·워크트리·레포) — 프로젝트별 localStorage. 플로팅바 원클릭(pjvBulkRunClaude)이 읽는다. ──
//  #782 키를 사용자별로도 나눈다(v2) — 한 브라우저를 여러 계정이 써도 남의 자동 승인이 내 기본값이 되지 않게.
//  자동 승인의 기본은 '꺼짐'(termAutoApprovePref = 내가 세션 폼에서 마지막에 고른 값)이고, 옛 키(v1)의 autoApprove 는
//  기본값이 켜져 있던 시절(#480)에 저장된 잔재라 이어받지 않는다 — 나머지(실행 위치·실행기·모델·워크트리·레포)만 이어받는다.
const pjvRunDefaultsKey = (pid) => 'lively:runclaude:defaults:v2:' + ((state.me && (state.me.userId || state.me.email)) || 'anon') + ':' + pid;
const pjvRunDefaultsLegacyKey = (pid) => 'lively:runclaude:defaults:' + pid;
function pjvRunDefaults(pid, projectRepos) {
  const base: any = { where: 'web', harness: 'claude', model: '', effort: '', autoApprove: termAutoApprovePref(), worktree: true, branch: 'project/' + pid, repos: null };
  let saved: any = {};
  try {
    const raw = localStorage.getItem(pjvRunDefaultsKey(pid));
    if (raw != null) saved = JSON.parse(raw) || {};
    else { saved = JSON.parse(localStorage.getItem(pjvRunDefaultsLegacyKey(pid)) || '{}') || {}; delete saved.autoApprove; }
  } catch (_) { saved = {}; }
  const d = { ...base, ...saved };
  d.branch = 'project/' + pid;   // 워크트리 브랜치는 프로젝트 id 로 자동 고정 — 팝업에서 편집하지 않는다(#514 후속 피드백: 자동 파생값을 '기본값'으로 노출하면 오해)
  // repos: null=관련 레포 전부(미래에 추가되는 레포도 자동 포함). 배열이면 현재 프로젝트 레포와 교집합(빠진 레포 정리).
  if (Array.isArray(d.repos)) d.repos = d.repos.filter((n) => (projectRepos || []).includes(n));
  return d;
}
function pjvSaveRunDefaults(pid, d) {
  try { localStorage.setItem(pjvRunDefaultsKey(pid), JSON.stringify(d)); } catch (_) { /* localStorage 불가 시 무시 */ }
}

// 기본값 설정 팝업 — '지금 어떻게 설정돼 있는지'를 보여주고 수정. 저장은 프로젝트별 localStorage(다음 '클로드로 실행'부터 적용).
async function pjvBulkRunDefaultsModal(ctx) {
  ctx = ctx || pjvSel.ctx || {};
  const pid = ctx.projectId;
  if (!pid) { toast('프로젝트를 찾을 수 없어요', true); return; }
  // 프로젝트 관련 레포 + 하네스 카탈로그(제공자·모델·추론강도·자동승인). 실패해도 아래 기본 카탈로그로 진행.
  let projectRepos: string[] = [];
  try { const pr = await api('/api/ui/v6/projects/' + pid).then((dd) => dd && (dd.project || dd)); projectRepos = ((pr && pr.repos) || []).filter(Boolean); } catch (_) { /* 레포 조회 실패 — 레포 선택 없이 */ }
  const harnessCat: any = {
    claude: { label: 'Claude Code', prov: 'Anthropic', models: ['', 'opus', 'sonnet', 'haiku'], efforts: [], hasAuto: true },
    codex: { label: 'Codex', prov: 'OpenAI', models: ['', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'], efforts: [], hasAuto: true },
  };
  // #1758 — 목록·이름은 서버 카탈로그가 준다(v2/run-picker 가 캐시). 홈 입력창과 **같은 표**를 읽어야 두 화면의 말이 갈리지 않는다.
  const cat: RunHarness[] = await runCatalog();
  cat.forEach((h) => {
    harnessCat[h.key] = {
      label: h.label || h.key, prov: providerLabel(h),
      models: ['', ...flagChoices(h, '--model')], efforts: flagChoices(h, '--effort'), hasAuto: !!h.hasAutoApprove,
    };
  });

  const d = pjvRunDefaults(pid, projectRepos);

  // ── 아래 UI 는 '새 AI 세션' 모달과 같은 언어를 쓴다(#1145) — 같은 일을 정하는 화면이 서로 다르게 생기면
  //  사용자는 매번 새로 배워야 한다. 웹/내 PC 는 제목 줄 pill, 나머지는 문장 격자(.ig-grid).

  // 실행 위치(웹 중앙 컴퓨터 / 내 PC 로컬) — 제목 줄 pill 로. 아래 '코드 저장소 준비'가 이 값에 종속된다.
  let whereVal: 'web' | 'local' = d.where === 'local' ? 'local' : 'web';
  const whereBtns: Record<string, any> = {};
  const whereSeg = el('div', { class: 'where-pill' }, ...[
    { k: 'web', t: '☁️ 웹' }, { k: 'local', t: '💻 내 PC' },
  ].map((w) => {
    const b = el('button', { class: 'where-pill-btn' + (w.k === whereVal ? ' on' : ''), type: 'button', text: w.t });
    b.onclick = (e: any) => {
      e.preventDefault();
      if (whereVal === w.k) return;
      whereVal = w.k as any;
      for (const k in whereBtns) whereBtns[k].classList.toggle('on', k === whereVal);
      syncRepoField();
    };
    whereBtns[w.k] = b; return b;
  }));

  // 실행기 + 모델 — 세션 모달과 같은 문장 격자. 빈 모델은 '지난번 그대로'(그 뜻 그대로다 — 세션 모달 주석 참조).
  //  #1695 — 목록은 **서버 카탈로그가 준 것 전부**(셸만 제외)다. 종전엔 ['claude','codex'] 를 여기 하드코딩해,
  //   배선이 다 끝난 하네스(opencode #1519 · antigravity #1689)가 이 화면에서만 존재하지 않았다.
  //   폴백 카탈로그(위)가 claude·codex 를 담고 있으므로 서버를 못 읽어도 종전 선택지는 그대로 뜬다.
  //  #1758 — 첫 칸은 하네스 이름이 아니라 **제공자**로 묻는다(홈 입력창과 같은 말): '앤트로피 · Claude Code'.
  //   고르는 건 결국 하네스지만, 사람이 먼저 떠올리는 이름을 앞에 두고 무엇이 뜨는지를 뒤에 붙여 둘 다 보이게 한다.
  const HKEYS = Object.keys(harnessCat).filter((k) => k !== 'shell');
  const harnessSel = el('select', { class: 'term-input ig-sel' },
    ...HKEYS.map((k) => el('option', { value: k, text: (harnessCat[k].prov ? harnessCat[k].prov + ' · ' : '') + (harnessCat[k].label || k) })));
  const modelSel = el('select', { class: 'term-input ig-sel' });
  const effortSel = el('select', { class: 'term-input ig-sel' });
  const autoCb = el('input', { type: 'checkbox' });
  const autoRow = el('label', { class: 'term-auto' }, autoCb, el('span', { text: ' 자동 승인 — 권한 확인 없이 바로 실행해 빨라요. 신뢰하는 작업에만 켜세요.' }));
  const renderModels = () => {
    const hc = harnessCat[harnessSel.value] || { models: [''], efforts: [] };
    const curM = modelSel.value;
    modelSel.replaceChildren(...(hc.models || ['']).map((m) => el('option', { value: m, text: m || '지난번 그대로' })));
    if ((hc.models || []).includes(curM)) modelSel.value = curM;
    // 추론강도를 안 받는 하네스(codex·opencode)면 그 칸을 아예 안 보인다 — 효과 없는 컨트롤을 남기지 않는다.
    const efs: string[] = hc.efforts || [];
    const curE = effortSel.value;
    effortSel.replaceChildren(el('option', { value: '', text: '지난번 그대로' }), ...efs.map((e) => el('option', { value: e, text: effortKo(e) })));
    if (efs.includes(curE)) effortSel.value = curE;
    effortWrap.style.display = efs.length ? '' : 'none';
    autoRow.style.display = (hc.hasAuto === false) ? 'none' : '';
  };
  // 문장 격자의 셀로 직접 참여한다(display:contents) — 하네스가 추론강도를 안 받으면 이 묶음만 통째로 사라진다.
  const effortWrap = el('span', { style: 'display:contents' },
    el('span', { class: 'ig-mid', text: ', 추론강도는' }), effortSel);
  if (HKEYS.includes(d.harness)) harnessSel.value = d.harness;
  harnessSel.addEventListener('change', renderModels);
  renderModels();
  if (((harnessCat[harnessSel.value] || { models: [] }).models || []).includes(d.model)) modelSel.value = d.model;
  if (((harnessCat[harnessSel.value] || { efforts: [] }).efforts || []).includes(d.effort)) effortSel.value = d.effort;
  autoCb.checked = d.autoApprove === true;   // #782 기본 해제(저장된 값이 있을 때만 켬)

  const runGrid = el('div', { class: 'ig-grid' },
    el('span', { class: 'ig-lead', text: '실행은' }),
    harnessSel,
    el('span', { class: 'ig-mid', text: '로 하고, 모델은' }),
    modelSel,
    effortWrap,
    el('span', { class: 'ig-tail' }, document.createTextNode('를 씁니다.'),
      infoPop('선택한 태스크를 맡길 **제공자(어느 회사 모델)와 모델·추론강도**입니다.\n\n제공자를 고르면 그에 맞는 AI 가 뜹니다 — 앤트로픽은 Claude Code, 오픈AI 는 Codex, 제미나이는 Antigravity, xAI 는 Grok Build, 그 밖은 OpenCode 입니다.\n\n「지난번 그대로」는 그 값을 **넘기지 않는다**는 뜻입니다 — 그 AI 가 자기 설정(마지막에 고른 값)으로 뜹니다.')));

  // 워크트리 — 이 프로젝트 전용 작업 공간을 자동 준비(있으면 재사용). 브랜치명(project/<id>)은 자동 파생이라 안 묻는다(#514 후속).
  const wtChk = el('input', { type: 'checkbox' }); wtChk.checked = d.worktree !== false;
  const wtRow = el('label', { class: 'term-auto' }, wtChk,
    el('span', { text: ' 이 프로젝트 전용 작업 공간에서 격리 실행 — 자동으로 준비되고(있으면 재사용) 다른 작업과 안 섞여요.' }));

  // 레포 선택 — 실행 전에 자동으로 가져올(provision) 레포. 기본은 관련 레포 전부.
  const repoChecks = projectRepos.map((n) => {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = (d.repos === null) ? true : d.repos.includes(n);
    return { n, cb, row: el('label', { class: 'term-auto' }, cb, el('span', { text: ' ' + n })) };
  });
  const repoBox = projectRepos.length
    ? el('div', { class: 'term-checks' }, ...repoChecks.map((r) => r.row))
    : el('div', { class: 'caption', text: '이 프로젝트에 연결된 레포가 없어요 — 레포 없이 실행됩니다.' });

  // 코드 저장소 준비는 '내 PC' 실행 전용이다(#918) — work.mjs 한 줄(--worktree/--branch/레포)에만 실린다.
  //  웹(박스) 세션은 코드를 미리 받지 않고, 세션이 코드가 필요해진 시점에 lively_local_repo_worktree 로 스스로 뜬다.
  //  그래서 웹을 고른 상태에선 숨긴다 — 남겨두면 '준비해준다'는 거짓 약속이 된다(웹에선 아무 효과도 없다).
  //  세션 모달에서 레포·워크트리를 걷어낸 것과 같은 이유로 **기본 화면에서는 접어 둔다**(#1145).
  const repoBody = el('div', { class: 'term-adv-body', hidden: '' },
    el('div', { class: 'caption', text: '내 PC에서 실행할 때 아래 레포를 준비합니다(있으면 재사용). 코드 작업이 아니면 그대로 두세요 — 세션이 필요해지면 스스로 가져옵니다.' }),
    el('div', { class: 'term-checks' }, wtRow),
    repoBox);
  const repoCaret = el('span', { class: 'term-fold-caret', text: '▸' });
  const repoToggle = el('button', { class: 'term-fold', type: 'button' }, repoCaret, el('b', { text: '코드 저장소 준비' }),
    el('span', { class: 'term-fold-sum', text: ' · 내 PC 실행에만 적용' }));
  repoToggle.onclick = (e: any) => {
    e.preventDefault();
    const o = repoBody.hasAttribute('hidden');
    if (o) repoBody.removeAttribute('hidden'); else repoBody.setAttribute('hidden', '');
    repoCaret.textContent = o ? '▾' : '▸';
  };
  const repoField = el('div', {}, repoToggle, repoBody);
  const syncRepoField = () => { repoField.style.display = whereVal === 'local' ? '' : 'none'; };
  syncRepoField();

  const saveBtn = el('button', { class: 'btn btn-primary', text: '기본값 저장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('클로드로 실행 — 기본값',
    el('p', { class: 'admin-hint', text: '‘클로드로 실행’(플로팅 바)을 누를 때 쓰는 기본값이에요. 여기서 바꾸면 다음 실행부터 이 값으로 준비됩니다. (이 프로젝트에만 적용)' }),
    runGrid,
    el('div', { class: 'term-checks' }, autoRow),
    repoField,
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  back.classList.add('ov-back--center');   // 세션 모달과 같은 세로 정렬(#1145)
  const head = back.querySelector('.ov-head');
  if (head) head.insertBefore(whereSeg, head.querySelector('.btn') || null);   // 제목 줄 pill

  saveBtn.onclick = () => {
    const chosen = repoChecks.filter((r) => r.cb.checked).map((r) => r.n);
    const allChosen = projectRepos.length > 0 && chosen.length === projectRepos.length;
    pjvSaveRunDefaults(pid, {
      where: whereVal,
      harness: harnessSel.value,
      model: modelSel.value || '',
      effort: effortSel.value || '',
      autoApprove: autoCb.checked,
      worktree: wtChk.checked,
      repos: (projectRepos.length && !allChosen) ? chosen : null,   // null=전부(미래 레포 자동 포함). 브랜치는 저장 안 함 — pjvRunDefaults 가 project/<id> 로 자동 고정.
    });
    back.remove();
    toast('클로드로 실행 기본값을 저장했어요');
  };
}
// ── 일괄 액션들 ──
function pjvBulkStatus(anchor) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  for (const [key, label] of [['todo', '할 일'], ['in_progress', '진행 중'], ['done', '완료']]) {
    const item = el('button', { class: 'pjv-menu-item', type: 'button' },
      pjvStatusIconStd(key, 'sm'),
      el('span', { text: label }));
    item.onclick = () => {
      close();
      if (pjvSel.kind === 'task') pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id, { method: 'POST', body: JSON.stringify({ status: key }) }), '상태 변경됨');
      else pjvBulkApply((id) => api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: key }) }), '상태 변경됨');
    };
    menu.append(item);
  }
}
function pjvBulkDue(anchor) {
  const input = el('input', { type: 'date', class: 'pjv-date-input' });
  const clearBtn = el('button', { class: 'pjv-menu-item danger', type: 'button', text: '마감일 지우기' });
  const wrap = el('div', { class: 'pjv-menu pjv-date-pop' }, input, clearBtn);
  const close = pjvPopover(anchor, wrap);
  setTimeout(() => { input.focus(); if (input.showPicker) { try { input.showPicker(); } catch (_) { /* noop */ } } }, 0);
  input.onchange = () => { const v = input.value || null; close(); pjvBulkApply((id) => api(pjvSelPatchUrl(id), { method: 'POST', body: JSON.stringify({ due_date: v }) }), '마감일 적용됨'); };
  clearBtn.onclick = () => { close(); pjvBulkApply((id) => api(pjvSelPatchUrl(id), { method: 'POST', body: JSON.stringify({ due_date: null }) }), '마감일 지움'); };
}
function pjvBulkPriority(anchor) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  for (const key of PJV_PRIORITY_ORDER) {
    const pm = PJV_PRIORITY[key];
    const item = el('button', { class: 'pjv-menu-item', type: 'button' },
      el('span', { class: 'pjv-flag ' + pm.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' })), el('span', { text: pm.label }));
    item.onclick = () => { close(); pjvBulkApply((id) => api(pjvSelPatchUrl(id), { method: 'POST', body: JSON.stringify({ priority: key }) }), '우선순위 적용됨'); };
    menu.append(item);
  }
  const none = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
  none.onclick = () => { close(); pjvBulkApply((id) => api(pjvSelPatchUrl(id), { method: 'POST', body: JSON.stringify({ priority: null }) }), '우선순위 지움'); };
  menu.append(none);
}
async function pjvBulkAssignee(anchor) {
  const menu = el('div', { class: 'pjv-menu pjv-asg-menu' });
  const close = pjvPopover(anchor, menu);
  menu.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  let members: any[] = [];
  try {
    if (pjvSel.kind === 'task' && pjvSel.ctx && (pjvSel.ctx.members || []).length) {
      members = pjvSel.ctx.members.map((m) => ({ id: m.member_id, name: m.display_name || m.member_id }));
    } else {
      members = ((await api('/api/ui/dash/members')) || []).map((m) => ({ id: m.id || m.member_id, name: m.display_name || m.name || m.id || m.member_id }));
    }
  } catch (_) { /* graceful */ }
  const picked = new Set();
  const render = () => {
    menu.replaceChildren(el('div', { class: 'pjv-menu-head', text: pjvSel.kind === 'task' ? '담당자 지정' : '팀원 지정' }));
    for (const m of members) {
      const on = picked.has(m.id);
      const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
        personFace(m.id, 'pjv-ava', m.name),
        el('span', { class: 'pjv-asg-mname', text: m.name }), el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
      item.onclick = (e) => { e.stopPropagation(); if (on) picked.delete(m.id); else picked.add(m.id); render(); };
      menu.append(item);
    }
    if (!members.length) menu.append(el('div', { class: 'pjv-menu-empty', text: '팀원이 없습니다' }));
    const apply = el('button', { class: 'pjv-menu-item pjv-bulk-apply', type: 'button' }, el('span', { text: '선택 ' + (pjvSel.kind === 'task' ? '담당자' : '팀원') + '로 지정 (' + picked.size + ')' }));
    apply.onclick = () => {
      close(); const ids = [...picked];
      if (pjvSel.kind === 'task') pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id, { method: 'POST', body: JSON.stringify({ assignee: pjvAssigneeWrite(ids) }) }), '담당자 적용됨');
      else pjvBulkApply((id) => pjvSaveProjMembers(id, ids), '팀원 적용됨');
    };
    const clear = el('button', { class: 'pjv-menu-item danger', type: 'button' }, el('span', { text: (pjvSel.kind === 'task' ? '담당자' : '팀원') + ' 비우기' }));
    clear.onclick = () => {
      close();
      if (pjvSel.kind === 'task') pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id, { method: 'POST', body: JSON.stringify({ assignee: null }) }), '담당자 비움');
      else pjvBulkApply((id) => pjvSaveProjMembers(id, []), '팀원 비움');
    };
    menu.append(el('div', { class: 'pjv-bulk-sep-h' }), apply, clear);
  };
  render();
}
async function pjvBulkTags(anchor) {
  if (pjvSel.kind !== 'task') return;
  const menu = el('div', { class: 'pjv-menu pjv-rowtag-pop' });
  const close = pjvPopover(anchor, menu);
  menu.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  let all: any[] = [];
  try { all = ((await api('/api/ui/v6/tags')) || {}).tags || []; } catch (_) { /* graceful */ }
  menu.replaceChildren(el('div', { class: 'pjv-menu-head', text: '선택 태스크에 태그 추가' }));
  for (const tg of all) {
    const item = el('button', { class: 'pjv-menu-item', type: 'button' },
      el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (tg.color || PJV_TAG_NONE) }), el('span', { text: tg.name }));
    item.onclick = () => { close(); pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tg.id }) }), '태그 추가됨'); };
    menu.append(item);
  }
  if (!all.length) menu.append(el('div', { class: 'pjv-menu-empty', text: '태그가 없습니다 — 행에서 ＋ 로 먼저 만드세요' }));
}
function pjvBulkDuplicate() {
  if (pjvSel.kind === 'task') {
    const pid = pjvSel.ctx && pjvSel.ctx.projectId;
    if (!pid) { toast('복제 대상 프로젝트를 알 수 없습니다', true); return; }
    pjvBulkApply(async (id) => {
      const t = pjvSel.items.get(id); const name = (t.name || t.title || '태스크') + ' (사본)';
      const created = await api('/api/ui/v6/projects/' + pid + '/tasks', { method: 'POST', body: JSON.stringify({ name }) }).then((d) => d && d.task);
      if (created) {
        if (t.status && t.status !== 'todo') await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify({ status: t.status }) }).catch(() => {});
        const patch: any = {}; if (t.assignee) patch.assignee = t.assignee; if (t.due_date) patch.due_date = t.due_date; if (t.priority) patch.priority = t.priority;
        if (Object.keys(patch).length) await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => {});
      }
    }, '복제됨');
  } else {
    pjvBulkApply(async (id) => {
      const p = pjvSel.items.get(id); await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({ name: (p.name || '프로젝트') + ' (사본)' }) });
    }, '복제됨');
  }
}
function pjvBulkDelete() {
  const n = pjvSel.ids.size; const what = pjvSel.kind === 'task' ? '태스크' : '프로젝트';
  if (!confirm(n + '개 ' + what + '를 삭제할까요?\n\n#/trash 에서 복원할 수 있습니다.')) return;
  if (pjvSel.kind === 'task') pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id + '/delete', { method: 'POST', body: JSON.stringify({}) }), '삭제됨');
  else pjvBulkApply((id) => api('/api/ui/v6/projects/' + id + '/delete', { method: 'POST', body: JSON.stringify({}) }), '삭제됨');
}
// 일괄 '리스트로 이동'(프로젝트 전용) — 선택한 프로젝트들을 한 리스트(또는 미분류)로. 기존 49개 정리·대량 분류용.
async function pjvBulkList(anchor) {
  if (pjvSel.kind === 'task') return; // 태스크는 리스트 개념 없음(프로젝트 전용)
  const menu = el('div', { class: 'pjv-menu pjv-listmove-pop' });
  const close = pjvPopover(anchor, menu);
  const headEl = el('div', { class: 'pjv-menu-head', text: '선택 프로젝트를 리스트로 이동' });
  menu.append(headEl, el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  let lists: any[] = [];
  try { lists = ((await api('/api/ui/v6/project-lists')) || {}).lists || []; } catch (_) { /* graceful */ }
  menu.replaceChildren(headEl);
  const mkItem = (label, listId, color) => {
    const item = el('button', { class: 'pjv-menu-item', type: 'button' },
      el('span', { class: 'pjv-list-dot sm', style: 'background:' + (color || 'var(--line)') }),
      el('span', { class: 'pjv-asg-mname', text: label }));
    item.onclick = () => { close(); pjvBulkApply((id) => api('/api/ui/v6/projects/' + id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listId }) }), '리스트로 이동됨'); };
    return item;
  };
  menu.append(mkItem('기타 (미분류)', null, null));
  for (const l of lists) menu.append(mkItem(l.name, l.id, l.color || avatarColor('list' + l.id)));
  if (!lists.length) menu.append(el('div', { class: 'pjv-menu-empty', text: '폴더가 없습니다 — 상단 ‘폴더’ 버튼을 켜면 왼쪽에서 ‘＋ 새 폴더’로 만들 수 있어요' }));
}

// ── 다중선택 드래그/범위 (#366) — 좌측 체크박스를 눌러 아래로 쭉 끌면 지나온 행이 한 번에 선택된다.
//  · 드래그: 앵커(누른 체크박스)~현재 포인터 아래 행까지를 '칠한다'. 되돌아오면 범위가 줄어(칠하기 전 상태로 복원).
//  · Shift+클릭: 직전 클릭 앵커~현재까지를 선택.
//  체크박스는 같은 kind(프로젝트 XOR 태스크)끼리만 이어진다 — pjvSelToggle 이 kind 혼합을 막기 때문.
const pjvDrag: any = { active: false, kind: null, ctx: null, mode: false, anchorEl: null, moved: false, base: null, lastOver: null, suppressClick: false, _init: false };

// 현재 화면의 같은 kind 체크박스들을 DOM(=시각) 순서로. (자식 서브태스크 체크박스도 문서 순서에 자연히 포함)
function pjvDragChecks(kind) {
  return [...document.querySelectorAll('.pjv-row-check')].filter((c: any) => (c as any)._pjvKind === kind);
}
// 체크박스 하나를 특정 상태로 세팅(멱등) — pjvSel 상태 + .on + 행 하이라이트를 함께 맞춘다.
function pjvSetChecked(cb: any, on) {
  const kind = cb._pjvKind, item = cb._pjvItem, ctx = cb._pjvCtx;
  const cur = pjvSel.kind === kind && pjvSel.ids.has(item.id);
  if (cur !== on) pjvSelToggle(kind, item, ctx);
  cb.classList.toggle('on', on);
  const w = cb.closest('.pjv-trow-wrap'); if (w) w.classList.toggle('pjv-row-selected', on);
}
// 앵커~overCb 범위를 mode 로 칠하고, 범위 밖은 드래그 시작 시점 상태(base)로 복원. 바 재렌더는 1회만.
function pjvDragPaint(overCb) {
  const list = pjvDragChecks(pjvDrag.kind);
  const ai = list.indexOf(pjvDrag.anchorEl);
  const ci = list.indexOf(overCb);
  if (ai < 0 || ci < 0) return;
  const lo = Math.min(ai, ci), hi = Math.max(ai, ci);
  pjvSelSilent = true;
  list.forEach((c, i) => {
    const inRange = i >= lo && i <= hi;
    pjvSetChecked(c, inRange ? pjvDrag.mode : !!(pjvDrag.base && pjvDrag.base.get(c)));
  });
  pjvSelSilent = false;
  pjvSelRenderBar();
}
function pjvDragInit() {
  if (pjvDrag._init) return; pjvDrag._init = true;
  document.addEventListener('pointerover', (e: any) => {
    if (!pjvDrag.active) return;
    if (e.buttons === 0) { pjvDragEnd(null); return; } // 창 밖에서 손을 뗀 경우 등 — 끊김 방지
    const wrap = e.target && e.target.closest && e.target.closest('.pjv-trow-wrap');
    if (!wrap) return;
    const cb = wrap.querySelector('.pjv-row-check'); // wrap 자신의 행 체크박스(문서상 첫 .pjv-row-check)
    if (!cb || (cb as any)._pjvKind !== pjvDrag.kind || cb === pjvDrag.lastOver) return;
    pjvDrag.lastOver = cb;
    if (cb !== pjvDrag.anchorEl) pjvDrag.moved = true;
    pjvDragPaint(cb);
  });
  document.addEventListener('pointerup', (e: any) => { if (pjvDrag.active) pjvDragEnd(e); });
}
function pjvDragEnd(e) {
  // 앵커 위에서 손을 뗐고 실제로 끌었다면, 뒤이어 오는 click 이 앵커를 되돌리지 않게 삼킨다.
  const endOnAnchor = !!(e && e.target && e.target.closest && e.target.closest('.pjv-row-check') === pjvDrag.anchorEl);
  pjvDrag.suppressClick = pjvDrag.moved && endOnAnchor;
  pjvDrag.active = false; pjvDrag.base = null; pjvDrag.lastOver = null;
  document.body.classList.remove('pjv-dragging');
}

// ── 행 호버 컨트롤 — 좌측 체크박스 + 우측 아이콘 그룹(추가·태그·이름변경) ──
function pjvRowCheck(kind, item, ctx) {
  pjvDragInit();
  const cb: any = el('button', { class: 'pjv-row-check', type: 'button', 'aria-label': '선택' });
  cb._pjvKind = kind; cb._pjvItem = item; cb._pjvCtx = ctx;
  if (pjvSel.kind === kind && pjvSel.ids.has(item.id)) cb.classList.add('on');
  cb.addEventListener('pointerdown', (e: any) => {
    if (e.button !== 0) return; // 좌클릭만
    pjvDrag.active = true; pjvDrag.kind = kind; pjvDrag.ctx = ctx;
    pjvDrag.anchorEl = cb; pjvDrag.moved = false; pjvDrag.lastOver = null; pjvDrag.suppressClick = false;
    const anchorOn = pjvSel.kind === kind && pjvSel.ids.has(item.id);
    pjvDrag.mode = !anchorOn; // 앵커가 꺼져있었으면 드래그는 '선택', 켜져있었으면 '해제'
    pjvDrag.base = new Map();
    for (const c of pjvDragChecks(kind)) pjvDrag.base.set(c, c.classList.contains('on'));
    document.body.classList.add('pjv-dragging'); // 드래그 중 텍스트 선택 방지
    e.preventDefault(); // 포커스/드래그 선택 억제(click 은 그대로 발생 → 단순 클릭 유지)
  });
  cb.onclick = (e: any) => {
    e.stopPropagation();
    if (pjvDrag.suppressClick) { pjvDrag.suppressClick = false; return; } // 드래그 뒤 따라온 click 무시
    // Shift+클릭 — 직전 앵커~현재까지 같은 kind 를 이어 선택.
    if (e.shiftKey && pjvSel.kind === kind && pjvSelLastEl && (pjvSelLastEl as any)._pjvKind === kind) {
      const list = pjvDragChecks(kind);
      const ai = list.indexOf(pjvSelLastEl), ci = list.indexOf(cb);
      if (ai >= 0 && ci >= 0) {
        const lo = Math.min(ai, ci), hi = Math.max(ai, ci);
        pjvSelSilent = true;
        for (let i = lo; i <= hi; i++) pjvSetChecked(list[i], true);
        pjvSelSilent = false; pjvSelRenderBar();
        pjvSelLastEl = cb;
        return;
      }
    }
    const on = !(pjvSel.kind === kind && pjvSel.ids.has(item.id));
    pjvSetChecked(cb, on);
    pjvSelLastEl = cb;
  };
  return cb;
}

// ── 그룹 헤더 전체선택 체크박스(#664) — 상태(할 일/진행 중/…) 그룹 헤더 좌측. 클릭하면 그 그룹 본문의
//  모든 행(펼쳐진 하위 포함)을 한 번에 선택/해제한다. 행 체크박스(pjvRowCheck)와 같은 스타일·hover 노출.
//  _pjvKind 를 안 달아 드래그 범위선택(pjvDragChecks)에는 안 섞인다. 선택 리셋 시 .on 은 pjvSelDomClear 가 함께 지운다.
function pjvGroupCheck(kind, bodyEl) {
  const cb: any = el('button', { class: 'pjv-row-check pjv-group-check', type: 'button', title: '이 그룹 전체 선택/해제', 'aria-label': '그룹 전체 선택/해제' });
  const rowChecks = () => [...bodyEl.querySelectorAll('.pjv-row-check')].filter((c: any) => c._pjvKind === kind);
  const allOn = (checks) => checks.length > 0 && checks.every((c: any) => pjvSel.kind === kind && pjvSel.ids.has(c._pjvItem.id));
  const sync = () => { cb.classList.toggle('on', allOn(rowChecks())); };
  cb.addEventListener('pointerenter', sync); // 개별 행 토글로 어긋난 표시를 호버 시점에 재동기
  cb.onclick = (e: any) => {
    e.stopPropagation();
    const checks = rowChecks();
    if (!checks.length) return;
    const on = !allOn(checks);
    pjvSelSilent = true;
    for (const c of checks) pjvSetChecked(c, on);
    pjvSelSilent = false;
    pjvSelRenderBar();
    cb.classList.toggle('on', on);
    pjvSelLastEl = null; // Shift+클릭 앵커는 개별 행 기준 — 그룹 토글 후엔 리셋
  };
  return cb;
}

// ── 그룹 내 프로젝트 행 수동 재정렬(#541) — 기존 행 HTML5 드래그(pjvFolderDrag)를 재사용: 같은 그룹 본문 위면
//  삽입선을 띄우고, 드롭 시 DOM 재배치 + 그 그룹의 새 순서(형제 전체 id)를 projects-reorder 로 저장(sort=1..n).
//  표시 순서는 pjvManualCmp(sort → ClickUp ext_orderindex → 최신순)가 소비. 컬럼 정렬이 켜져 있으면 비활성(ClickUp 동형).
function pjvGroupReorderTarget(body, _reload) {
  let marker: any = null;
  const rows = () => [...body.children].filter((c: any) => c.classList && c.classList.contains('pjv-proj-wrap'));
  const clear = () => { if (marker) { marker.remove(); marker = null; } };
  body.addEventListener('dragover', (ev: any) => {
    if (pjvSortCtx && pjvSortCtx.colSort) return; // 정렬 중엔 수동 순서 의미 없음
    const dragId = pjvFolderDrag.id;
    if (dragId == null) return;
    const dragged = rows().find((w: any) => String(w.getAttribute('data-proj-id')) === String(dragId));
    if (!dragged) return; // 이 그룹의 행이 아님 — 리스트/폴더 이동 등 기존 드롭 타깃에 맡긴다
    ev.preventDefault(); ev.stopPropagation();
    try { ev.dataTransfer.dropEffect = 'move'; } catch (_) { /* noop */ }
    if (!marker) marker = el('div', { class: 'pjv-proj-insert-marker', 'aria-hidden': 'true' });
    let before: any = null;
    for (const w of rows()) {
      if (w === dragged) continue;
      const r = w.getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) { before = w; break; }
    }
    if (before) body.insertBefore(marker, before);
    else { const rs = rows(); const last = rs[rs.length - 1]; if (last) body.insertBefore(marker, last.nextSibling); }
  });
  body.addEventListener('dragleave', (ev: any) => { if (!body.contains(ev.relatedTarget)) clear(); });
  body.addEventListener('drop', (ev: any) => {
    const dragId = pjvFolderDrag.id;
    if (dragId == null || !marker) { clear(); return; }
    const dragged = rows().find((w: any) => String(w.getAttribute('data-proj-id')) === String(dragId));
    if (!dragged) { clear(); return; }
    ev.preventDefault(); ev.stopPropagation();
    pjvFolderDrag.id = null;
    body.insertBefore(dragged, marker);
    clear();
    const ids = rows().map((w: any) => Number(w.getAttribute('data-proj-id'))).filter(Boolean);
    if (ids.length > 1) {
      ids.forEach((id, i) => pjvLocalSortOverride.set(id, i + 1)); // 세션 오버라이드 — 재렌더 원복 방지(서버 재부여와 동일 1..n)
      api('/api/ui/v6/projects-reorder', { method: 'POST', body: JSON.stringify({ ids }) })
        .then(() => toast('순서를 저장했습니다'))
        .catch((e) => toast('순서 저장 실패 — ' + e.message, true));
    }
  });
}

// ── 드래그 재정렬(#366) — 호버 시 체크박스 왼쪽 핸들(⠿)을 잡고 위/아래로 끌어 태스크 순서를 바꾼다.
//  · 여러 개 선택(pjvSel, kind='task')한 상태에서 핸들을 잡으면 선택분 전체가 'N개' 한 덩어리로 이동(클릭업 동형).
//  · 드래그 중: 커서를 따라다니는 고스트 + 놓일 자리에 가로 삽입선(marker). 같은 컨테이너의 형제 태스크 행끼리만.
//  · 끝나면 DOM 을 재배치하고 새 순서(sort)를 서버에 저장. 저장 API 미배포 환경에선 화면 순서만 바뀐다(새로고침 시 원복).
const pjvReorder: any = { active: false, wraps: [], container: null, ghost: null, marker: null, reload: null, _init: false };

// 컨테이너의 직계 태스크 행(형제)만 — 서브태스크(.pjv-trow-subs 안)는 각자의 컨테이너에서 다룬다.
function pjvReorderSibs(container) {
  return [...container.children].filter((c: any) => c.classList && c.classList.contains('pjv-trow-wrap') && c.hasAttribute('data-task-id'));
}
function pjvReorderStart(e, wrap, reload) {
  const container = wrap.parentElement;
  if (!container) return;
  const sibs = pjvReorderSibs(container);
  // 이 행이 다중선택(task)에 포함돼 있으면 선택분 전체(같은 컨테이너 것만), 아니면 이 행만 이동.
  const selIds = pjvSel.kind === 'task' ? pjvSel.ids : new Set();
  let moving = sibs.filter((w: any) => selIds.has(Number(w.getAttribute('data-task-id'))));
  if (!moving.length || moving.indexOf(wrap) < 0) moving = [wrap];
  pjvReorder.active = true; pjvReorder.container = container; pjvReorder.wraps = moving; pjvReorder.reload = reload;
  const label = moving.length > 1 ? (moving.length + '개 태스크') : (wrap.getAttribute('data-task-name') || '태스크');
  pjvReorder.ghost = el('div', { class: 'pjv-reorder-ghost', text: label });
  pjvReorder.marker = el('div', { class: 'pjv-reorder-marker', 'aria-hidden': 'true' });
  document.body.append(pjvReorder.ghost);
  moving.forEach((w: any) => w.classList.add('pjv-reorder-src'));
  document.body.classList.add('pjv-dragging');
  pjvReorderMove(e);
  e.preventDefault();
}
function pjvReorderMove(e) {
  if (!pjvReorder.active) return;
  if (e.buttons === 0) { pjvReorderEnd(); return; } // 창 밖에서 손을 뗀 경우 등 — 끊김 방지
  const g = pjvReorder.ghost;
  if (g) { g.style.left = (e.clientX + 14) + 'px'; g.style.top = (e.clientY + 12) + 'px'; }
  const rest = pjvReorderSibs(pjvReorder.container).filter((w: any) => pjvReorder.wraps.indexOf(w) < 0);
  let before: any = null;
  for (const w of rest) {
    const r = w.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { before = w; break; }
  }
  const m = pjvReorder.marker;
  if (before) pjvReorder.container.insertBefore(m, before);
  else pjvReorder.container.append(m);
}
function pjvReorderEnd() {
  if (!pjvReorder.active) return;
  pjvReorder.active = false;
  const { container, wraps, marker, ghost } = pjvReorder;
  document.body.classList.remove('pjv-dragging');
  if (ghost) ghost.remove();
  wraps.forEach((w: any) => w.classList.remove('pjv-reorder-src'));
  if (marker && marker.parentElement === container) { for (const w of wraps) container.insertBefore(w, marker); }
  if (marker) marker.remove();
  const ids = pjvReorderSibs(container).map((w: any) => Number(w.getAttribute('data-task-id')));
  pjvReorder.wraps = []; pjvReorder.container = null; pjvReorder.ghost = null; pjvReorder.marker = null; pjvReorder.reload = null;
  if (pjvSel.kind === 'task') pjvSelReset(); // 이동 후 선택 해제(자리 이동이 끝났으니)
  if (ids.length > 1) {
    api('/api/ui/v6/tasks-reorder', { method: 'POST', body: JSON.stringify({ ids }) })
      .then(() => toast('순서를 저장했습니다'))
      .catch(() => toast('순서를 화면에만 반영했어요 (저장 미지원 — 새로고침 시 원복)', true));
  }
}
function pjvReorderInit() {
  if (pjvReorder._init) return; pjvReorder._init = true;
  document.addEventListener('pointermove', pjvReorderMove);
  document.addEventListener('pointerup', pjvReorderEnd);
}
// 좌측 드래그 핸들(⠿) — 태스크 행 전용. ctx.reload 로 실패 시 원복 렌더.
function pjvRowGrip(_kind, _item, ctx) {
  pjvReorderInit();
  const g: any = el('button', { class: 'pjv-row-grip', type: 'button', tabindex: '-1', 'aria-label': '드래그해서 순서 바꾸기', title: '드래그해서 순서 바꾸기' }, '⠿');
  g.addEventListener('pointerdown', (e: any) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const wrap = g.closest('.pjv-trow-wrap');
    if (wrap) pjvReorderStart(e, wrap, ctx && ctx.reload);
  });
  g.onclick = (e: any) => { e.stopPropagation(); e.preventDefault(); }; // 핸들 클릭이 행 이동/네비로 새지 않게
  return g;
}
function pjvActIcon(kind) {
  const svg = (...k) => sv('svg', { class: 'pjv-act-ic', viewBox: '0 0 24 24', width: '15', height: '15', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...k);
  if (kind === 'add') return svg(sv('path', { d: 'M12 5v14M5 12h14' }));
  if (kind === 'tag') return svg(sv('path', { d: 'M4 4h7l9 9-7 7-9-9z' }), sv('circle', { cx: '8.4', cy: '8.4', r: '1.3' }));
  if (kind === 'rename') return svg(sv('path', { d: 'M4 20h4L18 10l-4-4L4 16z' }), sv('path', { d: 'M13.5 6.5l4 4' }));
  // 세션 만들기(#1236) — 터미널 창(>_ 프롬프트, pjvIcon('session') 동형) + 우상단 ＋ 배지('입장'이 아니라 '만들기').
  //  가운데 ＋만 넣으면 그냥 네모+더하기로 읽혀 터미널 느낌이 없다는 피드백으로 프롬프트를 살렸고,
  //  도형이 뷰박스를 꽉 채우게 키웠다(창이 60%만 차지해 같은 px 여도 옆 아이콘보다 작아 보였다).
  if (kind === 'session') return svg(
    sv('rect', { x: '1.5', y: '4.5', width: '16', height: '14', rx: '2.4' }),
    sv('path', { d: 'M5.2 9.4l3 2.6-3 2.6' }), sv('path', { d: 'M10.6 15.4h3.8' }),
    sv('path', { d: 'M20.6 2.6v5' }), sv('path', { d: 'M18.1 5.1h5' }));
  return svg();
}
function pjvRowActions(specs) {
  const group = el('span', { class: 'pjv-row-actions' });
  for (const s of specs) {
    if (!s) continue;
    const b = el('button', { class: 'pjv-row-act', type: 'button', title: s.title }, pjvActIcon(s.icon));
    b.onclick = (e) => { e.stopPropagation(); s.fn(b); };
    group.append(b);
  }
  return group;
}
// 행 인라인 태그 편집 팝오버(태스크) — 토글 추가/제거 + 새 태그 만들기. 닫힐 때 행 칩 갱신(reload).
async function pjvTagPopover(anchor, t, reload) {
  const menu = el('div', { class: 'pjv-menu pjv-rowtag-pop' });
  pjvPopover(anchor, menu);
  let changed = false;
  const obs = new MutationObserver(() => { if (!menu.isConnected) { obs.disconnect(); if (changed && reload) reload(); } });
  obs.observe(document.body, { childList: true, subtree: true });
  const draw = (all) => {
    const cur = new Set((t.tags || []).map((x) => x.id));
    menu.replaceChildren(el('div', { class: 'pjv-menu-head', text: '태그' }));
    for (const tg of all) {
      const on = cur.has(tg.id);
      const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
        el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (tg.color || PJV_TAG_NONE) }), el('span', { text: tg.name }), el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
      item.onclick = async (e) => {
        e.stopPropagation();
        try {
          if (on) { t.tags = (t.tags || []).filter((x) => x.id !== tg.id); await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tg.id, remove: true }) }); }
          else { t.tags = [...(t.tags || []), tg]; await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tg.id }) }); }
          changed = true; draw(all);
        } catch (err) { toast('태그 적용 실패 — ' + err.message, true); }
      };
      menu.append(item);
    }
    const inp = el('input', { type: 'text', class: 'pjv-rowtag-input', placeholder: '새 태그 이름 후 Enter', maxlength: '40' });
    inp.onkeydown = async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); const name = (inp as any).value.trim(); if (!name) return;
        try {
          const tags = await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ name }) }).then((r) => (r && r.tags) || []);
          t.tags = tags; changed = true;
          const all2 = ((await api('/api/ui/v6/tags')) || {}).tags || []; draw(all2);
        } catch (err) { toast('태그 생성 실패 — ' + err.message, true); }
      }
    };
    menu.append(el('div', { class: 'pjv-bulk-sep-h' }), inp);
  };
  menu.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
  let all: any[] = [];
  try { all = ((await api('/api/ui/v6/tags')) || {}).tags || []; } catch (_) { /* graceful */ }
  draw(all);
}

// 행(프로젝트/태스크/서브태스크) 태그 칩 — 보이는 칩(최대 2)에 호버 ×(제거). 클릭업식. row.id 로 /tasks/:id/tags 공유(프로젝트·태스크 동일).
//  비면 null 반환. 제거는 낙관적(즉시 칩 제거) + 백그라운드 POST(실패 시 reload 로 복구).
function pjvRowTagsEl(row, reload) {
  if (!(row.tags || []).length) return null;
  const wrap = el('span', { class: 'pjv-trow-tags' });
  const removeTag = async (tg) => {
    row.tags = (row.tags || []).filter((x) => x.id !== tg.id);
    repaint();
    try { await api('/api/ui/v6/tasks/' + row.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tg.id, remove: true }) }); }
    catch (e) { toast('태그 제거 실패 — ' + e.message, true); if (reload) reload(); }
  };
  function repaint() {
    wrap.replaceChildren();
    const cur = row.tags || [];
    for (const tg of cur.slice(0, 2)) {
      const x = el('button', { class: 'pjv-trow-tag-x', type: 'button', title: '태그 제거', text: '✕' });
      x.onclick = (e) => { e.stopPropagation(); removeTag(tg); };
      wrap.append(el('span', { class: 'pjv-trow-tag', style: '--tag:' + (tg.color || PJV_TAG_NONE), title: tg.name },
        el('span', { class: 'pjv-trow-tag-name', text: tg.name }), x));
    }
    if (cur.length > 2) wrap.append(el('span', { class: 'pjv-trow-tag-more', text: '+' + (cur.length - 2) }));
  }
  repaint();
  return wrap;
}

export {
  pjvActIcon,
  pjvBulkApply,
  pjvBulkAssignee,
  pjvBulkBarEl,
  pjvBulkDelete,
  pjvBulkDue,
  pjvBulkDuplicate,
  pjvBulkIcon,
  pjvBulkList,
  pjvBulkPriority,
  pjvBulkRunClaude,
  pjvBulkRunDefaultsModal,
  pjvBulkStatus,
  pjvBulkTags,
  pjvDrag,
  pjvDragChecks,
  pjvDragEnd,
  pjvDragInit,
  pjvDragPaint,
  pjvGroupCheck,
  pjvGroupReorderTarget,
  pjvReorder,
  pjvReorderEnd,
  pjvReorderInit,
  pjvReorderMove,
  pjvReorderSibs,
  pjvReorderStart,
  pjvRowActions,
  pjvRowCheck,
  pjvRowGrip,
  pjvRowTagsEl,
  pjvRunDefaults,
  pjvRunDefaultsKey,
  pjvRunDefaultsLegacyKey,
  pjvSaveRunDefaults,
  pjvSel,
  pjvSelDomClear,
  pjvSelIds,
  pjvSelLastEl,
  pjvSelPatchUrl,
  pjvSelReloadAfter,
  pjvSelRenderBar,
  pjvSelReset,
  pjvSelSilent,
  pjvSelToggle,
  pjvSetChecked,
  pjvTagPopover,
};

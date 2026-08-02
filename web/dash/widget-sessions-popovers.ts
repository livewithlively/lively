// dash/widget-sessions-popovers.ts — '내 AI 세션' 위젯의 거르기 모델 + 팝오버·팝업 4종(#1313 R42 · dashboard-home.ts 에서 verbatim 분리).
//  ① 거르기 모델: 기준 집합(baseSessions) → 출처(src)·상태(state) 두 축의 **다중선택**. 빈 집합 = 그 축 '전체'.
//   ⚠ 모델이 여기 있는 이유: 팝오버의 **카운트**와 draw() 의 **목록**이 반드시 같은 함수에서 나와야 한다(계약 아래) —
//    그래서 widget-sessions.ts 가 이 파일을 import 한다(반대 방향은 타입만).
//  ② 헤더 칩의 필터 팝오버 ③ 헤더 ⚙ '세션 표시 설정'(완료 프로젝트·온라인만·정렬·밀도) ④ 카드 ⋮ 메뉴 + 이름 수정 팝업.
//
// ⚠ 이 파일이 지켜야 하는 계약
//  · **칩 카운트와 실제로 그려지는 카드 수는 언제나 같다.** 그래서 팝오버의 개수도, draw() 의 목록도 전부
//    sessBaseSessions() 하나에서 출발한다(축 필터 적용 전 기준 집합).
//  · **팝오버는 항목을 골라도 닫히지 않는다.** 여러 개를 연속으로 체크할 수 있어야 하므로, 고를 때마다
//    자기 패널만 render() 로 다시 그린다 — draw() 로 위젯을 갈아끼우면 앵커(헤더 칩)가 끊긴다(#1098).
//    그 앵커 노드가 재생성되지 않는다는 짝 계약은 widget-sessions.ts 헤더에 있다.
//  · 상태 어휘(STATE_OPTS)는 AI 세션 탭과 **한 벌**(web/session-status.ts) — 여기서 따로 만들지 않는다(#1059 P1).
import { api, el, toast } from '../core.js';
import { overlay } from '../admin.js';            // 세션 이름 수정 팝업 — 다른 모달과 같은 프리미티브(#853)
import { openSessPrompts } from '../terminal.js'; // 세션 '내 질문' 팝업 재사용(#745) — 두 벌 만들지 않는다(#853)
import { SESS_STATES, SESS_STATE_KEYS } from '../session-status.js';
import { dashSaveSessDensity, dashSaveSessFilter2, dashSaveSessOnlineOnly, dashSaveSessShowClosed, dashSaveSessSort } from './prefs.js';
import { dashSessDead, dashSessState } from './status.js';
import { dashPopover } from './chrome.js';
import type { SessCtx } from './widget-sessions.js';

// #1098 출처 버킷 — 모든 세션이 정확히 하나에 속한다(상호배타). 초대받은 남의 세션 / 내 프로젝트 세션 / 내 개인 세션.
const sessSrcBucket = (s) => !s.owned ? 'invited' : (Number(s.projectId) || 0) ? 'myproj' : 'private';
// 필터용 상태 버킷 — 카드 배지(6종)를 거르는 축(5종)으로 접는다. exited(하네스 종료)와 offline(노드 끊김)은 사용자에겐 둘 다 '종료됨'.
//  '작업 완료'(#1098 done)는 별도 칸을 만들지 않고 그 아래 실제 상태인 '대기 중'으로 걸린다.
// 라벨 = 버킷(1:1). 종전의 흡수(offline→exited, done→idle)는 '고른 것과 다른 결과'를 만들어 제거했다.
const sessStateBucket = (s) => dashSessState(s).key;
const SESS_SRC_OPTS: any[] = [['myproj', '프로젝트'], ['private', '개인'], ['invited', '초대']];
// #1059 P1 — AI 세션 탭과 **같은 항목·같은 순서**. 종전엔 offline 이 exited 버킷에 흡수돼 '종료됨'을 고르면
//  오프라인 세션까지 딸려왔다(고객사 A 기준 3건 고르려다 45건).
const SESS_STATE_OPTS: any[] = SESS_STATE_KEYS.map((k) => [k, SESS_STATES[k].label]);

// #req 완료·보관(done/closed) 프로젝트의 세션은 기본 숨김. ⚙ 설정 팝오버의 '완료·보관 프로젝트 세션 표시' 토글로 포함.
//  ⚠ #853: 단, '살아있는(non-offline = 작업중/확인필요/대기중)' 세션은 프로젝트가 done 이어도 **항상 표시**한다.
const sessIsProjClosed = (p) => !!p && (p.status === 'done' || p.status_category === 'done' || p.status_category === 'closed'); // 내 프로젝트 모달 isDone 과 동형
// #853 살아있는 세션은 done 프로젝트여도 숨기지 않는다
const sessIsClosedProjSess = (ctx: SessCtx, s) => { const pid = Number(s.projectId) || 0; return pid > 0 && ctx.closedPids.has(pid) && dashSessDead(s); };
// 축 필터를 걸기 전의 기준 집합 — 필터 칩의 카운트와 실제로 그려지는 카드 수가 항상 일치하도록 둘 다 이걸 쓴다.
const sessBaseSessions = (ctx: SessCtx) => ctx.sessions
  .filter((s) => ctx.showClosed || !sessIsClosedProjSess(ctx, s))
  .filter((s) => !ctx.onlineOnly || !dashSessDead(s));   // #670 온라인만 — 축 필터보다 앞(칩 카운트도 이 기준)
const sessMatchSrc = (ctx: SessCtx, s) => ctx.fSrc.size === 0 || ctx.fSrc.has(sessSrcBucket(s));
const sessMatchState = (ctx: SessCtx, s) => ctx.fState.size === 0 || ctx.fState.has(sessStateBucket(s));
// 칩 라벨 = 현재 조건 요약. 2개까지는 이름 그대로, 3개부터는 '조건 N개'(헤더 폭이 흔들리지 않게).
function sessFilterLabel(ctx: SessCtx) {
  const picked = [...ctx.fSrc].map((k) => (SESS_SRC_OPTS.find(([x]) => x === k) || [, k])[1])
    .concat([...ctx.fState].map((k) => (SESS_STATE_OPTS.find(([x]) => x === k) || [, k])[1]));
  if (!picked.length) return '전체';
  return picked.length <= 2 ? picked.join(' · ') : '조건 ' + picked.length + '개';
}

// #1098 필터 팝오버 — 출처/상태 2섹션 **다중선택**. 항목을 골라도 **닫히지 않는다**(여러 개 연속으로 체크할 수 있어야 함).
//  ⚠ 그래서 팝오버 안은 draw() 로 갈아끼우지 않고 이 함수가 자기 패널만 다시 그린다(패널이 사라지면 dashPopover 의
//   바깥클릭 감지가 오작동하고 선택이 끊긴다). 헤더 칩(fdd)도 노드를 새로 만들지 않고 라벨만 갱신한다.
function sessOpenFilterMenu(ctx: SessCtx, anchor) {
  const panel = el('div', { class: 'dash-pop-panel dash-pop-panel--filter' });
  const render = () => {
    const nodes: any[] = [];
    const head = el('div', { class: 'dash-pop-head' }, el('strong', { text: '세션 보기' }));
    if (ctx.fSrc.size || ctx.fState.size) {
      const clr = el('button', { class: 'dash-pop-clear', type: 'button', text: '초기화' });
      clr.onclick = () => { ctx.fSrc.clear(); ctx.fState.clear(); apply(); };
      head.append(clr);
    }
    nodes.push(head);
    const section = (title, opts, set, bucketOf, otherOk) => {
      nodes.push(el('div', { class: 'dash-pop-sec', text: title }));
      const pool = sessBaseSessions(ctx).filter(otherOk);
      // '전체' = 이 축을 안 거름(선택 비우기). 아무것도 안 골랐으면 여기 체크가 서 있다.
      const allRow = el('button', { class: 'dash-pop-opt dash-pop-opt--all' + (set.size === 0 ? ' sel' : ''), type: 'button', 'aria-pressed': String(set.size === 0) },
        el('span', { class: 'dash-pop-box', text: set.size === 0 ? '✓' : '' }),
        el('span', { class: 'dash-pop-name', text: '전체' }),
        el('span', { class: 'dash-pop-cnt', text: String(pool.length) }));
      allRow.onclick = () => { set.clear(); apply(); };
      nodes.push(allRow);
      for (const [k, label] of opts) {
        const n = pool.filter((s) => bucketOf(s) === k).length;
        const on = set.has(k);
        // 0건 항목도 숨기지 않는다 — '초대받은 세션이 아예 없구나'가 그 자리에서 읽히는 편이 낫다(항목이 사라지면 헷갈린다).
        const row = el('button', { class: 'dash-pop-opt' + (on ? ' sel' : '') + (n === 0 && !on ? ' zero' : ''), type: 'button', 'aria-pressed': String(on) },
          el('span', { class: 'dash-pop-box', text: on ? '✓' : '' }),
          el('span', { class: 'dash-pop-name', text: label }),
          el('span', { class: 'dash-pop-cnt', text: String(n) }));
        row.onclick = () => { if (on) set.delete(k); else set.add(k); apply(); };
        nodes.push(row);
      }
    };
    section('출처', SESS_SRC_OPTS, ctx.fSrc, sessSrcBucket, (s) => sessMatchState(ctx, s));
    section('상태', SESS_STATE_OPTS, ctx.fState, sessStateBucket, (s) => sessMatchSrc(ctx, s));
    panel.replaceChildren(...nodes);
  };
  const apply = () => { dashSaveSessFilter2({ src: [...ctx.fSrc], state: [...ctx.fState] }); render(); ctx.draw(); };
  render();
  dashPopover(anchor, panel);
}

// #1098 설명은 기본으로 접는다 — 항목마다 회색 두 줄이 붙으니 팝오버가 화면을 넘길 만큼 길어졌다.
//  이름 옆 (i) 를 누를 때만 펼친다. ⚠ 이 (i) 는 체크박스 label·옵션 button 안에 들어가므로 클릭이
//  부모로 새면 설정이 토글된다 → mousedown/click 둘 다 여기서 끊는다(preventDefault 포함).
function sessPopTxt(name: string, desc: string) {
  const descEl = el('span', { class: 'dash-pop-desc', hidden: true, text: desc });
  const info: any = el('button', { class: 'dash-pop-i', type: 'button', 'aria-label': '설명 보기', 'aria-expanded': 'false', title: '설명 보기', text: 'i' });
  const stop = (e: any) => { e.preventDefault(); e.stopPropagation(); };
  info.onmousedown = stop;
  info.onclick = (e: any) => {
    stop(e);
    descEl.hidden = !descEl.hidden;
    info.classList.toggle('on', !descEl.hidden);
    info.setAttribute('aria-expanded', String(!descEl.hidden));
  };
  return el('span', { class: 'dash-pop-txt' },
    el('span', { class: 'dash-pop-nameline' }, el('span', { class: 'dash-pop-name', text: name }), info),
    descEl);
}

// 헤더 우상단 통일 컨트롤 — ⚙(세션 표시 설정) + →(터미널 딥링크). ⚙ = '완료·보관 프로젝트 세션 표시' 토글(#req, 기존 '기본 필터'는 칩과 중복이라 폐지).
function sessOpenPrefs(ctx: SessCtx, a) {
  const setShowClosed = (v) => { ctx.showClosed = v; dashSaveSessShowClosed(v); ctx.draw(); };
  const setOnlineOnly = (v) => { ctx.onlineOnly = v; dashSaveSessOnlineOnly(v); ctx.draw(); };
  const setSortMode = (v) => { ctx.sortMode = v; dashSaveSessSort(v); ctx.draw(); };
  const setDensity = (v) => { ctx.density = v; dashSaveSessDensity(v); ctx.draw(); }; // #758
  const panel = el('div', { class: 'dash-pop-panel' });
  let close = () => { /* dashPopover 반환값으로 대체 */ };
  panel.append(el('div', { class: 'dash-pop-head' }, el('strong', { text: '세션 표시 설정' }), el('span', { class: 'dash-pop-sub', text: '이 기기에 저장돼요' })));
  const cb: any = el('input', { type: 'checkbox' }); cb.checked = ctx.showClosed;
  cb.onchange = () => setShowClosed(cb.checked);
  panel.append(el('label', { class: 'dash-pop-row' }, cb,
    sessPopTxt('완료·보관 프로젝트 세션 표시', 'done/closed 프로젝트의 종료된(오프라인) 세션도 표시. 작업 중·확인 필요·대기 중 세션은 이 설정과 무관하게 항상 보여요.')));
  // #670 온라인 세션만 — 지금 도는 세션만. 상태 필터로도 되지만 스위치 하나가 더 빠르다(상민님, #1098 후속으로 복구).
  const cbOnline: any = el('input', { type: 'checkbox' }); cbOnline.checked = ctx.onlineOnly;
  cbOnline.onchange = () => setOnlineOnly(cbOnline.checked);
  panel.append(el('label', { class: 'dash-pop-row' }, cbOnline,
    sessPopTxt('온라인 세션만', '작업 중·확인 필요·대기 중만 표시 — 오프라인·종료됨·복원 가능 숨김')));
  // #req 카드 정렬 선택.
  panel.append(el('div', { class: 'dash-pop-gh', text: '카드 정렬' }));
  // 이름이 곧 기준이라 설명을 달지 않는다 — 읽으면 아는 항목에 (i) 를 붙이면 팝오버만 시끄러워진다(상민님).
  const sortOpts: Array<[string, string]> = [
    ['active',   '최근 작업순 (기본)'],
    ['priority', '상태순'],
    ['recent',   '최근 생성순'],
    ['name',     '작업 제목순'],
  ];
  for (const [k, label] of sortOpts) {
    const row = el('button', { class: 'dash-pop-opt' + (k === ctx.sortMode ? ' sel' : ''), type: 'button' },
      el('span', { class: 'dash-pop-name', text: label }),
      k === ctx.sortMode ? el('span', { class: 'dash-pop-check', text: '✓' }) : null);
    row.onclick = () => { close(); setSortMode(k); };
    panel.append(row);
  }
  // #758 카드 보기 밀도 — 자세히(리치 2줄) vs 간략히(한 줄). '두 줄이어서 짧던' 예전 느낌으로 접을 수 있게.
  panel.append(el('div', { class: 'dash-pop-gh', text: '카드 보기' }));
  for (const [k, label] of [['full', '자세히 (기본)'], ['compact', '간략히']] as [string, string][]) {
    const row = el('button', { class: 'dash-pop-opt' + (k === ctx.density ? ' sel' : ''), type: 'button' },
      el('span', { class: 'dash-pop-name', text: label }),
      k === ctx.density ? el('span', { class: 'dash-pop-check', text: '✓' }) : null);
    row.onclick = () => { close(); setDensity(k); };
    panel.append(row);
  }
  // (구 '관리 ▸ 세션 선택' 항목은 폐지 — 체크박스는 카드에 호버하면 나오고, 눌러서 위아래로 끌면 범위 선택(#1140),
  //  고르면 하단 바가 뜬다. 굳이 ⚙ 안에 '선택 모드' 스위치를 둘 이유가 없다.)
  close = dashPopover(a, panel);
}

// 세션 이름 수정 팝업(#853) — 브라우저 기본 prompt() 대신 우리 UI. overlay = 다른 모달과 같은 프리미티브(admin.js).
//  Enter=저장 / Esc=닫기(overlay 기본). 빈 이름·무변경이면 저장 비활성.
function openSessRename(s, onChange) {
  const input: any = el('input', { class: 'dash-rename-input', type: 'text', maxlength: '120', placeholder: '예: 위키 개선 조사', value: s.label || '' });
  const save: any = el('button', { class: 'btn btn-primary', type: 'button', text: '저장' });
  const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: '취소' });
  const err = el('div', { class: 'dash-rename-err', hidden: true });
  const body = el('div', { class: 'dash-rename' },
    el('label', { class: 'dash-rename-lbl', for: 'dash-rename-in', text: '세션 이름' }),
    input,
    el('div', { class: 'dash-rename-hint', text: '터미널 목록·대시보드 카드에 보이는 이름이에요. 지금 하는 작업 제목(클로드가 쓰는 것)과는 별개예요.' }),
    err,
    el('div', { class: 'dash-rename-acts' }, cancel, save));
  const back = overlay('세션 이름 수정', body);
  const close = () => back.remove();
  cancel.onclick = close;
  const sync = () => { const v = input.value.trim(); save.disabled = !v || v === (s.label || ''); };
  input.addEventListener('input', sync); sync();
  const submit = async () => {
    const to = input.value.trim();
    if (!to || to === (s.label || '')) return;
    save.disabled = true; save.textContent = '저장 중…';
    try {
      await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label: to }) });
      toast('이름을 바꿨어요'); close(); onChange && onChange();
    } catch (e: any) {
      err.textContent = '이름 변경 실패 — ' + ((e && e.message) || e); err.hidden = false;
      save.disabled = false; save.textContent = '저장';
    }
  };
  save.onclick = submit;
  input.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

// 세션 '⋯' 메뉴 — 이름 수정 · 내 질문 보기 · 삭제. 이름 수정/삭제는 소유자만(서버도 비소유 403 재검증).
//  '내 질문'은 터미널 탭의 팝업(openSessPrompts, #745)을 그대로 재사용 — 접근통제는 서버 canAttach.
function openSessMenu(anchor, s, onChange) {
  const panel = el('div', { class: 'dash-pop-panel' });
  let close = () => { /* dashPopover 반환값으로 대체 */ };
  const item = (label, desc, danger, fn) => {
    const b = el('button', { class: 'dash-pop-opt' + (danger ? ' danger' : ''), type: 'button' },
      el('span', { class: 'dash-pop-txt' }, el('span', { class: 'dash-pop-name', text: label }), desc ? el('span', { class: 'dash-pop-desc', text: desc }) : null));
    b.onclick = () => { close(); fn(); }; panel.append(b);
  };
  if (s.owned) item('이름 수정', null, false, () => openSessRename(s, onChange));
  item('질문 보기', '이 세션에서 AI 에게 보낸 질문 전부(누가 보냈든) 모아보기', false, () => openSessPrompts(s));
  // #1059 E — restorable(이미 꺼진) 세션은 '복원 목록에서 제거'(desired-state 삭제), 라이브 세션은 '삭제'(작업 종료).
  if (s.owned) item(s.restorable ? '복원 목록에서 제거' : '삭제', s.restorable ? '이 세션을 더는 복원하지 않습니다' : null, true, async () => {
    const msg = s.restorable
      ? '세션 ‘' + (s.label || '(이름 없음)') + '’을(를) 복원 목록에서 제거할까요?\n더는 복원할 수 없어요 (되돌릴 수 없어요).'
      : '세션 ‘' + (s.label || '(이름 없음)') + '’을(를) 삭제할까요?\n실행 중인 작업도 함께 종료됩니다 (되돌릴 수 없어요).';
    if (!confirm(msg)) return;
    try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' }); toast(s.restorable ? '복원 목록에서 제거했어요' : '세션을 삭제했어요'); onChange && onChange(); }
    catch (e: any) { toast('삭제 실패 — ' + (e && e.message || e), true); }
  });
  close = dashPopover(anchor, panel);
}

export {
  openSessRename, openSessMenu,
  sessSrcBucket, sessStateBucket, SESS_SRC_OPTS, SESS_STATE_OPTS,
  sessIsProjClosed, sessIsClosedProjSess, sessBaseSessions,
  sessMatchSrc, sessMatchState, sessFilterLabel,
  sessOpenFilterMenu, sessOpenPrefs,
};

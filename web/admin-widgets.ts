// admin-widgets.ts — 관리탭 공용 위젯·프리미티브 (#1313 R37, admin.ts 에서 verbatim 분리).
//  admin.ts 와 분리된 패널 모듈(admin-audit/automation/preview…)이 **함께** 쓰는 조각만 둔다.
//  여기 있는 것들은 어떤 패널도 import 해도 순환이 안 생기는 잎(leaf) 이어야 한다 — core.js·ui-primitives.js 외 의존 금지.
//  ⚠ 앱 전역 프리미티브(field·overlay·copyButton·confirmDialog…)는 여기 있지 않다 — web/ui-primitives.ts 소유(#1313 R27).
//   관리탭 밖에서도 쓰이던 것들이라 여기로 내려오면 정의가 두 벌이 된다. 필요하면 아래처럼 거기서 직접 받는다.
import { api, cardHead, el, errorNote, state, toast, uiText } from './core.js';
import { field, overlay } from './ui-primitives.js';

// ════════════════════════════════════════════════════════════════════
// 화면 내 서브탭 (#837) — 여러 탭으로 갈라져 있던 **한 개념**을 한 화면에 접는다.
//  좌측 nav 는 개념 단위로만 두고(16개), 그 개념의 여러 표면은 여기서 가른다. 라우팅은 섹션 단위 그대로라
//  URL 은 안 늘어난다. 선택은 state.admin.tab[sectionKey] 에 남아 패널 자체의 재렌더(목록 갱신 등)에도 살아남는다.
//  고아로 남아 있던 .seg-tabs 스타일을 되살려 쓴다(새 시각 언어 X — styles.css:534).
//  tabs: [{ key, label, show?, render(host) }] — show 가 false 면 권한 없음 → 탭 자체를 안 그린다.
// ⚠ #1313 R39 로 admin.ts 에서 여기로 내려왔다 — 셸(admin.ts)의 병합 섹션들과 분리된 패널(admin-storage)이
//  **함께** 쓰는 조각이라, 셸에 두면 패널 → 셸 역방향 import 가 생긴다.
function segTabs(sectionKey, tabs) {
  const live = tabs.filter((t) => t.show !== false);
  const host = el('div', {});
  if (!live.length) return host;
  state.admin.tab = state.admin.tab || {};
  let cur = state.admin.tab[sectionKey];
  if (!live.some((t) => t.key === cur)) cur = live[0].key;
  state.admin.tab[sectionKey] = cur;

  const body = el('div', { class: 'seg-body' });   // 탭 내용 구획(카드)들이 여백 없이 붙지 않게 세로 간격(#req)
  const bar = el('div', { class: 'seg-tabs', role: 'tablist' });
  const paint = () => {
    for (const b of bar.children as any) b.classList.toggle('on', b.dataset.k === state.admin.tab[sectionKey]);
    body.replaceChildren();
    (live.find((t) => t.key === state.admin.tab[sectionKey]) as any).render(body);
  };
  for (const t of live) {
    const b = el('button', { type: 'button', role: 'tab', text: t.label });
    (b as any).dataset.k = t.key;
    b.addEventListener('click', () => { state.admin.tab[sectionKey] = t.key; paint(); });
    bar.append(b);
  }
  // 탭이 하나뿐이면(권한으로 나머지가 숨음) 탭 바 자체가 의미 없다 — 본문만.
  if (live.length > 1) host.append(bar);
  host.append(body);
  paint();
  return host;
}

// '이게 뭐예요?' — 기본은 화면에 설명을 깔지 않고 작은 트리거 하나만 둔다. 궁금한 사람이 누르면
//  팝업(overlay)으로 전체 설명(요약·누가/언제/어디·예시)을 보여준다. 예전엔 항상-펼침(이후 한 줄 요약+토글)
//  이라 9개 섹션마다 같은 골격이 반복돼 화면이 무거웠다(윤상민 06-22 지적: "반복·둥둥 뜸"). 단일 함수라
//  모든 섹션에 일괄 적용. tone 색·카피는 팝업 안에서 그대로 보존.

// 두 번째 인자(m)는 옛 meaning 객체 또는 설명 문자열이다. **객체(효과 카드)는 폐기됐으므로 무시**하고,
//  문자열일 때만 설명으로 쓴다(호출부를 한꺼번에 고치지 않아도 되게 인자 자리는 남겨 둔다).
//  ⚠ **페이지 제목의 설명은 ⓘ 로 접지 않는다** — 한 페이지가 무엇을 하는 곳인지는 들어오자마자 보여야 한다
//   (사용자 요구: 큰 페이지 설명은 이전대로). ⓘ 는 박스(카드) 안 섹션 제목 전용(cardHead).
function sectionTitle(titleText, m) {
  const isText = typeof m === 'string';
  return el('div', {},
    el('div', { class: 'section-title' }, el('h2', { text: titleText })),
    isText ? el('p', { class: 'admin-hint' }, ...uiText(m)) : null);
}

// 섹션 머리 — 제목 + 한 줄 설명 + '이게 뭐예요?'. 병합 섹션이 "여기 뭐가 들었나"를 먼저 말해준다.
function sectionHead(title, hint, m?) {
  // admin-sechead: 제목 블록 아래 일관 여백. 페이지 설명(hint)은 종전대로 제목 아래 한 줄로 보인다.
  return el('div', { class: 'admin-sechead' }, sectionTitle(title, m || null), hint ? el('p', { class: 'admin-hint' }, ...uiText(hint)) : null);
}

// ── ps-block 폼 조각 — 종전엔 openCronForm·openManagedSessionForm·openPreviewEnvForm·openRepoForm 이
//  각자 함수 안에 **글자 하나까지 같은** 사본을 하나씩 들고 있었다(4벌). 마크업·클래스명 그대로 한 곳에.
const psInputStyle = 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box';
const psBlock = (title, hint, ctrl) => el('section', { class: 'ps-block' },
  el('h3', { class: 'ps-block-title', text: title }),
  hint ? el('p', { class: 'ps-block-hint' }, ...uiText(hint)) : null, ctrl);

// 외부 호출·DB 안전범위(allowlist) 카드 — runtime-config 의 SSRF 화이트리스트를 도구/DB 화면 안에 인라인(2026-06-26, 구 safetyEditor 폐기).
//  fields: [{key,label,initial,placeholder,hint}]. 저장은 patch 병합(POST runtime-config, admin 전용 — 아니면 읽기전용 textarea).
function allowlistCard(data, title, intro, fields) {
  const canEdit = !!data.canEdit;
  const tas = {};
  // fix#96: 형제 카드(DB 데이터소스 등)와 같은 h2 위계로 — admin-subhead 는 하위 섹션처럼 보였다.
  const rows = [cardHead(title, intro)];
  for (const f of fields) {
    const ta = el('textarea', { rows: '3', placeholder: f.placeholder || '' }); ta.value = (f.initial || []).join('\n'); ta.disabled = !canEdit;
    tas[f.key] = ta;
    rows.push(field(f.label, el('div', {}, f.hint ? el('p', { class: 'admin-hint', style: 'margin:0 0 4px' }, ...uiText(f.hint)) : null, ta)));
  }
  if (canEdit) {
    const btn = el('button', { class: 'btn btn-primary btn-sm', text: '안전범위 저장' });
    const st = el('span', { class: 'admin-status' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const patch = {}; for (const f of fields) patch[f.key] = tas[f.key].value.split('\n').map((l) => l.trim()).filter(Boolean);
        const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify(patch) });
        if (r && r.runtimeConfig) data.runtimeConfig = r.runtimeConfig;
        st.textContent = '저장됨'; toast('저장됨 — 구성원 다음 세션부터 반영');
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });
    rows.push(el('div', { class: 'admin-actions' }, btn, st));
  }
  return el('div', { class: 'card' }, ...rows);
}

// 경과시간(초) → 사람 단위 한 줄. 관측창(게이트웨이 가동시간·attach 나이)을 게이지 밑에 그대로 쓰기 위한 것.
function fmtElapsed(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return s + '초';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '분';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '시간' + (m % 60 ? ' ' + (m % 60) + '분' : '');
  return Math.floor(h / 24) + '일' + (h % 24 ? ' ' + (h % 24) + '시간' : '');
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)) + units[i];
}

// ── [대상 구성원](#860) — 정책(전원 켬/끔/지정) + 구성원별 예외를 한 자리에. 자산·훅 공용. ──
//  #699 가 서버(org_asset_pref_set)·부트스트랩 데이터까지 만들어 두고 UI 만 안 끝냈던 자리다.
//
//  전원 on/off 를 **정책 레이어**(enabled·target_members)에 두는 게 이 화면의 핵심 결정이다. 구성원 전원에게
//  예외 행(org_asset_pref)을 일괄로 박는 방식도 가능하지만, 그러면 그 뒤 합류한 구성원은 행이 없어 정책
//  기본값으로 새고 관리자는 "전원 껐다"고 믿게 된다. 정책은 신규 구성원에게도 자동 적용되므로 그 구멍이 없다.
//  예외 레이어의 일괄 연산은 '전체 기본값 복귀'(예외 일괄 삭제) 하나만 둔다.
//
//  ⚠ 두 레이어는 **저장 시점이 다르다** — 섞이면 사용자가 뭘 눌렀는지 모른다. 상자를 갈라 각각 명시한다:
//   · 정책 = 이 폼의 필드라 아래 [저장] 을 눌러야 반영.
//   · 예외 = 별개 객체(org_asset_pref)라 버튼 클릭 즉시 반영.
//  그래서 정책만 고치고 저장 안 한 동안 아래 표의 실효 상태는 **옛 정책 기준**이다 — 그 사실을 배지로 알린다.
//
//  실효 상태는 서버가 SoT(src/org/asset-visibility.ts)로 계산해 준 값만 그린다. 여기서 재계산하면 그 파일이
//  "세 곳이 똑같이 구현한다 — 드리프트 금지"라고 못박은 규칙의 4번째 사본이 된다(web/ 는 src/ 를 import 못 함).
//  저장 후엔 호출부가 rerenderPanel 로 폼을 통째로 다시 그리므로, 저장본 반영은 재생성이 담당한다.
function targetMembersField(targetKind, item, isNew) {
  const refId = item.id;
  const modeOf = (enabled, targets) => (enabled === false ? 'off' : (targets && targets.length ? 'some' : 'all'));
  let mode = modeOf(item.enabled, item.target_members);
  const saved = { mode, targets: (item.target_members || []).join(', ') }; // 마지막 저장본 — 표가 '저장 전'인지 판정

  const MODES = [
    ['all', '전원 켬', '지금 있는 구성원과 **앞으로 합류할 구성원**까지 전원에게 갑니다. 개인별 예외는 아래 표에서.'],
    ['off', '전원 끔', '전원에게 차단됩니다 — **아래 개인 예외도 이걸 못 이깁니다**(마스터 스위치).'],
    ['some', '지정한 사람만', '적은 구성원에게만 갑니다. 목록에 없으면 기본값이 «끔» 이고, **나중에 합류하는 구성원도 자동 제외**됩니다.'],
  ];
  const targetIn = el('input', { type: 'text', value: saved.targets, placeholder: '구성원 id 쉼표구분 (예: yoon, jang)' });
  const targetsNow = () => targetIn.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const enabledNow = () => mode !== 'off';
  // 'some' 인데 목록이 비면 서버는 그걸 '전원'으로 읽는다(target_members NULL/빈=전원) — 화면과 어긋나므로 저장 시 막는다.
  //  '전원 끔'은 target_members 를 **안 보낸다**(undefined=보존) — 마스터킬은 타깃팅과 직교하므로, 잠깐 껐다 켜는 동안
  //  애써 지정해 둔 명단을 날리면 안 된다(구 UI 는 [활성] 체크박스와 명단이 별개 필드라 보존됐다 — 그 계약 유지).
  const targetsPayload = () => {
    if (mode === 'off') return undefined;                       // 보존
    if (mode === 'all') return null;                            // 전원 = 명단 비움
    return targetsNow().length ? targetsNow() : null;
  };

  const segBar = el('div', { class: 'tm-seg' });
  const modeHint = el('p', { class: 'tm-hint' });
  const targetRow = el('div', { class: 'field', style: 'margin:10px 0 0' },
    el('label', { class: 'field-label', text: '대상 구성원 id' }), targetIn);
  const staleNote = el('div', { class: 'tm-stale' });
  const countEl = el('span', { class: 'tm-count' });
  const openBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '구성원별 조정…' });
  const clearBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '전체 기본값 복귀' });

  let rows: any[] = [];   // 서버가 준 구성원별 상태(정책 기본값·오버라이드·실효)
  let listHost: any = null; // 모달이 열려 있는 동안의 행 컨테이너(닫히면 isConnected=false → 자동 폐기)
  const dirty = () => mode !== saved.mode || (mode === 'some' && targetIn.value.trim() !== saved.targets);

  const paintPolicy = () => {
    for (const b of segBar.children as any) {
      b.classList.toggle('on', b.dataset.m === mode);
      b.setAttribute('aria-pressed', String(b.dataset.m === mode));
    }
    modeHint.replaceChildren(...uiText((MODES.find((m) => m[0] === mode) as any)[2]));
    targetRow.style.display = mode === 'some' ? '' : 'none';
    staleNote.replaceChildren(...uiText(dirty() ? '정책을 바꿨습니다 — [저장] 해야 구성원별 실효 상태에 반영됩니다.' : ''));
    staleNote.style.display = dirty() ? '' : 'none';
    if (listHost?.isConnected) listHost.classList.toggle('tm-list-stale', dirty());
  };
  for (const [m, label] of MODES) {
    const b = el('button', { type: 'button', class: 'tm-seg-btn', text: label });
    b.dataset.m = m;
    b.addEventListener('click', () => { mode = m; paintPolicy(); });
    segBar.append(b);
  }
  segBar.setAttribute('role', 'group');
  targetIn.addEventListener('input', paintPolicy);

  // 구성원별 예외 — 서버(/api/ui/org/asset-members)가 SoT 로 계산한 byDefault·override·effective 를 그대로 그린다.
  //  seq: 버튼을 빠르게 여러 번 누르면 먼저 띄운 GET 이 나중에 도착해 표를 옛 상태로 덮을 수 있다 — 마지막 요청만 그린다.
  let seq = 0;
  const reload = async () => {
    const mine = ++seq;
    try {
      const d: any = await api(`/api/ui/org/asset-members?target_kind=${encodeURIComponent(targetKind)}&ref_id=${encodeURIComponent(refId)}`);
      if (mine !== seq) return; // 더 최신 요청이 이미 떴다 — 이 응답은 버린다
      rows = d.members || [];
    } catch (e: any) {
      if (mine !== seq) return;
      countEl.textContent = '구성원 상태를 불러오지 못했습니다';
      openBtn.disabled = clearBtn.disabled = true;
      if (listHost?.isConnected) listHost.replaceChildren(errorNote(e, '구성원 상태를 불러오지 못했습니다'));
      return;
    }
    paintSummary();
    if (listHost?.isConnected) paintList();   // 모달이 열려 있으면 같이 갱신
  };
  // 폼에 남는 건 요약 한 줄뿐 — 구성원 42명을 폼에 깔면 [저장] 이 스크롤 저 아래로 밀린다.
  const paintSummary = () => {
    const exceptions = rows.filter((r) => r.override !== null).length;
    const inactive = rows.filter((r) => r.state !== 'active').length;
    countEl.textContent = `구성원 ${rows.length - inactive}명`
      + (inactive ? ` · 비활성 ${inactive}명` : '')
      + (exceptions ? ` · 예외 ${exceptions}명` : ' · 예외 없음');
    openBtn.disabled = !rows.length;
    clearBtn.disabled = !exceptions;
  };
  const paintList = () => {
    const q = String(searchIn?.value || '').trim().toLowerCase();
    const shown = rows.filter((r) => !q || r.id.toLowerCase().includes(q) || String(r.display_name || '').toLowerCase().includes(q));

    const node = (r) => {
      const dead = r.state !== 'active'; // 비활성 = 인증부터 막힌다 → 정책과 무관하게 아무것도 못 받는다
      const stateNow = r.override === null ? 'default' : (r.override ? 'on' : 'off');
      const seg = el('div', { class: 'tm-seg tm-seg-row', role: 'group' });
      for (const [v, label] of [['default', '기본' + (r.byDefault ? '(켬)' : '(끔)')], ['on', '켜기'], ['off', '끄기']]) {
        const on = stateNow === v;
        const b = el('button', { type: 'button', class: 'tm-seg-btn' + (on ? ' on' : ''), text: label, 'aria-pressed': String(on) });
        b.addEventListener('click', async () => {
          const body: any = { target_kind: targetKind, ref_id: refId, member_id: r.id };
          if (v === 'default') body.clear = true; else body.state = (v === 'on');
          try { await api('/api/ui/org/asset-pref', { method: 'POST', body: JSON.stringify(body) }); await reload(); }
          catch (e: any) { toast((e && e.message) || '실패', true); }
        });
        seg.append(b);
      }
      // 비활성이면 예외 설정은 남겨 둔다(복직 시 되살아나고, 지금 정리할 수도 있어야 하니) — 다만 '적용 중'이라고 말하지 않는다.
      const why = dead ? '비활성 구성원 — 접속 불가'
        : (r.override === null ? '정책 기본값' : (r.override ? '강제 켬 · 예외' : '강제 끔 · 예외'));
      return el('div', { class: 'tm-row' + (r.override !== null ? ' exc' : '') + (dead ? ' dead' : '') },
        el('div', { class: 'tm-who' },
          el('span', { class: 'tm-name', text: r.display_name || r.id }),
          el('span', { class: 'tm-id', text: r.id }),
          dead ? el('span', { class: 'pill', text: '비활성' }) : null,
          r.kind !== 'human' ? el('span', { class: 'pill', text: r.kind === 'agent' ? 'AI' : '시스템' }) : null),
        el('div', { class: 'tm-state' },
          el('span', { class: 'pill' + (r.effective ? ' tm-on' : ''), text: r.effective ? '적용 중' : '미적용' }),
          el('span', { class: 'tm-why', text: why })),
        seg);
    };
    listHost.replaceChildren(
      ...(shown.length ? shown.map(node) : [el('p', { class: 'admin-hint' }, ...uiText('검색 결과가 없습니다.'))]));
  };

  // 구성원별 예외는 **모달**로 — 폼에 인라인으로 깔면 구성원 수만큼 길어져(현재 42명) [저장] 이 화면 밖으로 밀린다.
  //  폼엔 요약 한 줄(구성원 N명 · 예외 M명)만 남기고, 조정이 필요할 때만 연다.
  let searchIn: any = null;
  const openModal = () => {
    searchIn = el('input', { type: 'search', class: 'tm-search', placeholder: '이름·id 검색', style: 'width:180px' });
    searchIn.addEventListener('input', () => { if (listHost?.isConnected) paintList(); });
    listHost = el('div', { class: 'tm-list' + (dirty() ? ' tm-list-stale' : '') });
    const note = dirty()
      ? el('div', { class: 'tm-stale', text: '정책이 저장 전입니다 — 아래 실효 상태는 아직 옛 정책 기준이에요.' }) : null;
    overlay(`구성원별 예외 — ${item.label || item.id}`,
      el('p', { class: 'admin-hint', style: 'margin:0 0 10px' },
        ...uiText('**클릭 즉시 반영**됩니다(구성원 다음 세션부터). 예외를 두지 않으면 위 정책 기본값을 따릅니다.')),
      el('div', { class: 'tm-members-head' }, searchIn,
        el('span', { class: 'tm-when', style: 'margin-left:auto', text: '클릭 즉시 반영' })),
      note, listHost);
    paintList();
  };
  openBtn.addEventListener('click', openModal);
  clearBtn.addEventListener('click', async () => {
    if (!confirm('이 스킬/훅의 구성원 예외를 전부 지울까요? 전원이 위 정책을 따르게 됩니다.')) return;
    try {
      const r: any = await api('/api/ui/org/asset-prefs/clear', { method: 'POST', body: JSON.stringify({ target_kind: targetKind, ref_id: refId }) });
      toast(`예외 ${r.cleared}건 해제됨`); await reload();
    } catch (e: any) { toast((e && e.message) || '실패', true); }
  });

  const membersCard = isNew
    ? el('p', { class: 'admin-hint', style: 'margin:10px 0 0' }, ...uiText('먼저 저장하면 구성원별로 예외(강제 켬/끔)를 둘 수 있어요.'))
    : el('div', { class: 'tm-members' }, countEl, openBtn, clearBtn);
  if (!isNew) { countEl.textContent = '불러오는 중…'; openBtn.disabled = clearBtn.disabled = true; void reload(); }

  paintPolicy();
  return {
    node: el('div', { class: 'tm' },
      el('div', { class: 'tm-policy' },
        el('div', { class: 'tm-members-head' }, el('b', { text: '전원 (정책 기본값)' }),
          el('span', { class: 'tm-when' }, ...uiText('[저장] 을 눌러야 반영'))),
        segBar, modeHint, targetRow),
      staleNote, membersCard),
    enabled: enabledNow,
    targetMembers: targetsPayload,
    // 'some' 인데 목록이 비었으면 저장 거부 — 서버가 빈 배열을 '전원'으로 읽어 화면과 정반대가 된다.
    validate: () => (mode === 'some' && !targetsNow().length ? '‘지정한 사람만’ 을 골랐으면 대상 구성원 id 를 하나 이상 적으세요 (비우면 전원이 됩니다).' : null),
  };
}

// MCP inputSchema(JSON Schema)의 properties → 필드 목록(이름:타입·필수여부·제약·설명). 하네스가 tools/list 에서 보는 입력 표면.
function mcpFieldsEl(schema) {
  const props = (schema && schema.properties) || {};
  const req = (schema && schema.required) || [];
  const keys = Object.keys(props);
  if (!keys.length) return el('div', { class: 'admin-hint' }, ...uiText('입력 필드 없음'));
  return el('ul', { style: 'margin:2px 0; padding-left:18px' }, ...keys.map((k) => {
    const p = props[k] || {};
    let t = p.type || (p.anyOf || p.oneOf ? 'union' : '?');
    if (p.enum) t = p.enum.join(' | ');
    const c: any[] = [];
    if (p.minLength != null) c.push('min ' + p.minLength);
    if (p.maxLength != null) c.push('max ' + p.maxLength);
    if (p.minimum != null) c.push('≥' + p.minimum);
    if (p.maximum != null) c.push('≤' + p.maximum);
    return el('li', {},
      el('code', { text: k }),
      el('span', { class: 'mini-meta', text: ' : ' + t + (req.includes(k) ? ' · 필수' : ' · 선택') + (c.length ? ' · ' + c.join(', ') : '') }),
      p.description ? el('div', { class: 'admin-hint', style: 'margin:0' }, ...uiText(p.description)) : null);
  }));
}

export {
  allowlistCard,
  fmtBytes,
  fmtElapsed,
  mcpFieldsEl,
  psBlock,
  psInputStyle,
  sectionHead,
  sectionTitle,
  segTabs,
  targetMembersField,
};

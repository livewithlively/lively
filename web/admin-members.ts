// admin-members.ts — 구성원 · 팀 · 조직 정보 · 접속 토큰 · AI 실행 계정 패널 (#1313 R39, admin.ts 에서 verbatim 분리).
//  ⚠ memberForm 이 서버와 맺은 계약 두 가지를 **그대로** 옮겼다. 손대지 마라:
//   ① scopes 보존 — 체크박스 목록(MEMBER_SCOPE_OPTS)에 없는 권한도 payload 에 실어 되돌려 보낸다.
//      목록이 서버 SCOPES 보다 좁아지는 순간, 안 보이던 권한이 저장 한 번에 조용히 드롭되기 때문이다.
//   ② identities 미전송 — 폼은 identities 를 **보내지 않는다**. 서버(org_member_upsert)가 undefined 를
//      '미변경'으로 읽어 보존한다. 외부 계정 연결의 편집 SoT 는 [외부 자료 수집 ▸ 멤버 매핑]이다(#837).
//  저장·제거 후 재렌더는 셸(admin.ts) 역호출이 아니라 R37 의 rerenderPanel 레지스트리를 경유한다(셸↔패널 순환 절단).
//  화면 간 선택·검색 상태(state.admin.memberSel·memberSearch·teamSel…)는 core 의 공유 state 에 있어 여기 모듈 전역이 없다.
import { api, busy, cardHead, el, errorNote, profileAvatar, state, toast, uiText } from './core.js';
import { copyButton, field, overlay, skeleton } from './ui-primitives.js';
import { loadAdmin, rerenderPanel } from './admin-rerender.js';

// ── 섹션(강제규칙·회사맥락) markdown 에디터 — 기본은 구성원에게 보이는 읽기 전용 뷰, 관리자는 [수정]을 눌러야 편집 ──
async function profilesEditor(detail) {
  const reload = () => profilesEditor(detail);
  busy(detail, el('div', { class: 'card' }, skeleton('프로필 상태를 불러오는 중')));
  let r;
  try { r = await api('/api/ui/terminal/profiles'); }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '프로필을 불러오지 못했습니다'))); return; }
  const profiles = r.profiles || [];
  const items = profiles.length ? profiles.map((p) => {
    // OS-유저 격리(#524) — 구성원별 OS 계정(box_<slug>, 홈700). secure-by-default: 인프라 설치된 박스에서 그 멤버가
    //  웹터미널 '첫 세션'을 열면 box_ 가 자동 생성(lazy)되고 그 세션부터 자기 계정으로 격리. 자격증명이 uid 로 상호열람 차단.
    //  #346 멀티프로필은 흡수됨(격리 시 네이티브 ~/.claude) → 프로필 버튼 없음. 아래는 상태 + (선택)미리생성/재프로비저닝.
    const os = p.os || {};
    const kids: any[] = [];
    const stateText = !os.ready ? '⚠ 격리 인프라 미설치 — 공유 계정으로 실행됩니다'
      : os.provisioned ? '🔒 격리됨: ' + (os.osUser || '') + ' ✓ · 세션 자동 격리'
        : '⏳ 첫 세션에 자동 격리 (' + (os.osUser || 'box_…') + ')';
    kids.push(el('div', {}, el('strong', { text: p.name }), el('span', { class: 'caption', text: '  ' + p.id + ' · ' + stateText })));
    // #2174: 종전엔 '관리 권한 포함' 체크박스로 프로비저닝 토큰에 admin/runtime 을 실을지 골랐다(#549). 그 방식은
    //  **켠 뒤에도 반영이 안 되는** 문제가 있었다 — 토큰은 발급 시점 scope 로 박제되는데 그 토큰은 박스 홈에 심긴
    //  것이라, 재프로비저닝이 그 파일까지 닿지 못하면 올린 권한이 영영 도달하지 않았다(2026-08-28 실측).
    //  이제 세션 토큰은 멤버 scope 를 그대로 따르므로 고를 것이 없다 — 여기서는 그 사실만 알린다.
    const hasCtrl = (p.scopes || []).some((s) => s === 'admin' || s === 'runtime');
    if (hasCtrl) {
      kids.push(el('p', { class: 'caption', style: 'margin:3px 0 7px' },
        el('span', { text: '이 구성원은 관리 권한(admin/runtime)이 있으므로, 이 계정으로 실행된 세션도 관리 탭 기능(구성원·토큰·훅·DB소스)을 MCP로 직접 다룹니다. 권한을 조정하면 실행 중인 세션에도 곧바로 반영되고, 변경 내역은 감사 로그에 AI 작업으로 기록됩니다.' })));
    }
    if (!os.ready) {
      // fix#59: 카드마다 반복되던 install-isolation.sh 캡션 제거 — 섹션 상단 안내에 이미 1회 서술됨.
    } else if (!os.provisioned) {
      // 자동이지만, 첫 세션 지연(수십초) 없이 미리 깔고 싶으면.
      kids.push(el('button', { class: 'btn btn-ghost btn-sm', text: '지금 미리 만들기', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '생성 중… (수십초)';
        try { await api('/api/ui/terminal/members/provision-os', { method: 'POST', body: JSON.stringify({ member: p.id }) }); toast('OS 격리 유저를 만들었습니다 — 이 멤버 세션이 본인 계정으로 격리됩니다.'); reload(); }
        catch (e) { btn.disabled = false; btn.textContent = '지금 미리 만들기'; toast('실패 — ' + e.message, true); }
      } }));
    } else {
      kids.push(el('button', { class: 'btn btn-ghost btn-sm', text: '재프로비저닝(격리·토큰 갱신)', onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = '갱신 중…';
        try { await api('/api/ui/terminal/members/provision-os', { method: 'POST', body: JSON.stringify({ member: p.id }) }); toast('재프로비저닝했습니다 — 로그인과 실행 중 세션은 그대로 유지됩니다.'); reload(); }
        catch (e) { btn.disabled = false; btn.textContent = '재프로비저닝(격리·토큰 갱신)'; toast('실패 — ' + e.message, true); }
      } }));
    }
    return el('div', { class: 'card' }, ...kids);
  }) : [el('p', { class: 'caption' }, ...uiText('구성원이 없습니다.'))];
  detail.replaceChildren(
    el('div', { class: 'card' },
      cardHead('AI 실행 계정 격리', '구성원마다 서버에 전용 OS 계정(box_<slug>, 홈 권한 700)이 만들어져 서로 완전히 분리됩니다. 구성원끼리는 Claude 자격증명(.credentials.json)을 열람할 수 없습니다. 격리 인프라(deploy/linux/install-isolation.sh)가 설치된 서버에서는 웹터미널 첫 세션을 열 때 전용 계정이 자동으로 만들어지고(별도 버튼 필요 없음), 그 세션부터 본인 Claude 로그인으로 실행됩니다. 아직 전용 계정이 없는 구성원은 기존과 같이 공유 계정으로 실행됩니다. 첫 세션 지연 없이 미리 만들려면 [지금 미리 만들기]를 누르고, 격리를 끄려면 게이트웨이 환경변수 LIVELY_MEMBER_ISOLATION=off 를 설정하세요.')),
    ...items);
}

// ── 구성원 관리(#613) — 3~40명 규모에서도 훑기 쉽게. 아바타 카드 '그리드'가 항상 전체 폭을 채우고
//  (세로로 죽 늘어지고 오른쪽이 비던 문제 해소), 카드를 누르면 상세/편집을 '모달 오버레이'로 띄운다
//  (#613 후속 — 옛 좌우 2단 collapse 가 어색하다는 피드백. 이 파일의 다른 표면(메모리 그리드·태스크 상세)과 동일한 그리드+팝업 패턴).
//  상단 검색으로 이름·이메일·아이디·종류를 실시간 필터 — 입력은 리스트 컨테이너만 다시 그려(renderRows) 포커스를 잃지 않는다.
function membersEditor(detail, data) {
  const canEdit = state.admin.canEdit;
  const members = data.members || [];

  // 한 구성원 카드 — 누르면 모달로 상세/편집을 연다(그리드는 그대로 유지).
  const memberRow = (m) => {
    const meta = canEdit
      ? (m.kind || 'human') + (m.email ? ' · ' + m.email : '')
      : (m.kind || 'human') + (m.state && m.state !== 'active' ? ' · ' + m.state : '');
    return el('div', { class: 'mini-row member-row',
      onclick: () => openMemberModal(m, data, detail) },
      profileAvatar(m.avatar || null, m.display_name || m.id, m.id, 'member-ava', { char: m.avatar_char, color: m.avatar_color }),
      el('div', { class: 'member-row-body' },
        el('div', { class: 'mini-title' },
          el('span', { class: 'member-name', text: (m.display_name || m.id) }),
          canEdit ? (m.hasToken ? el('span', { class: 'pill pill-ok', text: '토큰 발급됨' }) : el('span', { class: 'pill', text: '토큰 미발급' })) : null),
        el('div', { class: 'mini-meta', text: meta, title: meta })));
  };

  // 리스트 영역 — 검색 시 이 컨테이너만 replaceChildren 해서 입력 포커스를 보존한다.
  const listCol = el('div', { class: 'admin-sublist admin-sublist-row' });
  const renderRows = () => {
    const q = (state.admin.memberSearch || '').trim().toLowerCase();
    const shown = q
      ? members.filter((m) => [m.display_name, m.id, m.email, m.kind].filter(Boolean).join(' ').toLowerCase().includes(q))
      : members;
    listCol.replaceChildren();
    if (!shown.length) {
      listCol.append(el('p', { class: 'admin-member-empty',
        text: members.length ? '‘' + (state.admin.memberSearch || '') + '’ 검색 결과가 없어요.' : '구성원이 없습니다.' }));
      return;
    }
    for (const m of shown) listCol.append(memberRow(m));
  };
  renderRows();

  const searchInp = el('input', { type: 'search', class: 'admin-member-search',
    value: state.admin.memberSearch || '', autocomplete: 'off', spellcheck: 'false', 'aria-label': '구성원 검색',
    placeholder: '이름·이메일·아이디로 검색  (총 ' + members.length + '명)',
    oninput: (e) => { state.admin.memberSearch = e.target.value; renderRows(); } });
  // ＋ 추가 — 구 [구성원 추가] 탭을 대신한다(#837). 다른 모든 목록 화면과 같은 관례(＋ 버튼 → 폼)로 통일.
  //  구 탭은 저장 후 location.hash 로 [토큰] 탭에 점프하고 state.admin.memberAddPreselect 로 선택을 실어 날랐다.
  //  이제 같은 화면 안이라 그냥 서브탭을 넘기면 된다 — 전역 상태로 탭 사이를 꿰맬 이유가 없다.
  // ＋ 추가 버튼은 [구성원 추가] 화면으로 옮겼다(#1085) — 여기 명부는 '보고 고치는 곳'이다.
  const addBtn = canEdit ? el('button', { class: 'btn btn-ghost btn-sm', text: '구성원 추가 →',
    onclick: () => { location.hash = '#/system/member-add'; } }) : null;
  const bar = el('div', { class: 'admin-member-searchbar' }, members.length ? searchInp : el('span', {}), addBtn);

  detail.replaceChildren(el('div', { class: 'card' },
    cardHead('구성원 목록'),
    (members.length || canEdit) ? bar : null,
    listCol));
}

// ── 구성원 상세/편집 모달(#613 후속) — 카드 클릭 시 그리드 위에 오버레이로 띄운다.
//  2단 collapse 대신 모달: 그리드 맥락을 유지한 채 상세를 보고, 닫으면 그리드로 복귀.
//  보기(memberRead) ↔ 편집(memberForm) 을 모달 안에서 토글하고, 저장/제거 시 모달을 닫고 그리드를 새로고침.
//  m === null 이면 **신규 등록**(구 [구성원 추가] 탭 대체, #837). 등록 뒤엔 곧바로 [접속 열쇠] 탭으로 넘겨
//  발급까지 이어지게 한다 — 구조는 같지만 이제 같은 화면 안이라 전역 상태를 거치지 않는다.
function openMemberModal(m, data, detail) {
  const isNew = !m;
  const body = el('div', { class: 'member-modal-body' });
  let back: any = null;
  let editing = isNew;
  const refreshGrid = () => rerenderPanel(detail, 'members-list', state.admin.data);
  const closeModal = () => { if (back) { back.remove(); back = null; } };
  const blank = { id: '', kind: 'human', display_name: '', email: '', identities: [], body_md: '', state: 'active', scopes: ['items', 'context'] };
  const rerender = () => {
    if (isNew) {
      memberForm(body, blank, data, detail, true, {
        saveLabel: '구성원 등록', showCancel: false, showRemove: false,
        onSaved: () => {
          toast('구성원 등록됨 — 접속 토큰을 발급해 전달하세요');
          closeModal();
          // 같은 화면의 [접속 열쇠] 서브탭으로 전환하고 섹션을 다시 그린다(구 location.hash 점프 + preselect 해킹 제거).
          state.admin.tab = state.admin.tab || {};
          state.admin.tab['members'] = 'tokens';
          rerenderPanel(detail.closest('.admin-body') || detail, 'members', state.admin.data);
        },
      });
      return;
    }
    // 저장/리로드 후 최신 멤버 객체를 다시 집는다(이름·권한 변경 반영).
    const cur = ((state.admin.data && state.admin.data.members) || []).find((x) => x.id === m.id) || m;
    if (state.admin.canEdit && editing) {
      memberForm(body, cur, data, detail, false, {
        onSaved: () => { toast('저장됨 — 신원 매칭에 즉시 반영됩니다'); closeModal(); refreshGrid(); },
        onCancel: () => { editing = false; rerender(); }, // 편집 취소 → 모달 안에서 보기로 복귀
        onRemoved: () => { closeModal(); refreshGrid(); },
      });
    } else {
      memberRead(body, cur, data, detail, { onEdit: () => { editing = true; rerender(); } });
    }
  };
  rerender();
  back = overlay(isNew ? '구성원 추가' : ('구성원 · ' + (m.display_name || m.id)), body);
}

// 구성원 권한(scope) 옵션 — 보기/편집 공유. 서버 SCOPES(capabilities/scopes.ts) 전체와 일치시킨다.
const MEMBER_SCOPE_OPTS = [
  ['items', '아이템 조회'], ['context', '컨텍스트'], ['memory', '지식·메모리'],
  ['db', 'DB 조회'], ['code', '코드 도구'],
  ['admin', '관리자(편집·적용)'], ['runtime', '런타임(훅·툴 정의)'],
];

const MEMBER_SCOPE_LABEL = Object.fromEntries(MEMBER_SCOPE_OPTS);

// 멤버 계정 발급/재설정 시 — 로그인 주소·이메일·임시 비번을 1회 표시(관리자가 1:1 전달). overlay 재사용.
function showInitialAccount(id, name, email, password, data) {
  const gw = ((data && data.profile && data.profile.gateway_url) || location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
  const webUrl = gw + '/ui/';
  const dn = name || id;
  overlay('로그인 계정 · ' + dn,
    el('p', { class: 'admin-hint', text: dn + ' 님의 로그인 계정 정보예요. 아래를 1:1로(슬랙·메신저 DM 등) 전달하세요 — 비밀번호는 지금만 보입니다.' }),
    field('로그인 주소', el('div', { class: 'admin-ro', text: webUrl })),
    field('이메일 (로그인 아이디)', el('div', { class: 'admin-ro', text: email || '⚠ 이메일 미설정 — 멤버에 이메일을 넣어야 로그인됩니다' })),
    el('div', { class: 'deploy-head' }, el('span', { class: 'mini-meta' }, ...uiText('임시 비밀번호')), copyButton(() => password, '비밀번호 복사')),
    el('pre', { class: 'admin-preview', text: password }),
    el('p', { class: 'admin-hint' }, ...uiText('받은 분은 위 주소에서 이메일+비밀번호로 로그인 → 첫 로그인 시 새 비밀번호를 설정하게 됩니다 → [사용 가이드 › 시작하기]에서 [설치 명령 만들기]로 설치하면 됩니다.')));
}

// 외부 계정 연결(identities) 요약 — 읽기 전용 표시 + 매핑 화면 링크(#837).
//  identities 는 "이 슬랙 메시지 쓴 사람 = 우리 윤상민"을 AI 가 알아보는 근거다. 편집 SoT 는
//  [외부 자료 수집 ▸ 멤버 매핑] — 거기선 커넥터가 실제 사용자 목록을 줘서 드롭다운으로 고른다.
//  구성원 화면에서 손타이핑하게 두면 외부 id 를 어디서 찾는지도 모르고 오타가 조용히 매칭을 깨뜨린다.
function idnSummary(identities) {
  const wrap = el('div', { class: 'idn-wrap' });
  if (!identities.length) {
    wrap.append(el('p', { class: 'admin-hint', style: 'margin:0 0 6px' }, ...uiText('연결된 외부 계정이 없습니다.')));
  } else {
    for (const idn of identities) {
      wrap.append(el('div', { class: 'idn-row idn-ro' },
        el('span', { class: 'pill', text: idn.system }),
        el('span', { class: 'mini-title', text: idn.external_id }),
        idn.email ? el('span', { class: 'mini-meta' }, ...uiText(idn.email)) : null));
    }
  }
  wrap.append(el('div', { class: 'admin-actions' },
    el('a', { class: 'btn btn-ghost btn-sm', href: '#/system/connectors', text: '외부 자료 수집에서 매핑 →' }),
    el('span', { class: 'admin-hint', style: 'margin:0',
      text: '커넥터별 사용자 목록에서 골라 연결합니다 — 외부 ID를 직접 찾을 필요가 없어요.' })));
  return wrap;
}

// ── 구성원 보기 모드 — [수정]을 누르기 전 기본 화면. 폼이 아니라 읽기 전용 요약을 보여준다. ──
//  권한 있는 사람(canEdit)만 [수정] 버튼이 보이고, 누르면 편집모드로 전환(memberForm). 비-admin 은 버튼 없음.
function memberRead(root, m, data, detail, opts: any = {}) {
  const canEdit = state.admin.canEdit;
  const roRow = (label, value) => field(label, el('div', { class: 'admin-ro', text: value || '—' }));
  const kids = [
    el('div', { class: 'member-read-head' },
      el('h3', { text: m.display_name || m.id }),
      canEdit ? (m.hasToken ? el('span', { class: 'pill pill-ok', text: '토큰 발급됨' }) : el('span', { class: 'pill', text: '토큰 미발급' })) : null),
  ];
  if (canEdit) {
    const scopeText = (m.scopes || []).map((sk) => MEMBER_SCOPE_LABEL[sk] ? MEMBER_SCOPE_LABEL[sk] + ' (' + sk + ')' : sk).join(', ');
    kids.push(
      roRow('아이디', m.id),
      roRow('닉네임 (활동 로그 표시)', m.nickname),
      roRow('종류', m.kind || 'human'),
      roRow('대표 이메일', m.email),
      roRow('상태', (m.state || 'active') === 'active' ? '활성' : '비활성'),
      roRow('권한 (이 구성원 토큰의 scope)', scopeText),
      field('외부 계정 연결 (신원 매칭 키)', idnSummary(m.identities || [])),
      field('개인 레이어', el('div', { class: 'admin-ro admin-ro-pre', text: (m.body_md && m.body_md.trim()) || '—' })));
  } else {
    kids.push(el('div', { class: 'mini-meta', text: '종류: ' + (m.kind || 'human') + ' · 상태: ' + (m.state || 'active') }));
  }
  if (canEdit) {
    const acts = el('div', { class: 'admin-actions' },
      el('button', { class: 'btn btn-primary', text: '수정',
        // 모달에서 열렸으면 opts.onEdit 로 모달 안에서 폼으로 전환(전체 재렌더 대신). 기본은 기존 흐름.
        onclick: () => { if (opts.onEdit) { opts.onEdit(); return; } state.admin.memberEditing = true; rerenderPanel(detail, 'members-list', data); } }));
    if ((m.kind || 'human') === 'human') {
      acts.append(el('button', { class: 'btn btn-ghost', text: '비밀번호 재설정',
        onclick: async () => {
          if (!confirm(`'${m.display_name || m.id}' 님의 로그인 비밀번호를 임시 비번으로 재설정할까요?`)) return;
          try {
            const r = await api('/api/ui/org/member/reset-password', { method: 'POST', body: JSON.stringify({ id: m.id }) });
            showInitialAccount(m.id, m.display_name, m.email, r.password, data);
          } catch (e) { toast(e.message, true); }
        } }));
    }
    kids.push(acts);
  }
  root.replaceChildren(...kids);
}

// opts(선택): { saveLabel, onSaved(payload), showCancel(기본 true), onCancel, showRemove(기본 !isNew) }
//  기본 동작은 [구성원 관리] 섹션용(저장 후 보기 모드 복귀). [구성원 추가] 섹션이 onSaved 등으로 재정의해 재사용.
function memberForm(root, m, data, detail, isNew, opts: any = {}) {
  // 읽기 전용(비-admin): 폼 대신 요약(민감 필드는 서버가 이미 redact). (정상 흐름은 memberRead 가 처리 — 안전망.)
  if (!state.admin.canEdit) { memberRead(root, m, data, detail); return; }
  // 아이디 = 불변 내부키(토큰·세션·활동이력·프로젝트·감사가 참조 — 가변 이메일과 분리). 신규는 서버가 이메일에서
  //  자동·유니크 생성(폼에서 숨김 — 관리자 비관여). 기존 멤버는 표시만(변경 불가).
  const idIn = el('input', { type: 'text', value: m.id, placeholder: '아이디(영문/숫자)', disabled: '' });
  const nameIn = el('input', { type: 'text', value: m.display_name || '', placeholder: '표시 이름' });
  // 닉네임(#762) — 표시 이름과 별개, 활동 로그 등 캐주얼 표기용(비우면 이름 폴백). 개인 프로필 모달에만 있던 걸 관리자 편집에도(#1025).
  const nickIn = el('input', { type: 'text', value: m.nickname || '', placeholder: '닉네임 (비우면 표시 이름으로)' });
  const emailIn = el('input', { type: 'email', value: m.email || '', placeholder: '대표 이메일(로그인 아이디)' });
  const kindSel = el('select', {}, ...['human', 'agent', 'system'].map((k) => el('option', { value: k, text: k })));
  kindSel.value = m.kind || 'human';
  const stateSel = el('select', {}, ...['active', 'inactive'].map((k) => el('option', { value: k, text: k === 'active' ? '활성' : '비활성' })));
  stateSel.value = m.state || 'active';
  const bodyTa = el('textarea', { rows: '4', placeholder: '개인 레이어(역할/호칭/담당 — 선택)' });
  bodyTa.value = m.body_md || '';

  // 권한(scopes) — 이 구성원이 받는 토큰의 권한. 변경 시 활성 토큰에도 즉시 반영(서버).
  //  체크박스에 없는 권한은 저장 시 보존(아래 보존 로직이 안전망).
  const SCOPE_OPTS = MEMBER_SCOPE_OPTS;
  const scopeChks = {};
  const scopeWrap = el('div', { class: 'scope-wrap' });
  for (const [sk, label] of SCOPE_OPTS) {
    const chk = el('input', { type: 'checkbox' });
    chk.checked = (m.scopes || []).includes(sk);
    scopeChks[sk] = chk;
    scopeWrap.append(el('label', { class: 'admin-check scope-opt' }, chk, ' ' + label + ' (' + sk + ')'));
  }

  // 외부 계정 연결(identities) — **여기선 읽기 전용**(#837).
  //  예전엔 여기서 system·external_id 를 **손으로 타이핑**했다. 그런데 ClickUp 숫자 id 를 어디서 찾는지 알 길이
  //  없고, 시스템명 오타는 조용히 매칭 실패로 끝났다. 매핑의 편집 SoT 는 [외부 자료 수집 ▸ 멤버 매핑]이다 —
  //  거기선 커넥터가 실제 사용자 목록을 주므로 드롭다운으로 고르기만 하면 된다(오타 불가).
  //  ⚠ 저장 시 identities 를 **안 보낸다** → 서버가 보존한다(delivery.org_member_upsert: undefined 면 미변경).
  const idnWrap = idnSummary(m.identities || []);

  const saveBtn = el('button', { class: 'btn btn-primary', text: opts.saveLabel || (isNew ? '추가' : '저장') });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    const knownScopes = SCOPE_OPTS.map(([sk]) => sk);
    const payload = {
      // 신규는 아이디를 보내지 않는다 — 서버가 이메일/표시이름에서 불변 내부키를 자동·유니크 생성(관리자 비관여).
      id: isNew ? undefined : idIn.value.trim(), kind: kindSel.value, display_name: nameIn.value.trim(), nickname: nickIn.value.trim(),
      // identities 는 **보내지 않는다** — 서버가 보존하고, 편집은 [외부 자료 수집 ▸ 멤버 매핑]에서만 한다(#837).
      email: emailIn.value.trim(), body_md: bodyTa.value, state: stateSel.value,
      // 체크된 권한 + 체크박스에 없는 권한은 보존 — 목록 누락으로 권한이 조용히 드롭되는 것 방지(안전망).
      scopes: [...knownScopes.filter((sk) => scopeChks[sk].checked), ...(m.scopes || []).filter((sk) => !knownScopes.includes(sk))],
    };
    // 사람(human) 구성원은 이메일이 로그인 아이디 → 신규 등록 시 필수(있어야 로그인 계정·초기 비번 발급). agent/system 은 불요.
    if (isNew && kindSel.value === 'human' && !payload.email) { toast('이메일을 입력하세요 — 로그인 아이디예요', true); return; }
    saveBtn.disabled = true;
    try {
      const res = await api('/api/ui/org/member', { method: 'POST', body: JSON.stringify(payload) });
      const savedId = (res && res.member && res.member.id) || payload.id; // 서버가 자동 생성한 아이디 반영
      await loadAdmin(true);
      // 신규 human 멤버면 초기 비밀번호가 1회 반환됨 — 관리자에게 전달용으로 표시(이메일 필수라 항상 발급됨).
      if (res && res.initialPassword) showInitialAccount(savedId, payload.display_name, payload.email, res.initialPassword, data);
      if (opts.onSaved) { opts.onSaved({ ...payload, id: savedId }); return; }
      state.admin.memberSel = savedId;
      state.admin.memberEditing = false; // 저장 후 보기 모드로 복귀
      toast('저장됨 — 신원 매칭에 즉시 반영됩니다');
      rerenderPanel(detail, 'members-list', state.admin.data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });

  const actions = el('div', { class: 'admin-actions' }, saveBtn);
  // 취소 — 편집을 버리고 보기 모드로(신규는 선택 해제). opts.showCancel=false 면 숨김.
  if (opts.showCancel !== false) {
    actions.append(el('button', { class: 'btn btn-ghost', text: '취소',
      onclick: () => {
        if (opts.onCancel) { opts.onCancel(); return; }
        state.admin.memberEditing = false;
        if (isNew) state.admin.memberSel = null;
        rerenderPanel(detail, 'members-list', data);
      } }));
  }
  actions.append(status);
  const showRemove = opts.showRemove !== undefined ? opts.showRemove : !isNew;
  if (showRemove) {
    // 토큰 발급은 [구성원 추가] 탭에서 — 여기(구성원 관리)선 신원/권한 편집만.
    actions.append(el('button', { class: 'btn-text', text: '제거',
      onclick: async () => {
        if (!confirm(`구성원 '${m.display_name || m.id}' 제거?`)) return;
        try { await api('/api/ui/org/member/remove', { method: 'POST', body: JSON.stringify({ id: m.id }) });
          await loadAdmin(true); toast('제거됨');
          // 모달에서 열렸으면 opts.onRemoved 로 모달 닫고 그리드 새로고침. 기본은 기존 흐름.
          if (opts.onRemoved) { opts.onRemoved(); return; }
          state.admin.memberSel = null; rerenderPanel(detail, 'members-list', state.admin.data); }
        catch (e) { toast(e.message, true); }
      } }));
  }

  root.replaceChildren(
    isNew ? el('span', { hidden: '' }, idIn) : field('아이디 (내부 식별자 · 변경 불가)', idIn), field('표시 이름', nameIn), field('닉네임 (활동 로그 등 표시 · 비우면 이름)', nickIn), field('종류', kindSel),
    field('대표 이메일', emailIn), field('상태', stateSel),
    field('권한 (이 구성원 토큰의 scope)', scopeWrap),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '외부 계정 연결 (신원 매칭 키)' }), idnWrap),
    field('개인 레이어', bodyTa),
    actions);
}


export {
  profilesEditor,
  membersEditor,
  openMemberModal,
  memberRead,
  memberForm,
};
export { teamsPanel } from './admin-teams.js';
export { profileEditor, tokensPanel } from './admin-tokens.js';

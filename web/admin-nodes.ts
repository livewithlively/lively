// admin-nodes.ts — 컴퓨터(노드) 관리 패널 **두 개**. 축이 다른 두 일을 한 화면에 두지 않는다:
//
//   ① [내 설정 ▸ 내 컴퓨터] (myNodesPanel)  — 전 구성원. "내가 연결한 컴퓨터를 내가 관리한다."
//   ② [운영·감사 ▸ 컴퓨터(노드)] (orgNodesPanel) — 관리자. "조직의 컴퓨터를 보고, 무엇을 함께 쓸지 정한다."
//
//  왜 갈랐나: 처음엔 한 섹션이었는데, 거기서 하는 일이 **개인 행위**(내 노트북 붙이기·끊기)와 **조직 정책**
//  (#1540 공유 지정 — 남의 컴퓨터를 전체에 여는 것)으로 갈린다. 둘을 한 화면에 두면 개인이 자기 컴퓨터를
//  관리하러 왔다가 관리자 기능을 보고, 관리자는 조직 현황을 보러 왔다가 개인 설정을 지난다. 사이드바 그룹이
//  이미 그 축을 갖고 있으므로(내 설정 / 운영·감사) 거기에 각각 얹는다.
//
//  ⚠ '노드가 무엇인가'·'연결하는 법'은 여기 두지 않는다 — 사용가이드(#/learn/docs/nodes)가 원고의 집이다.
//   설정 화면은 **지금 상태를 보고 바꾸는 곳**이고, 배우는 곳은 문서다. 두 곳에 같은 설명을 두면 갈라진다.
import { api, el, errorNote, state, toast } from './core.js';
import { confirmDialog, copyText, field, overlay, skeleton } from './ui-primitives.js';
import { psInputStyle, sectionHead } from './admin-widgets.js';

const GUIDE = '#/learn/docs/nodes';   // 사용가이드 '컴퓨터 연결(노드)' — 설명·연결 명령의 단일 출처

const meId = (): string => String((state.me && (state.me.userId || state.me.email)) || '');

// 연결 상태 배지 — 세 상태를 한 어휘로 고정한다. '연결 차단됨'은 사람이 끈 것이고 '꺼져 있음'은 그 컴퓨터가
//  안 켜져 있는 것 — 원인이 달라 사람이 할 일도 다르므로 문구를 나눈다.
function statusBadge(n) {
  if (n.enabled === false) return el('span', { class: 'tsess-badge danger', text: '연결 차단됨' });
  if (n.online) return el('span', { class: 'tsess-badge live', text: '연결됨' + (n.sessions ? ' · 세션 ' + n.sessions : '') });
  return el('span', { class: 'tsess-badge', text: '꺼져 있음' });
}

// 노드 한 행. acts 는 호출부가 정한다 — 같은 노드라도 '내 화면'과 '관리자 화면'에서 할 수 있는 일이 다르다.
function nodeRow(n, ownerLabel, acts) {
  const main = el('div', { class: 'wikicat-row-main' },
    el('span', { class: 'wikicat-name', text: n.name || n.id }),
    el('span', { class: 'wikicat-key mono', text: n.id }),
    n.shared ? el('span', { class: 'dm-tag', text: '공유' }) : null,
    ownerLabel ? el('span', { class: 'wikicat-should' },
      el('span', { class: 'wikicat-should-label', text: '연결한 사람' }), ownerLabel) : null,
  );
  return el('div', { class: 'wikicat-row' }, main, statusBadge(n), acts || null);
}

// 그룹(제목·개수·한 줄 설명 + 행들). 빈 그룹도 '사실 + 다음에 할 일'로 말한다.
function nodeGroup(title, hint, nodes, rowFn, empty) {
  const rows = el('div', { class: 'wikicat-rows' });
  if (!nodes.length) rows.append(el('div', { class: 'wikicat-empty' }, empty));
  else for (const n of nodes) rows.append(rowFn(n));
  return el('div', { class: 'wikicat-group' },
    el('div', { class: 'wikicat-grouphead' },
      el('span', { class: 'wikicat-grouptitle', text: title }),
      el('span', { class: 'wikicat-groupcount', text: String(nodes.length) + '대' })),
    hint ? el('p', { class: 'admin-hint', style: 'margin:-4px 0 8px' }, hint) : null,
    rows);
}

// 노드 목록 — 두 API 를 합친다. 기본 목록은 '내가 관리하는 것'(admin 이면 전체), usable=1 은 '내가 쓸 수 있는 것'
//  (내 것 ∪ 공유). 기본만 쓰면 비관리자에게 공유 컴퓨터가 안 보이고, usable 만 쓰면 내가 **차단해 둔 내 컴퓨터가
//  사라져** 다시 켤 방법이 없어진다(usable 은 enabled 만 준다).
async function loadNodes() {
  const [own, usable] = await Promise.all([api('/api/ui/nodes'), api('/api/ui/nodes?usable=1')]);
  const byId = new Map();
  for (const n of [...((own && own.nodes) || []), ...((usable && usable.nodes) || [])]) byId.set(n.id, n);
  return [...byId.values()];
}

// 노드에 거는 동작들 — 두 패널이 같은 것을 쓴다(문구·확인 규칙이 화면마다 달라지면 사용자가 헷갈린다).
//  확인(confirmDialog)은 **넓히는 방향·되돌리기 어려운 것에만** 받는다: 공유 켜기·열쇠 재발급·지우기.
//  공유 해제·연결 차단은 좁히는 방향이라 즉시 적용한다.
function nodeActions(reload) {
  return {
    // 공유 **해제**만 있다(#1558) — 이미 있는 컴퓨터를 공유로 올리는 경로는 서버에도 없다. 공유 컴퓨터는
    //  처음부터 그 목적으로 등록한다(openSharedNodeForm). 해제는 좁히는 방향이라 확인 없이 즉시.
    async unshare(n) {
      try {
        await api('/api/ui/nodes/' + encodeURIComponent(n.id) + '/share', { method: 'POST', body: JSON.stringify({ shared: false }) });
        toast('공유를 해제했습니다 — 이제 등록한 사람만 씁니다');
        reload();
      } catch (e) { toast('변경 실패 — ' + e.message, true); }
    },
    async setEnabled(n, on) {
      try {
        await api('/api/ui/nodes/' + encodeURIComponent(n.id) + '/enable', { method: 'POST', body: JSON.stringify({ enabled: on }) });
        toast(on ? '연결을 다시 허용했습니다' : '연결을 차단했습니다');
        reload();
      } catch (e) { toast('변경 실패 — ' + e.message, true); }
    },
    async rotate(n) {
      const ok = await confirmDialog({
        title: '접속 열쇠를 다시 발급할까요?',
        message: (n.name || n.id) + ' 의 현재 열쇠가 즉시 무효가 됩니다.',
        lines: ['그 컴퓨터에서 lively node --daemon 을 다시 실행해야 연결이 돌아옵니다.'],
        note: '열쇠가 유출됐을 때 쓰는 기능입니다.',
        confirmText: '다시 발급',
      });
      if (!ok) return;
      try {
        await api('/api/ui/nodes/' + encodeURIComponent(n.id) + '/rotate', { method: 'POST', body: '{}' });
        toast('접속 열쇠를 다시 발급했습니다 — 그 컴퓨터에서 lively node --daemon 을 다시 실행하세요');
        reload();
      } catch (e) { toast('재발급 실패 — ' + e.message, true); }
    },
    async remove(n) {
      const ok = await confirmDialog({
        title: '이 컴퓨터를 목록에서 지울까요?',
        message: (n.name || n.id) + ' 의 연결을 끊고 등록을 지웁니다.',
        lines: ['그 컴퓨터의 파일은 아무것도 지우지 않습니다 — 라이블리와의 연결만 끊깁니다.'],
        note: '다시 붙이려면 그 컴퓨터에서 lively node --daemon 을 실행하면 됩니다.',
        confirmText: '지우기', danger: true,
      });
      if (!ok) return;
      try { await api('/api/ui/nodes/' + encodeURIComponent(n.id), { method: 'DELETE' }); toast('목록에서 지웠습니다'); reload(); }
      catch (e) { toast('삭제 실패 — ' + e.message, true); }
    },
  };
}

// 소유자 액션(공유 토글 제외) — 내 컴퓨터든 남의 컴퓨터든 '그 기계를 다루는' 일은 같다.
const ownerActs = (act, n) => el('div', { class: 'wikicat-row-acts' },
  el('button', { class: 'btn btn-ghost btn-sm', text: n.enabled === false ? '연결 허용' : '연결 차단',
    title: n.enabled === false ? '이 컴퓨터가 다시 연결되도록 허용합니다.' : '이 컴퓨터의 연결을 막습니다(작업은 못 들어오고, 등록은 남습니다).',
    onclick: () => act.setEnabled(n, n.enabled === false) }),
  el('button', { class: 'btn btn-ghost btn-sm', text: '접속 열쇠 재발급', onclick: () => act.rotate(n) }),
  el('button', { class: 'btn btn-ghost btn-sm', text: '지우기', onclick: () => act.remove(n) }));

// 사용가이드로 보내는 한 줄 — 설명은 문서가 갖고, 화면은 링크만 준다.
const guideLine = (text) => el('p', { class: 'admin-hint' },
  document.createTextNode(text + ' '),
  el('a', { href: GUIDE, text: '사용가이드에서 연결하는 법 보기 →' }));

// ─────────────────────────────────────────────────────────────────────────────
// ① [내 설정 ▸ 내 컴퓨터] — 전 구성원. 관리자 전용이 아니다: 자기 컴퓨터를 연결하고 관리하는 건 누구나 하는 일이다.
//   공유 토글은 여기 없다(#1540: 개방은 조직의 결정 = 관리자 몫). 내 컴퓨터가 공유로 지정돼 있으면 배지로 알린다.
// ─────────────────────────────────────────────────────────────────────────────
export async function myNodesPanel(detail, data) {
  const me = meId();
  const reload = () => myNodesPanel(detail, data);
  const act = nodeActions(reload);
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('연결된 컴퓨터를 불러오는 중')));

  let nodes;
  try { nodes = await loadNodes(); }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '연결된 컴퓨터를 불러오지 못했습니다'))); return; }

  const mine = nodes.filter((n) => n.owner_member === me);
  const sharedOthers = nodes.filter((n) => n.owner_member !== me && n.shared);
  const sharedMine = mine.filter((n) => n.shared).length;

  detail.replaceChildren(...[
    sectionHead('내 컴퓨터 · ' + mine.length + '대',
      '내 노트북이나 서버를 라이블리에 연결하면, 웹에서 그 컴퓨터의 AI 세션을 열고 오래 걸리는 작업을 맡길 수 있습니다.'),
    el('div', { class: 'card' }, ...[
      el('div', { class: 'wikicat' }, ...[
        nodeGroup('내가 연결한 컴퓨터', '기본적으로 나만 쓸 수 있습니다.',
          mine, (n) => nodeRow(n, null, ownerActs(act, n)),
          el('span', {}, document.createTextNode('아직 연결한 컴퓨터가 없습니다 — '),
            el('a', { href: GUIDE, text: '연결하는 법을 보세요' }), document.createTextNode('.'))),
        nodeGroup('함께 쓸 수 있는 공유 컴퓨터', '관리자가 조직 전체에 열어 둔 컴퓨터입니다. 여기에도 작업을 맡길 수 있습니다.',
          sharedOthers, (n) => nodeRow(n, null, null),
          '아직 공유로 지정된 컴퓨터가 없습니다.'),
      ]),
      // 내 컴퓨터가 공유로 지정돼 있으면 반드시 알린다 — 내 기계에서 남의 작업이 도는 상태이므로.
      // 내 목록에 공유 컴퓨터가 섞여 있으면 반드시 알린다 — 내 이름으로 등록돼 있지만 남의 작업이 도는 기계다.
      //  (공유 컴퓨터는 관리자가 등록하므로 보통 그 관리자 본인의 목록에 뜬다. 예전에 승격됐던 노드도 여기 걸린다.)
      sharedMine ? el('p', { class: 'admin-hint' },
        document.createTextNode('내 목록 중 ' + sharedMine + '대가 공유 컴퓨터입니다 — 구성원 누구나 그 컴퓨터를 씁니다. 공유 해제는 '),
        el('a', { href: '#/system/nodes', text: '설정 ▸ 컴퓨터(노드)' }),
        document.createTextNode(' 에서 합니다(관리자). 연결 차단·지우기는 여기서 직접 할 수 있습니다.')) : null,
      guideLine('컴퓨터를 새로 연결하려면 그 컴퓨터에서 명령 세 줄을 실행하면 됩니다.'),
    ].filter(Boolean)),
  ].filter(Boolean));
}

// 공유 컴퓨터 등록 폼 — **공유는 여기서만 켜진다.** 이미 붙어 있는 컴퓨터를 나중에 공유로 올리는 경로는 없다
//  (그러면 구성원 개인 노트북이 어느 날 조직 공용이 되고, 그걸 하려면 관리 화면이 남의 개인 컴퓨터를 늘어놔야
//  한다). 순서도 그래서 뒤집혀 있다 — **먼저 여기서 등록해 자리를 만들고**, 그 자리에 그 컴퓨터를 연결한다.
function openSharedNodeForm(reload) {
  const idInp = el('input', { type: 'text', style: psInputStyle, placeholder: 'build-server-1' });
  const nameInp = el('input', { type: 'text', style: psInputStyle, placeholder: '빌드 서버 1호' });
  const msg = el('p', { class: 'admin-hint' });
  const save = el('button', { class: 'btn btn-primary', text: '공유 컴퓨터로 등록' });
  const body = el('div', {},
    el('p', { class: 'admin-hint' },
      '여럿이 함께 쓸 컴퓨터의 자리를 먼저 만듭니다. 등록한 뒤 그 컴퓨터에서 연결 명령을 실행하면 목록에 나타납니다. '
      + '구성원 누구나 여기에 AI 세션을 열고 작업을 맡길 수 있게 되니, 개인 노트북이 아니라 공용 서버에만 쓰세요.'),
    field('아이디', idInp),
    el('p', { class: 'admin-hint', style: 'margin:-8px 0 12px' }, '영문 소문자·숫자·하이픈. 연결 명령에 그대로 들어갑니다.'),
    field('이름 (선택)', nameInp),
    msg);
  const back = overlay('공유 컴퓨터 등록', body, el('div', { class: 'admin-actions' }, save));

  save.onclick = async () => {
    const id = idInp.value.trim();
    if (!id) { msg.textContent = '아이디를 입력하세요.'; return; }
    save.disabled = true;
    try {
      const r = await api('/api/ui/nodes', { method: 'POST', body: JSON.stringify({ id, name: nameInp.value.trim() || id, shared: true }) });
      // 등록은 '자리'를 만든 것뿐 — 실제 연결은 그 컴퓨터에서 해야 한다. 그래서 폼을 닫지 않고 다음 할 일을 준다.
      //  접속 열쇠는 화면에 띄우지 않는다: 아래 명령이 관리자 로그인으로 자기 열쇠를 받아 간다(비밀을 눈에 안 띄우는 게 낫다).
      const cmd = 'lively login\nlively node --daemon --id ' + (r && r.node ? r.node.id : id);
      body.replaceChildren(
        el('p', { class: 'install-ok', text: '✓ 자리를 만들었습니다. 이제 그 컴퓨터에서 연결하세요.' }),
        el('p', { class: 'admin-hint' }, '공유할 컴퓨터에서 아래를 실행합니다(관리자 계정으로 로그인). 라이블리 CLI 가 아직 없다면 '),
        el('pre', { class: 'admin-preview', text: cmd }),
        el('div', { class: 'admin-actions' },
          el('button', { class: 'btn btn-primary', text: '명령 복사',
            onclick: async () => { const ok = await copyText(cmd); toast(ok ? '복사했습니다' : '복사 실패 — 직접 선택해 복사하세요', !ok); } }),
          el('button', { class: 'btn btn-ghost', text: '닫기', onclick: () => { back.remove(); reload(); } })),
        el('p', { class: 'admin-hint' }, 'CLI 설치가 아직이면 ', el('a', { href: '#/start', text: '시작하기' }),
          ' 의 한 줄 설치를 먼저 실행하세요. 연결되면 이 목록에 나타납니다.'));
      toast('공유 컴퓨터로 등록했습니다');
    } catch (e) { save.disabled = false; msg.textContent = '등록 실패 — ' + e.message; }
  };
  return back;
}

// ─────────────────────────────────────────────────────────────────────────────
// ② [운영·감사 ▸ 컴퓨터(노드)] — 관리자. **조직이 함께 쓰는 컴퓨터**만 다룬다.
//   ⚠ 구성원 개인 컴퓨터는 **여기 안 보인다.** 관리자가 볼 이유가 없기 때문이다 — 승격(남의 것을 공유로
//    올리기)이라는 동작 자체를 없앴으므로, 남의 개인 컴퓨터를 늘어놓을 목적이 사라졌다. 각자의 컴퓨터는
//    각자 [내 설정 ▸ 내 컴퓨터]에서 관리한다. ADMIN_ONLY 인 이유는 공유 컴퓨터를 만들고 없애는 화면이라서다.
// ─────────────────────────────────────────────────────────────────────────────
export async function orgNodesPanel(detail, data) {
  const reload = () => orgNodesPanel(detail, data);
  const act = nodeActions(reload);
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('공유 컴퓨터를 불러오는 중')));

  let nodes;
  try { const r = await api('/api/ui/nodes'); nodes = (r && r.nodes) || []; }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '공유 컴퓨터를 불러오지 못했습니다'))); return; }

  const memberName = (id) => {
    const m = ((data && data.members) || []).find((x) => x.id === id);
    return (m && (m.display_name || m.id)) || id || '알 수 없음';
  };
  const shared = nodes.filter((n) => n.shared);

  const adminActs = (n) => el('div', { class: 'wikicat-row-acts' },
    el('button', { class: 'btn btn-ghost btn-sm', text: n.enabled === false ? '연결 허용' : '연결 차단',
      title: n.enabled === false ? '이 컴퓨터가 다시 연결되도록 허용합니다.' : '이 컴퓨터의 연결을 막습니다(작업은 못 들어오고, 등록은 남습니다).',
      onclick: () => act.setEnabled(n, n.enabled === false) }),
    el('button', { class: 'btn btn-ghost btn-sm', text: '접속 열쇠 재발급', onclick: () => act.rotate(n) }),
    el('button', { class: 'btn btn-ghost btn-sm', text: '공유 해제',
      title: '공유를 거두고 등록한 사람 전용으로 되돌립니다. 다시 공유하려면 지우고 공유용으로 새로 등록하세요.',
      onclick: () => act.unshare(n) }),
    el('button', { class: 'btn btn-ghost btn-sm', text: '지우기', onclick: () => act.remove(n) }));

  detail.replaceChildren(...[
    sectionHead('컴퓨터(노드) · 공유 ' + shared.length + '대',
      '조직이 함께 쓰는 컴퓨터입니다. 구성원 누구나 여기에 AI 세션을 열고 오래 걸리는 작업을 맡길 수 있습니다.'),
    el('div', { class: 'admin-actions', style: 'margin:0 0 14px' },
      el('button', { class: 'btn btn-primary', text: '+ 공유 컴퓨터 등록', onclick: () => openSharedNodeForm(reload) })),
    el('div', { class: 'card' }, ...[
      el('div', { class: 'wikicat' },
        nodeGroup('공유 컴퓨터', null,
          shared, (n) => nodeRow(n, memberName(n.owner_member), adminActs(n)),
          '아직 공유 컴퓨터가 없습니다 — [+ 공유 컴퓨터 등록]으로 공용 서버의 자리를 먼저 만드세요.')),
      // 이 화면이 '조직 전체 컴퓨터 목록'이 아니라는 걸 분명히 한다 — 안 보이는 게 결함이 아니라 설계다.
      el('p', { class: 'admin-hint' },
        '구성원이 각자 연결한 개인 컴퓨터는 여기 보이지 않습니다. 그 컴퓨터들은 연결한 본인만 쓰고, 각자 [내 설정 ▸ 내 컴퓨터]에서 관리합니다. '
        + '이미 연결된 개인 컴퓨터를 공유로 올리는 기능은 없습니다 — 공유 컴퓨터는 위에서 그 목적으로 등록합니다.'),
      guideLine('구성원은 각자 자기 컴퓨터를 연결합니다.'),
    ].filter(Boolean)),
  ].filter(Boolean));
}

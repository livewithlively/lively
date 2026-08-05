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
import { confirmDialog, skeleton } from './ui-primitives.js';
import { sectionHead } from './admin-widgets.js';

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
    async setShared(n, on) {
      if (on) {
        const ok = await confirmDialog({
          title: '이 컴퓨터를 조직 전체에 열까요?',
          message: (n.name || n.id) + ' 를 공유 컴퓨터로 지정합니다.',
          lines: [
            '구성원 누구나 이 컴퓨터에서 AI 세션을 열고 작업을 맡길 수 있게 됩니다.',
            '즉 다른 사람이 이 컴퓨터에서 코드를 실행합니다 — 공용 서버에만 켜는 것을 권합니다.',
          ],
          note: '개인 노트북이라면 켜지 마세요. 나중에 언제든 공유를 해제할 수 있습니다.',
          confirmText: '공유로 지정',
        });
        if (!ok) return;
      }
      try {
        await api('/api/ui/nodes/' + encodeURIComponent(n.id) + '/share', { method: 'POST', body: JSON.stringify({ shared: on }) });
        toast(on ? '공유 컴퓨터로 지정했습니다' : '공유를 해제했습니다 — 이제 연결한 사람만 씁니다');
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
      sharedMine ? el('p', { class: 'admin-hint' },
        '내 컴퓨터 중 ' + sharedMine + '대가 공유로 지정돼 있습니다 — 구성원 누구나 그 컴퓨터를 씁니다. '
        + '공유를 해제하려면 관리자에게 요청하세요(연결 차단·지우기는 직접 할 수 있습니다).') : null,
      guideLine('컴퓨터를 새로 연결하려면 그 컴퓨터에서 명령 세 줄을 실행하면 됩니다.'),
    ].filter(Boolean)),
  ].filter(Boolean));
}

// ─────────────────────────────────────────────────────────────────────────────
// ② [운영·감사 ▸ 컴퓨터(노드)] — 관리자. 조직의 컴퓨터 전체를 보고 **무엇을 함께 쓸지** 정한다.
//   개인 컴퓨터 목록이 그대로 보이므로 관리자 전용(ADMIN_ONLY)이다.
// ─────────────────────────────────────────────────────────────────────────────
export async function orgNodesPanel(detail, data) {
  const reload = () => orgNodesPanel(detail, data);
  const act = nodeActions(reload);
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('조직의 컴퓨터를 불러오는 중')));

  let nodes;
  try { const r = await api('/api/ui/nodes'); nodes = (r && r.nodes) || []; }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '조직의 컴퓨터를 불러오지 못했습니다'))); return; }

  const memberName = (id) => {
    const m = ((data && data.members) || []).find((x) => x.id === id);
    return (m && (m.display_name || m.id)) || id || '알 수 없음';
  };
  const shared = nodes.filter((n) => n.shared);
  const personal = nodes.filter((n) => !n.shared);

  const adminActs = (n) => el('div', { class: 'wikicat-row-acts' },
    el('button', { class: 'btn btn-ghost btn-sm', text: n.shared ? '공유 해제' : '공유로 지정',
      title: n.shared ? '다시 연결한 사람만 쓰도록 되돌립니다.' : '조직 구성원 전체가 이 컴퓨터를 쓸 수 있게 합니다.',
      onclick: () => act.setShared(n, !n.shared) }),
    el('button', { class: 'btn btn-ghost btn-sm', text: n.enabled === false ? '연결 허용' : '연결 차단',
      onclick: () => act.setEnabled(n, n.enabled === false) }),
    el('button', { class: 'btn btn-ghost btn-sm', text: '접속 열쇠 재발급', onclick: () => act.rotate(n) }),
    el('button', { class: 'btn btn-ghost btn-sm', text: '지우기', onclick: () => act.remove(n) }));

  detail.replaceChildren(...[
    sectionHead('컴퓨터(노드) · ' + nodes.length + '대',
      '조직에 연결된 컴퓨터 전체입니다. 기본은 연결한 사람만 쓰고, 여기서 공유로 지정한 컴퓨터만 구성원 전체가 함께 씁니다.'),
    el('div', { class: 'card' }, ...[
      el('div', { class: 'wikicat' }, ...[
        nodeGroup('공유 컴퓨터', '구성원 누구나 여기에 AI 세션을 열고 작업을 맡길 수 있습니다.',
          shared, (n) => nodeRow(n, memberName(n.owner_member), adminActs(n)),
          '아직 공유로 지정된 컴퓨터가 없습니다 — 아래에서 공용 서버를 골라 [공유로 지정]하세요.'),
        nodeGroup('구성원 개인 컴퓨터', '연결한 본인만 씁니다. 공유로 지정하면 조직 전체가 그 컴퓨터에서 작업을 실행하게 되니, 개인 노트북은 그대로 두세요.',
          personal, (n) => nodeRow(n, memberName(n.owner_member), adminActs(n)),
          '연결된 개인 컴퓨터가 없습니다.'),
      ]),
      guideLine('구성원은 각자 자기 컴퓨터를 연결합니다.'),
    ].filter(Boolean)),
  ].filter(Boolean));
}

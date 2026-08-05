// admin-nodes.ts — 관리탭 [컴퓨터(노드)] 섹션.
//
//  왜 관리탭인가: 노드 관리는 원래 [AI세션] 탭의 [🖥 노드] 버튼 뒤에만 있었다. 그런데 거기서 하는 일이 두
//  종류로 갈린다 — **내 컴퓨터를 붙이는 것**(개인 행위)과 **어떤 컴퓨터를 조직 전체에 여는 것**(#1540 의
//  공유 지정 = 관리자 정책)이다. 뒤엣것은 "누가 누구 컴퓨터에서 코드를 돌릴 수 있나"를 정하는 조직 설정이라
//  세션 목록 옆 버튼이 제자리가 아니다(실제로 사용자가 관리탭에서 먼저 찾았다). 그래서 관리탭에 전체 그림을
//  두고, 세션 탭 모달은 그대로 남긴다(거기서 바로 붙이던 흐름을 끊지 않는다) — 데이터·API 는 같은 것 하나다.
//
//  이 화면의 목적 한 문장: **"어떤 컴퓨터가 연결돼 있고, 그중 무엇을 조직이 함께 쓰는지 알고 정한다."**
//  핵심 행동 1 = 내 컴퓨터 연결(명령 복사, 유일한 primary). 나머지(공유·차단·재발급·삭제)는 전부 보조.
//
//  ⚠ 처음 쓰는 사람 기준으로 쓴다 — '노드'라는 말을 모르는 사람이 이 화면만 읽고 "내 컴퓨터를 붙이면
//   웹에서 그 컴퓨터를 쓸 수 있고, 기본은 나만 쓴다"까지 이해해야 한다. 그래서 목록보다 설명이 먼저 온다.
import { api, el, errorNote, state, toast } from './core.js';
import { confirmDialog, copyText, skeleton } from './ui-primitives.js';
import { psBlock, sectionHead } from './admin-widgets.js';
const meId = () => String((state.me && (state.me.userId || state.me.email)) || '');
// 연결 상태 배지 — 세 상태를 한 어휘로 고정한다(연결됨/꺼져 있음/연결 차단됨).
//  '비활성'(enabled=false)은 사람이 끈 것이고 '꺼져 있음'은 그 컴퓨터가 안 켜져 있는 것 — 원인이 달라 문구를 나눈다.
function statusBadge(n) {
    if (n.enabled === false)
        return el('span', { class: 'tsess-badge danger', text: '연결 차단됨' });
    if (n.online)
        return el('span', { class: 'tsess-badge live', text: '연결됨' + (n.sessions ? ' · 세션 ' + n.sessions : '') });
    return el('span', { class: 'tsess-badge', text: '꺼져 있음' });
}
// 노드 한 행. acts 는 호출부가 그룹별로 정한다(내 것/공유/남의 것에서 할 수 있는 일이 다르다).
function nodeRow(n, ownerLabel, acts) {
    const main = el('div', { class: 'wikicat-row-main' }, el('span', { class: 'wikicat-name', text: n.name || n.id }), el('span', { class: 'wikicat-key mono', text: n.id }), n.shared ? el('span', { class: 'dm-tag', text: '공유' }) : null, ownerLabel ? el('span', { class: 'wikicat-should' }, el('span', { class: 'wikicat-should-label', text: '연결한 사람' }), ownerLabel) : null);
    return el('div', { class: 'wikicat-row' }, main, statusBadge(n), acts || null);
}
// 그룹(내 컴퓨터 / 조직 공유 / 다른 구성원) — 제목·개수·설명 한 줄 + 행들. 빈 그룹도 '사실 + 다음 행동'으로 말한다.
function nodeGroup(title, hint, nodes, rowFn, emptyText) {
    const rows = el('div', { class: 'wikicat-rows' });
    if (!nodes.length)
        rows.append(el('div', { class: 'wikicat-empty', text: emptyText }));
    else
        for (const n of nodes)
            rows.append(rowFn(n));
    return el('div', { class: 'wikicat-group' }, el('div', { class: 'wikicat-grouphead' }, el('span', { class: 'wikicat-grouptitle', text: title }), el('span', { class: 'wikicat-groupcount', text: String(nodes.length) + '대' })), hint ? el('p', { class: 'admin-hint', style: 'margin:-4px 0 8px' }, hint) : null, rows);
}
export async function nodesPanel(detail, data) {
    const admin = !!(data && data.canEdit);
    const me = meId();
    const reload = () => nodesPanel(detail, data);
    detail.replaceChildren(el('div', { class: 'card' }, skeleton('연결된 컴퓨터를 불러오는 중')));
    // 두 목록을 합친다 — 기본 목록은 '내가 관리하는 것'(관리자면 전체), usable=1 은 '내가 쓸 수 있는 것'
    //  (내 것 ∪ 공유). 비관리자에게도 **조직 공유 컴퓨터가 보여야** 이 화면이 정책을 설명할 수 있다.
    //  기본 목록만 쓰면 공유 컴퓨터가 안 보이고, usable 만 쓰면 내가 차단해 둔 내 컴퓨터가 사라진다(관리 불가).
    let nodes;
    try {
        const [own, usable] = await Promise.all([api('/api/ui/nodes'), api('/api/ui/nodes?usable=1')]);
        const byId = new Map();
        for (const n of [...((own && own.nodes) || []), ...((usable && usable.nodes) || [])])
            byId.set(n.id, n);
        nodes = [...byId.values()];
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '연결된 컴퓨터를 불러오지 못했습니다')));
        return;
    }
    const memberName = (id) => {
        const m = ((data && data.members) || []).find((x) => x.id === id);
        return (m && (m.display_name || m.id)) || id || '알 수 없음';
    };
    const mine = nodes.filter((n) => n.owner_member === me);
    const sharedOthers = nodes.filter((n) => n.owner_member !== me && n.shared);
    const privateOthers = nodes.filter((n) => n.owner_member !== me && !n.shared); // 관리자에게만 보인다
    // ── 액션 ──
    const setShared = async (n, on) => {
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
            if (!ok)
                return;
        }
        try {
            await api('/api/ui/nodes/' + encodeURIComponent(n.id) + '/share', { method: 'POST', body: JSON.stringify({ shared: on }) });
            toast(on ? '공유 컴퓨터로 지정했습니다' : '공유를 해제했습니다 — 이제 연결한 사람만 씁니다');
            reload();
        }
        catch (e) {
            toast('변경 실패 — ' + e.message, true);
        }
    };
    const setEnabled = async (n, on) => {
        try {
            await api('/api/ui/nodes/' + encodeURIComponent(n.id) + '/enable', { method: 'POST', body: JSON.stringify({ enabled: on }) });
            toast(on ? '연결을 다시 허용했습니다' : '연결을 차단했습니다');
            reload();
        }
        catch (e) {
            toast('변경 실패 — ' + e.message, true);
        }
    };
    const rotate = async (n) => {
        const ok = await confirmDialog({
            title: '접속 열쇠를 다시 발급할까요?',
            message: (n.name || n.id) + ' 의 현재 열쇠가 즉시 무효가 됩니다.',
            lines: ['그 컴퓨터에서 `lively node --daemon` 을 다시 실행해야 연결이 돌아옵니다.'],
            note: '열쇠가 유출됐을 때 쓰는 기능입니다.',
            confirmText: '다시 발급',
        });
        if (!ok)
            return;
        try {
            await api('/api/ui/nodes/' + encodeURIComponent(n.id) + '/rotate', { method: 'POST', body: '{}' });
            toast('접속 열쇠를 다시 발급했습니다 — 그 컴퓨터에서 lively node --daemon 을 다시 실행하세요');
            reload();
        }
        catch (e) {
            toast('재발급 실패 — ' + e.message, true);
        }
    };
    const remove = async (n) => {
        const ok = await confirmDialog({
            title: '이 컴퓨터를 목록에서 지울까요?',
            message: (n.name || n.id) + ' 의 연결을 끊고 등록을 지웁니다.',
            lines: ['그 컴퓨터의 파일은 아무것도 지우지 않습니다 — 라이블리와의 연결만 끊깁니다.'],
            note: '다시 붙이려면 그 컴퓨터에서 lively node --daemon 을 실행하면 됩니다.',
            confirmText: '지우기', danger: true,
        });
        if (!ok)
            return;
        try {
            await api('/api/ui/nodes/' + encodeURIComponent(n.id), { method: 'DELETE' });
            toast('목록에서 지웠습니다');
            reload();
        }
        catch (e) {
            toast('삭제 실패 — ' + e.message, true);
        }
    };
    const manageActs = (n) => el('div', { class: 'wikicat-row-acts' }, admin ? el('button', { class: 'btn btn-ghost btn-sm', text: n.shared ? '공유 해제' : '공유로 지정',
        title: n.shared ? '다시 연결한 사람만 쓰도록 되돌립니다.' : '조직 구성원 전체가 이 컴퓨터를 쓸 수 있게 합니다.',
        onclick: () => setShared(n, !n.shared) }) : null, el('button', { class: 'btn btn-ghost btn-sm', text: n.enabled === false ? '연결 허용' : '연결 차단',
        title: n.enabled === false ? '이 컴퓨터가 다시 연결되도록 허용합니다.' : '이 컴퓨터의 연결을 막습니다(작업은 못 들어오고, 등록은 남습니다).',
        onclick: () => setEnabled(n, n.enabled === false) }), el('button', { class: 'btn btn-ghost btn-sm', text: '접속 열쇠 재발급', onclick: () => rotate(n) }), el('button', { class: 'btn btn-ghost btn-sm', text: '지우기', onclick: () => remove(n) }));
    // 공유 컴퓨터는 '쓰는 사람'에겐 읽기 전용이다 — 남의 컴퓨터를 내가 차단·삭제할 수 없어야 한다.
    const sharedActs = (n) => (admin ? manageActs(n) : null);
    // ── 내 컴퓨터 연결하기 ──
    const cmd = 'curl -fsSL ' + location.origin + '/cli | sh\n'
        + 'lively login\n'
        + 'lively node --daemon        # 이 컴퓨터를 계속 연결해 둡니다';
    const connect = el('div', { class: 'card' }, psBlock('내 컴퓨터 연결하기', '연결할 컴퓨터(macOS·Linux)에서 아래 세 줄을 차례로 실행하세요. 설치가 끝나면 이 목록에 나타납니다.', el('div', {}, el('pre', { class: 'admin-preview', text: cmd }), el('div', { class: 'admin-actions' }, 
    // 이 화면의 primary CTA 는 여기 하나뿐이다 — 처음 온 사람이 할 일은 '내 컴퓨터 연결하기'이고,
    //  나머지(공유·차단·재발급·삭제)는 이미 연결한 뒤의 보조 행동이라 전부 ghost 로 둔다.
    //  copyButton 헬퍼는 ghost 고정이라 여기선 같은 동작을 primary 로 직접 만든다(문구·실패 처리는 동일).
    el('button', { class: 'btn btn-primary', text: '명령 복사',
        onclick: async () => {
            const ok = await copyText(cmd);
            toast(ok ? '복사했습니다 — 그 컴퓨터에 붙여넣어 실행하세요' : '복사 실패 — 명령을 직접 선택해 복사하세요', !ok);
        } }), el('span', { class: 'admin-hint', style: 'margin:0 0 0 10px' }, 'tmux 가 없으면 자동으로 설치합니다. 연결은 그 컴퓨터에서 라이블리 쪽으로만 나가므로 공유기·방화벽 설정은 필요하지 않습니다.')))));
    // ── 무엇인지 설명 (처음 쓰는 사람용) ──
    const explain = el('div', { class: 'card' }, psBlock('노드가 무엇인가요?', '라이블리에 연결한 컴퓨터를 노드라고 부릅니다. 내 노트북일 수도 있고, 팀이 함께 쓰는 서버일 수도 있습니다.', null), psBlock('연결하면 무엇을 할 수 있나요?', '첫째, 웹 브라우저에서 그 컴퓨터의 AI 세션을 열 수 있습니다 — 사무실 컴퓨터를 집에서 이어 쓰는 식입니다. '
        + '둘째, 오래 걸리는 작업(전체 빌드·대량 테스트 같은 것)을 그 컴퓨터에 맡길 수 있습니다. 맡긴 동안 내 컴퓨터는 느려지지 않습니다.', null), psBlock('누가 쓸 수 있나요?', '기본은 연결한 사람만 씁니다 — 남이 내 노트북에서 무언가를 실행할 수 없습니다. '
        + '여럿이 함께 쓰는 서버라면 관리자가 그 컴퓨터를 공유로 지정하고, 그때부터 조직 전체가 함께 씁니다.', null));
    detail.replaceChildren(...[
        sectionHead('컴퓨터(노드) · ' + nodes.length + '대', '라이블리에 연결한 컴퓨터를 보고 관리합니다. 연결하면 그 컴퓨터에서 AI 세션을 열고, 오래 걸리는 작업을 맡길 수 있습니다.'),
        el('div', { class: 'admin-stack' }, ...[
            explain,
            connect,
            el('div', { class: 'card' }, el('div', { class: 'wikicat' }, ...[
                nodeGroup('내 컴퓨터', '내가 연결한 컴퓨터입니다. 기본적으로 나만 쓸 수 있습니다.', mine, (n) => nodeRow(n, null, manageActs(n)), '아직 연결한 컴퓨터가 없습니다 — 위 세 줄을 그 컴퓨터에서 실행하면 여기에 나타납니다.'),
                nodeGroup('조직 공유 컴퓨터', '관리자가 공유로 지정해 구성원 누구나 쓸 수 있는 컴퓨터입니다.', sharedOthers, (n) => nodeRow(n, memberName(n.owner_member), sharedActs(n)), '아직 공유로 지정된 컴퓨터가 없습니다.'),
                admin ? nodeGroup('다른 구성원의 컴퓨터', '구성원이 각자 연결한 개인 컴퓨터입니다. 공유로 지정하기 전에는 연결한 본인만 씁니다.', privateOthers, (n) => nodeRow(n, memberName(n.owner_member), manageActs(n)), '다른 구성원이 연결한 컴퓨터가 없습니다.') : null,
            ].filter(Boolean))),
            admin ? null : el('p', { class: 'admin-hint' }, '공유 컴퓨터로 지정하는 것은 관리자만 할 수 있습니다 — 조직 전체가 쓸 컴퓨터가 필요하면 관리자에게 요청하세요.'),
        ].filter(Boolean)),
    ].filter(Boolean));
}

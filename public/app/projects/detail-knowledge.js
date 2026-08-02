// projects/detail-knowledge.ts — #1405 W2: detail-body.ts 분할 ③.
//  '지식 흐름' 섹션 — 이 프로젝트가 필요로 한 지식과 만들어 낸 지식(#245).
import { api, el, lifecycleDot, toast } from '../core.js';
import { knInjectChip, knProvChip } from '../wiki-data.js';
import { openKnowledgePicker } from './knowledge-picker.js';
function projectKnowledgeSection(id, p, reload) {
    const knName = (k) => k.name || k.knowledge_name;
    let cur = { required: (p.knowledge || {}).required || [], produced: (p.knowledge || {}).produced || [] };
    // 지식 링크는 새 탭(#804). 프로젝트 상세는 모달로도 뜨는데(pjvOpenProjectModal — 대시보드·보드 행 클릭),
    //  모달은 body 에 얹히고 라우터엔 모달 정리가 없어 같은 탭 해시 이동(#/k/…)이 **모달 뒤에서** 라우트만 바꾼다
    //  → 사용자 눈엔 '클릭해도 아무 일 없는' 죽은 클릭. 새 탭이면 프로젝트를 띄워 둔 채 지식을 읽는다(작업맥락 보존).
    //  지식 픽커(ps-kn-pick-main)가 이미 같은 규약이라 페이지에서도 동일하게 맞춘다.
    const KN_NEW_TAB = { target: '_blank', rel: 'noopener', title: '새 탭에서 지식 열기' };
    let remeasure = null; // 길이 초과 시 접기 컨트롤 재측정(접힘 박스 생성 후 할당). 리스트 변경마다 호출.
    const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
    // 연결 액션 — 섹션 우상단이 아니라 **필요 지식 칼럼 머리**에 둔다(#1133 피드백: 버튼이 연결 대상(필요지식 박스)과
    //  떨어져 있어 눈에 안 들어옴). 관계(필요/산출)는 여전히 픽커 라디오에서 고른다(#317 단일 픽커 유지).
    const knAddBtn = el('button', { class: 'btn btn-ghost btn-sm pjk-add-btn', type: 'button', text: '＋ 지식 연결', 'data-tour': 'pd-link-kn', // #853 '프로젝트 체험' 투어 앵커
        title: '관련 지식을 추천받고 검색해 연결 — 필요/산출은 픽커에서 선택(없으면 직접 작성)',
        onclick: () => openKnowledgePicker(id, 'required', { required: cur.required.map(knName), produced: cur.produced.map(knName) }, refresh) }); // 관계별 연결 상태(#1133)
    card.append(el('div', { class: 'card-head' }, el('div', { class: 'pjk-head-titles', style: 'display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; min-width:0;' }, el('h3', { text: '연결된 지식' }), el('span', { class: 'pjk-head-hint' }, '필요 지식을 연결하면 AI가 그 문서를 미리 읽은 상태로 시작해요 — ', 
    // 가이드도 새 탭(#804) — 지식 링크와 같은 이유(모달 뒤 라우트 변경 = 죽은 클릭) + 읽던 프로젝트를 잃지 않는다.
    //  목적지는 문서 사이트의 WIKI 페이지(#780) — 필요지식 카드가 그리로 이사했다.
    el('a', { href: '#/learn/docs/wiki?focus=required', target: '_blank', rel: 'noopener', title: '새 탭에서 사용 가이드 열기',
        style: 'color:var(--blue); text-decoration:none; white-space:nowrap;', text: '자세히' })))));
    const reqList = el('div', { class: 'pjk-list' });
    const prodList = el('div', { class: 'pjk-list' });
    const reqCount = el('span', { class: 'pjk-count' });
    const prodCount = el('span', { class: 'pjk-count' });
    // '왜 필요지식을 다나'는 닫는 배너 대신 섹션 제목 옆 부제로 이동(#317) — 위 card-head 의 pjk-head-hint + [자세히](→ learn 해당 섹션).
    // 필요지식 빈칸 — 죽은 끝('아직 없습니다') 대신 추천을 인라인으로 먼저(#317). 추천은 한 번만 불러 캐시(재페인트마다 호출 방지).
    let recsCache = null;
    async function fetchRecs() {
        if (recsCache)
            return recsCache;
        // 추천 2건(#1233-4) — 3건은 이 섹션 하나로 화면을 크게 먹었다. 연결은 초기 1회 작업이라 '고를 거리'만 있으면 되고,
        //  더 보고 싶으면 [＋ 지식 연결] 픽커가 전체를 보여준다.
        try {
            recsCache = await api('/api/ui/v6/projects/' + id + '/recommend-knowledge?limit=2').then((d) => (d && d.entries) || []);
        }
        catch (_) {
            recsCache = [];
        }
        return recsCache;
    }
    function recRow(m) {
        const name = knName(m);
        const pct = Math.round((Number(m.similarity) || 0) * 100);
        const addBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '연결' });
        addBtn.onclick = async () => {
            addBtn.disabled = true;
            try {
                await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name, relation: 'required' }) });
                toast('연결했습니다');
                refresh();
            }
            catch (e) {
                addBtn.disabled = false;
                toast('연결 실패 — ' + e.message, true);
            }
        };
        return el('div', { class: 'pjk-rec-row' }, el('a', { class: 'pjk-rec-title', href: '#/k/' + encodeURIComponent(name), ...KN_NEW_TAB, text: m.title || name }), m.shares_category ? el('span', { class: 'kn-chip', title: '프로젝트와 같은 분류', text: '📁' }) : null, pct > 0 ? el('span', { class: 'admin-hint pjk-rec-pct', title: '의미 유사도', text: pct + '%' }) : null, addBtn);
    }
    // 필요지식 칼럼 = 연결된 항목 + 아직 연결 안 된 추천을 **함께** 그린다(#138).
    //  하나 연결해도 나머지 추천은 그대로 남아 계속 추가 연결 가능(예전엔 첫 연결 순간 추천 목록이 통째로 사라짐).
    //  recsCache 는 최초 1회(연결 전) 목록이라, 이미 연결된 건 이름으로 걸러 낸다.
    let reqPaintSeq = 0;
    async function paintRequired(boxEl) {
        const seq = ++reqPaintSeq;
        const knRows = () => cur.required.map((k) => knRow(k, 'required'));
        if (!recsCache) { // 추천 로딩 전 — 연결된 건 바로 보이고, 추천 자리엔 로딩 문구.
            boxEl.replaceChildren(...knRows(), el('div', { class: 'pjk-empty', text: cur.required.length ? '관련 지식 더 찾는 중…' : '관련 지식을 찾는 중…' }));
        }
        const recs = await fetchRecs();
        if (seq !== reqPaintSeq)
            return; // 그 사이 다시 그려졌으면 폐기(레이스).
        const connected = new Set(cur.required.map(knName));
        const fresh = recs.filter((m) => !connected.has(knName(m))); // 이미 연결된 추천은 제외.
        // 기본 노출은 **2행까지**(#1233-4) — 이 섹션이 세로를 크게 먹어 아래 섹션들이 한눈에 안 들어왔다.
        //  추천은 '남은 자리'만 채운다: 연결이 늘수록 추천이 물러나므로 새 프로젝트에서도, 연결을 마친 뒤에도
        //  [더 보기] 없이 2행에서 끝난다. 더 고르고 싶으면 [＋ 지식 연결] 픽커가 전체 추천을 보여준다.
        const room = Math.max(0, 2 - cur.required.length);
        const show = fresh.slice(0, room);
        const children = knRows();
        if (show.length) {
            // 추천 머리글 삭제(#1233-4) — '이런 지식이 필요해 보여요' 는 한 줄을 통째로 먹으면서 정보가 없었다.
            //  추천행 자체가 [연결] 버튼을 달고 있어 무엇인지 이미 읽힌다.
            children.push(el('div', { class: 'pjk-rec' }, ...show.map(recRow)));
        }
        else if (!cur.required.length) {
            children.push(el('div', { class: 'pjk-empty' }, '아직 연결된 필요지식이 없어요. ', el('b', { text: '[＋ 지식 연결]' }), ' 로 시작하세요 — 찾는 게 없으면 거기서 직접 작성도 됩니다.'));
        }
        boxEl.replaceChildren(...children);
        if (remeasure)
            requestAnimationFrame(remeasure); // 내용이 바뀌었으니 접기 재측정.
    }
    // 지식 한 줄 — 제목(상세 링크) + 메타칩 + 연결 해제(✕). relation 별로 unlink 한다.
    function knRow(k, relation) {
        const name = knName(k);
        const r = el('div', { class: 'pjk-row' }, el('a', { class: 'pjk-row-title', href: '#/k/' + encodeURIComponent(name), ...KN_NEW_TAB, text: k.title || name }), el('div', { class: 'pjk-row-meta' }, 
        // 배지는 '예외만' 표시 — 기본값(검색=recalled·저작=authored·유효=active)은 매 행 똑같이 반복돼
        // 차별성 0 인 노이즈라 숨긴다. 벗어난 것만(주입·미러·폐기 등) 배지로 떠 제목 폭을 최대로 확보(#59 가독성).
        // 간격은 CSS gap — 예전 리터럴 공백(' '·'  ') span 래핑은 간격이 들쭉날쭉해 제거.
        (k.injection && k.injection !== 'recalled') ? knInjectChip(k.injection) : null, (k.provenance && k.provenance !== 'authored') ? knProvChip(k.provenance) : null, (k.lifecycle && k.lifecycle !== 'active') ? lifecycleDot(k.lifecycle) : null));
        const x = el('button', { class: 'pjk-row-x', type: 'button', title: '연결 해제', text: '✕' });
        x.onclick = async (ev) => {
            ev.preventDefault();
            try {
                await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name, relation, unlink: true }) });
                toast('연결을 해제했습니다');
                refresh();
            }
            catch (e) {
                toast('해제 실패 — ' + e.message, true);
            }
        };
        r.append(x);
        return r;
    }
    function paint(boxEl, list, relation, emptyText) {
        if (!list.length) {
            boxEl.replaceChildren(el('div', { class: 'pjk-empty', text: emptyText }));
            return;
        }
        boxEl.replaceChildren(...list.map((k) => knRow(k, relation)));
    }
    function repaint() {
        reqCount.textContent = String(cur.required.length);
        prodCount.textContent = String(cur.produced.length);
        paintRequired(reqList); // 연결된 항목 + 남은 추천을 함께(#138).
        paint(prodList, cur.produced, 'produced', '작업이 진행되면 여기에 쌓입니다 — 지금 비워둬도 괜찮아요.');
        if (remeasure)
            requestAnimationFrame(remeasure); // 내용이 바뀌면 접기 필요 여부 재판정.
    }
    async function refresh() {
        try {
            const d = await api('/api/ui/v6/projects/' + id).then((r) => r && (r.project || r));
            cur = { required: (d.knowledge || {}).required || [], produced: (d.knowledge || {}).produced || [] };
        }
        catch (_) { /* keep */ }
        repaint();
    }
    // (지식 연결 액션 = 필요 지식 칼럼 머리의 단일 버튼(위 knAddBtn) — #317 우상단 단일 버튼을 #1133 피드백으로 칼럼 안으로.)
    // 가운데 노드 — '이 프로젝트' 문구만(이름·상태 제거·박스 축소 #258). 좌우 화살표로 필요→프로젝트→산출 흐름을 표현.
    const node = el('div', { class: 'pjk-node' }, el('div', { class: 'pjk-node-label', text: '이 프로젝트' }));
    const reqCol = el('div', { class: 'pjk-col pjk-col-req' }, el('div', { class: 'pjk-col-head' }, el('span', { class: 'pjk-col-title', text: '필요 지식' }), reqCount, knAddBtn), // 버튼 = 칼럼 머리 우측(#1133)
    reqList);
    const prodCol = el('div', { class: 'pjk-col pjk-col-prod' }, el('div', { class: 'pjk-col-head' }, el('span', { class: 'pjk-col-title', text: '산출 지식' }), prodCount), prodList);
    const flow = el('div', { class: 'pjk-flow' }, reqCol, el('div', { class: 'pjk-arrow', 'aria-hidden': 'true', text: '→' }), node, el('div', { class: 'pjk-arrow', 'aria-hidden': 'true', text: '→' }), prodCol);
    // 길면(특정 높이 초과) 접기 — 본문 섹션과 동일한 펼침 알약(.proj-detail-body-expand). 짧으면 컨트롤 숨기고 펼쳐 둔다.
    const collapseBox = el('div', { class: 'pjk-collapse collapsed' }, flow);
    const exLbl = el('span', { class: 'lbl', text: '더 보기' });
    const exCaret = el('span', { class: 'caret', text: '⌄' });
    const exBtn = el('button', { class: 'proj-detail-body-expand', type: 'button' }, exLbl, exCaret);
    const exRow = el('div', { class: 'proj-detail-body-expand-row pjk-expand-row' }, exBtn);
    let userExpanded = false; // 사용자가 펼쳤는지 기억 — 재측정 후에도 상태 보존.
    const applyExpanded = (expanded) => {
        collapseBox.classList.toggle('collapsed', !expanded);
        exCaret.textContent = expanded ? '⌃' : '⌄';
        exLbl.textContent = expanded ? '접기' : '더 보기';
    };
    exBtn.onclick = () => { userExpanded = collapseBox.classList.contains('collapsed'); applyExpanded(userExpanded); };
    // 캡 높이로 강제해 넘치는지 측정 → 짧으면 컨트롤 숨기고 펼침, 길면 컨트롤 노출(사용자 펼침 상태 유지).
    remeasure = () => {
        collapseBox.classList.add('collapsed');
        const tall = flow.scrollHeight > collapseBox.clientHeight + 2;
        if (!tall) {
            collapseBox.classList.remove('collapsed');
            exRow.style.display = 'none';
            return;
        }
        exRow.style.display = '';
        applyExpanded(userExpanded);
    };
    card.append(collapseBox, exRow);
    repaint();
    return card;
}
export { projectKnowledgeSection };

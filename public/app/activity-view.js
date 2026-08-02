// activity-view.ts — 작업(activity) 표시 컴포넌트 3종의 소유 모듈(#1313 R49 에서 dashboard.ts 개명 —
//  '대시보드'라는 이름이 실체(작업 렌더러)와 어긋났고, 홈 대시보드인 dashboard-home.ts 와도 헷갈렸다).
//   · activityTimelineRow — 접힘/펼침 한 줄(목록용, 상세는 첫 펼침 때 lazy 생성)
//   · activityDetailView  — 유형 8종을 하나로 담는 상세 범용 템플릿(#852)
//   · activityHasDetail   — 펼칠 상세가 있는지의 단일 판정
//  소비자: 프로젝트 상세의 전체 작업 로그·작업 타임라인(projects/detail-sections.ts) ·
//   홈 대시보드의 팀 작업 로그 위젯(dash/widget-tasks-review-log.ts).
//  import 방향: core(프리미티브) ← 이 모듈. projects.ts 에서 fmtDateTime 하나를 되받는 역엣지가 남아 있다
//   (check-imports 의 ALLOWED_CYCLES 등재 — 그 심볼이 내려오면 사라진다). 새 역엣지를 늘리지 마라.
import { appUrl, ACTIVITY_TYPE_LABEL, REF_REL_LABEL, api, el, fmtNum, relTime, renderMarkdown } from './core.js';
import { fmtDateTime } from './projects.js';
// ════════════════════════════════════════════
// 유형별 점 색(스캔용 — §0.5: 채운 필 금지, 6px 점 + 무채 라벨). 성격축 8종(프로젝트 #182).
//  feature=민트, fix=코랄, decision=파랑, docs=틸, research=바이올렛, review=앰버, chore/other=중립.
const ACT_TYPE_TONE = { feature: 'mint', fix: 'coral', decision: 'blue', docs: 'teal', research: 'violet', review: 'amber', chore: 'muted', other: 'muted' };
function actTypeTag(type) {
    return el('span', { class: 'act-type tone-' + (ACT_TYPE_TONE[type] || 'muted') }, el('span', { class: 'act-type-dot', 'aria-hidden': 'true' }), ACTIVITY_TYPE_LABEL[type] || type);
}
// 펼칠(=보여 줄) 상세가 있는가 — 행의 캐럿 표시와 팝업의 '내용 없음' 안내를 가르는 하나의 기준.
function activityHasDetail(a) {
    return !!((a.title && a.title !== (a.summary || '')) || a.body || (a.tasks && a.tasks.length) || (a.refs && a.refs.length)
        || a.commit_sha || a.touchCount || a.external_url || a.session_id
        || (a.is_review && a.is_review !== 'na') || (a.should_review && a.should_review !== 'na'));
}
// ── 작업(activity) 상세 — 하나의 범용 템플릿(#852). 목록의 인라인 펼침과 단건 팝업이 **같은 함수**를 쓴다. ──
//  왜: 유형(기능·수정·결정·문서·리서치·검토·운영·기타)이 8가지인데 기록의 재료는 늘 같다 —
//  그래서 유형별 특수 서식 대신, 사람이 묻는 순서 하나로 모든 유형을 담는다:
//    ① 무엇을 했나(기술 제목) ② 자세히(본문) ③ 결과물(산출·참조 지식) ④ 어디에 반영됐나(과업·코드) ⑤ 언제
//  이전 문제 두 가지를 여기서 고친다:
//   · body 는 마크다운인데 raw 텍스트로 박혀 '## 제목'·'- 목록'이 글자 그대로 보였다 → renderMarkdown.
//   · 'should/is 점검: 해당 없음' 같은 내부 온톨로지 용어가 그대로 노출됐다 → 사람 말로, 바뀐 것만.
function activityDetailView(a, nameOf, opts) {
    const when = a.committed_at || a.created_at;
    const box = el('div', { class: 'act-doc' });
    // 머리(팝업 전용) — 목록 행은 이미 자기 헤드가 있어 생략한다.
    if (opts && opts.head) {
        box.append(el('div', { class: 'act-doc-head' }, el('div', { class: 'act-doc-titleline' }, actTypeTag(a.type), el('div', { class: 'act-doc-title', text: a.summary || a.title || '(제목 없음)' })), el('div', { class: 'act-doc-by' }, el('span', { class: 'act-doc-who', text: nameOf(a.author_person) || '미상' }), a.author_agent ? el('span', { class: 'act-doc-agent', text: a.author_agent }) : null, el('span', { class: 'act-doc-when', text: relTime(when) }))));
    }
    // 바로가기 — 이 작업을 한 터미널 세션(#852)·외부 원본. 세션 버튼은 입장 가능할 때만 비동기로 붙는다.
    const actions = el('div', { class: 'act-doc-actions' });
    if (a.external_url)
        actions.append(el('a', { class: 'btn btn-ghost btn-sm', href: a.external_url, target: '_blank', rel: 'noopener', text: '↗ 원본' }));
    box.append(actions);
    attachSessionButton(actions, a.session_id);
    const sec = (label, ...kids) => el('div', { class: 'act-doc-sec' }, el('div', { class: 'act-doc-label', text: label }), ...kids);
    // ① 무엇을 했나 — AI가 남긴 기술 상세 제목(겉의 쉬운 요약과 다를 때만 — 같으면 되풀이라 뺀다).
    if (a.title && a.title !== (a.summary || '')) {
        box.append(sec('무엇을 했나', el('div', { class: 'act-doc-what', text: a.title })));
    }
    // ② 자세히 — 본문은 마크다운이다. 반드시 렌더한다(raw 로 박으면 '## …' 가 글자로 보인다).
    if (a.body) {
        box.append(sec('자세히', el('div', { class: 'md-rendered act-doc-md' }, renderMarkdown(a.body))));
    }
    // ③ 결과물 — 이 작업이 만든/참고한/결정한 지식. 지식은 '읽고 돌아오는' 참조라 새 탭(#804·#811).
    if (a.refs && a.refs.length) {
        const KN_NEW_TAB = { target: '_blank', rel: 'noopener', title: '새 탭에서 지식 열기' };
        const byRel = {};
        for (const rf of a.refs)
            (byRel[rf.relation] = byRel[rf.relation] || []).push(rf);
        const REL_TEXT = { produced: '만든 것', references: '참고한 것', decided: '결정한 것' };
        const kids = [];
        for (const rel of ['produced', 'references', 'decided']) {
            if (!byRel[rel])
                continue;
            kids.push(el('div', { class: 'act-doc-refrow' }, el('span', { class: 'act-doc-rel', text: REL_TEXT[rel] || REF_REL_LABEL[rel] || rel }), el('span', { class: 'act-doc-links' }, ...byRel[rel].map((it) => el('a', { class: 'act-doc-link', href: '#/k/' + encodeURIComponent(it.name), ...KN_NEW_TAB, text: it.title || it.name })))));
        }
        box.append(sec('결과물', ...kids));
    }
    // ④ 어디에 반영됐나 — 과업(프로젝트)·코드(커밋). '과업'은 참조가 아니라 이동이라 같은 탭.
    const where = [];
    if (a.tasks && a.tasks.length) {
        where.push(el('div', { class: 'act-doc-refrow' }, el('span', { class: 'act-doc-rel', text: '과업' }), el('span', { class: 'act-doc-links' }, ...a.tasks.map((t) => el('a', { class: 'act-doc-link', href: '#/projects2/p/' + t.id, text: t.title || ('#' + t.id) })))));
    }
    if (a.commit_sha) {
        const bits = [a.repo, a.commit_sha.slice(0, 7), a.touchCount ? '코드 ' + fmtNum(a.touchCount) + '곳' : ''].filter(Boolean);
        where.push(el('div', { class: 'act-doc-refrow' }, el('span', { class: 'act-doc-rel', text: '코드' }), el('span', { class: 'act-doc-code mono', text: bits.join(' · ') })));
    }
    // 바뀐 것 — '점검했으나 변화 없음'은 굳이 알릴 게 아니다. **바뀐 것만** 사람 말로 띄운다.
    const changed = [];
    if (a.is_review === 'changed')
        changed.push('코드 구조가 바뀜');
    if (a.should_review === 'changed')
        changed.push('설계 의도가 바뀜');
    if (changed.length) {
        where.push(el('div', { class: 'act-doc-refrow' }, el('span', { class: 'act-doc-rel', text: '영향' }), el('span', { class: 'act-doc-chg', text: changed.join(' · ') })));
    }
    if (where.length)
        box.append(sec('어디에 반영됐나', ...where));
    // ⑤ 언제 — 커밋 시각이 있으면 그것, 없으면 기록 시각.
    box.append(el('div', { class: 'act-doc-foot', text: fmtDateTime(when) }));
    return box;
}
// 이 작업이 실행된 터미널 세션으로 바로 입장(#852). 판정은 서버에 맡긴다 —
//  GET /terminal/sessions/:id 는 canAttach(소유자·초대된 멤버, 프로젝트 폴더 세션은 로그인한 전원 #452)를
//  통과해야 200 을 준다. 그래서 **비공개 세션이면 403, 이미 끝난 세션이면 404/403** → 버튼을 아예 안 붙인다.
//  (세션 목록 API 는 프로젝트 세션을 일부러 빼고 주므로 목록으로 판정하면 안 된다 — src/terminal/routes.ts:128.)
//  상세(1건)에서만 부르므로 목록 N+1 이 없다.
async function attachSessionButton(host, sessionId) {
    if (!sessionId)
        return;
    let s;
    try {
        s = await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId));
    }
    catch {
        return;
    } // 비공개(403) 또는 종료됨 → 들어갈 수 없으니 버튼 없음
    if (!s || !s.id)
        return;
    const url = appUrl('/ui/terminal.html?session=') + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || '');
    host.prepend(el('a', { class: 'btn btn-sm act-doc-sess', href: url, target: '_blank', rel: 'noopener',
        title: '이 작업을 한 터미널 세션 열기', text: '▶ 터미널 세션 열기' }));
}
// 작업(activity) 한 줄 — 회사 전체 타임라인(#/projects2)·작업 현황(#/dash) 공용.
//  접힘: 캐럿 + 유형칩 + 요약(굵게) / 사람·AI·상대시간(+ 구조·의도 변경 태그).
//  펼침(클릭): activityDetailView — 단건 팝업과 같은 범용 템플릿. 처음 펼칠 때 한 번만 만든다(lazy) —
//   목록이 수백 행이라 안 볼 상세의 마크다운까지 미리 렌더하면 무겁다.
function activityTimelineRow(a, nameOf) {
    const when = a.committed_at || a.created_at;
    const hasDetail = activityHasDetail(a);
    const caret = el('span', { class: 'act-row-caret' + (hasDetail ? '' : ' act-row-caret-empty'), 'aria-hidden': 'true', text: hasDetail ? '▸' : '' });
    // 변경 태그 — 이번 작업이 코드구조(is)/도메인 의도(should)를 바꾼 경우만 작게 표기.
    const tags = [];
    if (a.is_review === 'changed')
        tags.push(el('span', { class: 'act-row-tag', text: '구조 변경' }));
    if (a.should_review === 'changed')
        tags.push(el('span', { class: 'act-row-tag', text: '의도 변경' }));
    const head = el('div', { class: 'act-row-head',
        role: hasDetail ? 'button' : null, tabindex: hasDetail ? '0' : null, 'aria-expanded': hasDetail ? 'false' : null }, caret, actTypeTag(a.type), el('div', { class: 'act-row-body' }, el('div', { class: 'act-row-title', text: a.summary || a.title || '(제목 없음)' }), el('div', { class: 'act-row-meta' }, el('span', { class: 'act-row-who', text: nameOf(a.author_person) }), a.author_agent ? el('span', { class: 'act-row-agent', text: ' · ' + a.author_agent }) : null, el('span', { class: 'act-row-time', text: ' · ' + relTime(when) }), ...tags)));
    const row = el('div', { class: 'act-row' + (hasDetail ? ' act-row-expandable' : '') }, head);
    if (!hasDetail)
        return row;
    const detail = el('div', { class: 'act-row-detail', hidden: true });
    let built = false;
    let open = false;
    const toggle = () => {
        if (!built) {
            built = true;
            detail.append(activityDetailView(a, nameOf));
        }
        open = !open;
        detail.hidden = !open;
        row.classList.toggle('open', open);
        caret.textContent = open ? '▾' : '▸';
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggle();
    } });
    row.append(detail);
    return row;
}
// ════════════════════════════════════════════
export { activityDetailView, activityHasDetail, activityTimelineRow, };

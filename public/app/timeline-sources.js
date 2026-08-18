// timeline-sources.ts — 우패널 타임라인(web/timeline.ts)의 **재료 모으기**(#1719).
//  화면마다 대상이 다르고 원천도 다르지만, 나가는 모양은 TlItem 한 벌이다.
//    프로젝트 → 작업 기록 + 프로젝트·태스크 사건 + 댓글 + 잔 변경
//    워크스페이스(홈·리브) → 워크스페이스 전체 작업 기록
//    세션 → 트랜스크립트(session-trail.ts 가 분류) + 이 세션이 남긴 작업 기록
//  ⚠ 여기서 위계(tier)를 손으로 매기지 않는다 — timeline.ts 의 tierOf 가 (kind, verb) 로 정한다.
//    예외는 '사건의 성격이 동사만으로 안 갈리는 것'뿐이다(상태 변경=1, 댓글=2, 잔 편집=3).
import { api, loadPeopleAvatars } from './core.js';
import { humanSummary } from './timeline.js';
const s = (v) => String(v ?? '');
// 사람 id → 표시명. 화면에 'yoon' 이 아니라 '윤상민' 이 떠야 한다(아바타 맵과 같은 원천).
let people = {};
void loadPeopleAvatars().then((m) => { people = m || {}; });
const personName = (id) => {
    const k = s(id);
    return (people[k] && people[k].display_name) || k;
};
// 작업 기록의 유형 — 화면 어휘는 한 곳(web/lib/widgets.ts)이 정본이지만, 여기선 타임라인 한 줄에 들어갈
//  짧은 말만 쓴다(칩이 아니라 부제의 한 조각이라 색·순서를 다시 만들 이유가 없다).
const TYPE_LABEL = {
    feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '리서치', review: '검토', chore: '운영', other: '기타',
};
// 화면에 보일 동사 — 유형마다 다르게 말한다. '했음'만 되풀이하면 아무 말도 안 한 것과 같다.
const TYPE_VERB = {
    feature: '만듦', fix: '고침', decision: '정함', docs: '남김', research: '알아봄', review: '살펴봄', chore: '손봄', other: '했음',
};
// 상태 원값(todo·active·in_progress·done)은 화면 말이 아니다 — 사람 말로 바꿔 보여준다.
const STATUS_LABEL = { todo: '시작 전', active: '진행 중', in_progress: '진행 중', done: '완료' };
const statusWord = (v) => { const k = s(v); return k ? (STATUS_LABEL[k] || k) : '—'; };
/** 작업 기록 한 건 → **장(章)** 한 줄. 접힌 줄은 사람 말 요약, 펼치면 그 작업에서 남은 것. */
function fromActivity(a, opts) {
    const ts = s(a.committed_at || a.created_at);
    // 펼침 — 이 작업에서 **남은 것**만. 커밋 해시·레포는 넣지 않는다(사람이 읽을 것이 아니다).
    const kids = [];
    for (const r of (Array.isArray(a.refs) ? a.refs : [])) {
        if (r.relation !== 'produced')
            continue;
        kids.push({ verb: '지식', label: humanSummary(r.title || r.name, 40), href: r.name ? '#/k/' + encodeURIComponent(s(r.name)) : null });
    }
    if (a.touchCount)
        kids.push({ verb: '코드', label: a.touchCount + '곳을 고쳤어요' });
    const type = s(a.type);
    return {
        id: 'act:' + a.id,
        kind: 'activity',
        verb: TYPE_VERB[type] || '했음',
        label: humanSummary(a.summary || a.title, 44),
        key: 'act|' + a.id,
        ts,
        detail: [TYPE_LABEL[type] || '', opts?.showProject && a.project_id ? '프로젝트 #' + a.project_id : ''].filter(Boolean).join(' · ') || undefined,
        actor: { id: s(a.author_person) || null, name: personName(a.author_person) || null, agent: s(a.author_agent) || null },
        children: kids,
        href: null,
    };
}
/** 프로젝트 타임라인 — 작업 기록 + 사건(상태·생성) + 댓글 + 잔 변경 + 태스크 만듦/끝냄. */
export async function loadProjectTimeline(id, detail) {
    const [actRes, feedRes] = await Promise.all([
        api('/api/ui/v6/projects/' + id + '/activity?limit=100').then((d) => (d && d.activities) || []).catch(() => []),
        api('/api/ui/v6/projects/' + id + '/comments?limit=200').then((d) => (d && d.feed) || []).catch(() => []),
    ]);
    const out = actRes.map((a) => fromActivity(a));
    for (const f of feedRes) {
        const actor = { id: s(f.actor) || null, name: s(f.display_name || f.actor) || null, agent: null };
        if (f.kind === 'comment') {
            out.push({ id: 'cmt:' + f.id, kind: 'say', verb: '말함', label: humanSummary(f.body || f.text, 44), key: 'cmt|' + f.id, ts: s(f.ts), actor });
            continue;
        }
        // 상태가 바뀐 것은 결정이다. 이름·설명 같은 잔 편집은 사건이 아니라 배경이라 싣지 않는다.
        if (f.field === 'created')
            out.push({ id: 'ev:' + f.id, kind: 'project', verb: '시작', label: '이 프로젝트를 시작했어요', key: 'ev|created', ts: s(f.ts), actor });
        else if (f.field === 'status')
            out.push({ id: 'ev:' + f.id, kind: 'project', verb: '정함', label: statusWord(f.to) + '(으)로 옮겼어요', key: 'ev|status|' + s(f.to), ts: s(f.ts), actor });
    }
    // 우리 일하는 방식상 '작업 기록을 남기고 그 태스크를 끝낸다' 가 한 벌이라, 둘 다 실으면 같은 일이 두 줄이 된다.
    //  기록 시각과 10분 안에 붙는 완료는 그 기록이 이미 말하고 있다 — 태스크 줄을 빼서 되풀이를 없앤다.
    const actTimes = out.map((x) => Date.parse(x.ts || '')).filter((n) => Number.isFinite(n));
    const nearActivity = (iso) => {
        const n = Date.parse(iso);
        if (!Number.isFinite(n))
            return false;
        return actTimes.some((t2) => Math.abs(t2 - n) <= 10 * 60_000);
    };
    const tasks = (detail && detail.project && Array.isArray(detail.project.tasks)) ? detail.project.tasks : [];
    for (const t of tasks) {
        if (!t.completed_at)
            continue; // 끝낸 일만 — 만든 일은 계획이지 결과가 아니다
        if (nearActivity(s(t.completed_at)))
            continue;
        const who = { id: s(t.assignee || t.created_by) || null, name: personName(t.assignee || t.created_by) || null, agent: null };
        out.push({ id: 'tk-done:' + t.id, kind: 'task', verb: '끝냄', label: humanSummary(t.name, 44), key: 'tk|done|' + t.id, ts: s(t.completed_at), actor: who, href: '#/projects2/t/' + t.id });
    }
    return out;
}
/** 워크스페이스 타임라인(홈·리브) — 프로젝트를 가리지 않은 전체 작업 기록. */
export async function loadWorkspaceTimeline(limit = 60) {
    const rows = await api('/api/ui/activity/list?limit=' + limit).then((d) => (Array.isArray(d) ? d : (d && d.activities) || [])).catch(() => []);
    return rows.map((a) => fromActivity(a, { showProject: true }));
}
/** 이 세션이 남긴 작업 기록 — 트랜스크립트의 activity_log 호출과 별개로 서버에 남은 정본. */
export async function loadSessionActivities(sessionId) {
    if (!sessionId)
        return [];
    const rows = await api('/api/ui/activity/list?limit=50&session_id=' + encodeURIComponent(sessionId))
        .then((d) => (Array.isArray(d) ? d : (d && d.activities) || [])).catch(() => []);
    return rows.map((a) => fromActivity(a, { showProject: true }));
}

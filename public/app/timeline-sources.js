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
/** 지식 슬러그 → 사람이 읽을 제목. 프로젝트 상세가 이미 필요·산출 목록을 갖고 있다. */
function knowledgeTitle(slug, detail) {
    const kn = detail && detail.project && detail.project.knowledge;
    const all = [...((kn && kn.produced) || []), ...((kn && kn.required) || [])];
    const hit = all.find((k) => s(k.name) === slug);
    return humanSummary(hit && hit.title ? hit.title : slug, 44);
}
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
/** 프로젝트 타임라인 — **이 프로젝트에 무슨 일이 있었나**.
 *
 *  상민님 2026-08-18: "프로젝트 타임라인은 하위 세션의 모든 타임라인을 다 보여주는 게 아니라,
 *   프로젝트 창의 수정이나 프로젝트 그 자체의 변경 같은 **중요한 사항**이었으면 한다.
 *   세션에서 나온 중요한 결과(특히 생성된 파일)면 그 정도는 보여도 괜찮다. 우선순위는 프로젝트 탭 자체의 수정."
 *
 *  그래서 겉면(접힌 목록)에 서는 것은 셋뿐이다:
 *    ① 프로젝트 자체의 변화 — 시작·상태·이름·담당·기한 (가장 위계가 높다)
 *    ② 태스크의 매듭 — 끝낸 일. 그 태스크에서 나온 작업 기록·지식은 **그 카드 안으로 접는다**.
 *    ③ 남은 결과물 — 프로젝트에 직접 달린 작업 기록 중 **커밋·지식·코드 변경이 실제로 있는 것만**.
 *  그 밖(결과 없는 기록·설명 잔 편집)은 겉면에 세우지 않는다. 설명 편집처럼 잦은 것은 하루 한 줄로 묶는다.
 */
export async function loadProjectTimeline(id, detail) {
    const [actRes, feedRes] = await Promise.all([
        api('/api/ui/v6/projects/' + id + '/activity?limit=200').then((d) => (d && d.activities) || []).catch(() => []),
        api('/api/ui/v6/projects/' + id + '/comments?limit=200').then((d) => (d && d.feed) || []).catch(() => []),
    ]);
    const out = [];
    const tasks = (detail && detail.project && Array.isArray(detail.project.tasks)) ? detail.project.tasks : [];
    const taskIds = new Set(tasks.map((t) => Number(t.id)));
    // 작업 기록을 둘로 가른다 — 태스크에 달린 것(그 태스크 카드 안으로) vs 프로젝트에 직접 달린 것(겉면 후보).
    const byTask = new Map();
    const direct = [];
    for (const a of actRes) {
        const pid = Number(a.project_id);
        if (pid && pid !== id && taskIds.has(pid)) {
            const arr = byTask.get(pid) || [];
            arr.push(a);
            byTask.set(pid, arr);
        }
        else
            direct.push(a);
    }
    const producedOf = (a) => (Array.isArray(a.refs) ? a.refs : [])
        .filter((r) => r.relation === 'produced')
        .map((r) => ({ verb: '지식', label: humanSummary(r.title || r.name, 38), href: r.name ? '#/k/' + encodeURIComponent(s(r.name)) : null }));
    /** 이 기록이 '남긴 것'을 갖고 있나 — 커밋·산출지식·코드 변경. 없으면 겉면에 설 자격이 없다. */
    const hasResult = (a) => !!(a.commit_sha || a.touchCount || producedOf(a).length);
    // ① 프로젝트 자체의 변화 — 가장 높은 위계. 잦은 편집(설명 등)은 하루 한 줄로 묶는다.
    const edits = new Map();
    for (const f of feedRes) {
        const actor = { id: s(f.actor) || null, name: s(f.display_name || f.actor) || null, agent: null };
        if (f.kind === 'comment') {
            out.push({ id: 'cmt:' + f.id, kind: 'say', verb: '말함', label: humanSummary(f.body || f.text, 44), key: 'cmt|' + f.id, ts: s(f.ts), actor });
            continue;
        }
        const field = s(f.field);
        if (field === 'created') {
            out.push({ id: 'ev:' + f.id, kind: 'project', verb: '시작', label: '이 프로젝트를 시작했어요', key: 'ev|created', ts: s(f.ts), actor });
            continue;
        }
        if (field === 'status') {
            out.push({ id: 'ev:' + f.id, kind: 'project', verb: '정함', label: statusWord(f.to) + '(으)로 옮겼어요', key: 'ev|status|' + s(f.to), ts: s(f.ts), actor });
            continue;
        }
        if (field === 'name') {
            // ⚠ 실측: 이 피드의 name 이벤트는 프로젝트 이름 변경이 아니라 **지식이 이 프로젝트에 붙은 사건**이다
            //  (from=null · to=지식 슬러그). 진짜 이름 변경은 from 이 있다. 사람에게는 산출물이 더 중요하다.
            const slug = s(f.to);
            if (!f.from && slug) {
                out.push({ id: 'ev:' + f.id, kind: 'knowledge', verb: '남김', label: knowledgeTitle(slug, detail), key: 'kn|' + slug, ts: s(f.ts), actor, href: '#/k/' + encodeURIComponent(slug) });
            }
            else {
                out.push({ id: 'ev:' + f.id, kind: 'project', verb: '고침', label: '이름을 ‘' + humanSummary(slug, 26) + '’ 로 바꿨어요', key: 'ev|name|' + slug, ts: s(f.ts), actor });
            }
            continue;
        }
        if (field === 'assignee' || field === 'due_date' || field === 'start_date' || field === 'priority') {
            out.push({ id: 'ev:' + f.id, kind: 'project', verb: '고침', label: s(f.label || field) + '을(를) 바꿨어요', key: 'ev|' + field, ts: s(f.ts), actor });
            continue;
        }
        // 그 밖(설명 등) — 하루 단위로 한 줄. 몇 번 손봤는지가 사실이고, 매번이 사건은 아니다.
        const day = s(f.ts).slice(0, 10);
        const k = day + '|' + s(f.actor);
        const cur = edits.get(k) || { n: 0, ts: s(f.ts), actor, what: new Set() };
        cur.n++;
        cur.ts = s(f.ts);
        cur.what.add(s(f.label || field));
        edits.set(k, cur);
    }
    for (const [k, e] of edits) {
        if (e.n < 1)
            continue;
        out.push({ id: 'ed:' + k, kind: 'meta', verb: '손봄', label: [...e.what].slice(0, 2).join('·') + (e.n > 1 ? ` ${e.n}번 고침` : ' 고침'), key: 'ed|' + k, ts: e.ts, actor: e.actor });
    }
    // ② 태스크의 매듭 — 끝낸 일. 그 안에서 나온 기록·지식은 카드 안으로.
    for (const t of tasks) {
        if (!t.completed_at)
            continue;
        const acts = byTask.get(Number(t.id)) || [];
        const kids = [];
        for (const a of acts.slice(0, 6)) {
            kids.push({ verb: TYPE_VERB[s(a.type)] || '했음', label: humanSummary(a.summary || a.title, 38) });
            for (const k of producedOf(a))
                kids.push(k);
        }
        const who = { id: s(t.assignee || t.created_by) || null, name: personName(t.assignee || t.created_by) || null, agent: null };
        out.push({ id: 'tk-done:' + t.id, kind: 'task', verb: '끝냄', label: humanSummary(t.name, 44), key: 'tk|done|' + t.id, ts: s(t.completed_at), actor: who, href: '#/projects2/t/' + t.id, children: kids.slice(0, 10) });
    }
    // ③ 프로젝트에 직접 달린 기록 중 **남긴 것이 있는 것만**.
    for (const a of direct) {
        if (!hasResult(a))
            continue;
        out.push(fromActivity(a));
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

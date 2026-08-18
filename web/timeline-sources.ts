// timeline-sources.ts — 우패널 타임라인(web/timeline.ts)의 **재료 모으기**(#1719).
//  화면마다 대상이 다르고 원천도 다르지만, 나가는 모양은 TlItem 한 벌이다.
//    프로젝트 → 작업 기록 + 프로젝트·태스크 사건 + 댓글 + 잔 변경
//    워크스페이스(홈·리브) → 워크스페이스 전체 작업 기록
//    세션 → 트랜스크립트(session-trail.ts 가 분류) + 이 세션이 남긴 작업 기록
//  ⚠ 여기서 위계(tier)를 손으로 매기지 않는다 — timeline.ts 의 tierOf 가 (kind, verb) 로 정한다.
//    예외는 '사건의 성격이 동사만으로 안 갈리는 것'뿐이다(상태 변경=1, 댓글=2, 잔 편집=3).
import { api } from './core.js';
import type { TlItem } from './timeline.js';

type Item = Omit<TlItem, 'count'>;

const s = (v: unknown): string => String(v ?? '');
const short = (v: unknown, n = 110): string => { const t = s(v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// 작업 기록의 유형 — 화면 어휘는 한 곳(web/lib/widgets.ts)이 정본이지만, 여기선 타임라인 한 줄에 들어갈
//  짧은 말만 쓴다(칩이 아니라 부제의 한 조각이라 색·순서를 다시 만들 이유가 없다).
const TYPE_LABEL: Record<string, string> = {
  feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '리서치', review: '검토', chore: '운영', other: '기타',
};
// 상태 원값(todo·active·in_progress·done)은 화면 말이 아니다 — 사람 말로 바꿔 보여준다.
const STATUS_LABEL: Record<string, string> = { todo: '시작 전', active: '진행 중', in_progress: '진행 중', done: '완료' };
const statusWord = (v: unknown): string => { const k = s(v); return k ? (STATUS_LABEL[k] || k) : '—'; };

/** 작업 기록 한 건 → 타임라인 항목. 프로젝트·워크스페이스가 같은 변환을 쓴다. */
function fromActivity(a: any, opts?: { showProject?: boolean }): Item {
  const ts = s(a.committed_at || a.created_at);
  const bits: string[] = [];
  if (a.type && TYPE_LABEL[a.type]) bits.push(TYPE_LABEL[a.type]);
  if (a.commit_sha) bits.push([a.repo, s(a.commit_sha).slice(0, 8)].filter(Boolean).join(' '));
  if (Array.isArray(a.refs) && a.refs.length) bits.push('지식 ' + a.refs.length);
  if (a.touchCount) bits.push('코드 ' + a.touchCount + '곳');
  if (opts?.showProject && a.project_id) bits.push('#' + a.project_id);
  return {
    id: 'act:' + a.id,
    kind: 'activity', verb: '기록',
    label: short(a.summary || a.title, 110),
    key: 'act|' + a.id,
    ts,
    detail: bits.join(' · ') || undefined,
    actor: { id: s(a.author_person) || null, name: s(a.author_person) || null, agent: s(a.author_agent) || null },
    // 작업 기록의 '자세히'는 가운데 화면 몫이다(상민님 결정) — 아직 그 화면이 없어 링크를 만들지 않는다.
    href: null,
  };
}

/** 프로젝트 타임라인 — 작업 기록 + 사건(상태·생성) + 댓글 + 잔 변경 + 태스크 만듦/끝냄. */
export async function loadProjectTimeline(id: number, detail?: any): Promise<Item[]> {
  const [actRes, feedRes] = await Promise.all([
    api('/api/ui/v6/projects/' + id + '/activity?limit=100').then((d: any) => (d && d.activities) || []).catch(() => []),
    api('/api/ui/v6/projects/' + id + '/comments?limit=200').then((d: any) => (d && d.feed) || []).catch(() => []),
  ]);
  const out: Item[] = (actRes as any[]).map((a) => fromActivity(a));

  for (const f of feedRes as any[]) {
    const actor = { id: s(f.actor) || null, name: s(f.display_name || f.actor) || null, agent: null };
    if (f.kind === 'comment') {
      out.push({ id: 'cmt:' + f.id, kind: 'say', verb: '남긴 말', label: short(f.body || f.text, 110), key: 'cmt|' + f.id, ts: s(f.ts), actor, tier: 2 });
      continue;
    }
    if (f.field === 'created') {
      out.push({ id: 'ev:' + f.id, kind: 'project', verb: '만듦', label: '프로젝트를 만듦', key: 'ev|created', ts: s(f.ts), actor });
    } else if (f.field === 'status') {
      out.push({ id: 'ev:' + f.id, kind: 'project', verb: '바꿈', label: `상태 ${statusWord(f.from)} → ${statusWord(f.to)}`, key: 'ev|status', ts: s(f.ts), actor });
    } else {
      // 설명·이름 같은 잔 편집은 사건이 아니라 배경이다 — 3단(전부 보기에서만).
      out.push({ id: 'ev:' + f.id, kind: 'meta', verb: '고침', label: s(f.label || f.field), key: 'ev|meta|' + s(f.field) + '|' + s(f.actor), ts: s(f.ts), actor, tier: 3 });
    }
  }

  const tasks: any[] = (detail && detail.project && Array.isArray(detail.project.tasks)) ? detail.project.tasks : [];
  for (const t of tasks) {
    const who = { id: s(t.assignee || t.created_by) || null, name: s(t.assignee || t.created_by) || null, agent: null };
    if (t.completed_at) out.push({ id: 'tk-done:' + t.id, kind: 'task', verb: '끝냄', label: short(t.name, 90), key: 'tk|done|' + t.id, ts: s(t.completed_at), actor: who, href: '#/projects2/t/' + t.id });
    if (t.created_at) out.push({ id: 'tk-new:' + t.id, kind: 'task', verb: '만듦', label: short(t.name, 90), key: 'tk|new|' + t.id, ts: s(t.created_at), actor: who, href: '#/projects2/t/' + t.id, tier: 2 });
  }
  return out;
}

/** 워크스페이스 타임라인(홈·리브) — 프로젝트를 가리지 않은 전체 작업 기록. */
export async function loadWorkspaceTimeline(limit = 60): Promise<Item[]> {
  const rows = await api('/api/ui/activity/list?limit=' + limit).then((d: any) => (Array.isArray(d) ? d : (d && d.activities) || [])).catch(() => []);
  return (rows as any[]).map((a) => fromActivity(a, { showProject: true }));
}

/** 이 세션이 남긴 작업 기록 — 트랜스크립트의 activity_log 호출과 별개로 서버에 남은 정본. */
export async function loadSessionActivities(sessionId: string): Promise<Item[]> {
  if (!sessionId) return [];
  const rows = await api('/api/ui/activity/list?limit=50&session_id=' + encodeURIComponent(sessionId))
    .then((d: any) => (Array.isArray(d) ? d : (d && d.activities) || [])).catch(() => []);
  return (rows as any[]).map((a) => fromActivity(a, { showProject: true }));
}

// 자료 앱의 **들어온 길** 규칙: 순수(#4233, 원준 2026-09-26). DOM 을 모른다: 나무 · 올린 사람 → 사이드바 계획, 자료 한 건 → 원천 칸 · 올린 곳 한 줄.
//  사이드바는 side.ts renderSourcesSection, 목록 · 원문은 sources.ts 가 이 결과를 그리기만 한다. 규칙이 여기 한 벌이라 시험이 화면 없이 잡는다.
//
//  원준: "1. 올린 자료 2. 수집한 자료 3. 라이블리에서 만들어진 자료 이렇게 나누면 MECE한가? … 수집한 자료의 하위에 슬랙, 디스코드, .. 이런식으로."
//  · 올린 자료   = 사람이 바깥에서 가져온 파일(자료 앱 · 세션 입력칸 첨부 · 프로젝트 폴더 · 태스크 첨부 · 온보딩). 카드 안 줄은 올린 사람.
//  · 수집한 자료 = 연결한 앱. 카드 안 줄은 앱, 앱 아래 줄은 그 앱의 자리(채널 · 저장소).
//  · 라이블리에서 만든 자료 = AI가 만든 파일 · 직접 적은 글, 두 줄.
//  갈래 판정은 서버(src/v6/source-group.ts)와 같은 규칙이다. 나무 가지는 서버가 준 group 을 그대로 쓰고, 옛 서버(group 없음)면 출처로 짐작한다.

export type SrcGroup = 'uploaded' | 'collected' | 'made_ai' | 'made_note';
export type SrcGroupSel = SrcGroup | 'made';
export const SRC_GROUP_SELS: readonly SrcGroupSel[] = ['uploaded', 'collected', 'made_ai', 'made_note', 'made'];

export interface SrcSel { group?: SrcGroupSel; system?: string; container?: string; author?: string; linked?: boolean; q?: string }
export interface PlanNode { system: string; container: string | null; group?: string; n: number; linked?: number }
export interface PlanUploader { name: string | null; id: string | null; n: number }
export interface PlanApp { system: string; n: number; containers: { name: string; n: number }[] }
export interface SourcesSidePlan {
  total: number;
  uploaded: { n: number; people: PlanUploader[]; unnamed: number };
  collected: { n: number; apps: PlanApp[] };
  made: { n: number; ai: number; note: number };
}

/** 출처 이름: external_system 은 기계 이름이라 그대로 보여 주지 않는다. */
export const SYS_LABEL: Record<string, string> = {
  slack: '슬랙', discord: '디스코드', github: '깃허브', gitlab: '깃랩', linear: '리니어', figma: '피그마',
  notion: '노션', clickup: '클릭업', gdrive: '구글드라이브', gmail: '지메일', outlook: '아웃룩', local: '파일',
  'domain-wiki': '도메인 위키', authored: '직접 적은 글',
};
export const KIND_LABEL: Record<string, string> = {
  transcript: '전사록', minutes: '회의록', email: '이메일', slack: '슬랙', discord: '디스코드',
  notion_doc: '노션', clickup_doc: '클릭업', drive_file: '구글드라이브', local_file: '파일',
  figma_comment: '피그마 코멘트', github_issue: '깃허브', gitlab_issue: '깃랩', linear_issue: '리니어', other: '기타',
};
export const sysLabel = (s: string): string => SYS_LABEL[s] || s;
export const kindLabel = (k: string): string => KIND_LABEL[k] || k;
/** 수집한 자료 안 앱의 차례: 대화가 위, 기록계가 아래. 모르는 앱은 끝(같으면 수 많은 순). */
export const SYS_ORDER = ['slack', 'discord', 'github', 'gitlab', 'linear', 'figma', 'notion', 'gdrive', 'gmail', 'outlook', 'clickup', 'domain-wiki'];
const sysRank = (s: string): number => { const i = SYS_ORDER.indexOf(s); return i < 0 ? SYS_ORDER.length : i; };
export const isChatSys = (s: string): boolean => s === 'slack' || s === 'discord';

const GROUPS: readonly string[] = ['uploaded', 'collected', 'made_ai', 'made_note'];
/** 나무 가지의 갈래: 서버가 준 값이 정본. 옛 서버면 출처로 짐작한다(파일은 전부 올린 자료). */
export function nodeGroup(n: PlanNode): SrcGroup {
  if (n.group && GROUPS.includes(n.group)) return n.group as SrcGroup;
  return n.system === 'authored' ? 'made_note' : n.system === 'local' ? 'uploaded' : 'collected';
}

/** 자료 한 건의 갈래: 서버 sourceGroupOf 와 같은 규칙(entry 가 'generated' 인 파일만 AI 가 만든 것). */
export function rowGroup(r: { external_system?: string | null; fields?: Record<string, any> | null }): SrcGroup {
  const sys = r.external_system ?? null;
  if (sys === null) return 'made_note';
  if (sys === 'local') return (r.fields && r.fields.entry === 'generated') ? 'made_ai' : 'uploaded';
  return 'collected';
}

export function planSourcesSide(nodes: PlanNode[], uploaders: PlanUploader[] | null | undefined): SourcesSidePlan {
  const sum = (xs: { n: number }[]): number => xs.reduce((a, x) => a + (Number(x.n) || 0), 0);
  const by: Record<SrcGroup, PlanNode[]> = { uploaded: [], collected: [], made_ai: [], made_note: [] };
  for (const n of nodes || []) by[nodeGroup(n)].push(n);
  const apps = new Map<string, PlanNode[]>();
  for (const n of by.collected) { const a = apps.get(n.system) || []; a.push(n); apps.set(n.system, a); }
  const appList: PlanApp[] = [...apps.entries()].map(([system, list]) => ({
    system, n: sum(list),
    //  자리 이름 없는 가지는 줄을 만들지 않는다: 그 자료는 앱 줄에서 함께 보인다.
    containers: list.filter((x) => !!x.container).map((x) => ({ name: String(x.container), n: Number(x.n) || 0 }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ko')),
  })).sort((a, b) => sysRank(a.system) - sysRank(b.system) || b.n - a.n || a.system.localeCompare(b.system));
  const ups = (uploaders || []).filter((u) => (Number(u.n) || 0) > 0);
  const people = ups.filter((u) => !!u.name).sort((a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name), 'ko'));
  const ai = sum(by.made_ai), note = sum(by.made_note);
  return {
    total: sum(nodes || []),
    uploaded: { n: sum(by.uploaded), people, unnamed: sum(ups.filter((u) => !u.name)) },
    collected: { n: sum(by.collected), apps: appList },
    made: { n: ai + note, ai, note },
  };
}

/** 옛 주소를 새 자리로(#4233): 옛 사이드바의 네 줄(system=local · root · author)과 적어 둔 것(system=authored). */
export function normalizeSel(sel: SrcSel & { root?: string }): SrcSel {
  const out: SrcSel & { root?: string } = { ...sel };
  delete out.root;                                          // 올린 자리는 묶음이 아니다(상세의 한 줄로만)
  if (out.system === 'local') { delete out.system; delete out.container; if (!out.group) out.group = 'uploaded'; }
  else if (out.system === 'authored') { delete out.system; delete out.container; if (!out.group) out.group = 'made_note'; }
  if (out.group && !SRC_GROUP_SELS.includes(out.group)) delete out.group;
  if (out.system) delete out.group;                         // 앱을 고르면 갈래는 저절로 수집한 자료다
  for (const k of Object.keys(out) as (keyof typeof out)[]) if (out[k] === undefined || out[k] === '') delete out[k];
  return out;
}

/** 사이드바에서 켜질 줄의 선택: 찾기 · 「지식이 된 것만」은 줄을 바꾸지 않는다. 올린 사람은 올린 자료 안에서만 줄이다. */
export function sideSel(sel: SrcSel): SrcSel {
  const out: SrcSel = {};
  if (sel.group) out.group = sel.group;
  if (sel.system) out.system = sel.system;
  if (sel.container) out.container = sel.container;
  if (sel.author && sel.group === 'uploaded' && !sel.system) out.author = sel.author;
  return out;
}

/** 「올린 사람」 거르개가 서는 자리: 모든 자료 · 올린 자료만(바깥 자료 · 만든 자료에는 올린 사람이 없다). */
export const showsUploaderFilter = (sel: SrcSel): boolean => !sel.system && !sel.container && (!sel.group || sel.group === 'uploaded');

/** 목록 머리 경로: 흐린 앞 칸들 + 굵은 마지막 칸. 찾는 중이면 찾는 말. */
export function crumbOf(sel: SrcSel, person: (name: string) => string): { dim: string[]; last: string } {
  if (sel.q) return { dim: ['찾기'], last: sel.q };
  const who = sel.author ? person(sel.author) : '';
  if (sel.system) return { dim: ['수집한 자료', ...(sel.container ? [sysLabel(sel.system)] : [])], last: sel.container ? (isChatSys(sel.system) ? '#' : '') + sel.container : sysLabel(sel.system) };
  if (sel.group === 'uploaded') return who ? { dim: ['올린 자료'], last: who } : { dim: [], last: '올린 자료' };
  if (sel.group === 'collected') return { dim: [], last: '수집한 자료' };
  if (sel.group === 'made') return { dim: [], last: '라이블리에서 만든 자료' };
  if (sel.group === 'made_ai') return { dim: ['라이블리에서 만든 자료'], last: 'AI가 만든 파일' };
  if (sel.group === 'made_note') return { dim: ['라이블리에서 만든 자료'], last: '직접 적은 글' };
  return who ? { dim: ['모든 자료'], last: who } : { dim: [], last: '모든 자료' };
}

export function emptyTextOf(sel: SrcSel): string {
  if (sel.q) return '찾는 말이 든 자료가 없습니다.';
  if (sel.group === 'uploaded') return '아직 올린 파일이 없습니다. 사이드바 머리의 ＋ 나 세션 입력칸, 프로젝트 폴더에 파일을 올리면 여기 모입니다.';
  if (sel.group === 'made_ai') return '아직 AI 세션이 만든 파일이 없습니다. 세션이 프로젝트 폴더에 파일을 쓰면 여기 모입니다.';
  if (sel.group === 'made_note') return '아직 직접 적은 글이 없습니다.';
  if (sel.group === 'collected' || sel.system) return '이 자리에는 아직 가져온 자료가 없습니다.';
  return '이 자리에는 아직 자료가 없습니다.';
}

// ── 자리(원천 칸 · 올린 곳 한 줄) ─────────────────────────────────────────────
interface RowLike { kind?: string; external_system?: string | null; external_id?: string | null; fields?: Record<string, any> | null }

/** 파일이 놓인 폴더를 사람 말로: 프로젝트 「이름」 폴더 · 태스크 첨부 · 개인 폴더 · 공유 폴더. */
export function folderText(r: RowLike): string {
  const f = r.fields || {};
  const path = String(f.path || '');
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  if (f.root === 'project') {
    const pid = /^project:(\d+)/.exec(String(f.container_ref || r.external_id || ''))?.[1];
    const name = f.project_name ? `「${f.project_name}」` : pid ? `#${pid}` : '';
    const proj = '프로젝트' + (name ? ' ' + name : '');
    if (path.startsWith('_attachments/task-')) return proj + ' 태스크 첨부';
    if (path.startsWith('_attachments/project-')) return proj + ' 본문 첨부';
    return proj + ' 폴더' + (dir ? ' ' + dir : '');
  }
  if (f.root === 'personal') return '개인 폴더' + (dir ? ' ' + dir : '');
  if (f.root === 'shared') return '공유 폴더' + (dir ? ' ' + dir : '');
  return '폴더' + (dir ? ' ' + dir : '');
}

/** 프로젝트 이름만(원천 칸은 좁다): 없으면 폴더 종류. */
function placeShort(r: RowLike): string {
  const f = r.fields || {};
  if (f.root === 'project') {
    if (f.project_name) return String(f.project_name);
    const pid = /^project:(\d+)/.exec(String(f.container_ref || r.external_id || ''))?.[1];
    return pid ? `프로젝트 #${pid}` : '프로젝트';
  }
  return f.root === 'shared' ? '공유 폴더' : '개인 폴더';
}

export interface SrcOrigin { kind: 'person' | 'ai' | 'app' | 'note'; text: string; id?: string; sys?: string }
/** 목록 줄의 원천 칸: 올린 파일은 사람, AI 파일은 «AI 세션 · 자리», 수집은 «앱 · 자리», 직접 적은 글은 종류. */
export function originOf(r: RowLike, person: (name: string, id: string) => string): SrcOrigin {
  const f = r.fields || {};
  const g = rowGroup(r);
  if (g === 'uploaded') {
    const name = String(f.author_name || ''), id = String(f.author_external_id || '');
    return name || id ? { kind: 'person', text: person(name, id), id: id || name } : { kind: 'person', text: '올린 사람 기록 없음' };
  }
  if (g === 'made_ai') return { kind: 'ai', text: 'AI 세션 · ' + placeShort(r) };
  if (g === 'made_note') return { kind: 'note', text: '직접 적은 글' + (r.kind && KIND_LABEL[r.kind] ? ' · ' + kindLabel(r.kind) : '') };
  const sys = String(r.external_system);
  const c = String(f.container_name || '');
  return { kind: 'app', sys, text: sysLabel(sys) + (c ? ' · ' + (isChatSys(sys) ? '#' : '') + c : '') };
}

/** 원문 칸의 한 줄: «올린 곳: …» · «만든 곳: …» · «가져온 곳: …». 자리는 묶음이 아니라 사실 한 줄이다. */
export function placeLine(r: RowLike): string {
  const g = rowGroup(r);
  if (g === 'uploaded') return '올린 곳: ' + folderText(r);
  if (g === 'made_ai') return '만든 곳: AI 세션 · ' + folderText(r);
  if (g === 'made_note') return '만든 곳: 라이블리에 직접 적은 글' + (r.kind && KIND_LABEL[r.kind] ? `(${kindLabel(r.kind)})` : '');
  const sys = String(r.external_system);
  const c = String((r.fields || {}).container_name || '');
  return '가져온 곳: ' + sysLabel(sys) + (c ? ' · ' + (isChatSys(sys) ? '#' : '') + c : '');
}

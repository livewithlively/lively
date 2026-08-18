// session-trail.ts — 세션 트랜스크립트의 **도구 사용 한 건 → 타임라인 항목** 분류(#1719).
//
//  세션 화면(session-chat.ts)이 대화 파일을 줄 단위로 읽으며 tool_use 를 여기로 넘긴다. 그 판정이
//  우패널 타임라인(web/timeline.ts)의 재료다. 별도 서버 로그를 기다리지 않아도 되고(mcp_call_log 에는
//  session_id 가 없다, #1578) 라이브로 자란다.
//
//  ⚠ 실측(2026-08-18, 이 세션): 도구 호출 151건 중 **126건이 Bash** 였고, 파일 작성·수정 상당수가
//   그 Bash 안(heredoc·sed·tee)에서 일어났다. 도구 이름만 보면 '가장 중요한 결과(파일이 남았다)'가
//   통째로 안 보인다. 그래서 Bash 도 분류한다 — 다만 **확실할 때만 '파일'이라 부르고**(리다이렉트·tee·sed -i 처럼
//   대상 경로가 명령에 드러난 경우), 애매하면 '명령'으로 남긴다. 없는 사실을 지어내지 않는 편이 낫다.
//
//  위젯은 여기 없다 — 그리는 일은 web/timeline.ts 한 곳이 한다(발자취·프로젝트·워크스페이스가 같은 부품).
import type { TimelineHandle, TlKind, TlTier } from './timeline.js';

/** session-chat.ts 가 받는 싱크 타입(이름 유지 — 호출부 무변경). */
export type TrailWidget = TimelineHandle;

export interface TrailClass {
  kind: TlKind; verb: string; label: string; key: string;
  detail?: string; href?: string | null; tier?: TlTier;
}

const short = (s: unknown, n = 120): string => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const tailPath = (p: unknown): string => { const s = String(p ?? ''); const parts = s.split('/').filter(Boolean); return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : s; };
const mk = (kind: TlKind, verb: string, label: string, extra?: Partial<TrailClass>): TrailClass =>
  ({ kind, verb, label, key: `${kind}|${verb}|${label}`, ...extra });

// ── Bash 한 줄 → 무슨 일이었나 ──────────────────────────────────────────────
//  순서가 곧 우선순위다(먼저 걸리는 것이 이긴다). 결과가 남는 것(커밋·배포·파일)이 위.
const CMD_RULES: Array<{ re: RegExp; f: (m: RegExpMatchArray, cmd: string) => TrailClass }> = [
  // 커밋 — 메시지 첫 줄을 라벨로. -m "…" · -m '…' · -F - <<'EOF' 첫 줄.
  { re: /\bgit commit\b[\s\S]*?-m\s+["']([^"'\n]+)/, f: (m) => mk('cmd', '커밋', short(m[1], 90), { tier: 1 }) },
  { re: /\bgit commit\b[\s\S]*?<<\s*'?\w+'?\s*\n([^\n]+)/, f: (m) => mk('cmd', '커밋', short(m[1], 90), { tier: 1 }) },
  { re: /\bgit commit\b/, f: () => mk('cmd', '커밋', '커밋', { tier: 1 }) },
  { re: /\bgh pr create\b[\s\S]*?--title\s+["']([^"'\n]+)/, f: (m) => mk('cmd', '올림', 'PR — ' + short(m[1], 80), { tier: 1 }) },
  { re: /\bgh pr (create|merge)\b/, f: (m) => mk('cmd', '올림', m[1] === 'merge' ? 'PR 머지' : 'PR 생성', { tier: 1 }) },
  { re: /\bgit push\b/, f: () => mk('cmd', '올림', 'push', { tier: 1 }) },
  { re: /restart-gateway|restage\.sh|cherry-pick/, f: () => mk('cmd', '배포', 'dev 반영', { tier: 1 }) },
  // 파일 — **대상이 명령에 드러난 경우만** 파일이라 부른다.
  //  ⚠ 스크립트 안 편집(python heredoc)이 실제로 가장 흔하다 — `p='web/x.ts' … open(p,'w')` 꼴을 함께 본다.
  { re: /p\s*=\s*['"]([^'"\n]+)['"][\s\S]{0,4000}?open\(\s*p\s*,\s*['"]w/, f: (m) => mk('file', '고침', tailPath(m[1])) },
  { re: /open\(\s*['"]([^'"\n]+)['"]\s*,\s*['"]w/, f: (m) => mk('file', '고침', tailPath(m[1])) },
  { re: /\btee\s+(?:-a\s+)?([\w./~-]+)/, f: (m) => mk('file', '씀', tailPath(m[1])) },
  { re: /(?:^|\n|&&|\|\|)\s*cat\s*>\s*([\w./~-]+)/, f: (m) => mk('file', '씀', tailPath(m[1])) },
  { re: /\bsed\s+-i\b[^\n]*?\s([\w./~-]+)\s*$/m, f: (m) => mk('file', '고침', tailPath(m[1])) },
  { re: /\b(rm|mv|cp)\s+(-\w+\s+)*([\w./~-]+)/, f: (m) => mk('file', m[1] === 'rm' ? '지움' : m[1] === 'mv' ? '옮김' : '복사', tailPath(m[3])) },
  // 과정
  { re: /run-tests|\bnpm (run )?test\b|\bvitest\b|\bjest\b/, f: () => mk('cmd', '테스트', '테스트 실행') },
  { re: /npm run build|\btsc\b|check-css-drops|check-imports/, f: () => mk('cmd', '빌드', '빌드·검사') },
  { re: /^\s*(cat|sed -n|head|tail|less|grep|rg|ls|find|wc|git (log|status|diff|show)|curl -s)\b/m, f: (_m, cmd) => mk('cmd', '봄', short(cmd.split('\n')[0], 70)) },
];
function classifyBash(cmd: string, desc?: string): TrailClass | null {
  const c = String(cmd || '');
  if (!c.trim()) return null;
  for (const r of CMD_RULES) { const m = c.match(r.re); if (m) return r.f(m, c); }
  return mk('cmd', '실행', short(desc || c.split('\n')[0], 70));
}

/** tool_use 한 건 → 타임라인 항목(해당 없으면 null). 순수 함수 — 테스트가 그대로 부른다. */
export function classifyToolUse(name: string, input: any): TrailClass | null {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  switch (name) {
    case 'Read': return mk('file', '읽음', tailPath(o.file_path));
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return mk('file', '고침', tailPath(o.file_path ?? o.notebook_path));
    case 'Write': return mk('file', '씀', tailPath(o.file_path));
    case 'Bash': return classifyBash(o.command, o.description);
    case 'Task': case 'Agent': return mk('cmd', '맡김', short(o.description ?? o.prompt, 70));
  }
  if (!name.startsWith('mcp__lively__')) return null;
  const t = name.slice('mcp__lively__'.length);
  const kHref = (n: unknown) => (n ? '#/k/' + encodeURIComponent(String(n)) : null);
  // 지식
  if (t === 'knowledge_get') return mk('knowledge', '읽음', String(o.name || ''), { href: kHref(o.name) });
  if (t === 'knowledge_search' || t === 'knowledge_grep' || t === 'knowledge_similar') return mk('knowledge', '찾아봄', short(o.q ?? o.query ?? o.name, 80));
  if (t === 'knowledge_save') return mk('knowledge', o.mode === 'append' ? '덧붙임' : o.mode === 'edit' ? '고침' : '남김', String(o.title || o.name || ''), { detail: o.name ? String(o.name) : undefined, href: kHref(o.name) });
  if (/^knowledge_(link|link_category|set_lifecycle|set_title|move|set_wiki|propose_category)$/.test(t)) return mk('knowledge', '고침', String(o.name || o.from || ''), { href: kHref(o.name) });
  if (t === 'knowledge_list' || t === 'knowledge_projects_v6' || t === 'knowledge_history') return mk('knowledge', '살펴봄', short(o.name || o.category || o.q || t, 60));
  // 활동(작업 기록) — 세션이 남긴 '한 일'. 가장 무거운 결과다.
  if (t === 'activity_log') return mk('activity', '기록', short(o.summary || o.title, 100), { detail: o.commit_sha ? '커밋 ' + String(o.commit_sha).slice(0, 8) : undefined });
  if (t === 'activity_list') return mk('activity', '살펴봄', short(o.project_id ? `프로젝트 #${o.project_id}` : '작업 기록', 60));
  // 프로젝트
  if (t === 'project_get_v6') return mk('project', '불러옴', `#${o.id ?? o.projectId ?? ''}`, { href: o.id ? '#/p/' + o.id : null });
  if (t === 'project_create_v6') return mk('project', '만듦', short(o.name, 80));
  if (/^project_(update|set_status|set_list|set_repos|set_members|set_categories|link_knowledge|link_category|link_project|bind_folder)_v6$/.test(t))
    return mk('project', '고침', `#${o.id ?? o.projectId ?? ''}`, { href: (o.id ?? o.projectId) ? '#/p/' + (o.id ?? o.projectId) : null });
  if (/^project_(list|search|grep|my_status|find_by_origin)/.test(t)) return mk('project', '찾아봄', short(o.q ?? o.query ?? o.status ?? '목록', 60));
  // 태스크
  if (t === 'task_create_v6') return mk('task', '만듦', short(o.name, 80));
  if (t === 'task_set_status_v6') return mk('task', o.status === 'done' ? '끝냄' : '되돌림', `#${o.id ?? ''}`, { href: o.id ? '#/projects2/t/' + o.id : null });
  if (t === 'task_detail_v6') return mk('task', '봄', `#${o.id ?? ''}`, { href: o.id ? '#/projects2/t/' + o.id : null });
  if (/^task_/.test(t)) return mk('task', '고침', `#${o.id ?? o.taskId ?? ''}`, { href: o.id ? '#/projects2/t/' + o.id : null });
  // 자료
  if (t === 'source_get' || t === 'source_artifact') return mk('source', '읽음', String(o.id ?? o.name ?? ''));
  if (t === 'source_save') return mk('source', '남김', short(o.title ?? o.name ?? o.url, 80));
  if (/^source_(list|undistilled|search)/.test(t)) return mk('source', '찾아봄', short(o.q ?? o.channel ?? '목록', 60));
  return null;
}

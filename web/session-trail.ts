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
import { humanTitle, type TimelineHandle, type TlKind, type TlTier } from './timeline.js';

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

// ── 무엇을 **안 적을지**(상민님 2026-08-18: "쓸데없는 얘기가 많다 · 중요한 줄기만") ──
//  타임라인은 일한 자취지 실행 기록이 아니다. 작업물이 아닌 것(임시파일·스크린샷·로그)과
//  들여다보기만 한 명령(cat·grep·ls)은 아예 적지 않는다 — 접어 두는 게 아니라 사건이 아니다.
const JUNK_PATH = /(^|\/)(tmp|scratchpad|node_modules|dist|\.cache|\.git|public\/app)(\/|$)|\.(png|jpe?g|gif|svg|log|jsonl|lock|tsbuildinfo[\w-]*)$/i;
const isJunkPath = (p: unknown): boolean => { const t = String(p ?? ''); return !t || JUNK_PATH.test(t); };

// ── Bash 한 줄 → 무슨 일이었나 ──────────────────────────────────────────────
//  순서가 곧 우선순위다(먼저 걸리는 것이 이긴다). 결과가 남는 것(커밋·배포·파일)이 위.
const CMD_RULES: Array<{ re: RegExp; f: (m: RegExpMatchArray, cmd: string) => TrailClass }> = [
  // 커밋 — 메시지 첫 줄을 라벨로. -m "…" · -m '…' · -F - <<'EOF' 첫 줄.
  { re: /\bgit commit\b[\s\S]*?-m\s+["']([^"'\n]+)/, f: (m) => mk('cmd', '커밋', humanTitle(m[1]), { tier: 1 }) },
  { re: /\bgit commit\b[\s\S]*?<<\s*'?\w+'?\s*\n([^\n]+)/, f: (m) => mk('cmd', '커밋', humanTitle(m[1]), { tier: 1 }) },
  { re: /\bgit commit\b/, f: () => mk('cmd', '커밋', '변경을 커밋', { tier: 1 }) },
  { re: /\bgh pr create\b[\s\S]*?--title\s+["']([^"'\n]+)/, f: (m) => mk('cmd', '올림', humanTitle(m[1]), { tier: 2 }) },
  { re: /\bgh pr create\b/, f: () => mk('cmd', '올림', '리뷰 요청(PR)', { tier: 2 }) },
  // 머지·푸시·재기동은 결과가 아니라 그 결과를 나르는 배관이다 — 적되 조용히(전부 보기).
  { re: /\bgh pr merge\b/, f: () => mk('cmd', '반영', '변경을 본줄기에 합침', { tier: 3 }) },
  { re: /\bgit push\b/, f: () => mk('cmd', '반영', '올려 보냄', { tier: 3 }) },
  { re: /restart-gateway|restage\.sh|cherry-pick/, f: () => mk('cmd', '반영', '개발 서버에 적용', { tier: 3 }) },
  // 파일 — **대상이 명령에 드러난 경우만** 파일이라 부른다.
  //  ⚠ 스크립트 안 편집(python heredoc)이 실제로 가장 흔하다 — `p='web/x.ts' … open(p,'w')` 꼴을 함께 본다.
  { re: /p\s*=\s*['"]([^'"\n]+)['"][\s\S]{0,4000}?open\(\s*p\s*,\s*['"]w/, f: (m) => mk('file', '고침', tailPath(m[1])) },
  { re: /open\(\s*['"]([^'"\n]+)['"]\s*,\s*['"]w/, f: (m) => mk('file', '고침', tailPath(m[1])) },
  { re: /\btee\s+(?:-a\s+)?([\w./~-]+)/, f: (m) => mk('file', '씀', tailPath(m[1])) },
  { re: /(?:^|\n|&&|\|\|)\s*cat\s*>\s*([\w./~-]+)/, f: (m) => mk('file', '씀', tailPath(m[1])) },
  { re: /\bsed\s+-i\b[^\n]*?\s([\w./~-]+)\s*$/m, f: (m) => mk('file', '고침', tailPath(m[1])) },
  { re: /\b(rm|mv|cp)\s+(-\w+\s+)*([\w./~-]+)/, f: (m) => mk('file', m[1] === 'rm' ? '지움' : m[1] === 'mv' ? '옮김' : '복사', tailPath(m[3])) },
  // 과정
  { re: /run-tests|\bnpm (run )?test\b|\bvitest\b|\bjest\b/, f: () => mk('cmd', '검사', '테스트를 돌림') },
  { re: /npm run build|\btsc\b|check-css-drops|check-imports/, f: () => mk('cmd', '검사', '빌드·검사를 돌림') },
];
// 들여다보기만 한 명령(파일·목록·상태 조회) — 사건이 아니다. 적지 않는다.
const LOOK_ONLY = /^\s*(cat|sed -n|head|tail|less|grep|rg|ls|find|wc|which|echo|pwd|git (log|status|diff|show|branch|fetch)|curl -s|node -e|python3? -c)\b/m;
function classifyBash(cmd: string, desc?: string): TrailClass | null {
  const c = String(cmd || '');
  if (!c.trim()) return null;
  for (const r of CMD_RULES) { const m = c.match(r.re); if (m) return r.f(m, c); }
  if (LOOK_ONLY.test(c)) return null;
  // 그 밖의 명령 — 무슨 명령인지만(첫 낱말). description 은 영어일 수 있어 쓰지 않는다.
  const first = (c.trim().split(/\s+/)[0] || '명령').replace(/^.*\//, '');
  return mk('cmd', '실행', short(desc && /[가-힣]/.test(desc) ? desc : first, 40), { tier: 3 });
}

/** tool_use 한 건 → 타임라인 항목(해당 없으면 null). 순수 함수 — 테스트가 그대로 부른다. */
export function classifyToolUse(name: string, input: any): TrailClass | null {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  switch (name) {
    case 'Read': return isJunkPath(o.file_path) ? null : mk('file', '읽음', tailPath(o.file_path));
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': {
      const f = o.file_path ?? o.notebook_path;
      return isJunkPath(f) ? null : mk('file', '고침', tailPath(f));
    }
    case 'Write': return isJunkPath(o.file_path) ? null : mk('file', '씀', tailPath(o.file_path));
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
  // 작업 기록은 **서버가 정본**이다(loadSessionActivities 가 같은 것을 커밋·지식까지 붙여 싣는다) — 여기서 또 만들면 두 줄이 된다.
  if (t === 'activity_log') return null;
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

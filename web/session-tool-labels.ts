// session-tool-labels.ts — 세션 대화창(#1719)의 도구 이름 → Claude Code 식 `이름 대상` 한 줄.
//  Claude Code 는 `Read(src/x.ts)`·`Bash(npm test)` 처럼 도구 이름 옆에 **대상**을 붙여 한 줄로 보인다. 그 자리를 사람 말로 옮긴다.
//  ⚠ 모르는 이름은 그대로 둔다(틀린 한국어보다 낯선 영어 한 줄이 낫다 — liv-chat.ts 와 같은 원칙). 순수 함수 — DOM 없음.
import type { ToolLabel } from './chat-view.js';

// ── 도구 이름 → Claude Code 식 `이름 대상` 한 줄 ─────────────────────────────────────────────
const TOOL_KO: Record<string, string> = {
  Read: '읽기', Edit: '고치기', Write: '쓰기', MultiEdit: '고치기', NotebookEdit: '노트북 고치기',
  Bash: '명령', Grep: '찾기', Glob: '파일 찾기', LS: '목록', WebFetch: '웹 읽기', WebSearch: '웹 검색',
  Task: '보조 에이전트', Agent: '보조 에이전트', TodoWrite: '할 일', AskUserQuestion: '물어보기', Skill: '스킬',
  ToolSearch: '도구 찾기', ExitPlanMode: '계획 끝', EnterPlanMode: '계획 시작', Workflow: '워크플로', Artifact: '아티팩트',
};
const short = (s: unknown, n = 90): string => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const tailPath = (p: unknown): string => { const s = String(p ?? ''); const parts = s.split('/').filter(Boolean); return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : s; };
export function toolLabel(name: string, input: unknown): ToolLabel {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');            // mcp__<server>__<tool>
    const server = parts[1] === 'lively' ? '라이블리' : parts[1] || 'MCP';
    return { label: server, detail: short(parts.slice(2).join('__') || name, 60) };
  }
  const label = TOOL_KO[name] ?? name;
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return { label, detail: tailPath(o.file_path ?? o.notebook_path ?? o.path) };
    case 'Bash': return { label, detail: short(o.description || o.command, 100) };
    case 'Grep': return { label, detail: short(o.pattern) + (o.path ? '  ' + tailPath(o.path) : '') };
    case 'Glob': return { label, detail: short(o.pattern) };
    case 'WebFetch': case 'WebSearch': return { label, detail: short(o.url ?? o.query, 100) };
    case 'Task': case 'Agent': return { label, detail: short(o.description ?? o.prompt, 100) };
    case 'TodoWrite': { const todos = Array.isArray(o.todos) ? o.todos as any[] : []; const done = todos.filter((t) => t && t.status === 'completed').length; return { label, detail: todos.length ? `${todos.length}개 · 끝남 ${done}` : '' }; }
    case 'Skill': return { label, detail: short(o.skill ?? o.name, 60) };
    case 'AskUserQuestion': { const qs = Array.isArray(o.questions) ? o.questions as any[] : []; return { label, detail: short(qs[0]?.question ?? '', 100) }; }
    default: {
      const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url ?? o.description ?? o.name;
      return { label, detail: typeof pick === 'string' ? short(pick, 90) : '' };
    }
  }
}


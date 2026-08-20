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
// ── MCP 서버 이름 → 사람 말 (#1823) ────────────────────────────────────────────────────────
//  ⚠ 한 계열을 한쪽만 번역하면 **같은 계열 호출이 서로 다른 것처럼 보인다.** 실측: '라이블리' 옆에 'lively-local' 이
//   영문으로 앉아, 사람이 그 둘을 같은 라이블리 호출로 읽지 못하고 "라이블리를 안 불렀다"고 판단했다.
//  Map 인 이유: 서버 이름이 그대로 키가 되므로 객체면 'constructor' 같은 이름이 프로토타입 값을 집는다.
const MCP_SERVER_KO = new Map<string, string>([
  ['lively', '라이블리'],
  ['lively-local', '라이블리 로컬'],
]);
/**
 * 하네스는 플러그인 MCP 를 `plugin:<플러그인>:<서버>` 로 싣고 도구 이름엔 `_` 로 눌러 담는다
 * (`plugin:playwright:playwright` → `plugin_playwright_playwright`). 플러그인과 서버 이름이 같으면 같은 낱말이
 * 두 번 붙어 접힌 줄 하나를 통째로 먹는다 — 그 **기계적 중복만** 걷어낸다(번역이 아니라 정규화라 원칙과 무충돌).
 * 이름이 서로 다르면(`plugin_foo_bar`) 무엇이 플러그인이고 무엇이 서버인지 우리가 모르므로 그대로 둔다.
 */
const dedupePluginServer = (s: string): string => {
  const m = /^plugin_(.+)_(.+)$/.exec(s);
  return m && m[1] === m[2] ? m[1] : s;
};
/** 모르는 서버는 영문 그대로 — 틀린 한국어보다 낯선 영어 한 줄이 낫다(이 파일의 원칙). */
const mcpServerLabel = (raw: string): string => (raw ? MCP_SERVER_KO.get(raw) ?? dedupePluginServer(raw) : 'MCP');

const short = (s: unknown, n = 90): string => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const tailPath = (p: unknown): string => { const s = String(p ?? ''); const parts = s.split('/').filter(Boolean); return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : s; };
export function toolLabel(name: string, input: unknown): ToolLabel {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');            // mcp__<server>__<tool>
    return { label: mcpServerLabel(parts[1] || ''), detail: short(parts.slice(2).join('__') || name, 60) };
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


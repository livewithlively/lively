// session-trail.ts — 세션 트랜스크립트의 **도구 사용 한 건 → 타임라인 항목** 분류(#1719).
//
//  세션 화면(session-chat.ts)이 대화 파일을 줄 단위로 읽으며 tool_use 를 여기로 넘긴다. 그 판정이
//  우패널 타임라인(web/timeline.ts)의 재료다. 별도 서버 로그를 기다리지 않아도 되고(mcp_call_log 에는
//  session_id 가 없다, #1578) 라이브로 자란다.
//
//  ⚠ 무엇을 적나 — 상민님 2026-08-18: "일반 사용자가 커밋 sha 를 볼 필요가 있겠어? 가장 작은 단위에서도
//   **꼭 필요하다 중요하다고 생각되는 내용만**." 그래서 이 분류기는 **남은 것만** 만든다:
//     새로 만든/고친 작업 파일 · 남긴 지식 · 커밋(메시지만) · 만든 프로젝트/태스크 · 끝낸 태스크.
//   읽기·검색·조회·빌드·테스트·배포·PR·일반 명령은 **항목을 만들지 않는다**(접는 게 아니라 없다).
//   파일은 대상 경로가 드러날 때만 파일이라 부른다 — 실측상 편집 상당수가 Bash 안(heredoc·sed·tee)에서 일어난다.
//
//  위젯은 여기 없다 — 그리는 일은 web/timeline.ts 한 곳이 한다(발자취·프로젝트·워크스페이스가 같은 부품).
import { humanTitle } from './timeline.js';
const tailPath = (p) => { const s = String(p ?? ''); const parts = s.split('/').filter(Boolean); return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : s; };
const mk = (kind, verb, label, extra) => ({ kind, verb, label, key: `${kind}|${verb}|${label}`, ...extra });
// ── 무엇을 **안 적을지**(상민님 2026-08-18: "쓸데없는 얘기가 많다 · 중요한 줄기만") ──
//  타임라인은 일한 자취지 실행 기록이 아니다. 작업물이 아닌 것(임시파일·스크린샷·로그)과
//  들여다보기만 한 명령(cat·grep·ls)은 아예 적지 않는다 — 접어 두는 게 아니라 사건이 아니다.
const JUNK_PATH = /(^|\/)(tmp|scratchpad|node_modules|dist|\.cache|\.git|public\/app)(\/|$)|\.(png|jpe?g|gif|svg|log|jsonl|lock|tsbuildinfo[\w-]*)$/i;
const isJunkPath = (p) => { const t = String(p ?? ''); return !t || JUNK_PATH.test(t); };
// ── Bash → 남은 것만 ────────────────────────────────────────────────────────
const CMD_RULES = [
    // 커밋 — 메시지 한 줄만. sha·레포는 사람이 읽을 것이 아니다(툴팁에도 안 넣는다).
    //  ⚠ -m "$(cat <<'EOF' …)" 로 쓴 커밋은 따옴표 뒤가 명령 치환이라 그걸 제목으로 삼으면 안 된다(실측: 제목이 `$(cat <<'EOF'` 가 됐다).
    //   그런 꼴은 건너뛰고 아래 heredoc 규칙이 **본문 첫 줄**을 집게 한다.
    { re: /\bgit commit\b[\s\S]*?-m\s+["'](?!\$\()([^"'\n]+)/, f: (m) => commitItem(m[1]) },
    { re: /\bgit commit\b[\s\S]*?<<\s*'?\w+'?\s*\n([^\n]+)/, f: (m) => commitItem(m[1]) },
    // 파일 — 대상이 명령에 드러난 경우만. (python heredoc 편집이 실제로 가장 흔하다)
    { re: /p\s*=\s*['"]([^'"\n]+)['"][\s\S]{0,4000}?open\(\s*p\s*,\s*['"]w/, f: (m) => mk('file', '고침', tailPath(m[1])) },
    { re: /open\(\s*['"]([^'"\n]+)['"]\s*,\s*['"]w/, f: (m) => mk('file', '고침', tailPath(m[1])) },
    { re: /\btee\s+(?:-a\s+)?([\w./~-]+)/, f: (m) => mk('file', '씀', tailPath(m[1])) },
    { re: /(?:^|\n|&&|\|\|)\s*cat\s*>\s*([\w./~-]+)/, f: (m) => mk('file', '씀', tailPath(m[1])) },
    { re: /\bsed\s+-i\b[^\n]*?\s([\w./~-]+)\s*$/m, f: (m) => mk('file', '고침', tailPath(m[1])) },
];
// 커밋이 다 같은 무게는 아니다 — 메시지의 관례 접두어가 이미 '무엇이 생겼다'와 '치웠다'를 가른다.
//  feat·design·fix·perf 는 화면에 남고, chore·docs·test·build·ci·style·refactor·revert 는 과정으로 접힌다.
//  접두어가 없으면 사람이 자기 말로 쓴 것이니 남기는 쪽(결과)으로 둔다 — 놓치는 것보다 낫다.
const COMMIT_CHORE = /^(chore|docs|test|build|ci|style|refactor|revert|wip)\b/i;
const commitItem = (raw) => mk('cmd', '커밋', humanTitle(raw), { tier: COMMIT_CHORE.test(String(raw).trim()) ? 3 : 1 });
function classifyBash(cmd) {
    const c = String(cmd || '');
    if (!c.trim())
        return null;
    for (const r of CMD_RULES) {
        const m = c.match(r.re);
        if (m) {
            const t = r.f(m);
            return t.kind === 'file' && isJunkPath(t.label) ? null : t;
        }
    }
    return null; // 그 밖의 명령은 사건이 아니다
}
/** tool_use 한 건 → 타임라인 항목(남은 것이 아니면 null). 순수 함수. */
export function classifyToolUse(name, input) {
    const o = (input && typeof input === 'object' ? input : {});
    switch (name) {
        case 'Edit':
        case 'MultiEdit':
        case 'NotebookEdit': {
            const f = o.file_path ?? o.notebook_path;
            return isJunkPath(f) ? null : mk('file', '고침', tailPath(f));
        }
        case 'Write': return isJunkPath(o.file_path) ? null : mk('file', '씀', tailPath(o.file_path));
        case 'Bash': return classifyBash(o.command);
    }
    if (!name.startsWith('mcp__lively__'))
        return null;
    const t = name.slice('mcp__lively__'.length);
    // 지식 — 남긴 것만(읽고 찾아본 것은 결과가 아니다). 제목은 한 줄로 자른다.
    if (t === 'knowledge_save') {
        const nm = String(o.name || '');
        return mk('knowledge', o.mode === 'append' ? '덧붙임' : o.mode === 'edit' ? '고침' : '남김', humanTitle(o.title || nm, 52), { href: nm ? '#/k/' + encodeURIComponent(nm) : null });
    }
    // 만든 것 · 끝낸 것
    if (t === 'project_create_v6')
        return mk('project', '만듦', humanTitle(o.name, 48));
    if (t === 'task_create_v6')
        return mk('task', '만듦', humanTitle(o.name, 48));
    if (t === 'task_set_status_v6' && o.status === 'done')
        return mk('task', '끝냄', '#' + String(o.id ?? ''), { href: o.id ? '#/projects2/t/' + o.id : null });
    return null; // 조회·수정·검색·기록은 화면에 남기지 않는다(작업 기록은 서버가 정본)
}

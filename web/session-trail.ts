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
import { apiUrl, TOKEN_KEY } from './core.js';
import { humanTitle, type TimelineHandle, type TlKind, type TlTier } from './timeline.js';

/** session-chat.ts 가 받는 싱크 타입(이름 유지 — 호출부 무변경). */
export type TrailWidget = TimelineHandle;

export interface TrailClass {
  kind: TlKind; verb: string; label: string; key: string;
  detail?: string; href?: string | null; tier?: TlTier;
}

const tailPath = (p: unknown): string => { const s = String(p ?? ''); const parts = s.split('/').filter(Boolean); return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : s; };
const mk = (kind: TlKind, verb: string, label: string, extra?: Partial<TrailClass>): TrailClass =>
  ({ kind, verb, label, key: `${kind}|${verb}|${label}`, ...extra });

// ── 무엇을 **안 적을지**(상민님 2026-08-18: "쓸데없는 얘기가 많다 · 중요한 줄기만") ──
//  타임라인은 일한 자취지 실행 기록이 아니다. 작업물이 아닌 것(임시파일·스크린샷·로그)과
//  들여다보기만 한 명령(cat·grep·ls)은 아예 적지 않는다 — 접어 두는 게 아니라 사건이 아니다.
const JUNK_PATH = /(^|\/)(tmp|scratchpad|node_modules|dist|\.cache|\.git|public\/app)(\/|$)|\.(png|jpe?g|gif|svg|log|jsonl|lock|tsbuildinfo[\w-]*)$/i;
const isJunkPath = (p: unknown): boolean => { const t = String(p ?? ''); return !t || JUNK_PATH.test(t); };

// ── Bash → 남은 것만 ────────────────────────────────────────────────────────
const CMD_RULES: Array<{ re: RegExp; f: (m: RegExpMatchArray) => TrailClass }> = [
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
const commitItem = (raw: string): TrailClass =>
  mk('cmd', '커밋', humanTitle(raw), { tier: COMMIT_CHORE.test(String(raw).trim()) ? 3 : 1 });

function classifyBash(cmd: string): TrailClass | null {
  const c = String(cmd || '');
  if (!c.trim()) return null;
  for (const r of CMD_RULES) { const m = c.match(r.re); if (m) { const t = r.f(m); return t.kind === 'file' && isJunkPath(t.label) ? null : t; } }
  return null;                                   // 그 밖의 명령은 사건이 아니다
}

/** tool_use 한 건 → 타임라인 항목(남은 것이 아니면 null). 순수 함수. */
export function classifyToolUse(name: string, input: any): TrailClass | null {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  switch (name) {
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': {
      const f = o.file_path ?? o.notebook_path;
      return isJunkPath(f) ? null : mk('file', '고침', tailPath(f));
    }
    case 'Write': return isJunkPath(o.file_path) ? null : mk('file', '씀', tailPath(o.file_path));
    case 'Bash': return classifyBash(o.command);
  }
  if (!name.startsWith('mcp__lively__')) return null;
  const t = name.slice('mcp__lively__'.length);
  // 지식 — 남긴 것만(읽고 찾아본 것은 결과가 아니다). 제목은 한 줄로 자른다.
  if (t === 'knowledge_save') {
    const nm = String(o.name || '');
    return mk('knowledge', o.mode === 'append' ? '덧붙임' : o.mode === 'edit' ? '고침' : '남김',
      humanTitle(o.title || nm, 52), { href: nm ? '#/k/' + encodeURIComponent(nm) : null });
  }
  // 만든 것 · 끝낸 것
  if (t === 'project_create_v6') return mk('project', '만듦', humanTitle(o.name, 48));
  if (t === 'task_create_v6') return mk('task', '만듦', humanTitle(o.name, 48));
  if (t === 'task_set_status_v6' && o.status === 'done') return mk('task', '끝냄', '#' + String(o.id ?? ''), { href: o.id ? '#/projects2/t/' + o.id : null });
  return null;                                   // 조회·수정·검색·기록은 화면에 남기지 않는다(작업 기록은 서버가 정본)
}


// ══ 세션 되감기(#1819) — 타임라인은 대화창의 창이 아니라 **세션 전체**를 본다 ═══════════════
//  왜 여기냐: 재료를 만드는 규칙(무엇이 사람 말인가·무엇이 답인가·무엇이 남은 것인가)은 한 벌이어야 한다.
//  라이브(session-chat 이 한 줄씩)와 되감기(아래 replayTrail 이 통째로)가 **같은 함수**를 쓴다.
//
//  ⚠ 왜 되감기가 필요했나 — 실측 #1819: 20.3MB 세션에서 대화창의 창(꼬리 1.5MB)은 전체의 7.4% 였고,
//   질문 15개 중 **14개가 창 밖**이라 타임라인에 2줄만 떴다. 서버의 얇은 판(fmt=thin, 2.24%)이 그 벽을 없앤다.

// ── 사람 말 걸러내기(대화창과 공용) ──
export const INJECTED_RE = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|Caveat:)/;
export const INTERRUPT_RE = /^\s*\[Request interrupted/;
export const CONTINUED_RE = /^\s*This session is being continued/;

/** 여러 줄에서 **첫 뜻있는 줄**(또는 그 첫 문장)만. 통째로 이으면 제목이 벽이 된다. */
export const firstLine = (t: string): string => {
  const ln = String(t || '').split('\n').map((x) => x.trim()).find((x) => x.length > 1) || '';
  const dot = ln.search(/[.?!。]\s/);
  return (dot > 8 ? ln.slice(0, dot + 1) : ln).trim();
};
export const cut = (t: string, n: number): string => (t.length > n ? t.slice(0, n - 1).replace(/[\s·,]+$/, '') + '…' : t);
/** 마크다운 부호는 화면 말이 아니다 — 답 한 줄은 '## 결론' 이 아니라 '결론' 이어야 한다. */
export const plain = (t: string): string => t.replace(/^\s*(?:[#>]+|[*\-•]\s)\s*/, '').replace(/\*\*|`|~~/g, '').trim();
/** 답이 아닌 것 — 하네스가 '할 말 없음'을 적어 두는 상용구. 장의 마지막 텍스트면 진짜 답을 밀어낸다. */
export const NO_ANSWER_RE = /^\s*(?:no response requested\.?|\(no content\)|\[no content\]|null)\s*$/i;

// ── 붙여넣은 덩어리 가리기 ──
//  로그를 통째로 붙여넣은 지시가 제목이 되면 그 한 장이 타임라인을 다 먹는다. **사람이 친 한 줄**만 세우고
//  나머지는 '붙여넣은 글 N줄' 칩으로 접는다(전문은 항목을 눌러서).
const PASTE_LINES = 8;
const PASTE_CHARS = 400;
const HUMAN_LINE = 120;
export function sayParts(raw: string): { label: string; pasteLines?: number; full?: string } {
  const text = String(raw || '');
  const lines = text.split('\n').map((x) => x.trim()).filter((x) => x.length > 0);
  const heavy = lines.length > PASTE_LINES || text.length > PASTE_CHARS;
  const head = lines[0] || '';
  const tail = lines[lines.length - 1] || '';
  const pick = !heavy ? text : (head.length <= HUMAN_LINE ? head : tail.length <= HUMAN_LINE ? tail : head);
  const label = cut(firstLine(pick), 110);
  const rest = lines.length - 1;
  return {
    label: label || '(빈 지시)',
    pasteLines: heavy && rest > 0 ? rest : undefined,
    full: text.trim().length > label.length ? text.slice(0, 4000) : undefined,
  };
}

const turnKey = (o: any, text: string): string => String(o.uuid || o.timestamp || String(text).slice(0, 40));

/** 사람 말 한 줄 → 장(章)의 머리. */
export function trailSay(w: TimelineHandle, o: any, text: string, at: 'end' | 'start'): void {
  const q = sayParts(text);
  const k = turnKey(o, text);
  w.add({ id: 'turn:' + k, kind: 'say', verb: '지시', label: q.label, full: q.full, pasteLines: q.pasteLines,
    key: 'turn|' + k, ts: o.timestamp }, at);
}

/** AI 한 줄 → 도구 사용은 그 장에 **남은 것**으로, 텍스트는 그 장의 **답**으로.
 *  ⚠ at='start'(되그리기)는 앞으로 밀어 넣으므로 블록을 거꾸로 넣어야 원래 순서가 산다. */
export function trailMsg(w: TimelineHandle, o: any, at: 'end' | 'start'): void {
  const meta = !!o.isMeta;                       // 사람에게 한 말이 아니다(하네스 내부 줄)
  const c = o?.message?.content;
  const blocks: any[] = Array.isArray(c) ? c : (typeof c === 'string' && c.trim() ? [{ type: 'text', text: c }] : []);
  const emit = (b: any, i: number): void => {
    if (b && b.type === 'tool_use' && b.id) {
      const cls = classifyToolUse(String(b.name ?? ''), b.input);
      if (cls) w.add({ ...cls, id: String(b.id), ts: o.timestamp }, at);
      return;
    }
    if (!b || b.type !== 'text' || meta) return;
    const raw = String(b.text ?? '');
    if (NO_ANSWER_RE.test(raw)) return;
    const t = plain(raw).trim();
    if (!t || NO_ANSWER_RE.test(t)) return;
    // 한 장에 답은 여러 번 온다("확인하겠습니다" → 도구 → … → 최종 답). 렌더러가 **마지막 것**만 세우므로
    //  열쇠를 고유하게 둔다 — 합치면 첫 마디가 굳어 최종 답이 영영 안 보인다.
    const id = 'ans:' + String(o.uuid || o.timestamp || '') + '#' + i;
    w.add({ id, kind: 'reply', verb: '답함', label: cut(firstLine(t), 96), key: id, ts: o.timestamp }, at);
  };
  if (at === 'start') for (let i = blocks.length - 1; i >= 0; i--) emit(blocks[i], i);
  else blocks.forEach(emit);
}

/** 얇은 대화록(ndjson) 통째 → 타임라인. 항목 id 가 같으면 위젯이 알아서 무시하므로 라이브와 겹쳐도 안전하다. */
export function replayTrail(w: TimelineHandle, ndjson: string): void {
  for (const line of String(ndjson || '').split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object' || o.isSidechain) continue;
    if (o.type === 'user') {
      const c = o.message && o.message.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text') text += (text ? '\n' : '') + String(b.text ?? '');
          else if (b.type === 'tool_result' && b.tool_use_id) w.result(String(b.tool_use_id), '', !!b.is_error);
        }
      }
      if (o.isMeta || !text.trim()) continue;
      if (INTERRUPT_RE.test(text) || CONTINUED_RE.test(text) || INJECTED_RE.test(text)) continue;
      trailSay(w, o, text, 'end');
      continue;
    }
    if (o.type === 'assistant') trailMsg(w, o, 'end');
  }
}

/** 서버의 얇은 판을 받아 타임라인에 통째로 붓는다. 돌려주는 값으로 '앞이 잘렸나'를 안다. */
export async function loadThinTrail(w: TimelineHandle, s: { id: string; node?: string | null; logId?: string | null; logNode?: string | null }):
  Promise<{ ok: boolean; from: number; bytes: number }> {
  const node = String(s.node || s.logNode || '');
  const sid = node ? String(s.logId || s.id) : s.id;
  const path = node
    ? `/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?node=${encodeURIComponent(node)}&fmt=thin`
    : `/api/ui/terminal/sessions/${encodeURIComponent(sid)}/transcript?fmt=thin`;
  const headers: Record<string, string> = {};
  const tok = localStorage.getItem(TOKEN_KEY); if (tok) headers.Authorization = 'Bearer ' + tok;
  try {
    const res = await fetch(apiUrl(path), { headers, credentials: 'same-origin' });
    if (!res.ok) return { ok: false, from: 0, bytes: 0 };
    const text = await res.text();
    const n = (h: string): number => { const v = Number(res.headers.get(h)); return Number.isFinite(v) ? v : 0; };
    replayTrail(w, text);
    w.sortByTime();                              // 라이브가 먼저 들어와 있어도 시간순으로 다시 세운다
    return { ok: true, from: n('X-Log-From'), bytes: n('X-Log-Bytes') };
  } catch (_) { return { ok: false, from: 0, bytes: 0 }; }
}

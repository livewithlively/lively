// chat-tui.ts — 세션 대화창을 **Claude Code TUI 와 같은 글자**로 그리는 규칙(#4707). 순수 함수 — DOM·전역 없음.
//
//  ── 왜 ──
//  상민님 지시(2026-10-14): «세션 대화창 ui를 클로드코드 tui랑 최대한 똑같이 바꿔». 세션 화면은 같은 세션을 [터미널]과
//  [대화] 두 겹으로 보여 주는데, 터미널 쪽은 Claude Code 가 직접 그린 화면이고 대화 쪽은 우리가 그린 말풍선이라 두 화면을
//  오가면 같은 세션이 다른 물건처럼 보였다. 대화 런타임 세션(runtimeMode='chat')은 pane 에 TUI 가 없어 이 대화창이 곧
//  Claude Code 의 얼굴이다. 그래서 대화창이 터미널과 **같은 줄 문법**을 쓴다:
//   · 도구 머리   `⏺ Bash(npm test)` · `⏺ Update(web/x.ts)` · `⏺ lively - knowledge_get (MCP)(name: "…")`
//   · 도구 결과   `⎿  Read 120 lines` · `⎿  Found 3 files` · `⎿  Updated web/x.ts with 2 additions and 1 removal` · 앞 3줄 + `… +N lines`
//   · 스피너      `✻ Cogitating… (12s · ↓ 1.2k tokens · esc to interrupt)`
//   · 권한 모드   `⏵⏵ accept edits on` · `⏸ plan mode on` (기본 모드면 `? for shortcuts`)
//  화면(chat-view.ts 의 tui 문법)은 여기서 나온 값을 칠하기만 한다 — 글자 규칙이 틀려도 화면은 멀쩡해 보이므로
//  (그럴듯한 한 줄이라 아무도 버그로 신고하지 않는다, #1822 의 교훈) 규칙만 따로 떼어 scripts/chat-tui.test.mjs 가 잰다.
//
//  ── 글자는 Claude Code 의 것을 그대로 쓴다 ──
//  `Read 120 lines`·`esc to interrupt`·`ctrl+o to expand` 는 영어다. 터미널 보기에서 사람이 이미 보는 글자가 그것이라
//  두 보기가 같은 말을 해야 한다. 라이블리가 덧붙이는 안내(전달 대기·멈춘 세션 등)는 종전대로 한국어로 남는다.
//
//  ── 지키는 것 ──
//  · 원문을 버리지 않는다 — 접을 뿐이다(full). 펼치면(클릭·Ctrl+O) 그게 '진짜 했다'의 증거다(chat-view.ts 원칙).
//  · 모르는 도구는 이름 그대로 + `key: "value"` 인자(Claude Code 의 기본 표시와 같다).
//  · 세지 못한 수는 지어내지 않는다 — 하네스가 준 값(toolUseResult)이 먼저고, 없으면 본문 줄을 센다.

/** 도구 머리 한 줄 — `⏺ {name}({args})`. args 가 비면 괄호를 안 그린다(`⏺ Update Todos`). */
export interface TuiHead { name: string; args: string }

/** 변경분 한 줄. no = 그 줄의 번호(모르면 null — 하네스가 패치를 안 준 경우), hl = 짝 줄과 달라진 구간 [시작, 끝). */
export interface TuiDiffRow { kind: 'add' | 'del' | 'ctx' | 'gap'; no: number | null; text: string; hl?: [number, number] }

export interface TuiTodo { text: string; status: 'pending' | 'in_progress' | 'completed' }

/** 도구 결과 — `⎿` 아래에 무엇을 몇 줄 보이고, 펼치면 무엇이 더 나오나. */
export interface TuiResult {
  summary?: string;          // 첫 줄 요약(`Read 120 lines`) — 없으면 lines 가 첫 줄부터 선다
  sumSegs?: TuiSeg[];        // 꾸민 요약(`Added **12** lines, removed **7** lines`) — 있으면 summary 대신 이것을 칠한다
  lines: string[];           // 접힌 상태에서 보이는 줄
  more: number;              // 접혀서 안 보이는 줄 수 — 0 보다 크면 `… +N lines (ctrl+o to expand)`
  full?: string;             // 펼치면 보일 원문(요약만 있는 결과도 펼치면 본문이 나온다)
  diff?: TuiDiffRow[];       // Update · Write(덮어쓰기)
  code?: string[];           // Write(새 파일)의 앞부분 — 줄 번호(1부터)를 붙여 문법 색으로 칠한다
  lang?: string;             // 변경분·미리보기 글의 언어(파일 확장자) — 문법 색칠용
  todos?: TuiTodo[];         // Update Todos
  tone?: 'err' | 'subtle';   // 결과 전체가 오류(빨강) · 거절(옅은 회색 — Claude Code 의 subtle)
  //  셸 명령이 바꾼 파일들 — 파일마다 따로 선 `⎿  Updated **경로** (+a -r)` + 변경분(파일당 40줄, 넘치면 `… N more lines`).
  edits?: Array<{ segs: TuiSeg[]; diff: TuiDiffRow[]; hidden: number; lang: string }>;
  notes?: string[];          // 따로 선 흐린 `⎿` 줄들(`… 3 more files changed` · git 안내)
}

/**
 * 셸 명령의 결과에 «바뀐 파일» 이 실렸나 — 그러면 Claude Code 는 그 명령을 묶음에서 빼내 따로 세우고 변경분을 보인다
 *  (2.1.299: toolUseResult.bashEditDiff. 건너뛰었거나 아무 파일도 못 센 «모름» 이면 빼지 않는다).
 */
export function bashPopsOut(meta: unknown): boolean {
  const d = obj(obj(meta).bashEditDiff);
  if (!obj(meta).bashEditDiff) return false;
  const files = Array.isArray(d.files) ? d.files : [];
  return !(d.skipped || (d.unavailable && files.length === 0 && !(Number(d.moreFiles) > 0)));
}
/** 그 명령에 작업 폴더를 옮길 수 있는 git 단계가 있나(그러면 Claude Code 는 변경분 대신 파일 줄만 보이고 안내를 붙인다). */
const GIT_MOVES_TREE = /\bgit\s+(?:-C\s+\S+\s+)?(?:checkout|switch|reset|rebase|merge|pull|stash|cherry-pick|revert|am|apply|restore|worktree|bisect)\b/;

/** 접힌 결과가 보이는 줄 수 — Claude Code 가 Bash·MCP 출력을 접을 때의 줄 수. */
export const TUI_PREVIEW_LINES = 3;
/** Write 가 새 파일을 만들 때 보여 주는 앞부분 줄 수. */
export const TUI_WRITE_LINES = 10;
/** 한 줄이 이보다 길면 접힌 화면에서 자른다(펼치면 전부). 압축된 JSON 한 줄이 화면을 덮지 않게. */
const LINE_CLIP = 400;
/** 펼친 원문의 상한 — 이보다 길면 끝에 남은 양을 적는다(브라우저가 수 MB 글자를 한 블록에 그리다 멈추지 않게). */
export const TUI_FULL_MAX = 60_000;
/** 변경분 줄 수 상한(접힌 상태). 넘으면 `… +N lines`. */
export const TUI_DIFF_ROWS = 60;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const plural = (n: number, one: string, many?: string): string => `${n} ${n === 1 ? one : (many ?? one + 's')}`;

/** 줄로 나눈다 — 끝의 빈 줄·줄끝 공백은 버린다(Claude Code 도 출력 끝을 다듬어 보인다). */
export function splitLines(text: string): string[] {
  const t = str(text).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return t ? t.split('\n').map((l) => l.replace(/\s+$/, '')) : [];
}

/** 작업 폴더 안의 경로는 상대 경로로(Claude Code 와 같다). 밖이면 그대로. */
export function relPath(p: unknown, cwd?: string | null): string {
  const s = str(p);
  const c = str(cwd).replace(/\/+$/, '');
  if (!s || !c) return s;
  if (s === c) return '.';
  return s.startsWith(c + '/') ? s.slice(c.length + 1) : s;
}

/** 값 하나를 머리 인자로 — 글자는 따옴표, 나머지는 JSON. 길면 자른다. */
function argVal(v: unknown, max = 80): string {
  let s: string;
  try { s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v); } catch { s = String(v); }
  if (s === undefined) s = String(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
/** `key: "value", key2: 3` — Claude Code 가 모르는 도구·MCP 도구의 입력을 머리에 적는 꼴. */
export function kvArgs(input: unknown, keys?: string[], max = 240): string {
  const o = obj(input);
  const ks = keys ? keys.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '') : Object.keys(o);
  const s = ks.map((k) => `${k}: ${argVal(o[k])}`).join(', ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * MCP 서버의 원래 이름 — 도구 이름(`mcp__<서버>__<도구>`)엔 서버 이름이 눌린 꼴로 들어온다(`:`·빈칸이 `_` 로). Claude Code 는
 *  원래 이름을 찍는다(2.1.299 실측: `Calling plugin:playwright:playwright`). 그래서 알려진 두 꼴을 되살린다:
 *  플러그인 `plugin_<플러그인>_<서버>` → `plugin:<플러그인>:<서버>` · claude.ai 커넥터 `claude_ai_Claude_Docs` → `claude.ai Claude Docs`.
 */
export const mcpServer = (raw: string): string => {
  const s = str(raw);
  const m = /^plugin_([^_]+)_(.+)$/.exec(s);
  if (m) return `plugin:${m[1]}:${m[2]}`;
  if (/^claude_ai_/.test(s)) return 'claude.ai ' + s.slice('claude_ai_'.length).replace(/_/g, ' ');
  return s;
};

/** 도구 이름 + 입력 → Claude Code 가 그리는 머리 한 줄. */
export function tuiToolHead(name: string, input: unknown, cwd?: string | null): TuiHead {
  const o = obj(input);
  const rel = (p: unknown): string => relPath(p, cwd);
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');            // mcp__<server>__<tool>
    const server = mcpServer(parts[1] || 'mcp');
    const tool = parts.slice(2).join('__') || name;
    return { name: `${server} - ${tool} (MCP)`, args: kvArgs(o) };
  }
  switch (name) {
    //  셸 명령 — 원문의 줄바꿈을 살려 **두 줄까지**, 둘째 줄은 6칸에서 시작하고 더 있으면 `…`(2.1.299 실측: `⏺ Bash(python3 - <<'EOF'` /
    //   `      p='web/chat-view.ts'…)`). 머리 칸이 2칸 들여 있으니 이어지는 줄 앞에 4칸을 붙인다.
    case 'Bash': case 'PowerShell': {
      const ls = str(o.command).replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
      return { name, args: ls.slice(0, 2).join('\n    ') + (ls.length > 2 ? '…' : '') };
    }
    case 'Read': return { name: 'Read', args: rel(o.file_path ?? o.path) };
    case 'Edit': case 'MultiEdit': return { name: 'Update', args: rel(o.file_path) };
    case 'Write': return { name: 'Write', args: rel(o.file_path) };
    case 'NotebookEdit': return { name: 'Edit Notebook', args: rel(o.notebook_path) };
    case 'Glob': return { name: 'Search', args: kvArgs({ pattern: o.pattern, path: o.path ? rel(o.path) : undefined }) };
    case 'Grep': return { name: 'Search', args: kvArgs({ ...o, path: o.path ? rel(o.path) : undefined }, ['pattern', 'path', 'glob', 'type', 'output_mode']) };
    case 'LS': return { name: 'List', args: rel(o.path) };
    case 'WebFetch': return { name: 'Fetch', args: str(o.url) };
    case 'WebSearch': return { name: 'Web Search', args: argVal(str(o.query), 160) };
    //  보조 에이전트 — Claude Code 는 도구 이름 대신 **에이전트 종류**를 머리에 세운다: `feature-dev:code-explorer(Map rename…)`(2.1.299 실측).
    case 'Task': case 'Agent': return { name: str(o.subagent_type) || name, args: str(o.description) };
    case 'TodoWrite': return { name: 'Update Todos', args: '' };
    case 'Skill': return { name: 'Skill', args: str(o.skill ?? o.name) };
    case 'BashOutput': return { name: 'BashOutput', args: kvArgs(o, ['bash_id', 'shell_id', 'filter']) };
    case 'KillShell': case 'KillBash': return { name: 'Kill Shell', args: str(o.shell_id ?? o.bash_id) };
    default: return { name, args: kvArgs(o) };
  }
}

// ── 변경분 ──────────────────────────────────────────────────────────────────────────────
interface Hunk { oldStart?: number; newStart?: number; lines?: unknown[] }

/** 같은 자리의 지운 줄·더한 줄 짝 — 앞뒤가 같은 부분을 걷고 남은 가운데가 «바뀐 낱말»이다(Claude Code 의 낱말 단위 강조). */
function pairHighlight(rows: TuiDiffRow[]): void {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== 'del') { i++; continue; }
    let d = i; while (d < rows.length && rows[d].kind === 'del') d++;
    let a = d; while (a < rows.length && rows[a].kind === 'add') a++;
    const nd = d - i, na = a - d;
    if (nd && nd === na) {
      for (let k = 0; k < nd; k++) {
        const x = rows[i + k], y = rows[d + k];
        let p = 0; const lim = Math.min(x.text.length, y.text.length);
        while (p < lim && x.text[p] === y.text[p]) p++;
        let s = 0;
        while (s < lim - p && x.text[x.text.length - 1 - s] === y.text[y.text.length - 1 - s]) s++;
        const xe = x.text.length - s, ye = y.text.length - s;
        // 줄 전체가 바뀌었으면(공통부가 거의 없으면) 강조하지 않는다 — 줄 배경이 이미 그 말을 한다.
        if (p + s > 0 && xe > p) x.hl = [p, xe];
        if (p + s > 0 && ye > p) y.hl = [p, ye];
      }
    }
    i = Math.max(a, i + 1);
  }
}

/** 하네스가 준 패치(structuredPatch) → 줄번호 붙은 변경분. */
export function diffFromPatch(patch: unknown): TuiDiffRow[] {
  if (!Array.isArray(patch)) return [];
  const rows: TuiDiffRow[] = [];
  (patch as Hunk[]).forEach((h, hi) => {
    if (!h || !Array.isArray(h.lines)) return;
    if (hi > 0) rows.push({ kind: 'gap', no: null, text: '...' });
    let oldNo = Number(h.oldStart) || 1, newNo = Number(h.newStart) || 1;
    for (const raw of h.lines) {
      const l = str(raw);
      const sign = l.charAt(0), text = l.slice(1);
      if (sign === '-') rows.push({ kind: 'del', no: oldNo++, text });
      else if (sign === '+') rows.push({ kind: 'add', no: newNo++, text });
      else if (sign === '\\') continue;                      // «\ No newline at end of file»
      else { rows.push({ kind: 'ctx', no: newNo++, text: sign === ' ' ? text : l }); oldNo++; }
    }
  });
  pairHighlight(rows);
  return rows;
}

/** 줄 단위 최장공통부분열 — 패치가 없을 때 고치기 전·후 글로 변경분을 만든다(번호는 모른다 → null). */
export function diffFromStrings(before: string, after: string): TuiDiffRow[] {
  const a = str(before).replace(/\r\n?/g, '\n').split('\n');
  const b = str(after).replace(/\r\n?/g, '\n').split('\n');
  const rows: TuiDiffRow[] = [];
  // 표가 너무 크면(수천 줄 × 수천 줄) 통째로 지우고 더한 것으로 본다 — 화면 하나를 그리려고 브라우저를 멈추지 않는다.
  if (a.length * b.length > 250_000) {
    for (const t of a) rows.push({ kind: 'del', no: null, text: t });
    for (const t of b) rows.push({ kind: 'add', no: null, text: t });
    return rows;
  }
  const n = a.length, m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ kind: 'ctx', no: null, text: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { rows.push({ kind: 'del', no: null, text: a[i] }); i++; }
    else { rows.push({ kind: 'add', no: null, text: b[j] }); j++; }
  }
  while (i < n) rows.push({ kind: 'del', no: null, text: a[i++] });
  while (j < m) rows.push({ kind: 'add', no: null, text: b[j++] });
  pairHighlight(rows);
  return rows;
}

const countKind = (rows: TuiDiffRow[], k: 'add' | 'del'): number => rows.reduce((n, r) => n + (r.kind === k ? 1 : 0), 0);

/**
 * `Added **12** lines, removed **7** lines` — Claude Code 2.1.299 의 Update 결과 머리(실행 파일 그대로). 0 인 쪽은 말하지 않고,
 *  더한 줄이 없으면 `Removed …` 로 대문자가 앞에 선다. 둘 다 0 이면 빈 배열.
 */
export function editSegs(adds: number, dels: number): TuiSeg[] {
  const out: TuiSeg[] = [];
  if (adds > 0) out.push({ t: 'Added ' }, { t: String(adds), b: true }, { t: adds > 1 ? ' lines' : ' line' });
  if (adds > 0 && dels > 0) out.push({ t: ', ' });
  if (dels > 0) out.push({ t: adds === 0 ? 'Removed ' : 'removed ' }, { t: String(dels), b: true }, { t: dels > 1 ? ' lines' : ' line' });
  return out;
}
/** 파일 경로 → 문법 색칠에 쓸 언어(확장자). */
export const langOf = (p: string): string => { const m = /\.([A-Za-z0-9]+)$/.exec(str(p)); return m ? m[1].toLowerCase() : ''; };

// ── 수·시간 ──────────────────────────────────────────────────────────────────────────────
/** 1234 → `1.2k` (Claude Code 스피너의 토큰 수 꼴). */
export function fmtTokens(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
}
/**
 * 경과 시간 — Claude Code 2.1.299 의 셈을 그대로 옮겼다(실행 파일의 그 함수). 1분 미만은 초를 **내림**(`43s`), 1분부터는 남은 초를
 *  **반올림**하고 60 이 되면 올린다(230602ms → `3m 51s`, 60989ms → `1m 1s`). 시간이 있으면 `1h 2m 3s`, 날이 있으면 `1d 2h 3m`.
 */
export function fmtElapsed(ms: number): string {
  const e = Math.max(0, Number(ms) || 0);
  if (e < 60000) {
    if (e === 0) return '0s';
    if (e < 1) return `${(e / 1000).toFixed(1)}s`;
    return `${Math.floor(e / 1000)}s`;
  }
  let d = Math.floor(e / 86400000), h = Math.floor((e % 86400000) / 3600000), m = Math.floor((e % 3600000) / 60000), s = Math.round((e % 60000) / 1000);
  if (s === 60) { s = 0; m++; }
  if (m === 60) { m = 0; h++; }
  if (h === 24) { h = 0; d++; }
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
/** 바이트 → `12.3KB` (Fetch 결과 꼴). */
export function fmtBytes(b: number): string {
  const v = Math.max(0, Number(b) || 0);
  if (v < 1024) return `${v} bytes`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1).replace(/\.0$/, '')}KB`;
  return `${(v / 1024 / 1024).toFixed(1).replace(/\.0$/, '')}MB`;
}

/** 모델 id → Claude Code 가 적는 이름. `claude-opus-5-5` → `Opus 5.5` · `claude-haiku-4-5-20251001` → `Haiku 4.5`. 모르는 꼴은 그대로. */
export function ccModelName(id: string): string {
  const raw = str(id).trim();
  const ctx = /\[1m\]$/i.test(raw) ? ' (1M context)' : '';
  const base = raw.replace(/\[1m\]$/i, '');
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(base);
  if (!m) return raw;
  const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${fam} ${m[2]}${m[3] ? '.' + m[3] : ''}${ctx}`;
}

// ── 스피너 ────────────────────────────────────────────────────────────────────────────────
/** 스피너 글리프 — 앞으로 갔다가 되돌아온다(Claude Code 와 같은 왕복). */
export const TUI_SPIN_FRAMES: readonly string[] = (() => { const f = ['·', '✢', '✳', '✶', '✻', '✽']; return [...f, ...f.slice().reverse()]; })();
/** 도는 동안의 동사 — Claude Code 의 그 목록에서 고른 것. 턴마다 하나를 정해 끝까지 쓴다. */
export const TUI_VERBS: readonly string[] = [
  'Accomplishing', 'Actualizing', 'Baking', 'Brewing', 'Calculating', 'Cerebrating', 'Churning', 'Clauding', 'Coalescing',
  'Cogitating', 'Computing', 'Concocting', 'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Crunching', 'Deciphering',
  'Deliberating', 'Divining', 'Effecting', 'Elucidating', 'Envisioning', 'Finagling', 'Forging', 'Generating', 'Germinating',
  'Hatching', 'Herding', 'Honking', 'Hustling', 'Ideating', 'Imagining', 'Incubating', 'Inferring', 'Manifesting', 'Marinating',
  'Meandering', 'Moseying', 'Mulling', 'Musing', 'Noodling', 'Percolating', 'Pondering', 'Processing', 'Puttering', 'Puzzling',
  'Reticulating', 'Ruminating', 'Schlepping', 'Shimmying', 'Simmering', 'Spelunking', 'Spinning', 'Stewing', 'Sussing',
  'Synthesizing', 'Thinking', 'Tinkering', 'Transmuting', 'Unfurling', 'Vibing', 'Wandering', 'Whirring', 'Wibbling', 'Working', 'Wrangling',
];
/** 턴이 끝난 뒤 한 줄(`✻ Churned for 3m 51s · done 6:43 PM`)의 동사 — Claude Code 2.1.299 의 그 목록·그 순서. */
export const TUI_PAST_VERBS: readonly string[] = ['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked'];
/** 글자 → 0 이상의 정수(같은 글이면 같은 수). 턴의 시각으로 스피너 동사를 고른다 — 다시 그려도 같은 동사가 선다. */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const pickVerb = (seed: number): string => TUI_VERBS[seed % TUI_VERBS.length];
/** Claude Code 의 글자 해시(`(h << 5) - h + c | 0`) — 턴 끝 동사를 고를 때 쓰는 바로 그 셈. */
export function ccHash(s: string): number {
  let e = 0;
  for (let i = 0; i < s.length; i++) e = ((e << 5) - e + s.charCodeAt(i)) | 0;
  return e;
}
/**
 * 턴 끝 동사 — 터미널은 그 턴의 turn_duration 기록 uuid 를 해시해 고른다. 같은 기록을 읽는 대화창도 같은 셈을 하면
 *  **두 화면에 같은 낱말**이 선다(`Churned` 면 둘 다 `Churned`). uuid 를 모르면 빈 글자의 해시(=Baked) — 터미널과 같다.
 */
export const pastVerbOf = (uuid: string | null | undefined): string => TUI_PAST_VERBS[(ccHash(str(uuid)) >>> 0) % TUI_PAST_VERBS.length] ?? 'Worked';

// ── 권한 모드(입력칸 아래 상태 줄 왼쪽) ─────────────────────────────────────────────────────
export interface TuiMode { glyph: string; text: string; tone: 'accept' | 'plan' | 'danger' | 'warn' }
/**
 * 대화 파일의 permissionMode → 상태 줄. 기본 모드(또는 모름)는 null — 그 자리엔 `? for shortcuts` 가 선다.
 * 뒤에 붙는 흐린 `(shift+tab to cycle)` 는 그리는 쪽(chat-view)이 단다 — 이 화면에선 모드를 못 바꾸지만 두 창이 같아 보이게
 *  글자를 그대로 두고, 무엇을 하는 말인지는 title 로 설명한다.
 */
export function tuiMode(mode: string | null | undefined): TuiMode | null {
  switch (str(mode)) {
    case 'acceptEdits': return { glyph: '⏵⏵', text: 'accept edits on', tone: 'accept' };
    //  auto 는 Claude Code 가 주의색(warning)으로 칠한다 — 터미널 실측 256색 137(#af875f).
    case 'auto': return { glyph: '⏵⏵', text: 'auto mode on', tone: 'warn' };
    case 'plan': return { glyph: '⏸', text: 'plan mode on', tone: 'plan' };
    case 'bypassPermissions': return { glyph: '⏵⏵', text: 'bypass permissions on', tone: 'danger' };
    case 'dontAsk': return { glyph: '⏵⏵', text: "don't ask mode on", tone: 'danger' };
    default: return null;
  }
}

// ── 보조 에이전트 · 완료 알림 ──────────────────────────────────────────────────────────────
/** 백그라운드로 띄운 에이전트의 결과인가 — 하네스가 적은 값(isAsync·async_launched)이 먼저, 없으면 본문 머리로 안다. */
export function isAsyncAgent(meta: unknown, text: string): boolean {
  const mt = obj(meta);
  if (mt.isAsync === true || str(mt.status) === 'async_launched') return true;
  return /^Async agent launched successfully/.test(str(text).trim());
}
/** 그 결과가 띄운 에이전트의 id(완료 알림의 task-id 와 같은 값). */
export function asyncAgentId(meta: unknown, text: string): string {
  const mt = obj(meta);
  if (mt.agentId) return str(mt.agentId);
  const m = /agentId:\s*([A-Za-z0-9_-]+)/.exec(str(text));
  return m ? m[1] : '';
}
export interface TaskNotice { taskId: string; status: string; summary: string; durationMs: number | null }
/**
 * 하네스가 보조 에이전트·백그라운드 작업이 끝났을 때 사람 말 자리에 끼워 넣는 `<task-notification>` → Claude Code 의 한 줄
 *  `● Agent "기록: …" finished · 1m 1s`(2.1.299 실측) 재료. 그 꼴이 아니면 null.
 */
export function parseTaskNotification(text: string): TaskNotice | null {
  const s = str(text);
  //  알림은 그 꼬리표로 **시작**하고 task-id 를 단다(실측 510/510). 글 중간에 꼬리표를 인용한 사람 말·스킬 펼침은 알림이 아니다
  //   (리뷰 실측: 14KB 사람 말이 «Background task finished» 한 줄로 삼켜지고, 보낸 말 확인이 영영 «전달 대기» 로 남았다).
  if (!/^\s*<task-notification>/.test(s)) return null;
  const tag = (k: string): string => { const m = new RegExp(`<${k}>([\\s\\S]*?)</${k}>`).exec(s); return m ? m[1].trim() : ''; };
  const taskId = tag('task-id');
  if (!taskId) return null;
  const ms = Number(tag('duration_ms'));
  return { taskId, status: tag('status') || 'completed', summary: tag('summary') || 'Background task finished', durationMs: Number.isFinite(ms) && tag('duration_ms') ? ms : null };
}
/** 완료 알림 한 줄의 재료 — taskId(백그라운드 셈에서 지울 것) · 칠할 조각 · 점 색 · inline(턴을 열지 않고 지금 턴 안에 선다). */
export interface LineNotice { taskId: string; segs: TuiSeg[]; tone: 'ok' | 'err'; inline: boolean }
/**
 * 대화 파일 한 줄이 «보조 에이전트·백그라운드 작업이 끝났다» 알림인가. Claude Code 2.1.299 는 두 꼴로 적는다:
 *  ① 사람 말 줄(type:user, isMeta 아님) — 쉬는 동안 도착하면 그 알림이 새 턴을 연다.
 *  ② 끼워 넣기 줄(type:attachment, attachment.type:queued_command) — 도는 동안 도착하면 지금 턴 안에 끼워 넣는다
 *     (리뷰 실측: 비동기 실행 94건 중 43건이 이 꼴로만 끝났다 — 못 읽으면 `Waiting for …` 가 영영 남는다).
 *  터미널은 둘 다 같은 한 줄(`⏺ Agent "…" finished · 1m 1s`)로 그린다. 아니면 null.
 */
export function lineNotice(line: unknown): LineNotice | null {
  const r = obj(line);
  const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (obj(b).type === 'text' ? str(obj(b).text) : '')).join('\n') : '');
  let text = '';
  let inline = false;
  if (r.type === 'user') {
    if (r.isMeta) return null;
    const c = obj(r.message).content;
    if (Array.isArray(c) && c.some((b) => obj(b).type === 'tool_result')) return null;
    text = textOf(c);
  } else if (r.type === 'attachment') {
    const a = obj(r.attachment);
    if (a.type !== 'queued_command') return null;
    text = textOf(a.prompt);
    inline = true;
  } else return null;
  const tn = parseTaskNotification(text);
  if (!tn) return null;
  return { taskId: tn.taskId, segs: taskNoticeSegs(tn), tone: /^(failed|killed|error)/i.test(tn.status) ? 'err' : 'ok', inline };
}
/**
 * 턴을 마감하는 system 줄 → settle 재료. turn_duration 만 턴 끝 줄(`✻ Churned for 3m 51s · done 6:43 PM`)의 재료를 싣는다 —
 *  동사는 그 기록의 uuid 해시, 시각은 그 기록의 timestamp 라서 터미널과 같은 글이 선다. stop_hook_summary 는 마감만 한다
 *  (Claude Code 도 그 줄로는 아무것도 그리지 않는다).
 */
export function turnEndOf(line: unknown): { durationMs?: number; turnEnd?: { uuid?: string; ts?: string; pendingBg?: number } } {
  const o = obj(line);
  if (o.subtype !== 'turn_duration') return {};
  return {
    durationMs: Number(o.durationMs) || 0,
    turnEnd: { uuid: o.uuid ? str(o.uuid) : undefined, ts: o.timestamp ? str(o.timestamp) : undefined, pendingBg: Number(o.pendingBackgroundAgentCount) || 0 },
  };
}
/** 완료 알림 한 줄의 글 — `Agent "…" finished` + 흐린 ` · 1m 1s`(걸린 시간은 inactive 색 — 2.1.299 실측). */
export function taskNoticeSegs(n: TaskNotice): TuiSeg[] {
  return [{ t: n.summary }, ...(n.durationMs != null ? [{ t: ` · ${fmtElapsed(n.durationMs)}`, d: true }] : [])];
}
/**
 * 턴이 끝난 시각 — `done 6:43 PM` 의 그 글. Claude Code 와 같은 세 꼴: 오늘이면 시각만, 일주일 안이면 `Monday 6:43 PM`,
 *  그보다 오래면 `Monday, Oct 13, 6:43 PM`(달력 날짜 차로 가른다). 터미널이 영어 시각을 찍으므로 en-US 로 맞춘다.
 *  ⚠ 요즘 ICU 는 시각과 AM/PM 사이에 좁은 공백(U+202F)을 넣는다 — 고정폭 칸에서 반 칸으로 그려지므로 보통 공백으로 바꾼다.
 */
export function doneAtLabel(iso: string | null | undefined, now: Date = new Date()): string {
  const s = str(iso);
  if (!s) return '';
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return '';
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const g = Math.round((day(now) - day(d)) / 86400000);
  const fix = (x: string): string => x.replace(/[  ]/g, ' ');
  const time = fix(d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
  if (g === 0) return time;
  if (g > 0 && g < 7) return `${fix(d.toLocaleDateString('en-US', { weekday: 'long' }))} ${time}`;
  return `${fix(d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }))}, ${time}`;
}
/**
 * 턴 끝 한 줄(`✻` 뒤) — 백그라운드 에이전트가 아직 돌면 `Waiting for **2** background agents to finish`, 아니면
 *  `Churned for 3m 51s · done 6:43 PM`(동사 = 기록 uuid 해시, 시각 = 그 기록의 timestamp). 줄 전체가 흐린 글자다.
 */
export function turnEndSegs(o: { pendingBg: number; durationMs: number; uuid?: string | null; ts?: string | null; now?: Date }): TuiSeg[] {
  if (o.pendingBg > 0) return [{ t: 'Waiting for ' }, { t: String(o.pendingBg), b: true }, { t: ` background ${o.pendingBg === 1 ? 'agent' : 'agents'} to finish` }];
  const at = doneAtLabel(o.ts, o.now);
  return [{ t: `${pastVerbOf(o.uuid)} for ${fmtElapsed(o.durationMs)}${at ? ` · done ${at}` : ''}` }];
}

// ── 쉬는 동안의 안내 — 입력칸 위 한 줄 오른쪽의 `new task? /clear to save 550.8k tokens` ───────────────
//  Claude Code 2.1.299(실행 파일): 턴이 끝나고 **75분** 동안 새 턴이 없고 문맥이 **10만 토큰** 이상이면 그 안내를 띄우고,
//   새 턴이 시작되면 걷는다. 두 값은 그 기본값(CLAUDE_CODE_IDLE_THRESHOLD_MINUTES · CLAUDE_CODE_IDLE_TOKEN_THRESHOLD).
export const IDLE_HINT_MS = 75 * 60_000;
export const IDLE_HINT_TOKENS = 100_000;
/** 안내 글 — `new task? ` · ` to save ` 는 흐리게, `/clear` · `550.8k tokens` 는 제안 색(= 권한 색, 256색 105/153 — 실측). */
export function idleHintSegs(tokens: number): TuiSeg[] {
  return [{ t: 'new task? ', d: true }, { t: '/clear', c: 'sug' }, { t: ' to save ', d: true }, { t: `${fmtTokens(tokens)} tokens`, c: 'sug' }];
}
/** 지금 안내가 서야 하나 — 마지막 턴이 끝난 시각(ms)·문맥 토큰을 안다는 전제. 도는 중이면 호출하는 쪽이 부르지 않는다. */
export const idleHintDue = (endAt: number, tokens: number, now: number): boolean => tokens >= IDLE_HINT_TOKENS && now - endAt >= IDLE_HINT_MS;

/**
 * 문맥 토큰 셈 — Claude Code 의 그 셈(실행 파일)을 옮겼다. 마지막 «실제» 응답의 사용량(입력 + 캐시 쓰기 + 캐시 읽기 + 출력)을
 *  닻으로 삼고, 닻이 된 응답의 **첫 줄 뒤**에 온 줄들은 글자 수 ÷ 4 로 어림해 더한다. 한 응답은 블록마다 여러 줄로 적히므로 그
 *  응답의 둘째 블록부터 어림에 든다 — 그 셈 그대로라야 터미널과 같은 수가 선다(실측: 550,661 + 98 = `550.8k`, 빼면 `550.7k`).
 *  맥락 압축 경계(compact_boundary)를 지나면 0 에서 다시 센다. 대화 줄을 **앞에서부터 차례로** 먹인다(ctxFeed) — 이전 기록을
 *  위로 붙이는 줄은 먹이지 않는다(닻은 늘 가장 새 쪽에 있다).
 */
export interface CtxCount { base: number | null; id: string | null; lastId: string | null; est: number }
export const ctxNew = (): CtxCount => ({ base: null, id: null, lastId: null, est: 0 });
/** 닻을 모르면(실제 응답이 아직 없다) null — 어림만으로 지어내지 않는다. */
export const ctxTokens = (s: CtxCount): number | null => (s.base == null ? null : s.base + s.est);
//  닻이 될 수 없는 응답 — 끊김·거절 안내 글이나 «No response requested.» 로 시작하는 줄(하네스가 적은 것).
const CTX_SKIP_TEXT = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
  'No response requested.',
]);
const SYNTHETIC = '<synthetic>';
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** 응답 하나의 사용량 합 — 서버 쪽 반복(iterations)이 있으면 마지막 반복의 값(조언자·압축 반복은 건너뛴다). 입력 쪽이 0 이면 null(닻 아님). */
function usageTotal(u: unknown): number | null {
  const o = obj(u);
  let n = { i: Number(o.input_tokens) || 0, o: Number(o.output_tokens) || 0, cw: Number(o.cache_creation_input_tokens) || 0, cr: Number(o.cache_read_input_tokens) || 0 };
  if (n.i + n.cw + n.cr !== 0 && Array.isArray(o.iterations)) {
    const last = [...o.iterations].reverse().find((r) => !(r && typeof r === 'object' && ((r as { type?: unknown }).type === 'advisor_message' || (r as { type?: unknown }).type === 'compaction')));
    const s = obj(last);
    if ((s.type === 'message' || s.type === 'fallback_message') && fin(s.input_tokens) && fin(s.output_tokens) && fin(s.cache_creation_input_tokens) && fin(s.cache_read_input_tokens)
      && s.input_tokens + s.cache_creation_input_tokens + s.cache_read_input_tokens > 0) n = { i: s.input_tokens, o: s.output_tokens, cw: s.cache_creation_input_tokens, cr: s.cache_read_input_tokens };
  }
  return n.i + n.cw + n.cr === 0 ? null : n.i + n.cw + n.cr + n.o;
}
const est4 = (s: unknown, per = 4): number => (typeof s === 'string' ? Math.round(s.length / per) : 0);
function estContent(c: unknown): number {
  if (!c) return 0;
  if (typeof c === 'string') return est4(c);
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const b of c) n += estBlock(b);
  return n;
}
function estBlock(b: unknown): number {
  if (typeof b === 'string') return est4(b);
  if (!b || typeof b !== 'object') return 0;
  const o = b as Record<string, unknown>;
  if (o.type === 'text') return est4(o.text);
  if (o.type === 'document' && o.source && typeof o.source === 'object') {
    const s = o.source as Record<string, unknown>;
    if (s.type === 'text') return est4(s.data, ['json', 'jsonl', 'jsonc'].includes(str(o.title).split('.').pop()?.toLowerCase() ?? '') ? 2 : 4);
    if (s.type === 'content' && typeof s.content === 'string') return est4(s.content);
    if (s.type === 'content' && Array.isArray(s.content)) return estContent(s.content.filter((x) => x && typeof x === 'object'));
  }
  if (o.type === 'image' || o.type === 'document') return 2000;
  if (o.type === 'tool_result') return estContent(o.content);
  if (o.type === 'tool_use') return est4(str(o.name) + JSON.stringify(o.input ?? {}));
  if (o.type === 'thinking') return est4(o.thinking);
  if (o.type === 'redacted_thinking') return est4(o.data);
  return est4(JSON.stringify(o));
}
/** 대화 줄 하나의 어림 토큰. 끼워 넣기 줄(attachment)은 그 글(prompt·content)만 어림한다 — 하네스가 감싸는 꼴까지는 옮기지 않았다. */
export function estLineTokens(line: unknown): number {
  const o = obj(line);
  const m = obj(o.message);
  if ((o.type === 'assistant' || o.type === 'user' || o.type === 'api_system') && m.content) return estContent(m.content);
  if (o.type === 'attachment') { const a = obj(o.attachment); return est4(typeof a.prompt === 'string' ? a.prompt : a.content); }
  return 0;
}
/** 대화 줄 하나를 셈에 먹인다(차례대로). */
export function ctxFeed(s: CtxCount, line: unknown): void {
  const o = obj(line);
  if (o.type === 'system' && o.subtype === 'compact_boundary') { s.base = 0; s.id = null; s.lastId = null; s.est = 0; return; }
  if (o.type === 'assistant') {
    const m = obj(o.message);
    const aid = m.model !== SYNTHETIC && m.id != null ? str(m.id) : null;
    //  같은 응답의 이어진 줄인가 — 사이에 다른 응답(id)이 끼면 끊긴다(사람 말·도구 결과 줄은 끊지 않는다).
    const same = aid != null && aid === s.id && s.lastId === aid;
    if (aid != null) s.lastId = aid;
    const c0 = Array.isArray(m.content) ? obj(m.content[0]) : {};
    const real = 'usage' in m && m.model !== SYNTHETIC && o.isUnmetered !== true && !(c0.type === 'text' && CTX_SKIP_TEXT.has(str(c0.text)));
    const total = real ? usageTotal(m.usage) : null;
    if (total != null) {
      if (same) s.est += estLineTokens(o);
      else { s.id = aid; s.est = 0; }
      s.base = total;
      return;
    }
  }
  s.est += estLineTokens(o);
}

// ── 도구 묶음(접힌 한 줄) ──────────────────────────────────────────────────────────────────
//  Claude Code 2.1.299 전체 화면은 읽기·검색·셸·MCP 같은 «들여다보는» 도구를 하나씩 세우지 않고, 이어진 것끼리 **흐린 한 줄**로 접는다:
//   `  Ran 2 shell commands` · `  Read 1 file` · `  Called lively, ran 1 shell command` · `  Made 2 scratchpad edits +2 -2, ran 1 shell command`.
//  어느 도구가 접히고 무엇으로 세는지는 그 실행 파일의 판정을 그대로 옮겼다(아래 tuiCollapse). 일반 파일 Edit/Write·에이전트·
//  웹 가져오기처럼 **무언가를 바꾸거나 밖으로 나가는** 도구는 접히지 않고 `⏺ Update(…)` 처럼 따로 선다. 글(답)이 끼면 묶음이 끊긴다.
/** 꾸민 글 조각 — b = 굵게, d = 흐리게, c = 색(+N 초록 · -N 빨강 · sug = 제안 색). 화면은 조각을 그대로 칠한다. */
export interface TuiSeg { t: string; b?: boolean; d?: boolean; c?: 'add' | 'del' | 'sug' }

/** 그 도구 호출 하나가 묶음에서 무엇으로 세이나. null = 접히지 않는다(따로 선다). */
export type TuiCollapse =
  | { kind: 'absorb' }                                         // 할 일·작업 목록·도구 찾기 — 묶음에 소리 없이 들어간다(세지 않음)
  | { kind: 'mem'; hint: string }                              // 기억 파일 쓰기 — `wrote N memories`
  | { kind: 'scratch'; add: number; del: number; hint: string } // 스크래치패드 고치기 — `made N scratchpad edits +a -r`
  | { kind: 'mcp'; label: string; hint: string }               // MCP — `called lively`
  | { kind: 'bash'; hint: string }                             // 셸 — `ran N shell commands`
  | { kind: 'list'; hint: string }                             // ls·tree·du — `listed N directories`
  | { kind: 'search'; hint: string }                           // Grep·Glob·grep·find — `searched for N patterns`
  | { kind: 'read'; path: string | null; hint: string };       // Read·cat·head — `read N files`

//  셸 명령의 갈래 — Claude Code 의 그 낱말 목록(실행 파일 그대로). 모든 토막이 이 안에 있어야 «읽기·검색·목록» 이다.
const SH_SEARCH = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis']);
const SH_READ = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'strings', 'jq', 'awk', 'cut', 'sort', 'uniq', 'tr']);
const SH_LIST = new Set(['ls', 'tree', 'du']);
const SH_NEUTRAL = new Set(['echo', 'printf', 'true', 'false', ':']);
const SH_ALL = new Set([...SH_SEARCH, ...SH_READ, ...SH_LIST, ...SH_NEUTRAL]);
/** 셸 명령을 토막(파이프·&&·||·;·& ·줄바꿈)으로 — 따옴표 안은 자르지 않고, `2>&1` 같은 돌려보내기의 & 는 토막 경계가 아니다. */
export function splitShell(cmd: string): string[] {
  const s = str(cmd);
  const parts: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; }
    const redirect = c === '&' && (/[<>]$/.test(cur) || s[i + 1] === '>');
    if (!redirect && (c === '|' || c === ';' || c === '&' || c === '\n')) {
      if (cur.trim()) parts.push(cur);
      cur = '';
      if ((c === '|' || c === '&') && s[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
/** 셸 명령이 «읽기·검색·목록» 인가. 셈의 차례(Claude Code): 목록 → 검색 → 읽기. 아니면 null(그냥 셸 명령). */
export function shellKind(cmd: string): 'list' | 'search' | 'read' | null {
  const first = /^\s*(?:(?:#[^\n]*|\\)\n\s*)*([^\s|&;<>()]+)/.exec(str(cmd))?.[1];
  if (!first || !SH_ALL.has(first)) return null;
  let srch = false, list = false, any = false;
  for (const p of splitShell(cmd)) {
    const w = p.trim().split(/\s+/)[0];
    if (!w || SH_NEUTRAL.has(w)) continue;
    if (!SH_ALL.has(w)) return null;
    any = true;
    if (SH_SEARCH.has(w)) srch = true;
    if (SH_LIST.has(w)) list = true;
  }
  if (!any) return null;
  //  읽기 낱말만 남았으면 읽기(SH_READ) — 목록·검색이 하나라도 있으면 그것이 먼저다.
  return list ? 'list' : srch ? 'search' : 'read';
}
/** 줄 수 — 빈 글이면 0, 아니면 줄바꿈 수 + 1(Claude Code 의 그 셈). */
const lineCount = (s: unknown): number => (typeof s === 'string' && s.length > 0 ? s.split('\n').length : 0);
/** 하네스가 스스로 관리하는 기억 파일(~/.claude/projects/<프로젝트>/memory/…). */
export const isMemoryPath = (p: string): boolean => /\/\.claude[^/]*\/projects\/[^/]+\/memory\//.test(p);
/** 세션 스크래치패드(/tmp/claude-<uid>/<프로젝트>/<세션>/scratchpad/…). */
export const isScratchpadPath = (p: string): boolean => /\/claude-[^/]+\/[^/]+\/[^/]+\/scratchpad\//.test(p);
/** 셸 명령을 진행 중 안내(`⎿  $ npm test`)로 — 첫 줄이 `# 설명` 주석이면 그 설명을, 아니면 `$ 명령`. 300자에서 자른다. */
function shellHint(cmd: string): string {
  const s = str(cmd);
  const nl = s.indexOf('\n');
  const head = (nl === -1 ? s : s.slice(0, nl)).trim();
  const clip = (x: string): string => (x.length > 300 ? x.slice(0, 299) + '…' : x);
  if (head.startsWith('#') && !head.startsWith('#!') && nl !== -1 && s.slice(nl + 1).split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))) {
    const d = head.replace(/^#+\s*/, '');
    if (d) return clip(d);
  }
  return clip('$ ' + s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n'));
}
/** 묶음 줄의 MCP 이름 — 원래 서버 이름(mcpServer)에서 `claude.ai ` 를 뗀다(Claude Code 와 같다: `Called Claude Docs`). */
export function mcpLabel(server: string): string {
  return mcpServer(server).replace(/^claude\.ai /, '');
}

/** 도구 호출 하나 → 묶음 셈(접히지 않으면 null). Claude Code 2.1.299 의 판정 순서 그대로. */
export function tuiCollapse(name: string, input: unknown, cwd?: string | null): TuiCollapse | null {
  const o = obj(input);
  if (name === 'REPL' || name === 'TodoWrite' || name === 'TaskCreate' || name === 'TaskGet' || name === 'TaskUpdate' || name === 'TaskList' || name === 'ToolSearch') return { kind: 'absorb' };
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') {
    const p = str(o.file_path ?? o.path);
    const hint = relPath(p, cwd);
    if (p && isMemoryPath(p)) return { kind: 'mem', hint };
    if (p && isScratchpadPath(p)) {
      if (name === 'Write') return { kind: 'scratch', add: lineCount(o.content), del: 0, hint };
      const edits = Array.isArray(o.edits) ? (o.edits as unknown[]).map(obj) : [o];
      return { kind: 'scratch', add: edits.reduce((n, e) => n + lineCount(e.new_string), 0), del: edits.reduce((n, e) => n + lineCount(e.old_string), 0), hint };
    }
    return null;
  }
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1] || 'MCP';
    const q = typeof o.query === 'string' ? o.query : '';
    return { kind: 'mcp', label: mcpLabel(server), hint: q ? `"${q.replace(/\s+/g, ' ').trim().slice(0, 300)}"` : '' };
  }
  if (name === 'Read') { const p = str(o.file_path ?? o.path); return { kind: 'read', path: p || null, hint: relPath(p, cwd) }; }
  if (name === 'Glob' || name === 'Grep') { const pat = str(o.pattern); return { kind: 'search', hint: pat ? `"${pat}"` : '' }; }
  if (name === 'LS') return { kind: 'list', hint: relPath(o.path, cwd) };
  if (name === 'Bash' || name === 'PowerShell') {
    const cmd = str(o.command);
    const k = name === 'Bash' ? shellKind(cmd) : null;
    if (k === 'read') return { kind: 'read', path: null, hint: shellHint(cmd) };
    if (k) return { kind: k, hint: shellHint(cmd) };
    return { kind: 'bash', hint: shellHint(cmd) };
  }
  return null;
}

/** 이어진 접힘 도구들의 셈. */
export interface TuiGroup {
  scratch: number; scratchAdd: number; scratchDel: number;
  search: number; readPaths: string[]; readOps: number; list: number;
  mcp: number; mcpLabels: string[]; bash: number; mem: number;
  hint: string;   // 가장 최근 호출의 안내(도는 동안 `⎿` 아래에 선다)
}
export const newGroup = (): TuiGroup => ({ scratch: 0, scratchAdd: 0, scratchDel: 0, search: 0, readPaths: [], readOps: 0, list: 0, mcp: 0, mcpLabels: [], bash: 0, mem: 0, hint: '' });
export function addToGroup(g: TuiGroup, c: TuiCollapse): void {
  switch (c.kind) {
    case 'absorb': return;
    case 'mem': g.mem++; break;
    case 'scratch': g.scratch++; g.scratchAdd += c.add; g.scratchDel += c.del; break;
    case 'mcp': g.mcp++; if (!g.mcpLabels.includes(c.label)) g.mcpLabels.push(c.label); break;
    case 'bash': g.bash++; break;
    case 'list': g.list++; break;
    case 'search': g.search++; break;
    case 'read': if (c.path) { if (!g.readPaths.includes(c.path)) g.readPaths.push(c.path); } else g.readOps++; break;
  }
  if (c.hint) g.hint = c.hint;
}
/** 묶음에 보일 것이 있나(할 일 목록 갱신만 있으면 줄을 세우지 않는다). */
export const groupVisible = (g: TuiGroup): boolean => g.scratch + g.search + g.readPaths.length + g.readOps + g.list + g.mcp + g.bash + g.mem > 0;
/**
 * 묶음 한 줄 — `Ran **2** shell commands` · `Called lively, ran **1** shell command`. 차례·낱말·복수형은 Claude Code 2.1.299 그대로:
 *  스크래치패드 → 검색 → 읽기 → 목록 → MCP → 셸 → 기억 쓰기. 첫 낱말만 대문자, 쉼표로 잇는다. active = 아직 도는 중(-ing 꼴).
 */
export function groupSegs(g: TuiGroup, active = false): TuiSeg[] {
  const out: TuiSeg[] = [];
  const part = (verb: string, ...rest: TuiSeg[]): void => {
    const first = out.length === 0;
    if (!first) out.push({ t: ', ' });
    out.push({ t: first ? verb.charAt(0).toUpperCase() + verb.slice(1) : verb });
    out.push(...rest);
  };
  const num = (n: number): TuiSeg => ({ t: String(n), b: true });
  if (g.scratch > 0) {
    const pm: TuiSeg[] = [];
    if (g.scratchAdd > 0 || g.scratchDel > 0) {
      pm.push({ t: ' ' });
      if (g.scratchAdd > 0) pm.push({ t: `+${g.scratchAdd}`, c: 'add' });
      if (g.scratchAdd > 0 && g.scratchDel > 0) pm.push({ t: ' ' });
      if (g.scratchDel > 0) pm.push({ t: `-${g.scratchDel}`, c: 'del' });
    }
    part(active ? 'making' : 'made', { t: ' ' }, num(g.scratch), { t: ` scratchpad ${g.scratch === 1 ? 'edit' : 'edits'}` }, ...pm);
  }
  if (g.search > 0) part(active ? 'searching for' : 'searched for', { t: ' ' }, num(g.search), { t: ` ${g.search === 1 ? 'pattern' : 'patterns'}` });
  const reads = g.readPaths.length > 0 ? g.readPaths.length : g.readOps;
  if (reads > 0) part(active ? 'reading' : 'read', { t: ' ' }, num(reads), { t: ` ${reads === 1 ? 'file' : 'files'}` });
  if (g.list > 0) part(active ? 'listing' : 'listed', { t: ' ' }, num(g.list), { t: ` ${g.list === 1 ? 'directory' : 'directories'}` });
  if (g.mcp > 0) {
    const times: TuiSeg[] = g.mcp > 1 ? [{ t: ' ' }, num(g.mcp), { t: ' times' }] : [];
    part(active ? 'calling' : 'called', { t: ' ' + (g.mcpLabels.join(', ') || 'MCP') }, ...times);
  }
  if (g.bash > 0) part(active ? 'running' : 'ran', { t: ' ' }, num(g.bash), { t: ` shell ${g.bash === 1 ? 'command' : 'commands'}` });
  if (g.mem > 0) part(active ? 'writing' : 'wrote', { t: ' ' }, num(g.mem), { t: ` ${g.mem === 1 ? 'memory' : 'memories'}` });
  return out;
}

// ── 변경분 문법 색 ──────────────────────────────────────────────────────────────────────────
//  Claude Code 는 변경분의 문맥 줄·더한 줄을 highlight.js 로 칠한다(지운 줄은 칠하지 않는다 — 2.1.299 실측). 그 색 판은 라이트=GitHub,
//  다크=Monokai Extended 이고 갈래(keyword·string·title.function…)마다 한 색이다. 여기서는 그 갈래를 가볍게 가른다 — 같은 갈래면
//  같은 색이 서므로 두 화면이 «같은 코드»로 보인다(highlight.js 전체를 싣지는 않는다: 자주 보는 C 계열·셸·파이썬 꼴만).
/**
 * 색 갈래(highlight.js 의 갈래 이름에 맞춤) — kw 키워드 · store 선언 키워드(const·function…, 다크에서만 따로) · fn 함수 이름 ·
 *  cls 클래스 · str 글자 · num 수 · lit 참/거짓/null · bi 내장(console·JSON…) · attr 설정 키(yaml·toml) · prop 속성 · com 주석.
 *  라이트(GitHub)는 num·lit·bi·attr·prop 이 한 색이고 다크(Monokai)는 갈린다 — 그래서 갈래는 나눠 두고 색은 CSS 가 쥔다.
 */
export type TuiTok = { t: string; k?: 'kw' | 'store' | 'fn' | 'cls' | 'str' | 'num' | 'lit' | 'bi' | 'attr' | 'prop' | 'com' };
const KW_C = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return', 'try', 'catch', 'finally', 'throw', 'new', 'delete',
  'typeof', 'instanceof', 'in', 'of', 'void', 'await', 'async', 'yield', 'import', 'export', 'from', 'as', 'default', 'extends', 'implements', 'static', 'public',
  'private', 'protected', 'readonly', 'get', 'set', 'super', 'with', 'goto', 'package', 'go', 'defer', 'select', 'chan', 'range', 'match', 'mut', 'pub', 'use',
  'mod', 'crate', 'self', 'where', 'loop', 'unsafe', 'move', 'ref', 'final', 'abstract', 'override', 'virtual', 'sizeof', 'satisfies', 'keyof', 'declare', 'is']);
const KW_STORE = new Set(['const', 'let', 'var', 'function', 'class', 'type', 'interface', 'enum', 'namespace', 'module', 'def', 'fn', 'func', 'struct', 'trait', 'impl']);
const KW_PY = new Set(['if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'return', 'try', 'except', 'finally', 'raise', 'import', 'from', 'as', 'with',
  'pass', 'lambda', 'yield', 'global', 'nonlocal', 'assert', 'del', 'in', 'is', 'not', 'and', 'or', 'async', 'await']);
const KW_SH = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', 'return', 'local', 'export',
  'readonly', 'declare', 'set', 'unset', 'shift', 'exit', 'break', 'continue', 'source']);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'nil', 'None', 'True', 'False', 'this', 'self']);
//  내장 — 소문자 전역만(console·window…). 대문자로 시작하는 이름(Number·JSON·ResizeObserver)은 Claude Code 가 클래스 색으로 칠한다(실측).
const BUILTINS = new Set(['console', 'window', 'document', 'globalThis', 'localStorage', 'sessionStorage', 'require', 'module', 'exports', 'arguments',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'print', 'len', 'range']);
/** 이 확장자를 어느 꼴로 칠하나. null = 칠하지 않는다(마크다운·글 파일). */
function langFamily(lang: string): 'c' | 'py' | 'sh' | 'conf' | null {
  const l = str(lang).toLowerCase();
  if (/^(js|mjs|cjs|jsx|ts|mts|cts|tsx|json|jsonc|css|scss|less|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|swift|php|dart|scala|vue|svelte)$/.test(l)) return 'c';
  if (/^(py|pyi)$/.test(l)) return 'py';
  if (/^(sh|bash|zsh|fish)$/.test(l)) return 'sh';
  if (/^(ya?ml|toml|ini|conf|env|rb|pl|r)$/.test(l)) return 'conf';
  return null;
}
/** 한 줄을 색 갈래 조각으로. 한 줄씩 칠하므로 여러 줄에 걸친 주석·글자는 그 줄 안에서만 맞는다(변경분은 줄 단위라 충분하다). */
export function tuiHighlight(line: string, lang: string): TuiTok[] {
  const fam = langFamily(lang);
  const s = str(line);
  if (!fam || !s) return [{ t: s }];
  const out: TuiTok[] = [];
  const push = (t: string, k?: TuiTok['k']): void => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.k === k) last.t += t; else out.push(k ? { t, k } : { t });
  };
  const hashCom = fam !== 'c';
  let i = 0;
  let prevWord = '';
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i);
    if ((fam === 'c' && rest.startsWith('//')) || (hashCom && c === '#' && (fam !== 'sh' || i === 0 || /\s/.test(s[i - 1])))) { push(rest, 'com'); break; }
    if (fam === 'c' && rest.startsWith('/*')) { const e = rest.indexOf('*/', 2); const t = e === -1 ? rest : rest.slice(0, e + 2); push(t, 'com'); i += t.length; continue; }
    if (c === '"' || c === "'" || (c === '`' && fam === 'c')) {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      const t = s.slice(i, Math.min(j + 1, s.length));
      push(t, 'str'); i += t.length; prevWord = ''; continue;
    }
    const num = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/.exec(rest);
    if (num && (i === 0 || !/[\w$]/.test(s[i - 1]))) { push(num[0], 'num'); i += num[0].length; prevWord = ''; continue; }
    const w = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (w) {
      const word = w[0];
      const after = s.slice(i + word.length);
      const before = s[i - 1];
      let k: TuiTok['k'];
      if (fam === 'sh') k = KW_SH.has(word) ? 'kw' : undefined;
      else if (fam === 'py') k = KW_PY.has(word) ? 'kw' : KW_STORE.has(word) ? 'store' : LITERALS.has(word) ? 'lit' : BUILTINS.has(word) ? 'bi' : /^\s*\(/.test(after) ? 'fn' : undefined;
      else if (fam === 'conf') k = LITERALS.has(word) ? 'lit' : /^\s*[:=]/.test(after) && !/\S/.test(s.slice(0, i)) ? 'attr' : undefined;
      //  객체 열쇠({ type: … }) — 키워드와 같은 낱말이어도 열쇠 자리면 열쇠 색(실측: `{ type: 'user' }` 의 type 은 속성 색).
      else if (/^\s*:(?!:)/.test(after) && /[{,(]\s*$/.test(s.slice(0, i))) k = 'attr';
      else if (KW_STORE.has(word)) k = 'store';
      else if (KW_C.has(word)) k = 'kw';
      else if (LITERALS.has(word)) k = 'lit';
      else if (BUILTINS.has(word)) k = 'bi';
      else if (/^[A-Z][A-Z0-9_]+$/.test(word)) k = 'prop';                       // 상수(INTERRUPT_RE) — 변수 색
      else if (/^[A-Z]/.test(word) || prevWord === 'new' || prevWord === 'class' || prevWord === 'extends') k = 'cls';
      else if (/^\s*\(/.test(after) || /^\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/.test(after)) k = 'fn';
      else if (before === '.') k = 'prop';
      push(word, k); i += word.length; prevWord = word; continue;
    }
    push(c); i++;
    if (!/\s/.test(c)) prevWord = '';
  }
  return out;
}

// ── 표 ────────────────────────────────────────────────────────────────────────────────────
//  Claude Code 2.1.299 의 마크다운 표 그리기를 그대로 옮겼다(실행 파일의 그 셈): 칸 폭은 «가장 긴 칸»(최소 3), 다 안 들어가면
//  «가장 긴 낱말» 폭에 남는 자리를 나눠 주고, 그래도 넘치면 비율로 줄이며 낱말을 자른다. 한 칸이 4줄을 넘거나 표가 화면보다
//  넓으면 **세로꼴**(`**머리:** 값` 줄들, 행 사이 `─`×40)로 바꾼다. 상자 표는 머리를 가운데, 행 사이마다 가로 칸막이를 긋는다.
/** 터미널 칸 수 — 한글·한자·전각·그림 글자는 두 칸. */
export function dispWidth(s: string): number {
  let w = 0;
  for (const ch of str(s)) {
    const c = ch.codePointAt(0) ?? 0;
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x303e) || (c >= 0x3041 && c <= 0x33ff) || (c >= 0x3400 && c <= 0x4dbf)
      || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xa960 && c <= 0xa97f) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
      || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1;
  }
  return w;
}
/** 마크다운 꾸밈표를 걷은 글(칸 폭을 잴 때 — 터미널엔 `**`·`` ` `` 가 안 보인다). */
export const mdPlain = (s: string): string => str(s)
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
  .replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, '$1$2').replace(/~~([^~]+)~~/g, '$1');
/** 낱말 단위 줄 바꿈. hard = 칸보다 긴 낱말을 글자 단위로 자른다(아니면 그 낱말만 한 줄을 넘친다). */
export function wrapWords(s: string, width: number, hard: boolean): string[] {
  const words = str(s).split(/\s+/).filter(Boolean);
  if (width <= 0 || !words.length) return [str(s).trim()];
  const out: string[] = [];
  let cur = '';
  const flush = (): void => { if (cur) out.push(cur); cur = ''; };
  for (let w of words) {
    if (hard) {
      while (dispWidth(w) > width) {
        if (cur) flush();
        let cut = '';
        for (const ch of w) { if (dispWidth(cut + ch) > width) break; cut += ch; }
        if (!cut) cut = [...w][0];
        out.push(cut);
        w = w.slice(cut.length);
      }
      if (!w) continue;
    }
    if (!cur) cur = w;
    else if (dispWidth(cur) + 1 + dispWidth(w) <= width) cur += ' ' + w;
    else { flush(); cur = w; }
  }
  flush();
  return out.length ? out : [''];
}
export type TuiAlign = 'left' | 'center' | 'right';
export type TuiTable =
  | { kind: 'box'; widths: number[]; hard: boolean }
  | { kind: 'vertical'; lines: Array<{ head?: string; text: string; raw?: string } | { sep: string }> };
/**
 * 표의 꼴을 정한다. cols = 글이 앉는 칸 수(⏺ 뒤의 폭). 상자 표면 칸 폭을, 세로꼴이면 그릴 줄들을 돌려준다.
 *  세로꼴 줄: head 가 있으면 `**head:** text`, raw = 한 줄에 다 들어간 칸의 원문(꾸밈 그대로 칠할 수 있다).
 */
export function tuiTableLayout(head: string[], rows: string[][], cols: number): TuiTable {
  const MIN = 3, SIDE = 4, MAX_LINES = 4;
  const n = head.length;
  const cell = (r: string[], c: number): string => r[c] ?? '';
  const minW = (s: string): number => { const ws = mdPlain(s).split(/\s+/).filter(Boolean); return ws.length ? Math.max(...ws.map(dispWidth), MIN) : MIN; };
  const natW = (s: string): number => Math.max(dispWidth(mdPlain(s)), MIN);
  const S = head.map((h, c) => Math.max(minW(h), ...rows.map((r) => minW(cell(r, c)))));
  const H = head.map((h, c) => Math.max(natW(h), ...rows.map((r) => natW(cell(r, c)))));
  const room = Math.max(cols - (1 + n * 3) - SIDE, n * MIN);
  const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
  let hard = false;
  let N: number[];
  if (sum(H) <= room) N = H;
  else if (sum(S) <= room) {
    const extra = room - sum(S);
    const gap = H.map((w, c) => w - S[c]);
    const gs = sum(gap);
    N = S.map((w, c) => (gs === 0 ? w : w + Math.floor((gap[c] / gs) * extra)));
  } else {
    hard = true;
    const k = room / sum(S);
    N = S.map((w) => Math.max(Math.floor(w * k), MIN));
  }
  const tall = [head, ...rows].some((r) => head.some((_, c) => wrapWords(mdPlain(cell(r, c)), N[c], hard).length > MAX_LINES));
  const wide = 1 + sum(N.map((w) => w + 3)) > cols - SIDE;
  if (!tall && !wide) return { kind: 'box', widths: N, hard };
  //  세로꼴 — 행마다 `머리: 값`, 값이 넘치면 첫 줄은 머리 뒤 폭으로, 이어지는 줄은 왼쪽 끝부터. 행 사이엔 `─`(최대 40).
  const lines: Array<{ head?: string; text: string; raw?: string } | { sep: string }> = [];
  const sep = '─'.repeat(Math.max(1, Math.min(cols - 1, 40)));
  const heads = head.map((h) => mdPlain(h).trim());
  for (const r of rows) {
    const mine: Array<{ head?: string; text: string; raw?: string }> = [];
    r.forEach((raw, c) => {
      const g = heads[c] || '';
      const v = mdPlain(raw).replace(/\s+/g, ' ').trim();
      if (!g && !v) return;
      const firstW = g ? cols - dispWidth(g) - 3 : cols - 1;
      const first = wrapWords(v, Math.max(firstW, 10), false);
      const all = first.length <= 1 ? first : [first[0], ...wrapWords(first.slice(1).join(' '), cols - 3, false)];
      mine.push({ ...(g ? { head: g } : {}), text: all[0] || '', ...(all.length <= 1 ? { raw: raw.trim() } : {}) });
      for (const l of all.slice(1)) if (l.trim()) mine.push({ text: l });
    });
    if (!mine.length) continue;
    if (lines.length) lines.push({ sep });
    lines.push(...mine);
  }
  return { kind: 'vertical', lines };
}

// ── 도구 결과 ────────────────────────────────────────────────────────────────────────────
/** `<tool_use_error>…</tool_use_error>` 같은 하네스 표지를 걷는다. */
const unwrapErr = (t: string): string => t.replace(/<\/?tool_use_error>/g, '').trim();

/** 접힌 미리보기 — 앞 n 줄(줄마다 너무 길면 자른다) + 남은 줄 수. */
function preview(lines: string[], n: number): { lines: string[]; more: number; clipped: boolean } {
  let clipped = false;
  const shown = lines.slice(0, n).map((l) => { if (l.length > LINE_CLIP) { clipped = true; return l.slice(0, LINE_CLIP) + '…'; } return l; });
  return { lines: shown, more: Math.max(0, lines.length - n), clipped };
}
/** 펼칠 원문 — 상한을 넘으면 자르고 남은 양을 적는다. */
export function fullText(text: string): string {
  const t = str(text).replace(/\s+$/, '');
  if (t.length <= TUI_FULL_MAX) return t;
  const rest = splitLines(t.slice(TUI_FULL_MAX)).length;
  return t.slice(0, TUI_FULL_MAX) + `\n… +${rest} lines`;
}
const numbered = (lines: string[], from = 1): string[] => {
  const w = String(from + lines.length - 1).length;
  return lines.map((l, i) => `${String(from + i).padStart(w)} ${l}`);
};

/** 기본 결과 — 앞 3줄 + `… +N lines`. 비었으면 `(No content)`. */
function plainResult(text: string, isError: boolean): TuiResult {
  const all = splitLines(isError ? unwrapErr(text) : text);
  if (!all.length) return { summary: '(No content)', lines: [], more: 0, ...(isError ? { tone: 'err' as const } : {}) };
  const p = preview(all, TUI_PREVIEW_LINES);
  const r: TuiResult = { lines: p.lines, more: p.more };
  if (p.more || p.clipped) r.full = fullText(all.join('\n'));
  if (isError) r.tone = 'err';
  return r;
}

/**
 * 도구 결과 → `⎿` 아래 그림.
 * @param meta 하네스가 결과와 함께 적은 구조화 값(claude 대화 파일의 toolUseResult) — 있으면 그 수를 쓴다.
 */
export function tuiToolResult(name: string, input: unknown, output: string, isError: boolean, meta?: unknown, cwd?: string | null): TuiResult {
  const o = obj(input);
  const mt = obj(meta);
  const text = str(output);
  const rel = (p: unknown): string => relPath(p, cwd);

  if (isError) {
    const t = unwrapErr(text);
    // 사람이 승인 창에서 거절했다 — 하네스가 남기는 정해진 문장이다.
    if (/doesn't want to proceed with this tool use|tool use was rejected/i.test(t)) {
      const what = name === 'Edit' || name === 'MultiEdit' ? `User rejected update to ${rel(o.file_path)}`
        : name === 'Write' ? `User rejected write to ${rel(o.file_path)}` : 'User rejected tool use';
      return { summary: what, lines: [], more: 0, tone: 'subtle' };
    }
    const all = splitLines(t);
    if (!all.length) return { summary: 'Error', lines: [], more: 0, tone: 'err' };
    const head = /^error\b/i.test(all[0]) ? all[0] : `Error: ${all[0]}`;
    const p = preview(all.slice(1), TUI_PREVIEW_LINES);
    const r: TuiResult = { summary: head.length > LINE_CLIP ? head.slice(0, LINE_CLIP) + '…' : head, lines: p.lines, more: p.more, tone: 'err' };
    if (p.more || p.clipped || head.length > LINE_CLIP) r.full = fullText(t);
    return r;
  }

  if (name.startsWith('mcp__')) return plainResult(text, false);
  switch (name) {
    case 'Bash': case 'PowerShell': {
      //  출력 앞 3줄 + `… +N lines`. 출력이 없으면 Claude Code 의 그 말(백그라운드 · Done · (No output)) — 바뀐 파일이 있으면 말 없이 파일 줄만.
      const bed = obj(mt.bashEditDiff);
      const files = Array.isArray(bed.files) ? (bed.files as unknown[]).map(obj) : [];
      const more = Number(bed.moreFiles) || 0;
      const pops = bashPopsOut(meta);
      const r: TuiResult = text.trim() ? plainResult(text, false)
        : pops ? { lines: [], more: 0 }
        : { summary: mt.backgroundTaskId ? 'Running in the background (↓ to manage)' : mt.noOutputExpected ? 'Done' : '(No output)', lines: [], more: 0 };
      if (!mt.bashEditDiff) return r;
      const SHARED = '(another command ran in this repository at the same time; a change made by either may show under either result)';
      if (bed.skipped || ((bed.unavailable || bed.shared) && files.length === 0)) {
        r.notes = [bed.skipped ? '(file diff skipped for this git command)'
          : bed.unavailable ? (more > 0 ? `(file diff unavailable for this command; ${plural(more, 'file')} changed)` : '(file diff unavailable for this command)') : SHARED];
        return r;
      }
      const treeMoved = GIT_MOVES_TREE.test(str(o.command));
      r.edits = files.map((f) => {
        const hunks = (Array.isArray(f.hunks) ? (f.hunks as unknown[]) : []).map((h) => obj(h));
        const all = hunks.flatMap((h) => (Array.isArray(h.lines) ? (h.lines as unknown[]).map(str) : []));
        const add = all.filter((l) => l.startsWith('+')).length, del = all.filter((l) => l.startsWith('-')).length;
        //  파일당 40줄 예산(Claude Code 와 같다) — 넘친 줄은 `… N more lines`.
        let room = 40, hidden = 0;
        const shown: Hunk[] = [];
        for (const h of hunks) {
          const ls = Array.isArray(h.lines) ? (h.lines as unknown[]) : [];
          if (room <= 0) hidden += ls.length;
          else if (ls.length <= room) { shown.push(h as Hunk); room -= ls.length; }
          else { shown.push({ ...(h as Hunk), lines: ls.slice(0, room) }); hidden += ls.length - room; room = 0; }
        }
        const verb = f.created ? 'Created' : f.deleted ? 'Deleted' : 'Updated';
        return { segs: [{ t: verb + ' ' }, { t: rel(f.filePath), b: true }, { t: ' ' }, { t: `(+${add} -${del})`, d: true }],
          diff: treeMoved ? [] : diffFromPatch(shown), hidden: treeMoved ? 0 : hidden, lang: langOf(str(f.filePath)) };
      });
      const notes: string[] = [];
      if (more > 0) notes.push((files.length ? `… ${more} more ${more === 1 ? 'file' : 'files'} changed` : `${plural(more, 'file')} changed (binary, mode only or too large to show)`) + (bed.unavailable ? ' (part of the diff is unavailable)' : ''));
      if (treeMoved) notes.push('(a git step in this command can move the working tree, so these may be its changes, not edits)');
      if (bed.shared) notes.push(SHARED);
      if (notes.length) r.notes = notes;
      return r;
    }
    case 'Read': {
      const file = obj(mt.file);
      if (str(mt.type) === 'image') return { summary: 'Read image' + (Number(file.originalSize) ? ` (${fmtBytes(Number(file.originalSize))})` : ''), lines: [], more: 0 };
      const all = splitLines(text);
      const n = Number(file.numLines) || all.length;
      return { summary: `Read ${plural(n, 'line')}`, lines: [], more: 0, ...(all.length ? { full: fullText(text) } : {}) };
    }
    case 'Edit': case 'MultiEdit': {
      let rows = diffFromPatch(mt.structuredPatch);
      if (!rows.length) {
        const edits = name === 'MultiEdit' && Array.isArray(o.edits) ? (o.edits as unknown[]).map(obj) : [o];
        edits.forEach((e, i) => { if (i) rows.push({ kind: 'gap', no: null, text: '...' }); rows = rows.concat(diffFromStrings(str(e.old_string), str(e.new_string))); });
      }
      const segs = editSegs(countKind(rows, 'add'), countKind(rows, 'del'));
      return { ...(segs.length ? { sumSegs: segs } : { summary: '(No changes)' }), lines: [], more: 0, diff: rows, lang: langOf(str(o.file_path)) };
    }
    case 'Write': {
      if (str(mt.type) === 'update' && Array.isArray(mt.structuredPatch) && (mt.structuredPatch as unknown[]).length) {
        const rows = diffFromPatch(mt.structuredPatch);
        const segs = editSegs(countKind(rows, 'add'), countKind(rows, 'del'));
        return { ...(segs.length ? { sumSegs: segs } : { summary: '(No changes)' }), lines: [], more: 0, diff: rows, lang: langOf(str(o.file_path)) };
      }
      //  새 파일 — `Wrote **N** lines to **경로**` + 앞 10줄(줄 번호) + `… +N lines (ctrl+o to expand)`.
      const raw = str(o.content ?? mt.content);
      const n = raw ? raw.split('\n').length - (raw.endsWith('\n') ? 1 : 0) : 0;
      const content = splitLines(raw);
      const r: TuiResult = { sumSegs: [{ t: 'Wrote ' }, { t: String(n), b: true }, { t: ` ${n === 1 ? 'line' : 'lines'} to ` }, { t: rel(o.file_path), b: true }],
        lines: [], code: content.slice(0, TUI_WRITE_LINES), more: Math.max(0, content.length - TUI_WRITE_LINES), lang: langOf(str(o.file_path)) };
      if (r.more) r.full = fullText(numbered(content).join('\n'));
      return r;
    }
    case 'Glob': {
      const all = splitLines(text);
      const n = Number.isFinite(Number(mt.numFiles)) && mt.numFiles !== undefined ? Number(mt.numFiles) : (/^No files found/i.test(text.trim()) ? 0 : all.length);
      return { summary: `Found ${plural(n, 'file')}`, lines: [], more: 0, ...(n ? { full: fullText(text) } : {}) };
    }
    case 'Grep': {
      const mode = str(mt.mode || o.output_mode || 'files_with_matches');
      const all = splitLines(text);
      const has = (k: string): boolean => mt[k] !== undefined && Number.isFinite(Number(mt[k]));
      let summary: string;
      if (mode === 'content') summary = `Found ${plural(has('numLines') ? Number(mt.numLines) : all.length, 'line')}`;
      else if (mode === 'count') summary = `Found ${plural(has('numMatches') ? Number(mt.numMatches) : all.length, 'match', 'matches')}`;
      else {
        const m = /^Found (\d+) files?/i.exec(text.trim());
        const n = has('numFiles') ? Number(mt.numFiles) : m ? Number(m[1]) : (/^No files found/i.test(text.trim()) ? 0 : all.length);
        summary = `Found ${plural(n, 'file')}`;
      }
      return { summary, lines: [], more: 0, ...(all.length ? { full: fullText(text) } : {}) };
    }
    case 'LS': {
      const n = splitLines(text).filter((l) => /^\s*-\s/.test(l)).length;
      return { summary: `Listed ${plural(n, 'path')}`, lines: [], more: 0, full: fullText(text) };
    }
    case 'WebFetch': {
      if (Number.isFinite(Number(mt.bytes)) && mt.bytes !== undefined) {
        const code = mt.code !== undefined ? ` (${[mt.code, mt.codeText].filter((x) => x !== undefined && x !== '').join(' ')})` : '';
        return { summary: `Received ${fmtBytes(Number(mt.bytes))}${code}`, lines: [], more: 0, full: fullText(text) };
      }
      return plainResult(text, false);
    }
    case 'WebSearch': {
      const d = Number(mt.durationSeconds);
      return { summary: Number.isFinite(d) && mt.durationSeconds !== undefined ? `Did 1 search in ${Math.max(0, Math.round(d))}s` : 'Did 1 search', lines: [], more: 0, full: fullText(text) };
    }
    case 'Task': case 'Agent': {
      //  백그라운드로 띄운 에이전트 — 결과 본문은 하네스에게 하는 안내문이라 Claude Code 는 `Backgrounded agent` 한 줄만 보인다.
      //   뒤의 괄호(흐림)도 터미널 그대로 — `Backgrounded agent (↓ to manage · ctrl+o to expand)`.
      if (isAsyncAgent(meta, text)) return { sumSegs: [{ t: 'Backgrounded agent' }, { t: ' (↓ to manage · ctrl+o to expand)', d: true }], lines: [], more: 0, full: fullText(text) };
      if (mt.totalToolUseCount !== undefined || mt.totalDurationMs !== undefined) {
        const bits = [
          mt.totalToolUseCount !== undefined ? plural(Number(mt.totalToolUseCount) || 0, 'tool use') : '',
          mt.totalTokens !== undefined ? `${fmtTokens(Number(mt.totalTokens))} tokens` : '',
          mt.totalDurationMs !== undefined ? fmtElapsed(Number(mt.totalDurationMs)) : '',
        ].filter(Boolean);
        return { summary: `Done (${bits.join(' · ')})`, lines: [], more: 0, full: fullText(text) };
      }
      return plainResult(text, false);
    }
    case 'TodoWrite': {
      const todos = (Array.isArray(o.todos) ? o.todos as unknown[] : []).map(obj).map((t): TuiTodo => {
        const s = str(t.status);
        return { text: str(t.content || t.activeForm), status: s === 'completed' || s === 'in_progress' ? s : 'pending' };
      }).filter((t) => t.text);
      return { lines: [], more: 0, todos };
    }
    default: return plainResult(text, false);
  }
}

// term-prefs.ts — 웹 터미널의 환경 설정(글꼴·크기·색·커서·스크롤)을 **대화창도 그대로 쓴다**(#4707).
//
//  ── 왜 ──
//  상민님 지시(2026-10-14): «웹터미널의 설정이 똑같이 대화화면에도 적용되도록해». 세션 화면은 같은 세션을 터미널과 대화
//  두 겹으로 보여 주는데, 글꼴·크기·색이 두 겹에서 따로 놀면 같은 세션이 다른 물건처럼 보인다. 설정은 **하나**다 —
//  터미널이 저장해 둔 값(localStorage `lively_term_prefs`)이 정본이고, 대화창은 그 값을 읽어 같은 얼굴로 선다.
//  대화창에서 바꾸면 같은 키에 쓰고, 터미널 액자는 storage 신호로 그 자리에서 따라온다(web/standalone/terminal.ts).
//
//  ── 이 파일이 쥐는 것 ──
//  터미널 번들(web/standalone/terminal.ts)은 SPA 와 따로 빌드되는 단독 페이지라 모듈을 나눠 쓸 수 없다. 그래서 대화창이 알아야
//  하는 몫(글꼴 목록 · 테마의 바탕·글자·커서·선택 색 · 기본값 · 옛 저장값 이관 규칙)을 **옮겨 적는다**. 두 벌이 갈라지면
//  «터미널은 Nord 인데 대화는 엉뚱한 색» 이 되므로 scripts/term-prefs-parity.test.mjs 가 터미널 모듈의 실제 값과 맞대어 잠근다.
//  순수 함수 — DOM·localStorage 를 직접 만지지 않는다(읽은 글자를 받아 해석만 한다).

/** 터미널이 설정을 두는 자리 — web/standalone/terminal.ts 의 PREFS_KEY 와 같은 글자. */
export const TERM_PREFS_KEY = 'lively_term_prefs';

/** 글꼴 목록 — 터미널 설정의 그것과 같은 순서·같은 값(라틴 글꼴 뒤에 한글 D2Coding). */
export const TERM_FONTS: ReadonlyArray<{ v: string; label: string }> = [
  { v: "'JetBrains Mono', 'D2Coding', monospace", label: 'JetBrains Mono' },
  { v: "'D2Coding', monospace", label: 'D2Coding · 한글 코딩' },
  { v: "'Fira Code', 'D2Coding', monospace", label: 'Fira Code' },
  { v: "'Source Code Pro', 'D2Coding', monospace", label: 'Source Code Pro' },
  { v: "'IBM Plex Mono', 'D2Coding', monospace", label: 'IBM Plex Mono' },
  { v: "'Roboto Mono', 'D2Coding', monospace", label: 'Roboto Mono' },
  { v: "Menlo, 'D2Coding', monospace", label: 'Menlo' },
  { v: "'SF Mono', SFMono-Regular, 'D2Coding', monospace", label: 'SF Mono' },
  { v: "Monaco, 'D2Coding', monospace", label: 'Monaco' },
  { v: "Consolas, 'D2Coding', monospace", label: 'Consolas' },
];

/**
 * 테마 한 벌 중 대화창이 쓰는 것 — 바탕·글자·커서·선택 색, ANSI 파랑(Claude Code 가 링크를 그 색으로 찍는다), 그리고 어두운 판인가
 *  (Claude Code 의 다크/라이트 팔레트를 가른다).
 */
export interface TermFace { dark: boolean; background: string; foreground: string; cursor: string; selectionBackground: string; blue: string }

/** 앱 테마 따름(auto)의 두 얼굴 — 터미널의 APP_DARK/APP_LIGHT 와 같은 값(= 앱의 --bg/--ink). */
export const TERM_APP_DARK: TermFace = { dark: true, background: '#111726', foreground: '#EAF0FA', cursor: '#43E5B0', selectionBackground: '#2B3B5C', blue: '#6E9AF8' };
export const TERM_APP_LIGHT: TermFace = { dark: false, background: '#FFFFFF', foreground: '#15233B', cursor: '#2D6BF0', selectionBackground: '#CFE0F7', blue: '#2453C7' };

/** 이름 있는 테마 — 터미널 THEMES 의 그 값. auto 는 앱 테마를 따른다(face=null). */
export const TERM_THEMES: ReadonlyArray<{ key: string; name: string; face: TermFace | null }> = [
  { key: 'auto', name: '앱 테마 따름', face: null },
  { key: 'dark', name: '다크', face: { dark: true, background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70', blue: '#6E9AF8' } },
  { key: 'light', name: '라이트', face: { dark: false, background: '#fdfdfd', foreground: '#2a2a2a', cursor: '#5566ff', selectionBackground: '#cfe3ff', blue: '#2453C7' } },
  { key: 'dracula', name: 'Dracula', face: { dark: true, background: '#282a36', foreground: '#f8f8f2', cursor: '#ff79c6', selectionBackground: '#44475a', blue: '#bd93f9' } },
  { key: 'solarized', name: 'Solarized Dark', face: { dark: true, background: '#002b36', foreground: '#93a1a1', cursor: '#cb4b16', selectionBackground: '#073642', blue: '#268bd2' } },
  { key: 'solarized-hc', name: 'Solarized Dark (고대비)', face: { dark: true, background: '#002b36', foreground: '#c5d1d1', cursor: '#e8965a', selectionBackground: '#0d4453', blue: '#3f9fe0' } },
  { key: 'nord', name: 'Nord', face: { dark: true, background: '#2e3440', foreground: '#d8dee9', cursor: '#88c0d0', selectionBackground: '#434c5e', blue: '#81a1c1' } },
  { key: 'github', name: 'GitHub Light', face: { dark: false, background: '#ffffff', foreground: '#24292f', cursor: '#0969da', selectionBackground: '#b6e3ff', blue: '#0969da' } },
];

export type TermCursor = 'bar' | 'block' | 'underline';
export const TERM_CURSORS: ReadonlyArray<{ v: TermCursor; label: string }> = [
  { v: 'bar', label: '막대' }, { v: 'block', label: '네모' }, { v: 'underline', label: '밑줄' },
];

export interface TermPrefs {
  fontFamily: string;
  fontSize: number;
  theme: string;
  cursorStyle: TermCursor;
  scrollSpeed: number;     // 마우스 휠 배수(이산 노치) — 1..12
  padGain: number;         // 트랙패드 배수(연속 픽셀) — 0.5..6, 1 = 손가락 이동 1:1
  /** 저장된 원본 — 쓸 때 대화창이 모르는 칸(mobileDock·lineSelect·이관 표시)을 지우지 않게 그대로 들고 간다. */
  raw: Record<string, unknown>;
}

/** 라틴 글꼴만 적힌 옛 저장값에 한글 폴백(D2Coding)을 끼운다 — 터미널의 withKR 과 같은 규칙. */
export function withKR(ff: unknown): string {
  let s = String(ff || TERM_FONTS[0].v);
  if (/D2Coding/i.test(s)) return s;
  if (/,?\s*monospace\s*$/i.test(s)) return s.replace(/,?\s*monospace\s*$/i, ", 'D2Coding', monospace");
  s += ", 'D2Coding', monospace";
  return s;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * 저장된 글자 → 설정. 터미널의 prefs() 와 **같은 해석**을 한다:
 *  · 기본값 — 글꼴 JetBrains Mono · 크기 14(폰 12) · 테마 auto · 커서 막대 · 휠 3 · 트랙패드 3
 *  · 옛 저장값 이관 — 이관 표시가 없는 'dark'/'light' 는 사람이 고른 게 아니라 자동 판정이 굳은 값이라 auto 로 읽는다(#1683)
 *  · 글꼴엔 한글 폴백을 끼운다(#279)
 */
export function parseTermPrefs(stored: string | null | undefined, mobile: boolean): TermPrefs {
  let raw: Record<string, unknown> = {};
  try { const v = JSON.parse(String(stored || '{}')); if (v && typeof v === 'object' && !Array.isArray(v)) raw = v as Record<string, unknown>; } catch { raw = {}; }
  let theme = typeof raw.theme === 'string' && raw.theme ? raw.theme : 'auto';
  if (!raw.themeAutoMigrated && (theme === 'dark' || theme === 'light')) theme = 'auto';
  if (!TERM_THEMES.some((t) => t.key === theme)) theme = 'auto';   // 터미널도 모르는 이름은 auto 로 해석한다(THEMES[key] || THEMES.auto)
  const cur = String(raw.cursorStyle || 'bar');
  const size = Number(raw.fontSize);
  return {
    fontFamily: withKR(raw.fontFamily),
    //  터미널은 저장값을 그대로 xterm 에 싣는다 — 여기서도 범위를 좁히지 않고 말이 안 되는 값만 거른다.
    fontSize: Number.isFinite(size) && size > 0 ? clamp(size, 6, 72) : (mobile ? 12 : 14),
    theme,
    cursorStyle: cur === 'block' || cur === 'underline' ? cur : 'bar',
    //  터미널 부팅과 같은 식: `Math.max(1, Math.min(12, Number(p.scrollSpeed) || 3))` · padGain 은 0.5..6.
    scrollSpeed: clamp(Number(raw.scrollSpeed) || 3, 1, 12),
    padGain: clamp(Number(raw.padGain) || 3, 0.5, 6),
    raw,
  };
}

/** 고친 설정 → 저장할 글자. 모르는 칸은 그대로 두고 이관 표시를 남긴다(그래야 터미널이 다시 auto 로 되돌리지 않는다). */
export function serializeTermPrefs(p: TermPrefs): string {
  return JSON.stringify({
    ...p.raw,
    fontFamily: p.fontFamily, fontSize: clamp(Math.round(p.fontSize), 9, 30), theme: p.theme, cursorStyle: p.cursorStyle,
    scrollSpeed: clamp(p.scrollSpeed, 1, 12), padGain: clamp(p.padGain, 0.5, 6), themeAutoMigrated: true,
  });
}

/** 테마 키 → 지금 보일 얼굴. auto 는 앱이 지금 어두운가(appDark)로 정한다. */
export function termFace(theme: string, appDark: boolean): TermFace {
  const t = TERM_THEMES.find((x) => x.key === theme);
  return (t && t.face) || (appDark ? TERM_APP_DARK : TERM_APP_LIGHT);
}

/** 터미널 커서 모양 → CSS caret-shape 값. */
export function caretShape(c: TermCursor): 'bar' | 'block' | 'underscore' {
  return c === 'block' ? 'block' : c === 'underline' ? 'underscore' : 'bar';
}

// ── 휠 — 대화창이 터미널과 **같은 줄 수**로 굴러간다(#4797) ─────────────────────────────────────────────
//  상민님(2026-10-16): «스크롤속도 … 터미널이랑 대화창 스크롤속도 맞춰주면 좋을듯 설정값에따라 똑같은속도로 느껴지게».
//  세션 터미널에서 휠을 굴리면 줄을 정하는 것은 **두 단계**다:
//   ① 터미널 페이지가 휠 한 번을 Claude Code 에 보낼 SGR 휠 틱 수로 바꾼다(web/standalone/terminal.ts wheelStep —
//      마우스 = 이벤트당 scrollSpeed 틱 · 트랙패드 = 손가락 이동 × padGain 을 줄 높이로 나눈 수).
//   ② Claude Code 가 틱마다 몇 줄 굴릴지 **스스로 가속**한다(40ms 안에 틱이 이어지면 틱마다 0.3 씩, 최대 6줄).
//  종전 대화창은 ①을 픽셀로 흉내만 내고 ②가 없어서, 같은 설정에서 마우스는 대화창이 두 배쯤 빠르고(맥 가속으로 커진 deltaY
//  를 줄 수로 곱했다) 트랙패드는 터미널이 몇 배 빨랐다(가속). 그래서 두 단계를 **그대로** 옮겨 적는다.
//  ①은 시험(scripts/term-prefs-parity.test.mjs)이 터미널 모듈의 실제 함수와 맞대어 잠근다. ②는 Claude Code 실행 파일의 원본
//  셈(아래 ccWheelRows 머리말)을 옮긴 것이고, 시험이 원본에서 뽑은 값과 맞댄다.

/** 휠 틱을 셀 때 이어 가는 기억 — 트랙패드 픽셀 잔차(px)와 그 시각(at), xterm 이 직접 보낼 때의 부분 줄(part). */
export interface WheelTickAcc { px: number; at: number; part: number }
export function newWheelTickAcc(): WheelTickAcc { return { px: 0, at: 0, part: 0 }; }

/**
 * 휠 이벤트 하나 → 터미널이 Claude Code 에 보내는 SGR 휠 틱 수(부호 = 방향, 음수 = 위로). 0 이면 보내지 않는다.
 *  터미널 페이지의 휠 규칙(web/standalone/terminal.ts setupWheel · wheelStep, 화면이 alt-screen + 앱 마우스모드일 때 —
 *  Claude Code 가 늘 그 상태다)과 같은 셈이다:
 *  · 마우스 휠(이산 노치) — 이벤트당 round(scrollSpeed) 틱(최대 12). scrollSpeed 가 1 이하면 터미널이 xterm 에 맡기고,
 *    xterm 은 쌓인 줄(부분 줄 포함)이 한 줄 이상인 이벤트마다 한 틱을 보낸다.
 *  · 트랙패드(연속 픽셀) — deltaY × padGain 픽셀을 쌓아 줄 높이로 나눈 정수만큼(최대 12). 잔차는 다음 이벤트로 넘기고,
 *    방향이 바뀌거나 300ms 넘게 쉬면 버린다.
 * @param notch 이산 노치인가(isWheelNotch)
 * @param cellPx 한 줄의 높이(px) — 터미널 칸 높이와 같은 값(대화창은 같은 글꼴·크기로 같은 셈을 한다)
 * @param rows 한 화면의 줄 수(page 단위 이벤트용)
 */
export function termWheelTicks(e: { deltaY: number; deltaMode: number; timeStamp?: number; shiftKey?: boolean }, notch: boolean,
  p: Pick<TermPrefs, 'scrollSpeed' | 'padGain'>, cellPx: number, rows: number, acc: WheelTickAcc): number {
  const h = Math.max(4, cellPx);
  if (notch && p.scrollSpeed <= 1) {
    //  xterm(5.5) Viewport.getLinesScrolled — 픽셀은 줄 높이로 나눠 부분 줄을 쌓고, 정수 부분이 있을 때만 그 이벤트가 한 틱이 된다.
    if (!e.deltaY || e.shiftKey) return 0;
    let t = e.deltaY;
    if (e.deltaMode === 0) {
      acc.part += t / h;
      t = Math.floor(Math.abs(acc.part)) * (acc.part > 0 ? 1 : -1);
      acc.part %= 1;
    } else if (e.deltaMode === 2) t *= rows;
    return t ? (e.deltaY < 0 ? -1 : 1) : 0;
  }
  let lines: number;
  if (e.deltaMode === 2) lines = e.deltaY * rows;
  else if (notch) {
    acc.px = 0;                                       // 입력원이 바뀌었다 — 트랙패드 잔차는 버린다
    const approx = e.deltaMode === 1 ? e.deltaY : (Math.trunc(e.deltaY / 18) || (e.deltaY > 0 ? 1 : -1));
    lines = approx * Math.max(1, Math.round(p.scrollSpeed));
  } else {
    const now = e.timeStamp || 0;
    if (acc.px && (Math.sign(acc.px) !== Math.sign(e.deltaY) || now - acc.at > 300)) acc.px = 0;
    acc.at = now;
    acc.px += e.deltaY * Math.max(0.2, p.padGain);
    lines = Math.trunc(acc.px / h);
    acc.px -= lines * h;
  }
  const n = Math.trunc(lines);
  const reps = notch ? Math.min(Math.max(1, Math.round(p.scrollSpeed)), 12) : Math.min(Math.abs(n), 12);
  if (!reps) return 0;
  return n < 0 ? -reps : reps;
}

/** Claude Code 휠 가속의 기억 — 원본 상태 객체에서 이 환경이 쓰는 칸만. */
export interface CcWheel { time: number; mult: number; dir: number; base: number; pendingFlip: boolean; wheelMode: boolean; burstCount: number; accel: boolean }
/** base 1 · 가속 켬 — 세션 컨테이너의 Claude Code 가 쓰는 값(아래 머리말). */
export function newCcWheel(base = 1, accel = true): CcWheel {
  return { time: 0, mult: base, dir: 0, base, pendingFlip: false, wheelMode: false, burstCount: 0, accel };
}

/**
 * SGR 휠 틱 하나 → Claude Code(전체 화면)가 굴리는 줄 수. 원본: Claude Code 2.1.301 실행 파일의 휠 가속 함수(바이트코드 번들의
 *  `avt` — `dvt` 가 상태를, `p3` 가 단말별 값을 만든다)를 이 환경 갈래만 옮겨 적었다.
 *  · 이 환경: Claude Code 가 tmux 안에서 돈다 → XTVERSION 답이 «tmux …» 라 xterm.js·VS Code·Windows Terminal·JetBrains 판정이
 *    모두 거짓 → 감쇠 곡선 아님(window 갈래) · base = 1(CLAUDE_CODE_SCROLL_SPEED 미설정) · 가속은 /config 기본값(켬).
 *  · 셈: 틱 사이가 40ms 를 넘으면 base 줄, 40ms 안에 이어지면 틱마다 0.3 씩 늘려 최대 6(내림). 방향이 바뀐 첫 틱은 0 줄이고,
 *    200ms 안에 원래 방향으로 되튀면(마우스 휠의 흔들림) 더 센 가속(최대 15줄 · 반감기 150ms)으로 바꾼다.
 *  ⚠ 터미널은 한 이벤트의 틱을 한 번에 보낸다 — 같은 이벤트의 틱은 같은 now 로 부른다(그 사이 0ms 라 가속이 붙는다).
 * @param dir 1 = 아래로 · -1 = 위로
 * @param now 그 틱이 도착한 시각(ms)
 */
export function ccWheelRows(h: CcWheel, dir: 1 | -1, now: number): number {
  if (h.wheelMode && now - h.time > 1500) { h.wheelMode = false; h.burstCount = 0; h.mult = h.base; }
  if (h.pendingFlip) {
    h.pendingFlip = false;
    if (dir !== h.dir || now - h.time > 200) { h.dir = dir; h.time = now; h.mult = h.base; return Math.max(1, Math.floor(h.mult)); }
    h.wheelMode = true;
  }
  const dt = now - h.time;
  if (dir !== h.dir && h.dir !== 0) { h.pendingFlip = true; h.time = now; return 0; }
  h.dir = dir; h.time = now;
  if (h.wheelMode) {
    if (dt < 5) {
      if (++h.burstCount >= 5) { h.wheelMode = false; h.burstCount = 0; h.mult = h.base; } else return 1;
    } else h.burstCount = 0;
  }
  if (h.wheelMode && h.accel) {
    const decay = Math.pow(0.5, dt / 150);
    const cap = Math.max(15 * Math.min(h.base, 1), h.base * 2);
    h.mult = Math.min(cap, 1 + (h.mult - 1) * decay + 15 * decay, h.mult + 3);
    return Math.max(1, Math.floor(h.mult));
  }
  if (dt > 40 || !h.accel) h.mult = h.base;
  else h.mult = Math.min(Math.max(6 * Math.min(h.base, 1), h.base * 2), h.mult + 0.3);
  return Math.max(1, Math.floor(h.mult));
}

/** 이산 노치(마우스 휠)인가 연속 픽셀(트랙패드)인가 — 터미널의 isNotch 와 같은 판별(브라우저가 주는 신호로만). wheelDeltaY 가
 *  120 의 배수면 마우스다(맥 크롬 실측 #1168: 마우스 100% · 트랙패드 0%). */
export function isWheelNotch(e: { deltaY: number; deltaMode: number; wheelDeltaY?: number }): boolean {
  if (e.deltaMode !== 0) return true;
  const wdy = e.wheelDeltaY;
  if (typeof wdy === 'number' && wdy !== 0) return Math.abs(wdy) % 120 === 0;
  return Math.abs(e.deltaY) >= 100;
}

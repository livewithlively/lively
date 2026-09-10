// 터미널 입력줄의 «선택»과 «되돌리기» (#3778) — 앱에 없는 두 기능을 웹터미널이 대신 만든다.
//
// 왜 여기서 만드나: Claude Code 입력칸에는 **선택이라는 개념이 아예 없다**(2.1.266 바이너리 실측 — 방향키 처리가
//  shift 를 보지 않는다. vim 모드의 비주얼 선택만 예외). 되돌리기도 vim 의 `u` 뿐이었다(2.1.267 부터는 앱이 Ctrl+_
//  되돌리기를 갖는다 — 그 판에선 앱 것을 부른다, 아래 nativeUndoOk). 앱은 우리 것이 아니라
//  고칠 수 없으므로, 터미널이 **앱이 이미 지원하는 조작(커서 이동·백스페이스·kill·yank)만 써서** 두 기능을 합성한다.
//  즉 여기서 만드는 건 «새 프로토콜» 이 아니라 «키를 앱의 기존 조작으로 번역하는 규칙» 이다.
//
// 불변식 — 이 모듈은 순수하다(DOM·xterm·소켓을 모른다). 그래야 키 표를 그대로 단위 테스트한다.
//  실제 좌표 읽기·화면 칠하기·바이트 보내기는 terminal.ts 가 한다.

export interface KeyLike {
  key: string;
  shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean;
  isComposing?: boolean; keyCode?: number;
}

export interface LineEditCtx {
  mac: boolean;      // ⌘ 계열을 쓸 자리인가(맥 관례)
  hasSel: boolean;   // 지금 선택이 서 있나(terminal.ts 가 커서·앵커로 매번 새로 잰다)
  select: boolean;   // 선택 흉내를 켜 두었나(터미널 설정 — vim 처럼 자기 키가 있는 앱을 위해 끌 수 있다)
}

export type Unit = 'char' | 'word' | 'line';
export type Dir = -1 | 1;

export type Act =
  | { k: 'pass' }                                     // 손대지 않는다(종전 그대로 흘린다)
  | { k: 'clear' }                                    // 선택만 거두고 키는 그대로 흘린다
  | { k: 'send'; seq: string; kill?: boolean }        // 이 바이트를 보내고 키는 삼킨다. kill=앱 kill-ring 에 들어감
  | { k: 'extend'; seq: string; unit: Unit; dir: Dir } // 앵커를 세우고(없으면) 이 바이트로 커서를 옮겨 선택을 넓힌다
  | { k: 'del' }                                      // 선택을 지운다(키는 삼킨다)
  | { k: 'delThenPass' }                              // 선택을 지우고 그 키는 흘린다(글자로 갈아치우기)
  | { k: 'copy' }                                     // 선택을 클립보드로
  | { k: 'undo' };

// 앱이 이미 아는 조작들의 바이트. 셸(readline)·Claude Code 가 같은 뜻으로 받는 것만 골랐다.
export const SEQ = {
  left: '\x1b[D', right: '\x1b[C',
  home: '\x01', end: '\x05',        // Ctrl+A / Ctrl+E — 줄 처음·끝
  killHead: '\x15', killTail: '\x0b', // Ctrl+U / Ctrl+K — 커서 앞·뒤 지우기(둘 다 kill-ring 에 들어간다)
  wordLeft: '\x1bb', wordRight: '\x1bf',
  yank: '\x19',                      // Ctrl+Y — 마지막 kill 을 되붙인다(= 우리 되돌리기의 한 갈래)
  undo: '\x1f',                      // Ctrl+_ — readline·zsh 의 undo. Claude Code 는 2.1.267 부터(nativeUndoOk)
  back: '\x7f', del: '\x1b[3~',
};

const isPrintable = (k: string): boolean => Array.from(k).length === 1;

// **선택을 거둘 키만 열거한다.** 여기 없는 키는 선택을 건드리지 않는다 — «모르면 그대로 둔다» 가 기본값이다.
//  ★ 이 방향이 규칙이다. 종전엔 반대로 «처리 안 한 키는 전부 해제» 였는데, 그러면 **Shift 를 누르는 것 자체가**
//   선택을 지웠다(Shift 도 keydown 이다). ⌘C 하려고 ⌘ 를 누르는 순간도 마찬가지 — 선택을 만들고 쓰는 동작이
//   곧 선택을 죽였다(#3778 원준님 실측: «드래그는 되는데 그 상태가 지속이 안 된다»). 수정자·기능키·미디어키·
//   새로 생길 키는 전부 여기 없으므로 이제 선택을 건드리지 않는다.
//  거두는 것은 캐럿이 선택 밖으로 옮겨 갔거나(맨 화살표·Home/End·PageUp/Down) 줄이 끝난(Enter) 경우뿐.
const CLEARING_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Enter', 'Escape', 'Tab']);

/**
 * 키 하나를 보고 무엇을 할지 정한다. 순서가 규칙이다 — 되돌리기 → ⌘ 계열 → 선택 확장 → 선택이 선 상태의 처리.
 */
export function decideKey(e: KeyLike, c: LineEditCtx): Act {
  const shift = !!e.shiftKey, ctrl = !!e.ctrlKey, alt = !!e.altKey, meta = !!e.metaKey;
  const key = e.key || '';
  const lower = key.toLowerCase();

  // ── 되돌리기 ──────────────────────────────────────────────────────────────────
  //  Ctrl+Z 는 모든 플랫폼에서 되돌리기다(#3864). 종전엔 «터미널에서 Ctrl+Z 는 중단(SIGTSTP)이라 뺏지 않는다» 였는데,
  //  웹 터미널 pane 은 대화형 셸이 아니라 런처(lively-launch)라 하네스가 정지되면 `fg` 칠 곳이 없다 — 사람 손으로는
  //  못 되살린다(#3861 실사고: Claude Code 2.1.267 부터 Ctrl+Z = 정지). 돌던 명령을 멈추는 일은 Ctrl+C 가 그대로 한다.
  //  xterm 은 key 가 아니라 keyCode 로 0x1a 를 만들므로(한글 자판에선 key 가 'ㅋ') keyCode 90 도 같은 키로 본다.
  //  맥은 ⌘Z 도, 그 밖에서는 Alt+Z 도 되돌리기다(Alt+Z 는 readline 기본 바인딩이 없어 잃는 것이 없다).
  //  ⚠ 입력줄 선택 설정(c.select)과 무관하다 — 그 설정을 끈다고 정지 위험이 되살아나면 안 된다.
  const isZ = lower === 'z' || e.keyCode === 90;
  if (isZ && !shift && ((ctrl && !alt && !meta) || (!ctrl && c.mac && meta && !alt) || (!ctrl && !c.mac && alt && !meta))) return { k: 'undo' };

  // ── ⌘ 계열 넷 ─────────────────────────────────────────────────────────────────
  //  앱(Claude Code)은 ⌘←/→/⌫/⌦ 를 다 구현해 뒀는데 **xterm 이 ⌘ 를 PTY 로 안 보내** 앱까지 닿지 않는다.
  //  그래서 같은 뜻의 조작으로 번역해 보낸다(Option+←/→ 를 \eb/\ef 로 번역해 온 것과 같은 방식).
  if (c.mac && meta && !ctrl && !alt) {
    if (key === 'ArrowLeft') return shift ? { k: 'extend', seq: SEQ.home, unit: 'line', dir: -1 } : { k: 'send', seq: SEQ.home };
    if (key === 'ArrowRight') return shift ? { k: 'extend', seq: SEQ.end, unit: 'line', dir: 1 } : { k: 'send', seq: SEQ.end };
    if (key === 'Backspace') return c.hasSel ? { k: 'del' } : { k: 'send', seq: SEQ.killHead, kill: true };
    if (key === 'Delete') return c.hasSel ? { k: 'del' } : { k: 'send', seq: SEQ.killTail, kill: true };
    if (lower === 'c' && c.hasSel) return { k: 'copy' }; // 우리 선택이 서 있으면 그것이 «복사»의 대상이다
  }

  // ── 선택 확장 ─────────────────────────────────────────────────────────────────
  //  Shift+이동키. 보내는 바이트는 **선택 없는 평범한 이동과 똑같다** — 앱은 선택을 모르고, 넓어진 범위를
  //  기억하고 칠하는 건 우리다. 그래서 앱이 어떤 상태든 이 키가 앱을 망가뜨릴 일이 없다.
  if (c.select && shift && !ctrl) {
    if (!alt && !meta) {
      if (key === 'ArrowLeft') return { k: 'extend', seq: SEQ.left, unit: 'char', dir: -1 };
      if (key === 'ArrowRight') return { k: 'extend', seq: SEQ.right, unit: 'char', dir: 1 };
      if (key === 'Home') return { k: 'extend', seq: SEQ.home, unit: 'line', dir: -1 };
      if (key === 'End') return { k: 'extend', seq: SEQ.end, unit: 'line', dir: 1 };
    }
    if (alt && !meta) {
      if (key === 'ArrowLeft') return { k: 'extend', seq: SEQ.wordLeft, unit: 'word', dir: -1 };
      if (key === 'ArrowRight') return { k: 'extend', seq: SEQ.wordRight, unit: 'word', dir: 1 };
    }
  }

  // ── 선택이 서 있을 때 ─────────────────────────────────────────────────────────
  if (c.hasSel) {
    // 조합 중(IME)에는 **아무것도 지우지 않는다** — 조합 도중 바이트를 끼워 넣으면 음절이 깨진다(#1117·#1300 계열).
    //  선택만 거두고 물러난다. 사람이 다시 지우면 된다.
    if (e.isComposing) return { k: 'clear' };
    if (!ctrl && (key === 'Backspace' || key === 'Delete')) return { k: 'del' };
    if (!ctrl && !meta && !alt && (e.keyCode === 229 || isPrintable(key))) return { k: 'delThenPass' };
    // 캐럿이 선택 밖으로 갔거나 줄이 끝난 키만 해제. 그 밖(기능키·미디어키·모르는 키)은 그대로 둔다.
    if (CLEARING_KEYS.has(key) && !shift) return { k: 'clear' };
    if (key === 'Escape' || key === 'Enter') return { k: 'clear' }; // Shift 여부와 무관하게 끝난다
    // Ctrl/⌘ + 글자 = 줄을 바꾸거나 끊는 명령(^C 중단 · ^U/^K 지우기 · ⌘V 붙여넣기…). 우리가 처리한 것(⌘C 복사)은
    //  위에서 이미 돌아갔으므로, 여기 오는 것은 «앱이 줄을 건드릴 키» 다 → 선택을 거둔다(남기면 낡은 좌표가 된다).
    if ((ctrl || meta) && isPrintable(key)) return { k: 'clear' };
    return { k: 'pass' };
  }
  return { k: 'pass' };
}

// ── 되돌리기 스택 ───────────────────────────────────────────────────────────────
//  세 갈래만 담는다. 셋 다 «무엇을 되돌리는지»가 분명해서 되돌리기가 추측이 아니다.
//   yank  — 앱의 kill 명령(⌘⌫·⌘⌦·⌥⌫)으로 지운 것. 되돌리기는 앱의 Ctrl+Y 한 방이면 된다(글자를 우리가 몰라도 된다).
//   text  — 우리가 지운 선택. 지울 때 화면에서 읽어 뒀으므로 그대로 다시 넣는다.
//   typed — 방금 친 글자들. 그 수만큼 백스페이스.
export type UndoEntry = { k: 'yank' } | { k: 'text'; text: string } | { k: 'typed'; n: number };

const MAX_UNDO = 50;

export class UndoStack {
  private items: UndoEntry[] = [];
  private typed = 0; // 아직 스택에 넣지 않은 «지금 치고 있는 런»

  /** 타이핑 한 덩이를 센다. 되돌리기 단위를 «한 글자»가 아니라 «한 번에 친 만큼»으로 만든다. */
  type(n: number): void {
    if (!n) return;
    this.typed = Math.max(0, this.typed + n);
  }

  /** 타이핑 런을 끊는다(이동키·Enter 등 — 여기까지가 한 번에 되돌아갈 덩이다). */
  breakRun(): void {
    if (this.typed > 0) { this.items.push({ k: 'typed', n: this.typed }); this.trim(); }
    this.typed = 0;
  }

  push(e: UndoEntry): void { this.breakRun(); this.items.push(e); this.trim(); }

  /** 되돌릴 것 하나를 꺼낸다. 치던 런이 있으면 그것이 먼저다. */
  pop(): UndoEntry | null {
    this.breakRun();
    return this.items.pop() || null;
  }

  /** 보낸 뒤(Enter)에는 입력칸이 비므로 되돌릴 대상이 사라진다 — 남겨 두면 엉뚱한 자리에 옛 글이 들어간다. */
  reset(): void { this.items = []; this.typed = 0; }

  get depth(): number { return this.items.length + (this.typed > 0 ? 1 : 0); }

  private trim(): void { while (this.items.length > MAX_UNDO) this.items.shift(); }
}

// ── 앱 자체 되돌리기 (#3864) ────────────────────────────────────────────────────
//  Claude Code 는 2.1.267 부터 입력칸 되돌리기를 스스로 갖는다 — Ctrl+_(SEQ.undo)로 한 덩이씩 되돌리고 지운 글자도
//  되살린다(격리 인스턴스 실측). 2.1.266 번들엔 없었다(#3778 바이너리 실측). 앱은 입력칸의 진짜 이력(백스페이스로 지운
//  글자·붙여넣기·↑ 이력 호출)을 알지만 위 합성 스택은 우리가 본 세 갈래뿐이라, 앱 것이 있으면 그것을 부른다.
//  판은 pane 포그라운드 명령으로만 안다 — 네이티브 설치는 실행 파일 이름이 버전 문자열(`2.1.267`)이라 tmux 가 그걸 준다.
//  확인이 안 되면(상태 미수신·매니지드 `docker`·npm 설치 `node`·셸) false → 어느 판에서도 도는 합성으로.
const NATIVE_UNDO_MIN = [2, 1, 267];
export function nativeUndoOk(cmd: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(cmd || ''));
  if (!m) return false;
  for (let i = 0; i < 3; i++) {
    const d = Number(m[i + 1]) - NATIVE_UNDO_MIN[i];
    if (d !== 0) return d > 0;
  }
  return true;
}

/**
 * PTY 로 나가는 한 덩이가 «타이핑 몇 글자»인지 센다.
 *  · DEL(\x7f)은 방금 센 글자를 되돌린다 — 백스페이스도, 사파리 IME 의 «지우고 다시 쓰기» 치환도 이걸로 저절로 맞는다.
 *  · 제어문자를 만나면 타이핑이 아니다 → 덩이를 끊는다(null). ESC 로 시작하는 이동·기능키·괄호붙여넣기가 여기 걸린다
 *    (ESC 자체가 0x1b 라 이 한 규칙으로 덮인다 — 별도 조기반환을 뒀다가 변이 검사에서 «깨도 빨간불이 안 나는»
 *     중복 분기임이 드러나 걷어냈다).
 */
export function countTyped(d: string): number | null {
  if (!d) return 0;
  let n = 0;
  for (const ch of d) {
    const c = ch.codePointAt(0) as number;
    if (c === 0x7f) n--;
    else if (c < 0x20) return null;
    else n++;
  }
  return n;
}

// 세션 PTY 에 프롬프트를 넣는 **단일 통로** — 게이트웨이(로컬 tmux)와 노드 에이전트(자기 로컬 mux)가 같은 함수를 쓴다.
//  종전엔 이 로직이 scheduler/actions/_headless.ts 안에 인라인으로 있었고 tmux 를 직접 execFile 했다. 그래서
//  **게이트웨이 로컬 세션에만** 주입할 수 있었다 — 크론도, 리브(#1631)도 노드 세션(멤버 PC)에는 일을 시킬 수
//  없었다. 노드 프로토콜에 send-keys 계열 op 가 아예 없었기 때문이다(#1664).
//  여기로 빼면서 psmux(Windows 노드) 분기를 함께 넣는다 — 노드는 mac/linux(tmux)와 Windows(psmux) 둘 다다.
//
// 네 규약이 이 파일에 갇혀 있다. 하나라도 빠지면 주입이 **조용히** 반쪽이 된다:
//  ① **단일 라인** — `send-keys -l` 에 개행이 섞이면 그 자리에서 조기 제출된다(프롬프트가 잘려 나간다).
//     개행을 공백으로 평탄화해 한 단락 1회 제출로 만든다.
//  ② **flush 지연** — TUI(Claude Code)가 긴 텍스트를 다 그리기 전에 Enter 가 도착하면 '입력창에 텍스트만
//     남고 미제출' 상태가 된다(#606 도메인맵 부트스트랩에서 실측). 길이 비례 500~1500ms 를 둔다.
//  ③ **psmux 는 입력 표면이 다르다** — 3.3.7 은 `-H`(hex)를 받지 않고(공식 인자 문서가 명시 배제, 실측 일치 —
//     3.3.8 에서 구현됐지만 이미 떠 있는 세션은 옛 서버로 돈다) `-l`(리터럴)은 검증된 적이 없다. 실측으로 통과가 확인된 형태는 코드포인트 토큰(`0xNN`)뿐이라
//     terminal-pty 의 인코더를 그대로 재사용한다. Enter 도 키 이름이 아니라 `0x0d` 로 보낸다.
//     (자세한 근거는 terminal-pty.ts 의 'psmux 입력 경로' 절.)
//  ④ **tmux 도 청크** — 인자 하나가 16KiB 를 넘으면 tmux 가 명령을 통째로 거절한다(TMUX_LITERAL_CHUNK_BYTES).
//     그리고 **`;` 로 끝나는 인자는 tmux 가 명령 구분자로 먹는다**(literalArgv — 끝의 `;` 가 조용히 사라진다).
//  ⑤ **Claude Code 에는 글을 «붙여넣기»로 싣는다**(#4818 — PASTE_OPEN 머리말). 친 글과 Enter 가 한 번에 읽히면
//     Enter 가 글자로 박혀 제출이 안 된다. ②의 지연은 Claude Code 가 그 사이 입력을 읽어 줄 때만 성립한다.
import { TMUX_BIN, harnessLiveThemeSteps, harnessLiveThemeSupported, type LiveThemeStep } from "./catalog.js";
import { detectAwaiting, isSpinning, SHELL_CMDS } from "./phase.js";   // #1683 후속2 — 바쁜/모달 세션엔 키를 넣지 않는다 · #4818 셸 화면엔 표지를 안 싣는다
import { tmux, getOpt, chunkTmuxCommands } from "./tmux-exec.js";
import { isPsmuxBin, inputToSendKeysArgv } from "./terminal-pty.js";

// 텍스트가 pane 에 닿은 뒤 Enter 가 가도록 두는 창(규약 ②). 길이 비례이되 상·하한을 둔다 —
//  짧은 프롬프트에 1.5s 를 쓰면 크론 주입이 느려지고, 긴 프롬프트에 500ms 는 모자란다.
export const injectFlushMs = (len: number): number => Math.min(1500, Math.max(500, Math.round(len * 0.6)));

// tmux `send-keys -l` 한 번에 싣는 상한(바이트). tmux 는 명령 하나를 **16KiB 메시지 한 통**에 실어 서버로 보내고,
//  그보다 크면 `command too long` 으로 **통째로 거절**한다(실측 tmux 3.6a: 16,300바이트 통과 · 20,000바이트 거절).
//  한글은 글자당 3바이트라 약 5,400자 — 음성 받아쓰기 지시는 이걸 쉽게 넘는다. 실측 2026-09-22(원준님, 맥미니 노드
//  box-wonjoon-jang-3da5e47e): 홈에서 연 세션의 첫 지시가 이 거절로 **한 글자도 안 들어갔다**.
//  그래서 여러 번에 나눠 싣는다 — pane 에 닿는 바이트는 한 번에 보낸 것과 같다. 상한의 절반을 쓰는 이유는 argv 의
//  나머지(세션 id·플래그)와 메시지 머리도 같은 통에 들어가기 때문이다.
export const TMUX_LITERAL_CHUNK_BYTES = 8 * 1024;

/** 문자열을 UTF-8 바이트 상한으로 자른다(순수). ⚠ **코드포인트 경계에서만** 자른다 — tmux 가 인자를 UTF-8 로 풀어
 *  키로 바꾸므로 글자 가운데를 자르면 깨진 글자가 된다. `for..of` 는 코드포인트 단위라 서로게이트 쌍도 안 가른다. */
export function splitUtf8(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let cur = ""; let bytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (cur && bytes + b > maxBytes) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += b;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 실제로 넣는 한 줄(규약 ①) — 줄을 가르는 글자를 공백으로 편다(순수). 에코 바늘(session-outbox `flatOneLine`)도 이 함수다.
 *  LF 만이 아니다(#4818): **CR** 은 치면 그 자리에서 제출되고(Enter 와 같은 바이트), U+2028·U+2029 는 Claude Code 가
 *  «보이지 않는 글자» 로 지우며 제출을 멈춘다(«Removed 1 invisible character · review and press Enter to send», 2.1.301 실측).
 */
export function oneLineOf(text: string): string {
  return String(text ?? "").replace(/\s*[\n\r\u2028\u2029]\s*/g, " ").trim();
}

// ── 붙여넣기(bracketed paste) — 규약 ⑤ (#4818) ─────────────────────────────────────────────────────
//  실측(2026-10-16, Claude Code 2.1.301 · tmux 3.6a · 별도 tmux 서버): Claude Code 의 키 분해기는 **한 번에 읽은 입력이 64자
//   이상이면 그 안의 제어 글자(CR 포함)를 키로 떼어 내지 않고 글자로 둔다.** 아웃박스는 «글 → 0.5초 → Enter» 로 치는데,
//   그 0.5초 동안 Claude Code 가 입력을 안 읽으면(기동·되살리기 직후의 바쁜 이벤트 루프) 글과 Enter 가 한 덩어리로 읽힌다.
//   그러면 ① Enter 가 입력칸에 **글자 CR** 로 박히고(빈 줄 하나로 보인다) ② 다음 Enter 는 그 CR 을 «보이지 않는 글자» 로
//   지우며 «Removed 1 invisible character · review and press Enter to send» 를 띄우고 **제출하지 않는다** ③ 세 번째 Enter 에서야
//   들어간다. 아웃박스는 Enter 를 두 번만 눌러 «입력칸에 글 + 빈 줄, 미제출» 로 멈췄다(상민님 신고 화면과 같다).
//   64자 미만 글은 같은 조건에서도 첫 Enter 에 들어간다.
//  붙여넣기 표지(ESC[200~ … ESC[201~)로 감싸면 글은 붙여넣기 하나로 읽히고 뒤따르는 Enter 는 제 토큰이 된다 — 같은 조건에서
//   첫 Enter 에 제출됐다(표지 직접 싣기·tmux paste-buffer -p 둘 다). Claude Code 스스로 백그라운드 세션에 답을 넣을 때도
//   «붙여넣기 + CR» 이다(2.1.301 번들의 reply 경로).
//  ⚠ 붙여넣기 **한 번이 800자를 넘으면** Claude Code 가 입력칸에 «[Pasted text #1]» 로 접고 대화 기록에
//   `<pasted_content id=…>` 로 감싸 적는다 — 모델이 «사람이 다른 데서 붙여넣은 자료» 로 읽는다(실측). 그래서 PASTE_CHUNK_UNITS
//   조각으로 나눠 붙인다: 1,121자를 넷으로 붙이면 입력칸에 펼쳐진 그대로·기록도 평문 그대로였다(친 글과 같다).
//  ⚠ 표지는 **앱이 붙여넣기 모드를 켰을 때만** 뜻이 있다(안 켠 앱엔 «[200~» 가 글자로 찍힌다). tmux 엔 그 모드를 묻는 형식
//   변수가 없고, 모드를 보고 표지를 붙여 주는 `paste-buffer -p` 는 세션 지목 없는 `set-buffer` 가 앞서야 해서 매니지드의 tmux
//   해석기(tmux-route — `-t` 로 세션 컨테이너를 고른다)를 못 지난다. 그래서 **Claude Code 세션만**(입력칸이 살아 있는 동안 늘
//   켠다 — 2.1.301 번들 handleSetRawMode) 부른 쪽이 `paste` 로 고른다. 다른 하네스·셸은 종전 그대로 친다.
export const PASTE_OPEN = "\x1b[200~";
export const PASTE_CLOSE = "\x1b[201~";
/** 붙여넣기 한 번에 싣는 상한(UTF-16 단위 — Claude Code 가 재는 단위) — 접힘 문턱(800)보다 넉넉히 아래. */
export const PASTE_CHUNK_UNITS = 500;

/** 문자열을 UTF-16 길이 상한으로 자른다(순수) — 코드포인트 경계에서만(서로게이트 쌍을 안 가른다). */
export function splitUnits(text: string, maxUnits: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (cur && cur.length + ch.length > maxUnits) { out.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

//  ⚠ 이미지 경로 — Claude Code 2.1.301 의 붙여넣기 처리(번들 handlePaste)는 붙여넣은 글을 «`/`·`X:\` 앞의 공백» 과 줄바꿈에서 조각으로
//   자르고, 조각 하나가 **통째로** 이미지 경로면(앞뒤 공백·감싼 따옴표·역슬래시를 푼 뒤 `kAt = /\.(png|jpe?g|gif|webp)$/i`) 그 파일을 읽어
//   **글에서 그 조각을 빼고 이미지로 붙인다**(남은 조각은 줄바꿈으로 잇는다 · 못 읽으면 글 그대로). 실측(격리 리뷰 지적): «… The file is
//   /…/dot.png» 를 붙이면 입력칸 «[Image #1]… The file is» · 기록에 경로가 없다. 친 글(한 번에 800자 이하)은 그 처리를 안 탄다 — 붙여넣기로
//   바꾸며 생긴 차이다. 그래서 그런 조각이 붙여넣기 하나에 통째로 들지 않게 **조각 경계를 그 확장자 가운데(«.p|ng»)에 둔다** — 나뉜
//   두 쪽은 어느 쪽도 이미지 경로가 아니라 글 그대로 들어간다(실측). 파일이 있는지는 여기서 모른다 — 모양만 보고 자른다(자르기는 해가 없다).
const PASTE_SEGMENT_CUT = / (?=\/|[A-Za-z]:\\)/g;
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)$/i;
const unquoted = (s: string): string => ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) ? s.slice(1, -1) : s;
const unescaped = (s: string): string => s.replace(/\\\\|\\(.)/g, (_m, c: string | undefined) => c ?? "\\");

/** (순수) 이 글을 붙여넣기 하나로 실으면 Claude Code 가 이미지로 바꿀 조각이 있나 — 있으면 첫 그런 조각의 확장자 «.» 뒤 한 글자 자리(자를 곳), 없으면 -1. */
export function imagePathCut(piece: string): number {
  let start = 0;
  for (const end of [...[...piece.matchAll(PASTE_SEGMENT_CUT)].map((m) => m.index ?? 0), piece.length]) {
    for (const [off, seg] of lineSegments(piece.slice(start, end))) {
      if (!IMAGE_PATH.test(unescaped(unquoted(seg.trim())))) continue;
      return piece.lastIndexOf(".", start + off + seg.trimEnd().length - 1) + 2;
    }
    start = end + 1;
  }
  return -1;
}
/** 줄바꿈 조각(시작 자리 · 글) — 한 줄 글(규약 ①)엔 하나뿐이지만 Claude Code 와 같은 자리에서 자른다. */
function lineSegments(s: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let at = 0;
  for (const seg of s.split("\n")) { out.push([at, seg]); at += seg.length + 1; }
  return out;
}

//  ⚠ 포커스 꼬리 — 같은 처리는 붙여넣기 하나가 `[I`·`[O` 로 끝나면 그 두 글자를 지우고(포커스 보고 ESC[I·ESC[O 의 꼬리로 본다 —
//   번들 `Fde.rawEndedWithFocusTail`), 딱 `[I`·`[O` 면 빈 붙여넣기로 버린다(macOS 면 클립보드 이미지를 찾는다). 실측: 498자+«[I» 와
//   «NFO] x» 를 붙이면 «…NFO] x» · «[OK] done» 이 경계에 걸리면 «K] done»(격리 리뷰 지적). 그래서 조각이 그렇게 끝나지 않게 한 글자 앞에서 자른다.
const FOCUS_TAIL = /\[[IO]$/;

/** (순수) 붙여넣기 조각들 — PASTE_CHUNK_UNITS 상한(코드포인트 경계) · 이미지 경로 조각이 한 붙여넣기에 통째로 들지 않게 · 포커스 꼬리로 끝나지 않게(위). 이어 붙이면 원글이다. */
export function piecesToPaste(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest) {
    let piece = splitUnits(rest.slice(0, PASTE_CHUNK_UNITS + 1), PASTE_CHUNK_UNITS)[0];
    const cut = imagePathCut(piece);
    if (cut > 0 && cut < piece.length) piece = piece.slice(0, cut);
    if (FOCUS_TAIL.test(piece)) piece = piece.slice(0, -1);   // «…[» 로 끝내고 «I…» 는 다음 조각으로 — «[» 로 끝난 조각은 이미지 경로도 아니다
    out.push(piece);
    rest = rest.slice(piece.length);
  }
  return out;
}

/** 바이트 그대로 싣는 argv(`send-keys -H`) — 키 이름 해석·확장 키 인코딩을 안 탄다. */
const hexKeys = (id: string, s: string): string[] => ["send-keys", "-t", id, "-H", ...[...Buffer.from(s, "utf8")].map((b) => b.toString(16).padStart(2, "0"))];

/** 이 하네스에 글을 붙여넣기로 싣나(규약 ⑤) — Claude Code 만. */
export const pastesFor = (harness: string | null | undefined): boolean => String(harness ?? "").trim() === "claude";

//  붙여넣기는 **글**만 싣는다 — 제어 글자(탭 빼고 C0 · DEL)는 키다. 붙여넣기 안에 들어가면 키가 아니라 글자가 되고, Claude Code 는
//   제출할 때 그 글자를 «보이지 않는 글자» 로 지우며 멈춘다(«… review and press Enter to send»). 실제로 그런 글이 있다: 모델·추론강도
//   명령은 사람이 치던 글을 치워 두는 키(Ctrl+S, catalog runtimeDraftStash)를 앞에 붙여 보낸다 — 붙여넣으면 치워 두기도 안 되고
//   명령도 안 나간다. 그런 글은 종전대로 친다(키는 키로). 탭은 붙여넣기에서 공백 넷이 된다(친 탭은 자동완성을 부른다 — 붙이는 편이 낫다).
// eslint-disable-next-line no-control-regex
const KEYS_IN_TEXT = /[\x00-\x08\x0a-\x1f\x7f]/;

/**
 * 그 세션이 붙여넣기를 받나 — 부른 쪽이 하네스를 알면 그것으로, 모르면 이 호스트 tmux 의 `@box_harness` 로(규약 ⑤).
 *  ⚠ 표식이 비었거나 못 읽으면 **종전대로 친다**(붙여넣기를 모르는 앱에 표지를 흘리지 않는다).
 *  ⚠ 하네스 표식은 «그 세션이 무엇으로 떴나» 일 뿐 «지금 화면에 무엇이 있나» 가 아니다. 준비 판정 없이 치는 길(노드 sendKeys ·
 *   크론 주입)은 Claude Code 가 끝난 뒤의 셸에 닿을 수 있고, macOS 기본 bash 3.2 는 표지를 글자(«00~…01~»)로 찍는다(격리 리뷰 실측).
 *   그래서 포그라운드가 셸이면 친다. gVisor 에선 포그라운드가 `box-spawn` 으로만 보여 이 겹은 안 걸린다(그 길은 아웃박스가 준비를 본다).
 */
export async function sessionPastes(id: string, harness?: string | null): Promise<boolean> {
  if (!pastesFor(harness || await getOpt(id, "@box_harness"))) return false;   // getOpt 은 못 읽으면 "" 를 준다(던지지 않는다)
  const fg = await tmux(["display-message", "-p", "-t", id, "#{pane_current_command}"]).then((x) => String(x).trim(), () => "");
  return !SHELL_CMDS.has(fg);
}

/**
 * 리터럴 글을 싣는 argv 들(규약 ④) — 바이트 상한으로 자르고, **끝의 `;` 는 바이트(-H 3b)로** 싣는다.
 *  tmux 는 `;` 로 끝나는 인자를 명령 구분자로 읽어 그 `;` 하나를 먹는다(rc 0 · 아무 경고 없음): `foo;` → `foo` · `foo;;` → `foo;` ·
 *  `;` → 아무것도 안 감 · 가운데 `a;b` 는 그대로(tmux 3.6a 실측). 종전엔 글 끝에서만 났는데(«끝 `;`» 잠복, #4077) 붙여넣기 조각으로
 *  자르면 조각마다 경계가 생겨 지시 가운데서 글자가 사라진다(격리 리뷰 재현). 끝의 `;` 를 전부 떼어 바이트로 싣는다 —
 *  한 명령의 토큰은 SEMI_TOKENS_MAX 개까지(브로커 인자 상한 64 · 묶음 상한 60 안에 들게).
 */
const SEMI_TOKENS_MAX = 16;
function literalArgv(id: string, text: string): string[][] {
  const out: string[][] = [];
  for (const part of splitUtf8(text, TMUX_LITERAL_CHUNK_BYTES)) {
    const body = part.replace(/;+$/, "");
    if (body) out.push(["send-keys", "-t", id, "-l", "--", body]);
    for (let n = part.length - body.length; n > 0; n -= SEMI_TOKENS_MAX) out.push(["send-keys", "-t", id, "-H", ...Array<string>(Math.min(n, SEMI_TOKENS_MAX)).fill("3b")]);
  }
  return out;
}

export interface SendKeysOpts {
  /** 글을 붙여넣기 조각으로 싣는다(규약 ⑤ — Claude Code 세션만 참). psmux 는 무시한다(입력 표면이 다르다 — 규약 ③).
   *  글에 키(제어 글자)가 섞여 있으면 무시한다(KEYS_IN_TEXT 머리말). */
  paste?: boolean;
}

export interface SendKeysPlan {
  /** 평탄화된 실제 주입 문자열(규약 ①). 빈 문자열이면 보낼 것이 없다. */
  oneLine: string;
  /** 텍스트를 싣는 mux argv 들 — 순서대로 실행한다(psmux 는 청크로 갈릴 수 있다). */
  keys: string[][];
  /** 제출(Enter) argv. keys 를 다 보내고 flush 지연 뒤에 보낸다. */
  enter: string[];
}

/**
 * 주입 계획을 세운다(순수 함수 — 프로세스를 안 띄운다).
 *
 * 실행부와 갈라 둔 이유: 이 판단(무엇을 어떤 표면으로 보내나)이 플랫폼마다 다른데, Windows 노드를
 * CI 에서 못 띄운다. 순수 함수면 mac 에서도 psmux 규칙을 표로 못박을 수 있다.
 *
 * 인젝션 안전: 두 경로 다 execFile argv(셸 미경유)이고 psmux 경로는 값이 전부 `0x…` 토큰이라
 * `;kill-server;` 를 넣어도 화면에 리터럴로만 도달한다(terminal-pty 실측). 붙여넣기 표지는 고정 상수라 글이 표지를 못 바꾼다.
 */
export function sendKeysPlan(id: string, text: string, bin: string, opts: SendKeysOpts = {}): SendKeysPlan {
  const oneLine = oneLineOf(text);
  if (isPsmuxBin(bin)) {
    return { oneLine, keys: oneLine ? inputToSendKeysArgv(id, oneLine) : [], enter: ["send-keys", "-t", id, "0x0d"] };
  }
  //  `--` — 텍스트가 `-` 로 시작하면 tmux 가 그걸 **옵션으로 읽는다**(실측: `-foo` 는 `unknown flag -f` 로 거절,
  //   `-R` 은 조용히 삼켜져 한 글자도 안 간다). 마크다운 목록(«- 이거 해 줘») 으로 시작하는 지시가 그렇게 사라지고,
  //   청크로 자르면 경계마다 같은 일이 생길 수 있다. 매니지드 중계의 세션 해석(lvly-cloud sessionbroker)도 `--` 를
  //   옵션 구간 끝으로 읽으므로 `-t` 지목은 그대로다.
  //  붙여넣기 조각 하나(여는 표지 → 글 → 닫는 표지)는 tmux **한 번**에 `;` 로 이어 싣는다(chunkTmuxCommands — 첫 명령의 `-t` 로 라우팅).
  //   따로 부르면 중계에선 호출마다 0.5~1초(드물게 4.8초)라, 표지 사이가 2초를 넘으면 Claude Code 가 붙여넣기를 거기서 끊는다
  //   (2.1.301 키 읽기 — 붙여넣기 중 2초 무입력이면 흘려보냄). 조각끼리는 잇지 않는다: 한 묶음의 글 바이트를 조각 하나(≤2KB)로 묶어 둔다.
  const keys = !oneLine ? []
    : opts.paste && !KEYS_IN_TEXT.test(oneLine)
      ? piecesToPaste(oneLine).flatMap((piece) => chunkTmuxCommands([hexKeys(id, PASTE_OPEN), ...literalArgv(id, piece), hexKeys(id, PASTE_CLOSE)]))
      : literalArgv(id, oneLine);
  return { oneLine, keys, enter: ["send-keys", "-t", id, "Enter"] };
}

/**
 * 존재 확인(has-session) 단계에서 실패했다 = **한 글자도 안 들어갔다** (#2154).
 *
 *  왜 따로 두나: 이 함수의 실패는 두 종류인데 결과가 정반대다. 존재 확인에서 죽었으면 아무것도 안 갔으니
 *  **그대로 다시 보내도 안전**하고, 글자를 싣기 시작한 뒤에 죽었으면 입력칸에 반쪽이 남아 있을 수 있어
 *  **다시 보내면 안 된다**(이 파일과 session-outbox 머리말의 '중복을 만들지 않는다').
 *  종전엔 호출자가 그 둘을 구별할 수 없어 둘 다 실패로 버렸다 — 실측 2026-08-27: 노드 채널이 순간 빈
 *  `has-session … node channel unavailable` 하나에 사람의 지시("자꾸 매니지드 클로드코드 tui 맨아래
 *  프롬프트 입력 사라져…")가 통째로 사라졌다. `cause` 는 원래의 tmux 오류다(gone 확답 판정에 쓴다).
 */
export class SendKeysNotStarted extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SendKeysNotStarted";
    this.cause = cause;
  }
}

/** 치기가 멈춘 단계 — 세션 확인(`check`)에서 멈췄으면 **한 글자도 안 갔다**. 그 뒤(`text`·`enter`)는 입력칸에 무엇이 남았는지 모른다. */
export type SendKeysStage = "check" | "text" | "enter";

/**
 * 계획 하나를 **정해진 순서로** 싣는다 — 세션 확인 → 글자(청크 순서 = 글자 순서) → flush 대기(규약 ②) → Enter.
 *  이 호스트의 `sendKeysToSession` 과 세션 호스트의 아웃박스 치기(`outbox-host-step`)가 **같은 이 함수**를 쓴다(#2600 T2 d6 · #3773) —
 *  순서가 두 벌이면 한쪽만 고쳐진다(예: flush 를 Enter 뒤로 옮기는 실수가 한 자리에만 난다).
 *  실패는 던지지 않고 **멈춘 단계와 원래 오류**를 돌려준다 — «한 글자도 안 갔다» 를 예외로 알릴지 값으로 알릴지는 부른 쪽이 정한다.
 *  ⚠ 빈 계획(`oneLine` 이 빔)을 거르는 것도 부른 쪽이다 — 여기는 받은 계획을 싣기만 한다.
 */
export async function runSendKeysPlan(
  id: string,
  plan: SendKeysPlan,
  io: { tmux: (argv: string[]) => Promise<unknown>; sleep: (ms: number) => Promise<void> },
): Promise<{ ok: true } | { ok: false; stage: SendKeysStage; err: unknown }> {
  let stage: SendKeysStage = "check";
  try {
    await io.tmux(["has-session", "-t", id]);   // 부재면 여기서 멈춘다 — 없는 세션에 키를 흘리지 않는다
    stage = "text";
    for (const argv of plan.keys) await io.tmux(argv);
    await io.sleep(injectFlushMs(plan.oneLine.length));
    stage = "enter";
    await io.tmux(plan.enter);
    return { ok: true };
  } catch (err) {
    return { ok: false, stage, err };
  }
}

/**
 * 이 호스트의 mux 세션에 텍스트를 넣고 제출한다. 세션이 없으면 throw(호출자가 error 로 보고한다).
 *  `opts.paste` 는 부른 쪽이 고른다(규약 ⑤ — Claude Code 세션이면 `sessionPastes`). 안 주면 종전대로 친다(셸에 치는 자리가 있다).
 *
 * ⚠ 인가는 하지 않는다 — 게이트웨이 로컬 호출은 크론/관리세션 해소를 거쳐 오고, 노드 호출은
 *  게이트웨이가 소유·초대를 검증한 뒤 릴레이한다(정책=게이트웨이, 실행=노드 F7).
 */
export async function sendKeysToSession(id: string, text: string, opts: SendKeysOpts = {}): Promise<void> {
  const plan = sendKeysPlan(id, text, TMUX_BIN, opts);
  if (!plan.oneLine) throw new Error("주입할 텍스트가 비어 있습니다");
  const r = await runSendKeysPlan(id, plan, { tmux, sleep: (ms) => new Promise((res) => setTimeout(res, ms)) });
  // 세션 확인에서 죽었으면 **한 글자도 안 갔다**(SendKeysNotStarted). 그 뒤의 실패는 원래 오류 그대로 — 입력칸에 반쪽이 남았을 수 있다.
  if (!r.ok) throw r.stage === "check" ? new SendKeysNotStarted(r.err) : r.err;
}

// ── 단일 키(Enter·Escape) — 대화 화면(#1719 세션 대화창)이 승인·중단을 대신 누른다 ──
//  텍스트 주입과 **다른 통로**를 두는 이유: Claude Code 의 승인 대화상자는 글자가 아니라 키(Enter=기본 선택 승인 /
//  Esc=거부·중단)로 답한다. `sendKeysToSession` 은 문자열을 넣고 flush 를 기다린 뒤 Enter 를 붙이므로 그 자리에 쓸 수 없다.
//  받는 키를 둘로 못박는다 — 화면이 보낼 수 있는 키가 곧 화면이 대신할 수 있는 행동의 전부다(임의 키 릴레이는 만들지 않는다).
export const CHAT_KEYS = ["Enter", "Escape"] as const;
export type ChatKey = typeof CHAT_KEYS[number];
export const isChatKey = (k: unknown): k is ChatKey => (CHAT_KEYS as readonly string[]).includes(String(k));

/** 키 하나를 보내는 argv(순수) — tmux 는 키 이름, psmux 는 코드포인트 토큰(위 규약 ③). */
export function sendKeyPlan(id: string, key: ChatKey, bin: string): string[] {
  if (isPsmuxBin(bin)) return ["send-keys", "-t", id, key === "Enter" ? "0x0d" : "0x1b"];
  return ["send-keys", "-t", id, key];
}

export async function sendKeyToSession(id: string, key: ChatKey): Promise<void> {
  await tmux(["has-session", "-t", id]);
  await tmux(sendKeyPlan(id, key, TMUX_BIN));
}

// ── 목록에서 **아래로 한 칸** (#3626) ────────────────────────────────────────────────────────
//  CHAT_KEYS 를 안 늘린다: 저건 «화면이 사람 대신 누를 수 있는 행동»의 전부라는 계약이라(위 주석),
//  임의 키 릴레이로 넓히면 그 계약이 무너진다. 이건 릴레이가 아니라 **우리가 우리 대화상자를 넘길 때**만
//  쓰는 내부 이동이라 별도 함수로 둔다.
//  ⚠ psmux 는 키 이름을 모른다 — 방향키는 터미널이 보내는 것과 같은 이스케이프(ESC [ B)를 코드포인트로 넣는다.
//   토큰 폭 규약(2자리 이상)은 inputToSendKeysArgv 가 지킨다.
const ARROW_DOWN = "\x1b[B";
export function sendDownPlan(id: string, bin: string): string[][] {
  if (isPsmuxBin(bin)) return inputToSendKeysArgv(id, ARROW_DOWN);
  return [["send-keys", "-t", id, "Down"]];
}

/** 목록 선택을 아래로 n 칸 옮긴다(0 이면 아무것도 안 보낸다). */
export async function sendDownToSession(id: string, times = 1): Promise<void> {
  if (times <= 0) return;
  await tmux(["has-session", "-t", id]);
  for (let i = 0; i < times; i++) for (const argv of sendDownPlan(id, TMUX_BIN)) await tmux(argv);
}

// ── 실행 중 세션의 테마 전환 (#1683 후속2) ─────────────────────────────────
//  하네스의 자체 테마 명령을 그 pane 에 넣는다. 시퀀스는 catalog 의 HARNESS_LIVE_THEME 이 소유하고
//  (하네스 TUI 메뉴에 기대는 값이라 한 곳에 모아 둔다) 여기는 그걸 **순서대로 흘리는 일**만 한다.
//
// ⚠ 사람이 입력창에 쓰던 글이 있으면 우리 글자가 그 뒤에 붙는다 — 그래서 이 함수는 **사람이 명시적으로
//  '열린 탭 모두 적용'을 켠 순간에만** 불린다(자동 주입 금지). 지우고 시작하지 않는 이유도 같다:
//  C-u 로 비우면 그 사람의 초안이 사라진다. 남의 글을 지우는 것보다 한 줄 덧붙는 편이 되돌리기 쉽다.
export interface LiveThemeResult {
  /** 'applied' 이 아닌 값은 **사람에게 그대로 알린다**(조용한 실패 금지 — catalog 주석 ②). */
  status: "applied" | "unsupported" | "gone" | "error" | "busy";
  detail?: string;
}

export async function applyLiveTheme(id: string, harnessKey: string, theme: unknown): Promise<LiveThemeResult> {
  if (!harnessLiveThemeSupported(harnessKey)) {
    return { status: "unsupported", detail: `${harnessKey} 는 실행 중 테마 지정을 지원하지 않습니다` };
  }
  // ★ 바쁜 세션·모달에 걸린 세션은 **건너뛴다**(실측 사고, 2026-08-24): 하네스가 일하는 중이면 `/theme` 이
  //  선택창을 띄우지 못하고 **그냥 프롬프트로 큐에 쌓인다** — 그 세션은 테마도 안 바뀌고 대화에 `/theme`·`2`
  //  같은 쓰레기 지시만 남는다(상민님 세션에서 실제로 그렇게 들어갔다). 승인 대화상자에 멈춘 세션도 같다:
  //  우리 글자가 그 모달의 답으로 먹혀 엉뚱한 선택을 누를 수 있다.
  //  그래서 '지금 조용히 입력창을 띄우고 있는' 세션에만 넣는다. 아니면 사유를 돌려주고 화면이 사람에게 말한다.
  {
    const busy = await sessionBusyOrModal(id);
    if (busy) return { status: "busy", detail: busy };
  }
  const steps = harnessLiveThemeSteps(harnessKey, theme);
  if (!steps.length) return { status: "unsupported", detail: "테마 값이 해석되지 않았습니다" };
  try { await tmux(["has-session", "-t", id]); }
  catch { return { status: "gone", detail: "세션이 이미 없습니다" }; }
  try {
    for (const st of steps) await runStep(id, st);
    return { status: "applied" };
  } catch (e: any) {
    return { status: "error", detail: (e && e.message) || "전환 중 오류" };
  }
}

async function runStep(id: string, st: LiveThemeStep): Promise<void> {
  if (st.kind === "wait") { await new Promise((r) => setTimeout(r, st.ms)); return; }
  if (st.kind === "enter") { await tmux(sendKeyPlan(id, "Enter", TMUX_BIN)); return; }
  // 글자 — sendKeysPlan 의 청크·psmux 인코딩 규약을 그대로 재사용하고 **Enter 는 붙이지 않는다**
  //  (제출 시점을 시퀀스가 정한다. 선택창 번호처럼 '누르는 순간 적용'인 자리엔 Enter 가 오면 안 된다).
  const plan = sendKeysPlan(id, st.text, TMUX_BIN);
  for (const argv of plan.keys) await tmux(argv);
  await new Promise((r) => setTimeout(r, injectFlushMs(plan.oneLine.length)));
}

/** 지금 키를 넣으면 안 되는 상태인가 — 그 사유(넣어도 되면 null). 관측은 **라이브 pane** 에서 한다(기억 아님).
 *  ① pane 타이틀 스피너 = 하네스가 일하는 중 → 넣으면 `/theme` 이 프롬프트로 큐에 쌓인다(실측 사고).
 *  ② 승인·선택 모달 = 우리 글자가 그 모달의 답으로 먹힌다 → 엉뚱한 선택을 누를 수 있다.
 *  둘 다 phase.ts 의 판정을 그대로 쓴다 — 같은 화면을 두 기준으로 읽지 않는다. */
async function sessionBusyOrModal(id: string): Promise<string | null> {
  try {
    const title = await tmux(["display-message", "-p", "-t", id, "#{pane_title}"]);
    if (isSpinning(String(title || ""))) return "작업 중이라 건너뛰었습니다";
  } catch { /* 타이틀을 못 읽어도 아래 pane 관측으로 판단한다 */ }
  try {
    const pane = await tmux(["capture-pane", "-t", id, "-p"]);
    if (detectAwaiting(String(pane || ""))) return "확인창이 떠 있어 건너뛰었습니다";
    return null;
  } catch { return "화면을 읽지 못해 건너뛰었습니다"; }
}

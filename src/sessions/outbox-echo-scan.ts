// 에코 판정 한 벌(#4819 · #4851) — «그 말이 하네스에 들어갔나» 를 대화 기록에서 찾는 순수 규칙과 기록 훑기.
//
//  ── 왜 한 벌인가 ──
//  같은 질문을 세 자리가 묻는다: 아웃박스가 친 직후(session-outbox waitEcho) · 화면이 큐를 읽을 때 다시(outbox-late-echo) ·
//   화면이 이미 그린 기록으로(web/lib/outbox-echo.ts — 계약 시험 E3 이 같은 규칙인지 잰다). 규칙이 갈리면 한 자리만 거짓 «전달됨» 을 낸다.
//  #4851 전엔 친 직후 판정만 따로였다 — 기록 끝 256KB 에 그 말(머리 160자)이 **글자로 있기만 하면** «전달됨» 이었다. 보내기 전에 있던
//   같은 말 · Claude Code 가 매 턴 되풀이해 적는 last-prompt 줄 · AI 답 속 같은 글에 곧바로 걸렸고, 첫 확인에서 «전달됨» 으로 끝나
//   #4818 제출 지킴이(입력칸에 글이 남았으면 Enter)가 돌 틈도 없었다(«진행해»·«1» 같은 짧은 말은 거의 늘 걸린다).
//  ⇒ 이제 셋 다 «보낸 뒤에 적힌 사람 말 줄» 만 증거로 본다.
//
//  ── 이 모듈의 경계 ──
//  · 순수 판정(promptOfLine · samePrompt · exactPrompt · scanLinesForPrompt)과 줄 맞춤 훑기(findPromptInTranscript)뿐이다 — DB·로그·
//    기록 찾기(transcript-locate)를 들이지 않는다. session-outbox.ts 가 이걸 쓰는데 그 모듈은 노드 번들의 알려진 부채라
//    (scripts/node-agent-known-debt.json) 여기 들인 것은 멤버 PC 로 나간다 — 그래서 줄 맞춤(harness-io/window — 이미 승인 목록)만 들인다.
import { readAlignedWindow, type ByteReader } from "../terminal/harness-io/window.js";

/** 같은 말 판정의 머리 길이 — 아주 긴 글은 TUI 를 지나며 꼬리가 뒤섞일 수 있어(실측 2026-08-18, 3천자 프롬프트) 머리만 견준다.
 *  화면(web/lib/outbox-echo.ts PROMPT_HEAD)·«다 쳤다» 알림 머리(session-outbox typedHead)도 같은 값이다(계약 시험이 맞춘다). */
export const ECHO_HEAD_CHARS = 160;
/** 큐·아웃박스 시각(게이트웨이 DB·프로세스 시계)과 기록 시각(하네스가 도는 기계의 시계)의 차이 허용. */
export const ECHO_SKEW_MS = 5_000;
/** 거슬러 읽을 때 한 번에 읽는 창 기본값 — 중계에선 원격 읽기 한 번. */
export const SCAN_WINDOW_BYTES = 1024 * 1024;
/** 한 번의 훑기에서 읽는 상한 기본값(실제로 읽은 바이트) — 넘으면 그 앞은 못 본 채로 둔다(«못 찾음» — 안전한 쪽). */
export const SCAN_BYTES = 8 * 1024 * 1024;

const norm = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();

//  사람이 친 빗금 명령은 기록에 **친 글 그대로가 아니라 태그 묶음으로** 남는다(Claude Code — 이 맥 기록 · 2.1.301 실측 · #4851):
//   · 로컬 명령 — `<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>sonnet</command-args>`.
//     모델 맥락에 남는 것(/model · /clear · /compact · /export · /exit …)은 user 줄(앞에 isMeta caveat 줄)로, **화면만 띄우는 것(/context · /usage ·
//     /status · /help · /mcp · /resume …)은 system 줄(subtype local_command)로** 적힌다. 대화상자를 여는 명령은 그 창을 닫을 때에야 적힌다.
//   · 프롬프트형(명령 파일 · 스킬 · /doctor …) — `<command-message>…</command-message>\n<command-name>/loop</command-name>\n<command-args>…</command-args>`(인자 없으면 args 줄이 없다).
//   · 별칭은 풀린 이름으로 적힌다(친 /cost → /usage) · 모르는 명령은 «Unknown command» 알림 줄뿐 · /exit 는 대개(하네스가 먼저 끝나) 아무것도 안 남는다 ·
//     /btw · 취소한 /rewind 도 안 남는다. 그런 명령은 기록이 아니라 화면이 말한다(session-outbox slashCommandLeftInput).
//  그래서 친 글 «/model sonnet» 은 이 줄의 글과 같을 수 없었다 — 대화창에서 보낸 `/exit` 가 늘 «미확인» 으로 남은 까닭(매니지드 행 131318).
//  태그 묶음을 친 꼴 «/이름 인자» 로 되돌려 같은 말 판정에 넣는다. 사람 글이 태그로 **시작**할 때만 읽는다(글 속에 태그를 인용한 말은 그대로).
const CMD_LEAD = /^\s*<command-(?:name|message)>/;
const CMD_NAME = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>/;
const CMD_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** (순수) 빗금 명령 줄의 글(태그 묶음) → 친 꼴 «/이름 인자». 그 꼴이 아니면 null. */
export function typedCommandOf(text: string): string | null {
  if (!CMD_LEAD.test(text)) return null;
  const name = CMD_NAME.exec(text)?.[1];
  if (!name) return null;
  const args = (CMD_ARGS.exec(text)?.[1] ?? "").trim();
  return args ? `${name} ${args}` : name;
}

/**
 * (순수) 기록 한 줄이 **사람이 보낸 말**이면 그 글과 갈래, 아니면 null.
 *  · user 줄의 text 블록(또는 문자열 본문) — 주입(isMeta)·서브에이전트 가지(isSidechain)·도구 결과(tool_result 만 있는 줄)는 아니다.
 *    빗금 명령 줄(태그 묶음)은 친 꼴 «/이름 인자» 로 돌려준다(typedCommandOf).
 *  · 화면만 띄우는 로컬 명령의 system 줄(subtype local_command · 태그 묶음) — 친 꼴로 돌려준다. 그 명령의 출력 줄은 아니다.
 *  · 도는 중에 친 말(queued: true) — Claude Code 는 그 턴의 다음 틈에 `{"type":"attachment","attachment":{"type":"queued_command",
 *    "prompt":…}}` 로 적는다(실측: commandMode 'prompt' · origin {kind:'human'}). 같은 줄 모양에 작업 끝 알림·세션 간 메시지도 실리지만
 *    그 글은 사람이 보낸 말과 같을 수 없어 글 대조에서 걸러진다.
 *  · 도는 중에 받은 말의 «대기열에 넣었다» 줄(`{"type":"queue-operation","operation":"enqueue","content":…}`) — Claude Code 는 Enter 를 받은 즉시
 *    원문 그대로 이 줄을 적는다(2.1.301 실측 0.3초). 끼워 넣은 말 줄은 도구가 끝나야 적혀(실측 28초 뒤 — 긴 도구면 몇 분) 그동안 «미확인» 경고가
 *    떴다. 하네스가 그 말을 받았다는 증거로 충분하다. Enter 가 먹히지 않아 두 말이 이어 붙어 들어간 판(«/context끝나면 알려줘» — 실측)은 어느 말과도
 *    같지 않아 증거가 안 된다(그 판의 경고는 사실이다).
 *  다른 하네스의 줄도 이 모양이다 — 어댑터(harness-io/*.ts)가 공통 ChatLine(user 줄의 text = 사람 말)으로 올린다.
 */
export function promptOfLine(line: unknown): { text: string; queued: boolean } | null {
  if (!line || typeof line !== "object") return null;
  const o = line as Record<string, any>;
  if (o.type === "system" && o.subtype === "local_command") {
    const cmd = typeof o.content === "string" && !o.isMeta && !o.isSidechain ? typedCommandOf(o.content) : null;
    return cmd ? { text: cmd, queued: false } : null;
  }
  if (o.type === "queue-operation" && o.operation === "enqueue" && typeof o.content === "string") {
    return { text: o.content, queued: false };
  }
  if (o.type === "user") {
    if (o.isMeta || o.isSidechain) return null;
    const c = o.message?.content;
    let text: string;
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      const texts = c.filter((b: any) => b && b.type === "text").map((b: any) => String(b.text ?? ""));
      if (!texts.length) return null;
      text = texts.join("\n");
    } else return null;
    return { text: typedCommandOf(text) ?? text, queued: false };
  }
  if (o.type === "attachment" && o.attachment?.type === "queued_command" && typeof o.attachment.prompt === "string") {
    return { text: o.attachment.prompt, queued: true };
  }
  return null;
}

/** (순수) 같은 말인가 — 공백을 하나로 접은 뒤, 160자 이하면 전체가, 그보다 길면 머리 160자가 같아야 한다. */
export function samePrompt(said: string, line: string): boolean {
  const a = norm(said), b = norm(line);
  if (!a || !b) return false;
  if (a.length <= ECHO_HEAD_CHARS) return a === b;
  return a.slice(0, ECHO_HEAD_CHARS) === b.slice(0, ECHO_HEAD_CHARS);
}

/** (순수) 글이 통째로 같은가 — 공백만 하나로 접는다. 늦게(제때 창 뒤에) 적힌 줄은 이 규칙으로만 증거가 된다. */
export function exactPrompt(said: string, line: string): boolean {
  const a = norm(said);
  return !!a && a === norm(line);
}

/** (순수) 친 글이 빗금 명령 꼴인가 — `/이름`(글자로 시작 · 플러그인 `a:b` 포함) 뒤가 공백이거나 끝. `/tmp/x.txt` 처럼 경로로 이어지는 글은 아니다.
 *  쓰는 곳은 «기록에 아무것도 안 남을 수 있는 말인가» 판단뿐이다(session-outbox — 화면이 입력칸을 떠났다고 말할 때만 경고 없이 마감). */
export function looksLikeSlashCommand(text: string): boolean {
  return /^\/[A-Za-z][\w:-]*(?:\s|$)/.test(String(text ?? "").trim());
}

/** 증거 시각 창(ms). notBefore 앞은 증거가 아니고, …NotAfter 는 «제때» 의 끝이다 — 그 뒤는 글이 통째로 같을 때만 증거다(outbox-late-echo 머리말).
 *  친 직후 판정(session-outbox)은 «제때» 끝을 두지 않는다(Infinity) — 기다리는 동안 적힌 줄이 곧 그 말의 짝이다. */
export interface EchoWindow { notBefore: number; userNotAfter: number; queuedNotAfter: number }

/**
 * (순수) 줄 묶음에서 그 말을 찾는다 — 하한 뒤에 적힌 사람 말 줄만 본다. 제때 창 안이면 같은 말(samePrompt), 그 뒤면 통째로 같은 글(exactPrompt).
 *  earliestMs = 이 묶음에서 가장 이른 시각 — 거슬러 읽기가 «행이 생기기 전» 까지 왔는지 판단하는 근거다(시각 없는 줄은 안 센다).
 */
export function scanLinesForPrompt(lines: readonly unknown[], said: string, win: EchoWindow):
  { found: boolean; at: string | null; earliestMs: number | null } {
  let earliest: number | null = null;
  for (const l of lines) {
    const raw = (l as { timestamp?: unknown } | null)?.timestamp;
    const ts = typeof raw === "string" ? Date.parse(raw) : NaN;
    if (!Number.isFinite(ts)) continue;
    if (earliest === null || ts < earliest) earliest = ts;
    if (ts < win.notBefore) continue;
    const p = promptOfLine(l);
    if (!p) continue;
    const timely = ts <= (p.queued ? win.queuedNotAfter : win.userNotAfter);
    if (timely ? samePrompt(said, p.text) : exactPrompt(said, p.text)) return { found: true, at: new Date(ts).toISOString(), earliestMs: earliest };
  }
  return { found: false, at: null, earliestMs: earliest };
}

/** 대조할 기록 — 파일 하나의 크기·읽기·해석. 실제는 대화 파일(로컬 fs 또는 멤버 중계)이, 시험은 메모리 버퍼가 채운다(둘 다 alignedSource). */
export interface EchoSource {
  file: string;
  size: number;
  /**
   * [start,end) 를 줄 경계에 맞춰 읽고 해석한 줄 — from/to 는 맞춘 경계(readAlignedWindow 와 같은 뜻).
   *  bytes = 이 창을 맞추느라 **실제로 읽은** 바이트(긴 한 줄을 지날 땐 창보다 훨씬 클 수 있다 — 읽기 상한은 이 값으로 센다).
   */
  window(start: number, end: number): Promise<{ from: number; to: number; lines: unknown[]; bytes: number }>;
  /** 날 바이트 [start,end) — 창보다 긴 한 줄을 건너뛸 때 그 줄 끝(개행)을 찾는 데만 쓴다(줄 맞춤은 요청한 창 끝 너머의 개행 자리를 안 알려 준다). */
  raw(start: number, end: number): Promise<Buffer>;
}

/**
 * 바이트 읽기 + 해석기 → 대조할 기록. 줄 경계 맞춤은 대화창 창과 같은 규칙(readAlignedWindow)이고, 끝은 늘 «명시» 로 맞춘다 —
 *  거슬러 읽을 때 다음 창의 끝이 앞 창의 시작(줄 경계)과 정확히 만나고, 파일 끝의 쓰는 중인 반 줄은 잘라 낸다(window.ts 끝 정렬 ①②).
 * @param read 파일을 열어 ByteReader 로 fn 을 돌린다(로컬 fs 또는 멤버 중계 — transcript-fs).
 */
export function alignedSource(
  file: string, size: number,
  read: <T>(fn: (r: ByteReader) => Promise<T>) => Promise<T>,
  parse: (text: string) => unknown[],
): EchoSource {
  return {
    file, size,
    async window(start, end) {
      let bytes = 0;
      const w = await read((r) => readAlignedWindow({
        async read(s, e) { const b = await r.read(s, e); bytes += b.length; return b; },
      }, size, start, end, true));
      return { from: w.from, to: w.to, lines: w.data.length ? parse(w.data.toString("utf8")) : [], bytes };
    },
    raw: (start, end) => read((r) => r.read(start, Math.min(end, size))),
  };
}

/** 한 행에 대해 «어디까지 읽었나» — 다음엔 그 뒤만 읽는다. aligned=false 면 그 자리가 거대한 한 줄의 가운데다(줄 끝부터 잇는다). */
export interface EchoMemo { file: string; scannedTo: number; aligned?: boolean }

/** from 부터 날 바이트로 개행을 찾아 그 뒤 자리를 준다 — 예산 안에 못 찾으면 읽은 데까지(aligned=false). used = 읽은 바이트. */
async function skipToLineEnd(src: EchoSource, from: number, budget: number, step: number): Promise<{ pos: number; aligned: boolean; used: number }> {
  let p = from, used = 0;
  while (used < budget && p < src.size) {
    const b = await src.raw(p, Math.min(src.size, p + step));
    if (!b.length) break;
    used += b.length;
    const i = b.indexOf(0x0a);
    if (i >= 0) return { pos: p + i + 1, aligned: true, used };
    p += b.length;
  }
  return { pos: p, aligned: false, used };
}

/**
 * 그 말이 기록에 있나 — 메모가 없으면 꼬리부터 거슬러(증거 창 하한 앞까지·상한까지), 있으면 메모 뒤에 자란 만큼만 앞으로.
 *  scannedTo = 다음 대조가 이어 읽을 자리. 파일이 바뀌었으면(맥락 압축으로 새 파일) 처음부터 다시 거슬러 읽는다.
 */
export async function findPromptInTranscript(
  src: EchoSource, said: string, win: EchoWindow, memo: EchoMemo | null,
  o: { windowBytes?: number; scanBytes?: number } = {},
): Promise<{ found: boolean; at: string | null; scannedTo: number; aligned: boolean }> {
  const W = o.windowBytes ?? SCAN_WINDOW_BYTES;
  let budget = o.scanBytes ?? SCAN_BYTES;
  if (memo && memo.file === src.file && memo.scannedTo <= src.size) {
    // 앞으로 — 지난번 끝부터 지금 끝까지.
    let pos = memo.scannedTo;
    if (memo.aligned === false) {
      //  지난번이 거대한 한 줄 가운데서 멈췄다 — 그 줄 끝(개행)부터 잇는다. 창으로 바로 읽으면 줄 맞춤이 요청한 창 끝을 «다음 시작» 으로
      //   돌려줘 창 하나씩만 나아가며 매번 줄 끝까지 다시 읽는다(시험 F10 이 잡은 꼴).
      const s = await skipToLineEnd(src, pos, budget, W);
      budget -= s.used; pos = s.pos;
      if (!s.aligned) return { found: false, at: null, scannedTo: pos, aligned: false };
    }
    while (pos < src.size && budget > 0) {
      const w = await src.window(pos, Math.min(src.size, pos + W));
      budget -= w.bytes;
      if (w.to <= pos) {
        //  온전한 줄이 없다 — ① 파일 끝이 쓰는 중인 반 줄(다음 대조가 잇는다) ② 창과 줄 끝 찾기 상한(window.ts MAX_LINE_SCAN)을 다 써도
        //   안 끝나는 거대한 한 줄(이미지가 든 도구 결과 등). ②면 그 줄 끝까지 날 바이트로 건너뛴다 — 그 줄은 사람이 친 말일 수 없다(아웃박스가
        //   치는 글은 수 MB 가 아니다). 안 건너뛰면 기억이 그 앞에 멈춰 다음 대조마다 같은 수 MB 를 다시 읽는다(격리 리뷰 실측: 6MB 줄 →
        //   매번 원격 읽기 33회). 예산 안에 줄 끝을 못 찾으면 읽은 데까지 기억하고(aligned=false) 다음 대조가 거기서 잇는다.
        if (!(w.bytes >= W && pos + w.bytes < src.size)) break;
        const s = await skipToLineEnd(src, pos + w.bytes - 1, budget, W);   // w.bytes 는 시작 정렬용 앞 1바이트를 포함한다 — 아직 안 본 첫 바이트부터
        budget -= s.used; pos = s.pos;
        if (!s.aligned) return { found: false, at: null, scannedTo: pos, aligned: false };
        continue;
      }
      const r = scanLinesForPrompt(w.lines, said, win);
      if (r.found) return { found: true, at: r.at, scannedTo: w.to, aligned: true };
      pos = w.to;
    }
    return { found: false, at: null, scannedTo: pos, aligned: true };
  }
  // 거슬러 — 꼬리 창부터. 첫 창의 끝(마지막 온전한 줄 뒤)이 다음 대조의 시작이다.
  let end = src.size; let scannedTo = -1;
  while (end > 0 && budget > 0) {
    const start = Math.max(0, end - W);
    const w = await src.window(start, end);
    if (scannedTo < 0) scannedTo = w.to;
    const r = scanLinesForPrompt(w.lines, said, win);
    if (r.found) return { found: true, at: r.at, scannedTo, aligned: true };
    if (r.earliestMs !== null && r.earliestMs < win.notBefore) break;   // 행이 생기기 전까지 다 봤다 — 그 앞엔 이 말이 있을 수 없다
    budget -= w.bytes;                                                 // 실제로 읽은 만큼 — 긴 줄을 지나며 늘려 읽은 것까지
    if (start === 0) break;
    //  다음 창은 이 창이 시작한 줄 경계에서 끝난다. 이 구간 전체가 긴 한 줄 안이면(시작 경계를 못 찾음) 날 경계로 물러난다 —
    //   다음 창의 끝은 줄 끝까지 늘려 읽히므로(readAlignedWindow 끝 정렬 ①) 그 긴 줄도 빠지지 않는다.
    end = w.from < end ? w.from : start;
  }
  return { found: false, at: null, scannedTo: Math.max(0, scannedTo), aligned: true };
}

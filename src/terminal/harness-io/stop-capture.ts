// 하네스를 끄기 직전 화면에서 **쓰다 만 글**과 **답을 기다리던 질문**을 읽는다 (#4695 T5 하네스 종료 규칙). 순수 — 표는 stop-capture.test.ts.
//
// ── 왜 화면인가 ─────────────────────────────────────────────────────────────────────────────────────
//  · 쓰다 만 글은 하네스 프로세스 메모리에만 있다 — 끄면 사라진다. 대화 파일엔 보낸 말만 적힌다.
//  · 질문(선택 질문·실행 승인)은 claude 에선 **대화 파일에도 안 남는다**: 질문 창이 떠 있을 때 끄면 그 AI 메시지(질문·선택지·도구 호출)가
//    파일에 없다(실측 claude 2.1.300 3/3 · T2 #4692 2/2). 답이 나야 파일에 적힌다. 그래서 끄기 직전 화면이 유일한 출처다.
//    codex 0.162.1 은 반대로 승인 요청이 rollout 에 남아 `codex resume` 이 **같은 승인 창을 다시 띄운다**(1/1) — reappears.
//
// ── 실측한 화면 모양 (2026-10-15, 이 맥미니 · 별도 tmux 서버) ───────────────────────────────────────────
//  claude 2.1.300 입력창 — 가로줄 둘 사이:
//      ────────────…                                   ← 줄(옛 판은 ╭───╮ 상자)
//      ❯ 보내지 않은 글입니다 — draft …                 ← «❯» 다음 NBSP( ). 빈 칸이면 흐린 글씨(SGR 2)로 «Try "…"» 예시가 뜬다
//        이어서 길게 씁니다 …                           ← 이어지는 줄 = 2칸 들여쓰기(낱말 경계에서 접힌다 · 실제 줄바꿈도 같은 모양)
//      ────────────…
//  claude 질문 창(AskUserQuestion) — 입력창 대신:
//      ────────────…
//      ←  ☐ 색  ☐ 과일  ✔ Submit  →                    ← 질문이 여럿이면 탭 줄(→ 키로 넘긴다 · Submit 탭에서도 Enter 없이는 제출 안 됨)
//       ☐ 색상                                          ← 질문이 하나면 머리 이름
//      가장 좋아하는 색은?
//      ❯ 1. 빨강
//           빨간색                                      ← 선택지 설명(더 깊은 들여쓰기)
//        4. Type something.                             ← 직접 쓰기(여러 개 고르기면 «[ ] Type something»)
//      ────────────…
//        5. Chat about this
//      Enter to select · ↑/↓ to navigate · Esc to cancel
//  claude 실행 승인:
//      ────────────…
//       Bash command
//       Tip: auto mode handles these prompts for you — …
//       Create empty file perm-test-4695.txt
//      ╌╌╌╌╌╌…
//       touch perm-test-4695.txt                       ← 실행하려던 대상
//      ╌╌╌╌╌╌…
//       Do you want to proceed?
//       ❯ 1. Yes
//         2. Yes, and always allow access to … from this project
//         4. No
//       Esc to cancel · Tab to amend
//  codex 0.162.1 입력창: «›»(굵게) 다음 글. 빈 칸이면 흐린 글씨로 «Ask Codex to do anything». 이어지는 줄은 2칸 들여쓰기 · **글자 단위로 접힌다**.
//  codex 승인 창:
//      • Running touch codex-perm-4695.txt
//        Would you like to run the following command?
//        Reason: …
//        $ touch codex-perm-4695.txt
//      › 1. Yes, proceed (y)
//        2. Yes, and don't ask again for commands that start with `…` (p)
//        3. No, and tell Codex what to do differently (esc)
//        Press enter to confirm or esc to cancel
//  agy 1.1.22 입력창: 가로줄 둘 사이 «> » 다음 글(예시 글 없음). 질문 창은 실측 못 했다(훅 실패로 안 떴다) — 모양을 모르면 화면 글 그대로 남긴다.
//
// ⚠ 틀리는 방향: 못 읽으면 null(쪽지에 안 남는다). 끄기는 쪽지와 무관하게 간다(글이 있다고 끄기를 미루지 않는다 — 규칙 정본).
import type { StopQuestion } from "../../sessions/session-state.js";

/** 한 화면 — 같은 줄 수의 원문(색 신호 포함)과 맨글. */
export interface ScreenCapture { raw: string[]; plain: string[] }

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>]/g;
export function stripAnsi(s: string): string { return s.replace(ANSI, ""); }

/** `tmux capture-pane -p -e` 결과 → 줄 단위(끝 공백 제거). */
export function captureOf(rawText: string): ScreenCapture {
  const raw = String(rawText || "").split("\n").map((l) => l.replace(/\s+$/u, ""));
  while (raw.length && !stripAnsi(raw[raw.length - 1]).trim()) raw.pop();
  return { raw, plain: raw.map((l) => stripAnsi(l).replace(/ /g, " ")) };
}

const RULE = /^\s*[╭╰]?─{3,}/;                 // 입력창·대화상자 가로줄(옛 판 상자 포함)
const DASH = /^\s*╌{3,}/;                      // 승인 창의 대상 상자
/**
 * 원문이 **흐린 글씨(SGR 2)로 시작**하나 — 빈 입력칸의 예시 글(claude «Try "…"» · codex «Ask Codex to do anything»)을 사람이 친 글과 가른다.
 *  앞쪽 SGR 묶음들을 차례로 읽어 마지막 상태를 본다. ⚠ «38;2;R;G;B»(트루컬러)의 2 는 흐림이 아니다 — 색 지정 인자는 건너뛴다.
 */
export function startsDim(raw: string): boolean {
  let dim = false;
  let rest = raw;
  for (;;) {
    const m = /^\x1b\[([0-9;]*)m/.exec(rest);
    if (!m) break;
    const ps = m[1] === "" ? ["0"] : m[1].split(";");
    for (let i = 0; i < ps.length; i++) {
      const v = ps[i];
      if (v === "38" || v === "48" || v === "58") { i += ps[i + 1] === "5" ? 2 : ps[i + 1] === "2" ? 4 : 1; continue; }
      if (v === "2") dim = true;
      else if (v === "0" || v === "22") dim = false;
    }
    rest = rest.slice(m[0].length);
  }
  return dim && rest.length > 0;
}

/** claude·agy 처럼 **가로줄 둘 사이**에 입력창이 있는 화면에서 그 줄들(맨 아래 상자). 없으면 null. */
function ruledInputBox(cap: ScreenCapture): { from: number; to: number } | null {
  const rules: number[] = [];
  cap.plain.forEach((l, i) => { if (RULE.test(l)) rules.push(i); });
  if (rules.length < 2) return null;
  const to = rules[rules.length - 1];
  const from = rules[rules.length - 2];
  if (to - from < 2) return null;
  return { from: from + 1, to };
}

/** 프롬프트 줄의 글자 부분 — 맨글(text)과, 기호 뒤 원문(rawRest — 흐린 예시 글 판정용). 기호가 없으면 null. */
function afterPrompt(raw: string, plain: string, marks: RegExp): { rawRest: string; text: string } | null {
  const m = marks.exec(plain);
  if (!m) return null;
  const text = plain.slice(m[0].length);
  //  원문에서 기호 다음 자리 — 사이에 낀 색 신호와 한 칸(공백·NBSP)을 건너뛴다(색 신호는 남겨 흐림 판정에 쓴다).
  const symAt = raw.search(/[❯›>]/u);
  if (symAt < 0) return { rawRest: "", text };
  let rest = raw.slice(symAt + 1);
  const sgr: string[] = [];
  for (;;) {
    const s = /^\x1b\[[0-9;]*m/.exec(rest);
    if (s) { sgr.push(s[0]); rest = rest.slice(s[0].length); continue; }
    if (/^[  ]/u.test(rest)) { rest = rest.slice(1); continue; }
    break;
  }
  return { rawRest: sgr.join("") + rest, text };
}

/** 이어지는 줄을 붙인다 — claude·agy 는 낱말 경계에서 접혀 공백으로, codex 는 글자 단위로 접혀 그대로 붙인다. */
function joinWrapped(first: string, rest: string[], sep: string): string {
  return [first, ...rest].map((x, i) => (i === 0 ? x : x.replace(/^ {2}/, ""))).join(sep).replace(/\s+$/u, "");
}

/**
 * 쓰다 만 글 — 하네스 입력창에 남아 있는 글. 없거나(빈 칸·예시 글) 못 읽으면 null.
 *  ⚠ «[Pasted text #1 +12 lines]» 같은 접힌 붙여넣기 표시는 그대로 돌려준다 — 원문은 화면에 없다(사람이 그 표시를 보고 안다).
 */
export function draftFromScreen(harness: string, cap: ScreenCapture): string | null {
  if (harness === "codex") return codexDraft(cap);
  //  대화상자(질문·승인)가 떠 있으면 입력칸이 없다 — 대화상자의 가로줄 사이를 입력칸으로 읽지 않는다(격리 리뷰 — 지금 실측 화면에선 재현 안 되는 보험).
  if (screenAsks(cap)) return null;
  return ruledInputText(cap) || null;
}

/**
 * claude·agy 입력칸(가로줄 둘 사이 «❯ …»)의 글 — 빈 칸(예시 글 포함)이면 "", **입력칸을 못 찾으면 null**.
 *  `draftFromScreen` 은 둘을 다 null 로 접는다(쪽지엔 «없음» 하나면 된다). 아웃박스의 제출 확인(submit-check, #4818)은
 *  «비었다(제출됐다)» 와 «모르는 화면» 을 갈라야 해서 이 함수를 따로 둔다. ⚠ 대화상자 판정(screenAsks)은 부른 쪽이 먼저 한다.
 *  ⚠ 흐린 예시 글은 원문(-e 캡처)이 있어야 가린다 — 맨글만 받으면 예시 글도 글로 돌아온다.
 */
export function ruledInputText(cap: ScreenCapture): string | null {
  const box = ruledInputBox(cap);
  if (!box) return null;
  const marks = /^\s*(?:│\s*)?(?:❯|>)\s?/u;
  const ap = afterPrompt(cap.raw[box.from], cap.plain[box.from], marks);
  if (!ap) return null;
  if (startsDim(ap.rawRest)) return "";                              // 예시 글(흐린 글씨) = 빈 칸
  const rest = cap.plain.slice(box.from + 1, box.to).map((l) => l.replace(/\s*│\s*$/u, ""));
  return joinWrapped(ap.text.replace(/\s*│\s*$/u, ""), rest, " ").trim();
}

/** 줄머리 «›» 앞의 SGR 인자들(굵게 1 · 흐림 2 · 반전 7 …). «›» 로 시작하지 않으면 null. */
function promptSgr(raw: string): Set<string> | null {
  const m = /^((?:\x1b\[[0-9;]*m)*)›/u.exec(raw);
  if (!m) return null;
  const ps = new Set<string>();
  for (const s of m[1].matchAll(/\x1b\[([0-9;]*)m/g)) for (const p of (s[1] || "0").split(";")) ps.add(p);
  return ps;
}

function codexDraft(cap: ScreenCapture): string | null {
  //  대화상자(승인 창)가 떠 있으면 입력칸이 없다 — 그 화면의 «›» 줄은 지난 사람 말이거나 선택지 커서다.
  if (screenAsks(cap)) return null;
  //  입력 줄 = **굵게만** 칠한 «›»(실측 `\x1b[1m›`). 지난 사람 말은 굵게+흐림(`\x1b[1;2m› `), 선택지 커서는 굵게+반전(`\x1b[1;7m›`)이다.
  let at = -1;
  for (let i = cap.raw.length - 1; i >= 0; i--) {
    const ps = promptSgr(cap.raw[i]);
    if (!ps || !ps.has("1") || ps.has("2") || ps.has("7")) continue;
    if (/^\s*›\s*\d+\.\s/u.test(cap.plain[i])) continue;                      // 번호 선택지
    at = i; break;
  }
  if (at < 0) return null;
  const ap = afterPrompt(cap.raw[at], cap.plain[at], /^\s*›\s?/u);
  if (!ap) return null;
  if (startsDim(ap.rawRest)) return null;
  //  이어지는 줄 = 색 신호 없이 두 칸 들여쓴 글(아래 꼬리줄 «모델 · 폴더» 는 색으로 시작한다).
  const rest: string[] = [];
  for (let i = at + 1; i < cap.raw.length; i++) {
    if (!/^ {2}[^\s\x1b]/u.test(cap.raw[i])) break;
    rest.push(cap.plain[i]);
  }
  const text = joinWrapped(ap.text, rest, "").trim();
  return text || null;
}

// ── 질문 ─────────────────────────────────────────────────────────────────────────────────────────

const OPT = /^\s*(?:[❯›>]\s*)?(\d{1,2})\.\s+(.*\S)\s*$/u;
const HINT = /Enter to select|to navigate|Esc to cancel|Press enter to confirm|enter Confirm|Tab to amend/i;
const TAB_BAR = /^\s*←.*→\s*$/u;
const FREE = /^(?:\[[ x✓✔]\]\s*)?Type something\.?$/iu;
const META = /^Chat about this$/iu;

/** claude 질문 여러 개의 탭 이름(Submit 제외). 탭 줄이 없으면 빈 배열. */
export function questionTabs(cap: ScreenCapture): string[] {
  const line = cap.plain.find((l) => TAB_BAR.test(l));
  if (!line) return [];
  const names = [...line.matchAll(/[☐☒✔✓]\s+(.+?)(?=\s{2,}|\s*[☐☒✔✓→]|$)/gu)].map((m) => m[1].trim()).filter(Boolean);
  return names.filter((n) => !/^Submit$/i.test(n));
}

//  입력칸이 떠 있다는 꼬리 안내 — phase.ts INPUT_BOX 와 같은 문구다(claude·agy). 이게 보이면 대화상자가 없다(모달이 뜨면 입력칸이 감춰진다).
const INPUT_FOOTER = /\b(?:auto|manual|plan|accept edits|bypass permissions) mode on\b|\? for shortcuts|shift\+tab to cycle/i;
const MENU_CURSOR = /^\s*[❯›]\s*\d{1,2}[.)]\s/u;

/**
 * 이 화면이 아직 답을 기다리는 대화상자인가. 끄기 직전 «그새 답이 났나» 를 다시 볼 때 쓴다.
 *  ⚠ 입력칸 안내가 보이면 거짓이다 — claude 는 지난 사람 말도 «❯ » 로 그려서, 번호 목록을 보냈던 대화가 선택지 커서처럼 보인다(#853 오탐).
 *  커서 줄(❯ 1. · › 1.)이 있거나, 번호 선택지 + 안내 줄(Enter to select …)이 함께 있으면 참. Submit 탭처럼 안내 줄이 없는 창도 커서로 잡는다.
 */
export function screenAsks(cap: ScreenCapture): boolean {
  const tail = cap.plain.filter((l) => l.trim() !== "").slice(-30);
  if (tail.some((l) => INPUT_FOOTER.test(l))) return false;
  if (tail.some((l) => MENU_CURSOR.test(l))) return true;
  return tail.some((l) => OPT.test(l)) && tail.some((l) => HINT.test(l));
}

/**
 * 답을 기다리던 질문 — 화면에서 읽은 것. 대화상자가 아니면 null.
 *  여러 질문(claude 탭)은 **지금 보이는 하나**만 읽는다 — 나머지는 부르는 쪽이 → 키로 넘기며 `questionItemFromScreen` 을 다시 부른다.
 */
export function questionFromScreen(harness: string, cap: ScreenCapture): StopQuestion | null {
  const item = questionItemFromScreen(cap);
  if (!item) return null;
  const blob = [item.header ?? "", item.text].join("\n");
  const kind: StopQuestion["kind"] = /Would you like to run|Do you want to (?:proceed|make|create|allow|run)|permission/i.test(blob) ? "permission"
    : /\bplan\b|Ready to code/i.test(blob) ? "plan"
    : (questionTabs(cap).length || item.header) ? "ask" : "other";
  const target = kind === "permission" ? permissionTarget(cap) : undefined;
  return {
    kind, items: [item],
    ...(target ? { target } : {}),
    //  codex 는 승인 요청이 대화 파일(rollout)에 남아 이어 열면 같은 창이 다시 뜬다(실측 0.162.1 1/1). claude 는 안 뜬다(3/3).
    ...(harness === "codex" ? { reappears: true } : {}),
  };
}

const BULLET = /^\s*•\s/u;
/**
 * 대화상자의 자리 — 닻(마지막 커서 줄 «❯/› N.», 없으면 마지막 안내 줄 바로 위의 번호 줄)에서 위로 올라가 가장 가까운 경계(가로줄 · 탭 줄 ·
 *  codex «•» 줄)까지가 대화상자다. ⚠ 화면 전체의 첫 번호 줄을 잡으면 **전사(대화)에 남은 번호 목록**이 질문·선택지로 섞인다(격리 리뷰 재현:
 *  승인 창 위에 AI 가 쓴 «1. … 2. …» 가 있으면 kind 가 permission → other 로 바뀌고 선택지 앞에 목록이 붙었다). 대화상자는 늘 화면 맨 아래에 있다.
 *  선택지 사이를 가르는 가로줄(«4. Type something.» 과 «5. Chat about this» 사이)은 경계가 아니다 — 그 줄 바로 다음이 번호 줄이면 더 올라간다.
 */
function dialogSpan(p: string[]): { top: number; first: number } | null {
  let anchor = -1;
  for (let i = p.length - 1; i >= 0; i--) if (MENU_CURSOR.test(p[i])) { anchor = i; break; }
  if (anchor < 0) {
    let hint = -1;
    for (let i = p.length - 1; i >= 0; i--) if (HINT.test(p[i])) { hint = i; break; }
    for (let i = hint - 1; hint > 0 && i >= 0; i--) if (OPT.test(p[i]) && !RULE.test(p[i])) { anchor = i; break; }
    if (anchor < 0) return null;
  }
  const nextFilled = (i: number): string => { for (let j = i + 1; j < p.length; j++) if (p[j].trim()) return p[j]; return ""; };
  let top = anchor - 1;
  for (; top >= 0; top--) {
    if (TAB_BAR.test(p[top]) || BULLET.test(p[top])) break;
    if (RULE.test(p[top]) && !OPT.test(nextFilled(top))) break;
  }
  for (let i = top + 1; i <= anchor; i++) if (OPT.test(p[i]) && !RULE.test(p[i])) return { top, first: i };
  return null;
}

/** 지금 보이는 질문 하나(머리·글·선택지). 번호 선택지가 없으면 null. */
export function questionItemFromScreen(cap: ScreenCapture): StopQuestion["items"][number] | null {
  const p = cap.plain;
  const span = dialogSpan(p);
  if (!span) return null;
  const { top, first } = span;
  const head = p.slice(top + 1, first).map((l) => l.trim()).filter((l) => !!l && !DASH.test(l) && !/^Tip:/i.test(l));
  //  codex 승인은 «•» 줄 자체가 머리(무엇을 하려던 참인가)다.
  const bullet = top >= 0 && BULLET.test(p[top]) ? p[top].replace(/^\s*•\s*/u, "").trim() : "";
  //  claude 단일 질문의 머리 이름(☐ 색상)과 승인 창의 제목(Bash command)은 첫 줄이다 — 글에서 떼어 header 로 둔다.
  let header: string | undefined;
  if (head.length && /^[☐☒✔✓]\s+/u.test(head[0])) header = head.shift()!.replace(/^[☐☒✔✓]\s+/u, "");
  else if (head.length > 1 && !/[?？]\s*$/u.test(head[0])) header = head.shift();
  if (bullet) header = header ? `${bullet} — ${header}` : bullet;
  const options: Array<{ n: number; label: string; desc?: string }> = [];
  let multi = false;
  let free = false;
  for (let i = first; i < p.length; i++) {
    const l = p[i];
    if (HINT.test(l)) break;
    if (RULE.test(l) || !l.trim()) continue;
    const m = OPT.exec(l);
    if (m) {
      let label = m[2].trim();
      if (/^\[[ x✓✔]\]\s+/u.test(label)) { multi = true; label = label.replace(/^\[[ x✓✔]\]\s+/u, ""); }
      label = label.replace(/\s+\((?:y|p|n|a|esc|enter)\)\s*$/iu, "");   // codex 단축키 꼬리
      if (FREE.test(label)) { free = true; continue; }
      if (META.test(label)) continue;
      options.push({ n: Number(m[1]), label });
      continue;
    }
    //  설명 줄 — 바로 앞 선택지에 붙인다(여러 줄이면 이어 붙인다). «Next» 같은 단추 글은 설명이 아니다.
    const prev = options[options.length - 1];
    const t = l.trim();
    if (prev && t && !/^Next$/i.test(t)) prev.desc = prev.desc ? `${prev.desc} ${t}` : t;
  }
  if (!options.length && !free) return null;
  const text = head.join("\n").trim();
  return { ...(header ? { header } : {}), text, options, ...(multi ? { multi: true } : {}), ...(free ? { free: true } : {}) };
}

/** 승인 창이 실행하려던 대상 — claude 는 ╌ 상자 안, codex 는 «$ » 줄. 없으면 undefined. */
function permissionTarget(cap: ScreenCapture): string | undefined {
  const p = cap.plain;
  const dashes = p.flatMap((l, i) => (DASH.test(l) ? [i] : []));
  if (dashes.length >= 2) {
    const inside = p.slice(dashes[dashes.length - 2] + 1, dashes[dashes.length - 1]).map((l) => l.trim()).filter(Boolean);
    if (inside.length) return inside.join("\n").slice(0, 2000);
  }
  const dollar = [...p].reverse().find((l) => /^\s*\$\s+\S/u.test(l));
  return dollar ? dollar.replace(/^\s*\$\s+/u, "").trim().slice(0, 2000) : undefined;
}

/**
 * 끄기 직전 화면이 **지금 턴이 도는 화면**인가 — 목록을 본 뒤 끄기까지 사이에 새 턴이 시작됐으면 끄지 않는다(마지막 확인).
 *  claude 는 하네스 어댑터의 판정(«esc to interrupt» · 스피너 줄)을 그대로 쓴다 — 부르는 쪽이 넘긴다.
 */
export type RunJudge = (tail: string[]) => string | null;
export function screenRunning(cap: ScreenCapture, run?: RunJudge | null): boolean {
  if (!run) return false;
  const v = run(cap.plain.filter((l) => l.trim() !== "").slice(-30));
  return v === "turn" || v === "background";
}

// 쪽지 크기 상한 — 화면 한 장이라 원래 작지만, 붙여넣은 긴 글이 그대로 접히지 않은 판도 있어 상한을 둔다.
export const DRAFT_MAX_CHARS = 8_000;
export function clampDraft(s: string | null): string | null {
  if (!s) return null;
  return s.length > DRAFT_MAX_CHARS ? s.slice(0, DRAFT_MAX_CHARS) : s;
}

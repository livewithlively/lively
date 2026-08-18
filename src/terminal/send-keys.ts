// 세션 PTY 에 프롬프트를 넣는 **단일 통로** — 게이트웨이(로컬 tmux)와 노드 에이전트(자기 로컬 mux)가 같은 함수를 쓴다.
//  종전엔 이 로직이 scheduler/actions/_headless.ts 안에 인라인으로 있었고 tmux 를 직접 execFile 했다. 그래서
//  **게이트웨이 로컬 세션에만** 주입할 수 있었다 — 크론도, 리브(#1631)도 노드 세션(멤버 PC)에는 일을 시킬 수
//  없었다. 노드 프로토콜에 send-keys 계열 op 가 아예 없었기 때문이다(#1664).
//  여기로 빼면서 psmux(Windows 노드) 분기를 함께 넣는다 — 노드는 mac/linux(tmux)와 Windows(psmux) 둘 다다.
//
// 세 규약이 이 파일에 갇혀 있다. 하나라도 빠지면 주입이 **조용히** 반쪽이 된다:
//  ① **단일 라인** — `send-keys -l` 에 개행이 섞이면 그 자리에서 조기 제출된다(프롬프트가 잘려 나간다).
//     개행을 공백으로 평탄화해 한 단락 1회 제출로 만든다.
//  ② **flush 지연** — TUI(Claude Code)가 긴 텍스트를 다 그리기 전에 Enter 가 도착하면 '입력창에 텍스트만
//     남고 미제출' 상태가 된다(#606 도메인맵 부트스트랩에서 실측). 길이 비례 500~1500ms 를 둔다.
//  ③ **psmux 는 입력 표면이 다르다** — `-H`(hex)를 받지 않고(공식 인자 문서가 명시 배제, 실측 일치)
//     `-l`(리터럴)은 검증된 적이 없다. 실측으로 통과가 확인된 형태는 코드포인트 토큰(`0xNN`)뿐이라
//     terminal-pty 의 인코더를 그대로 재사용한다. Enter 도 키 이름이 아니라 `0x0d` 로 보낸다.
//     (자세한 근거는 terminal-pty.ts 의 'psmux 입력 경로' 절.)
import { TMUX_BIN } from "./catalog.js";
import { tmux } from "./tmux-exec.js";
import { isPsmuxBin, inputToSendKeysArgv } from "./terminal-pty.js";

// 텍스트가 pane 에 닿은 뒤 Enter 가 가도록 두는 창(규약 ②). 길이 비례이되 상·하한을 둔다 —
//  짧은 프롬프트에 1.5s 를 쓰면 크론 주입이 느려지고, 긴 프롬프트에 500ms 는 모자란다.
export const injectFlushMs = (len: number): number => Math.min(1500, Math.max(500, Math.round(len * 0.6)));

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
 * `;kill-server;` 를 넣어도 화면에 리터럴로만 도달한다(terminal-pty 실측).
 */
export function sendKeysPlan(id: string, text: string, bin: string): SendKeysPlan {
  const oneLine = String(text ?? "").replace(/\s*\n\s*/g, " ").trim();
  if (isPsmuxBin(bin)) {
    return { oneLine, keys: oneLine ? inputToSendKeysArgv(id, oneLine) : [], enter: ["send-keys", "-t", id, "0x0d"] };
  }
  return { oneLine, keys: oneLine ? [["send-keys", "-t", id, "-l", oneLine]] : [], enter: ["send-keys", "-t", id, "Enter"] };
}

/**
 * 이 호스트의 mux 세션에 텍스트를 넣고 제출한다. 세션이 없으면 throw(호출자가 error 로 보고한다).
 *
 * ⚠ 인가는 하지 않는다 — 게이트웨이 로컬 호출은 크론/관리세션 해소를 거쳐 오고, 노드 호출은
 *  게이트웨이가 소유·초대를 검증한 뒤 릴레이한다(정책=게이트웨이, 실행=노드 F7).
 */
export async function sendKeysToSession(id: string, text: string): Promise<void> {
  const plan = sendKeysPlan(id, text, TMUX_BIN);
  if (!plan.oneLine) throw new Error("주입할 텍스트가 비어 있습니다");
  await tmux(["has-session", "-t", id]);          // 부재면 throw — 없는 세션에 키를 흘리지 않는다
  for (const argv of plan.keys) await tmux(argv); // 청크 순서 = 글자 순서
  await new Promise((r) => setTimeout(r, injectFlushMs(plan.oneLine.length)));
  await tmux(plan.enter);
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

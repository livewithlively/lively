// 사람 없이 도는 작업(증류·분류·관리)의 자격을 **화면에서** 발급받는다 (#4012 T12 · #4051).
//
//  ── 왜 ──
//  중앙 샌드박스 판(T3)은 **등록된 헤드리스 자격만** 쓴다(node/sandbox-credentials SANDBOX_CREDS). 그런데 그 자격을
//  넣는 길이 «터미널에서 `claude setup-token` 을 돌려 나온 토큰을 숨은 화면에 붙여넣기» 뿐이었다. 웹만 쓰는 첫 사용자는
//  거기서 막히고, 막힌 줄도 모른다(증류가 조용히 `no_credential` 로 끝난다). 여기서는 «화면에서 끝나는 로그인»(#2477)
//  통로에 발급을 얹는다 — 서버가 명령을 돌리고, 사람은 주소를 열어 승인하고 코드만 붙여넣는다. **토큰은 사람이 보지도
//  복사하지도 않는다.** 러너가 화면에서 잡아 따로 된 파일로 넘기고, 서버가 곧바로 멤버 비밀로 저장한다.
//
//  ── 하네스마다 다른 것 (실측 2026-09-17, claude 2.1.273 · codex 0.153.4) ──
//   · claude `claude setup-token` — **TTY 가 아니면 아무것도 안 찍는다**(파이프로 8초 동안 출력 0바이트). Ink 화면이라
//     PTY 가 필요하고, 좁은 창이면 주소가 여러 줄로 접힌다. 그래서 러너가 전용 tmux(넓은 창)에서 띄우고 **그려진 화면**을
//     읽는다(capture-pane). 모양은 `claude auth login` 과 같다 — 주소 한 줄 + `Paste code here if prompted >`.
//     승인 범위는 `scope=user:inference` 뿐이다(대화형 로그인의 org:create_api_key·user:profile 등이 없다).
//   · codex  `codex login --device-auth` 를 **따로 된 CODEX_HOME** 에서 — 주소 + 일회용 코드. 끝나면 그 홈의 auth.json
//     통째가 자격이다(`codex_auth_json`). 평소 로그인과 refresh token 을 나눠 쓰면 한쪽이 다른 쪽을 무효화한다(T2 실측
//     성질) — 그래서 멤버 홈의 ~/.codex 를 빌리지 않고 새로 받는다.
//
//  ── 경계 ──
//  이 파일은 **순수**다(프로세스·파일·DB 없음). 실행은 ai-login-run.ts(러너), 저장은 org/credentials/headless-connect.ts.
import { parseAiLogin, type AiLoginState, type AiLoginStep } from "./ai-login-flow.js";

/** 이 통로로 헤드리스 자격을 받을 수 있는 하네스 — 중앙 샌드박스 판이 빌리는 표(SANDBOX_CREDS)와 같은 목록이어야 한다. */
export const HEADLESS_LOGIN_HARNESSES = ["claude", "codex"] as const;
export type HeadlessLoginHarness = (typeof HEADLESS_LOGIN_HARNESSES)[number];

export function isHeadlessLoginHarness(k: string): k is HeadlessLoginHarness {
  return (HEADLESS_LOGIN_HARNESSES as readonly string[]).includes(k);
}

/**
 * 받은 자격을 저장할 멤버 비밀 종류.
 *  ⚠ `node/sandbox-credentials.SANDBOX_CREDS` 의 kind 와 **같아야 한다**(시험이 둘을 대조한다). 어긋나면 발급은 끝났다고
 *   말하는데 판은 여전히 `no_credential` 이다 — 이 통로가 없애려는 바로 그 조용한 실패다.
 */
export const HEADLESS_SECRET_KIND: Readonly<Record<HeadlessLoginHarness, string>> = Object.freeze({
  claude: "claude_setup_token",
  codex: "codex_auth_json",
});

/** 사람에게 보여 줄 이름. */
export const HEADLESS_LABEL: Readonly<Record<HeadlessLoginHarness, string>> = Object.freeze({
  claude: "Claude",
  codex: "ChatGPT(Codex)",
});

/**
 * 발급 명령(argv). 실행은 러너가 한다.
 *  codex 는 자격을 **파일로** 남기게 못박는다(`cli_auth_credentials_store=file`) — 설정에 따라 키체인에 두면 러너가 거둘
 *  auth.json 이 안 생긴다(맥 셀프호스트). 모르는 설정 키는 codex 가 조용히 무시한다(실측 0.153.4) — 판이 달라도 안 깨진다.
 */
export function headlessLoginArgv(h: HeadlessLoginHarness): string[] {
  if (h === "codex") return ["codex", "-c", "cli_auth_credentials_store=file", "login", "--device-auth"];
  return ["claude", "setup-token"];
}

/**
 * 이 발급 명령이 **터미널(PTY)** 을 요구하나.
 *  claude setup-token 은 stdout 이 TTY 가 아니면 한 글자도 안 찍고 기다린다(실측) — 파이프 러너로 띄우면 화면은
 *  영영 «주소를 받는 중» 이다. codex device-auth 는 파이프로 충분하다(대화형 로그인 러너가 이미 그렇게 돈다).
 */
export function headlessNeedsPty(h: HeadlessLoginHarness): boolean {
  return h === "claude";
}

/**
 * setup-token 이 찍는 장기 토큰의 모양 — `sk-ant-oat01-…`.
 *  판 번호(01)는 바뀔 수 있어 숫자 두 자리로 둔다. 길이 하한은 «우연히 비슷한 글자» 를 토큰으로 잡지 않기 위한 것이다
 *  (실제 토큰은 100자가 넘는다).
 */
const SETUP_TOKEN_SRC = "sk-ant-oat\\d{2}-[A-Za-z0-9_-]{40,}";
export const SETUP_TOKEN_RE = new RegExp(SETUP_TOKEN_SRC);

/** 화면에서 토큰을 찾는다. 없으면 null. */
export function findSetupToken(screen: string): string | null {
  const m = String(screen ?? "").match(SETUP_TOKEN_RE);
  return m ? m[0] : null;
}

/** 로그·화면에 남기면 안 되는 토큰을 표식으로 바꾼다. 러너가 **로그에 쓰기 전에** 부른다. */
export const TOKEN_CAPTURED_MARK = "[LVLY-TOKEN-CAPTURED]";
export function redactSetupToken(screen: string): string {
  return String(screen ?? "").replace(new RegExp(SETUP_TOKEN_SRC, "g"), TOKEN_CAPTURED_MARK);
}

/** 저장 직전 검사 — 값 **전체가** 토큰 모양인가(앞뒤 공백만 허용). */
export function isSetupTokenShaped(v: string): boolean {
  return new RegExp(`^${SETUP_TOKEN_SRC}$`).test(String(v ?? "").trim());
}

/** 러너의 JS 에 그대로 싣는 원문 — 같은 정규식이 두 벌로 갈리지 않게 여기서 한 번만 적는다. */
export const SETUP_TOKEN_PATTERN_SOURCE = SETUP_TOKEN_SRC;

/**
 * 파이프 러너(codex)가 자격 파일을 잡았을 때 로그에 남기는 줄.
 *  ⚠ 러너는 이 줄을 **종료 표식보다 먼저** 쓴다 — 거꾸로면 그 사이에 읽은 화면이 «끝났는데 못 받았다» 로 깜빡인다.
 */
export const CAPTURED_LINE = "LVLY_CAPTURED";

export interface HeadlessLoginState extends AiLoginState {
  /** 러너가 자격을 잡았다(아직 저장 전일 수 있다). */
  captured?: boolean;
  /** 서버가 자격을 멤버 비밀로 **저장했다** — 이번 시도의 완료 신호는 이것 하나다. */
  stored?: boolean;
}

/** 러너가 끝났는데 저장도 잡음도 종료 오류도 없을 때 사람에게 하는 말(화면이 [다시 시도] 안내를 덧붙인다). */
export const HEADLESS_ENDED_MESSAGE = "연결 시도가 끝났어요(취소됐거나 시간이 지났어요).";
/** 잡았다는 기록은 있는데 자격 파일도 러너도 없다 — 저장하기 전에 사라졌다(상한 · 자리 회수). 기다려도 안 온다. */
export const HEADLESS_LOST_MESSAGE = "자격을 받았지만 저장하기 전에 연결 시도가 끝났어요.";

/**
 * (순수) 러너 로그 → 화면 상태.
 *  주소·코드·붙여넣기 판단은 대화형 로그인 파서를 그대로 쓴다 — 출력 모양이 같다(머리말). 여기서 더하는 것은
 *  «자격을 잡았나» · «저장했나» · «러너가 끝났나» 셋이다.
 *  `ended` — 러너가 더는 없고 **거둘 자격 파일도 없다**(headlessStateOf 가 그렇게만 넘긴다). 그때 화면에 남은 주소·코드는
 *   받을 러너가 없는 것이라 내보내지 않는다 — 사람이 그 주소로 승인하고 코드를 넣어도 아무 일이 없다(실측 2026-09-17).
 *   기록에 «잡았다» 표시가 있었다면 그 자격은 저장 전에 사라진 것이다 — «기다림» 에 두면 영영 안 끝난다.
 */
export function parseHeadlessLogin(
  h: HeadlessLoginHarness, raw: string, o: { stored?: boolean; ended?: boolean } = {},
): HeadlessLoginState {
  //  ⚠ 로그에는 토큰이 없어야 한다(러너가 표식으로 바꿔 쓴다). 혹시 남아 있어도 **화면으로는 절대 안 내보낸다** —
  //   파서가 보는 글에서 먼저 지운다(주소 고르기가 토큰을 주소 조각으로 오인할 일도 함께 막는다).
  const text = redactSetupToken(raw);
  const st: HeadlessLoginState = parseAiLogin(h, text);
  if (text.includes(TOKEN_CAPTURED_MARK) || new RegExp(`^${CAPTURED_LINE}$`, "m").test(text)) st.captured = true;
  if (o.stored) st.stored = true;
  //  claude setup-token 은 코드를 넣고 나면 입력줄이 화면에 남는다 — 이미 잡았으면 «붙여넣기» 단계가 아니다.
  if (st.captured || st.stored) st.needsPaste = false;
  //  정상 종료(0)인데 아무것도 못 잡았다 = 발급이 안 됐다. 사람에게 그렇게 말한다(조용히 «기다리는 중» 에 두지 않는다).
  if (!st.error && st.exited && !st.captured && !st.stored) {
    st.error = st.exitCode === 0
      ? "승인은 끝났지만 자격을 받지 못했어요. 다시 시도해 주세요."
      : `연결 명령이 ${st.exitCode} 로 끝났어요.`;
  }
  //  저장했으면 끝난 러너가 정상이다. 종료 오류가 있으면 그 문장이 더 구체적이다.
  if (o.ended && !st.stored) {
    if (!st.error) st.error = st.captured ? HEADLESS_LOST_MESSAGE : HEADLESS_ENDED_MESSAGE;
    delete st.url;
    delete st.code;
    st.needsPaste = false;
  }
  return st;
}

/** (순수) 지금 화면이 사람에게 시킬 한 단계. «끝났다» 는 **저장했을 때만**이다. */
export function headlessLoginStep(st: HeadlessLoginState): AiLoginStep {
  if (st.stored) return "done";
  if (st.error) return "failed";
  if (st.captured) return "waiting";          // 잡았고 서버가 저장하는 중 — 사람이 할 일은 없다
  if (!st.url) return st.exited ? "failed" : "starting";
  if (st.needsPaste) return "paste-code";
  return st.exited ? "waiting" : "open-url";
}

/**
 * (순수) 상태 경로가 사람에게 줄 한 장 — 이번 조회(기록 · 러너 수명 · 거둘 자격 파일이 있나) + 이번 조회의 저장 결과.
 *  ⚠ «끝남» 은 **거둘 자격 파일이 없을 때만** 판정에 넘긴다 — 러너가 끝났어도 자격 파일이 있으면 이번 조회가 저장한다.
 *   저장이 실패했으면 그 사유가 화면에 가야 한다(«끝났어요» 로 덮지 않는다).
 *  비밀 값은 받지 않는다 — «있나» 만 받는다.
 */
export function headlessStateOf(
  h: HeadlessLoginHarness,
  read: { log: string; ended: boolean; hasCaptured: boolean },
  o: { stored: boolean; storeError?: string | null },
): HeadlessLoginState & { step: AiLoginStep } {
  const st = parseHeadlessLogin(h, read.log, { stored: o.stored, ended: read.ended && !read.hasCaptured });
  if (o.storeError && !st.error) st.error = o.storeError;
  return { ...st, step: headlessLoginStep(st) };
}

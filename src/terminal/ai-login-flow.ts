// AI 로그인을 **터미널 없이** 화면에서 끝낸다 (#2055 후속, 2026-08-28 상민님 지시 "C").
//
//  ── 왜 ──
//  종전 로그인은 «로그인 전용 세션을 만들고 그 터미널을 새 탭으로 연다» 였다(온보딩·대화창 관문 둘 다).
//  그래서 웹에서는 새 탭, 데스크톱 앱에서는 **새 창**이 뜬다. 맥락이 끊기고, 사람이 실제로 해야 할 일은
//  «주소를 열고 코드를 넣는 것» 뿐인데 그걸 하려고 터미널 화면을 통째로 본다.
//
//  ⚠ 그런데 하네스마다 필요한 게 다르다(실측 2026-08-28, 격리 홈에서 직접 돌려 받은 출력):
//   · codex 0.149.1  `codex login --device-auth` → 주소 + 일회용 코드(15분)를 **찍고 기다린다**. 사람이
//     브라우저에서 끝내면 프로세스가 스스로 끝난다. **되돌려 줄 입력이 없다.**
//   · claude 2.1.x   `claude auth login` → OAuth 주소를 찍고 `Paste code here if prompted >` 로 **stdin 을
//     기다린다**. 즉 사람이 브라우저에서 받은 코드를 **되돌려 넣어야** 한다.
//   · agy            로그인 서브커맨드 자체가 없다(하네스를 켜야 뜬다) → 이 통로의 대상이 아니다.
//   · grok·opencode  비대화형 한 줄이 아니다(catalog.harnessLoginArgv 머리말) → 대상이 아니다.
//  그래서 이 파일은 «주소를 보여준다»와 «코드를 되받는다»를 **둘 다** 다룬다. 하나만 다루면 claude 가 빠진다.
//
//  ── 경계 ──
//  이 파일은 **순수**다(프로세스·파일 없음). 출력 원문 → 화면이 그릴 상태로 옮기는 번역만 한다.
//  실행(멤버 자리에서 띄우고 로그를 읽는 것)은 호출자가 하고, 그래야 이 표를 하네스 바이너리 없이 검사할 수 있다.

/** 이 통로로 로그인할 수 있는 하네스. 그 외는 종전 안내(터미널)로 간다 — 지어내지 않는다. */
export const AI_LOGIN_HARNESSES = ["codex", "claude"] as const;
export type AiLoginHarness = (typeof AI_LOGIN_HARNESSES)[number];

export function isAiLoginHarness(k: string): k is AiLoginHarness {
  return (AI_LOGIN_HARNESSES as readonly string[]).includes(k);
}

/** 그 하네스의 로그인 명령(argv). 실행은 호출자가 한다. */
export function aiLoginArgv(h: AiLoginHarness): string[] {
  return h === "codex" ? ["codex", "login", "--device-auth"] : ["claude", "auth", "login"];
}

/** 로그인 프로세스가 끝났음을 로그에 남기는 표식 — 러너가 붙인다(종료코드까지). */
export const EXIT_MARK = "LVLY_LOGIN_EXIT";

export interface AiLoginState {
  /** 브라우저에서 열 주소. 아직 안 찍혔으면 없다. */
  url?: string;
  /** 그 화면에 넣을 일회용 코드(codex). claude 는 없다 — 반대로 사람이 코드를 **받아 와서** 넣는다. */
  code?: string;
  /** 사람이 받아 온 코드를 **되돌려 넣어야** 하나(claude). */
  needsPaste?: boolean;
  /** 프로세스가 끝났나 + 종료코드. 끝났다고 로그인 성공은 아니다 — 성공 판정은 자격 확인(aiLoginCheck)이 한다. */
  exited?: boolean;
  exitCode?: number;
  /** 사람에게 그대로 보여줄 오류 한 줄(있으면). */
  error?: string;
}

/**
 * ANSI 색·OSC-8 하이퍼링크를 걷어낸다.
 *
 *  ⚠ OSC-8 을 반드시 걷어야 한다(실측): claude 는 주소를 `ESC]8;;<url>ESC\<보이는 글자>ESC]8;;ESC\` 로 감싸서
 *   같은 주소가 **두 번** 나온다. 안 걷으면 화면에 주소가 겹쳐 보이고, 첫 매치가 제어문자에 붙어 깨진다.
 */
export function stripAnsi(s: string): string {
  return String(s)
    // OSC(]8;; …)는 BEL 또는 ST(ESC \)로 끝난다 — 링크 «표적» 만 지우고 보이는 글자는 남긴다.
    .replace(/\]8;;[^]*(?:|\\)/g, "")
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[@-Z\\-_]/g, "");
}

/** 사람이 브라우저에서 열 주소만 고른다 — 로그인 도메인이 아닌 주소(문서 링크 등)에 낚이지 않게 한다. */
function pickUrl(text: string): string | undefined {
  const all = text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
  const login = all.find((u) => /(auth\.openai\.com|chatgpt\.com|claude\.com|anthropic\.com)/i.test(u));
  return login ?? all[0];
}

/**
 * (순수) 로그인 프로세스의 출력 원문 → 화면 상태.
 *
 *  ⚠ 형식을 **앵커로** 읽지 않고 «주소 하나 · 코드 하나» 로 읽는다. CLI 문구는 판마다 바뀌지만(실측:
 *   codex 는 «1. Open this link…», claude 는 «If the browser didn't open, visit:») 주소와 코드의 **모양**은
 *   안 바뀐다. 문구에 앵커를 걸면 다음 판올림에서 조용히 빈 화면이 된다.
 */
export function parseAiLogin(harness: AiLoginHarness, raw: string): AiLoginState {
  const text = stripAnsi(raw);
  const st: AiLoginState = {};

  const ex = text.match(new RegExp(`${EXIT_MARK}\\s+(-?\\d+)`));
  if (ex) { st.exited = true; st.exitCode = Number(ex[1]); }

  const url = pickUrl(text);
  if (url) st.url = url;

  if (harness === "codex") {
    // 예: `GTMY-691A5` — 대문자·숫자 덩어리 두 개를 하이픈으로 이은 한 줄(실측 2026-08-28).
    const m = text.match(/^\s*([A-Z0-9]{3,8}-[A-Z0-9]{3,8})\s*$/m);
    if (m) st.code = m[1];
  } else {
    // claude 는 코드를 **받아서 넣는다**. 프롬프트가 떴을 때만 입력칸을 연다(안 떴는데 열면 헛수고를 시킨다).
    if (/paste code here/i.test(text)) st.needsPaste = true;
  }

  // 실패를 삼키지 않는다 — 사람이 볼 한 줄로 올린다. 종료했는데 아무 단서도 없을 때만 일반 문구.
  const err = text.match(/^\s*(error|Error|ERROR)[:\s].{0,200}$/m);
  if (err) st.error = err[0].trim();
  else if (st.exited && st.exitCode !== 0 && !st.url) st.error = `로그인 명령이 ${st.exitCode} 로 끝났습니다.`;

  return st;
}

/**
 * (순수) 지금 화면이 사람에게 무엇을 시켜야 하나 — 상태 → 한 단계.
 *  화면이 이 값을 그대로 그리면 «주소는 떴는데 아무 말이 없는» 자리가 안 생긴다.
 */
export type AiLoginStep = "starting" | "open-url" | "paste-code" | "waiting" | "done" | "failed";

export function aiLoginStep(st: AiLoginState, loggedIn: boolean | null): AiLoginStep {
  if (loggedIn === true) return "done";
  if (st.error) return "failed";
  if (!st.url) return st.exited ? "failed" : "starting";
  if (st.needsPaste) return "paste-code";
  // 주소가 떴고 끝나지도 않았다 = 사람이 브라우저에서 하는 중.
  return st.exited ? "waiting" : "open-url";
}

// codex 시작 «Update available» 창을 **아예 안 뜨게** 한다 (#4135 후속) — 그 창이 첫 지시를 막고, 최악엔 codex 를 죽였다.
//
//  ── 무엇이 죽었나 (실측 2026-09-26, 매니지드 lively-46e3 라이브 pane) ───────────────────────
//  테넌트 이미지의 codex 는 **npm 전역 설치**다. npm 설치본은 시작할 때 업데이트를 «대화형» 으로 묻는다:
//
//      ✨ Update available! 0.149.1 -> 0.157.1
//      Release notes: https://github.com/openai/codex/releases/latest
//    › 1. Update now (runs `npm install -g @openai/codex`)
//      2. Skip
//      3. Skip until next version
//      Press enter to continue
//
//  커서가 **1번**에 있다. 그 창에 Enter 가 들어가면 `npm install -g` 가 돌고, 이미지의 전역 prefix 는 root
//  소유라 EACCES(exit 243)로 실패한 뒤 **codex 가 그대로 끝난다** → pane 이 셸이 되고 사람은 «내가 직접
//  codex 라고 쳐야 실행된다» 를 본다(원준님 실측). 안 눌러도 창이 남아 첫 지시 주입은 «대화상자» 로 판정해
//  영원히 기다린다 — 어느 쪽이든 그 세션은 말이 안 통한다. 라이브 캡처로 두 갈래 다 봤다.
//
//  ── 왜 설정 파일의 루트 키인가 ────────────────────────────────────────────────────
//  · `check_for_update_on_startup = false` — 실측: 0.149.1 · 0.157.1 **양쪽에서** 검사를 건너뛴다
//    (`<CODEX_HOME>/version.json` 이 아예 안 생긴다 = 네트워크 조회도 안 한다).
//  · ⚠ **첫 테이블보다 먼저** 있어야 한다. TOML 은 테이블 뒤의 키를 그 테이블 것으로 읽는다 —
//    `[projects."…"]` 뒤에 적어 두고 재보니 검사가 그대로 돌았다(같은 자리에서 두 번 실측). 그래서
//    **파일 맨 앞**에 넣는다: 1행은 늘 루트 스코프라, 어디가 루트인지 찾는 스캐너(여러줄 문자열·주석)가 필요 없다.
//  · `-c check_for_update_on_startup=false`(CLI 덮어쓰기)로도 꺼지지만 **쓰지 않는다** — 0.157.1 은 `-c` 가
//    있으면 «embedded mode» 로 내려가 공유 백그라운드 서버를 안 쓴다(실측: 시작 경고 1건). 그 대가는 원치 않는다.
//
//  ⚠ 비치명이다 — 못 심어도 세션은 뜬다. 그때는 두 번째 겹(session-first-prompt 의 Escape)이 받는다.
import type { TrustIo, TrustPatch } from "./harness-trust.js";

/** codex 설정의 루트 키 — 시작할 때 새 버전을 조회할지. */
export const CODEX_UPDATE_CHECK_KEY = "check_for_update_on_startup";

/** 파일 맨 앞에 넣는 한 줄. 인라인 주석은 **이 줄을 나중에 열어 볼 사람**을 위한 것이다(TOML 유효). */
export const CODEX_UPDATE_CHECK_LINE =
  `${CODEX_UPDATE_CHECK_KEY} = false   # lively — 시작 업데이트 창이 첫 지시를 막는다(#4135). 지우면 그 창이 돌아온다.`;

/** 이미 이 키를 **설정으로** 적어 뒀나(주석은 설정이 아니다). 값은 보지 않는다 — false·true 다 사람의 선택이다. */
const HAS_KEY = new RegExp(`^[ \\t]*${CODEX_UPDATE_CHECK_KEY}[ \\t]*=`, "m");

/**
 * 업데이트 검사를 끈 새 파일 내용을 만든다(**순수** — 파일시스템 무접촉).
 *
 * 규칙:
 *  · 파일 어디든 그 키가 **설정으로** 있으면 `{write:false}` — 멱등(매 세션 mtime 을 건드리지 않고)이고,
 *    사람이 `true` 로 켜 둔 것도 덮지 않는다.
 *    ⚠ 여러줄 문자열 **안**의 같은 글자도 «있다» 로 본다 — 보수적인 쪽이 무해한 실패 방향이다(창이 떠도
 *     Escape 층이 받는다). 반대로 틀리면 사람의 파일에 중복 키를 만들어 codex 가 **아예 안 뜬다**.
 *  · 넣을 때는 **맨 앞**에 한 줄 + 개행. 나머지는 한 글자도 안 건드린다(이 파일엔 사람의 설정과 MCP·훅 배선이
 *    함께 산다 — 실측 1200줄 넘는 파일). 끝 개행이 없던 파일은 개행으로 끝나게 한다(다음 덧붙임의 전제).
 */
export function planCodexUpdateCheckOff(current: string | null): TrustPatch {
  const text = current ?? "";
  if (HAS_KEY.test(text)) return { write: false };
  const body = text && !text.endsWith("\n") ? `${text}\n` : text;
  return { write: true, text: `${CODEX_UPDATE_CHECK_LINE}\n${body}` };
}

/**
 * 세션이 실제로 쓸 codex 설정에 그 한 줄을 심는다. **비치명** — 던지지 않는다(호출자가 세션을 막으면 안 된다).
 *
 * @param configFile 그 세션의 `<CODEX_HOME|홈/.codex>/config.toml` — 자리는 호출자가 계산한다(harness-trust 와 같은 관례).
 * @returns 실제로 썼으면 true
 */
export async function ensureCodexUpdateCheckOff(io: TrustIo, configFile: string): Promise<boolean> {
  try {
    const patch = planCodexUpdateCheckOff(await io.read(configFile));
    if (!patch.write) return false;
    await io.write(configFile, patch.text);
    return true;
  } catch {
    return false;   // 못 심었다고 세션을 막지 않는다 — 그때는 Escape 층이 그 창을 닫는다
  }
}

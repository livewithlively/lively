// 테스트 격리 규칙 — **순수 판정**(소스 텍스트 → 위반 여부). 스캔·보고는 test-isolation-lint.test.mjs.
//
// 왜 순수 함수로 갈랐나 — 판정을 스캔과 섞으면 "규칙이 실제로 위반을 잡는가"를 red 입증할 방법이
//  레포에 일부러 위반 파일을 만드는 것뿐이다. 갈라 두면 픽스처 문자열로 엣지를 전수 검증할 수 있고,
//  레포가 깨끗해진 뒤에도 그 검증이 계속 산다.
//
// 겨냥하는 건 **지금까지 실제로 사고를 낸 두 모양**뿐이다(#1593 · #1786 · 2026-08-20). 정적 텍스트
//  검사라 우회 가능하고 완전하지도 않다 — 완전성은 런타임 가드(scripts/testguard-real-home.mjs)가 맡는다.

// POSIX 전용 테스트는 R1 면제 — 윈도우에서 아예 안 도니 USERPROFILE 이 의미가 없다.
//  관례상 파일 머리에서 `process.platform === "win32"` 로 즉시 빠져나간다(bootstrap-node-gate 등).
export const isPosixOnly = (src) => /process\.platform\s*===\s*"win32"/.test(src);

/**
 * R1 — 자식 env 에 홈을 `HOME` 으로만 돌리면 윈도우에서 격리가 조용히 무효가 된다.
 *  node·claude 의 os.homedir() 는 윈도우에서 USERPROFILE 을 보므로, HOME 만 준 테스트는
 *  **실패로도 안 나타난 채** 사람의 실제 설정을 덮어쓴다(2026-08-20 실측).
 *  정본 해법은 kit/testlib/os-sandbox.mjs 의 sandboxEnv({home,tmp}) — 쓰면 자동 충족된다.
 *  `\bHOME:` 는 LIVELY_HOME:·XDG_CONFIG_HOME: 에 매치되지 않는다(`_` 뒤엔 단어경계가 없다).
 */
export function violatesR1(src) {
  if (isPosixOnly(src)) return false;
  return /\bHOME:/.test(src) && !/USERPROFILE|sandboxEnv/.test(src);
}

/**
 * R2 — claude 는 등록 대상 파일을 고를 때 CLAUDE_CONFIG_DIR 를 **HOME 보다 먼저** 본다(#346).
 *  웹터미널 세션·라이블리 프로필 셸이 그 변수를 항상 주입하므로, 테스트가 상속시키면 HOME 을
 *  아무리 잘 돌려도 claude 는 실 프로필에 쓴다 — #1786(윈도우 훅 전멸)이 이 경로였다.
 *  샌드박스 안 값을 주거나 빈 문자열로 덮어 "없음"으로 폴백시킨다.
 */
export function violatesR2(src) {
  const callsClaude = /(?:spawnSync|spawn|execFileSync|execSync)\(\s*"claude"\s*[,)]/;
  return callsClaude.test(src) && !/CLAUDE_CONFIG_DIR/.test(src);
}

export const RULES = [
  { id: "R1", violates: violatesR1, title: "자식 env 의 HOME 은 USERPROFILE 과 함께 준다(윈도우 격리 무효 방지)", fix: "sandboxEnv({home,tmp}) 를 쓰세요 — kit/testlib/os-sandbox.mjs" },
  { id: "R2", violates: violatesR2, title: "실 claude 를 부르는 테스트는 CLAUDE_CONFIG_DIR 를 명시한다(실 프로필 오염 방지)", fix: '샌드박스 안 값 또는 "" 로 덮으세요' },
];

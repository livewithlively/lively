// 로그인 셸 PATH (#1541) — GUI 로 뜬 앱은 로그인 셸을 안 거쳐 PATH 가 최소값이다(macOS 실측: /usr/bin:/bin:…).
//  그 좁은 PATH 로 CLI(lively)를 몰면 CLI 가 찾는 것들(claude·tmux·brew)이 통째로 안 보인다 — 노드 env 굽기는
//  kit 쪽(#216)이 스스로 로그인 셸에 물어 방어하지만, setup·install·tmux 탐색 등 **CLI 의 나머지 전부**는 호출자
//  PATH 를 그대로 쓴다. 그래서 앱이 시작할 때 한 번 로그인 셸 PATH 를 합쳐 process.env.PATH 에 심는다(fix-path 패턴)
//  — 이후 모든 자식 spawn 이 물려받아, 앱이 모는 CLI 가 터미널에서 몰 때와 같은 세상을 본다.
//
// Windows 는 손대지 않는다 — GUI 도 레지스트리(머신+사용자) PATH 를 받아 이 문제가 구조적으로 없다.
// 실패는 무해하다 — 못 물으면 현재 PATH 그대로(종전과 동일).
//
// 두 번 묻는다(-lc 와 -ilc): zsh 의 비대화 로그인 셸(-l)은 .zprofile 까지만 읽고 **.zshrc 는 읽지 않는다** —
//  nvm·claude 네이티브 설치가 PATH 를 .zshrc 에만 넣는 관례라, -l 만으로는 그 경로가 통째로 빠진다
//  (실측 2026-08-20: 원준 맥 — 트레이로 시작한 노드의 pane 이 claude 를 못 찾음. brew 설치 맥은 -l 로 충분해 멀쩡).
//  -i(대화형)는 tty 없이 매달릴 수 있다는 우려로 뺐었지만, stdin=ignore + timeout 이면 매달려도 그 프로브만
//  조용히 실패한다(프로브별 격리) — VS Code 도 같은 이유로 대화형 로그인 셸로 PATH 를 해석한다.

/** (순수) 로그인 셸 PATH ∪ 현재 PATH — 빈 조각·중복 제거, 로그인 셸 우선(사용자 rc 의 우선순위 보존). */
export function mergePath(loginPath, currentPath, sep) {
  const out = [];
  for (const p of [...String(loginPath || "").split(sep), ...String(currentPath || "").split(sep)]) {
    if (p && !out.includes(p)) out.push(p);
  }
  return out.join(sep);
}

/** (순수) 로그인 셸 출력에서 PATH 추출 — rc 가 stdout 에 찍는 잡음(모트·에코)과 마커로 가른다. 없으면 null. */
export function extractPath(out) {
  const m = /<<<LIVELY_PATH:([^>]*)>>>/.exec(String(out || ""));
  return m ? m[1] : null;
}

/** 로그인 셸 PATH 질의 인자들 — [[셸, argv], …] 순서대로 전부 물어 합집합한다(-lc 먼저, -ilc 로 .zshrc 커버).
 *  SHELL 미설정(GUI 컨텍스트)이면 macOS 기본 zsh 폴백. */
export function loginShellCmds(env, platform) {
  const sh = (env && env.SHELL) || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const q = 'printf "<<<LIVELY_PATH:%s>>>" "$PATH"';
  return [[sh, ["-lc", q]], [sh, ["-ilc", q]]];
}

/**
 * process.env.PATH 를 로그인 셸 합집합으로 갱신한다(darwin/linux 만). exec 는 주입(테스트 seam) —
 *  실호출은 execFileSync(sh, argv, {encoding:"utf8", timeout, stdio:["ignore","pipe","ignore"]}).
 * @returns 갱신됐으면 새 PATH, 아니면 null(윈도우·질의 실패·변화 없음).
 */
export function enrichPathFromLoginShell(env, platform, exec) {
  if (platform === "win32") return null;
  // 프로브별 격리 — -ilc 가 이상한 rc 로 죽거나 매달려도(-> timeout throw) -lc 결과는 살린다.
  const found = [];
  for (const [sh, argv] of loginShellCmds(env, platform)) {
    try {
      const login = extractPath(exec(sh, argv));
      if (login) found.push(login);
    } catch { /* 이 프로브만 포기 */ }
  }
  if (!found.length) return null;
  const merged = mergePath(found.join(":"), env.PATH || "", ":");
  if (!merged || merged === env.PATH) return null;
  env.PATH = merged;
  return merged;
}

// 메인↔렌더러 IPC 채널 (#1541 T2) — **이름의 단일 출처**. 양쪽이 문자열을 따로 적으면 오타가 조용한 무동작이 된다
//  (렌더러는 아무 일도 안 일어난 것처럼 보이고, 메인은 아무 요청도 못 받은 것처럼 보인다).
export const IPC = {
  // 렌더러 → 메인 (invoke, 응답 있음)
  GET_STATE: "lively:get-state",       // 현재 앱 상태 스냅샷
  RUN: "lively:run",                   // { kind: "setup"|"login"|"install"|"node-start"|"node-stop", opts }
  CANCEL: "lively:cancel",             // 진행 중인 CLI 취소
  ANSWER: "lively:answer",             // { id, value } — prompt 에 대한 사람의 답
  SET_GATEWAY: "lively:set-gateway",   // { url }
  OPEN_EXTERNAL: "lively:open-external", // { url } — 브라우저로 (렌더러에 shell 을 노출하지 않기 위해 메인 경유)
  SET_APP_AUTOLAUNCH: "lively:set-app-autolaunch", // { on } — 앱(리모컨)을 로그인 때 띄울지. 노드 자동시작과 별개 축.
  RETRY: "lively:retry",               // 방금 실패한 작업을 **그대로** 다시 — kind·opts 는 메인이 기억한다
  READ_LOG: "lively:read-log",         // { id } — 화이트리스트된 로그의 꼬리(log-view.mjs)
  CHECK_UPDATE: "lively:check-update", // 사람이 누른 '지금 확인' — 자동 6시간 주기와 같은 판정을 쓴다
  APPLY_UPDATE: "lively:apply-update", // 받아 둔 업데이트를 지금 적용 — 앱이 스스로 닫고·설치하고·다시 뜬다(update-policy 머리말)
  CLEANUP_STALE: "lively:cleanup-stale", // Windows: 다른 자리에 남은 옛 설치본 제거 + 바로가기·자동시작을 이 버전으로(win-stale-install.mjs)
  OPEN_APP: "lively:open-app",         // 라이블리 화면(웹 UI 창)을 연다 — 마법사의 '라이블리 열기'. 준비 안 됐으면 메인이 거절한다

  // 메인 → 렌더러 (send, 단방향)
  STATE: "lively:state",               // 상태 스냅샷 갱신
  PROGRESS: "lively:progress",         // reduceProgress 결과
  LOG: "lively:log",                   // { stream:"stderr"|"raw", line }
};

/**
 * 웹 UI 창(게이트웨이의 /ui/ 를 싣는 창) ↔ 메인 채널 (#1541 · web-shell.mjs).
 *  ⚠ 마법사 채널(IPC)과 **다른 preload·다른 접두(`lively-web:`)** 다 — 원격 페이지(웹 UI)에는 설치·노드를 움직이는
 *  IPC 를 절대 노출하지 않는다(웹 UI 의 XSS 한 방이 이 PC 의 CLI 실행으로 승격되면 안 된다). 여기 둘만 있다:
 *   BOOT   preload 가 문서 시작 시점에 동기로 받는 값 — { origin, token, appVersion, platform } (web-shell.webBootPayload)
 *   LOGOUT 웹 UI 의 '로그아웃' 이 데스크톱 로그인(CLI 토큰)까지 끝내도록 — 안 이으면 웹은 localStorage 만 지우고
 *          다음 창 열기에서 토큰이 다시 주입돼 '로그아웃이 안 된다' 로 보인다
 */
export const IPC_WEB = {
  BOOT: "lively-web:boot",
  LOGOUT: "lively-web:logout",
};

/** 렌더러가 요청할 수 있는 작업 — 화이트리스트. 임의 argv 를 렌더러가 만들지 못하게 한다. */
export const RUN_KINDS = ["setup", "login", "logout", "install", "update", "node-start", "node-stop", "status", "doctor"];

/** 다시 시도해도 **안전한** 작업인가 — 재시도 버튼은 이 목록에만 붙는다.
 *  로그아웃·정지처럼 상태를 되돌리는 것은 실패해도 자동 재시도를 권하지 않는다(사람이 다시 판단해야 한다). */
export const RETRYABLE_KINDS = ["setup", "login", "install", "update", "node-start", "status", "doctor"];

/**
 * 작업 종류 → CLI argv (순수). `--json-events` 는 runCli 가 붙인다.
 *
 * ⚠ **렌더러가 argv 를 만들지 않는다.** 여기서만 만든다 — 렌더러(웹 컨텐츠)가 인자를 조립할 수 있으면
 *  XSS 한 방이 `lively` 임의 실행으로 승격된다. opts 는 값만 받고 형태는 여기서 강제한다.
 */
/**
 * 게이트웨이 주소 검사 — **한 자리에서만** 한다(setup·login 이 같은 자를 쓰게).
 * 빈 값·공백만 = 미입력(저장된 주소를 쓴다). 그 외엔 http(s) 형식이어야 하고, 셸/인자로 샐 문자를 배제한다
 * (부트스트랩은 이 주소를 `sh -c` 문자열에 넣는다 — 거기서 한 번 더 막지만, 애초에 여기서 걸러야 한다).
 */
function gateway(o) {
  const gw = String(o.gateway || "").trim();
  if (!gw) return "";
  if (!/^https?:\/\/[^\s"'`;|&$()<>\\]+$/i.test(gw)) throw new Error("게이트웨이 주소 형식이 올바르지 않습니다.");
  return gw;
}

export function argvFor(kind, opts) {
  const o = opts || {};
  switch (kind) {
    // setup = 로그인 + 키트 설치(순서·조건의 정본은 CLI 다 — 앱이 다시 판단하지 않는다).
    case "setup": { const gw = gateway(o); return gw ? ["setup", "--gateway", gw] : ["setup"]; }
    case "login": { const gw = gateway(o); return gw ? ["login", "--gateway", gw] : ["login"]; }
    // 로그아웃은 게이트웨이 인자를 받지 않는다 — 지금 로그인된 곳에서 나가는 것이지 '어디서' 를 고르는 게 아니다.
    case "logout": return ["logout"];
    case "install": return ["install"];
    // 키트 갱신 — **앱 자신의 자동 업데이트와 다른 축**이다(그건 electron-updater 가 앱 바이너리를 바꾼다).
    case "update": return ["update"];
    case "node-start": return ["node", "--daemon"];
    case "node-stop": return ["node", "stop"];
    case "status": return ["status", "--json"];
    case "doctor": return ["doctor", "--json"];
    default: throw new Error(`알 수 없는 작업: ${kind}`);
  }
}

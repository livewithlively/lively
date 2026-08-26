// 메인↔렌더러 IPC 채널 (#1541 T2) — **이름의 단일 출처**. 양쪽이 문자열을 따로 적으면 오타가 조용한 무동작이 된다
//  (렌더러는 아무 일도 안 일어난 것처럼 보이고, 메인은 아무 요청도 못 받은 것처럼 보인다).
import { normalizeGatewayInput } from "./gateway-input.mjs";

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
  // 주소칸을 **타이핑하는 동안** 메인이 되비쳐 주는 값(#2044) — { url, cmd, error, hint }. 문자열 하나를 받아
  //  문자열들을 돌려줄 뿐 아무것도 실행하지 않는다. 렌더러가 정규화 규칙을 따로 적으면 정본이 둘이 되고,
  //  그 순간 "미리보기엔 되는데 [연결]은 안 되는" 상태가 생긴다 — 판단은 메인에만 둔다.
  GATEWAY_ADVICE: "lively:gateway-advice",

  // 메인 → 렌더러 (send, 단방향)
  STATE: "lively:state",               // 상태 스냅샷 갱신
  PROGRESS: "lively:progress",         // reduceProgress 결과
  LOG: "lively:log",                   // { stream:"stderr"|"raw", line }
};

/**
 * 웹 UI 창(게이트웨이의 /ui/ 를 싣는 창) ↔ 메인 채널 (#1541 · web-shell.mjs).
 *  ⚠ 마법사 채널(IPC)과 **다른 preload·다른 접두(`lively-web:`)** 다 — 원격 페이지(웹 UI)에는 설치·노드를 움직이는
 *  IPC 를 절대 노출하지 않는다(웹 UI 의 XSS 한 방이 이 PC 의 CLI 실행으로 승격되면 안 된다). 원격 페이지에 주는
 *  다리는 아래 것들뿐이고, 하나같이 **인자 없는 단일 동작**이거나 메인이 형태를 강제하는 값이다:
 *   BOOT   preload 가 문서 시작 시점에 동기로 받는 값 — { origin, token, appVersion, platform } (web-shell.webBootPayload)
 *   LOGOUT 웹 UI 의 '로그아웃' 이 데스크톱 로그인(CLI 토큰)까지 끝내도록 — 안 이으면 웹은 localStorage 만 지우고
 *          다음 창 열기에서 토큰이 다시 주입돼 '로그아웃이 안 된다' 로 보인다
 */
export const IPC_WEB = {
  BOOT: "lively-web:boot",
  LOGOUT: "lively-web:logout",
  // 커스텀 타이틀바(#1541) — preload 가 페이지의 실제 배경/글자색을 읽어 보고하면, 메인이 Windows 의
  //  네이티브 창 버튼(WCO overlay) 색을 거기 맞춘다. 페이지(웹 UI)는 이 채널을 모른다 — preload 전용.
  TITLEBAR: "lively-web:titlebar",
  // 브라우저 서피스 확장(#1829) — 목록·설치·제거. **경로를 페이지가 정하지 못한다**:
  //  설치는 메인이 네이티브 파일 선택창을 띄우고 사람이 고른 파일만 받는다(위 머리말의 원칙 그대로 —
  //  웹 UI 의 XSS 한 방이 임의 파일을 확장으로 심을 수 있으면 안 된다). 제거는 우리 목록에 있는 id 만.
  EXT_LIST: "lively-web:ext-list",
  EXT_INSTALL: "lively-web:ext-install",
  EXT_REMOVE: "lively-web:ext-remove",
  // 앱 업데이트를 **메인 화면(웹 UI)에서** 알리고 적용한다 (#1838). 종전엔 받아 둔 업데이트의 입구가 트레이와
  //  마법사뿐이라, 라이블리 화면을 띄워 두고 일하는 사람에게는 아무 신호도 가지 않았다 — 창이 보이는 동안엔
  //  자동 적용도 하지 않으므로(창 앞에서 앱이 사라지면 고장으로 읽힌다) 업데이트가 무한정 앉아 있었다.
  //   UPDATE_STATE  지금 받아 둔 게 있나 — { ready, version, busy } (update-policy.webUpdateState)
  //   UPDATE_APPLY  지금 적용(앱이 스스로 닫고·설치하고·다시 뜬다) — 트레이 항목과 같은 경로
  //   UPDATE        메인 → 웹, 위 값이 바뀔 때마다(폴링을 시키지 않는다)
  //  ⚠ CLI 를 돌리는 통로가 아니다 — 인자가 없고, 하는 일은 '이 앱을 다시 시작' 하나뿐이다. 게이트웨이 출처에서
  //   온 요청만 받는 것은 다른 채널과 같다.
  UPDATE_STATE: "lively-web:update-state",
  UPDATE_APPLY: "lively-web:update-apply",
  UPDATE: "lively-web:update",
};

/** 렌더러가 요청할 수 있는 작업 — 화이트리스트. 임의 argv 를 렌더러가 만들지 못하게 한다. */
export const RUN_KINDS = ["setup", "login", "logout", "install", "update", "node-start", "node-stop", "status", "doctor", "setup-cloud"];

/** 다시 시도해도 **안전한** 작업인가 — 재시도 버튼은 이 목록에만 붙는다.
 *  로그아웃·정지처럼 상태를 되돌리는 것은 실패해도 자동 재시도를 권하지 않는다(사람이 다시 판단해야 한다). */
export const RETRYABLE_KINDS = ["setup", "login", "install", "update", "node-start", "status", "doctor", "setup-cloud"];

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
  // 사람의 입력을 먼저 **해석**하고(스킴 보정·`/ui` 말미 제거 등 — gateway-input.mjs), 그 다음에 형식을 강제한다.
  //  해석과 강제를 한 함수에 섞지 않는 이유: 강제는 보안 경계(셸 문자열로 들어간다)라 좁아야 하고,
  //  해석은 사람을 돕는 일이라 관대해야 한다. 종전엔 강제만 있어서 `acme.app.lvly.io` 가 거절됐다(#1771 §6).
  const gw = normalizeGatewayInput(o.gateway);
  if (!gw) return "";
  if (!/^https?:\/\/[^\s"'`;|&$()<>\\]+$/i.test(gw)) throw new Error("게이트웨이 주소 형식이 올바르지 않습니다.");
  return gw;
}

export function argvFor(kind, opts) {
  const o = opts || {};
  switch (kind) {
    // setup = 로그인 + 키트 설치(순서·조건의 정본은 CLI 다 — 앱이 다시 판단하지 않는다).
    case "setup": { const gw = gateway(o); return gw ? ["setup", "--gateway", gw] : ["setup"]; }
    // 클라우드 설치(#2044) — 주소를 **안 받는다**. CLI 가 라이블리 클라우드에 붙어 워크스페이스를 알아 온다.
    //  값을 인자로 노출하지 않는 이유: 이 경로의 요지가 "사람도 앱도 주소를 모른다" 이고, 렌더러가 임의
    //  클라우드 주소를 넣을 수 있으면 그건 다시 주소 입력이다(개발용 덮어쓰기는 env LIVELY_CLOUD_URL).
    case "setup-cloud": {
      const c = String(process.env.LIVELY_CLOUD_URL || "").trim();
      if (c && !/^https?:\/\/[^\s"'`;|&$()<>\\]+$/i.test(c)) throw new Error("LIVELY_CLOUD_URL 형식이 올바르지 않습니다.");
      return c ? ["setup", "--cloud", c] : ["setup", "--cloud"];
    }
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

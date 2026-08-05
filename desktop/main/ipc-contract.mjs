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

  // 메인 → 렌더러 (send, 단방향)
  STATE: "lively:state",               // 상태 스냅샷 갱신
  PROGRESS: "lively:progress",         // reduceProgress 결과
  LOG: "lively:log",                   // { stream:"stderr"|"raw", line }
};

/** 렌더러가 요청할 수 있는 작업 — 화이트리스트. 임의 argv 를 렌더러가 만들지 못하게 한다. */
export const RUN_KINDS = ["setup", "login", "install", "node-start", "node-stop", "status", "doctor"];

/**
 * 작업 종류 → CLI argv (순수). `--json-events` 는 runCli 가 붙인다.
 *
 * ⚠ **렌더러가 argv 를 만들지 않는다.** 여기서만 만든다 — 렌더러(웹 컨텐츠)가 인자를 조립할 수 있으면
 *  XSS 한 방이 `lively` 임의 실행으로 승격된다. opts 는 값만 받고 형태는 여기서 강제한다.
 */
export function argvFor(kind, opts) {
  const o = opts || {};
  switch (kind) {
    case "setup": return ["setup"];
    case "login": {
      const gw = String(o.gateway || "").trim();
      // 주소는 http(s) 만. 여기서 막지 않으면 `--gateway` 뒤에 임의 문자열이 붙는다.
      if (gw && !/^https?:\/\/[^\s]+$/i.test(gw)) throw new Error("게이트웨이 주소 형식이 올바르지 않습니다.");
      return gw ? ["login", "--gateway", gw] : ["login"];
    }
    case "install": return ["install"];
    case "node-start": return ["node", "--daemon"];
    case "node-stop": return ["node", "stop"];
    case "status": return ["status", "--json"];
    case "doctor": return ["doctor", "--json"];
    default: throw new Error(`알 수 없는 작업: ${kind}`);
  }
}

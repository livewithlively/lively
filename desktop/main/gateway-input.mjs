// 사람이 마법사에 **입력한 문자열** → 게이트웨이 주소 (#2044). 순수 — 이 값의 유일한 해석기다.
//
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
// 마법사는 "주소"를 묻지만 사람이 넣는 건 주소가 아니라 **자기가 아는 문자열**이다. 실측된 세 가지:
//  ① 스킴 없이 `acme.app.lvly.io` — 종전엔 "형식이 올바르지 않습니다" 로 끝났다(#1771 §6, 후속으로 남아 있었다).
//  ② 브라우저 주소창에서 복사한 `https://acme.app.lvly.io/ui/#/home` — 경로·해시가 그대로 붙어 온다.
//  ③ **매니지드 로그인 주소**(app.lvly.io) — 사람이 아는 유일한 주소가 그것이다. 그런데 거기엔 게이트웨이가
//     없어서 부트스트랩이 404 를 받고, 앱은 "CLI 설치가 끝났는데 실행파일이 없습니다" 라는 **엉뚱한 진단**을 낸다.
//     ③ 은 셀프호스팅 전제로 만든 문구("관리자에게 받은 주소")가 매니지드에서 만드는 막다른 길 그 자체다.
//
// ── 원칙 ────────────────────────────────────────────────────────────────────
// · **관대하게 해석하되, 값은 좁게 만든다.** 정규화는 여기서 하고, 형식 강제(셸 메타문자 배제)는 종전대로
//   ipc-contract.gateway() 가 한 자리에서 한다 — 이 모듈은 그 앞단이다.
// · **경로 접두는 보존한다.** `https://dev.lvly.io/preview/p1541` 같은 게이트웨이가 실재한다(web-shell.webUiUrl
//   가 경로 접두를 그대로 살린다) — 임의 경로를 잘라내면 그 배포가 통째로 못 붙는다. 자르는 건 **말미의
//   `/ui`·`/mcp`** 뿐이고, 그 둘은 게이트웨이 주소가 아니라 그 안의 화면·엔드포인트라 확정적으로 군더더기다.

import { bootstrapOneLiner } from "./cli-locate.mjs";

/** 스킴·경로 없이 이 호스트만 오면 게이트웨이가 아니다 — 라이블리 클라우드의 **로그인(컨트롤플레인)** 주소들. */
export const CONTROL_PLANE_HOSTS = ["app.lvly.io", "lvly.io", "www.lvly.io"];

/**
 * 스킴을 보태도 되는 모양인가 — **호스트처럼 생긴 것만** 보탠다.
 *
 * ⚠ 여기가 좁아야 하는 이유(실측: 이 가드가 없어 기존 테스트 E2 가 빨간불이 났다): 아무 문자열에나 `https://` 를
 *  붙이면 `--token`·`-x` 처럼 **플래그로 생긴 값**이 갑자기 '올바른 주소'가 되어 형식 강제를 통과한다.
 *  그건 곧 "형식이 올바르지 않습니다"(즉시·정확) 대신 부트스트랩 실패(느리고 원인이 안 보임)로 바뀐다는 뜻이다.
 * 규칙: 첫 글자가 영숫자 · 점이 있거나 포트가 붙었거나 localhost(= 진짜 호스트의 최소 조건).
 */
const HOSTISH = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+(?::\d{1,5})?(?:\/\S*)?$/i;
const LOCALISH = /^(?:localhost|[a-z0-9][a-z0-9-]*):\d{1,5}(?:\/\S*)?$/i;

/** 입력 문자열 → 게이트웨이 주소 후보. 형식 판정은 하지 않는다(못 고칠 값은 **그대로** 돌려준다). */
export function normalizeGatewayInput(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.split("#")[0].split("?")[0].trim();           // 브라우저에서 복사한 해시·쿼리는 주소가 아니다
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!HOSTISH.test(s) && !LOCALISH.test(s)) return s;   // 호스트로 안 보이면 손대지 않는다(형식 강제가 잡는다)
    s = "https://" + s;                                     // 스킴 없이 넣는 사람이 다수다
  }
  s = s.replace(/\/+$/, "");
  s = s.replace(/\/ui$/i, "").replace(/\/mcp$/i, "");  // 화면·MCP 엔드포인트는 게이트웨이 주소가 아니다
  return s.replace(/\/+$/, "");
}

/** 정규화된 주소의 호스트(소문자). 못 읽으면 "". */
export function hostOf(url) {
  try { return new URL(String(url || "")).hostname.toLowerCase(); } catch { return ""; }
}

/** 이 주소가 워크스페이스가 아니라 **라이블리 클라우드 로그인 페이지**인가. */
export function isControlPlane(url) {
  const h = hostOf(url);
  return !!h && CONTROL_PLANE_HOSTS.includes(h);
}

/**
 * 입력을 그대로 사람에게 되비춰 준다 — 무엇이 실행될지, 무엇이 잘못됐는지.
 * 마법사는 **타이핑 중에도** 이걸 그린다(설치는 원격 코드 실행이라 숨기지 않는다).
 *
 * @returns {{url:string, cmd:string, error:string, hint:string}}
 *   url   정규화 결과(빈 값이면 아직 판단할 게 없다)
 *   cmd   실행될 부트스트랩 한 줄(문제가 있으면 "")
 *   error 진행을 막아야 하는 사유(사람 말) — 있으면 [연결]을 눌러도 소용없다
 *   hint  막지는 않지만 알려줄 것
 */
export function gatewayAdvice(raw, platform = process.platform) {
  const url = normalizeGatewayInput(raw);
  if (!url) return { url: "", cmd: "", error: "", hint: "" };
  if (!/^https?:\/\/[^\s"'`;|&$()<>\\]+$/i.test(url)) {
    return { url, cmd: "", error: "주소 형식을 알아볼 수 없습니다. 예: acme.app.lvly.io", hint: "" };
  }
  if (isControlPlane(url)) {
    return {
      url, cmd: "",
      // ★ 매니지드에서 가장 흔한 막다른 길 — 여기서 잡아야 부트스트랩 404 를 "주소가 틀렸나?" 로 헤매지 않는다.
      error: "여기는 라이블리 클라우드 **로그인** 주소라 워크스페이스가 아닙니다. "
        + "app.lvly.io 에 로그인해 워크스페이스 카드의 «데스크톱 앱·CLI 로 연결» 을 열고 거기 «워크스페이스 주소» 를 넣으세요"
        + " (보통 `이름.app.lvly.io` 꼴입니다).",
      hint: "",
    };
  }
  // 한 줄의 문구는 cli-locate 가 정본이다(웹 관리화면과 **같은 URL** 이어야 한다 — 거기 주석 참조).
  return { url, cmd: bootstrapOneLiner(url, platform) || "", error: "", hint: "" };
}

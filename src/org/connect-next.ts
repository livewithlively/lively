// 외부 앱 연결의 «다음 걸음» 판정 — 순수(#4970). org_connect_status 가 앱마다 이 표를 돌린다.
//
//  처음 설정이 «누가 먼저 왔나»(첫 관리자·합류자)로 갈리던 것을 **서비스별 등록 상태 × 이 사람의 권한**으로 바꾼다.
//  연결 스킬(liv-connect·liv-connect-<앱>)은 이 값을 보고 어느 단계부터 시작할지 정한다 — 스킬 본문이 판정을 다시 하지 않게
//  여기 한 곳에 둔다(같은 판정을 두 벌로 두면 한쪽만 고쳐져 갈린다).
//
//  판정 순서(위에서 먼저 걸린 것):
//   1. 앱 등록이 필요한 앱인데 아직 준비 안 됨
//      · 매니지드 → preparing (앱 키는 라이블리 클라우드가 쥔다 — 구성원에게 «앱을 직접 등록하세요»를 내밀면 안 된다)
//      · 셀프호스트 → 이 사람이 등록할 수 있으면 register_app, 아니면 ask_admin
//   2. 이미 모으고 있음 → collecting (팀 수집기는 켠 한 사람의 연결로 돈다 — 다른 사람이 다시 연결할 필요가 없다)
//   3. 이 사람이 아직 연결 안 함 → connect
//   4. 연결은 됐는데 수집이 꺼져 있음 → 켤 수 있으면 set_scope, 아니면 ask_admin
export type ConnectNext = "register_app" | "ask_admin" | "preparing" | "connect" | "set_scope" | "collecting";

export interface ConnectFacts {
  variant: "managed" | "selfhost";
  /** 앱 등록(OAuth 앱 client 등)이 있어야 연결할 수 있는 앱인가. 개인 토큰 앱은 false. */
  needsApp: boolean;
  /** 그 앱 등록이 끝났는가(매니지드 = 릴레이, 셀프호스트 = 금고에 client). needsApp=false 면 보지 않는다. */
  appReady: boolean;
  /** 이 사람이 앱을 등록할 수 있는가. */
  canRegister: boolean;
  /** 이 사람이 수집을 켜고 범위를 정할 수 있는가. */
  canCollect: boolean;
  /** 이 사람이 그 앱을 연결했는가(그 앱에 «연결»이 사람 단위가 아니면 워크스페이스 단위 연결 여부). */
  meConnected: boolean;
  /** 이 워크스페이스가 그 앱에서 이미 모으고 있는가. */
  collecting: boolean;
}

export function decideConnectNext(f: ConnectFacts): ConnectNext {
  if (f.needsApp && !f.appReady) {
    if (f.variant === "managed") return "preparing";
    return f.canRegister ? "register_app" : "ask_admin";
  }
  if (f.collecting) return "collecting";
  if (!f.meConnected) return "connect";
  return f.canCollect ? "set_scope" : "ask_admin";
}

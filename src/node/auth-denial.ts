// 노드 채널 인증 거부 사유(#2161) — **'조용한 null' 을 없애는 것이 이 파일의 존재 이유다.**
//
// 사연: 매니지드에서 상민님 윈도우 노드가 /node/ws 에 502 무한 재시도를 돌았다. 게이트웨이가 한 일은
//  `authNodeToken()` 이 null 을 냈고 `socket.destroy()` 를 부른 것 뿐 — **로그 한 줄이 없었다.** 그래서
//  사람이 볼 수 있는 것은 caddy 의 502 뿐이었고, 원인(그 테넌트에 org_node 행이 없다)을 짚는 데 패킷캡처와
//  DB 대조까지 갔다. 종전 store 의 `catch { return null }` 은 **네 가지 다른 사실**을 한 값으로 뭉갰다:
//   ① DB 오류(공유 게이트웨이 RLS 포함) ② 이 게이트웨이가 모르는 토큰 ③ 노드 토큰이 아닌 토큰(로그인 토큰 등)
//   ④ 노드는 있으나 비활성/소유자 비활성.
//  ②와 ③은 **사람이 할 행동이 서로 다르다**(재등록 vs 설치 경로 점검). 뭉치면 둘 다 못 한다.
//
// registry.ts:503 주석이 이미 이 함정을 경고하고 있었다(#2044 가 테넌트 컨텍스트 축을 고쳤다). 남은 것이
//  '어긋남이 사람에게 도달하는가' 축이다 — 판정 함수의 정확성, 그 함수가 불리는 조건, 그리고 **그 결과가
//  사람 눈에 닿는가**는 각각 별개의 결함 축이다.
//
// ⚠ 이 모듈은 순수하다(DB·로거 의존 없음). 평문 토큰은 **어떤 필드에도 담지 않는다** — 상관추적은
//  토큰 해시 앞부분(fingerprint)으로 한다(해시는 비밀이 아니다 — tokens.ts revokeToken 주석과 같은 관례).

/** 인증 거부 사유. 각 항목은 **사람이 할 다음 행동이 다르다**는 기준으로 갈랐다. */
export type NodeAuthDenial =
  /** 토큰 형식이 아님(빈 값·lvk_ 접두 아님) — 헤더가 안 실렸거나 엉뚱한 값이다. */
  | { reason: "malformed" }
  /** 이 프로세스에 DB 가 없다(구성 문제). */
  | { reason: "no-db" }
  /** 조회 자체가 실패 — RLS·연결 등. **이걸 '토큰 불일치'로 뭉개면 안 된다**(매니지드 디버깅 지옥의 원인). */
  | { reason: "db-error"; detail: string }
  /** 이 게이트웨이(테넌트)가 발급한 적 없는 토큰 — 다른 게이트웨이의 토큰을 들고 온 경우가 여기다. */
  | { reason: "unknown-token" }
  /** 토큰은 있으나 노드 토큰이 아니다(로그인·세션 토큰 등). label 로 어느 표면의 토큰인지 드러난다. */
  | { reason: "not-a-node-token"; label: string | null; member: string | null }
  /** 회수된 토큰. */
  | { reason: "revoked"; label: string | null }
  /** 노드가 비활성(관리탭에서 껐다). */
  | { reason: "node-disabled"; node: string }
  /** 소유 멤버가 active 가 아니다(퇴사·정지) — 설계상 즉시 차단이 맞다. */
  | { reason: "owner-inactive"; node: string; owner: string; state: string | null };

export type NodeAuthOutcome<TNode> =
  | { ok: true; node: TNode }
  | ({ ok: false; fingerprint: string } & NodeAuthDenial);

/**
 * 거부 사유를 **사람이 읽고 바로 다음 행동을 할 수 있는 한 줄**로. 순수 함수(테스트 대상).
 *  운영자가 로그에서 이 줄만 보고 움직일 수 있어야 한다 — "인증 실패" 는 그 조건을 못 넘는다.
 */
export function denialMessage(d: NodeAuthDenial): string {
  switch (d.reason) {
    case "malformed":
      return "노드 토큰이 안 실렸거나 형식이 아닙니다(Authorization: Bearer lvk_… 확인).";
    case "no-db":
      return "이 게이트웨이에 DB 가 구성되지 않아 노드 인증을 할 수 없습니다(ITEMS_DATABASE_URL).";
    case "db-error":
      // ★ 이 갈래가 종전엔 '토큰 불일치'로 둔갑했다. 공유 게이트웨이에서 테넌트 컨텍스트 없이 부르면 여기다.
      return `노드 인증 조회가 실패했습니다(토큰 문제가 아닙니다) — ${d.detail}`;
    case "unknown-token":
      return "이 게이트웨이가 발급한 노드 토큰이 아닙니다 — 다른 게이트웨이/테넌트의 토큰일 수 있습니다. "
        + "그 컴퓨터에서 `lively node --daemon` 을 다시 실행하면 지금 로그인한 게이트웨이로 재등록됩니다.";
    case "not-a-node-token":
      // 실측(#2161)에서 의심된 모양 — 로그인 토큰으로 노드 채널에 붙는 경우.
      return `노드 토큰이 아니라 다른 용도의 토큰입니다(label=${d.label ?? "(없음)"}${d.member ? `, member=${d.member}` : ""}) `
        + "— 노드 등록(POST /api/ui/nodes)을 안 타고 붙은 것입니다. 그 컴퓨터에서 `lively node --daemon` 으로 재등록하세요.";
    case "revoked":
      return `회수된 토큰입니다(label=${d.label ?? "(없음)"}) — `
        + "`lively node --daemon` 으로 재등록하거나 관리탭에서 토큰을 회전하세요.";
    case "node-disabled":
      return `노드 '${d.node}' 가 비활성 상태입니다 — 관리탭에서 활성화하면 다음 재연결에 붙습니다.`;
    case "owner-inactive":
      return `노드 '${d.node}' 의 소유 구성원 '${d.owner}' 가 active 가 아닙니다(state=${d.state ?? "없음"}) — 설계상 차단입니다.`;
  }
}

/**
 * 같은 실패의 로그 폭주를 막는 쿨다운 판정(순수). 노드는 거부돼도 **백오프로 계속 재접속**하므로,
 *  매 시도를 다 찍으면 진짜 신호가 묻힌다. 첫 건은 반드시 남긴다(auth-failure-response.shouldAlertNow 와 같은 관례).
 */
export const DENIAL_LOG_COOLDOWN_MS = 60_000;
export function shouldLogDenial(last: number | undefined, now: number, cooldownMs = DENIAL_LOG_COOLDOWN_MS): boolean {
  return last === undefined || now - last >= cooldownMs;
}

/** 쿨다운 키 — 같은 토큰의 같은 사유를 한 건으로 본다(사유가 바뀌면 그건 새 사실이라 다시 남긴다). */
export function denialKey(fingerprint: string, reason: NodeAuthDenial["reason"]): string {
  return `${fingerprint}:${reason}`;
}

// 노드 RPC 실패 → HttpError 번역(#1313 R46) — 세 호출부(terminal/routes 의 relayNodeOp · provision-remote 의
//  provision dispatch · createProjectSessionOnNode)가 같은 캐스케이드를 복붙해 왔다. 다만 **시맨틱이 서로 다르다**:
//
//   ┌ 사이트 ───────────────────────┬ offline 판정 ────────────────────┬ timeout ─┬ unsupported ┐
//   │ relayNodeOp                   │ msg === "node-offline" 만        │ 504 있음 │ 409 있음(op) │
//   │ provisionProjectOnNode.dispatch│ msg 동등성 **또는** !nodeOnline  │ **없음** │ **없음**     │
//   │ createProjectSessionOnNode    │ msg 동등성 **또는** !nodeOnline  │ 504 있음 │ 409 있음(고정)│
//   └───────────────────────────────┴──────────────────────────────────┴──────────┴─────────────┘
//
//  ⚠ 단일 매핑으로 뭉개면 동작이 바뀐다: dispatch 는 timeout 분기가 없어 **오늘 node-rpc-timeout 이 502 로 나간다.**
//   여기에 504 를 '보태면' 그건 리팩토링이 아니라 동작 변경이다. 그래서 이 함수는 규칙을 강제하지 않고
//   **호출부가 준 케이스 서브셋만** 적용한다(timeout/unsupported 는 옵셔널 — 미지정이면 분기 자체가 없다).
//   offline 의 추가조건도 프레디킷 주입(offlineWhen)으로 사이트별 차이를 그대로 보존한다.
//
//  분기 순서(offline → timeout → unsupported → 502)와 각 문구·상태코드는 원문 그대로다.
//  msg 추출(`(e as Error)?.message ?? String(e)` vs `e instanceof Error ? … : String(e)`)은 사이트마다 표현이
//  달라 **호출부에 남긴다** — 여기로 끌어오면 non-Error throw 시 문구가 갈릴 수 있다(behavior-preserving 우선).
import { HttpError } from "../http-error.js";

export interface NodeRpcErrorMap {
  /** 409 — 노드 오프라인 문구. */
  offline: string;
  /** offline 추가 판정(원문의 `|| !nodeOnline(nodeId)`). 없으면 msg 동등성만 본다(relayNodeOp 원문). */
  offlineWhen?: () => boolean;
  /** 504 — RPC 타임아웃 문구. **미지정이면 분기 없음**(원문 dispatch: 타임아웃도 502 로 떨어진다). */
  timeout?: string;
  /** 409 — 노드 에이전트가 그 op 을 지원하지 않음(인자=op 이름). 미지정이면 분기 없음. */
  unsupported?: (op: string) => string;
  /** 502 — 그 외 노드측 오류(인자=원문 msg). */
  failed: (msg: string) => string;
}

const UNSUPPORTED_PREFIX = "node-unsupported-op:";

export function translateNodeRpcError(msg: string, map: NodeRpcErrorMap): HttpError {
  // `||` 단축평가까지 원문과 동일 — msg 가 "node-offline" 이면 offlineWhen 은 호출되지 않는다.
  if (msg === "node-offline" || (map.offlineWhen?.() ?? false)) return new HttpError(409, map.offline);
  if (map.timeout !== undefined && msg === "node-rpc-timeout") return new HttpError(504, map.timeout);
  if (map.unsupported && msg.startsWith(UNSUPPORTED_PREFIX)) {
    return new HttpError(409, map.unsupported(msg.slice(UNSUPPORTED_PREFIX.length)));
  }
  return new HttpError(502, map.failed(msg));
}

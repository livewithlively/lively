// 구 HTTP 클라이언트(client.ts) 에러 엔벨로프 호환 어댑터 — capability 계층 소유.
// (src/domainmap/ 에 두면 엔진 모듈이 rest-util 로 '위로' 기어오르는 계층 역전 — 여기로 이동해
//  src/domainmap/ 는 pg/express/node 빌트인만 import 하는 자기완결 모듈로 유지한다.)
// 엔진이 in-process 직결로 바뀌어도 REST/MCP 에러 표면은 byte-compat 이어야 한다:
//  - 읽기(구 dmGet): HTTP status 에러 → plain Error `domainmap <status> <legacyPath>: <msg(200자 캡)>`
//    ('domainmap' 토큰이 wrap() 의 502 매핑에 load-bearing — 미검증 repo 404 도 기존처럼 502 로 표면화).
//    인프라 에러(pg 연결 실패 등 status 없는 것)는 그대로 전파(구 fetch 실패와 동일하게 500 클래스 —
//    메시지 텍스트만 구 'fetch failed' 대신 pg 원문; repo_list.domainmapError 필드에 그대로 실린다. 수용된 차이).
//  - 쓰기(구 dmPost/dmPatch): e.status 4xx → HttpError(status, msg(300자 캡)) (구 extractError 캡과 동일).
//    raw pg 23505(reassign 충돌)는 잡지 않고 전파 — 409 번역은 capability 한 곳(dm_mapping_move)의
//    책임이라는 기존 계약 유지. 그 외 status 없는 인프라/pg 에러는 구 DmUpstreamError 처럼 일반화:
//    원문은 logger.error 로만 남기고 'domainmap 오류(500)' 로 감싼다(wrap() 502 매핑 복원 +
//    MCP isError 에 pg 내부 문자열 비노출 — 구 5xx 분기와 동일 거동).
//  - actor: 구 x-actor 헤더 규약 재현 — userId 누락 시 '인증 사용자 식별 실패 — userId 필수'.
import { HttpError } from "./rest-util.js";
import { logger } from "../log.js";
import type { Actor } from "../domainmap/core/types.js";

type WithStatus = Error & { status?: number };

// 읽기 경로 — legacyPath 는 구 dmGet 에 넘기던 경로 문자열(에러 문구 byte 동일용).
export async function dmRead<T>(legacyPath: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const status = (err as WithStatus)?.status;
    if (typeof status === "number") {
      // 구 extractError(body, 200) 의 200자 캡 재현 — 캡 초과 메시지도 byte 동일.
      throw new Error(`domainmap ${status} ${legacyPath}: ${((err as Error).message ?? "").slice(0, 200)}`);
    }
    throw err; // pg 연결 실패 등 — 구 fetch 실패와 동일 클래스(500)
  }
}

// 쓰기 경로 — 코어의 e.status 4xx 는 HttpError 로(구 dmWrite 4xx 분기·300자 캡 동일),
// raw pg 23505 는 그대로(409 번역은 dm_mapping_move 소유), 그 외 인프라 에러는 일반화(구 5xx 분기).
export async function dmWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const status = (err as WithStatus)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      throw new HttpError(status, ((err as Error).message ?? "").slice(0, 300));
    }
    if ((err as { code?: string })?.code === "23505") throw err; // 계약: raw 전파(유일한 예외)
    // 구 DmUpstreamError 등가: 원문(pg 내부 정보 가능)은 서버 로그에만, 표면은 일반 메시지.
    // 'domainmap' 토큰은 wrap() 의 502 매핑에 load-bearing(구 502 표면 복원).
    logger.error({ err }, "domainmap core write failed");
    throw new Error("domainmap 오류(500)");
  }
}

// 구 actorFromReq/typedActor 재현: id 는 인증 userId(공백이면 구 dmWrite 가드처럼 throw),
// type 은 MCP 경유('agent') 외 전부 'human'(헤더 생략 = human 기본이던 기존 거동).
export function webActor(userId: string, type: Actor["type"] = "human"): Actor {
  if (!userId || !userId.trim()) throw new Error("인증 사용자 식별 실패 — userId 필수");
  return { type, id: userId };
}

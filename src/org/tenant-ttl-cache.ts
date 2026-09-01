// 테넌트별 TTL 캐시 — 중앙 게이트웨이가 **한 프로세스로 여러 테넌트를 서비스**하기 때문에 필요하다.
//
//  ── 왜 (실측 2026-08-27, 프로덕션) ──
//  정책 캐시들이 `let cache: {at, policy} | null` 이라는 **모듈 전역 한 칸**이었다. 단일 테넌트 배포에서는
//  맞는 코드다. 그런데 중앙 게이트웨이에서는 **먼저 읽은 테넌트의 값이 TTL 동안 다른 테넌트에도 적용된다.**
//
//  그래서 실제로 벌어진 일: 갓 만들어진 테넌트(런타임 설정 행이 아직 없음)가 세션 메모리 정책을 읽어
//  **기본값 0/0**(=무제한, 무회귀 기본)을 캐시에 넣었고, 그 30초 안에 세션을 만든 **정상 테넌트(1536)가
//  0 을 받았다.** 코어는 0 이면 cgspawn 갈래를 안 타므로 매니지드의 «세션 = 컨테이너 1개»(#1437 C1)가
//  조용히 꺼졌다 — 세션은 멀쩡히 뜨고 격리만 사라진다(무증상 보안 저하). codex 대화 중계는 그 세션
//  컨테이너를 대상으로 하므로 대화창도 안 뜬다. e2e 가 «간헐적으로» 빨간불이던 정체가 이것이다.
//
//  ⚠ 왜 «전역 캐시를 지우자» 가 아니라 이 파일인가: 지우면 세션 생성마다 DB 를 때린다. 캐시는 필요하고
//   **키가 없던 것**이 문제다. 그리고 같은 모양이 여럿이라(storage·reclaim·delegate·ingest·timezone…)
//   한 곳만 고치면 나머지가 남는다. 그래서 통로를 하나 만들어 옮겨 간다.
//
//  단일 테넌트 배포(셀프호스트)에서는 currentTenant() 가 null 이라 키가 하나뿐이고, 종전과 같이 동작한다.
import { currentTenant } from "./tenant-context.js";

/** 테넌트 컨텍스트 밖(단일 테넌트 배포·부팅 경로)의 키. 슬러그 규칙상 공백은 실제 id 와 겹치지 않는다. */
const SOLO = " solo";

export interface TenantTtlCache<T> {
  /**
   * 이 테넌트의 값을 준다. 없거나 만료면 load 로 채운다. load 가 던지면 이 테넌트의 마지막 값 → fallback.
   *  ttlMs·now 는 **호출마다** 받는다(정책 모듈들의 종전 시그니처가 그렇다). 캐시 저장소는 그대로 쓰므로
   *  가짜 시계를 넘기는 테스트에서도 캐시가 산다 — 호출마다 새 캐시를 만들면 그게 곧 캐시를 없앤 것이다
   *  (실측: delegate-policy 테스트가 «TTL 이내인데 DB 를 또 쳤다» 로 잡았다).
   */
  get(load: () => Promise<T>, ttlMs?: number, now?: () => number): Promise<T>;
  /** 이 테넌트만 무효화(설정 저장 직후). */
  invalidate(): void;
  /** 전부 무효화(테스트·전역 재설정). */
  invalidateAll(): void;
}

/**
 * @param ttlMs  캐시 수명
 * @param fallback 한 번도 못 읽었고 load 가 실패했을 때의 값. **조회 실패가 호출자를 막지 않게** 한다
 *   (정책 조회로 세션 생성이 막히면 안 된다 — 각 정책 모듈이 이미 그렇게 설계돼 있고 그 계약을 지킨다).
 */
export function tenantTtlCache<T>(
  defaultTtlMs: number,
  fallback: () => T,
  defaultNow: () => number = Date.now,
): TenantTtlCache<T> {
  const map = new Map<string, { at: number; v: T }>();
  const key = (): string => currentTenant()?.id ?? SOLO;
  return {
    async get(load: () => Promise<T>, ttlMs = defaultTtlMs, now = defaultNow): Promise<T> {
      const k = key();
      const hit = map.get(k);
      if (hit && now() - hit.at < ttlMs) return hit.v;
      try {
        const v = await load();
        map.set(k, { at: now(), v });
        return v;
      } catch {
        // 마지막으로 성공한 **이 테넌트의** 값으로 버틴다. 남의 값을 주지 않는다 — 그게 이 파일의 요점이다.
        return hit?.v ?? fallback();
      }
    },
    invalidate(): void { map.delete(key()); },
    invalidateAll(): void { map.clear(); },
  };
}

// per-session cgroup 메모리 격리 정책(#1059 D) — 세션(claude 등)당 MemoryHigh/Max(MB). **관리탭(DB)이 단일 창구, env 는 시드.**
//
// 왜 필요(#1059): 고객사 A 박스가 claude 세션 누적 baseline(~8GB) + Ollama 임베딩 3.3GB 스파이크로 스왑0 물리
//  초과 → 스래싱 라이브락 → 강제재부팅(커널 global_oom 이 엉뚱하게 llama-server 만 반복 kill). claude 는 **네이티브
//  ELF** 라 NODE_OPTIONS 힙제한이 안 통해, 세션 메모리 폭주를 막는 유일 수단은 cgroup(box-cgspawn → systemd-run
//  --scope, deploy/linux/box-cgspawn). 이 정책이 세션당 상한을 정해 **폭주 세션 하나만 자기 scope 안에서 OOM-kill**
//  되고 박스는 생존하게 한다(EC2 실측: CONSTRAINT_MEMCG 로 격리 kill, global_oom 아님).
//
// 왜 DB 인가(storage-policy 와 동일 교리): 고객 박스는 우리가 SSH 로 못 들어간다 → env 전용이면 사실상 아무도 못
//  바꾼다. 관리탭에서 바꿀 수 있어야 실제로 쓰인다. 우선순위: **DB(관리탭 저장) > env 시드 > 코드 기본값.**
//  ⚠ '이 항목을 안 건드린 저장'은 DB 원본을 그대로 둔다 — resolved 값을 되쓰면 env 시드가 DB 로 굳는다(#688 함정).
//
// 기본값 0 = 무제한(**무회귀**): 캡을 설정하지 않은 박스는 종전과 동일 — 세션이 box-cgspawn 을 안 거치고 sudo -u
//  직행한다(terminal-isolation.wrapAsMember 의 cap-gated 분기). 운영자가 캡을 걸어야(예: 고객사 A 16GB → high 3072
//  / max 4096) 그때부터 세션이 scope 격리된다. 캡 설정 = per-session 메모리 격리 + 게이트웨이 cgroup 탈출 동시 활성.
//
// 관련: deploy/linux/box-cgspawn(root wrapper, systemd-run --scope) · terminal-isolation.wrapAsMember(cap-gated 분기) ·
//  src/org/policies/storage-policy.ts(같은 seam 의 원형).

import { definePolicy } from "../org/policies/knob.js";

export interface SessionMemoryPolicy {
  /** 세션당 MemoryHigh(MB) — 초과 시 강한 회수·스로틀(kill 아님, 소프트). 0 = 소프트 캡 없음. */
  per_session_high_mb: number;
  /** 세션당 MemoryMax(MB) — 초과 시 그 세션 scope 안에서 OOM-kill(하드). 0 = 하드 캡 없음. */
  per_session_max_mb: number;
  /**
   * 세션당 **스케줄링 예약치**(MB) — 이 세션을 노드에 앉힐 때 '자리를 얼마나 차지하는 것으로 칠지'.
   * 0 = 미설정(종전 동작: 배치·용량 심사가 하드 캡을 그대로 쓴다).
   *
   * 왜 캡과 따로인가: 캡(max)은 **폭주 상한**이라 크게 잡아야 안전한데, 그 값으로 배치를 심사하면
   *  노드가 놀면서도 새 세션을 거절한다. 실측(2026-08-26 매니지드 박스): 활성 claude 세션이
   *  560MiB / 1.5GiB 캡(36%), 물리 가용 6027MB 인데 두 번째 세션이 거절됐다. k8s 의 requests/limits
   *  와 같은 분리다 — 예약은 실사용 기준, 캡은 폭주 방지. 넘어서는 사용은 캡까지 허용되고, 노드가
   *  위험해지면 회수(리퍼)·earlyoom 이 받는다.
   *
   * 이 값은 **세션 spawn 훅을 쓰는 배포**(매니지드)에서만 뜻이 있다 — 그 훅이 노드 용량을 심사한다.
   *  로컬·단일호스트는 심사 주체가 없어 무시된다(무회귀).
   */
  per_session_request_mb: number;
}

export type SessionMemoryPolicyPatch = Partial<SessionMemoryPolicy>;

// 기본값 — 0/0 = 무제한(무회귀). 운영자가 관리탭/env 로 박스 크기에 맞춰 설정한다.
export const DEFAULT_SESSION_MEMORY_POLICY: SessionMemoryPolicy = {
  per_session_high_mb: 0,
  per_session_max_mb: 0,
  per_session_request_mb: 0,   // 0 = 미설정 → 심사가 하드 캡을 그대로 쓴다(종전 동작)
};

// 관리탭·검증 노출 상수 — 0(무제한) ~ 1TB(비정상 큰 값 방어).
export const SESSION_MEM_MB_MIN = 0;
export const SESSION_MEM_MB_MAX = 1_048_576;

// 노브 선언(#1313 R47) — 범위·env 시드는 이 표가 전부. 클램프/시드/우선순위 골격은 knob.ts 가 맡는다.
//  loose: R47 이전 이 모듈의 숫자 해석(Number(v) 직행)을 그대로 보존(byte-compat). 새 정책은 쓰지 마라 — knob.ts 참조.
const policy = definePolicy<SessionMemoryPolicy>({
  defaults: DEFAULT_SESSION_MEMORY_POLICY,
  fields: {
    per_session_high_mb: { env: "LIVELY_SESSION_MEM_HIGH_MB", min: SESSION_MEM_MB_MIN, max: SESSION_MEM_MB_MAX, loose: true },
    per_session_max_mb: { env: "LIVELY_SESSION_MEM_MAX_MB", min: SESSION_MEM_MB_MIN, max: SESSION_MEM_MB_MAX, loose: true },
    per_session_request_mb: { env: "LIVELY_SESSION_MEM_REQUEST_MB", min: SESSION_MEM_MB_MIN, max: SESSION_MEM_MB_MAX, loose: true },
  },
  invariant(out) {
    // 불변식: 둘 다 설정됐고 high > max 면 high 를 max 로 내린다. MemoryHigh 는 MemoryMax **아래**의 스로틀
    //  지점이라야 의미(high>max 면 하드 kill 전에 소프트 스로틀이 안 걸려 무의미). 조용히 고치되(잡음 방지) 안전쪽으로.
    if (out.per_session_high_mb > 0 && out.per_session_max_mb > 0 && out.per_session_high_mb > out.per_session_max_mb) {
      out.per_session_high_mb = out.per_session_max_mb;
    }
    // 예약이 캡보다 클 수는 없다 — 그러면 '자리는 크게 잡고 실제로는 그만큼 못 쓰는' 모순이 되고,
    //  배치가 캡 심사보다 보수적이 되어 이 분리의 목적(밀도 회복)이 뒤집힌다. 조용히 캡으로 내린다.
    if (out.per_session_request_mb > 0 && out.per_session_max_mb > 0 && out.per_session_request_mb > out.per_session_max_mb) {
      out.per_session_request_mb = out.per_session_max_mb;
    }
  },
});

/** 잡값 방어 — 관리탭 입력이든 env 든 범위를 벗어나면 시드/기본값으로. 'high ≤ max' 불변식도 여기서 강제한다. */
export function normalizeSessionMemoryPolicy(raw: unknown): SessionMemoryPolicy {
  return policy.normalize(raw);
}

/** DB 원본(JSONB) → 유효 정책. DB 우선, 비면 env 시드, 그 다음 기본값. */
export function resolveSessionMemoryPolicy(dbRaw: unknown): SessionMemoryPolicy {
  return policy.resolve(dbRaw);
}

/** 유효 정책의 출처(관리 UI 안내) — 관리탭 저장값인지, .env 시드인지, 코드 기본값인지. */
export function sessionMemoryPolicySource(dbRaw: unknown): "db" | "env" | "default" {
  return policy.source(dbRaw);
}

// ── 캐시 ──
// 세션 생성마다 조회한다 → 매번 DB 를 때리지 않게 짧게 캐시. DB 가 죽어도 정책을 낼 수 있어야 하므로(세션 생성이
//  정책 조회로 막히면 안 됨) load 실패 시 마지막 값 → 기본값으로 폴백하고 절대 throw 하지 않는다(storage-policy 와 동형).
let cache: { at: number; policy: SessionMemoryPolicy } | null = null;

export async function effectiveSessionMemoryPolicy(
  load: () => Promise<SessionMemoryPolicy>,
  ttlMs = 30_000,
  now: () => number = Date.now,
): Promise<SessionMemoryPolicy> {
  if (cache && now() - cache.at < ttlMs) return cache.policy;
  try {
    const policy = await load();
    cache = { at: now(), policy };
    return policy;
  } catch {
    return cache?.policy ?? normalizeSessionMemoryPolicy(null);
  }
}

/** 관리탭에서 정책을 저장한 직후 호출 — 다음 세션 생성이 즉시 새 값을 보게. */
export function invalidateSessionMemoryPolicyCache(): void {
  cache = null;
}

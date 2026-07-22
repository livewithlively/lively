// MCP 호출 감사로그 보관 정책(#1082) — mcp_call_log 를 며칠 치까지 남길지. **관리탭(DB)이 단일 창구, env 는 시드일 뿐.**
//
// 왜 필요한가: mcp_call_log 는 도입(#318) 이래 **무기한** 쌓였다(schema.ts 주석에 "성장 시 주기 prune 추가" 로
//  예고만 되고 미구현). 이 표에는 어떤 구성원이 언제 무슨 툴을 썼는지가 사람 단위로 남는다 — 보관기간 없는 축적은
//  개인정보 최소보관 원칙에 어긋나고, 박스가 오래 살수록 유출 시 피해 범위가 계속 커진다.
//
// 왜 DB 인가(storage-policy.ts 와 같은 교리): 고객 박스는 우리가 SSH 로 못 들어간다. .env 전용 정책은 사실상
//  아무도 못 바꾼다 → 관리탭에서 바꿀 수 있어야 실제로 쓰인다. 우선순위: **DB(관리탭) > env 시드 > 코드 기본값.**

export interface CallLogPolicy {
  /** 보존일수 — 이보다 오래된 호출 로그는 삭제한다. 0 = 삭제 안 함(무기한 보관, 구동작). */
  retention_days: number;
}

export type CallLogPolicyPatch = Partial<CallLogPolicy>;

// 기본 90일 — #318 스키마 주석이 예시로 든 값이자, 사고 조사에 실무상 충분한 범위.
//  '무기한(0)' 을 기본으로 두지 않는 이유: 기본값이 곧 대부분의 박스에서 실제로 쓰이는 값이라, 안전측이어야 한다.
export const DEFAULT_CALL_LOG_POLICY: CallLogPolicy = {
  retention_days: 90,
};

const MAX_RETENTION_DAYS = 3650; // 10년 — 오타로 천문학적 값이 들어와 prune 이 사실상 꺼지는 것 방지

// ⚠ Number() 에 바로 넘기면 안 된다 — Number(null)/Number("")/Number(false)/Number([]) 가 모두 **0** 이다.
//  이 정책에서 0 은 '잡값'이 아니라 **영구 보관**이라는 의미 있는 선택지다. 그래서 실수로 null 이 들어오면
//  기본값(90일)이 아니라 영구 보관으로 조용히 뒤집힌다 → 숫자이거나 숫자꼴 문자열일 때만 값으로 인정한다.
function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// env 시드(.env) — 최초 부팅·구박스 호환용 초기값. 관리탭에서 한 번 저장하면 그 뒤론 DB 가 이긴다.
function envSeed(): CallLogPolicyPatch {
  const p: CallLogPolicyPatch = {};
  if (process.env.MCP_CALL_LOG_RETENTION_DAYS) {
    p.retention_days = clampInt(process.env.MCP_CALL_LOG_RETENTION_DAYS, 0, MAX_RETENTION_DAYS, DEFAULT_CALL_LOG_POLICY.retention_days);
  }
  return p;
}

/** 잡값 방어 — 관리탭 입력이든 env 든 범위를 벗어나면 시드/기본값으로 접는다. */
export function normalizeCallLogPolicy(raw: unknown): CallLogPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const base = { ...DEFAULT_CALL_LOG_POLICY, ...envSeed() }; // DB 값이 없는 항목은 env 시드 → 기본값 순
  return {
    retention_days: r.retention_days !== undefined
      ? clampInt(r.retention_days, 0, MAX_RETENTION_DAYS, base.retention_days)
      : base.retention_days,
  };
}

/** DB 원본(JSONB) → 유효 정책. DB 우선, 비면 env 시드, 그 다음 기본값. */
export function resolveCallLogPolicy(dbRaw: unknown): CallLogPolicy {
  return normalizeCallLogPolicy(dbRaw);
}

/** 유효 정책의 출처(관리 UI 안내) — 관리탭 저장값인지, .env 시드인지, 코드 기본값인지. */
export function callLogPolicySource(dbRaw: unknown): "db" | "env" | "default" {
  if (dbRaw && typeof dbRaw === "object" && Object.keys(dbRaw as object).length > 0) return "db";
  if (Object.keys(envSeed()).length > 0) return "env";
  return "default";
}

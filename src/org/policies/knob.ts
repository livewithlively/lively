// 관리탭 정책 노브 팩토리(#1313 R47) — 정책 하나를 **선언 하나**로.
//
// 왜 필요: storage_policy(#813)·call_log_policy(#1082)·delegate_policy(#1101)·session_memory_policy(#1059 D)·
//  session_reclaim_policy(#1059 F) 다섯이 전부 같은 뼈대였다 — interface + DEFAULT_* + clampInt + envSeed +
//  normalize + resolve + source. 노브 하나 늘 때마다 그 일곱 조각을 손으로 베끼니, 베끼다 빠뜨린 한 줄이 곧
//  "관리탭에서 고른 값이 안 먹는다"였다(각 정책의 회귀 테스트가 전부 그 사고를 못 박고 있는 이유).
//  이제 6번째 정책은 `definePolicy({ defaults, fields })` **선언 1개**다.
//
// 교리(5벌이 공유하던 것 — 여기 한 곳에 못 박는다):
//  ① 우선순위 **DB(관리탭 저장) > env 시드 > 코드 기본값.** 고객 박스는 우리가 SSH 로 못 들어간다 → .env 전용
//     정책은 사실상 아무도 못 바꾼다. 관리탭에서 바꿀 수 있어야 실제로 쓰인다.
//  ② '이 항목을 안 건드린 저장'은 DB 원본을 그대로 둔다 — resolved 값을 되쓰면 env 시드가 DB 로 굳는다(#688 함정).
//     그 규칙은 store.updateRuntimeConfig 의 몫이고, 여기서는 **DB 에 없는 키를 base(env→기본값)로 채우는** 쪽만 맡는다.
//  ③ 잡값은 조용히 접는다(throw 금지) — DB JSONB 든 .env 든 사람 손이 닿는 입력이라 늘 이상한 게 들어온다.
//
// 여기 없는 것(일부러): 캐시(effectiveX/invalidateXCache)는 **모듈 전역 mutable 상태**라 소유 모듈과 동거시킨다.
//  공유 팩토리에 두면 정책 5개가 캐시 한 칸을 나눠 갖게 된다.

/** 유효 정책의 출처(관리 UI 안내) — 관리탭 저장값인지, .env 시드인지, 코드 기본값인지. */
export type PolicySource = "db" | "env" | "default";

/**
 * 노브 정책의 값 모양 — 정수 노브와 on/off 토글만. (문자열·중첩은 이 팩토리의 대상이 아니다.)
 *  `T extends PolicyShape<T>` 꼴로 쓴다 — interface 는 암묵 인덱스 시그니처가 없어 `Record<string, …>` 로는 못 받는다.
 */
export type PolicyShape<T> = Record<keyof T, number | boolean>;

/** 정수 노브 한 칸의 선언. */
export interface IntFieldSpec {
  kind?: "int";
  /** env 시드 변수명. 없으면 이 항목은 env 로 안 받는다(DB·기본값만). */
  env?: string;
  /** 클램프 하한. 통상 0 = '끔'처럼 의미 있는 경계다. */
  min: number;
  /** 클램프 상한 — 오타로 천문학적 값이 들어와 기능이 사실상 꺼지는 것 방지. */
  max: number;
  /**
   * **켰다면 최소 이만큼**(0 초과인데 이보다 짧으면 여기로 올린다). delegate 의 stall_ms 처럼
   *  "끄는 건 0 으로 명시해야지, '30초'로 끄는 게 아니다"인 노브용. 없으면 평범한 [min,max] 클램프.
   */
  floor?: number;
  /**
   * ⚠ 구정책 호환 전용 — 숫자 해석을 `Number(v)` 직행으로 되돌린다. **새 정책은 쓰지 마라.**
   *  R47 이전 4벌(storage·delegate·session-memory·session-reclaim)이 이 동작이었고, 여기서 strict 로 바꾸면
   *  `{키: null}` 같은 입력의 결과가 달라진다(0 → 기본값). byte-compat 유지 목적으로만 남긴 문이다.
   */
  loose?: boolean;
}

/** on/off 토글 한 칸의 선언. */
export interface BoolFieldSpec {
  kind: "bool";
  /** env 시드 변수명. `0|false|off|no`(대소문자 무시)만 거짓, 빈 문자열·미설정은 '안 건드림'. */
  env?: string;
}

export type FieldSpec = IntFieldSpec | BoolFieldSpec;

/** 정책 타입 T 의 **모든** 키에 선언을 요구한다 — 새 필드를 추가하고 선언을 빠뜨리면 tsc 가 잡는다. */
export type PolicyFields<T extends PolicyShape<T>> = {
  [K in keyof T]-?: T[K] extends boolean ? BoolFieldSpec : IntFieldSpec;
};

export interface PolicyDefinition<T extends PolicyShape<T>> {
  /** 코드 기본값 — DB·env 가 아무것도 없을 때의 값. 키 순서가 곧 정책 객체의 키 순서다. */
  defaults: T;
  fields: PolicyFields<T>;
  /**
   * 필드 **사이의** 불변식(예: '경고 < 위험', 'high ≤ max'). 클램프가 끝난 뒤 out 을 제자리에서 고친다.
   *  한 칸짜리 범위 규칙은 fields 로 표현되니, 여기엔 정말 축 사이 관계만 남긴다.
   */
  invariant?: (out: T) => void;
}

/** definePolicy 가 돌려주는 4종 세트 — 각 정책 모듈이 기존 export 이름으로 얇게 감싸 내보낸다. */
export interface DefinedPolicy<T extends PolicyShape<T>> {
  /** .env 로 들어온 초기값만 모은 patch(관리탭 저장 전까지 유효). 출처 판정에도 쓴다. */
  envSeed(): Partial<T>;
  /** 잡값 방어 — DB 원본(JSONB)이든 env 든 범위를 벗어나면 시드/기본값으로 접는다. */
  normalize(raw: unknown): T;
  /** DB 원본(JSONB) → 유효 정책. DB 우선, 비면 env 시드, 그 다음 기본값. */
  resolve(dbRaw: unknown): T;
  source(dbRaw: unknown): PolicySource;
}

/**
 * 숫자 해석 — **정본은 call-log-policy(#1082)의 방어 버전**(5벌 중 가장 방어적).
 *
 * ⚠ Number() 에 바로 넘기면 안 된다 — Number(null)/Number("")/Number(false)/Number([]) 가 모두 **0** 이다.
 *  노브 정책에서 0 은 '잡값'이 아니라 **영구 보관·끔·무제한** 같은 의미 있는 선택지다. 그래서 실수로 null 이
 *  들어오면 기본값이 아니라 그 선택지로 조용히 뒤집힌다 → 숫자이거나 숫자꼴 문자열일 때만 값으로 인정한다.
 */
function toNumber(v: unknown): number {
  return typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
}

/**
 * 잡값 방어 정수 클램프 — 레포 유일 정본(R47 이전엔 4벌이 각자 복사본을 갖고 있었다).
 *  해석 불가면 dflt, 되면 반올림 후 [min,max] 로 접는다. floor 가 있으면 'min 이하는 min(끔), 그 위는 [floor,max]'.
 */
export function clampInt(
  v: unknown,
  min: number,
  max: number,
  dflt: number,
  opts?: { floor?: number; loose?: boolean },
): number {
  const raw = opts?.loose ? Number(v) : toNumber(v);
  if (!Number.isFinite(raw)) return dflt;
  const n = Math.round(raw);
  if (opts?.floor !== undefined) {
    if (n <= min) return min;                              // min 이하 = 끔(음수도 끔으로 수렴)
    return Math.min(max, Math.max(opts.floor, n));         // 켰으면 floor~max
  }
  return Math.min(max, Math.max(min, n));
}

/**
 * env 불리언 해석 — 레포 유일 정본. 미설정·빈 문자열은 '안 건드림'(undefined)이고,
 *  `0|false|off|no`(대소문자 무시)만 거짓, 나머지는 참.
 */
export function envBool(v: string | undefined): boolean | undefined {
  return v === undefined || v === "" ? undefined : !/^(0|false|off|no)$/i.test(v);
}

/** 노브 정책 선언 → envSeed/normalize/resolve/source. 정책 모듈은 이 4종을 기존 export 이름으로 재수출한다. */
export function definePolicy<T extends PolicyShape<T>>(def: PolicyDefinition<T>): DefinedPolicy<T> {
  const { defaults, fields, invariant } = def;
  const keys = Object.keys(defaults) as Array<keyof T & string>;
  const specOf = (k: keyof T & string): FieldSpec => fields[k] as unknown as FieldSpec;

  // env 시드(.env) — 최초 부팅·구박스 호환용 초기값. 관리탭에서 한 번 저장하면 그 뒤론 DB 가 이긴다.
  //  ⚠ 클램프의 폴백은 base 가 아니라 **코드 기본값**이다(시드가 자기 자신을 폴백으로 삼을 수 없다).
  const envSeed = (): Partial<T> => {
    const p: Partial<T> = {};
    const w = p as Record<string, number | boolean>;
    for (const k of keys) {
      const f = specOf(k);
      if (!f.env) continue;
      const raw = process.env[f.env];
      if (f.kind === "bool") {
        const b = envBool(raw);
        if (b !== undefined) w[k] = b;
      } else if (raw) {
        w[k] = clampInt(raw, f.min, f.max, defaults[k] as number, f);
      }
    }
    return p;
  };

  const normalize = (raw: unknown): T => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const base = { ...defaults, ...envSeed() }; // DB 값이 없는 항목은 env 시드 → 기본값 순으로 채운다
    const out = { ...base } as T;
    const w = out as Record<string, number | boolean>;
    for (const k of keys) {
      const v = r[k];
      if (v === undefined) continue;             // 안 건드린 항목은 base 그대로
      const f = specOf(k);
      w[k] = f.kind === "bool" ? Boolean(v) : clampInt(v, f.min, f.max, base[k] as number, f);
    }
    invariant?.(out);
    return out;
  };

  const source = (dbRaw: unknown): PolicySource => {
    if (dbRaw && typeof dbRaw === "object" && Object.keys(dbRaw as object).length > 0) return "db";
    if (Object.keys(envSeed()).length > 0) return "env";
    return "default";
  };

  return { envSeed, normalize, resolve: (dbRaw: unknown) => normalize(dbRaw), source };
}

// 맥락관리 잡 실행 신원 정책 — **누구 자격으로 도나** (#4012 T1 · #3994 D1 확정)
//
// 왜 필요(2026-09-16 상민님 결정): 증류기·분류기·관리기 같은 LLM 맥락관리 잡은 사람이 안 보는 자리에서
//  돈다. 그 판이 쓸 Claude·Codex 로그인은 **워크스페이스가 정한 멤버 한 명**의 것이어야 한다 —
//  «누가 마지막으로 그 잡을 저장했나»(created_by)로 정해지면 과금·귀속이 사람 손을 떠난다.
//
// 종전 해소 사슬은 `headlessRequester(params, createdBy)` 하나뿐이었다: 잡 params.requester > 잡 created_by.
//  레인(증류기)엔 자기 `requester` 가 따로 있고 분류기·관리기는 잡 params 에만 있어서, **워크스페이스 수준의
//  기본값이 아예 없었다.** 그래서 잡마다 따로 박히고, 안 박힌 잡은 created_by 로 조용히 흘렀다.
//
// 우선순위(이 모듈이 정하는 것은 가운데 칸이다):
//   ① 레인·잡이 명시한 requester   — 더 구체적인 지정이므로 이긴다
//   ② **워크스페이스 실행 멤버**    — 이 정책
//   ③ 잡 created_by                — 호환 폴백. ②가 서기 전의 동작을 깨지 않으려고 남긴다.
//      ⚠ ②가 보급되면 걷는 것이 목표다 — «마지막 저장자» 는 자격 주체의 근거가 못 된다.
//
// 왜 DB 인가(storage-policy·delegate-policy 와 같은 교리): 고객 박스는 우리가 SSH 로 못 들어간다.
//  env 전용이면 정작 필요한 자리에서 아무도 못 바꾼다. 우선순위는 **DB(관리탭) > env 시드 > 없음**.
//
// ⚠ 이 모듈은 «누구» 만 정한다. 그 멤버의 자격이 실제로 등록돼 있는지(claude_setup_token)는
//  `node/task-scheduler.leaseEnvFor` 가 본다 — 없으면 실행이 무출력 stall 로 죽는 것이 종전 동작이고,
//  그걸 접수 단계에서 정직하게 끊는 것은 T2 몫이다.

/** 멤버 id 로 쓸 수 있는 모양인가 — 잡값이 신원 자리에 앉는 것을 막는다(공백·제어문자·과길이). */
const MEMBER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;

export interface ContextJobPolicy {
  /**
   * 맥락관리 잡(증류·분류·관리 등 LLM 잡)을 **이 멤버의 자격으로** 돌린다. null = 미설정.
   *
   * 값은 워크스페이스 멤버 id(`whoami` 의 member_id). 이메일도 받는다 — `memberOwner` 가 해소한다.
   */
  runner_member: string | null;
}

export type ContextJobPolicyPatch = Partial<ContextJobPolicy>;

export const DEFAULT_CONTEXT_JOB_POLICY: ContextJobPolicy = { runner_member: null };

/** env 시드 — 최초 부팅·구박스 호환. 관리탭에서 한 번 저장하면 그 뒤론 DB 가 이긴다. */
const ENV_KEY = "LIVELY_CONTEXT_JOB_RUNNER";

/** 한 칸 정규화 — 모양이 아니면 **조용히 null** 로 접는다(잡값을 신원으로 쓰지 않는다). */
function cleanMember(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return MEMBER_ID_RE.test(s) ? s : null;
}

/** 잡값 방어 — 관리탭 입력이든 env 든 모양이 아니면 미설정으로. */
export function normalizeContextJobPolicy(raw: unknown): ContextJobPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  //  ⚠ 키가 **없는 것**과 `null` 을 가른다: 없으면 env 시드로 채우고, 명시적 null 은 «비웠다» 는 뜻이라 그대로 둔다.
  //   그러지 않으면 관리탭에서 실행 멤버를 지운 순간 env 시드가 되살아나 사람이 끈 것이 안 꺼진다.
  if (!("runner_member" in r)) return { runner_member: cleanMember(process.env[ENV_KEY]) };
  return { runner_member: cleanMember(r.runner_member) };
}

/** DB 원본(JSONB) → 유효 정책. DB 우선, 비면 env 시드, 그 다음 미설정. */
export function resolveContextJobPolicy(dbRaw: unknown): ContextJobPolicy {
  return normalizeContextJobPolicy(dbRaw);
}

/** 유효 정책의 출처(관리 UI 안내) — 관리탭 저장값인지, .env 시드인지, 아무것도 없는지. */
export function contextJobPolicySource(dbRaw: unknown): "db" | "env" | "default" {
  const r = (dbRaw && typeof dbRaw === "object" ? dbRaw : {}) as Record<string, unknown>;
  if ("runner_member" in r) return "db";
  return cleanMember(process.env[ENV_KEY]) ? "env" : "default";
}

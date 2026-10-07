// 앱 × 보는 사람의 개인 설정 (#4601) — 「앱이 나에 대해 기억하는 것」(배치 2열/2행 · 글자 크기 · 접기 · 마지막으로 보던 장).
//
//  왜 코어에 있나: 앱 화면은 불투명 오리진(sandbox=allow-scripts)이라 localStorage 가 SecurityError 로 막히고(#4593 실측),
//   앱 전용 표에 두자니 SDK 에 **보는 사람 신원이 없어** 누구 것인지 못 가른다. 신원은 앱 화면 다리(/api/ui/apps/:id/…)를
//   받는 서버만 안다 — 그래서 (앱, 구성원) 키의 작은 JSON 한 칸을 서버가 들어 준다. 동의(grant)는 묻지 않는다: 이 값은
//   라이블리의 데이터가 아니라 그 사람이 그 앱을 어떻게 보고 싶은지일 뿐이고, 다른 사람에게 새지 않는다(키에 구성원이 있다).
//  크기 상한 16KB — 설정이지 데이터가 아니다. 넘치면 413 으로 돌려 앱이 설정 칸에 문서를 넣지 못하게 한다.
//  \u0000 금지 — Postgres jsonb 는 NUL 문자를 못 담는다(«unsupported Unicode escape sequence»). 저장 직전에 400 으로 돌려 500 을 막는다.
//  병합은 **저장소가 한 트랜잭션 안에서**(FOR UPDATE) 한다 — 두 탭이 동시에 다른 키를 고치면 마지막 쓰기가 앞의 것을 지우는 일이 없게.
import { HttpError } from "../http-error.js";

export const PREFS_MAX_BYTES = 16 * 1024;
export const PREFS_WRITES_PER_MINUTE = 60;
export type Prefs = Record<string, unknown>;

/** JSON 객체(배열·null 아님)인가. */
export function isPlainObject(v: unknown): v is Prefs {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 값 어디든(키 · 문자열 · 중첩 · 배열) 실제 NUL 문자가 있나. 직렬화 문자열의 `\u0000` 을 찾으면 역슬래시 글자(`\\u0000`)와 헷갈린다 — 값을 직접 걷는다. */
export function hasNul(v: unknown): boolean {
  if (typeof v === "string") return v.includes("\u0000");
  if (Array.isArray(v)) return v.some(hasNul);
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).some(([k, x]) => k.includes("\u0000") || hasNul(x));
  return false;
}

/** patch 가 쓸 수 있는 모양인가 — 객체가 아니면 400 · 어디든 NUL 문자가 있으면 400. 순수. */
export function assertPatch(patch: unknown): asserts patch is Prefs {
  if (!isPlainObject(patch)) throw new HttpError(400, "patch 는 JSON 객체여야 합니다");
  if (hasNul(patch)) throw new HttpError(400, "설정 값에 NUL 문자(\\u0000)를 넣을 수 없습니다");
}

/**
 * 얕은 병합 — patch 의 키를 덮어쓰고, 값이 null 인 키는 **지운다**(앱이 「기본값으로」를 표현하는 길). 중첩 객체는 통째로 바뀐다
 *  (깊은 병합을 하면 앱이 중첩 키 하나를 지울 길이 없다 — 얕게 두고 중첩이 필요하면 앱이 전체를 다시 넣는다). 순수.
 */
export function mergePrefs(cur: unknown, patch: unknown): Prefs {
  assertPatch(patch);
  const out: Prefs = isPlainObject(cur) ? { ...cur } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** 저장 직전 크기 검사 — 직렬화 바이트가 상한을 넘으면 413. 돌려주는 값 = 직렬화 문자열(저장에 그대로 쓴다). */
export function serializePrefs(prefs: Prefs): string {
  const s = JSON.stringify(prefs);
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes > PREFS_MAX_BYTES) {
    throw new HttpError(413, `개인 설정이 너무 큽니다(${bytes}B > ${PREFS_MAX_BYTES}B) — 설정 칸에는 설정만 두세요. 문서·데이터는 앱 표(store_*)에`);
  }
  return s;
}

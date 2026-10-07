// 앱 × 보는 사람의 개인 설정 (#4601) — 「앱이 나에 대해 기억하는 것」(배치 2열/2행 · 글자 크기 · 접기 · 마지막으로 보던 장).
//
//  왜 코어에 있나: 앱 화면은 불투명 오리진(sandbox=allow-scripts)이라 localStorage 가 SecurityError 로 막히고(#4593 실측),
//   앱 전용 표에 두자니 SDK 에 **보는 사람 신원이 없어** 누구 것인지 못 가른다. 신원은 앱 화면 다리(/api/ui/apps/:id/…)를
//   받는 서버만 안다 — 그래서 (앱, 구성원) 키의 작은 JSON 한 칸을 서버가 들어 준다. 동의(grant)는 묻지 않는다: 이 값은
//   라이블리의 데이터가 아니라 그 사람이 그 앱을 어떻게 보고 싶은지일 뿐이고, 다른 사람에게 새지 않는다(키에 구성원이 있다).
//  크기 상한 16KB — 설정이지 데이터가 아니다. 넘치면 413 으로 돌려 앱이 설정 칸에 문서를 넣지 못하게 한다.
import { HttpError } from "../http-error.js";

export const PREFS_MAX_BYTES = 16 * 1024;
export type Prefs = Record<string, unknown>;

/** JSON 객체(배열·null 아님)인가. */
export function isPlainObject(v: unknown): v is Prefs {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * 얕은 병합 — patch 의 키를 덮어쓰고, 값이 null 인 키는 **지운다**(앱이 「기본값으로」를 표현하는 길). 중첩 객체는 통째로 바뀐다
 *  (깊은 병합을 하면 앱이 중첩 키 하나를 지울 길이 없다 — 얕게 두고 중첩이 필요하면 앱이 전체를 다시 넣는다). 순수.
 */
export function mergePrefs(cur: unknown, patch: unknown): Prefs {
  if (!isPlainObject(patch)) throw new HttpError(400, "patch 는 JSON 객체여야 합니다");
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

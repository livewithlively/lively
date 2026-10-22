// 지식 fields(메타데이터 jsonb) 패치 — JSON Merge Patch(RFC 7396) 의미론. 순수 함수(DB 없음).
//  knowledge_set_fields 가 «본문·제목을 건드리지 않고 fields 의 키 몇 개만» 고칠 때 쓴다.
//  종전엔 fields 를 쓰는 길이 커넥터 미러 upsert 하나뿐이라(mirror-knowledge.ts) 사람·에이전트가 code_sot 같은
//  값을 고칠 방법이 없었다 — knowledge_save 의 REST 파서는 fields 를 조용히 버린다.

export type JsonObject = Record<string, unknown>;

export const isJsonObject = (v: unknown): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * base 에 patch 를 RFC 7396 으로 적용한 **새 객체**를 돌려준다(base 는 건드리지 않는다).
 *  · patch 의 값이 null → 그 키를 지운다.
 *  · patch 의 값이 객체 → base 의 같은 키가 객체면 재귀 병합(형제 키 보존), 아니면 빈 객체에 병합한 결과로 바꾼다.
 *  · 그 밖(문자열·수·불리언·배열) → 통째로 바꾼다. 배열은 원소 단위로 합치지 않는다(RFC 7396 그대로).
 *  patch 에 없는 키는 그대로 남는다 — 이게 이 함수의 존재 이유다(domain_wiki.code_sot 만 고쳐도 relpath 가 산다).
 */
export function mergeFieldsPatch(base: JsonObject, patch: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (isJsonObject(v)) out[k] = mergeFieldsPatch(isJsonObject(out[k]) ? (out[k] as JsonObject) : {}, v);
    else out[k] = v;
  }
  return out;
}

/** 두 JSON 값이 같은가 — 객체 키 순서는 무시한다(jsonb 는 키 순서를 보존하지 않으므로 순서로 판정하면 헛 변경이 생긴다). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

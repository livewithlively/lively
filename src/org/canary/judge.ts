// 카나리 판정 (#1657) — 순수. 실행(네트워크·DB)과 완전히 분리해 엣지를 전수로 고정한다.
import type { ProbeExpect } from "./probes.js";

export interface ProbeVerdict { ok: boolean; reason: string | null }

/** 점 표기 경로로 값 하나를 꺼낸다. 배열은 숫자 인덱스로("files.0.id"). 없으면 undefined. */
export function pluck(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
    } else return undefined;
  }
  return cur;
}

/**
 * 한 번의 프로브 호출 결과를 판정한다.
 *  ⚠ 판정 순서가 곧 사양이다:
 *   ① isError:true 면 **즉시 실패**. 이번 구글 403 이 바로 이 형태였다(HTTP 200 + isError + 거부 문구).
 *   ② 금지 문구(notContains) — 상류가 200 으로 위장해 보내는 거부를 잡는다. 이건 isError 가 아닐 수도 있다.
 *   ③ 그다음에야 형태 단언(json·paths·arrayMin·contains).
 *  '거부'를 형태 단언보다 먼저 보는 이유: 거부 응답도 형태는 멀쩡할 수 있고, 그때 나오는 사유가
 *  "files 가 없다"면 사람이 원인을 완전히 잘못 짚는다.
 */
export function judgeProbe(res: { isError: boolean; text: string }, expect: ProbeExpect): ProbeVerdict {
  const text = res.text ?? "";
  if (res.isError) return { ok: false, reason: `상류가 실패를 반환했다: ${snippet(text)}` };

  const lower = text.toLowerCase();
  for (const marker of expect.notContains ?? []) {
    if (lower.includes(marker.toLowerCase())) return { ok: false, reason: `거부 문구 발견('${marker}'): ${snippet(text)}` };
  }
  for (const needle of expect.contains ?? []) {
    if (!text.includes(needle)) return { ok: false, reason: `응답에 '${needle}' 가 없다: ${snippet(text)}` };
  }

  const needsJson = expect.json || (expect.paths?.length ?? 0) > 0 || (expect.arrayMin?.length ?? 0) > 0;
  if (!needsJson) return { ok: true, reason: null };

  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { ok: false, reason: `응답이 JSON 이 아니다: ${snippet(text)}` }; }

  for (const p of expect.paths ?? []) {
    if (pluck(parsed, p) === undefined) return { ok: false, reason: `응답에 경로 '${p}' 가 없다` };
  }
  for (const { path, min } of expect.arrayMin ?? []) {
    const v = pluck(parsed, path);
    if (!Array.isArray(v)) return { ok: false, reason: `'${path}' 가 배열이 아니다` };
    if (v.length < min) return { ok: false, reason: `'${path}' 가 ${v.length}개 — 최소 ${min}개여야 한다` };
  }
  return { ok: true, reason: null };
}

function snippet(t: string, max = 200): string {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export type CanaryState = "ok" | "failing" | "unknown";

/**
 * 최근 결과(**최신이 앞**)로 상태를 정한다. threshold 회 연속 실패해야 failing —
 *  일시적 네트워크 오류 한 번에 사람을 깨우면 경보를 끄게 되고, 그러면 진짜 고장도 못 본다.
 *  회복은 **1회 성공이면 즉시** ok 다(비대칭): 고장 판정은 신중하게, 해제는 빠르게.
 */
export function evaluateStreak(recent: boolean[], threshold: number): { state: CanaryState; failStreak: number } {
  if (recent.length === 0) return { state: "unknown", failStreak: 0 };
  let failStreak = 0;
  for (const ok of recent) {
    if (ok) break;
    failStreak++;
  }
  if (failStreak === 0) return { state: "ok", failStreak: 0 };
  if (failStreak >= Math.max(1, threshold)) return { state: "failing", failStreak };
  return { state: "unknown", failStreak }; // 실패했지만 아직 임계 미만 — 관측 중(경보도 해제도 아니다)
}

/**
 * 경보를 보낼지 — **상태가 바뀔 때만**. 같은 상태가 이어지면 조용하다(알림 피로가 곧 경보 무시로 이어진다).
 *  unknown 은 어느 쪽으로도 전이로 치지 않는다: 데이터가 없거나 판정 중인 것을 '변화'라고 알리면 소음이 된다.
 */
export function alertTransition(prev: CanaryState, next: CanaryState): "raise" | "clear" | null {
  if (next === "failing" && prev !== "failing") return "raise";
  if (next === "ok" && prev === "failing") return "clear";
  return null;
}

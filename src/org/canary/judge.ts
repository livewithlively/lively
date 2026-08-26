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

// ── 구성 미비 vs 상류 회귀 (#1657, dev 실측으로 추가) ────────────────────────────────────────
//  '이 조직은 gmail 을 안 쓴다' 와 '구글이 우리를 막았다' 는 완전히 다른 사실인데 둘 다 '호출 실패' 로 온다.
//  구분하지 않으면 안 쓰는 커넥터가 영구 failing 으로 남아 **가짜 경보가 진짜 경보를 묻는다** — 그게 사람이
//  경보를 끄게 만드는 가장 흔한 경로다(dev 에서 실제로 그렇게 됐다: gmail 미연결 → 3회 만에 raise).
//
//  판정 근거는 **우리 코드가 만드는 문구만** 쓴다(#1082 와 같은 원칙 — 상류가 정하는 값에 의존하면 상류가
//  문구를 바꾸는 순간 정책이 조용히 무효화된다). 아래는 전부 게이트웨이 자신이 만드는 메시지다.
const UNCONFIGURED_MARKERS = [
  "자격 없음",           // dynamic-tools: vault 해소 실패
  "미연결",              // mcp-proxy: OAuth 토큰 없음
  "개인 연결이 필요",     // mcp-proxy: OAuth 커넥터인데 callerId 없음
  "개인 신원이 필요",     // mcp-proxy: SigV4
  "이 없습니다(프리셋 미적용?)", // run.ts: org_tool 부재
  "이 꺼져 있습니다",     // run.ts: org_tool 비활성
  "proxy MCP 서버 없음",  // mcp-proxy: 서버 행 부재
  "다시 연결하세요",      // oauth-proxy-auth: 갱신 불가(재연결 필요)
  // ── #1881 G2 이후 추가 — 구글은 "자격 없음" 대신 **다음에 누를 버튼**을 말한다(googleToolAuthHint).
  //  그 문구 개선이 여기 목록을 비켜 가면, 구글을 안 쓰는 조직이 전부 '상류 회귀'로 잡혀 **가짜 경보가
  //  진짜 경보를 묻는다** — 이 파일이 경계하는 바로 그 실패다(실제로 그렇게 될 뻔했다).
  //  ⚠ 리터럴이라 문구를 또 바꾸면 다시 새는데, judge.test 가 googleToolAuthHint 의 **실제 출력**을
  //   여기 통과시켜 보므로 그때 red 가 난다(리터럴이 아니라 경계를 잠갔다).
  "연결이 없습니다",       // google-oauth: 슬롯 0 — [Google 연결]을 누르라는 안내
  "권한이 없습니다",       // google-oauth: 슬롯은 있는데 그 서비스 범위 미동의 — [권한 넓히기]
  "아직 준비 중입니다",    // google-oauth: 1차 런칭에서 뺀 서비스(Gmail)
];

/** 이 실패가 '상류 회귀' 가 아니라 '이 박스에 아직 설정이 없음' 인가. */
export function isUnconfigured(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return UNCONFIGURED_MARKERS.some((m) => reason.includes(m));
}

export type CanaryState = "ok" | "failing" | "unknown" | "unconfigured";

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
  // 고장인 줄 알았는데 '설정이 없는 것' 으로 재분류됐다 → 잘못 울린 경보를 **명시적으로 푼다.**
  //  안 풀면 사람은 아직 고장 중인 줄 알고, 그 오해가 다음 진짜 경보의 신뢰를 깎는다.
  if (next === "unconfigured" && prev === "failing") return "clear";
  return null;
}

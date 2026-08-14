// 위탁 실패 분류(#1675 ②③) — 사양 엣지 표 20행 전수(<스크래치패드>/spec.md).
//  이 판정이 틀리면 둘 중 하나가 난다:
//   · 누락 → 어니스트 2026-08-12 재발. 폐기된 토큰으로 10분마다 9건씩 200회 실패하고 아무도 모른다.
//   · 오탐 → **멀쩡한 크론이 멈추고** 사람이 호출된다. 위탁 산출물은 AI 자유 텍스트라 "401 오류를
//     조사해줘" 같은 작업의 요약에 이 패턴이 얼마든 나온다 — ⑦⑧⑨ 행이 그 경계를 못 박는다.
import { strict as assert } from "node:assert";
import { detectAuthFailure, isRetriableFailure, cronJobIdFromMarker, SHORT_OUTPUT_CAP } from "./task-failure.js";

const ERNEST = "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";

// ── ① 어니스트 실측 원문(stderr) — 이걸 못 잡으면 이 모듈은 존재 이유가 없다 ──
{
  const hit = detectAuthFailure({ error: ERNEST });
  assert.ok(hit, "어니스트 실측 401 원문(stderr)을 자격 실패로 못 잡았다");
  assert.equal(hit.from, "stderr");
  assert.equal(hit.label, "토큰 폐기(revoked)");
  assert.ok(hit.evidence.includes("revoked"), "근거 조각에 판정 문구가 없다 — 사람이 오탐을 뒤집을 수 없다");
}

// ── ② 같은 원문이 요약(stream.jsonl)에 있을 때 — **실측에서 문구가 있던 자리가 여기다** ──
{
  const hit = detectAuthFailure({ summary: ERNEST });
  assert.ok(hit, "요약(stream.jsonl) 경로를 못 잡았다 — 실측 경로가 이쪽이다");
  assert.equal(hit.from, "summary");
}

// ── ③ 자격 실패의 표현 변형 ──
for (const [text, why] of [
  ["Error: OAuth token expired", "만료"],
  ["API error: authentication_error", "API 오류코드"],
  ["Invalid API key · Please run /login", "미로그인 안내"],
  ["401 Unauthorized", "401+낱말 근접"],
  ["Unauthorized (401)", "낱말+401 역순"],
  ["You are not logged in.", "미인증 평문"],
] as const) {
  assert.ok(detectAuthFailure({ error: text }), `자격 실패로 못 잡았다(${why}): ${text}`);
}

// ── ④ 일반 실패는 절대 잡히면 안 된다 ──
for (const [text, why] of [
  ["exit=1", "일반 실패"],
  ["Error: ENOSPC: no space left on device", "디스크"],
  ["fatal: repository not found", "git"],
  ["Rate limited: 429 too many requests", "다른 상태코드"],
  ["", "빈 문자열"],
] as const) {
  assert.equal(detectAuthFailure({ error: text }), null, `자격 실패가 아닌데 잡았다(${why}): ${text}`);
}

// ── ⑤ `401` 단독 — 인증 낱말이 없으면 자격 실패가 아니다(근접 매칭) ──
assert.equal(detectAuthFailure({ error: "HTTP 401" }), null,
  "인증 낱말 없는 401 을 자격 실패로 판정했다 — HTTP 상태를 다루는 모든 작업이 오탐된다");
// ── ⑥ `token` 단독 ──
assert.equal(detectAuthFailure({ error: "token count exceeded" }), null, "token 낱말 단독을 자격 실패로 판정했다");

// ── ⑦ ★핵심 — 긴 요약 안의 401 은 '작업 내용'이지 실행 실패가 아니다 ──
{
  const report = "조사 결과를 정리했습니다. ".repeat(40) + " 원인은 401 Unauthorized 였습니다.";
  assert.ok(report.length > SHORT_OUTPUT_CAP, "픽스처가 상한보다 짧다 — 이 케이스를 검증 못 한다");
  assert.equal(detectAuthFailure({ summary: report }), null,
    "긴 산출물 안의 401 을 자격 실패로 판정했다 — 멀쩡한 크론이 멈춘다");
}

// ── ⑧⑨ 경계값 — 상한 '이하'는 보고, 한 글자 넘으면 안 본다(off-by-one) ──
{
  const at = "401 unauthorized" + "x".repeat(SHORT_OUTPUT_CAP - "401 unauthorized".length);
  assert.equal(at.length, SHORT_OUTPUT_CAP, "픽스처 길이가 경계와 다르다");
  assert.ok(detectAuthFailure({ summary: at }), `요약 길이 ${SHORT_OUTPUT_CAP}(경계 이하)를 안 봤다`);

  const over = at + "x";
  assert.equal(over.length, SHORT_OUTPUT_CAP + 1);
  assert.equal(detectAuthFailure({ summary: over }), null, `요약 길이 ${SHORT_OUTPUT_CAP + 1}(경계 초과)를 봤다`);
}

// ── ⑩ stderr 는 길이와 무관하게 본다(AI 산출물이 아니다) ──
{
  const noisy = "warning: something\n".repeat(50) + ERNEST;
  assert.ok(noisy.length > SHORT_OUTPUT_CAP);
  assert.ok(detectAuthFailure({ error: noisy }), "stderr 를 길이로 잘랐다 — 하네스 로그는 원래 길다");
}

// ── ⑪ 부재 엣지 ──
assert.equal(detectAuthFailure({}), null, "입력이 비었는데 자격 실패로 판정했다");
assert.equal(detectAuthFailure({ error: null, summary: null }), null, "null 입력에서 자격 실패로 판정했다");

// ── ⑫ 근거에 시크릿이 섞여 나가면 안 된다(알림은 슬랙으로 흘러간다) ──
{
  const secret = "A".repeat(60);
  const hit = detectAuthFailure({ error: `Failed to authenticate with sk-ant-oat01-${secret} — revoked` });
  assert.ok(hit);
  assert.ok(!hit.evidence.includes(secret), "근거 조각에 토큰 원문이 실렸다 — 알림으로 샌다");
  assert.ok(hit.evidence.includes("[redacted]"), "토큰을 지웠으면 지웠다는 표시가 있어야 한다");
}

// ── ⑬⑭ 재시도 가부는 판정의 뒷면이다 ──
assert.equal(isRetriableFailure({ error: ERNEST }), false, "자격 실패를 재시도 대상으로 뒀다 — 부하가 배가 된다");
assert.equal(isRetriableFailure({ error: "exit=1" }), true, "일반 실패까지 재시도를 막았다 — 과잉 차단");

// ── ⑮~⑲ 마커 → 크론 잡 id (어느 크론을 멈출지) ──
assert.equal(cronJobIdFromMarker("cron:distill-sources-headless#hf-catchall"), "distill-sources-headless",
  "레인 붙은 마커에서 잡 id 를 못 뽑았다 — 증류 크론이 정확히 이 꼴이다");
assert.equal(cronJobIdFromMarker("cron:sync-notion-full"), "sync-notion-full");
assert.equal(cronJobIdFromMarker("box-yoon-1a2b3c"), null, "사람이 낸 위탁인데 크론 id 를 만들어냈다 — 남의 크론을 멈춘다");
assert.equal(cronJobIdFromMarker(null), null);
assert.equal(cronJobIdFromMarker("cron:"), null, "빈 잡 id 를 유효하다고 했다");

// ── ⑳ 둘 다 걸리면 stderr 가 이긴다(신뢰도 순서) ──
{
  const hit = detectAuthFailure({ error: ERNEST, summary: "401 unauthorized" });
  assert.ok(hit);
  assert.equal(hit.from, "stderr", "요약을 근거로 삼았다 — 신뢰도 높은 stderr 가 있는데도");
}

console.log("task-failure.test: ok");

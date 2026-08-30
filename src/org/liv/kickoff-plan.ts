// 리브 킥오프 판정(#1631) — 처음 설정이 끝났을 때 세션을 열까, 열지 말까.
//
//  ── 왜 판정이 필요한가 (실측 2026-08-30) ──
//  종전엔 조건 없이 열었다. 그런데 `resolveHeadlessHarness` 는 로그인된 하네스가 **하나도 없을 때
//  예외가 아니라 기본값 `"claude"`** 를 준다(headless-harness.ts). 그래서 킥오프는 성공으로 끝나고
//  세션이 열리는데, 그 안의 CLI 는 인증이 안 돼 있어 **한 글자도 답하지 못한다.**
//  사용자가 보는 것은 "조용히 멈춘 세션" 이고, 화면은 그게 왜 그런지 말해 주지 못한다.
//  welcome 응답은 이미 `ai_ready` 를 싣고 있었다 — 판정 재료는 있었는데 킥오프가 그걸 안 봤을 뿐이다.
//
//  ⚠ 처음 설정 자체는 실패시키지 않는다. 사람이 답한 것은 이미 반영됐고, AI 는 나중에 이어도 된다.
//   그래서 '열지 않음'은 오류가 아니라 **사유가 붙은 정상 결과**다(화면이 «AI 연결» 로 안내할 수 있게).

export type KickoffPlan =
  | { action: "reuse"; sessionId: string }
  | { action: "skip"; reason: "ai-not-connected" }
  | { action: "create"; harness: string };

/**
 * 킥오프 판정(순수).
 * @param priorSession 이미 열어 둔 리브 세션(멱등 — 처음 설정을 다시 눌러도 세션을 또 열지 않는다)
 * @param aiHarnesses 이 사람의 **로그인 확인된** 하네스(welcome 의 ai_harnesses 와 같은 값)
 */
export function planLivKickoff(priorSession: string | null | undefined, aiHarnesses: readonly string[]): KickoffPlan {
  const prior = String(priorSession ?? "").trim();
  if (prior) return { action: "reuse", sessionId: prior };
  const usable = aiHarnesses.map((h) => String(h ?? "").trim()).filter(Boolean);
  if (!usable.length) return { action: "skip", reason: "ai-not-connected" };
  return { action: "create", harness: usable[0] };
}

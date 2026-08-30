// 자격 **파일이 없는** 하네스를 로그인 목록에서 잃지 않는다(#1631) — 제미나이만 이은 사람이 통째로 막히던 것.
//
//  ── 무엇이 어긋났나 (실측 2026-08-31, dev) ──
//  같은 서버가 같은 사실에 두 답을 준다:
//    POST /api/ui/me/ai-accounts/check {antigravity} → loggedIn: true   (프로브 — `agy models` exit 0)
//    GET  /api/ui/me/welcome                        → ai_harnesses: ['claude','codex','grok']
//  프로브가 진실이다(그 자리에서 `agy models` 를 돌려 모델 목록을 받았다). 파일 표 쪽이 눈이 멀었다 —
//  `memberLoggedInHarnessesAny` 는 자격 **파일**(HARNESS_CRED)만 보는데 antigravity 는 자격 파일이 없어
//  **구조적으로 목록에 못 든다.**
//
//  ── 왜 치명적인가 ──
//  온보딩은 제미나이를 고르게 하고 «Gemini 로그인이 확인됐어요» 라고 확정까지 해 준다. 그런데
//   · `planLivKickoff` 는 `ai_harnesses` 로 판정한다 → 빈 목록 → **리브 세션을 아예 안 연다**
//   · `resolveHeadlessHarness` 도 같은 목록을 본다 → 아무것도 못 골라 기본값 `claude` 로 떨어진다
//     → 자격 없는 `claude -p` 무출력 hang(#1101 부류)
//  antigravity 는 `HEADLESS_KEYS` 에 **들어 있다** — 돌 수 있는데 못 고르는 것이다.
//
//  ── 값 ──
//  프로브는 비싸다(실측 4.3초·상한 25초). 그래서 **뜨거운 경로에 무조건 올리지 않는다.**
//  파일 표가 비었다는 것은 곧 그 사람에게 «AI 안 이었음» 이라 말하려는 순간이다 — 그때만 프로브를 돌리면
//  비용은 «어차피 막힐 사람» 에게만 들고 정확도는 회복된다. 하나라도 있으면 프로브는 0회다(무회귀).

/** 프로브를 돌릴 후보를 고른다(**순수**). 파일 표에 하나라도 있으면 빈 배열 — 비용을 안 쓴다. */
export function planLoginProbe(fileList: readonly string[], probeCapable: readonly string[]): string[] {
  if (fileList.length > 0) return [];
  return probeCapable.filter((k) => !!k);
}

/** 프로브 결과를 합친다(**순수**). `true` 인 것만 — `false`·`null`(모름)은 지어내지 않는다. */
export function mergeProbeResults(
  fileList: readonly string[],
  probed: ReadonlyArray<{ key: string; loggedIn: boolean | null }>,
): string[] {
  const out = [...fileList];
  for (const p of probed) if (p.loggedIn === true && p.key && !out.includes(p.key)) out.push(p.key);
  return out;
}

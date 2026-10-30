// 복원을 **같은 세션 id** 로 하나 — 판정 한 자리 (#4694 T4).
//
// ── 왜 ───────────────────────────────────────────────────────────────────────
// 복원은 오래 «새 id 로 만들고 옛 행에 이정표(superseded_by)» 였다. 그 구조가 결함 계열을 낳았다 — 옛 id 가 막다른 길(#2231),
//  이름·핀이 되돌아감(#2402·#2243), 은퇴한 행 때문에 무한 이동(#3555), 같은 세션이 두 줄(#3891). 같은 id 로 다시 띄우면
//  주소·장부 행·이름·핀·소속·미전달 지시가 그대로 이어져 그 계열이 구조적으로 없어진다.
//
// ── 언제 같은 id 인가 ────────────────────────────────────────────────────────
//  ① 옛 판(그 id 의 tmux)이 **없다는 확답**이 있을 때만. 살아 있으면 복원할 것이 없고(already), «모름» 에서 사람이 고른
//     «강제로 되살리기» 는 옛 판이 살아 있을 수 있다 — 그때는 종전대로 새 id 를 만들고 옛 id 를 은퇴시켜 브로커가 걷게 한다
//     (장부 retired → 안을 묻지 않고 회수). 같은 id 로 강제하면 살아 있던 하네스와 한 대화에 둘이 붙는다.
//  ② 셀프호스트(세션 컨테이너 없음)는 늘. 매니지드(세션 컨테이너 안 tmux)는 워크스페이스 스위치
//     `session_reclaim_policy.restore_same_id` 가 켜졌을 때 — 같은 id 의 옛 컨테이너가 브로커 철거와 겹치던 것을 #4693(T3) 의
//     «자리 이름»(확보마다 새 컨테이너 이름)이 풀어, T3 전 테넌트 롤아웃·실측 뒤 기본 켬이다(상민님 2026-10-15). 스위치는 끄는 수단으로 남는다.
//
// 분석 전문: 라이블리 지식 `same-id-restore-vs-3675-conflicts-4694`.
import { tmuxInSessionContainer } from "./session-tmux.js";
import { tenantSlug } from "./catalog.js";
import { getRuntimeConfig } from "../org/store/runtime-config.js";
import { effectiveSessionReclaimPolicy, normalizeSessionReclaimPolicy } from "../sessions/session-reclaim-policy.js";

/** (순수) 같은 id 로 되살리나. `gone` = 옛 판이 없나(sessionGoneVerdict: true 없음 · false 있음 · null 모름). */
export function sameIdRestoreVerdict(o: { gone: boolean | null; containerTopology: boolean; policyOn: boolean }): boolean {
  if (o.gone !== true) return false;
  return !o.containerTopology || o.policyOn;
}

/** 이 요청(테넌트 컨텍스트)에서 같은 id 로 되살리나. 정책 조회가 던지면 끈 것으로 본다(종전 경로). DB 를 못 읽는 것만으로는
 *  던지지 않는다 — effectiveSessionReclaimPolicy 가 마지막 값→기본값(켬)으로 답한다. */
export async function sameIdRestoreOn(gone: boolean | null): Promise<boolean> {
  if (gone !== true) return false;
  const containerTopology = tmuxInSessionContainer(tenantSlug());
  if (!containerTopology) return true;
  const policy = await effectiveSessionReclaimPolicy(
    async () => normalizeSessionReclaimPolicy((await getRuntimeConfig()).session_reclaim_policy),
  ).catch(() => null);
  return sameIdRestoreVerdict({ gone, containerTopology, policyOn: !!policy?.restore_same_id });
}

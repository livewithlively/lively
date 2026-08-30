// 리브 2턴(#1631) — 첫 수집 배치가 돈 뒤 **같은 세션**에 넣는 증류 지시, 그리고 "지금 쏠 때인가"의 판정.
//
//  ── 왜 2턴이 따로 있나 ──
//  1턴(first-turn.ts)은 보고만 한다. 온보딩 직후엔 자료가 덜 모였고, 그때 만들면 온보딩 답만 보고 틀에 박힌
//  수집기·증류기를 찍어낸다(페르소나 채점에서 걸러야 할 바로 그 실패). 그래서 만드는 일은 첫 수집이 한 바퀴 돈 뒤로 미룬다.
//  결정(2026-08-28, 윤상민): "첫 수집배치가 돈 뒤에 트리거는 자동으로 되는게 맞는거같아" · "증류 트리거를 그 ai세션에다가 주면
//  그 세션이 작업하고 끝날 때 자체 ai세션 마무리 알림도 갈테니 플로우가 자연스러울듯".
//
//  ── 판정은 순수 함수(decideSecondTurn) · 실행은 스윕(second-turn-sweep.ts) ──
//  판정을 따로 둔 이유: 표로 검증할 수 있어야 한다(엣지가 많다 — 세션 소멸·1턴 미배달·수집 지연·상한 초과).
//
//  ── 낡은 실측 문제 ──
//  1턴이 실은 숫자는 그 순간의 것이다. 2턴은 **다시 읽고** 시작하라고 못박는다(세션 관성 실측: classify-knowledge-stale-session-inertia).

export interface SecondTurnCollector { label: string; preset_key: string; enabled: boolean; ran: boolean }
export interface SecondTurnInput {
  displayName: string | null;
  drawers: string[];
  firstOrder: string | null;
  collectors: SecondTurnCollector[];
  partial: boolean;          // 상한까지 기다렸는데 일부 수집이 아직 → 있는 것으로 시작
  waitedMin: number;         // 온보딩 끝난 뒤 흐른 시간(분)
}

// ── TEMPLATE — 문안은 여기만 고친다 ─────────────────────────────────────────────
export function buildSecondTurnPrompt(i: SecondTurnInput): string {
  const who = i.displayName ? `${i.displayName} 님` : "이 사람";
  const ran = i.collectors.filter((c) => c.enabled && c.ran);
  const pending = i.collectors.filter((c) => c.enabled && !c.ran);
  const collectLine = i.collectors.length
    ? `- 수집기: ${ran.length ? `첫 수집을 마친 것 ${ran.map((c) => c.label).join(" · ")}` : "첫 수집을 마친 것 없음"}${pending.length ? ` / 아직 안 끝난 것 ${pending.map((c) => c.label).join(" · ")}` : ""}`
    : "- 수집기: 없음(외부 앱을 잇지 않음) — 자료는 올린 것뿐이며, 그것도 0건일 수 있다";   // 실측(태오 채점): "올린 자료만 있다"로 단정하면 자료 0건일 때 전제가 틀린다
  return [
    `리브, 이제 **증류 작업**을 시작한다. 처음 설정이 끝난 지 ${i.waitedMin}분 지났다.`,
    "",
    "## 먼저 — 1턴의 실측은 낡았다. **지금 상태를 다시 읽어라.**",
    "1턴에서 본 숫자를 믿지 마라. 아래 도구로 지금 것을 새로 읽고 시작한다:",
    "- `source_list`(자료 — 종류·제목·건수) · `category_list`(서랍) · `org_collectors`(수집기와 마지막 실행) · `org_distiller_list`(증류기) · `knowledge_list`(이미 있는 지식)",
    `- 처음 설정 답: 서랍 ${i.drawers.length ? i.drawers.join(" · ") : "없음"} · 첫 지시 ${i.firstOrder ? `"${i.firstOrder}"` : "없음"}`,
    collectLine,
    ...(i.partial ? ["- ⚠ 일부 수집이 아직 안 끝났다. 자료가 부족해 보이면 **최대 1분** 기다렸다가 다시 읽고 시작하라. 그 뒤엔 있는 것으로 간다."] : []),
    "",
    "## 목표 — 이 사람에게 맞는 수집기·증류기를 세우고 첫 지식을 낸다",
    "",
    "⚠ **사람에게 말할 때는 «수집기»·«증류기»라고 하지 마라** — 화면에 없는 개발자 낱말이다(#2243).",
    "   수집기 → **자료 가져오기**(외부 앱 연결 화면의 그 스위치) · 증류기 → **지식으로 정리하기**.",
   "   도구 이름(org_collector_upsert 등)은 그대로 쓰되, 요약·설명 문장에서는 위 말로 바꿔 말한다.",
    `틀에 박힌 것을 찍어내지 마라. 같은 직무라도 사람마다 자료의 성격이 다르다 — **자료를 실제로 읽고** ${who}의 일하는 방식에 맞춰라.`,
    "",
    "## 먼저 `liv-distill` 스킬을 열어 그 절차대로 한다",
    "이 스킬이 두뇌다 — 레인은 서랍 기준(자료 종류로 가르지 않는다), 표본 읽기 예산(자료 수의 2배), catch-all, 증류기 key `liv-<서랍 key>` 멱등, 물어도 되는 것 3종, 첫 지시 = 인수 시험, 첫 문장부터 한국어. 스킬이 없으면 아래 절차만으로 간다.",
    "",
    "## 절차",
    "1. **자료 표본을 실제로 읽는다** — 종류마다 3~5건 `source_get`. 결정이 오가는 곳인가, 반복 양식인가, 숫자인가, 남의 글을 모아 둔 것인가.",
    "2. **서랍(갈래)마다 증류기를 세운다** — `org_distiller_upsert`. 스코프(`match_kinds`·`include_channels`)·기준(`criteria_md`: 이 서랍에서 지식이 되는 것은 무엇인가)·형식(`format_md`: 결과의 꼴)·`target_category`(그 서랍). **catch-all 레인 하나를 반드시**(priority 낮게, 스코프 넓게) — 없으면 어느 증류기에도 안 걸린 자료가 조용히 사라진다. 자세한 규율은 `distiller-authoring` 스킬.",
    "3. **수집기 범위를 손본다** — `org_collector_upsert`. 자료를 읽어 보니 잡담 채널·알림 봇이 섞여 있으면 뺀다. 주기는 이 사람의 반복 주기에 맞춘다.",
    "4. **첫 지시를 시도한다** — 첫 지시가 있으면 지금 있는 자료로 그 답을 낸다(지식으로 남기려면 `knowledge_save` + `source_link_knowledge`). 자료가 모자라면 무엇이 모자란지 말한다.",
    "5. **남긴다** — 무엇을 왜 그렇게 세웠는지 `me_liv_profile_set`(decision). 다음 세션의 리브가 오늘을 알아야 한다.",
    "",
    "## 규율",
    "- **멱등** — 이미 있는 수집기·증류기는 다시 만들지 말고 갱신한다(같은 key 로 upsert). 이 지시가 두 번 와도 결과는 하나다.",
    "- **물어야 할 때만 묻는다** — 자료를 본 뒤에도 정말 갈리는 것(예: 두 서랍 중 어디로, 어떤 채널을 뺄지)만 `me_liv_ask_choice`. 자격이 필요하면 `me_liv_ask_secret`, 파일이 더 필요하면 `me_liv_ask_upload`. 물었으면 그 턴은 거기서 끝난다 — 답이 오면 이어서 한다.",
    "- **되돌리기 어려운 것은 하지 않는다** — 자료·지식 삭제, 외부 전송, 남의 설정.",
    "- **끝나면 요약한다** — 만든 것(수집기·증류기·지식) · 바꾼 것 · 못 한 것과 이유. 그리고 턴을 끝낸다.",
  ].join("\n");
}

// ── 판정 ────────────────────────────────────────────────────────────────────────
export interface SecondTurnState {
  welcome: { done_at?: string | null; session_id?: string | null; distill_at?: string | null; distill_gave_up_at?: string | null;
    /** 세션이 사라져 **다시 연** 시각(#1631). 한 번만 다시 연다 — 무한 재생성은 비용이고 유령 세션을 만든다. */
    distill_reopened_at?: string | null } | null;
  /** 세션 관측(listSessionsRaw). null = 그 세션이 이 박스에 없다(회수·종료·노드). */
  session: { working?: boolean; agentState?: string | null } | null;
  /** 아직 배달 안 된(또는 실패한) 아웃박스 항목 수 — 1턴이 들어갔는지의 근거. */
  outboxPending: number;
  collectors: Array<{ enabled: boolean; lastRunAt: string | null }>;
  now: number;
}
export type SecondTurnDecision =
  | { action: "skip"; reason: "no-kickoff" | "already-fired" | "gave-up" }
  | { action: "wait"; reason: "turn1-undelivered" | "turn1-running" | "collecting" | "session-offline" }
  //  세션이 사라졌지만 **일은 남아 있다** — 새 창구를 열어 거기로 배달한다(#1631). 딱 한 번.
  | { action: "reopen"; reason: "session-gone" }
  | { action: "giveup"; reason: "session-gone" | "session-gone-again" | "turn1-never-delivered" | "turn1-session-offline" }
  | { action: "fire"; partial: boolean; waitedMin: number };

/** 수집 대기 상한 — 이 안에 첫 배치가 안 끝나면 있는 것으로 시작한다(영원히 안 쏘는 것이 최악이다). */
export const SECOND_TURN_MAX_WAIT_MS = 20 * 60_000;
/** 1턴 배달 상한 — 아웃박스 NOT_READY_TTL(2h)과 같다. 이 뒤에도 안 들어갔으면 사람이 세션을 안 연 것이다. */
export const TURN1_DELIVERY_TTL_MS = 2 * 60 * 60_000;

export function decideSecondTurn(s: SecondTurnState): SecondTurnDecision {
  const w = s.welcome;
  if (!w?.session_id || !w.done_at) return { action: "skip", reason: "no-kickoff" };
  if (w.distill_at) return { action: "skip", reason: "already-fired" };
  if (w.distill_gave_up_at) return { action: "skip", reason: "gave-up" };
  const done = Date.parse(w.done_at);
  const waited = s.now - done;
  if (!s.session) {
    //  ★ #1631 실측(2026-08-31 dev): 1턴을 성공으로 끝낸 리브 세션이 **수집 대기 20분 사이에 사라졌다.**
    //   종전엔 그 자리에서 영구 포기했고(distill_gave_up_at·멱등 가드), 그 사람의 증류기 15개가 **영원히 꺼진 채**
    //   남아 온보딩을 완주하고도 지식을 하나도 못 얻었다. 세션이 왜 죽었는지는 게이트웨이 기록에 없다
    //   (org_session_state 의 exited_at·exit_reason 이 비어 있다) — 원인을 모르는 채로도 사람이 손해 보면 안 된다.
    //   사슬의 목적은 **일**이지 그 세션이 아니므로 새 창구를 연다. 단 **딱 한 번**이고(무한 재생성 금지),
    //   1턴 배달 상한을 넘긴 뒤엔 열지 않는다 — 한참 뒤에 창이 불쑥 뜨는 편이 더 나쁘다.
    if (w.distill_reopened_at) return { action: "giveup", reason: "session-gone-again" };
    if (waited > TURN1_DELIVERY_TTL_MS) return { action: "giveup", reason: "session-gone" };
    return { action: "reopen", reason: "session-gone" };
  }
  if (s.outboxPending > 0) {
    return waited > TURN1_DELIVERY_TTL_MS ? { action: "giveup", reason: "turn1-never-delivered" } : { action: "wait", reason: "turn1-undelivered" };
  }
  if (s.session.working || s.session.agentState === "busy") return { action: "wait", reason: "turn1-running" };
  // ★ 세션이 살아 있지 않으면 1턴은 **아직 한 글자도 안 나왔다.** 'busy 가 아님' 을 '끝났음' 으로 읽으면
  //  안 된다 — 실측(2026-08-30 dev): 세션이 안 뜬 채로 온보딩 31초 만에 2턴이 발사되고 distill_at 이
  //  찍혀, 그 사람은 **영영 증류 지시를 못 받았다**(멱등 가드가 재시도를 막는다). 자료 8건·레인 0.
  //  AI 미로그인·스폰 실패·노드 오프라인이 전부 이 모양으로 들어온다.
  //  그래서 기다린다 — 사람이 로그인하거나 세션이 뜨면 그때 쏜다. TTL 을 넘기면 포기하고 사유를 남긴다
  //  (포기는 distill_gave_up_at 으로 남아 화면이 "왜 안 왔나"에 답할 수 있다).
  if (s.session.agentState === "offline") {
    return waited > TURN1_DELIVERY_TTL_MS
      ? { action: "giveup", reason: "turn1-session-offline" }
      : { action: "wait", reason: "session-offline" };
  }
  const enabled = s.collectors.filter((c) => c.enabled);
  const notYet = enabled.filter((c) => !c.lastRunAt || Date.parse(c.lastRunAt) < done);
  const waitedMin = Math.max(0, Math.round(waited / 60_000));
  if (notYet.length && waited < SECOND_TURN_MAX_WAIT_MS) return { action: "wait", reason: "collecting" };
  return { action: "fire", partial: notYet.length > 0, waitedMin };
}

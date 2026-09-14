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

import { GROUP_SETS, groupSetFor, groupSetPromptLines } from "../../v6/category-groups.js";

export interface SecondTurnCollector { label: string; preset_key: string; enabled: boolean; ran: boolean }
export interface SecondTurnInput {
  displayName: string | null;
  /** 처음 설정에서 답한 일하는 형태·직무 한 줄(liv_profile.work.asis). 자료가 0건이면 카테고리를 만들 재료는 이것뿐이다. */
  work: string | null;
  /**
   * 이 워크스페이스의 **묶음**(카테고리 위의 화면 층, #1631). 처음 설정이 직업·직무로 심어 둔다.
   *  리브는 이 중에서 **고르기만** 한다 — 새로 만들지 않는다. 비어 있으면 아래 intended 를 **먼저 만들게** 한다
   *  (종전엔 구획을 아예 뺐고, 그 판에서 리브가 묶음 없는 카테고리를 만들었다 — 2026-09-14 lively-agent-2-6a84).
   */
  groups: Array<{ key: string; name: string; hint?: string | null }>;
  /**
   * 묶음이 **없을 때** 리브가 먼저 만들 세 칸 — 이 사람의 무대·직무로 룰 테이블에서 고른 집합(groupSetFor). 묶음이 있으면 안 쓴다.
   *  비었으면(판정 재료가 없었다) 기본 집합으로 간다 — 어느 경로로도 «묶음 없이 카테고리를 만들라» 는 지시가 나가지 않는다.
   */
  intended: Array<{ key: string; name: string; hint?: string | null }>;
  /** 묶음 밖 카테고리(이름). 이 턴을 끝내기 전에 0개로 만든다 — 계정 서버 기본 카테고리·처음 설정 서랍이 여기 걸린다. */
  ungrouped: Array<{ key: string; name: string }>;
  drawers: string[];
  firstOrder: string | null;
  collectors: SecondTurnCollector[];
  partial: boolean;          // 상한까지 기다렸는데 일부 수집이 아직 → 있는 것으로 시작
  waitedMin: number;         // 온보딩 끝난 뒤 흐른 시간(분)
}

/**
 * 2턴이 묶음에 쓸 재료(순수, #1631) — 무대(welcome.stage)와 «무대 · 직무» 한 줄(work.asis)에서 직무를 되갈라 룰 테이블의 세 칸을 고른다.
 *  ⚠ 무대를 넘긴다(2026-09-14) — 종전 받침은 무대를 null 로 넘겨, 직무를 건너뛴 학업 사용자가 회사 기본 이름을 받았다.
 *  ⚠ 구분자는 주입받는다(`WORK_ASIS_SEP`, org/store/members.ts) — 이 파일은 DB 모듈을 끌어오지 않는 순수 모듈이다.
 */
export function turnGroupInputs(input: { stage?: string | null; workAsis?: string | null; sep: string }): {
  stage: string | null; job: string | null; intended: Array<{ key: string; name: string; hint: string }>;
} {
  const stage = String(input.stage ?? "").trim() || null;
  const job = String(input.workAsis ?? "").split(input.sep).slice(-1)[0]?.trim() || null;
  return { stage, job, intended: groupSetFor(stage, job).map((g) => ({ key: g.key, name: g.name, hint: g.hint })) };
}

// ── 묶음 단락(#1631) — **빠지는 경우가 없다** ─────────────────────────────────────
//  2026-09-14 실측(lively-agent-2-6a84): 묶음이 0개인 워크스페이스에서 이 단락이 통째로 빠졌고, 리브는 묶음 없는
//   카테고리 4개를 에러 없이 만들었다 — 서버의 하드 규칙은 묶음이 **있어야** 켜지기 때문이다. 그래서:
//  · 묶음이 있으면: 그 안에서 고른다(새로 만들지 않는다) — 종전 문구 그대로.
//  · 없으면: 이 사람 직무의 세 칸(intended)을 **먼저** 만들게 한다 — 만드는 순간부터 하드 규칙이 켜진다.
//  · 묶음 밖 카테고리가 남아 있으면 이름을 싣고 0개로 끝내게 한다.
function groupStepLines(i: SecondTurnInput): string[] {
  const has = i.groups.length > 0;
  const set = has ? i.groups : (i.intended.length ? i.intended : GROUP_SETS.default);
  const lines: string[] = has
    ? [
      "   - **묶음도 함께 정한다.** 이 워크스페이스의 묶음은 아래가 전부이고, 이 사람 일 전체를 덮는다. `category_create` 의 `group` 에 그 key 를 넣는다 — **안 넣으면 서버가 400 으로 막는다**(카테고리는 묶음 하나에 반드시 든다). **새 묶음을 만들지 마라.** 「기타」 같은 자리로 미루지도 마라 — 그런 묶음은 없다.",
      "     **이미 있는 카테고리를 쓰는데 묶음이 비어 있으면** 그 자리에서 `category_update` 로 묶음만 채운다(내용은 건드리지 않는다). 안 채우면 그 카테고리는 화면에서 «묶음을 정해 주세요» 에 남는다.",
    ]
    : [
      "   - **묶음부터 만든다 — 이 워크스페이스엔 아직 묶음이 없다.** 카테고리를 만들기 **전에** 아래 세 칸을 `category_group_upsert` 로 **key·이름·뜻을 그대로** 만든다(이름을 새로 짓지 않는다 — 이 사람의 직무에서 나온 룰베이스 집합이다). 만든 뒤 `category_group_list` 로 셋이 다 생겼는지 확인한다.",
      "     그다음부터 카테고리는 **묶음도 함께 정한다.** `category_create` 의 `group` 에 그 key 를 넣는다 — **안 넣으면 서버가 400 으로 막는다**(카테고리는 묶음 하나에 반드시 든다). 「기타」 같은 자리로 미루지 마라 — 그런 묶음은 없다.",
    ];
  lines.push(...groupSetPromptLines(set).map((l) => `  ${l}`));
  if (i.ungrouped.length) {
    lines.push(`   - **묶음 밖 카테고리 ${i.ungrouped.length}개: ${i.ungrouped.map((c) => c.name).join(" · ")}** — 이 턴을 끝내기 전에 각각 \`category_update\` 로 위 세 칸 중 하나에 넣는다(내용은 건드리지 않는다). 묶음 밖 카테고리가 **0개**여야 이 단계가 끝난다.`);
  }
  lines.push("     이미 묶음에 든 카테고리도 자료를 읽어 보니 칸이 안 맞으면 `category_update` 로 옮긴다 — 서버가 이름만 보고 넣어 둔 것일 수 있다.");
  return lines;
}

// ── TEMPLATE — 문안은 여기만 고친다 ─────────────────────────────────────────────
export function buildSecondTurnPrompt(i: SecondTurnInput): string {
  const who = i.displayName ? `${i.displayName} 님` : "이 사람";
  const on = i.collectors.filter((c) => c.enabled);
  const off = i.collectors.filter((c) => !c.enabled);
  const ran = on.filter((c) => c.ran);
  const pending = on.filter((c) => !c.ran);
  //  #3872 — 꺼진 칸은 연결이 아니다. 매니지드가 모든 워크스페이스에 Notion·Slack 빈 칸(꺼짐·자격 없음)을 심어 두는데, 종전엔
  //   그 칸이 있다는 이유로 «첫 수집을 마친 것 없음» 이라고 써서 리브가 «연결됐고 곧 돈다» 로 읽었다(2026-09-13 실측).
  //   리브는 이 턴에서 org_collectors 를 다시 읽으므로 그 칸을 다시 보게 된다 — 그래서 «연결이 아니다» 를 여기 못박는다.
  const offNote = off.length ? ` — 꺼져 있는 칸 ${off.length}개(${off.map((c) => c.label).join(" · ")})는 연결이 아니다(자격이 없는 빈 칸일 수 있다). «연결됐다»·«곧 돈다» 고 말하지 마라` : "";
  const collectLine = on.length
    ? `- 수집기: ${ran.length ? `첫 수집을 마친 것 ${ran.map((c) => c.label).join(" · ")}` : "첫 수집을 마친 것 없음"}${pending.length ? ` / 아직 안 끝난 것 ${pending.map((c) => c.label).join(" · ")}` : ""}${offNote}`
    : `- 수집기: 없음(외부 앱을 잇지 않음) — 자료는 올린 것뿐이며, 그것도 0건일 수 있다${offNote}`;   // 실측(태오 채점): "올린 자료만 있다"로 단정하면 자료 0건일 때 전제가 틀린다
  return [
    `리브, 이제 **증류 작업**을 시작한다. 처음 설정이 끝난 지 ${i.waitedMin}분 지났다.`,
    "",
    "## 먼저 — 1턴의 실측은 낡았다. **지금 상태를 다시 읽어라.**",
    "1턴에서 본 숫자를 믿지 마라. 아래 도구로 지금 것을 새로 읽고 시작한다:",
    "- `source_list`(자료 — 종류·제목·건수) · `category_list`(카테고리 = 서랍) · `org_collectors`(수집기와 마지막 실행) · `org_distiller_list`(증류기) · `knowledge_list`(이미 있는 지식)",
    `- 처음 설정 답: 일하는 형태·직무 ${i.work ? `"${i.work}"` : "없음"} · 서랍 ${i.drawers.length ? i.drawers.join(" · ") : "없음"} · 첫 지시 ${i.firstOrder ? `"${i.firstOrder}"` : "없음"}`,
    collectLine,
    ...(i.partial ? ["- ⚠ 일부 수집이 아직 안 끝났다. 자료가 부족해 보이면 **최대 1분** 기다렸다가 다시 읽고 시작하라. 그 뒤엔 있는 것으로 간다."] : []),
    "",
    "## 목표 — 이 사람에게 맞는 카테고리·수집기·증류기를 세우고 첫 지식을 낸다",
    "",
    "⚠ **사람에게 말할 때는 «수집기»·«증류기»라고 하지 마라** — 화면에 없는 개발자 낱말이다(#2243).",
    "   수집기 → **자료 가져오기**(외부 앱 연결 화면의 그 스위치) · 증류기 → **지식으로 정리하기**.",
   "   도구 이름(org_collector_upsert 등)은 그대로 쓰되, 요약·설명 문장에서는 위 말로 바꿔 말한다.",
    "   카테고리는 화면에 있는 말이라 사람에게도 **카테고리**라고 한다(«서랍»이라고 하지 않는다).",
    `틀에 박힌 것을 찍어내지 마라. 같은 직무라도 사람마다 자료의 성격이 다르다 — **자료를 실제로 읽고** ${who}의 일하는 방식에 맞춰라.`,
    "",
    "## 먼저 `liv-distill` 스킬을 열어 그 절차대로 한다",
    "이 스킬이 두뇌다 — 레인은 서랍 기준(자료 종류로 가르지 않는다), 표본 읽기 예산(자료 수의 2배), catch-all, 증류기 key `liv-<서랍 key>` 멱등, 물어도 되는 것 3종, 첫 지시 = 인수 시험, 첫 문장부터 한국어. 스킬이 없으면 아래 절차만으로 간다.",
    "⚠ 아래 **절차 2(카테고리 만들기)는 스킬에 이 단계가 없어도 반드시 한다** — 워크스페이스에 따라 스킬이 이 단계가 생기기 전 판일 수 있다.",
    "",
    "## 절차",
    "1. **자료 표본을 실제로 읽는다** — 종류마다 3~5건 `source_get`. 결정이 오가는 곳인가, 반복 양식인가, 숫자인가, 남의 글을 모아 둔 것인가.",
    "2. **카테고리를 만든다 — 이 단계는 건너뛰지 않는다.** 증류기의 목적지(`target_category`)는 이미 있는 카테고리만 저장된다. 처음 설정은 카테고리를 만들지 않고 끝나므로 여기서 만든다 — 카테고리가 없으면 증류기도, 지식이 들어갈 자리도 없다.",
    "   - 재료: 1에서 읽은 자료(올린 파일·연결한 앱에서 들어온 자료) · 위의 일하는 형태·직무 · `category_list` 에 이미 있는 카테고리.",
    "   - **이미 있는 카테고리가 받을 수 있으면 그것을 쓴다.** 어느 카테고리에도 안 맞는 자료 덩어리가 있을 때만 `category_create` 로 더한다. 같은 범위를 이름만 바꿔 또 만들지 않는다.",
    "   - 나누는 기준은 내용(무슨 일에 대한 자료인가)이다. 자료 종류(슬랙·노션·메일)로 나누지 않는다. 보통 3~6개, 자료가 1~3건이면 1~3개. **자료가 0건이면 일하는 형태·직무로 2~3개를 만든다 — 0개로 끝내지 않는다.**",
    "   - 값: `key` 는 영문 소문자·숫자·하이픈 40자 이내(증류기 key 가 `liv-<카테고리 key>` 가 된다) · `name` 은 한국어 · `should` 는 400~600자로 범위(한 문장), 자료에서 본(자료가 없으면 그 직무에서 흔한) 구체적인 예 3~5개, 안 들어가는 것과 그것이 가는 옆 카테고리 이름을 쓴다(회사·팀 이름과 민감정보 규칙은 쓰지 않는다) · `description` 은 한 줄.",
    ...groupStepLines(i),
    "   - **묻지 않고 만든다.** 사람은 나중에 화면에서 이름을 바꾸거나 치울 수 있다. 물을 것이 생겨도 카테고리를 다 만든 뒤에 묻는다(`lively-taxonomy` 스킬의 항목별 승인 절차는 여기서 쓰지 않는다).",
    "   - 만든 뒤 `category_list` 로 다시 읽어 실제로 생겼는지 확인한다. 만들기가 실패하면 오류 문구를 그대로 두고, 요약 첫 줄에 «카테고리를 만들지 못했다»와 그 이유를 쓴다.",
    "3. **카테고리(서랍)마다 증류기를 세운다** — `org_distiller_upsert`. 스코프(`match_kinds`·`include_channels`)·기준(`criteria_md`: 이 카테고리에서 지식이 되는 것은 무엇인가)·형식(`format_md`: 결과의 꼴)·`target_category`(그 카테고리 key). **catch-all 레인 하나를 반드시**(priority 낮게, 스코프 넓게) — 없으면 어느 증류기에도 안 걸린 자료가 조용히 사라진다. 자세한 규율은 `distiller-authoring` 스킬.",
    "4. **수집기 범위를 손본다** — `org_collector_upsert`. 자료를 읽어 보니 잡담 채널·알림 봇이 섞여 있으면 뺀다. 주기는 이 사람의 반복 주기에 맞춘다.",
    "5. **첫 지시를 시도한다** — 첫 지시가 있으면 지금 있는 자료로 그 답을 낸다(지식으로 남기려면 `knowledge_save` + `source_link_knowledge`). 자료가 모자라면 무엇이 모자란지 말한다.",
    "6. **남긴다** — 무엇을 왜 그렇게 세웠는지(카테고리를 그렇게 나눈 이유 포함) `me_liv_profile_set`(decision). 다음 세션의 리브가 오늘을 알아야 한다.",
    "",
    "## 규율",
    "- **멱등** — 이미 있는 카테고리·수집기·증류기는 다시 만들지 말고 쓰거나 갱신한다(같은 key 로 upsert). 이 지시가 두 번 와도 결과는 하나다.",
    "- **물어야 할 때만 묻는다** — 자료를 본 뒤에도 정말 갈리는 것(예: 두 서랍 중 어디로, 어떤 채널을 뺄지)만 `me_liv_ask_choice`. 자격이 필요하면 `me_liv_ask_secret`, 파일이 더 필요하면 `me_liv_ask_upload`. 물었으면 그 턴은 거기서 끝난다 — 답이 오면 이어서 한다.",
    "- **되돌리기 어려운 것은 하지 않는다** — 자료·지식 삭제, 외부 전송, 남의 설정.",
    "- **끝나면 요약한다** — 만든 것(카테고리·수집기·증류기·지식 — 카테고리는 이름을 빠짐없이) · 바꾼 것 · 못 한 것과 이유. 그리고 턴을 끝낸다.",
  ].join("\n");
}

// ── 판정 ────────────────────────────────────────────────────────────────────────
export interface SecondTurnState {
  welcome: { done_at?: string | null; session_id?: string | null; distill_at?: string | null; distill_gave_up_at?: string | null;
    /** 리브 탭의 대화 턴으로 킥오프한 사람(#1631) — 세션 대신 이 턴이 1턴이다. 스윕이 그 턴의 끝남을 session.working 으로 옮겨 준다. */
    liv_turn_id?: string | null;
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
  //  킥오프의 증거는 둘 중 하나 — tmux 세션(session_id) 또는 리브 대화 턴(liv_turn_id, #1631 2026-09-14).
  if (!(w?.session_id || w?.liv_turn_id) || !w?.done_at) return { action: "skip", reason: "no-kickoff" };
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

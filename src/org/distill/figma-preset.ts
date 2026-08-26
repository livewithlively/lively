// 피그마 코멘트 자료 증류기 프리셋 (#1881 F8) — "디자인 코멘트가 지식이 되는" 마지막 조각.
//  왜 프리셋인가: F5 로 자료(kind=figma_comment)는 쌓이는데 증류기가 0개면 **수집은 성공하고 지식은 한 줄도 안 는다**
//   (로컬 L3 와 같은 이유 — dev 실측: figma_comment 4건 전부 미증류). 셀프서브 사용자는 증류기라는 개념을 모른다.
//   그래서 첫 피그마 수집기를 만들 때 **꺼진 채로** 준비하고(distiller-authoring §3), 사람이 표본을 보고 켠다.
//  스코프는 kind 전용 catch-all(match_kinds=['figma_comment']): 피그마 자료가 어디에도 안 잡혀 사라지지 않는다.
//
// ── 피그마 코멘트가 슬랙 메시지와 다른 점 (기준을 따로 세운 이유) ─────────────────────────────
//  ① **맥락이 본문에 없다.** 코멘트는 캔버스의 한 점에 붙어 있어 "여기 간격 8로" 처럼 지시어로 말한다.
//     본문만 읽으면 무슨 화면인지 모른다 — 채널(=파일명)이 사실상 유일한 맥락 단서다.
//  ② **스레드가 얕고 짧다.** 피그마 답글은 1단이라(답글의 답글이 없다) 스레드가 곧 완결 단위다.
//  ③ ★ **resolved 가 있다.** 슬랙엔 없는 신호다 — 해결 처리된 스레드는 **결론이 난 것**이고,
//     미해결 스레드는 아직 논의 중이다. 이 둘을 같은 기준으로 다루면 진행 중인 안을 결정으로 굳힌다.
import type { DistillerUpsertInput } from "../store/ingest.js";
import { upsertDistiller } from "../store/ingest.js";
import { getDistiller } from "./distiller.js";
import { upsertCronJob } from "../cron-store.js";

export const FIGMA_DISTILLER_KEY = "figma-comments";
export const FIGMA_DISTILL_JOB_ID = "distill-figma-comments";
export const FIGMA_DISTILL_INTERVAL_SEC = 900;

export const FIGMA_CRITERIA_MD = `## 판단 단위 — 스레드 하나가 한 논의다
- 자료 1건 = 피그마 코멘트 1건. **부모 코멘트 + 그 답글들을 묶어 하나로 판단한다**(피그마 답글은 1단이라 스레드가 곧 완결 단위다).
- 코멘트 낱개로는 거의 아무 뜻이 없다("ㅎㅎ", "확인", "여기요"). 스레드로 합쳐야 논의가 보인다.
- 채널(container_name) = **디자인 파일 이름**이다. 코멘트는 캔버스의 한 점에 붙어 있어 "여기·이거·이 부분" 같은 지시어로 말하므로, **파일명이 사실상 유일한 맥락 단서**다. 지식에 반드시 남긴다.

## ★ 해결됨(resolved) 을 먼저 본다
- \`resolved: true\` 스레드 = **결론이 난 것**. 디자인 코멘트에서 가장 강한 지식 신호다. 무엇이 어떻게 정해졌는지를 남긴다.
- \`resolved: false\` 스레드 = **아직 논의 중**이다. 결정으로 굳혀 쓰지 마라 — 지식으로 만들 값어치가 있으면 "열린 사항"으로 명시하고, 결론처럼 단정하는 문장을 쓰지 않는다.
- 미해결인데 마지막 답글이 조치 완료를 말하면(아래 '완결 구조') 결론으로 본다 — 해결 표시를 안 누르는 팀이 많다.

## 형태별 규칙 (여기 안 맞으면 지식이 아니다)
1. **디자인 결정**(A안으로 간다 / 이 컴포넌트를 쓴다 / 이 흐름으로 바꾼다): 무엇을 왜 그렇게 정했는지 + 탈락한 안이 있으면 그 이유까지. 같은 논의가 반복될 때 이게 가장 값지다.
2. **사양·수치 확정**(간격·색·크기·카피 문구·상태 정의): **원문 표현 그대로** 인용한다. 요약으로 바꾸면 구현이 어긋난다.
3. **피드백·수정 요청 → 반영**: 지적과 그 결과를 한 줄기로. 반영 여부가 안 보이면 '요청됨'까지만 적는다.
4. **QA·버그 지적**: 증상 → 원인(있으면) → 조치. 화면·조건이 적혀 있으면 그대로 남긴다.
5. **배경 맥락**(왜 이 화면이 이렇게 생겼는지, 어떤 제약 때문에 이 안을 못 쓰는지): 짧아도 지식이다 — 나중에 같은 제안이 다시 올라온다.

## 제외 (지식 아님 → skip)
- 리액션·인사·감탄만 있는 스레드("ㅎㅎ", "굿", "확인했습니다" 단발, 이모지).
- 위치만 찍고 내용이 없는 코멘트, 테스트로 남긴 낙서.
- 일정 조율("내일 볼게요"), 담당 호출("@OO 봐주세요")만 있고 내용이 없는 것.
- 같은 지적이 이미 지식이 된 경우 — 새로 만들지 말고 그 지식을 갱신한다(아래 중복 방지).

## 판정은 절대 기준으로 (백분위·상위 N% 금지)
아래 신호가 **하나라도** 있으면 지식 후보다. 없으면 skip:
- 무엇을 하기로/안 하기로 정한 문장이 있다(해결 표시가 있으면 특히).
- 수치·문구·조건이 구체적으로 적혀 있다(간격 8, #F24E1E, "로그인" 버튼 등).
- 왜 그렇게 하는지/왜 안 되는지 이유가 적혀 있다.
- 키워드가 없어도 **지적 → 조치 → 확인**으로 닫히는 구조가 있다. ⚠ 디자인 코멘트는 결정 단어를 거의 쓰지 않는다("여기 간격 8로" → "고쳤어요" → 해결). **구조로 잡지 않으면 실제 결정을 통째로 놓친다.**
애매하면 버리지 말고 저장한다 — 검토 여부는 조직의 인입 허용선 정책이 정한다. **lifecycle 을 직접 지정하지 마라.**

## 중복 방지 규약
- 저장 전 knowledge_similar 로 확인한다. 같은 주제가 있으면 새로 만들지 말고 **그 지식을 같은 name 으로 갱신**한다(knowledge_save mode='edit').
- ★ **같은 파일의 코멘트는 한 화면을 두고 오간 말이라 주제가 겹치기 쉽다.** 파일 단위로 이미 만든 지식이 있는지 먼저 보고, 있으면 거기에 이어 쓴다. 스레드마다 새 문서를 만들면 같은 화면 이야기가 파편으로 흩어진다.
- 나중에 그 스레드에 답글이 더 달리면 **기존 지식을 갱신**한다 — 새 name 은 수정이 아니라 중복 생성이다.
- 자료 링크 없는 지식을 만들지 마라. 만든 지식마다 source_link_knowledge(derived_from) 를 건다.
- 배치를 서브에이전트로 쪼개지 마라 — 한 스레드가 두 묶음에 걸려 같은 지식이 두 번 만들어진다.
`;

export const FIGMA_FORMAT_MD = `- **제목**: 무엇이 정해졌는지가 제목만 읽어도 보이게("로그인 화면 여백을 8pt 로 통일"). 파일명을 그대로 제목으로 쓰지 말고, 날짜는 제목에 넣지 않는다.
- **name(슬러그)**: 영문 소문자·숫자·하이픈. 같은 주제를 갱신할 땐 기존 name 을 그대로 쓴다.
- **섹션**: 배경(무슨 화면·무엇이 문제였나) → 논의 → 결론 → 후속조치 → 출처. 해당 없는 섹션은 통째로 뺀다(빈 섹션 금지).
  - **채택되지 않은 안도 왜 탈락했는지 남겨라.** 디자인은 같은 제안이 몇 달 뒤 다시 올라온다.
- **인용**: 수치·색·카피 문구·조건은 원문 표현 그대로. 추론한 것은 "…로 보인다" 로 표시해 사실과 구분한다. 원문에 없는 내용은 쓰지 않는다.
- **미해결 스레드**: 결론 대신 "열린 사항" 으로 적고, 누가 무엇을 정해야 하는지까지 쓴다.
- **출처**: 본문 끝에 "출처: 피그마 <파일명> · <날짜> · <참여자>" 한 줄. 파일을 열 수 있는 주소가 자료에 있으면 함께 남긴다. ⚠ 자료 id 를 본문에 나열하지 마라 — 자료↔지식 관계는 source_link_knowledge 링크가 정본이다.
- 개인정보: 사람은 표시 이름까지만.
`;

export function figmaCommentsDistillerDraft(): DistillerUpsertInput {
  return {
    key: FIGMA_DISTILLER_KEY,
    label: "피그마 코멘트",
    enabled: false,
    priority: -10,               // kind 전용 catch-all — 더 좁게 집는 피그마 증류기가 생기면 그쪽이 먼저 배정된다
    match_kinds: ["figma_comment"],
    match_system: "figma",
    include_channels: null, exclude_channels: null, include_authors: null, exclude_authors: null,
    exclude_bots: false,         // 피그마 코멘트에 봇 표식이 없다 — 켜면 판정 근거 없이 거를 위험만 있다
    min_chars: 0,                // ⚠ 코멘트는 짧다. 길이 컷은 "간격 8" 같은 사양 확정을 통째로 버린다
    lookback_days: null,
    criteria_md: FIGMA_CRITERIA_MD,
    format_md: FIGMA_FORMAT_MD,
    target_category: null,
    default_type: null,
    name_prefix: null,
    thread_aware: true,          // 부모+답글이 한 논의다(로컬 파일과 다른 지점)
    prefilter_level: 0,          // ⚠ 끔 — 길이·참여자·키워드 축이 전부 디자인 코멘트에 불리하다(짧고, 둘이서 말하고, 결정 단어를 안 쓴다).
    prefilter_rules: null,       //   실사용처가 생겨 자료가 쌓이면 org_distiller_tune 의 **유실률**로 정한다(감으로 켜지 마라).
    batch_size: 10,              // 스레드 10개 — 코멘트 스레드는 짧아 파일(로컬 5)보다 많이 담아도 컨텍스트가 남는다
    batch_max_msgs: 40,
    mode: "headless",
    note: "피그마 디자인 파일의 코멘트(자료 kind=figma_comment)를 지식으로. 첫 피그마 수집기를 만들 때 꺼진 채로 준비되고, 사람이 표본을 보고 켠다(#1881 F8).",
  };
}

export interface EnsureFigmaDistillerOpts {
  /** 만든/켠 사람(감사·created_by). */
  actor?: string | null;
  /** true 면 켜고(없으면 만들고) 크론 잡까지 등록한다. false/미지정 = 없을 때만 꺼진 채로 만든다. */
  enable?: boolean;
  /** 헤드리스 실행 신원(그 멤버의 클로드 로그인·과금 귀속). 켤 때 없으면 actor. */
  requester?: string | null;
  source?: string;
}

/**
 * 피그마 증류기를 '있게' 한다 — 없으면 **꺼진 채로** 만들고, enable 이면 켜면서 크론 잡까지 등록한다.
 *  ⚠ 켜기만 하고 잡을 안 걸면 화면은 초록불인데 아무것도 안 돈다(distiller-authoring §9 의 실측 함정).
 *  기존 행이 있으면 기준·형식·스코프는 **건드리지 않는다** — 사람이 손봤을 수 있다(부분 갱신).
 */
export async function ensureFigmaCommentsDistiller(opts: EnsureFigmaDistillerOpts = {})
  : Promise<{ distiller: Record<string, unknown>; created: boolean; enabled: boolean; job: { id: string; enabled: boolean } | null }> {
  const existing = await getDistiller(FIGMA_DISTILLER_KEY);
  let created = false;
  let row: Record<string, unknown>;
  if (!existing) {
    row = await upsertDistiller(
      { ...figmaCommentsDistillerDraft(), enabled: !!opts.enable, requester: opts.enable ? (opts.requester ?? opts.actor ?? null) : null },
      opts.actor ?? undefined, opts.source ?? "figma-collect");
    created = true;
  } else if (opts.enable && (!existing.enabled || (opts.requester && existing.requester !== opts.requester))) {
    row = await upsertDistiller(
      { key: FIGMA_DISTILLER_KEY, enabled: true, requester: opts.requester ?? existing.requester ?? opts.actor ?? null },
      opts.actor ?? undefined, opts.source ?? "figma-collect");
  } else {
    row = existing as unknown as Record<string, unknown>;
  }

  let job: { id: string; enabled: boolean } | null = null;
  if (opts.enable) {
    const j = await upsertCronJob({
      id: FIGMA_DISTILL_JOB_ID, label: "피그마 코멘트 증류", action: "distill_sources_headless",
      params: JSON.stringify({ distiller: FIGMA_DISTILLER_KEY }),
      interval_sec: FIGMA_DISTILL_INTERVAL_SEC, cron_expr: null, enabled: true,
      note: "피그마 코멘트(자료 kind=figma_comment)를 지식으로 — 증류기 'figma-comments' 전용(#1881 F8).",
      run_once: null, actor: opts.actor ?? null,
    });
    job = { id: String(j.id), enabled: !!j.enabled };
  }

  return { distiller: row, created, enabled: !!(row as { enabled?: boolean }).enabled, job };
}

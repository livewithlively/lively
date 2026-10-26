// Zotero 논문 자료 증류기 프리셋 — 자료(kind=zotero_item)가 쌓이는데 증류기가 0개면 지식이 한 줄도 안 는다.
//  피그마·GitHub 과 같은 이유·같은 모양: 첫 Zotero 수집기를 켤 때 **꺼진 채로** 준비하고, 사람이 표본을 보고 켠다.
//  스코프는 kind 전용 catch-all(match_kinds=['zotero_item']).
//
// ── 논문 자료가 슬랙·이슈와 다른 점 (기준을 따로 세운 이유) ─────────────────────────────
//  ① **한 건이 이미 완결 단위다.** 커넥터가 논문 한 편에 서지 + 주석 + 노트를 묶어 준다(connectors/zotero.ts). 스레드가 없다.
//  ② ★ **연구자의 생각은 주석·노트에만 있다.** 서지·초록은 논문 저자의 말이지 이 조직의 말이 아니다 — 서지만 있는 논문은
//     지식이 아니다(검색용 자료로 남는다). 그래서 사전필터가 «하이라이트·코멘트»·«노트» 머리가 있는 논문만 LLM 에 넘긴다(비용 0 으로 거른다).
//  ③ **색에 뜻이 있다.** 연구자마다 색 규칙이 다르다(노랑=핵심, 빨강=반박 …). 규칙이 자료에 없으면 색으로 뜻을 단정하지 않는다.
//  ④ **같은 논문 = 같은 지식.** 주석이 더 달리면 그 논문의 지식을 고쳐 쓴다(새 지식이 아니다).
import type { DistillerUpsertInput } from "../store/ingest.js";
import { upsertDistiller } from "../store/ingest.js";
import { getDistiller } from "./distiller.js";
import { upsertCronJob } from "../cron-store.js";
import { ANNOTATION_HEAD, NOTE_HEAD } from "../../connectors/zotero.js";

export const ZOTERO_DISTILLER_KEY = "zotero-papers";
export const ZOTERO_DISTILL_JOB_ID = "distill-zotero-papers";
export const ZOTERO_DISTILL_INTERVAL_SEC = 1800;

export const ZOTERO_CRITERIA_MD = `## 판단 단위 — 자료 한 건이 논문 한 편이다
- 자료 1건 = Zotero 논문 한 편(서지 + 초록 + 그 논문에 단 하이라이트·코멘트 + 노트) 또는 독립 노트 한 건. 이미 한 편으로 묶여 있으니 따로 합치지 않는다.
- 채널(container_name) = **라이브러리 이름**(내 라이브러리 · 연구실 그룹 이름). fields 에 year · creators · venue · doi · collections · tags · annotation_count · note_count · has_thinking 이 있다.
- 컬렉션·태그는 연구자가 붙인 분류다 — 어느 연구·프로젝트의 문헌인지 알려 주는 가장 좋은 단서다. 지식에 남긴다.

## ★ 생각이 담긴 논문만 지식이 된다
- \`has_thinking: false\` (주석·노트가 없고 서지·초록만 있는 논문) → **skip**. 초록은 논문 저자의 말이지 이 조직이 무엇을 읽고 판단했는지가 아니다. 그 자료는 검색용으로 그대로 남는다.
- 지식의 중심은 **하이라이트 원문과 코멘트, 노트**다. 연구자가 어디에 밑줄을 긋고 무엇이라 적었는지가 «우리가 이 논문에서 가져간 것»이다.

## 형태별 규칙
1. **핵심 발견·주장**(하이라이트가 모인 곳): 연구자가 강조한 문장을 원문 그대로 인용하고, 그 논문이 무엇을 보였는지 한두 줄로 묶는다. 페이지 번호를 남긴다.
2. **연구자의 판단**(코멘트·노트의 «동의/반박/우리 연구에 쓸 점/한계»): 가장 값지다 — 원문 그대로 남기고, 누구의 판단인지(그룹이면 이름)를 붙인다.
3. **방법·데이터·수치**(표본 수, 효과 크기, 실험 조건): 원문 표현 그대로. 요약으로 바꾸면 인용할 때 틀린다.
4. **연결**(다른 논문·우리 프로젝트와 어떻게 이어지나): 노트에 적혀 있으면 남긴다. 컬렉션 이름이 프로젝트를 가리키면 그것도 적는다.
5. **독립 노트**(논문에 안 붙은 노트): 문헌 정리·연구 아이디어·회의 메모다. 결론·결정·질문이 있으면 지식으로, 할 일 목록만 있으면 skip.

## 색
- 하이라이트 색은 사람마다 뜻이 다르다. 노트·자료에 색 규칙이 적혀 있지 않으면 **색으로 뜻을 단정하지 않는다**(«노랑이니 핵심» 금지). 색은 묶음 표시로만 쓴다.

## 제외 (지식 아님 → skip)
- 서지만 있는 논문(위 has_thinking:false).
- 하이라이트가 한두 줄뿐이고 코멘트·노트가 없어 무엇을 왜 봤는지 알 수 없는 것 — 단, 그 한 줄이 수치·결론이면 남긴다.
- 노트가 비었거나 서지를 복사해 둔 것뿐인 것, 할 일 목록만 있는 것.

## 판정은 절대 기준으로 (백분위·상위 N% 금지)
아래 중 **하나라도** 있으면 지식 후보다:
- 연구자가 적은 코멘트·노트가 한 문장 이상 있다.
- 하이라이트가 셋 이상이거나, 하나라도 수치·결론·정의를 담고 있다.
- 컬렉션·태그가 이 조직의 연구·프로젝트를 가리킨다.
- 결론·결정 같은 단어가 없어도 **하이라이트 → 코멘트 → 노트** 로 이어지는 구조(무엇을 보고 → 어떻게 판단했는지)가 있다. ⚠ 연구자의 주석은 결정 단어를 거의 쓰지 않는다 — 키워드가 없어도 이 구조로 잡지 않으면 실제 판단을 통째로 놓친다.
애매하면 버리지 말고 저장한다 — 검토 여부는 조직의 인입 허용선 정책이 정한다. **lifecycle 을 직접 지정하지 마라.**

## 중복 방지 규약
- ★ **논문 한 편 = 지식 하나.** 저장 전 knowledge_similar 로 같은 논문(제목·DOI)의 지식이 있는지 먼저 본다. 있으면 새로 만들지 말고 **그 지식을 같은 name 으로 갱신**한다(knowledge_save mode='edit') — 주석이 더 달려 자료가 다시 온 것이다.
- 같은 논문을 개인 라이브러리와 그룹 라이브러리에 따로 둔 경우(주석이 서로 동기화되지 않는다) 두 자료를 한 지식으로 합친다 — 다만 **공개범위가 다르면**(개인 라이브러리 자료가 잠겨 있으면) 합치지 말고 따로 둔다(저장이 409 로 거절된다).
- 자료 링크 없는 지식을 만들지 마라. 지식은 knowledge_save 에 derived_from:[이 지식이 나온 자료 id 전부] 를 실어 저장한다(저장과 자료 연결이 한 번에 된다).
- 배치를 서브에이전트로 쪼개지 마라 — 같은 논문이 두 묶음에 걸려 지식이 두 번 만들어진다.
`;

export const ZOTERO_FORMAT_MD = `- **제목**: 논문이 무엇을 보였는지 + 우리가 무엇을 가져갔는지가 보이게(«소규모 표본에서 X 효과는 재현되지 않는다 — Kim 2023»). 논문 제목을 그대로 쓰지 말고, 끝에 «1저자 연도» 를 붙인다.
- **name(슬러그)**: 영문 소문자·숫자·하이픈. 1저자 성 + 연도 + 핵심어(예: kim-2023-x-effect-replication). 같은 논문을 갱신할 땐 기존 name 을 그대로 쓴다.
- **섹션**: 서지(저자 · 연도 · 실린 곳 · DOI) → 핵심 발견(하이라이트 원문 인용, 페이지) → 연구자의 판단(코멘트·노트, 누구의 것인지) → 우리 연구와의 연결(컬렉션·태그·노트에 적힌 것) → 출처. 해당 없는 섹션은 통째로 뺀다(빈 섹션 금지).
- **인용**: 하이라이트·코멘트·수치는 원문 그대로 따옴표로. 추론한 것은 «…로 보인다» 로 표시해 사실과 구분한다. 원문에 없는 내용(논문을 따로 읽어 보탠 내용)은 쓰지 않는다.
- **출처**: 본문 끝에 «출처: Zotero <라이브러리 이름> · <논문 제목> · <주석 n개 · 노트 n개>» 한 줄. 자료에 주소가 있으면 함께 남긴다. ⚠ 자료 id 를 본문에 나열하지 마라 — 자료↔지식 관계는 derived_from 연결이 정본이다.
- 개인정보: 사람은 표시 이름까지만.
`;

/** 사전필터 — 본문에 주석·노트 머리가 있는 자료만 LLM 에 넘긴다(서지만 있는 논문을 비용 0 으로 거른다). 커넥터가 이 머리를 단다. */
export const ZOTERO_PREFILTER_RULES = { min_decisive: 1, keywords: [ANNOTATION_HEAD, NOTE_HEAD], match: "all" as const };

export function zoteroPapersDistillerDraft(): DistillerUpsertInput {
  return {
    key: ZOTERO_DISTILLER_KEY,
    label: "Zotero 논문",
    enabled: false,
    priority: -10,               // kind 전용 catch-all — 더 좁게 집는 Zotero 증류기(특정 컬렉션 등)가 생기면 그쪽이 먼저 배정된다
    match_kinds: ["zotero_item"],
    match_system: "zotero",
    include_channels: null, exclude_channels: null, include_authors: null, exclude_authors: null,
    exclude_bots: false,
    min_chars: 0,
    lookback_days: null,
    criteria_md: ZOTERO_CRITERIA_MD,
    format_md: ZOTERO_FORMAT_MD,
    target_category: null,
    default_type: "research",
    name_prefix: null,
    thread_aware: false,         // 한 건이 이미 논문 한 편이다 — 묶을 스레드가 없다
    prefilter_level: 0,
    prefilter_rules: ZOTERO_PREFILTER_RULES,
    batch_size: 5,               // 논문 한 편이 길다(초록 + 하이라이트 수십 줄) — 로컬 파일과 같은 5
    batch_max_msgs: 5,
    mode: "headless",
    note: "Zotero 논문(자료 kind=zotero_item — 서지 + 주석 + 노트)을 지식으로. 주석·노트가 있는 논문만 사전필터를 지난다. 첫 Zotero 수집기를 켤 때 꺼진 채로 준비되고, 사람이 표본을 보고 켠다.",
  };
}

export interface EnsureZoteroDistillerOpts {
  actor?: string | null;
  /** true 면 켜고(없으면 만들고) 크론 잡까지 등록한다. false/미지정 = 없을 때만 꺼진 채로 만든다. */
  enable?: boolean;
  /** 헤드리스 실행 신원(그 멤버의 클로드 로그인·과금 귀속). 켤 때 없으면 actor. */
  requester?: string | null;
  source?: string;
}

/**
 * Zotero 증류기를 '있게' 한다 — 없으면 **꺼진 채로** 만들고, enable 이면 켜면서 크론 잡까지 등록한다.
 *  ⚠ 켜기만 하고 잡을 안 걸면 화면은 초록불인데 아무것도 안 돈다(distiller-authoring §9 의 실측 함정).
 *  기존 행이 있으면 기준·형식·스코프는 **건드리지 않는다** — 사람이 손봤을 수 있다(부분 갱신). figma-preset.ts 와 같은 모양.
 */
export async function ensureZoteroPapersDistiller(opts: EnsureZoteroDistillerOpts = {})
  : Promise<{ distiller: Record<string, unknown>; created: boolean; enabled: boolean; job: { id: string; enabled: boolean } | null }> {
  const existing = await getDistiller(ZOTERO_DISTILLER_KEY);
  let created = false;
  let row: Record<string, unknown>;
  if (!existing) {
    row = await upsertDistiller(
      { ...zoteroPapersDistillerDraft(), enabled: !!opts.enable, requester: opts.enable ? (opts.requester ?? opts.actor ?? null) : null },
      opts.actor ?? undefined, opts.source ?? "zotero-collect");
    created = true;
  } else if (opts.enable && (!existing.enabled || (opts.requester && existing.requester !== opts.requester))) {
    row = await upsertDistiller(
      { key: ZOTERO_DISTILLER_KEY, enabled: true, requester: opts.requester ?? existing.requester ?? opts.actor ?? null },
      opts.actor ?? undefined, opts.source ?? "zotero-collect");
  } else {
    row = existing as unknown as Record<string, unknown>;
  }

  let job: { id: string; enabled: boolean } | null = null;
  if (opts.enable) {
    const j = await upsertCronJob({
      id: ZOTERO_DISTILL_JOB_ID, label: "Zotero 논문 증류", action: "distill_sources_headless",
      params: JSON.stringify({ distiller: ZOTERO_DISTILLER_KEY }),
      interval_sec: ZOTERO_DISTILL_INTERVAL_SEC, cron_expr: null, enabled: true,
      note: "Zotero 논문(자료 kind=zotero_item)을 지식으로 — 증류기 'zotero-papers' 전용.",
      run_once: null, actor: opts.actor ?? null,
    });
    job = { id: String(j.id), enabled: !!j.enabled };
  }

  return { distiller: row, created, enabled: !!(row as { enabled?: boolean }).enabled, job };
}

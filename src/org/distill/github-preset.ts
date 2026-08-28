// GitHub 이슈·PR 대화 증류기 프리셋 (#2247) — 자료(kind=github_issue)가 쌓이는데 증류기가 0개면 지식이 한 줄도 안 는다.
//  피그마(figma-preset.ts)와 같은 이유·같은 모양: 첫 GitHub 수집기를 켤 때 **꺼진 채로** 준비하고, 사람이 표본을 보고 켠다.
//  스코프는 kind 전용 catch-all(match_kinds=['github_issue']).
//
// ── 이슈·PR 대화가 슬랙·피그마와 다른 점 ────────────────────────────────────────────
//  ① **스레드가 곧 사건이다.** 이슈 하나 = 문제 하나, PR 하나 = 변경 하나. 본문 + 댓글 + 리뷰 댓글을 묶어야 결론이 보인다.
//  ② ★ **닫힘·머지가 있다.** closed/merged 는 결론이 난 것, open 은 진행 중이다(피그마 resolved 와 같은 신호).
//  ③ **원인·재현·수정이 구조로 온다.** 버그 이슈는 증상→원인→조치, PR 은 왜 바꿨나→어떻게→리뷰에서 무엇이 걸렸나.
import type { DistillerUpsertInput } from "../store/ingest.js";
import { upsertDistiller } from "../store/ingest.js";
import { getDistiller } from "./distiller.js";
import { upsertCronJob } from "../cron-store.js";

export const GITHUB_DISTILLER_KEY = "github-issues";
export const GITHUB_DISTILL_JOB_ID = "distill-github-issues";
export const GITHUB_DISTILL_INTERVAL_SEC = 900;

export const GITHUB_CRITERIA_MD = `## 판단 단위 — 이슈/PR 하나가 한 사건이다
- 자료 1건 = 이슈·PR 본문 1건 또는 댓글 1건. **본문 + 댓글 + 리뷰 댓글을 묶어 하나로 판단한다**(parent 가 같은 것이 한 스레드).
- 채널(container_name) = **저장소(owner/repo)**. fields.kind 가 issue | pr | comment | review_comment | release 다. fields.number 가 같으면 같은 사건이다.
- 릴리스 노트(kind=release)는 단독으로 판단한다 — 그 버전에 무엇이 들어갔는지가 곧 지식이다.

## ★ 닫힘·머지를 먼저 본다
- \`state: closed\` 이슈 / \`merged_at\` 이 있는 PR = **결론이 난 것**. 무엇이 원인이었고 어떻게 고쳤는지를 남긴다.
- \`state: open\` = **아직 진행 중**. 결론처럼 단정하지 말고 "열린 사항"으로 남긴다(값어치가 있을 때만).
- 닫혔는데 이유 없이 닫힌 것(중복·무효)은 지식이 아니다.

## 형태별 규칙 (여기 안 맞으면 지식이 아니다)
1. **버그 원인과 수정**: 증상 → 재현 조건 → 원인 → 조치. 원인 문장은 원문 그대로 인용한다.
2. **설계·구현 결정**(PR 설명·리뷰 논의에서 "이렇게 한 이유", 반려된 대안): 무엇을 왜 그렇게 했는지 + 탈락한 안과 이유.
3. **리뷰에서 걸린 규칙**("여기선 늘 X 해야 한다", "Y 는 쓰지 마라"): 팀 규약이다 — 파일·조건까지 남긴다.
4. **릴리스 노트**: 버전·날짜·들어간 변경을 항목 그대로.
5. **운영 사실**(장애 이슈의 타임라인·영향 범위·재발 방지책): 짧아도 지식이다.

## 제외 (지식 아님 → skip)
- 봇 댓글(CI 결과·자동 라벨·의존성 봇), "+1"·"LGTM"·감사 인사만 있는 댓글.
- 내용 없는 이슈(제목만, 템플릿 빈칸), 중복으로 닫힌 이슈, 초안(draft) PR 의 빈 설명.
- 같은 사건이 이미 지식이 된 경우 — 새로 만들지 말고 그 지식을 갱신한다.

## 판정은 절대 기준으로 (백분위·상위 N% 금지)
아래 신호가 **하나라도** 있으면 지식 후보다. 없으면 skip:
- 원인·이유를 말하는 문장이 있다("때문에", "원인은", "because", "root cause").
- 무엇을 하기로/안 하기로 정한 문장이 있다(머지·닫힘이면 특히).
- 조건·수치·파일·명령이 구체적으로 적혀 있다.
- 키워드가 없어도 **지적 → 수정 → 확인(머지)** 으로 닫히는 구조가 있다.
애매하면 버리지 말고 저장한다 — 검토 여부는 조직의 인입 허용선 정책이 정한다. **lifecycle 을 직접 지정하지 마라.**

## 중복 방지 규약
- 저장 전 knowledge_similar 로 확인한다. 같은 사건·같은 규칙이 있으면 **그 지식을 같은 name 으로 갱신**한다(knowledge_save mode='edit').
- 같은 저장소의 같은 번호(fields.number)는 한 사건이다 — 댓글이 더 달리면 기존 지식을 갱신한다.
- 자료 링크 없는 지식을 만들지 마라. 만든 지식마다 source_link_knowledge(derived_from) 를 건다.
- 배치를 서브에이전트로 쪼개지 마라.
`;

export const GITHUB_FORMAT_MD = `- **제목**: 무엇이 정해졌는지/무엇이 원인이었는지가 제목만 읽어도 보이게("로그인 실패 원인은 세션 캐시 키 충돌"). 이슈 번호·날짜는 제목에 넣지 않는다.
- **name(슬러그)**: 영문 소문자·숫자·하이픈. 같은 사건을 갱신할 땐 기존 name 을 그대로 쓴다.
- **섹션**: 배경(무슨 저장소·무엇이 문제였나) → 원인/논의 → 결론(수정·결정) → 후속조치 → 출처. 해당 없는 섹션은 통째로 뺀다.
  - **반려된 대안도 왜 탈락했는지 남겨라.**
- **인용**: 원인 문장·조건·수치·명령·파일 경로는 원문 그대로. 추론한 것은 "…로 보인다" 로 표시한다.
- **열린 이슈**: 결론 대신 "열린 사항" 으로 적고, 무엇이 정해져야 닫히는지까지 쓴다.
- **출처**: 본문 끝에 "출처: GitHub <owner/repo>#<번호> · <날짜> · <참여자>" 한 줄. 주소(external_url)가 있으면 함께. ⚠ 자료 id 를 본문에 나열하지 마라.
- 개인정보: 사람은 GitHub 표시 이름까지만.
`;

export function githubIssuesDistillerDraft(): DistillerUpsertInput {
  return {
    key: GITHUB_DISTILLER_KEY,
    label: "GitHub 이슈·PR 대화",
    enabled: false,
    priority: -10,
    match_kinds: ["github_issue"],
    match_system: "github",
    include_channels: null, exclude_channels: null, include_authors: null, exclude_authors: null,
    exclude_bots: true,          // CI·의존성 봇 댓글은 actor.is_bot 으로 표식이 온다 — 걸러도 근거가 있다
    min_chars: 0,
    lookback_days: null,
    criteria_md: GITHUB_CRITERIA_MD,
    format_md: GITHUB_FORMAT_MD,
    target_category: null,
    default_type: null,
    name_prefix: null,
    thread_aware: true,          // 본문+댓글이 한 사건
    prefilter_level: 0,
    prefilter_rules: null,
    batch_size: 8,
    batch_max_msgs: 60,          // PR 하나에 리뷰 댓글이 수십 개 붙는다
    mode: "headless",
    note: "GitHub 이슈·PR 대화와 릴리스 노트(자료 kind=github_issue)를 지식으로. 첫 GitHub 수집기를 켤 때 꺼진 채로 준비되고, 사람이 표본을 보고 켠다(#2247).",
  };
}

export interface EnsureGithubDistillerOpts { actor?: string | null; enable?: boolean; requester?: string | null; source?: string }

export async function ensureGithubIssuesDistiller(opts: EnsureGithubDistillerOpts = {})
  : Promise<{ distiller: Record<string, unknown>; created: boolean; enabled: boolean; job: { id: string; enabled: boolean } | null }> {
  const existing = await getDistiller(GITHUB_DISTILLER_KEY);
  let created = false;
  let row: Record<string, unknown>;
  if (!existing) {
    row = await upsertDistiller(
      { ...githubIssuesDistillerDraft(), enabled: !!opts.enable, requester: opts.enable ? (opts.requester ?? opts.actor ?? null) : null },
      opts.actor ?? undefined, opts.source ?? "github-collect");
    created = true;
  } else if (opts.enable && (!existing.enabled || (opts.requester && existing.requester !== opts.requester))) {
    row = await upsertDistiller(
      { key: GITHUB_DISTILLER_KEY, enabled: true, requester: opts.requester ?? existing.requester ?? opts.actor ?? null },
      opts.actor ?? undefined, opts.source ?? "github-collect");
  } else {
    row = existing as unknown as Record<string, unknown>;
  }
  let job: { id: string; enabled: boolean } | null = null;
  if (opts.enable) {
    const j = await upsertCronJob({
      id: GITHUB_DISTILL_JOB_ID, label: "GitHub 이슈·PR 증류", action: "distill_sources_headless",
      params: JSON.stringify({ distiller: GITHUB_DISTILLER_KEY }),
      interval_sec: GITHUB_DISTILL_INTERVAL_SEC, cron_expr: null, enabled: true,
      note: "GitHub 이슈·PR 대화(자료 kind=github_issue)를 지식으로 — 증류기 'github-issues' 전용(#2247).",
      run_once: null, actor: opts.actor ?? null,
    });
    job = { id: String(j.id), enabled: !!j.enabled };
  }
  return { distiller: row, created, enabled: !!(row as { enabled?: boolean }).enabled, job };
}

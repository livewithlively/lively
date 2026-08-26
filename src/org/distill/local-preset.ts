// 내 컴퓨터(로컬 업로드) 자료 증류기 프리셋 (#1881 L3) — "올린 파일이 지식이 되는" 마지막 조각.
//  왜 프리셋인가: 자료가 자료로만 쌓이고 증류기가 0개면 아무것도 지식이 되지 않는다(dev 실측: 증류기 0 · 미증류 560).
//   셀프서브 사용자는 증류기라는 개념을 모른다 — 첫 업로드 때 **꺼진 채로** 만들어 두고(distiller-authoring 함정 ②),
//   온보딩 W6 "이렇게 나눴는데 맞나요?" 승인 때 켠다(ensureLocalFilesDistiller({enable:true})).
//  스코프는 catch-all(match_system='local', 채널 제한 없음 — 함정 ①): 로컬 자료가 어느 증류기에도 안 잡혀 사라지는 일이 없다.
//  판단 단위는 스레드가 아니라 **파일**(thread_aware=false) — 파일 1개가 곧 한 문서다.
import type { DistillerUpsertInput } from "../store/ingest.js";
import { upsertDistiller } from "../store/ingest.js";
import { getDistiller } from "./distiller.js";
import { upsertCronJob } from "../cron-store.js";
import { itemsPool } from "../../db/client.js";

export const LOCAL_DISTILLER_KEY = "local-files";
export const LOCAL_DISTILL_JOB_ID = "distill-local-files";
export const LOCAL_DISTILL_INTERVAL_SEC = 600;

export const LOCAL_CRITERIA_MD = `## 판단 단위 — 파일 하나가 한 문서다
- 자료 1건 = 사람이 자기 컴퓨터에서 올린 파일 1개. 채널(container_name) = 그 파일이 들어 있던 최상위 폴더명.
- 파일 하나를 읽고 **형태부터** 정한 뒤, 그 형태의 규칙대로 지식 0~n건(대개 1건)을 만든다.

## 형태별 규칙 (여기 안 맞으면 지식이 아니다)
1. **위키형 문서**(주제 하나를 설명하는 글 — 규정·정책·가이드·제품 설명·용어 정의): 파일 1개 = 지식 1개. 원문 구조를 보존하되 낡은 머리말·서명·양식 잔해는 뺀다. 상대링크·위키링크는 내부 링크로 정규화한다.
2. **회의록**: 결정·합의·할 일(담당·기한)만 지식으로. 논의 과정·발언 나열은 자료에 남기고 지식엔 결론만. 결정이 하나도 없으면 skip.
3. **보고서·기획·제안서**: 결론(수치·판단·권고)과 그 근거만. 표지·목차·상투 문구는 뺀다.
4. **계약·규정·정책**: 조건·기한·금액·책임 같은 **구속력 있는 문장은 원문 그대로** 인용한다. 요약으로 바꾸지 않는다.
5. **저널·일지·메모 뭉치**(날짜별 기록): 그대로 넣지 않는다. 지속되는 것(결정·규칙·절차·반복되는 사실)만 뽑고, 하루짜리 상태·감상은 skip.
6. **코드 문서**(README·docs·설계 노트): 도메인 설명·의도·운영 절차만. 코드가 진실인 부분(시그니처·설정값 나열)은 복제하지 않는다.
7. **개인 노트가 섞인 파일**: 조직·업무에 쓰이는 부분만 골라낸다. 사생활·개인 재정·건강 같은 내용은 지식에 옮기지 않는다.

## 제외 (지식 아님 → skip)
- 임시 파일·초안 조각·빈 양식·설치/사용 안내(외부 제품 매뉴얼)·광고·뉴스레터·영수증 낱장·스크린샷 노이즈.
- 본문이 '[BINARY]' 로 시작하는 자료: filename·mime·size·채널로 볼 가치를 먼저 판단한다. PDF·이미지는 가치가 보이면 source_artifact(source_id)로 원본을 받아 Read 한다(스캔본·한글 PDF 정상). 스텁에 "읽을 수 없는 형식" 또는 "추출 실패" 라고 적혀 있으면 fetch 하지 말고 skip 하되, 실행 요약에 그 안내 문장(예: "hwp 파일은 pdf 로 저장해 다시 올리면 읽습니다")을 남긴다.
- 본문 꼬리에 "[… 앞 N자까지만 실었습니다 — 전문은 …]" 가 있으면 잘린 문서다. 앞부분만으로 판단이 서면 만들고, 안 서면 skip 하고 요약에 "긴 문서 — 나눠 올려 주세요" 를 남긴다.

## 판정은 절대 기준으로 (백분위·상위 N% 금지)
아래 신호가 **하나라도** 있으면 지식 후보다. 없으면 skip:
- 결정·합의·규칙·기준값·기한·담당이 문장으로 적혀 있다.
- 절차(순서가 있는 단계)나 체크리스트가 있다.
- 조직 고유 사실(제품·고객·가격·계약 조건·연락처가 아닌 업무 규약)이 적혀 있다.
- 키워드가 없어도 **문제 → 조치 → 결과** 로 닫히는 구조가 있다.
애매하면 버리지 말고 저장한다 — 검토 여부는 조직의 인입 허용선 정책이 정한다. **lifecycle 을 직접 지정하지 마라.**

## 개인 폴더 자료 (머리글에 "개인 폴더(올린 사람만 봄)" 이 붙은 것)
그 자료는 **올린 사람만 보는 자료**다. 조직 전체가 보는 기존 지식에 **합치지 마라** — 합치는 순간 그 문서가 올린 사람 전용으로 잠겨 다른 사람 화면에서 사라진다(공개범위는 자료↔지식 링크를 따라 좁아지기만 한다).
- 이미 조직 지식이 그 내용을 담고 있으면 **skip** 하고, 요약에 "이미 조직 지식에 있음(<지식 이름>)" 을 남긴다.
- 조직 지식에 없는 내용이면 **새 지식으로** 만든다(그 지식도 올린 사람만 보게 된다 — 그게 맞다).
- 개인 자료 여러 건끼리 묶는 것은 괜찮다. 조직 지식과 섞지만 마라.

## 중복 방지 규약
- 저장 전 knowledge_similar 로 확인한다. 같은 주제가 있으면 새로 만들지 말고 **그 지식을 같은 name 으로 갱신**한다(knowledge_save mode='edit' 또는 append).
- 같은 파일을 다시 올린 경우(자료 갱신)는 기존 지식을 갱신한다 — 새 name 은 수정이 아니라 중복 생성이다.
- 자료 링크 없는 지식을 만들지 마라. 만든 지식마다 source_link_knowledge(derived_from) 를 건다.
- 배치를 서브에이전트로 쪼개지 마라.
`;

export const LOCAL_FORMAT_MD = `- **제목**: 무엇이 정해졌는지 / 무엇을 설명하는지가 제목만 읽어도 보이게. 파일명을 그대로 제목으로 쓰지 말고, 날짜·버전은 제목에 넣지 않는다.
- **name(슬러그)**: 영문 소문자·숫자·하이픈. 같은 주제를 갱신할 땐 기존 name 을 그대로 쓴다.
- **섹션**: 배경 → 내용(규정이면 조항 그대로 / 회의록이면 결정·할 일 / 보고서면 결론·근거) → 후속조치 → 출처. 해당 없는 섹션은 통째로 뺀다(빈 섹션 금지).
- **인용**: 조건·기한·금액·기준값은 원문 표현 그대로. 추론한 것은 "…로 보인다" 로 표시해 사실과 구분한다. 원문에 없는 내용은 쓰지 않는다.
- **출처**: 본문 끝에 "출처: <폴더>/<파일명> (수정일)" 한 줄. ⚠ 자료 id 를 본문에 나열하지 마라 — 자료↔지식 관계는 source_link_knowledge 링크가 정본이다.
- 개인정보: 사람은 표시 이름까지만. 주민번호·계좌·전화·주소는 마스킹한다.
`;

export function localFilesDistillerDraft(): DistillerUpsertInput {
  return {
    key: LOCAL_DISTILLER_KEY,
    label: "내 컴퓨터 자료",
    enabled: false,
    priority: -10,               // catch-all — 같은 local 자료를 더 좁게 집는 증류기가 생기면 그쪽이 먼저 배정된다
    match_kinds: ["local_file"],
    match_system: "local",
    include_channels: null, exclude_channels: null, include_authors: null, exclude_authors: null,
    exclude_bots: false,
    min_chars: 0,
    lookback_days: null,
    criteria_md: LOCAL_CRITERIA_MD,
    format_md: LOCAL_FORMAT_MD,
    target_category: null,
    default_type: null,
    name_prefix: null,
    thread_aware: false,
    prefilter_level: 0,          // 파일은 스레드가 아니다 — 길이·참여자 축의 사전필터는 문서에 맞지 않는다(유실만 난다)
    prefilter_rules: null,
    batch_size: 5,               // 파일 5개씩 — 문서는 스레드보다 길다
    batch_max_msgs: 5,
    mode: "headless",
    note: "내 컴퓨터에서 올린 파일(자료 kind=local_file)을 지식으로. 첫 업로드 때 꺼진 채로 만들어지고, 온보딩 표본 승인 때 켜진다(#1881 L3).",
  };
}

export interface EnsureLocalDistillerOpts {
  /** 만든/켠 사람(감사·created_by). */
  actor?: string | null;
  /** true 면 켜고(없으면 만들고) 크론 잡까지 등록한다. false/미지정 = 없을 때만 꺼진 채로 만든다. */
  enable?: boolean;
  /** 헤드리스 실행 신원(그 멤버의 클로드 로그인·과금 귀속). 켤 때 없으면 actor. */
  requester?: string | null;
  source?: string;
}

export async function ensureLocalFilesDistiller(opts: EnsureLocalDistillerOpts = {})
  : Promise<{ distiller: Record<string, unknown>; created: boolean; enabled: boolean; job: { id: string; enabled: boolean } | null }> {
  const existing = await getDistiller(LOCAL_DISTILLER_KEY);
  let created = false;
  let row: Record<string, unknown>;
  if (!existing) {
    row = await upsertDistiller(
      { ...localFilesDistillerDraft(), enabled: !!opts.enable, requester: opts.enable ? (opts.requester ?? opts.actor ?? null) : null },
      opts.actor ?? undefined, opts.source ?? "local-ingest");
    created = true;
  } else if (opts.enable && (!existing.enabled || (opts.requester && existing.requester !== opts.requester))) {
    // 부분 갱신 — 기준·형식·스코프는 사람이 손봤을 수 있으니 건드리지 않고 켜기만.
    row = await upsertDistiller(
      { key: LOCAL_DISTILLER_KEY, enabled: true, requester: opts.requester ?? existing.requester ?? opts.actor ?? null },
      opts.actor ?? undefined, opts.source ?? "local-ingest");
  } else {
    row = existing as unknown as Record<string, unknown>;
  }

  let job: { id: string; enabled: boolean } | null = null;
  if (opts.enable) {
    // 켜짐 = 실제로 돈다 — 증류기별 헤드리스 잡을 같이 둔다(잡이 없으면 초록불인데 아무것도 안 도는 상태가 된다).
    const j = await upsertCronJob({
      id: LOCAL_DISTILL_JOB_ID, label: "내 컴퓨터 자료 증류", action: "distill_sources_headless",
      params: JSON.stringify({ distiller: LOCAL_DISTILLER_KEY }),
      interval_sec: LOCAL_DISTILL_INTERVAL_SEC, cron_expr: null, enabled: true,
      note: "올린 파일(자료 kind=local_file)을 지식으로 — 증류기 'local-files' 전용. 온보딩 승인 때 등록됨(#1881 L3).",
      run_once: null, actor: opts.actor ?? null,
    });
    job = { id: String(j.id), enabled: !!j.enabled };
  } else {
    try {
      const r = await itemsPool.query(`SELECT id, enabled FROM org_cron WHERE id=$1`, [LOCAL_DISTILL_JOB_ID]);
      if (r.rows[0]) job = { id: r.rows[0].id, enabled: !!r.rows[0].enabled };
    } catch { /* org_cron 미생성 — 무시 */ }
  }
  return { distiller: row, created, enabled: !!row.enabled, job };
}

// 첫 업로드 때 한 번만(프로세스당) — 실패해도 업로드·자료 등록엔 영향 없다.
let ensuredOnce: Promise<void> | null = null;
export function ensureLocalFilesDistillerOnce(actor?: string | null): Promise<void> {
  if (!ensuredOnce) {
    ensuredOnce = ensureLocalFilesDistiller({ actor: actor ?? null, enable: false })
      .then(() => undefined)
      .catch((e) => { ensuredOnce = null; console.warn(`[local-ingest] 증류기 프리셋 준비 실패: ${(e as Error)?.message ?? e}`); });
  }
  return ensuredOnce;
}

// 훅 주입 가시화(V4-P5 J절) — 설치된 세션 훅들이 각자 실제로 무엇을 세션 컨텍스트에 주입하는지를
//  최종 주입 메시지로 렌더한다(비개발자가 "AI 가 무엇을 받는지"를 웹에서 확인). 읽기 전용.
//
// 충실도(fidelity) 정직성:
//  - 'exact'      : 게이트웨이가 단일 출처인 부분(드리프트 없음).
//  - 'approximate': 훅이 멤버 머신에서 세션마다 동적으로 덧붙이는 부분(라이브 현황 등)은 서버가 재현 불가 —
//                   재현 가능한 부분만 보여주고 차이를 note 로 명시한다.
//
// 드리프트 방지: 게이트웨이가 소스인 부분(세션 시작 org-context)은 previewMemberContext 단일 함수를 호출
//  (텍스트 복붙 금지 — /api/ui/org/preview 와 byte-identical). Stop 너지문은 #270 이후 게이트웨이가 라이브
//  단일소스다 — 어드민 오버라이드 || DEFAULT_WRITEBACK_NOTICE(설치 .mjs 의 REASON 은 last-resort 스텁이라
//  미리보기 대상 아님). 모든 메시지는 redactString choke-point 통과.
import { redactString } from "../ingest/redact.js";
import { previewMemberContext } from "./publish.js";
import { getOrgProfile, getRuntimeConfig } from "../store.js";
import { DEFAULT_WRITEBACK_NOTICE } from "./hook-defaults.js";

export interface HookPreview {
  id: string;
  title: string;
  event: string;
  message: string;          // 이 훅이 세션 컨텍스트에 주입하는 최종 메시지(redact 통과). 미주입이면 "".
  fidelity: "exact" | "approximate";
  source: string;           // 메시지의 출처(드리프트 추적용): 게이트웨이 함수 또는 서버 단일소스.
}

// 3개 설치 훅의 최종 주입 메시지 미리보기. session-preload·work-flag·stop-writeback-gate.
//  memberId(#1291) — 이 화면은 "**내** AI 가 무엇을 받나"를 보여주는 자리다. 주는 사람의 신원으로 렌더해야
//  미리보기가 실제 주입과 같아지고(fidelity=exact 의 전제), 남의 시야로 잠긴 지식이 이 화면을 통해 새지 않는다.
//  미지정이면 previewMemberContext 가 공개 맥락만 담는다(멤버 무관 미리보기).
export async function previewHooks(memberId?: string): Promise<{ hooks: HookPreview[] }> {
  const p = await getOrgProfile();
  const orgName = p.display_name?.trim() || p.name?.trim() || "조직";

  // ── 1) session-preload (SessionStart) — 세션 첫머리 org-context 주입. ──
  //  게이트웨이 단일 출처: previewMemberContext(= /api/ui/org/preview = buildKnowledgeIndex). 드리프트 0.
  //  멤버 훅은 이 정적 org-context 만 주입한다(구 [라이브 현황] 동적 블록은 v6 컷오버로 폐기 — ~/.lively/hooks/session-preload.mjs:114).
  //  쓰기가이드는 정적 컨텍스트(buildKnowledgeIndex)에 이미 포함이라 동적 아님. → 동적 부분이 없어 미리보기 = 실제 주입과 byte-identical. fidelity=exact.
  let preloadMsg: string;
  let preloadFidelity: HookPreview["fidelity"];
  try {
    const ctx = await previewMemberContext(orgName, memberId);
    preloadMsg =
      ctx.trimEnd() +
      "\n\n— 위 org-context 가 게이트웨이가 매 세션 주입하는 전부입니다(이 미리보기와 byte-identical).\n" +
      "  멤버 훅(session-preload)은 이 정적 org-context 만 주입합니다.";
    preloadFidelity = "exact";
  } catch {
    preloadMsg = "(org-context 미리보기를 불러오지 못했습니다)";
    preloadFidelity = "approximate";
  }
  const preload: HookPreview = {
    id: "session-preload",
    title: "세션 시작 org-context 주입",
    event: "SessionStart",
    message: redactString(preloadMsg),
    fidelity: preloadFidelity,
    source: "gateway:previewMemberContext (=/api/ui/org/preview)",
  };

  // ── 2) work-flag (PostToolUse) — 세션 플래그만 기록, 컨텍스트 주입 없음. ──
  //  도구 사용 후 디스크 플래그(.worked/.writeback/.lively)만 남기고 stdout 으로 컨텍스트를 내보내지 않는다.
  //  → 주입 메시지 없음(provably empty). fidelity=exact.
  const workFlag: HookPreview = {
    id: "work-flag",
    title: "작업 플래그 기록(주입 없음)",
    event: "PostToolUse",
    message: "",
    fidelity: "exact",
    source: "(주입 없음 — 세션 플래그만 디스크에 기록)",
  };

  // ── 3) stop-writeback-gate (Stop) — '작업했으나 기록 안 한' 세션 종료 시 1회 너지. ──
  //  실제 훅 로직 = readHooksConfig()?.writeback_notice || REASON(스텁). 게이트웨이 runtime-config 가 '유효 너지'
  //  (어드민 오버라이드 || 서버 단일소스 DEFAULT_WRITEBACK_NOTICE)를 매 세션 서빙 → session-preload 가
  //  hooks-config.json 에 기록 → 게이트가 그대로 emit. 즉 무오버라이드 기본값 = DEFAULT_WRITEBACK_NOTICE 이고
  //  미리보기도 이 effective 값을 그대로 보여줘 드리프트 0(설치 .mjs 의 REASON 스텁은 게이트웨이 영영 불가 시의 last-resort 라 미대상).
  const rc = await getRuntimeConfig().catch(() => null);
  const override = rc?.writeback_notice?.trim() ? rc.writeback_notice.trim() : null;
  const reason = override ?? DEFAULT_WRITEBACK_NOTICE;
  const stop: HookPreview = {
    id: "stop-writeback-gate",
    title: "종료 시 기록 너지(조건부 1회)",
    event: "Stop",
    // 조건(lively work 세션 · 파일작업 O · 기록 X · 세션당 1회) 충족 시에만 아래 reason 이 주입된다.
    message: redactString(reason),
    fidelity: "exact",
    source: override
      ? "gateway:runtime-config (writeback_notice 오버라이드 — 어드민 설정값)"
      : "gateway:hook-defaults DEFAULT_WRITEBACK_NOTICE (서버 단일소스 — runtime-config 가 매 세션 라이브 서빙)",
  };

  return { hooks: [preload, workFlag, stop] };
}

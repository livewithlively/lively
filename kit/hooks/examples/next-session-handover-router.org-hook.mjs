#!/usr/bin/env node
// UserPromptSubmit 훅: 다음 세션 핸드오버 준비 의도를 감지하면 next-session-handover 스킬을
// invoke하도록 리마인더 주입(soft). 스킬에 비자명 점이 박혀 있어(핸드오버는 scratchpad 아닌
// 영속 경로에 저장, 파일경로 참조 방식, cmd line -n 세션명 자동생성 격리 함정 회피) 모델
// 재량 매칭만으론 멀티스텝 중 누락될 수 있다 → 결정론적 트리거로 보강.

// "다시 시작"은 단독이면 앱/작업 재시작과 혼동 → 세션 토큰 동반 시만. 나머지는 명확 구절.
const TRIGGER = /(새\s*세션|new\s+session|세션\s*(준비|넘겨|인계|핸드오버|이어)|이어서.*세션|세션.*이어서|핸드오버|hand[\s-]?over|(다시\s*시작|재시작).*세션|세션.*(다시\s*시작|재시작))/i;

let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const raw = (data.prompt || "").trim();
    if (!raw) return;
    // 작업 끝 알림·하위 에이전트 보고 같은 하네스 주입 메시지는 사람의 의도가 아니다(러너가 kit/hooks/prompt-origin.mjs 로 판정해 싣는다).
    //  하위 에이전트 보고 본문엔 "delegated to" 같은 낱말이 늘 들어 있어, 이 표시 없이는 보고마다 안내가 주입됐다.
    if (data.lively_prompt_injected) return;
    if (!TRIGGER.test(raw)) return;

    const ctx =
      "다음 세션 핸드오버 준비 요청일 수 있음. **`next-session-handover` 스킬을 invoke**할 것. " +
      "핵심(스킬에 상세): ① 핸드오버 파일은 세션 격리된 scratchpad가 아니라 **영속 경로**(`$HANDOVER_DIR`, 미설정 시 `~/.claude/handovers`)에 저장 — " +
      "새 세션이 못 읽으면 무의미. ② 새 세션 시작 명령은 핸드오버를 **파일경로 참조**로 넘긴다(인라인 `$(cat)` 금지). " +
      "③ 세션명은 사용자가 주면 그대로, 안 주면 작업 주제 기반 이름을 지어 `claude -n` 인자로(cmd line -n은 자동생성 격리 함정 회피). (무관하면 무시)";

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: ctx,
      },
    }));
  } catch (e) {
    // Silent fail — never block the prompt on router error.
  }
});

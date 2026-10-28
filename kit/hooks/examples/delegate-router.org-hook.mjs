#!/usr/bin/env node
// UserPromptSubmit 훅: 무거운 1회성 작업의 위탁/위임 의도를 감지하면 delegate-heavy-work 스킬을
// invoke 하도록 리마인더 주입(soft). delegate_run MCP 는 기본 비활성이라 모델이 위탁하려
// 툴을 찾아도 없어 막다른 길이 되기 쉽다 — 정답 경로(lively delegate CLI 를 Bash run_in_background 로)를
// 그 순간에 알려준다. 스킬에 비자명 함정(--detach 금물 · --help 가 실제 위탁 생성 · --repo 소스등록 전제)이
// 박혀 있어 모델 재량 매칭만으론 누락된다 → 결정론적 트리거로 보강.

const TRIGGER = /위탁|위임|delegate|오프로드|offload|워커(에|로|가|한테| ).{0,10}(돌려|실행|맡|보내)|무거운.{0,14}(빌드|테스트|스크립트|작업).{0,14}(위탁|위임|워커|노드|오프로드|돌려)|풀빌드.{0,10}(위탁|위임|워커|노드)|로컬.{0,8}(리소스|자원).{0,8}부족/i;

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
      "무거운 1회성 작업의 위탁/위임 의도일 수 있음. **`delegate-heavy-work` 스킬을 invoke**할 것. " +
      "핵심(스킬에 상세): ① `lively delegate \"<작업>\"` 를 **Bash(run_in_background=true)** 로 실행한다 — " +
      "MCP `delegate_run` 동기 wait 는 하네스 인라인 블로킹이라 긴 위탁에서 transport 가 끊겨 응답을 잃는다" +
      "(서버측 작업은 완주하지만 결과 회수 실패). 그래서 delegate_run 은 기본 비활성이고 생성 경로는 CLI 뿐. " +
      "② **`--detach` 금물** — 번호만 반환하고 종료해 결과를 못 받는다. " +
      "③ 완료 시 task-notification → output 파일을 Read 로 수령. (무관하면 무시)";

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

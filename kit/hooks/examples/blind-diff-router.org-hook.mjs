#!/usr/bin/env node
// UserPromptSubmit 훅: 코드 diff만으로 기능을 유추시키는 블라인드 검증 의도를 감지하면
// blind-diff-review 스킬을 invoke하도록 리마인더 주입. 스킬에 three-dot diff(stale-base 아티팩트
// 회피)·subagent 격리(커밋메시지 누출 방지) 같은 비자명 함정이 박혀 있어, 모델 재량 매칭으로
// 누락되면 거짓 결과가 난다 → 결정론적 트리거로 보강.

// 블라인드/코드-only 의도 토큰
const BLIND = /(blind|블라인드|코드\s*변경만|코드만\s*(읽|보)|diff\s*만|self.?document|커밋\s*메시지.*없이|description.*(없이|주지))/i;
// diff/MR/코드 추론 맥락
const CTX = /(diff|mr|merge request|머지\s*리퀘|커밋|코드|기능\s*유추|기능\s*추론|유추|추론)/i;

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
    if (!BLIND.test(raw) || !CTX.test(raw)) return;

    const ctx =
      "코드 diff만으로 기능을 유추시키는 블라인드 검증 요청일 수 있음. **`blind-diff-review` 스킬을 invoke**할 것. " +
      "핵심 함정 두 가지(스킬에 상세): ① diff는 **merge-base(three-dot) `git diff <target>...HEAD`** 로 뽑는다 — " +
      "two-dot `git diff <target>` 쓰면 브랜치가 뒤처질 때 target 신규 커밋이 역방향으로 섞여 거짓 발견을 유발. " +
      "② subagent는 **diff 파일 1개만**, git/repo/위키/웹 접근 금지(커밋 메시지 누출 방지), diff는 repo 밖에 둔다. (무관하면 무시)";

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

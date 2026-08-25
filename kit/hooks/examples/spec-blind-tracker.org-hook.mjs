#!/usr/bin/env node
// PostToolUse 훅: 테스트 작성 스킬이 이 세션에서 invoke되면 세션 마커를 남긴다.
// ⚠ 스킬 id 를 하나로 못 박지 않는다 — 조직은 spec-blind-test(기본) 또는 그 경량 대안
//   spec-failfirst-test 중 하나를 켠다. 여기에 한 id 만 적으면, 다른 쪽을 켠 조직은
//   guard 를 풀 방법이 없어 테스트 파일 작성이 영구 차단된다(#1069).
// spec-blind-guard.js가 이 마커로 "이 세션에서 테스트 작성 전 spec-blind 절차를 의식했나"를 판정.
// 같은 짝(guard/tracker) 철학: 스킬 발동은 모델 재량(description 매칭)이라 멀티스텝 중
// 누락될 수 있음 → 액션 경계(테스트 파일 Write)에서 결정론적 게이트로 보강.
// 마커를 "스킬 invoke" 시점에 잡는 이유: spec-blind는 test-writer subagent가 general-purpose라
// subagent_type으로 구분 불가(diff-reviewer처럼 고유 타입 없음). 스킬 진입이 유일한 결정론 신호.
//
// ── 하네스 패리티(#1884) ──
//  claude 만 `Skill` 툴이 있다. codex 는 스킬을 프롬프트에 인라인하거나 모델이 SKILL.md 를 **셸로 읽는다**
//  (Skill 툴 호출이 없다 — #1475 §3 이 guard 만 열면 코덱스 사용자가 해제 경로 없이 막힌다고 짚은 자리).
//  그래서 해제 신호를 셋으로 둔다 — ① claude Skill 툴(tool_input.skill) ② opencode `skill` 툴(소문자, 입력 어딘가에 스킬명)
//  ③ 셸 명령이 그 스킬의 SKILL.md 를 읽음(`…/spec-blind-test/SKILL.md`). guard 의 deny 문구가 ③을 안내한다.
//  matcher 는 `Skill|skill|Bash|bash` — 셸 호출마다 이 작은 스크립트가 한 번 더 돌지만(수십 ms), 러너는 어차피
//  PostToolUse .* 로 뜬다.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 어느 쪽을 켜 뒀든 해제된다. 새 테스트 스킬을 추가하면 여기에 id 를 더한다.
const UNLOCK_SKILLS = ["spec-blind-test", "spec-failfirst-test"];
const SKILL_FILE_RE = new RegExp(`(?:^|[\\\\/])(?:${UNLOCK_SKILLS.join("|")})[\\\\/]SKILL\\.md\\b`);

function unlocked(toolName, ti) {
  const t = String(toolName || "");
  if (t === "Skill") return UNLOCK_SKILLS.includes(String(ti.skill || ""));                       // claude
  if (t === "skill") return UNLOCK_SKILLS.some((s) => JSON.stringify(ti).includes(`"${s}"`));   // opencode(입력 형태 미확정 — 넓게)
  if (/^(Bash|bash|shell|exec_command)$/.test(t)) {                                              // codex·opencode 셸: SKILL.md 읽기
    const cmd = Array.isArray(ti.command) ? ti.command.join(" ") : String(ti.command || ti.cmd || "");
    return SKILL_FILE_RE.test(cmd);
  }
  return false;
}

let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    if (!unlocked(data.tool_name, data.tool_input || {})) return;

    const sid = data.session_id || "no-session";
    const dir = path.join(os.homedir(), ".claude", ".cache", "spec-blind");   // guard 와 같은 자리(하네스 무관)
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sid), String(Date.now()));
  } catch (e) {
    // Silent fail — 트래커 오류로 액션을 막지 않는다.
  }
});

#!/usr/bin/env node
// PreToolUse 훅: 테스트 파일(*Test.kt, *.spec.ts, test_*.py 등)을 Write/Edit하기 직전,
// 이 세션에서 spec-blind-test 스킬이 발동되지 않았으면 차단.
// spec-blind-test는 모델 재량(description 매칭)으로만 발동돼 멀티스텝 작업 중 누락된다
// (2026-06-24 실제 누락: 구현 보며 인라인 작성 → tautological 위험 + 테스트가 컴파일조차
//  안 되는 걸 늦게 발견). 짝(guard/tracker) 패턴 — 액션 경계에서 결정론적 게이트.
//
// 해소 2경로(deny 메시지에 안내):
//  1) 비자명 로직 테스트 → spec-blind-test 스킬 invoke(tracker가 마커 기록) → 통과.
//  2) 사소 변경(typo·rename·포맷·자명) → 안내된 ack 명령 1회 실행 → 세션 통과.
// 세션 단위 단일 마커: 첫 테스트 Write에서 한 번 의식하면 이후 통과.
//
// ── 하네스 패리티(#1884) ──
//  편집이 하네스마다 다른 얼굴로 온다. 툴명 하나에 묶으면 다른 하네스에선 게이트가 **조용히 없다**.
//   · claude   : Write / Edit / MultiEdit (tool_input.file_path·content·new_string)
//   · codex    : apply_patch **툴**(gpt-5.4 계열 — tool_input.command 가 패치 본문) 또는
//                셸 명령 `apply_patch <<'EOF' …`(gpt-5.6 계열 — tool_name=Bash, 0.149.1 실측). 패치 본문의
//                `*** Add File:`=Write · `*** Update File:`=Edit 로 번역하고 추가 텍스트는 `+` 줄이다.
//   · opencode : edit / write (소문자, tool_input.filePath·content·newString)
//  deny 출력엔 hookSpecificOutput.hookEventName 이 **필수**다 — codex 는 그게 없으면 출력을 통째로 무시하고
//  툴을 실행한다(fail-open, 0.149.1 실측). claude 는 관대하지만 계약은 엄격한 쪽에 맞춘다.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 테스트 파일 판정 — 프로덕션 코드(섞임) 오탐 줄이려 보수적으로.
function isTestFile(fp) {
  if (!fp) return false;
  const f = String(fp);
  if (/(Test|Tests|IT|Spec)\.(kt|java|scala)$/.test(f)) return true;       // JVM
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) return true;        // JS/TS
  if (/(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f)) return true;             // Python
  if (/\.spec\.(rb)$|_spec\.rb$/.test(f)) return true;                        // Ruby
  return false;
}

// 테스트 "로직"(케이스·단언)을 새로 도입하는 편집인가 — 게이트의 진짜 대상.
// tautological 위험은 새 테스트 케이스/단언을 구현 보며 인라인 작성할 때 생긴다.
// import 추가·mockk `every{}` 스텁 등록·rename·포맷 같은 기계적/compat 편집은 로직을 안 만든다
// → 게이트할 필요 없음(첫 테스트 편집이 하필 기계적 편집이면 불필요한 ack 낭비 + 그 ack가
//   세션 전체 게이트를 무력화해 정작 뒤의 진짜 테스트 작성이 안 걸리는 구멍이 생겼다).
// 단언/케이스 신호가 추가 텍스트에 있을 때만 authoring으로 본다. mockk `every{`(스텁 셋업)는
// 제외하되 `verify`(검증)는 포함. Write(신규/전면덮어쓰기 테스트파일)는 authoring으로 간주.
const TEST_LOGIC_SIGNAL =
  /@Test\b|@ParameterizedTest\b|@RepeatedTest\b|fun `|\bit\(|\bdescribe\(|\bcontext\(|\btest\(|\bassert[A-Za-z]*\b|\bassert |shouldBe\b|shouldNotBe\b|shouldThrow|shouldContain|shouldHave|\bverify\s*[({]|\bexpect\(|\.to(Be|Equal|Throw|Contain|Match|Have)|assert_/;

// 하네스별 편집 툴 호출 → 공통 형태 [{ kind: "write"|"edit", file, added }] 로 정규화. 편집이 아니면 [].
function normalizeEdits(toolName, ti) {
  const t = String(toolName || "");
  if (t === "Write") return [{ kind: "write", file: ti.file_path, added: String(ti.content || "") }];
  if (t === "Edit") return [{ kind: "edit", file: ti.file_path, added: String(ti.new_string || "") }];
  if (t === "MultiEdit") {
    const edits = Array.isArray(ti.edits) ? ti.edits : [];
    return [{ kind: "edit", file: ti.file_path, added: edits.map((e) => String(e.new_string || "")).join("\n") }];
  }
  if (t === "write") return [{ kind: "write", file: ti.filePath || ti.file_path, added: String(ti.content || "") }];   // opencode
  if (t === "edit") return [{ kind: "edit", file: ti.filePath || ti.file_path, added: String(ti.newString || ti.new_string || "") }];
  // codex — apply_patch 툴(패치 본문이 command) 또는 셸 `apply_patch <<'EOF' … EOF`
  let patch = null;
  if (t === "apply_patch") patch = String(ti.command || ti.input || ti.patch || "");
  else if (/^(Bash|bash|shell|exec_command)$/.test(t)) {
    const cmd = Array.isArray(ti.command) ? ti.command.join(" ") : String(ti.command || ti.cmd || "");
    if (/^\s*apply_patch\b/.test(cmd)) patch = cmd;
  }
  if (patch === null) return [];
  return parsePatch(patch);
}

// codex 패치 형식(*** Begin Patch / *** Add File: p / *** Update File: p / *** Delete File: p / *** End Patch).
function parsePatch(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split("\n")) {
    const add = /^\*\*\* Add File: (.+)$/.exec(line);
    const upd = /^\*\*\* Update File: (.+)$/.exec(line);
    const del = /^\*\*\* Delete File: (.+)$/.exec(line);
    if (add || upd || del) {
      if (cur) out.push(cur);
      cur = add ? { kind: "write", file: add[1].trim(), added: "" }
        : upd ? { kind: "edit", file: upd[1].trim(), added: "" }
        : null;                                   // Delete 는 게이트 대상 아님
      continue;
    }
    if (cur && line.startsWith("+")) cur.added += line.slice(1) + "\n";
  }
  if (cur) out.push(cur);
  return out;
}

// 게이트 대상 편집인가. write=신규 테스트파일 작성이라 항상 대상. edit=추가 텍스트에
// 단언/케이스 신호가 있을 때만 대상(기계적 편집은 통과).
function editAuthorsTestLogic(e) {
  if (e.kind === "write") return true;
  return TEST_LOGIC_SIGNAL.test(e.added);
}

let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const edits = normalizeEdits(data.tool_name, data.tool_input || {});
    // 테스트 파일에 테스트 로직(케이스·단언)을 새로 도입하는 편집만 게이트. 기계적/compat 편집(import·스텁·rename)은
    // 통과시켜 불필요한 ack 낭비를 없앤다(마커도 안 건드리므로 이후 진짜 테스트 작성은 정상 게이트됨).
    const hit = edits.find((e) => isTestFile(e.file) && editAuthorsTestLogic(e));
    if (!hit) return; // 편집 아님 · 테스트 파일 아님 · 기계적 편집 → silent allow

    const sid = data.session_id || "no-session";
    const dir = path.join(os.homedir(), ".claude", ".cache", "spec-blind");   // 경로는 하네스 무관(호환 유지 — 옮기면 ack 안내가 어긋난다)
    const marker = path.join(dir, sid);
    if (fs.existsSync(marker)) return; // 이 세션에서 의식함 → 통과

    const ackCmd = `mkdir -p "${dir}" && touch "${marker}"`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "테스트 파일을 작성/수정하기 전 **테스트 작성 방식을 의식**하세요 (이 세션 첫 테스트 Write). " +
          "구현을 보며 쓰면 구현을 그대로 재진술하는(tautological) 테스트가 되고, 그건 통과하면서 아무것도 못 잡습니다. " +
          "요구사항은 둘입니다 — ① 사양의 **엣지를 빠짐없이** 시나리오로 만들 것(빠뜨린 엣지가 곧 못 잡는 버그입니다) " +
          "② **fail-first**: 수정 전 코드나 mutation 으로 그 테스트가 **실제로 빨간불이 되는 걸 먼저 눈으로 볼 것**. " +
          "비자명 로직(분기·루프·파서·금액/보안·도메인 룰)이면 **조직이 켜 둔 테스트 작성 스킬을 invoke**하세요 " +
          "(`spec-blind-test` 또는 경량판 `spec-failfirst-test` — 사용 가능한 쪽. Skill 툴이 없는 하네스(codex 등)에선 " +
          "그 스킬의 SKILL.md 를 읽는 것이 곧 invoke 로 인정됩니다). " +
          "사소 변경(typo·rename·포맷·자명)이면 다음을 1회 실행해 세션을 풀고 진행하세요: " +
          "`" + ackCmd + "`",
      },
    }));
  } catch (e) {
    // Silent fail — 훅 오류로 액션을 막지 않는다.
  }
});

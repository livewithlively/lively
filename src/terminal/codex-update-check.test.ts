// codex 시작 업데이트 검사 끄기 — 값 표 (#4135 후속)
//
//  사양·엣지 표: 스크래치 spec-updatecheck.md. 행마다 시나리오 하나.
//  ★ 이 표가 지키는 경계는 둘이다:
//   ① 키는 **첫 테이블보다 먼저** 있어야 한다 — 뒤에 두면 TOML 이 그 테이블 키로 읽어 검사가 그대로 돈다(실측).
//   ② 사람이 적어 둔 값은 **덮지 않는다** — 업데이트 알림을 보겠다는 선택도 사람의 것이다.
//  red 는 mutation 셋으로 눈으로 봤다(멱등 제거 · 앞이 아니라 뒤에 붙이기 · 주석줄도 「있다」로 세기).
import assert from "node:assert/strict";
import { planCodexUpdateCheckOff, CODEX_UPDATE_CHECK_KEY } from "./codex-update-check.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const txt = (p: ReturnType<typeof planCodexUpdateCheckOff>): string => (p.write ? p.text : "");

t("[1] 파일이 없으면 키줄 하나를 만든다(개행으로 끝난다)", () => {
  const p = planCodexUpdateCheckOff(null);
  assert.equal(p.write, true);
  assert.match(txt(p), new RegExp(`^${CODEX_UPDATE_CHECK_KEY} = false`));
  assert.ok(txt(p).endsWith("\n"));
});

t("[2] 빈 파일도 같다", () => assert.equal(planCodexUpdateCheckOff("").write, true));

t("[3] 사람의 설정은 한 글자도 안 건드리고 **뒤에** 그대로 둔다", () => {
  const keep = 'model = "gpt-5.6-terra"\n\n[mcp_servers.lively]\ncommand = "lively"\n';
  const out = txt(planCodexUpdateCheckOff(keep));
  assert.ok(out.endsWith(keep), "원문이 끝에 그대로 있어야 한다");
  assert.equal(out.indexOf(keep), out.length - keep.length);
});

t("[4] ★ 키는 첫 테이블보다 **먼저** 온다 — 뒤에 두면 그 테이블 키가 되어 검사가 돈다(실측)", () => {
  const cfg = '[projects."/work/shared/project/4354"]\ntrust_level = "trusted"\n';
  const out = txt(planCodexUpdateCheckOff(cfg));
  assert.ok(out.indexOf(CODEX_UPDATE_CHECK_KEY) < out.indexOf("[projects"), "키가 테이블보다 앞이어야 한다");
});

t("[5] 이미 루트에 있으면 아무것도 쓰지 않는다(멱등 — 매 세션 파일을 건드리지 않는다)", () => {
  assert.deepEqual(planCodexUpdateCheckOff(`${CODEX_UPDATE_CHECK_KEY} = false\nmodel = "x"\n`), { write: false });
});

t("[6] ★ 사람이 true 로 켜 뒀으면 덮지 않는다 — 알림을 보겠다는 선택도 사람의 것이다", () => {
  assert.deepEqual(planCodexUpdateCheckOff(`${CODEX_UPDATE_CHECK_KEY} = true\n`), { write: false });
});

t("[7] 주석은 설정이 아니다 — 주석뿐이면 심는다", () => {
  assert.equal(planCodexUpdateCheckOff(`# ${CODEX_UPDATE_CHECK_KEY} = false\n[a]\nb = 1\n`).write, true);
});

t("[8] 공백·끝개행이 달라도 **같은 키**로 본다(두 번 심지 않는다)", () => {
  assert.deepEqual(planCodexUpdateCheckOff(`  ${CODEX_UPDATE_CHECK_KEY}=false`), { write: false });
});

t("[9] 끝 개행이 없던 파일도 개행으로 끝나게 만든다(원문 보존)", () => {
  const out = txt(planCodexUpdateCheckOff('model = "x"'));
  assert.ok(out.endsWith('model = "x"\n'), "원문 뒤에 개행을 붙인다");
  assert.ok(out.startsWith(`${CODEX_UPDATE_CHECK_KEY} = false`));
});

t("[10] 여러줄 문자열 안의 그 글자도 «있다» 로 본다 — 보수적(무해한 실패 방향: 창이 떠도 Escape 층이 받는다)", () => {
  assert.deepEqual(planCodexUpdateCheckOff(`desc = """\n${CODEX_UPDATE_CHECK_KEY} = false\n"""\n`), { write: false });
});

console.log(`\n${pass} tests passed`);

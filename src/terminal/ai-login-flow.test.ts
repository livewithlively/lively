// AI 로그인 통로의 파싱 계약 (#2055 후속) — **실제 CLI 출력 원문**(__fixtures__)으로만 검사한다.
//
//  왜 픽스처인가: 이 파서가 틀리면 화면에 «주소는 있는데 코드가 없는» 반쪽이 뜨고, 사람은 로그인을 못 한다.
//  손으로 지어낸 샘플로 맞추면 진짜 출력의 제어문자(ANSI 색·OSC-8 하이퍼링크)를 놓친다 — 실제로 claude 는
//  주소를 OSC-8 로 감싸 **같은 주소가 두 번** 나온다. 그래서 격리 홈에서 두 CLI 를 직접 돌려 받은 출력을
//  그대로 두고(일회용 코드·PKCE 값만 치환) 그것으로 잠근다. 판올림으로 문구가 바뀌면 이 픽스처를 다시 딴다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aiLoginStep, isAiLoginHarness, parseAiLogin, stripAnsi, EXIT_MARK } from "./ai-login-flow.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const fx = (n: string): string =>
  readFileSync(new URL(`./__fixtures__/${n}`, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");

t("배선 · 픽스처를 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(fx("codex-device-auth.txt").length > 200);
  assert.ok(fx("claude-auth-login.txt").length > 400);
});

t("★ C1 codex — 주소와 일회용 코드를 뽑는다(이 둘이면 터미널이 필요 없다)", () => {
  const st = parseAiLogin("codex", fx("codex-device-auth.txt"));
  assert.equal(st.url, "https://auth.openai.com/codex/device");
  assert.equal(st.code, "ABCD-12345");
  assert.ok(!st.needsPaste, "codex 는 되돌려 넣을 것이 없다");
  assert.equal(aiLoginStep(st, false), "open-url");
});

t("★ C2 claude — 주소를 뽑고 «코드를 되돌려 넣어야 한다»를 안다", () => {
  const st = parseAiLogin("claude", fx("claude-auth-login.txt"));
  assert.match(String(st.url), /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  assert.ok(!st.code, "claude 는 우리가 보여줄 코드가 없다 — 사람이 받아 온다");
  assert.equal(st.needsPaste, true);
  assert.equal(aiLoginStep(st, false), "paste-code");
});

t("★ C3 OSC-8 하이퍼링크를 걷는다 — 안 걷으면 주소가 두 번 나오고 첫 매치가 깨진다", () => {
  const raw = fx("claude-auth-login.txt");
  assert.ok(/\]8;;/.test(raw), "픽스처에 OSC-8 이 실제로 들어 있다");
  const clean = stripAnsi(raw);
  assert.ok(!/\]8;;/.test(clean));
  assert.equal((clean.match(/https:\/\/claude\.com/g) || []).length, 1, "주소가 한 번만 남는다");
});

t("C4 아직 아무것도 안 찍혔으면 '시작 중'", () => {
  assert.equal(aiLoginStep(parseAiLogin("codex", ""), false), "starting");
});

t("★ C5 프로세스가 끝난 것과 로그인 성공은 다르다 — 성공은 자격 확인이 정한다", () => {
  const st = parseAiLogin("codex", fx("codex-device-auth.txt") + `\n${EXIT_MARK} 0\n`);
  assert.equal(st.exited, true);
  assert.equal(st.exitCode, 0);
  assert.equal(aiLoginStep(st, false), "waiting", "끝났어도 자격이 확인되기 전엔 '기다림'");
  assert.equal(aiLoginStep(st, true), "done", "자격이 확인돼야 '완료'");
});

t("★ C6 실패를 삼키지 않는다", () => {
  const st = parseAiLogin("codex", `Error: network unreachable\n${EXIT_MARK} 1\n`);
  assert.match(String(st.error), /network unreachable/);
  assert.equal(aiLoginStep(st, false), "failed");
  // 주소도 못 찍고 죽었으면 종료코드만으로도 실패로 본다.
  const st2 = parseAiLogin("codex", `${EXIT_MARK} 127\n`);
  assert.equal(aiLoginStep(st2, false), "failed");
});

t("C7 이 통로가 다루는 하네스만 받는다 — 나머지는 종전 안내로", () => {
  assert.ok(isAiLoginHarness("codex") && isAiLoginHarness("claude"));
  for (const k of ["agy", "grok", "opencode", "shell", ""]) assert.ok(!isAiLoginHarness(k), k);
});

t("★ C8 문구가 아니라 **모양**으로 읽는다 — 판올림으로 안내문이 바뀌어도 안 깨진다", () => {
  const future = "\n어서 오세요 Codex\n\n로그인하려면:\n  https://auth.openai.com/codex/device\n\n코드:\n  WXYZ-98765\n";
  const st = parseAiLogin("codex", future);
  assert.equal(st.url, "https://auth.openai.com/codex/device");
  assert.equal(st.code, "WXYZ-98765");
});

console.log(`\n${pass} passed`);

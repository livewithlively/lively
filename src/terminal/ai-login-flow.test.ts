// AI 로그인 통로의 파싱 계약 (#2055 후속) — **실제 CLI 출력 원문**(__fixtures__)으로만 검사한다.
//
//  왜 픽스처인가: 이 파서가 틀리면 화면에 «주소는 있는데 코드가 없는» 반쪽이 뜨고, 사람은 로그인을 못 한다.
//  손으로 지어낸 샘플로 맞추면 진짜 출력의 제어문자(ANSI 색·OSC-8 하이퍼링크)를 놓친다 — 실제로 claude 는
//  주소를 OSC-8 로 감싸 **같은 주소가 두 번** 나온다. 그래서 격리 홈에서 두 CLI 를 직접 돌려 받은 출력을
//  그대로 두고(일회용 코드·PKCE 값만 치환) 그것으로 잠근다. 판올림으로 문구가 바뀌면 이 픽스처를 다시 딴다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aiLoginArgv, aiLoginStep, isAiLoginHarness, parseAiLogin, stripAnsi, EXIT_MARK } from "./ai-login-flow.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const fx = (n: string): string =>
  readFileSync(new URL(`./__fixtures__/${n}`, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");

t("배선 · 픽스처를 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(fx("codex-device-auth.txt").length > 200);
  assert.ok(fx("claude-auth-login.txt").length > 400);
  assert.ok(fx("grok-device-auth.txt").length > 200);
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
  assert.ok(isAiLoginHarness("codex") && isAiLoginHarness("claude") && isAiLoginHarness("grok"));
  //  agy 는 **로그인 서브커맨드 자체가 없다**(실측 2026-08-31: `agy login --help` 가 일반 usage 를 찍는다).
  //   하네스를 켜야 로그인 화면이 뜨고 자격도 파일로 안 남아(키링) 이 통로의 전제를 못 채운다 — 지어내지 않는다.
  for (const k of ["agy", "opencode", "shell", ""]) assert.ok(!isAiLoginHarness(k), k);
});

t("★ C8 문구가 아니라 **모양**으로 읽는다 — 판올림으로 안내문이 바뀌어도 안 깨진다", () => {
  const future = "\n어서 오세요 Codex\n\n로그인하려면:\n  https://auth.openai.com/codex/device\n\n코드:\n  WXYZ-98765\n";
  const st = parseAiLogin("codex", future);
  assert.equal(st.url, "https://auth.openai.com/codex/device");
  assert.equal(st.code, "WXYZ-98765");
});

t("★ grok 도 codex 와 같은 모양이다 — 주소와 코드를 **보여 준다**(실측 2026-08-31)", () => {
  // 하네스가 늘 때 이 검사가 없으면 «주소는 뜨는데 코드가 없는» 반쪽 화면을 배포하고도 모른다.
  const st = parseAiLogin("grok", fx("grok-device-auth.txt"));
  assert.equal(st.url, "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234");
  assert.equal(st.code, "ABCD-1234");
  assert.equal(st.needsPaste, undefined, "grok 은 코드를 되받지 않는다");
  assert.equal(st.error, undefined);
  assert.equal(aiLoginStep(st, false), "open-url");
});

t("★ grok 은 이 통로의 대상이다 — 표에서 빠지면 화면이 종전 창으로 되돌아간다", () => {
  assert.ok(isAiLoginHarness("grok"));
  assert.deepEqual(aiLoginArgv("grok"), ["grok", "login", "--device-auth"]);
});

console.log(`\n${pass} passed`);

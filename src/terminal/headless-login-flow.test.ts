// 헤드리스 자격 발급 통로의 화면 판독 계약 (#4051) — **실제 CLI 화면**(__fixtures__)으로 검사한다.
//
//  픽스처 둘은 2026-09-17 격리 HOME 에서 `claude setup-token`(2.1.273)을 직접 띄워 받은 것이다(PKCE 값만 치환).
//   · claude-setup-token-screen.txt — 500칸 tmux 에서 **그려진 화면**(capture-pane). 러너가 실제로 읽는 모양이다.
//   · claude-setup-token-raw.txt    — 같은 명령의 **원시 PTY 출력**. 왜 원시 출력을 안 읽는지의 증거로만 쓴다.
//  판올림으로 화면이 바뀌면 이 픽스처를 다시 딴다. 행 번호(F1…)는 스크래치패드 spec.md 의 엣지 표다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HEADLESS_LOGIN_HARNESSES, HEADLESS_SECRET_KIND, headlessLoginArgv, headlessNeedsPty, isHeadlessLoginHarness,
  findSetupToken, redactSetupToken, isSetupTokenShaped, TOKEN_CAPTURED_MARK, CAPTURED_LINE,
  parseHeadlessLogin, headlessLoginStep, headlessStateOf, HEADLESS_ENDED_MESSAGE, HEADLESS_LOST_MESSAGE,
} from "./headless-login-flow.js";
import { parseAiLogin, stripAnsi, EXIT_MARK } from "./ai-login-flow.js";
import { SANDBOX_CREDS } from "../node/sandbox-credentials.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const fx = (n: string): string =>
  readFileSync(new URL(`./__fixtures__/${n}`, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
//  모양만 진짜와 같은 가짜 토큰(실제 토큰은 이 저장소에 없다).
const FAKE = "sk-ant-oat01-" + "Ab3_-".repeat(18) + "xyzAA";
const SCREEN = fx("claude-setup-token-screen.txt");

t("배선 · 픽스처를 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(SCREEN.length > 400);
  assert.ok(fx("claude-setup-token-raw.txt").length > 400);
  assert.ok(fx("codex-device-auth.txt").length > 200);
  assert.ok(!SCREEN.includes("sk-ant-"), "픽스처에 토큰이 없다");
});

t("★ F1 그려진 화면에서 주소 한 줄과 «코드를 넣으라» 를 읽는다", () => {
  const st = parseHeadlessLogin("claude", SCREEN);
  assert.match(String(st.url), /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  assert.match(String(st.url), /scope=user%3Ainference(&|$)/, "setup-token 은 추론 범위 하나만 요구한다");
  assert.match(String(st.url), /state=STATE_REDACTED$/, "주소가 끝까지 한 줄로 읽혔다(잘리지 않았다)");
  assert.equal(st.needsPaste, true);
  assert.ok(!st.code, "claude 는 우리가 보여 줄 코드가 없다 — 사람이 받아 온다");
  assert.equal(headlessLoginStep(st), "paste-code");
});

t("★ F2 왜 원시 출력을 안 읽나 — Ink 가 단어 사이를 커서 이동으로 채워 «Paste code here» 가 안 보인다", () => {
  //  이 단언이 깨지면(=원시 출력으로도 읽힌다) tmux 없이 PTY 만으로 가도 되는지 다시 따져 볼 때다.
  const raw = fx("claude-setup-token-raw.txt");
  assert.ok(/\x1b\[\d+G/.test(raw), "원시 출력에 커서 가로 이동(CHA)이 들어 있다");
  assert.ok(!/paste code here/i.test(stripAnsi(raw)), "색만 걷으면 단어가 붙어 버린다");
  assert.notEqual(parseAiLogin("claude", raw).needsPaste, true, "원시 출력으로는 붙여넣기 단계를 못 연다");
});

t("★ F3 토큰은 모든 자리에서 가리고, 상태 객체로는 절대 안 나간다", () => {
  const screen = `${SCREEN}\n Your OAuth token (valid for 1 year):\n ${FAKE}\n export CLAUDE_CODE_OAUTH_TOKEN=${FAKE}\n`;
  assert.equal(findSetupToken(screen), FAKE);
  const red = redactSetupToken(screen);
  assert.ok(!red.includes("sk-ant-"), "첫 번째만이 아니라 전부 가린다");
  assert.equal(red.split(TOKEN_CAPTURED_MARK).length - 1, 2);
  const st = parseHeadlessLogin("claude", screen);
  assert.ok(!JSON.stringify(st).includes("sk-ant-"), "상태 객체 어디에도 토큰이 없다");
  assert.equal(st.captured, true, "가려진 자리는 «잡았다» 로 읽힌다");
});

t("★ F4 비슷하지만 토큰이 아닌 글자는 잡지 않는다", () => {
  assert.equal(findSetupToken("sk-ant-oat01-short"), null, "짧은 글자");
  assert.equal(findSetupToken("sk-ant-api03-" + "a".repeat(80)), null, "API 키(oat 가 아님)는 이 통로의 자격이 아니다");
  assert.equal(findSetupToken(""), null);
});

t("★ F5 저장 직전 검사 — 값 전체가 토큰 모양이어야 한다", () => {
  assert.equal(isSetupTokenShaped(FAKE), true);
  assert.equal(isSetupTokenShaped(`  ${FAKE}\n`), true, "앞뒤 공백은 허용");
  assert.equal(isSetupTokenShaped(`x${FAKE}`), false, "앞에 다른 글자");
  assert.equal(isSetupTokenShaped(`${FAKE} rest`), false, "뒤에 다른 글자");
  assert.equal(isSetupTokenShaped(`${FAKE}\n${FAKE}`), false, "두 개가 붙은 값");
  assert.equal(isSetupTokenShaped(""), false, "빈 값");
});

t("★ F6·F7 잡았으면 기다림, 저장했을 때만 끝", () => {
  const screen = `${SCREEN} abcd#efgh\n\n Token created\n ${TOKEN_CAPTURED_MARK}\n\n${EXIT_MARK} 0\n`;
  const cap = parseHeadlessLogin("claude", screen);
  assert.equal(cap.captured, true);
  assert.notEqual(cap.needsPaste, true, "코드를 넣고 난 입력줄이 화면에 남아도 붙여넣기 단계가 아니다");
  assert.equal(headlessLoginStep(cap), "waiting", "저장 전에는 끝났다고 하지 않는다");
  assert.equal(headlessLoginStep(parseHeadlessLogin("claude", screen, { stored: true })), "done");
  assert.equal(headlessLoginStep(parseHeadlessLogin("claude", "", { stored: true })), "done", "로그가 지워져도 저장 표식이 끝이다");
  assert.equal(headlessLoginStep(parseHeadlessLogin("claude", "")), "starting", "아무것도 없으면 시작 중");
});

t("★ F8·F9 정상 종료인데 못 잡았거나 CLI 가 없으면 실패로 말한다", () => {
  const st = parseHeadlessLogin("claude", `${SCREEN}\n${EXIT_MARK} 0\n`);
  assert.equal(headlessLoginStep(st), "failed", "조용히 «기다림» 에 두지 않는다");
  assert.ok(String(st.error || "").length > 0, "사람에게 보일 문장이 있다");
  const st2 = parseHeadlessLogin("claude", `env: claude: No such file or directory\n${EXIT_MARK} 127\n`);
  assert.equal(headlessLoginStep(st2), "failed");
  assert.ok(String(st2.error || "").includes("127"), "종료 코드를 말한다");
});

t("★ F10·F11 codex — 주소·코드, 잡음 줄 뒤 종료는 기다림", () => {
  const st = parseHeadlessLogin("codex", fx("codex-device-auth.txt"));
  assert.equal(st.url, "https://auth.openai.com/codex/device");
  assert.equal(st.code, "ABCD-12345");
  assert.equal(headlessLoginStep(st), "open-url");
  const done = parseHeadlessLogin("codex", `${fx("codex-device-auth.txt")}\n${CAPTURED_LINE}\n\n${EXIT_MARK} 0\n`);
  assert.equal(done.captured, true);
  assert.equal(headlessLoginStep(done), "waiting");
});

t("★ F12 잡음 표시는 한 줄 전체일 때만 — 다른 글 속의 같은 글자는 아니다", () => {
  const fake = parseHeadlessLogin("codex", `${fx("codex-device-auth.txt")}\nsay ${CAPTURED_LINE} here\n\n${EXIT_MARK} 0\n`);
  assert.notEqual(fake.captured, true);
  assert.equal(headlessLoginStep(fake), "failed");
});

t("★ L6 러너가 끝났으면 실패로 말하고, 받을 러너가 없는 주소·코드는 내보내지 않는다", () => {
  const gone = parseHeadlessLogin("claude", SCREEN, { ended: true });
  assert.equal(headlessLoginStep(gone), "failed", "영영 «코드를 넣으세요» 로 두지 않는다");
  assert.equal(gone.error, HEADLESS_ENDED_MESSAGE);
  assert.equal(gone.url, undefined, "사람이 그 주소로 승인해도 아무 일이 없다");
  assert.notEqual(gone.needsPaste, true);
  const cx = parseHeadlessLogin("codex", fx("codex-device-auth.txt"), { ended: true });
  assert.deepEqual([cx.url, cx.code, headlessLoginStep(cx)], [undefined, undefined, "failed"], "codex 일회용 코드도 안 내보낸다");
  const live = parseHeadlessLogin("claude", SCREEN, { ended: false });
  assert.equal(headlessLoginStep(live), "paste-code", "산 러너는 그대로다(배선 — 같은 화면이 끝남 표시로만 갈린다)");
  assert.equal(headlessLoginStep(parseHeadlessLogin("claude", "", { ended: true })), "failed", "기록이 없어도 끝난 건 끝난 것");
});

t("★ L11·L13·L19 끝난 러너(거둘 자격 파일 없음)의 우선순위 — 저장 > 종료 오류 > «잃었어요» / «끝났어요»", () => {
  const stored = parseHeadlessLogin("claude", SCREEN, { ended: true, stored: true });
  assert.equal(headlessLoginStep(stored), "done", "L11 저장이 이긴다");
  assert.equal(stored.error, undefined, "L11 저장된 시도에 실패 문장을 싣지 않는다(오류부터 보는 화면이 틀리게 읽는다)");
  const ex = parseHeadlessLogin("claude", `env: claude: No such file or directory\n${EXIT_MARK} 127\n`, { ended: true });
  assert.equal(headlessLoginStep(ex), "failed");
  assert.match(String(ex.error), /127/, "L13 더 구체적인 종료 오류가 이긴다");
  const noTok = parseHeadlessLogin("claude", `${SCREEN}\n${EXIT_MARK} 0\n`, { ended: true });
  assert.match(String(noTok.error), /자격을 받지 못했어요/, "정상 종료인데 못 잡음(F8) 문장이 이긴다");
  const lost = parseHeadlessLogin("claude", `${SCREEN} abcd#efgh\n ${TOKEN_CAPTURED_MARK}\n`, { ended: true });
  assert.equal(headlessLoginStep(lost), "failed", "L19 잡았다는 기록만 있고 자격도 러너도 없다 — 영영 «기다림» 에 두지 않는다");
  assert.equal(lost.error, HEADLESS_LOST_MESSAGE);
  assert.equal(lost.url, undefined);
});

t("★ L12·L20 상태 조립 — 거둘 자격 파일이 있으면 러너가 끝났어도 «끝남» 이 아니다(이번 조회가 저장한다)", () => {
  const capLog = `${SCREEN} abcd#efgh\n ${TOKEN_CAPTURED_MARK}\n`;
  const pending = headlessStateOf("claude", { log: capLog, ended: true, hasCaptured: true }, { stored: false });
  assert.equal(pending.step, "waiting", "L12 저장을 기다린다");
  assert.equal(pending.error, undefined);
  const saved = headlessStateOf("claude", { log: capLog, ended: true, hasCaptured: true }, { stored: true });
  assert.equal(saved.step, "done", "이번 조회가 저장했다");
  const failedStore = headlessStateOf("claude", { log: capLog, ended: true, hasCaptured: true }, { stored: false, storeError: "저장 실패 — 키 없음" });
  assert.deepEqual([failedStore.step, failedStore.error], ["failed", "저장 실패 — 키 없음"],
    "L20 저장 실패 사유가 보인다(«끝났어요» 로 덮지 않는다)");
  const gone = headlessStateOf("claude", { log: capLog, ended: true, hasCaptured: false }, { stored: false });
  assert.deepEqual([gone.step, gone.error], ["failed", HEADLESS_LOST_MESSAGE], "자격 파일도 없으면 잃은 것이다");
  const ended = headlessStateOf("claude", { log: SCREEN, ended: true, hasCaptured: false }, { stored: false });
  assert.deepEqual([ended.step, ended.error, ended.url], ["failed", HEADLESS_ENDED_MESSAGE, undefined]);
  const live = headlessStateOf("claude", { log: SCREEN, ended: false, hasCaptured: false }, { stored: false });
  assert.equal(live.step, "paste-code", "산 러너는 그대로다");
  assert.match(String(live.url), /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  const empty = headlessStateOf("claude", { log: "", ended: false, hasCaptured: false }, { stored: false });
  assert.equal(empty.step, "starting", "빈 자리는 시작 중(끝남 판정은 조회가 흔적을 보고 한다)");
});

t("★ F13·F14 하네스 목록·저장 종류 = 중앙 샌드박스 판이 빌리는 표", () => {
  //  어긋나면 화면은 «연결됨» 인데 판은 여전히 no_credential 이다 — 이 통로가 없애려는 바로 그 조용한 실패.
  assert.deepEqual([...HEADLESS_LOGIN_HARNESSES].sort(), Object.keys(SANDBOX_CREDS).sort());
  for (const h of HEADLESS_LOGIN_HARNESSES) assert.equal(HEADLESS_SECRET_KIND[h], SANDBOX_CREDS[h].kind, `${h} 자격 종류`);
  assert.equal(isHeadlessLoginHarness("claude"), true);
  assert.equal(isHeadlessLoginHarness("codex"), true);
  assert.equal(isHeadlessLoginHarness("grok"), false, "판 자격 표에 없는 하네스는 받지 않는다");
  assert.equal(isHeadlessLoginHarness(""), false);
});

t("★ F15 발급 명령 — claude 는 장기 토큰(PTY), codex 는 파일로 남는 장치 로그인(파이프)", () => {
  assert.deepEqual(headlessLoginArgv("claude"), ["claude", "setup-token"]);
  assert.equal(headlessNeedsPty("claude"), true, "setup-token 은 TTY 가 아니면 한 글자도 안 찍는다(실측)");
  const cx = headlessLoginArgv("codex");
  assert.equal(cx[0], "codex");
  assert.deepEqual(cx.slice(-2), ["login", "--device-auth"], "웹터미널이 원격이라 device-auth 여야 한다");
  const i = cx.indexOf("cli_auth_credentials_store=file");
  assert.ok(i > 0 && cx[i - 1] === "-c", "자격을 파일로 남기게 한다(키체인이면 거둘 파일이 없다)");
  assert.ok(i < cx.indexOf("login"), "-c 는 서브커맨드 앞(전역 설정)");
  assert.equal(headlessNeedsPty("codex"), false);
});

console.log(`\n${pass} passed`);

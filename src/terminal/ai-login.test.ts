// 온보딩 «AI 잇기» 4종 실배선 — 클로드·챗지피티·제미나이·그록 (#1879).
//
// 왜 소스를 읽는 테스트가 섞여 있나: 이 배선의 고장은 **오류를 내지 않는다**. 판정이 어긋나면 화면이
//  조용히 «아직 로그인이 안 보여요» 를 반복할 뿐이고(제미나이가 정확히 그랬다), 런타임으로 잡으려면
//  격리 박스·drop-priv·네 벤더의 실계정이 다 필요하다. 그래서 계약을 소스에 못박는다(#1813 ㉟㊱㊲ 와 같은 판단).
// 실행: npm run build && node dist/terminal/ai-login.test.js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HARNESSES } from "./catalog.js";
import { harnessHasCredential, harnessLoginProbe } from "./profiles.js";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void): void => {
  try { fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.log(`not ok  ${name}\n    ${(e as Error).message.split("\n")[0]}`); }
};

const srcOf = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const PROFILES = srcOf("./profiles.ts");
const ROUTES = srcOf("./routes.ts");
//  #1631 — «폴링은 싸게, 결정 지점은 정확하게» 를 지키려면 그 두 자리가 있는 파일도 봐야 한다.
const WELCOME = readFileSync(
  new URL("../capabilities/delivery/welcome.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
// 웹은 dist 로 안 간다 — src/terminal 기준 상대경로로 레포 루트를 거슬러 올라간다.
const ONBOARDING = readFileSync(
  new URL("../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");

/** 온보딩이 사람에게 **고르게 하는** AI → 하네스 key. 화면의 표를 그대로 읽는다(두 벌로 적지 않는다). */
function onboardingAiMap(): Record<string, string> {
  const m = ONBOARDING.match(/const AI_HARNESS = \{([^}]*)\}/);
  assert.ok(m, "온보딩에서 AI_HARNESS 표를 찾지 못했다 — 화면이 무엇을 고르게 하는지 알 수 없다");
  const out: Record<string, string> = {};
  for (const [, label, key] of m![1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) out[label] = key;
  return out;
}

// ── 고르게 한 넷이 실제로 이어지는가 (이 프로젝트의 본론) ─────────────────────

t("① 온보딩이 고르게 하는 넷은 전부 실재하는 하네스다", () => {
  const map = onboardingAiMap();
  assert.deepEqual(Object.keys(map).sort(), ["ChatGPT", "Claude", "Gemini", "Grok"]);
  for (const [label, key] of Object.entries(map)) {
    assert.ok(HARNESSES.some((h) => h.key === key), `${label} → ${key} 가 카탈로그에 없다`);
  }
});

t("② ★고르게 한 AI 는 전부 «이어졌나» 를 답할 수 있어야 한다 — 이게 제미나이가 막다른 길이던 자리다", () => {
  // 자격 파일(HARNESS_CRED)도 없고 프로브(HARNESS_PROBE)도 없으면 서버는 로그인을 영영 못 본다.
  //  그런 AI 를 고르게 해 두면 사람은 로그인을 마치고도 «아직 로그인이 안 보여요» 를 무한히 본다.
  for (const [label, key] of Object.entries(onboardingAiMap())) {
    assert.ok(harnessHasCredential(key) || harnessLoginProbe(key),
      `${label}(${key}) 는 로그인 판정 수단이 없다 — 고르게 하면 안 되거나, 프로브를 실측해 표에 넣어야 한다`);
  }
});

t("③ 제미나이(antigravity)는 프로브로 잰다 — 자격 파일이 없기 때문이다", () => {
  assert.equal(harnessHasCredential("antigravity"), false,
    "agy 가 자격 파일을 남긴다고 판정하고 있다 — ~/.gemini 트리엔 자격 파일이 없다(실측)");
  assert.deepEqual([...(harnessLoginProbe("antigravity") ?? [])], ["models"],
    "실측된 프로브는 `agy models` 다 — 로그인 exit 0 / 미로그인 exit 1");
});

t("④ 고르게 한 넷은 전부 **실측된** 로그인 절차를 갖는다", () => {
  for (const [label, key] of Object.entries(onboardingAiMap())) {
    const h = HARNESSES.find((x) => x.key === key)!;
    assert.ok(h.loginSteps?.length, `${label} 의 loginSteps 가 비었다 — 화면이 빈 절차를 그린다`);
    assert.ok(h.bin, `${label} 의 bin 이 비었다`);
  }
});

t("⑤ 없는 명령을 안내하지 않는다 — agy 에는 login 서브커맨드가 없다", () => {
  const steps = (HARNESSES.find((h) => h.key === "antigravity")?.loginSteps ?? []).join(" ");
  assert.doesNotMatch(steps, /agy\s+login/,
    "`agy login` 을 안내하고 있다 — 그 명령은 없다(실측 --help). 사람은 첫 줄에서 막힌다");
  // 나머지 셋은 반대로 **셸 한 줄이 실재**하므로 그걸 그대로 준다.
  for (const [key, re] of [["claude", /claude auth login/], ["codex", /codex login/], ["grok", /grok login/]] as const) {
    assert.match((HARNESSES.find((h) => h.key === key)?.loginSteps ?? []).join(" "), re,
      `${key} 의 실측된 로그인 명령이 절차에 없다`);
  }
});

// ── 판정이 도는 자리 ────────────────────────────────────────────────────────

t("⑥ 프로브는 **뜨거운 경로에 없다** — /welcome 폴링이 매번 4.3초를 물면 안 된다", () => {
  //  ⚠ 함수 **본문**으로 자른다(600자 어림이 아니라). #1631 로 바로 아래에 프로브를 쓰는 형제 함수
  //   (memberUsableHarnesses)가 생겼는데, 어림 창은 그것까지 삼켜 «폴링에 프로브가 섞였다» 고 잘못 짚었다.
  //   지켜야 할 사실은 «폴링이 부르는 그 함수의 몸통에 프로브가 없다» 이지 «근처에 없다» 가 아니다.
  const from = PROFILES.indexOf("export async function memberLoggedInHarnessesAny");
  assert.notEqual(from, -1, "폴링이 부르는 함수가 사라졌다");
  const nextExport = PROFILES.indexOf("\nexport ", from + 10);
  const body = PROFILES.slice(from, nextExport === -1 ? undefined : nextExport);
  assert.doesNotMatch(body, /HARNESS_PROBE|aiLoginCheck|runAtMemberSeat/,
    "폴링이 읽는 판정에 프로브가 섞였다 — 온보딩 조회마다 네트워크 왕복이 붙는다");
  //  그리고 **폴링 자리 자신**도 싼 쪽을 불러야 한다 — 함수가 싸도 호출자가 비싼 형제를 부르면 같은 사고다.
  //  ⚠ **주석은 빼고** 본다 — 이 자리엔 «왜 싼 쪽을 쓰는가» 를 설명하려고 비싼 쪽 이름이 글로 등장한다.
  //   글자를 세면 그 설명 자체가 위반으로 잡혀, 결국 사람이 주석을 지우게 만든다(가드가 문서를 이긴다).
  const snap = WELCOME.slice(WELCOME.indexOf("export async function welcomeSnapshot"),
    WELCOME.indexOf("export async function kickoffLivAfterWelcome"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.match(snap, /memberLoggedInHarnessesAny\(userId\)/, "폴링 스냅샷이 싼 판정을 안 쓴다");
  assert.doesNotMatch(snap, /memberUsableHarnesses/,
    "폴링 스냅샷이 프로브 판정을 쓴다 — 조회마다 최대 25초가 붙는다(#1631)");
  assert.match(ROUTES, /app\.post\("\/api\/ui\/me\/ai-accounts\/check"/,
    "프로브를 돌리는 자리가 POST 가 아니다 — 부수효과 있는 조회를 GET 계약에 얹으면 캐시·프리페치가 붙는다");
});

t("⑥b 결정 지점(리브 킥오프)은 **정확한** 사실을 쓴다 — 제미나이만 이은 사람이 막히면 안 된다(#1631)", () => {
  //  자격 파일이 없는 하네스(antigravity)는 파일 표에 구조적으로 못 든다. 게이트가 그 목록을 그대로 쓰면
  //   화면이 «Gemini 로그인이 확인됐어요» 라고 확정해 준 사람에게 리브를 열어 주지 않는다.
  const kick = WELCOME.slice(WELCOME.indexOf("export async function kickoffLivAfterWelcome"));
  assert.match(kick, /memberUsableHarnesses/, "킥오프 게이트가 프로브까지 본 사실을 쓰지 않는다");
  assert.match(kick, /planLivKickoff\(o\.priorSession, usable\)/, "게이트에 넘기는 값이 그 사실이 아니다");
  assert.match(kick, /aiHarnesses: usable/, "1턴 프롬프트가 게이트와 다른 사실을 본다");
});

t("⑦b ★설치는 **게이트웨이 자신**에서 잰다 — 멤버 자리(tmux 컨테이너)는 이미지가 다를 수 있다", () => {
  // 2026-08-27 라이브 실측: 중계는 늘 tmux 컨테이너로 exec 하는데(member-exec-relay `/containers/…-tmux/exec`)
  //  하네스가 도는 곳은 멤버 세션 컨테이너다. 같은 테넌트에서 tmux=c36(agy 없음) / 세션=c48(agy 있음) →
  //  화면이 «이 자리엔 Gemini 가 없어요» 라고 거짓말했다. 새 세션엔 실제로 있었다.
  const fn = PROFILES.slice(PROFILES.indexOf("export async function aiLoginCheck"));
  assert.match(fn, /out\.installed = await runAtMemberSeat\(null,/,
    "설치를 멤버 자리에서 재고 있다 — tmux 컨테이너가 스테일하면 거짓 '미설치' 가 된다");
  // 반대로 자격은 멤버 자리가 맞다(홈이 볼륨) — 그쪽까지 게이트웨이로 옮기면 남의 자격을 보게 된다.
  assert.match(fn, /aiAccountStatus\(user, osSt\)/, "자격 판정이 멤버 축(aiAccountStatus)을 안 쓴다");
});

t("★ 매니지드 중계 배포(LIVELY_MEMBER_EXEC)에서도 자격 판정은 멤버 홈이다 — 게이트웨이 자기 홈을 보면 늘 «미로그인» (#2232)", () => {
  const fn = PROFILES.slice(PROFILES.indexOf("export async function aiAccountStatus"), PROFILES.indexOf("export async function memberLoggedInHarnessesAny"));
  assert.match(fn, /const relayed = !isolated && memberExecConfigured\(\)/, "중계 배포 분기가 없다");
  assert.match(fn, /if \(isolated \|\| relayed\)/, "중계 배포가 격리와 같은 축(osSt.loggedInHarnesses)을 안 탄다");

});

t("⑦c 프로브를 못 돌리는 자리면 '미로그인' 이 아니라 '모름' 이다", () => {
  // 프로브는 그 사람 자격(HOME)을 봐야 해서 멤버 자리에서 돌아야 하는데, 그 자리에 바이너리가 없을 수 있다.
  //  그 실패를 false 로 접으면 **로그인한 사람에게** «아직 로그인이 안 보여요» 라고 한다.
  const fn = PROFILES.slice(PROFILES.indexOf("export async function aiLoginCheck"));
  assert.match(fn, /if \(await runAtMemberSeat\(osUser, `command -v[\s\S]{0,120}out\.loggedIn = null;/,
    "프로브 자리에 바이너리가 없을 때를 모름(null)으로 접지 않는다");
});

t("⑦ 설치가 아니면 로그인을 묻지 않는다 — 없는 CLI 의 답은 늘 '미로그인' 이라 사람을 오도한다", () => {
  const fn = PROFILES.slice(PROFILES.indexOf("export async function aiLoginCheck"));
  assert.match(fn, /out\.installed = await runAtMemberSeat[\s\S]{0,200}if \(out\.installed !== true\) return out;/,
    "설치 확인 뒤 곧바로 빠져나가지 않는다 — 미설치를 미로그인으로 옮겨 적게 된다");
});

t("⑧ 격리에서 프로브는 HOME 을 **명시**한다 — 중계 exec 에는 그 유저의 passwd 항목이 없다", () => {
  assert.match(PROFILES, /memberSh\(osUser, `HOME="\$\{MEMBER_HOME_BASE\}\/\$\{osUser\}" \$\{cmd\}`\)/,
    "HOME 을 안 넘긴다 — agy 는 자격을 HOME 기준으로 찾으므로 판정이 통째로 뒤집힌다");
});

t("⑨ 프로브는 stdin 을 닫는다 — 안 닫으면 agy 가 영원히 멈춰 제미나이 전원이 '모름' 이 된다", () => {
  // 실측(2026-08-26, 프리뷰 라이브): execFile 이 준 stdin 파이프는 EOF 가 안 와서 `agy models` 가 25초 상한까지
  //  매달렸다(→ null). `< /dev/null` 이면 3.1초 exit 0. 셸에서 손으로 치면 TTY 라 멀쩡해서 **서버에서만** 고장난다.
  const fn = PROFILES.slice(PROFILES.indexOf("async function runAtMemberSeat"), PROFILES.indexOf("export async function aiLoginCheck"));
  assert.match(fn, /const cmd = `\$\{line\} < \/dev\/null`;/, "stdin 을 닫지 않는다");
  assert.doesNotMatch(fn, /execFileAsync\("sh", \["-c", line\]/, "닫지 않은 원본 line 을 그대로 돌리고 있다");
});

t("⑨b 모름(null)을 미로그인으로 접지 않는다", () => {
  const fn = PROFILES.slice(PROFILES.indexOf("async function runAtMemberSeat"), PROFILES.indexOf("export async function aiLoginCheck"));
  assert.match(fn, /return null;\s*\/\/ 게이트웨이가 윈도우면/, "확인 불가를 false 로 접고 있다");
  assert.match(fn, /Promise\.race\(\[run, timer\]\)/, "상한이 없다 — 프로브가 매달리면 요청이 함께 매달린다");
});

// ── 화면이 사람을 가두지 않는가 ──────────────────────────────────────────────

t("⑩ 화면은 고른 AI **하나**를 묻는다 — «아무거나 하나» 로 «이어졌어요» 라고 하지 않는다", () => {
  const scene = ONBOARDING.slice(ONBOARDING.indexOf("    claude: {"), ONBOARDING.indexOf("    terminal: {"));
  assert.match(scene, /checkAi\(\)/, "고른 AI 판정을 부르지 않는다");
  assert.doesNotMatch(scene, /WS\.ai_ready/,
    "«아무 하네스나 하나» 인 ai_ready 로 이음 여부를 정하고 있다 — 그록을 고른 사람에게 claude 로그인을 근거로 «이어졌어요» 라고 하게 된다");
});

t("⑪ 막다른 길이 없다 — CLI 가 없어도 계속할 문이 있다", () => {
  const scene = ONBOARDING.slice(ONBOARDING.indexOf("    claude: {"), ONBOARDING.indexOf("    terminal: {"));
  assert.match(scene, /c\.installed === false/, "미설치 갈래가 없다 — 그 사람은 없는 명령을 치라는 안내를 받는다");
  assert.match(scene, /data-other/, "다른 AI 를 고를 문이 없다");
  assert.match(scene, /id="cKeep"/, "이미 이어진 다른 AI 로 계속할 문이 없다");
});

t("⑬ ★화면이 «이어졌다» 를 지어내지 않는다 — 참으로 만드는 자리는 서버 확인 뒤 한 곳뿐", () => {
  // 종전 replayChatTo 가 `S.aiConnected = S.ai !== '아직 없어요'` 로 **무조건 대입**했다(|| 폴백이 아니다).
  //  그래서 AI 잇기를 건너뛴 사람도 채팅 단계에 닿는 순간 참이 됐고, AI 화면으로 돌아가면
  //  «이어졌어요 · 로그인이 확인됐어요» 라고 말했다 — 서버는 그런 적이 없다.
  //  #1813 이 걷어낸 «900ms 뒤 무조건 연결됐어요» 와 같은 모양의 잔재였다.
  const sets = [...ONBOARDING.matchAll(/S\.aiConnected\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(sets, ["true"],
    `S.aiConnected 를 참으로 만드는 자리가 하나가 아니거나 서버 판정이 아니다: ${JSON.stringify(sets)}`);
  // 그 한 곳은 checkAi() 결과나 «이대로 계속»(다른 AI 가 실제로 이어져 있음) 뒤여야 한다.
  const scene = ONBOARDING.slice(ONBOARDING.indexOf("    claude: {"), ONBOARDING.indexOf("    terminal: {"));
  assert.match(scene, /S\.aiConnected = true/, "이음 처리가 claude 장면(서버 판정 자리) 밖에 있다");
});

t("⑫ 화면이 CLI 이름을 박아 두지 않는다 — 하네스 표가 바뀌면 그 줄만 조용히 틀려진다", () => {
  const map = ONBOARDING.match(/const AI_HARNESS = \{([^}]*)\}/)![1];
  assert.doesNotMatch(map, /'agy'/, "고르기 표에 실행 파일 이름(agy)이 박혀 있다 — 여긴 하네스 key 자리다");
  assert.match(ONBOARDING, /c\.bin/, "실행 파일 이름을 서버 답에서 읽지 않는다");
});

t("★ 프로브형(antigravity)도 중계 배포에선 멤버 자리에서 돈다 — 게이트웨이 자리에서 돌면 늘 «미로그인» (#2232)", () => {
  const fn = PROFILES.slice(PROFILES.indexOf("export async function aiLoginCheck"), PROFILES.indexOf("async function memberFileExists"));
  assert.match(fn, /const osUser = \(osSt\.ready && osSt\.provisioned\) \|\| memberExecConfigured\(\) \? osSt\.osUser : null/, "중계 배포에서 프로브 자리가 게이트웨이다");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

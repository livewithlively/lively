// 세션 표면(#2439 ④) — **컴맹 중학생이 쓸 수 있나**를 값으로 지킨다.
//
//  ⚠ 왜 이 테스트가 필요한가: 이 프로젝트의 «반쪽 UX» 는 두 얼굴이었다.
//   ① 기능이 없다 — 승인·슬래시·사용량이 화면에 아예 안 그려졌다(2026-08-31 사고).
//   ② 있는 척하는데 안 닿는다 — 카드는 뜨는데 눌러도 아무 데도 안 간다.
//  ①은 «그리나» 로, ②는 «배선했나» 로 지킨다. 규칙이 맞아도 **안 부르면** 화면은 그대로다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

const V = await import(join(root, "public/app/session-surface-view.js"));

// ── 승인 카드 ────────────────────────────────────────────────────────────────────
{
  ok(V.askHeadline({ id: "1", toolName: "Bash", title: "rm -rf /tmp/x" }) === "rm -rf /tmp/x",
    "① 제목은 «무엇을 하려는가» — 도구 이름만으로는 판단할 수 없다");
  ok(V.askKind({ id: "1", toolName: "Bash" }) === "명령 실행", "② 종류는 사람 말로('Bash' 아님)");
  ok(V.askKind({ id: "1", toolName: "execute" }) === "명령 실행", "②-b grok ACP 의 kind 도 같은 말로");
  ok(V.askDetail({ id: "1", toolName: "Bash", input: { command: ["ls", "-la"] } }) === "ls -la",
    "③ 본문은 원문 그대로 — 요약하면 무엇을 허용하는지 모른다");

  ok(V.askIsRisky({ id: "1", toolName: "Bash", input: { command: "rm -rf build" } }) === true,
    "④ 되돌리기 어려운 것은 경고한다");
  ok(V.askIsRisky({ id: "1", toolName: "Bash", input: { command: "npm test" } }) === false,
    "④-b 흔한 명령엔 경고 안 한다 — 늘 빨간 화면은 안 빨간 화면과 같다");

  const acp = V.askChoices({ id: "1", toolName: "execute", suggestions: [
    { optionId: "a1", name: "한 번 허용", kind: "allow_once" },
    { optionId: "a2", name: "항상 허용", kind: "allow_always" },
    { optionId: "r1", name: "거부", kind: "reject_once" },
  ] });
  ok(acp.map((c) => c.value.optionId).join() === "a1,a2,r1",
    "⑤ 하네스가 준 선택지는 그대로 — 지어낸 값은 튕기고 그 턴이 선다");
  ok(acp[2].value.allow === false, "⑤-b 거부 선택지는 allow=false");

  ok(V.askChoices({ id: "1", toolName: "Bash" }).map((c) => c.label).join() === "허용,거부",
    "⑥ «항상 허용» 은 근거 없이 안 그린다 — 없는데 그리면 «껐는데 또 묻네» 가 된다");
  ok(V.askChoices({ id: "1", toolName: "Bash", suggestions: [{ type: "addRules" }] }).length === 3,
    "⑥-b 하네스가 감을 주면 그때 그린다");
}

// ── 슬래시 ───────────────────────────────────────────────────────────────────────
{
  ok(V.slashQuery("/rev", 4) === "rev", "⑦ 줄 맨 앞의 / 면 목록을 연다");
  ok(V.slashQuery("보고 src/foo", 11) === null, "⑦-b 경로의 / 에는 안 뜬다(방해만 된다)");
  ok(V.slashQuery("/review 파일", 11) === null, "⑦-c 이미 명령을 고른 뒤엔 닫는다");
  ok(V.slashMatches([{ name: "model" }, { name: "compact" }, { name: "mcp" }], "m")
      .map((c) => c.name).join() === "model,mcp,compact", "⑧ 앞글자 일치가 먼저");
  const r = V.applySlash("/mo뒤", 3, "model");
  ok(r.text === "/model 뒤" && r.caret === 7, "⑨ 고른 명령이 끼워지고 커서가 따라간다");
}

// ── 사실·사용량 ──────────────────────────────────────────────────────────────────
{
  ok(V.usageLine({ utilization: { five_hour: 0.2 } }) === null,
    "⑩ 여유로우면 아무 말 안 한다 — 늘 뜨는 숫자는 화면만 좁힌다");
  const now = Date.now();
  const line = V.usageLine({ utilization: { five_hour: 0.55, weekly: 0.92 }, resetsAt: now + 3600_000 }, now);
  ok(line.startsWith("사용량 92%"), "⑩-b 여러 창 중 가장 빡빡한 것만 말한다");
  ok(V.factChips({}).length === 0, "⑪ 모르는 것은 칩으로 안 그린다(빈 칩은 «없다» 로 읽힌다)");
  ok(V.factChips({ permissionMode: "needs-auth" })[0] === "로그인 필요", "⑪-b 로그인 필요는 그 말로");
  ok(V.factChips({ permissionMode: "weird" })[0] === "weird", "⑪-c 모르는 값은 그대로(지어낸 번역이 더 나쁘다)");
}

// ── 막다른 길 금지 ───────────────────────────────────────────────────────────────
{
  ok(V.terminalOnlyNote([]) === null, "⑫ 전부 되면 조용하다");
  const n = V.terminalOnlyNote(["approve", "slash"]);
  ok(n.includes("승인") && n.includes("슬래시 명령") && n.includes("터미널"),
    "⑫-b ★ 못 하는 기능은 말해 준다 — 안 말하면 사람이 찾아 헤매다 포기한다");
}

// ── 배선 ─────────────────────────────────────────────────────────────────────────
//  규칙이 맞아도 **안 부르면** 화면은 그대로다. 그래서 «부르나» 를 소스에서 확인한다.
{
  const surface = read("web/session-tasks.ts");
  ok(/permission\.asked/.test(surface) && /drawAsk/.test(surface), "⑬ 승인 이벤트를 카드로 그린다");
  ok(/events\/answer/.test(surface), "⑭ ★ 카드가 실제로 **답을 보낸다**(안 보내면 그 턴이 TTL 까지 선다)");
  ok(/permission\.resolved/.test(surface), "⑮ 다른 창에서 답하면 이 화면의 카드도 접는다");
  ok(/'facts'/.test(surface) && /paintMenu/.test(surface), "⑯ 슬래시 목록이 자동완성으로 이어진다");
  ok(/'usage'/.test(surface) && /usageLine/.test(surface), "⑰ 사용량을 그린다");
  ok(/terminalOnlyNote/.test(surface), "⑱ «터미널에서 하세요» 안내를 그린다");
  ok(/cxl-ask/.test(surface),
    "⑲ ★ 승인 카드는 codex 와 **같은 클래스** — 하네스마다 화면이 갈리면 그게 반쪽 UX 다");

  //  ★ 2026-09-01 화면 확인에서 잡은 진짜 버그: 카드에 «null» 이 글자로 찍혀 있었다.
  //   `el()` 은 null 자식을 거르지만 DOM 의 append()/replaceChildren() 은 **"null" 문자열로 넣는다.**
  //   눈으로 안 봤으면 못 잡았을 종류라, 다시 들어오지 못하게 못 박는다.
  ok(/card\.append\(\.\.\.\[[\s\S]*?\]\.filter\(Boolean\)\)/.test(surface),
    "㉔ ★ 승인 카드가 null 자식을 거른다 — 안 거르면 화면에 «null» 이 찍힌다");
  ok(/replaceChildren\(\.\.\.\[[\s\S]*?\]\.filter\(Boolean\)\)/.test(surface),
    "㉔-b 사실 칩 줄도 마찬가지");
  ok(/c\.primary && !risky/.test(surface),
    "㉕ ★ 위험한 요청엔 아무 버튼도 파랗게 안 세운다 — `rm -rf` 옆의 큰 파란 [허용] 은 «여길 누르세요» 로 읽힌다");

  const chat = read("web/session-chat.ts");
  ok(/input: view\.input/.test(chat), "⑳ 입력칸을 넘긴다 — 안 넘기면 슬래시 자동완성이 붙을 자리가 없다");
  ok(/terminalOnly/.test(chat), "㉑ 서버가 준 «못 하는 축» 을 화면에 넘긴다");
  ok(/events\/interrupt/.test(chat), "㉒ 멈춤이 하네스 무관 통로를 탄다");

  const css = read("public/styles/36-chat.css");
  ok(/\.stk-warn/.test(css) && /\.stk-slash/.test(css), "㉓ 경고·자동완성에 스타일이 있다(없으면 안 보인다)");
  ok(/\.cxl-ask\.is-risky/.test(css), "㉖ 위험 카드가 카드째로 티가 난다");

  //  ★ 2026-09-01 다크 모드 확인에서 잡은 함정: `--surface-1`·`--surface-2` 는 **이 레포에 정의된 적이
  //   없는 토큰**이다(쓰이기만 한다). 폴백 `#fff` 를 달아 두면 다크에서 **흰 배경 + 밝은 글자**가 되어
  //   슬래시 메뉴가 통째로 안 읽힌다. 그래서 이 파일이 쓰는 토큰은 **양쪽 테마에 실재해야** 한다.
  //  ⚠ 토큰이 01-base 에만 있는 것은 아니다 — `--livc-mono` 는 35-liv.css 가 :root 에 얹는다.
  //   여기서 01-base 만 보면 «미정의» 라는 거짓 실패가 난다(그러면 다음 사람이 테스트를 지운다).
  const base = read("public/styles/01-base.css") + read("public/styles/35-liv.css");
  const dark = read("public/styles/90-dark.css");
  const mine = css.slice(css.indexOf(".stk-dock"));
  const used = [...new Set([...mine.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]))];
  //  ⚠ 줄 앞 앵커(^)로 찾으면 안 된다 — `:root { --livc-mono: … }` 처럼 **한 줄에 몰아 쓴** 정의를
  //   놓치고 «미정의» 라는 거짓 실패가 난다(그러면 다음 사람이 이 테스트를 지운다).
  const defined = (src, t) => new RegExp(`[{;\\s]--${t}\\s*:`).test(src);
  const undef = used.filter((t) => !defined(base, t));
  ok(undef.length === 0, `㉗ ★ 쓰는 토큰이 라이트 테마에 전부 정의돼 있다 (미정의: ${undef.join(", ") || "없음"})`);
  //  on-fill(칠한 위의 글자색)·livc-mono(글꼴)는 테마와 무관해 다크에서 다시 정의하지 않는다.
  const noDark = used.filter((t) => defined(base, t) && !defined(dark, t)
    && t !== "on-fill" && t !== "livc-mono");
  ok(noDark.length === 0, `㉘ ★ 다크 테마에도 정의돼 있다 (미정의: ${noDark.join(", ") || "없음"})`);
  ok(!/surface-1|surface-2/.test(mine),
    "㉙ ★ 정의된 적 없는 --surface-* 토큰을 안 쓴다 — #fff 폴백이 다크에서 흰 배경을 만든다");
}

console.log(`\n${pass}건 통과`);

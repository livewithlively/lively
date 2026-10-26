// 앱 만들기 세션의 AI · 모델 · 생각 깊이(web/lib/studio-ai.ts, #4632 원준 2026-10-26 «코덱스만 연결되어있거나 다른거 하나만 연결되어있는 사람도 그 비슷한 정도로»).
//  컴파일된 모듈(public/app/lib/studio-ai.js)을 돌린다 — 빌드가 없으면 건너뛰고 그 사실을 적는다(CI 의 run-tests --build 가 돈다).
//  이게 틀리면: Codex(또는 Antigravity · Grok) 하나만 연결한 사람의 앱 만들기 세션이 로그인 안 된 claude 로 떠서 시작조차 못 하거나,
//   claude 를 쓰던 사람이 갑자기 다른 AI 로 열리거나, 그 AI 가 받지 않는 모델 · 강도를 넘겨 세션 생성이 거부된다.
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
//  STUDIO_AI_JS — 다른 빌드(fail-first · 옛 트리)를 물릴 때. 없으면 이 트리의 빌드.
const mod = process.env.STUDIO_AI_JS || join(root, "public/app/lib/studio-ai.js");
if (!existsSync(mod)) {
  //  run-tests --build 밖에서 그냥 돌렸는데 빌드가 없으면 «건너뜀» 이 초록으로 읽힌다 — 그 사실을 크게 적는다(CI 는 늘 빌드 뒤에 돈다).
  console.log("studio-ai: ⚠ 빌드 없음(public/app/lib/studio-ai.js) — 아무것도 시험하지 않고 건너뜀. node scripts/build-web.mjs 뒤에 다시 돌릴 것");
  process.exit(0);
}
const F = await import(mod);
let pass = 0, fail = 0;
const check = (ok, what, extra) => { if (ok) pass++; else { fail++; console.log("FAIL ", what, extra == null ? "" : JSON.stringify(extra)); } };

const ALL = ["claude", "codex", "opencode", "antigravity", "grok", "shell"];
const pick = (o) => F.pickStudioAi({ catalog: ALL, runnable: null, yes: [], no: [], ...o });

// 고르기(순수 규칙) — 엣지 표(행마다 하나). yes/no 를 직접 준다.
const rows = [
  ["P1 claude 만 로그인 → claude(종전과 같다)", { yes: ["claude"], no: ["codex", "grok"] }, "claude"],
  ["P2 codex 만 로그인 → codex", { yes: ["codex"], no: ["claude", "grok"] }, "codex"],
  ["P3 grok 만 로그인 → grok", { yes: ["grok"], no: ["claude", "codex"] }, "grok"],
  ["P4 둘 다 로그인 → claude 먼저", { yes: ["codex", "claude"] }, "claude"],
  ["P5 codex · grok 로그인 → 표 순서(codex)", { yes: ["grok", "codex"], no: ["claude"] }, "codex"],
  ["P7 아무것도 모름 → claude(종전 기본)", {}, "claude"],
  ["P8 전부 «안 됨» → claude(거기서 로그인 안내)", { no: ["claude", "codex", "antigravity", "grok"] }, "claude"],
  ["P10 컴퓨터에 codex 만 깔림 → codex(로그인 몰라도)", { runnable: ["codex", "shell"] }, "codex"],
  ["P11 컴퓨터에 claude · codex · 중앙 로그인 힌트 codex → codex", { runnable: ["claude", "codex"], yes: ["codex"] }, "codex"],
  ["P12 로그인된 AI 를 그 컴퓨터가 못 띄움 → 띄울 수 있는 것 중 claude", { runnable: ["claude", "codex"], yes: ["grok"] }, "claude"],
  ["P13 그 컴퓨터가 claude 를 못 띄우고 전부 «안 됨» → 띄울 수 있는 첫 AI", { runnable: ["grok", "codex"], no: ["codex", "grok"] }, "codex"],
  ["P14 opencode 만 깔림 → 표에 없으니 claude(종전)", { runnable: ["opencode", "shell"] }, "claude"],
  ["P15 카탈로그 없음(옛 게이트웨이) → claude", { catalog: [], yes: ["codex"] }, "claude"],
  ["P16 카탈로그에 codex 가 없으면 로그인돼 있어도 안 고른다", { catalog: ["claude", "grok"], yes: ["codex"], no: ["claude"] }, "grok"],
];
for (const [what, o, want] of rows) { const got = pick(o); check(got === want, what, { got, want }); }

// 실제 꼴로 — 컴퓨터 · 로그인 목록(/api/ui/me/ai-accounts 를 읽은 것) → studioAiInputs → pickStudioAi.
//  목록에서 Antigravity 는 늘 «모름»(자격이 파일로 안 남는다)이라 yes 에 없으면 확인 안 된 것이다 — 화면이 따로 물어 확인됐을 때만 yes 에 든다.
const NODES = [
  { id: "mac", harnesses: ["claude", "codex", "shell"] },
  { id: "codexmac", harnesses: ["codex", "shell"] },
  { id: "old", harnesses: [] },
  { id: "winsh", harnesses: ["shell"] },
];
const real = (nodeId, lg) => F.pickStudioAi(F.studioAiInputs(ALL, NODES, nodeId, { yes: [], absent: [], ...lg }));
const reals = [
  ["R1 ★ 아무것도 연결 안 함(중앙 · agy 깔림·모름) → claude(Antigravity 아님 — 격리 리뷰)", "", {}, "claude"],
  ["R2 중앙 · codex 만 로그인 → codex", "", { yes: ["codex"] }, "codex"],
  ["R3 중앙 · 따로 물어 agy 확인 → antigravity", "", { yes: ["antigravity"] }, "antigravity"],
  ["R4 중앙 · claude 자격 확인 실패(거짓 미로그인)·나머지도 없음 → claude(종전 유지)", "", {}, "claude"],
  ["R5 중앙 · codex 로그인인데 이 서버에 codex 가 안 깔림 → claude", "", { yes: ["codex"], absent: ["codex"] }, "claude"],
  ["R6 중앙 · claude 가 안 깔리고 아무 로그인 없음 → 띄울 수 있는 첫 AI(codex — 못 띄우는 claude 로 열지 않는다)", "", { absent: ["claude"] }, "codex"],
  ["R7 내 맥(claude·codex) · 중앙 힌트 없음 → claude", "mac", {}, "claude"],
  ["R8 내 맥(codex 만) → codex", "codexmac", {}, "codex"],
  ["R9 내 맥(claude·codex) · 중앙에서 codex 확인 → codex", "mac", { yes: ["codex"] }, "codex"],
  ["R10 하네스를 빈 목록으로 보고한 노드 = 제한 없음 → 중앙 힌트 codex 를 따른다", "old", { yes: ["codex"] }, "codex"],
  ["R11 목록에 없는 노드 id = 제한 없음 · 중앙의 «안 됨» 을 대지 않는다 → 힌트 grok", "gone", { yes: ["grok"] }, "grok"],
  ["R12 셸만 있는 PC(골라질 일은 없지만) → claude", "winsh", {}, "claude"],
];
for (const [what, nodeId, lg, want] of reals) { const got = real(nodeId, lg); check(got === want, what, { got, want }); }
const inC = F.studioAiInputs(ALL, NODES, "", { yes: ["codex"], absent: ["grok"] });
check(inC.no.includes("antigravity") && inC.no.includes("claude") && !inC.no.includes("codex") && !inC.runnable.includes("grok"), "I1 중앙: 확인 안 된 것은 전부 «안 됨» · 안 깔린 것은 후보 밖", inC);
const inN = F.studioAiInputs(ALL, NODES, "mac", { yes: ["codex"], absent: ["claude"] });
check(inN.no.length === 0 && inN.runnable.join() === "claude,codex,shell", "I2 노드: «안 됨» 없음 · 중앙의 «안 깔림» 은 노드에 대지 않는다", inN);

// 모델 · 생각 깊이 — claude opus · 높음에 맞먹는 값
const CLAUDE_M = ["fable", "opus", "sonnet", "haiku"], EFF = ["low", "medium", "high", "xhigh", "max"];
check(JSON.stringify(F.studioAiFlags("claude", CLAUDE_M, () => EFF)) === JSON.stringify({ "--model": "opus", "--effort": "high" }), "F1 claude = opus · high");
const codexEff = { "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"] };
const cx = F.studioAiFlags("codex", ["gpt-5.6-sol", "gpt-5.6-terra"], (m) => codexEff[m] || []);
check(cx["--model"] === "gpt-5.6-sol" && cx["--effort"] === "high", "F2 codex = gpt-5.6-sol · high", cx);
const ag = F.studioAiFlags("antigravity", ["gemini-3.8-flash-high", "gemini-3.8-flash-low"], () => ["low", "medium", "high"]);
check(ag["--model"] === "gemini-3.8-flash-high" && ag["--effort"] === "high", "F3 antigravity = gemini-3.8-flash-high · high", ag);
const gk = F.studioAiFlags("grok", ["grok-4.6"], () => ["low", "medium", "high", "xhigh"]);
check(gk["--model"] === "grok-4.6" && gk["--effort"] === "high", "F4 grok = grok-4.6 · high", gk);
// 카탈로그가 받지 않는 값은 그 축만 뺀다
const noModel = F.studioAiFlags("codex", ["gpt-5.5"], () => ["low", "medium", "high"]);
check(!("--model" in noModel) && noModel["--effort"] === "high", "F5 모델이 카탈로그에 없으면 모델만 뺀다", noModel);
const noEff = F.studioAiFlags("codex", ["gpt-5.6-sol"], () => ["low", "medium"]);
check(noEff["--model"] === "gpt-5.6-sol" && !("--effort" in noEff), "F6 그 모델이 high 를 안 받으면 강도만 뺀다", noEff);
const blind = F.studioAiFlags("claude", [], () => []);
check(blind["--model"] === "opus" && blind["--effort"] === "high", "F7 카탈로그를 못 받으면 표 값을 그대로(종전과 같다)", blind);
check(JSON.stringify(F.studioAiFlags("opencode", ["x"], () => ["high"])) === "{}" && JSON.stringify(F.studioAiFlags("shell", [], () => [])) === "{}", "F8 표에 없는 하네스는 아무것도 안 넘긴다");
// 고른 하네스는 늘 표에 있다(= 늘 값이 있다) — pick 의 결과로 flags 가 비지 않는다
check(rows.every(([, o]) => F.studioAiRun(pick(o)) !== null) && reals.every(([, n, lg]) => F.studioAiRun(real(n, lg)) !== null), "F9 고른 AI 는 늘 모델 · 강도 표에 있다");

// 표의 값이 서버 카탈로그(src/terminal/catalog.ts)에 실제로 있나 — 모델 이름이 바뀌면 화면이 조용히 «AI 설정 그대로» 로 떨어진다.
//  서버 빌드(dist)가 없으면 이 줄만 건너뛴다.
const catJs = join(root, "dist/terminal/catalog.js");
if (existsSync(catJs)) {
  const { HARNESSES } = await import(catJs);
  for (const r of F.STUDIO_AI) {
    const h = HARNESSES.find((x) => x.key === r.key);
    const models = h?.flags.find((f) => f.name === "--model")?.choices ?? [];
    const efforts = h?.effortsByModel?.[r.model] ?? h?.flags.find((f) => f.name === "--effort")?.choices ?? [];
    check(!!h && models.includes(r.model) && efforts.includes(r.effort), `T1 ${r.key} — ${r.model} · ${r.effort} 가 카탈로그에 있다`, { models, efforts });
  }
} else console.log("studio-ai: 서버 빌드 없음(dist/terminal/catalog.js) — 카탈로그 대조 건너뜀");

console.log(`studio-ai: ${pass} 통과 · ${fail} 실패`);
assert.equal(fail, 0);

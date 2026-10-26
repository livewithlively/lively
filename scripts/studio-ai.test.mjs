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
if (!existsSync(mod)) { console.log("studio-ai: 빌드 없음(public/app/lib/studio-ai.js) — 건너뜀"); process.exit(0); }
const F = await import(mod);
let pass = 0, fail = 0;
const check = (ok, what, extra) => { if (ok) pass++; else { fail++; console.log("FAIL ", what, extra == null ? "" : JSON.stringify(extra)); } };

const ALL = ["claude", "codex", "opencode", "antigravity", "grok", "shell"];
const pick = (o) => F.pickStudioAi({ catalog: ALL, runnable: null, yes: [], no: [], ...o });

// 고르기 — 엣지 표(행마다 하나)
const rows = [
  ["P1 claude 만 로그인 → claude(종전과 같다)", { yes: ["claude"], no: ["codex", "grok"] }, "claude"],
  ["P2 codex 만 로그인 → codex", { yes: ["codex"], no: ["claude", "grok"] }, "codex"],
  ["P3 grok 만 로그인 → grok", { yes: ["grok"], no: ["claude", "codex"] }, "grok"],
  ["P4 둘 다 로그인 → claude 먼저", { yes: ["codex", "claude"] }, "claude"],
  ["P5 codex · grok 로그인 → 표 순서(codex)", { yes: ["grok", "codex"], no: ["claude"] }, "codex"],
  ["P6 파일로 재는 셋 다 «안 됨» · agy 는 모름 → antigravity", { no: ["claude", "codex", "grok"] }, "antigravity"],
  ["P7 아무것도 모름 → claude(종전 기본)", {}, "claude"],
  ["P8 전부 «안 됨» 확인 → claude(거기서 로그인 안내)", { no: ["claude", "codex", "antigravity", "grok"] }, "claude"],
  ["P9 맥 키체인처럼 claude 가 모름 · codex 안 됨 → claude", { no: ["codex", "grok"] }, "claude"],
  ["P10 컴퓨터에 codex 만 깔림 → codex(로그인 몰라도)", { runnable: ["codex", "shell"] }, "codex"],
  ["P11 컴퓨터에 claude · codex · 중앙 로그인 힌트 codex → codex", { runnable: ["claude", "codex"], yes: ["codex"] }, "codex"],
  ["P12 로그인된 AI 를 그 컴퓨터가 못 띄움 → 띄울 수 있는 것 중 claude", { runnable: ["claude", "codex"], yes: ["grok"] }, "claude"],
  ["P13 그 컴퓨터가 claude 를 못 띄우고 전부 «안 됨» → 띄울 수 있는 첫 AI", { runnable: ["grok", "codex"], no: ["codex", "grok"] }, "codex"],
  ["P14 opencode 만 깔림 → 표에 없으니 claude(종전)", { runnable: ["opencode", "shell"] }, "claude"],
  ["P15 카탈로그 없음(옛 게이트웨이) → claude", { catalog: [], yes: ["codex"] }, "claude"],
  ["P16 카탈로그에 codex 가 없으면 로그인돼 있어도 안 고른다", { catalog: ["claude", "grok"], yes: ["codex"], no: ["claude"] }, "grok"],
];
for (const [what, o, want] of rows) { const got = pick(o); check(got === want, what, { got, want }); }

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
check(rows.every(([, o]) => F.studioAiRun(pick(o)) !== null), "F9 고른 AI 는 늘 모델 · 강도 표에 있다");

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

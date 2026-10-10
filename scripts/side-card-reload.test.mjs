// #3870 · 세션 카드가 새로고침 · 세션 전환 뒤에도 그 상태 그대로 (원준 2026-10-10 «새로고침하면 상태가 계속 달라짐. 이전꺼 기억을 못하는듯»).
//
//  실측(매니지드, 2026-10-10): ① 최소화한 카드 → 새로고침 → 펼친 카드 ② 곁칸을 골라 비치던 카드 → 새로고침 → 0.2~1.4초 뒤 터미널이
//   연결되며 스스로 초점을 가져가(terminal.ts onopen 의 term.focus()) 카드가 «골라진» 것으로 읽혀 불투명. 자리 · 크기는 그대로였다.
//
//  사양 · 엣지 표(spec-failfirst) — 런타임 행(S1~S7 · S11 · S12)은 side-card-pill-runtime.test.mjs Q7 · Q12 · Q13 이 실제 크롬에서 본다.
//   S1 최소화한 카드 → 새로고침 → 알약 그대로 · S2 펼친 카드 → 펼친 카드
//   S3 곁칸을 골라 비치는 카드 → 새로고침 → 비친 채 · 터미널이 초점을 안 가져감 · S4 카드를 골라 불투명 → 불투명(종전)
//   S5 옛 기록(card:true 만) → 펼친 카드 · 고른 것으로(종전) · S6 손잡이로 카드가 됨 → 펼친 카드 · 최소화 false 로 다시 적음
//   S7 세션 A 최소화 → 세션 B → A : B 는 펼침 · A 는 다시 알약(세션마다 적는다)
//   S8 비치는 카드에서 터미널 재연결 → 초점 안 가져감 · S9 카드가 아닐 때 재연결 → 종전대로 초점
//   S10 glass 메시지에 idle 이 없음(옛 셸) → idle 아님 → 종전대로 초점
//   S11 카드가 보이는 동안 고름이 바뀜 → 액자에 idle 을 다시 알리고 세션 기록에 적는다
//   S12 새로 도입한 보고(onState)를 받는 쪽이 없음 → 아무 일 없음
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? " : " + detail : ""}`); } };
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const card = code(read("web/v2/side-card.ts"));
const panes = code(read("web/v2/panes.ts"));
const term = code(read("web/standalone/terminal.ts"));
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ""; const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };

// ── 셸(panes.ts): 세션마다 적고 되살린다 ──
ok(/cardFold\?: boolean; cardPick\?: boolean/.test(panes), "S1·S3 세션 화면 상태에 최소화(cardFold) · 고름(cardPick) 자리가 있다");
ok(/card\?\.restore\(v\.card === true, \{ fold: v\.cardFold === true, pick: typeof v\.cardPick === 'boolean' \? v\.cardPick : undefined \}\);/.test(panes),
  "S1·S3·S5 되살릴 때 그 세션의 최소화 · 고름을 넘긴다(고름 값이 없으면 넘기지 않는다)");
ok(/onState: \(s\) => saveView\(\{ cardFold: s\.fold, cardPick: s\.pick \}\)/.test(panes), "S11 카드가 알린 최소화 · 고름을 이 세션의 것으로 적는다");

// ── 카드(side-card.ts) ──
const rs = between(card, "function restore(", "function settleSoon(");
ok(/fold = st\?\.fold === true;/.test(rs), "S1·S2·S7 적어 둔 최소화를 따른다(없으면 펼침)", rs.slice(0, 300));
ok(/picked = typeof st\?\.pick === 'boolean' \? st\.pick : true;/.test(rs), "S3·S4·S5 적어 둔 고름을 따른다(없으면 고른 것 = 종전)");
ok(/lastState = fold \+ ':' \+ picked;/.test(rs) && rs.indexOf("lastState =") < rs.indexOf("paint()"), "S7b 되살린 값을 도로 적지 않는다(앞 세션 값이 새 세션에 새지 않는다)");
ok(/wasShown = shown\(\);/.test(rs) && rs.indexOf("wasShown = shown()") < rs.indexOf("paint()"), "S3b 되살린 고름을 «다시 보이기 시작함» 의 초점 판정이 덮지 않는다");
ok(!/picked = focusInCard\(\);/.test(rs), "S3c 되살릴 때 지금 초점(새로고침 직후엔 늘 문서 바탕)으로 고름을 정하지 않는다");
const enter = between(card, "async function enter(", "async function leave(");
ok(/fold = false;/.test(enter), "S6 손잡이로 카드가 되면 펼친 카드(종전)");
const pl = between(card, "function paintLive(", "let glassKey");
ok(/const k = shown\(\) \+ ':' \+ picked;/.test(pl) && /if \(k !== glassKey\) \{ glassKey = k; postGlass\(\); \}/.test(pl) && /report\(\);/.test(pl), "S11 고름이 바뀌면 액자에 다시 알리고 셸에 보고한다", pl);
const rp = between(card, "function report(", "const glassMsg");
ok(/if \(dead \|\| !shown\(\)\) return;/.test(rp) && /if \(k === lastState\) return;/.test(rp) && /h\.onState\?\.\(\{ fold, pick: picked \}\)/.test(rp) && /try \{/.test(rp),
  "S11b · S12 보이는 동안 바뀐 것만 보고 · 받는 쪽이 없거나 실패해도 그대로", rp);
ok(/idle: shown\(\) && !picked/.test(card), "S3d 액자에 보내는 idle = 비치고 있고 사람이 카드를 고르지 않음");
ok(/fold = v;\s*paint\(\);/.test(between(card, "function setFold(", "let pillTimer")), "S1b 최소화 · 펴기는 paint → paintLive → report 로 적힌다");

// ── 터미널(terminal.ts) ──
ok(/let glassIdle = false;/.test(term), "S8 터미널이 «비치는 카드에서 고르지 않음» 을 안다");
ok(/else if \(m\.cmd === 'glass'\) \{ setGlass\(m\.on === true\); glassIdle = m\.on === true && m\.idle === true; \}/.test(term), "S10 glass 메시지의 idle 을 읽는다 — idle 이 없으면(옛 셸) 거짓");
const open = between(term, "initialSettleRedraw();", "sock.onmessage");
ok(/if \(!glassIdle\) term\.focus\(\);/.test(open) && !/^\s*term\.focus\(\);/m.test(open), "S3e·S8·S9 연결될 때 비치는(고르지 않은) 카드면 초점을 가져가지 않는다 · 아니면 종전대로", open.slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

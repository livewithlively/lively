// #2022 후속 — "지난 세션 목록이 **조용히** 8일치에서 잘리던 것" + 유령 청소기를 건별 확답으로.
//  사양·엣지 표(A1~A12 · B1~B6)는 스크래치패드 spec2.md — 아래 이름의 번호가 그 행이다(행 하나도 안 빠지게).
//
//  실측 2026-08-26: `/api/ui/v6/sessions` 가 `LIMIT 200` 으로 잘렸는데 **아무 말도 안 했다**. 한 사람의
//  200행이 7.7일치(2026-08-18 ~ 08-26)밖에 안 돼 그보다 오래된 지난 세션이 트리에서 통째로 사라졌다.
//
//  ⚠ 이 파일이 값과 소스텍스트를 함께 보는 이유: 합치는 **규칙**이 맞아도 화면이 그걸 안 부르면 그대로고,
//   서버가 `truncated` 를 안 실어 보내면 다음 사람이 또 '이게 전부'라고 믿는다. 그리고 청소기의 안전장치는
//   '어떤 함수를 쓰는가'가 곧 안전선이라(건별 확답 vs 전역 목록) 값으로는 잡히지 않는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

const { mergeLogRows, logRowSeen } = await import(join(root, "public/app/v2/log-rows.js"));
const { clampSessionListLimit, SESSION_LIST_MAX } = await import(join(root, "dist/v6/session-log-store.js"));

const STORE = read("src/v6/session-log-store.ts");
const ROUTE = read("src/sessions/session-log-routes.ts");
const MAIN = read("web/v2/main.ts");
const JANITOR = read("src/apps/instance-janitor.ts");
let JCODE;   // 주석 걷은 청소기 소스(아래 code()) — B 단언은 이걸 본다

function slice(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `구간 시작을 못 찾았다: ${from}`);
  const b = src.indexOf(to, a + 1);
  assert.ok(b > a, `구간 끝을 못 찾았다: ${to}`);
  return src.slice(a, b);
}
/** 주석을 걷어 **코드만** 남긴다 — "이 함수를 쓰지 않는다"를 단언할 때 그 이유를 적은 주석이 걸리면 안 된다
 *  (실측: 청소기 머리 주석이 `listSessionsRaw` 를 언급해 B1 이 거짓 실패했다). */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** t = '며칠째'를 ISO 로 — 값만 다르면 되므로 고정 기준일에서 민다. */
const row = (id, t) => ({ session_id: id, last_seen: new Date(Date.UTC(2026, 0, t)).toISOString() });
const ids = (rows) => rows.map((r) => r.session_id).sort().join(",");

// ══ A. 두 겹 합치기 — 값으로 본다 ════════════════════════════════════════════
ok(ids(mergeLogRows([row("a", 1), row("b", 2)], [row("y", 9), row("z", 10)])) === "a,b,y,z",
  "A1 얕은 판이 볼 수 없는 옛 구간은 캐시가 지킨다 — 이게 없으면 오래된 지난 세션이 통째로 사라진다");

{
  const merged = mergeLogRows([{ ...row("a", 1) }, { ...row("y", 9), title: "옛 제목" }], [{ ...row("y", 9), title: "새 제목" }]);
  ok(merged.length === 2 && merged.find((r) => r.session_id === "y").title === "새 제목",
    "A2 얕은 창 **안**은 얕은 판이 정본이다(제목이 바뀌면 그 값이 이긴다)");
}

//  ⚠ 지워진 행이 **얕은 창 안**에 있어야 검출된다 — 창은 [얕은 판의 가장 오래된 행, 지금] 이다.
//   m(t=5)은 얕은 판의 가장 오래된 행(x, t=3)보다 **새로우니** 창 안이고, 거기 없으므로 지워진 것이다.
//   (창 **밖**의 옛 행은 정의상 얕은 판이 못 본 자리라 지워졌다고 단정하면 안 된다 — 그게 A1 이다.)
ok(ids(mergeLogRows([row("a", 1), row("m", 5), row("y", 9)], [row("x", 3), row("y", 9)])) === "a,x,y",
  "A3 얕은 창 안에서 사라진 행은 지워진 것이다 — 캐시가 되살리지 않는다");

ok(ids(mergeLogRows([], [row("a", 1), row("b", 2), row("c", 3)])) === "a,b,c",
  "A4 캐시가 비었으면 얕은 판이 그대로 목록이다(첫 판)");

ok(ids(mergeLogRows([row("a", 1), row("b", 2), row("c", 3)], [])) === "a,b,c",
  "A5 얕은 판이 **0건**이면 창이 없다 — '전부 지워졌다'로 읽으면 목록이 통째로 사라진다(경계)");

//  ⚠ 같은 id 가 **다른 시각**으로 양쪽에 있는 경우가 진짜 위험한 자리다 — 세션이 계속 돌면 last_seen 이
//   깊은 판 이후로 밀린다(캐시엔 t=1, 얕은 판엔 t=9). 시각이 같으면 `< edge` 가 알아서 걸러 dedupe 가 안 걸린다.
ok(ids(mergeLogRows([row("a", 1)], [row("a", 9), row("b", 5)])) === "a,b"
  && mergeLogRows([row("a", 1)], [row("a", 9), row("b", 5)]).length === 2,
  "A6 같은 세션이 양쪽에 있어도 한 줄이다(두 줄이면 한 세션이 둘로 보인다)");

ok(logRowSeen({}) === 0 && logRowSeen(null) === 0 && logRowSeen({ last_seen: "쓰레기" }) === 0,
  "A7 last_seen 이 없거나 못 읽으면 0 — 가장 오래된 것으로 친다(새 필드 부재 케이스)");

// ══ A. 서버 — 깊이와 '잘렸다' ════════════════════════════════════════════════
ok(clampSessionListLimit(999999) === SESSION_LIST_MAX && SESSION_LIST_MAX >= 2000,
  "A10 요청 깊이는 상한 안으로 클램프된다(상한은 스토어 한 곳이 쥔다)");

ok(clampSessionListLimit(0) === 200 && clampSessionListLimit(-5) === 1 && clampSessionListLimit("x") === 200 && clampSessionListLimit(undefined) === 200,
  "A11 0·NaN·미지정은 기본 200, 음수는 최소 1 — 사람이 준 값으로 쿼리를 깨지 않는다");

const PAGE = () => slice(STORE, "export async function listSessionsForOwnerPage", "\nexport async function listSessionsForOwner(");
ok(/truncated: rows\.length >= want/.test(PAGE()),
  "A8·A9 요청한 만큼 꽉 찼으면 truncated — '뒤가 없다'고 단정하지 않는다(보수적)");

ok(/res\.json\(\{ sessions: rows, truncated: page\.truncated \}\)/.test(ROUTE),
  "A12 라우트가 truncated 를 함께 낸다 — 이 목록이 8일치만 보여 주면서 아무 말도 안 하던 것이 이 버그였다");

const LOAD = () => slice(MAIN, "async function loadData(", "\nconst findSess");
ok(/wantDeepLogs \? LOGS_DEEP : LOGS_SHALLOW/.test(LOAD()),
  "A13 화면은 매 틱 얕게, 이따금 깊게 부른다 — 매 틱 전량은 20초마다 수백 KB 라 안 된다");

ok(/mergeLogRows\(lastLogs, logs/.test(LOAD()) && /if \(wantDeepLogs\) \{ lastLogs = logs/.test(LOAD()),
  "A14 얕은 판은 캐시 위에 얹고, 깊은 판만 캐시를 통째로 간다");

ok(/noteTruncated\(/.test(LOAD()),
  "A15 서버가 '더 있다'고 하면 조용히 넘기지 않는다");

// ══ B. 유령 청소기 — 건별 확답 ═══════════════════════════════════════════════
JCODE = code(JANITOR);
ok(!/listSessionsRaw/.test(JCODE),
  "B1 전역 목록으로 '없더라'를 추론하지 않는다 — 그 방식은 인자 하나 없는 배포에서 안전장치째 사라진다");

ok(/if \(!\(await sessionGone\(sid\)[\s\S]{0,40}\)\) continue;/.test(JCODE),
  "B2 건별 확답 — tmux 가 '그런 세션 없다'고 답할 때만 닫는다(못 물어봤으면 손대지 않는다)");

ok(/if \(restorable\.has\(sid\)\) continue;/.test(JCODE),
  "B3 desired-state 가 있으면 유령이 아니다(되살릴 수 있는 세션)");

ok(/if \(nodeOfSession\(sid\)\) continue;/.test(JCODE),
  "B4 노드 스냅샷에 살아 있으면 손대지 않는다");

ok(/LIMIT \$2/.test(JCODE) && /MAX_PER_SWEEP/.test(JCODE),
  "B5 한 판 상한 — 건별로 tmux 에 묻기 때문에 폭주를 막는다");

ok(!/killSession|tmuxKill|deleteSessionState/.test(JCODE),
  "B6 세션을 죽이지 않는다 — 닫기만 하고, 그 세션을 다시 열면 되살아난다(되돌릴 수 있는 일만)");

console.log(`log-rows: ${pass} passed`);

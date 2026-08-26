// #2022 항목3 — "노드가 직접 띄운 세션은 서버가 기억하지 못한다".
//  사양·엣지 표(C1~C12)는 스크래치패드 spec3.md — 아래 이름의 번호가 그 행이다(행 하나도 안 빠지게).
//
//  사실관계: 노드 에이전트는 3초마다 자기 tmux 의 box-* 세션을 **전부** 밀어 올리는데(agent.ts listSessionsRaw),
//  게이트웨이는 그걸 메모리에만 담는다(registry.ts states Map). desired-state 행을 쓰는 mirrorNodeSession 은
//  **create 릴레이 직후에만** 불린다 → 그 컴퓨터에서 직접 띄운 세션은 행이 없고, 노드가 꺼지면 라이브에도
//  복원 목록에도 없는 '어디에도 없는 세션'이 된다.
//
//  ⚠ 이 파일이 소스텍스트를 보는 이유: 여기서 지켜야 할 것 대부분이 **무엇을 쓰지 않는가**다 —
//   upsert 를 쓰지 않고(좌표를 덮으니까), 좌표를 추측하지 않고, registry 가 DB 를 import 하지 않는다.
//   '안 하는 것'은 값으로 잡히지 않는다. 값으로 잡히는 것(좌표 null·표식·no-op)은 함께 값으로 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

/** 주석을 걷어 **코드만** — "이 함수를 쓰지 않는다"를 단언할 때 그 이유를 적은 주석이 걸리면 안 된다. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NSS = read("src/terminal/node-session-state.ts");
const NSS_CODE = code(NSS);
const STATE = read("src/sessions/session-state.ts");
const STATE_CODE = code(STATE);
const REG = code(read("src/node/registry.ts"));
const ROUTES = read("src/terminal/routes.ts");
const SESSIONS = read("src/terminal/sessions.ts");
const SCHEMA = read("src/org/schema/sessions-infra.ts");
const BOOT = read("src/boot/housekeeping.ts");

function slice(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `구간 시작을 못 찾았다: ${from}`);
  const b = src.indexOf(to, a + 1);
  assert.ok(b > a, `구간 끝을 못 찾았다: ${to}`);
  return src.slice(a, b);
}

const DISCOVER = () => slice(NSS_CODE, "export async function discoverNodeSessions", "\nexport function armNodeSessionDiscovery");
const INSERT = () => slice(STATE_CODE, "export async function insertDiscoveredSessionState", "\nexport async function getSessionStates");

// ══ C1~C5 — 무엇을 적는가 ════════════════════════════════════════════════════
ok(/insertDiscoveredSessionState\(\{/.test(DISCOVER()),
  "C1 스냅샷에서 처음 보는 세션은 그 자리에서 desired-state 행이 된다 — 노드가 꺼져도 목록에서 안 사라지게");

ok(/root_key: null, subpath: null/.test(DISCOVER()),
  "C2 좌표는 **비운다** — 노드는 dir 만 보고하고 그걸 좌표로 되돌리려면 그 노드의 루트 설정이 필요하다(추측 금지)");

ok(/discovered/.test(INSERT()) && /\btrue,\s*now\(\), now\(\)/.test(INSERT()),
  "C3 그 행은 discovered=true 로 박힌다 — 보이게 하되 '되살릴 수 있다'고 말하지 않기 위한 표식");

ok(/ON CONFLICT \(tenant_id, id\) DO NOTHING/.test(INSERT()) && !/DO UPDATE/.test(INSERT()),
  "C4 이미 있는 행은 **안 건드린다** — upsert 면 create 릴레이가 쓴 정확한 좌표를 3초 뒤 push 가 덮는다");

ok(/if \(!owner\) continue;/.test(DISCOVER()),
  "C5 주인을 모르는 세션은 적지 않는다 — owner 가 가시성 판정의 재료다");

// ══ C6~C7 — 얼마나 자주 묻는가 · 실패하면 ═════════════════════════════════════
ok(/seenNodeSessions/.test(DISCOVER()) && /if \(!fresh\.length\) return 0;/.test(DISCOVER()),
  "C6 처음 보는 id 가 없으면 DB 를 아예 안 묻는다(3초 push × 노드 수 만큼 쿼리가 나가면 안 된다)");

ok(/getSessionStates\(fresh\.map/.test(DISCOVER()),
  "C6b 물을 때도 한 번의 일괄 조회다(세션 수만큼 왕복하지 않는다)");

ok(/catch \(e\)[\s\S]{0,120}seenNodeSessions\.delete/.test(DISCOVER()),
  "C7 실패한 판은 '안 본 것'으로 되돌린다 — 그래야 다음 상태 보고가 다시 본다");

// ══ C8~C9 — 되살릴 수 있다고 말하지 않는다 ════════════════════════════════════
ok(/if \(st\.discovered && !st\.root_key\)[\s\S]{0,300}HttpError\(409/.test(ROUTES),
  "C8 복원은 좌표 없는 discovered 행을 거절한다 — 추측하면 그 세션이 엉뚱한 폴더에서 되살아난다");

const RESTORE_GUARD = () => slice(ROUTES, "if (st.discovered && !st.root_key)", "const resumeId = st.claude_session_id");
ok(RESTORE_GUARD().indexOf("409") < ROUTES.indexOf('rootKey: st.root_key || "shared"'),
  "C8b 그 거절은 좌표 폴백(root_key || 'shared')보다 **앞**에 선다 — 뒤에 두면 이미 추측한 뒤다");

ok(/restorable: !\(s\.discovered && !s\.root_key\)/.test(SESSIONS),
  "C9 목록도 그 행을 '복원 가능'으로 내보내지 않는다 — 화면이 약속한 뒤 409 를 받지 않게");

// ══ C10~C12 — 결합 · 스키마 · 노드 ════════════════════════════════════════════
ok(!/sessions\/session-state\.js/.test(REG) && /onNodeSessions/.test(REG),
  "C10 registry 는 DB 계층을 import 하지 않는다 — 구독(콜백 역전)으로 잇는다(onTaskDone·onWorkerState 와 같은 패턴)");

ok(/armNodeSessionDiscovery/.test(BOOT),
  "C10b 그 구독은 부팅에서 걸린다(안 걸면 스냅샷이 와도 아무 일도 안 난다)");

ok(/ADD COLUMN IF NOT EXISTS discovered BOOLEAN NOT NULL DEFAULT false/.test(SCHEMA),
  "C11 discovered 컬럼은 멱등 추가된다(기존 행은 false = 종전 의미 그대로)");

ok(/if \(ON_NODE\) return false;/.test(INSERT()),
  "C12 노드에서 실행될 땐 no-op — 노드엔 DB 가 없다(upsertSessionState 와 같은 규약)");

console.log(`node-session-discovery: ${pass} passed`);

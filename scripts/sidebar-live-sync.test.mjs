// #2041 — 배너가 뜨는 순간 사이드바도 같은 순간을 본다.
//
// 무엇이 문제였나 (상민님 2026-08-26): "세션 상태가 바뀌어서 앱에서 알림이 오는 순간 사이드바를 보면
//  아직 바뀌기 전으로 보인다." 두 표면이 같은 사건을 **다른 시계**로 봤다 —
//   · 배너   = 데스크톱 앱이 SSE 로 받는다(발행→배너 실측 평균 5ms, #1842 §6)
//   · 사이드바 = 웹 셸의 8초 폴링(v2/main.ts)
//  즉 최대 8초 동안 배너와 목록이 서로 다른 말을 한다. 그래서 셸도 같은 스트림을 구독한다.
//
// 이 파일이 지키는 것 둘:
//  ① 프레임 파서·재연결 간격의 판정 표(순수 모듈이라 컴파일 결과를 그대로 import 한다)
//  ② 배선의 성질 — 부팅이 스트림을 켜는가 · 스트림이 사이드바를 다시 읽게 하는가 ·
//     **배너를 또 만들지는 않는가**(그러면 데스크톱 앱 안에서 배너가 두 장이다) ·
//     **폴링을 끄지는 않았는가**(스트림이 끊기면 그 자리에서 이어받아야 한다)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name, detail) => { assert.ok(cond, detail ? `${name}\n${detail}` : name); pass++; console.log(`ok  ${name}`); };
const eq = (got, want, name) => { assert.deepEqual(got, want, `${name}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); };

const { parseSse, retryDelay, stableConnection } = await import(join(root, "public/app/v2/sse.js"));

// ── 1. 프레임 파서 ──────────────────────────────────────────────────────────
//  ⚠ 마지막 미완성 프레임을 그냥 파싱하면 반쪽 JSON 을 만나 **사건을 조용히 잃는다** — 그게 이 함수의 존재 이유다.
eq(parseSse('event: session\ndata: {"id":"s1"}\n\n'), { events: [{ id: "s1" }], rest: "" },
  "①완성 프레임 한 장 — 이벤트 1, 남는 조각 없음");
eq(parseSse('data: {"id":"s1"}\n\ndata: {"id":"s2"}\n\ndata: {"id"'),
  { events: [{ id: "s1" }, { id: "s2" }], rest: 'data: {"id"' },
  "②★미완성 마지막 조각은 버퍼에 남긴다 — 반쪽 JSON 을 파싱하면 그 사건이 사라진다");
eq(parseSse(": ping\n\n"), { events: [], rest: "" }, "③주석(keepalive) 프레임은 이벤트가 아니다");
eq(parseSse('data: {깨짐\n\ndata: {"id":"s2"}\n\n'), { events: [{ id: "s2" }], rest: "" },
  "④깨진 프레임 한 장이 나머지를 막지 않는다");
eq(parseSse('data: {"id":\ndata: "s1"}\n\n'), { events: [{ id: "s1" }], rest: "" },
  "⑤data 줄이 여럿이면 개행으로 잇는다(SSE 규약)");
eq(parseSse("event: session\n\n"), { events: [], rest: "" }, "⑥이벤트명만 있고 data 가 없는 프레임도 이벤트가 아니다");
eq(parseSse(""), { events: [], rest: "" }, "⑦빈 버퍼");
eq(parseSse(undefined), { events: [], rest: "" }, "⑧없는 입력도 던지지 않는다 — 첫 조각 전에 불릴 수 있다");

// ── 2. 재연결 간격 — 게이트웨이 재시작 중에 초당 재접속으로 때리지 않는다 ────────
eq(retryDelay(0), 1000, "⑨첫 재시도는 1초");
eq(retryDelay(4), 16000, "⑩상한 직전 — 지수 그대로");
eq(retryDelay(5), 30000, "⑪★경계: 32초가 될 자리에서 상한 30초가 이긴다");
eq(retryDelay(99), 30000, "⑫아무리 실패해도 상한을 넘지 않는다");
eq(retryDelay(-1), 1000, "⑬음수는 0 으로 본다");
eq(retryDelay(NaN), 1000, "⑭NaN 도 0 으로 본다 — 카운터가 오염돼도 1초 미만으로 때리지 않는다");

// ── 2-b. ★'붙었나'가 아니라 '붙어서 얼마나 살았나' ──────────────────────────
//  실측(#2041): 붙는 데 성공한 순간 카운터를 0 으로 되돌렸더니, 붙자마자 끊는 서버에 **20초에 19번**
//  재접속했다(성공 → 즉시 종료 → 백오프 0 → 1초 뒤 또). 백오프가 있는데 없는 것과 같아진다.
eq(stableConnection(0), false, "⑮붙자마자 끊긴 연결은 실패의 한 종류다 — 백오프를 되돌리지 않는다");
eq(stableConnection(9_999), false, "⑯경계 직전 — 아직 아니다");
eq(stableConnection(10_000), true, "⑰경계 — 10초를 버텼으면 정상 연결로 본다");
eq(stableConnection(undefined), false, "⑱값이 없으면 되돌리지 않는다(안전한 쪽)");

// ── 3. 배선의 성질 ──────────────────────────────────────────────────────────
const MAIN = read("web/v2/main.ts");
const LIVE = read("web/v2/live-sync.ts");
const SSE = read("web/v2/sse.ts");

// ⚠ 줄 맨 앞의 **실제 호출**만 인정한다 — 이름만 찾으면 주석 처리해도 통과한다
//  (#1842 7차에서 실제로 그런 가드를 하나 잡았다).
ok(/^\s*startLiveSync\(/m.test(MAIN), "셸 부팅이 실시간 스트림을 켠다",
  "  → 안 켜면 사이드바는 그대로 8초 뒤에야 배너를 따라잡는다(이 프로젝트의 신고 내용 그 자체).");
ok(/startLiveSync\([^;]*refreshSideSoon/.test(MAIN.replace(/\s+/g, " ")), "스트림 사건 → 사이드바 다시 읽기로 간다",
  "  → 구독만 하고 아무것도 안 하면 연결만 늘고 화면은 그대로다.");
ok(/function refreshSideSoon/.test(MAIN), "몰아 읽기(coalesce) 창이 있다",
  "  → 세션 20개가 동시에 끝나면 이벤트도 20개다(#1842 가 겨냥한 바로 그 상황). 한 건마다 다시 읽으면 요청이 20벌 나간다.");

ok(!/new Notification/.test(LIVE), "★실시간 구독은 배너를 만들지 않는다 — 다시 읽기만 한다",
  "  → 만들면 데스크톱 앱 안에서 한 사건에 배너가 두 장이다(#1842 §3 '판정은 앱 한 곳').\n"
  + "  → 다시 읽기는 몇 번 해도 결과가 같다(idempotent). 배너는 아니다 — 그 차이가 이 경계의 근거다.");
// ⚠ 이름만 찾으면 **머리말 주석에 그 단어가 있다는 이유로** 통과한다(mutation 으로 잡았다) — 실제 등록만 인정한다.
ok(/addEventListener\('visibilitychange'/.test(LIVE) && /abort\(\)/.test(LIVE), "화면이 숨으면 연결을 끊는다",
  "  → HTTP/1.1 오리진당 연결은 6개뿐이다. 탭마다 스트림을 물고 있으면 그 예산을 갉아먹는다.\n"
  + "  → 숨은 동안은 8초 폴링도 건너뛰므로 스트림을 유지할 이유가 없다(돌아오면 visibilitychange 가 한 판 당긴다).");

ok(/setInterval\([\s\S]{0,4000}?\}, 8000\);/.test(MAIN), "★8초 폴링은 그대로 남아 있다",
  "  → 스트림은 폴링의 대체가 아니라 **앞당기기**다. 끊기면 그 자리에서 폴링이 이어받아야 하고,\n"
  + "     세션 생성·이름·프로젝트처럼 스트림이 안 미는 변화는 여전히 폴링만 본다.");

ok(!/^import /m.test(SSE), "sse.ts 는 import 0 인 순수 모듈로 남는다",
  "  → 그 성질이 위 ①~⑪ 표의 근거다. DOM·fetch 를 들이는 순간 node 가 이 모듈을 못 부른다.");

console.log(`\nsidebar-live-sync: ${pass} passed`);

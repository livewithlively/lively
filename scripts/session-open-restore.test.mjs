// #1820 — "세션을 열면 반드시 살아난다"의 **배선**을 지킨다.
//
// 왜 소스 텍스트를 보나: 이 기능의 실패는 판정 함수가 틀려서가 아니라 **아무도 그 판정을 부르지 않아서** 났다.
//  실측 회귀(2026-08-14~20): 죽은 세션 메타에 restorable 을 싣는 코드는 멀쩡히 있었는데, 그 앞의 canAttach 가
//  desired(DB) 우선이 되면서(#109) 죽은 세션도 통과해 **그 분기에 영영 도달하지 못했다**. 순수 함수 테스트는
//  전부 초록이었고 기능만 죽어 있었다. 그래서 '누가 누구를 어떤 순서로 부르는가'를 여기서 못 박는다.
//
// 함께 지키는 것: 세션 주소를 만드는 곳이 하나여야 한다(그 도착지가 복원을 책임지므로).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

// ── ① 서버 — 살아있음 확인이 canAttach 보다 **앞**이다 ───────────────────────────────
{
  const src = read("src/terminal/routes.ts");
  const i = src.indexOf('app.get("/api/ui/terminal/sessions/:id"');
  assert.ok(i > 0, "단일 세션 메타 라우트를 찾지 못했습니다");
  const blk = src.slice(i, src.indexOf("app.get(", i + 10));
  const gone = blk.indexOf("await sessionGone(");
  const attach = blk.indexOf("await canAttach(");
  const dead = blk.indexOf("deadSessionMeta(");
  ok(gone > 0, "①-a 라우트가 sessionGone 으로 '지금 살아 있나'를 확인한다");
  ok(dead > 0, "①-b 라우트가 deadSessionMeta 로 복원 신호를 만든다");
  ok(attach > 0 && gone < attach,
    "①-c sessionGone 게이트가 canAttach 보다 앞에 있다 — 뒤로 가면 죽은 세션이 통과해 restorable 신호가 통째로 빠진다(2026-08-14 회귀)");
}

// ── ② 터미널 페이지 — WS 를 붙이기 **전에** 복원 게이트를 지난다 ─────────────────────
{
  const src = read("web/standalone/terminal.ts");
  const i = src.indexOf("export async function boot()");
  assert.ok(i > 0, "boot() 를 찾지 못했습니다");
  const blk = src.slice(i, src.indexOf("\n}", src.indexOf("connectNow();", i)));
  const gate = blk.indexOf("maybeRestoreOnOpen(");
  const conn = blk.lastIndexOf("connectNow();");
  ok(gate > 0, "②-a boot 이 maybeRestoreOnOpen 을 부른다");
  ok(gate < conn, "②-b 복원 게이트가 connectNow 보다 앞이다 — 뒤면 없는 세션에 붙었다 실패하는 화면이 먼저 번쩍인다");
  ok(/if\s*\(await maybeRestoreOnOpen\([^)]*\)\)\s*return;/.test(blk),
    "②-c 게이트가 true 면 연결하지 않고 반환한다(죽은 id 로 재연결 루프를 돌지 않게)");
  // 게이트는 goneMode 표를 그대로 쓴다 — 판정이 두 벌이 되면 갈린다(4410 경로와 부팅 경로가 달라진다).
  const fn = src.slice(src.indexOf("async function maybeRestoreOnOpen("));
  ok(/goneMode\(/.test(fn.slice(0, 1200)),
    "②-d 부팅 게이트가 goneMode(4410 경로와 같은 표)를 쓴다 — 판정을 두 벌로 만들지 않는다");
  // 세션 화면 안 프레임이면 스스로 갈아타지 않고 부모에게 알린다(#1808 — 프레임만 새 세션이 되는 어긋남 방지).
  ok(/function handOffToShell\([\s\S]{0,600}lively-term-gone/.test(src),
    "②-e embed 프레임은 부모에게 알리고 스스로 location 을 갈아타지 않는다");
  // **두 경로 모두** 넘겨야 한다 — 부팅(열 때)만 넘기면 '보다가 죽을 때'는 프레임이 몰래 갈아탄다.
  const gone = src.slice(src.indexOf("async function onSessionGone()"));
  ok(/handOffToShell\(/.test(fn.slice(0, 2000)) && /handOffToShell\(/.test(gone.slice(0, 2500)),
    "②-f 열 때(maybeRestoreOnOpen)와 보다가 죽을 때(onSessionGone) 둘 다 셸에 넘긴다");
}

// ── ③ 세션 화면(v2) — 멈춘 내 세션은 열자마자 되살린다 ──────────────────────────────
{
  const views = read("web/v2/views.ts");
  ok(/autoResume:\s*shouldRestoreOnOpen\(/.test(views),
    "③-a renderSession 이 autoResume 판정을 넘긴다");
  const chat = read("web/session-chat.ts");
  ok(/opts\.autoResume\s*&&\s*!resumeAuto/.test(chat),
    "③-b 대화창이 autoResume 을 받아 (한 번만) 되살린다");
  ok(/lively-term-gone/.test(chat),
    "③-c 프레임이 보낸 '박스 없음' 신호를 셸이 받아 라우팅까지 쥔다");
  const status = read("web/session-status.ts");
  ok(/export function shouldRestoreOnOpen/.test(status),
    "③-d 판정은 공용 모듈에 있다(화면마다 다른 술어를 쓰지 않게)");
  // #1851 — 휴지통에 있는 세션은 열어도 되살리지 않는다(판정표 한 줄). 화면(views.ts)이 trashed 를 판정표에 넘겨야
  //  이 규칙이 실제로 작동한다 — 판정표만 고치고 호출처가 안 넘기면 조용히 무효가 된다.
  ok(/trashed\?:\s*boolean/.test(status) && /!s\.trashed/.test(status),
    "③-e 판정표가 trashed 를 받아 휴지통 세션은 되살리지 않는다");
  ok(/autoResume:\s*shouldRestoreOnOpen\(\{[^}]*trashed:\s*isTrashedSess\(s\)/.test(views),
    "③-f 화면이 휴지통 여부를 판정표에 넘긴다");
}

// ── ④ 세션 주소를 만드는 곳은 하나다 ────────────────────────────────────────────────
//  트리거가 아니라 **도착지**가 복원을 책임지는 구조라, 도착지로 가는 주소를 아무 데서나 조립하면
//  그 구조가 조용히 새어나간다. 새 트리거는 sessionTermUrl/openSessionWindow 만 부르면 된다.
{
  const ALLOW = new Set([
    "web/lib/session-open.ts",              // 정본
    "web/standalone/terminal.ts",           // 별도 번들(클래식 <script> — web/lib 을 import 하지 않는다). 자기 자신이 도착지다.
  ]);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(root, rel)).isDirectory()) { walk(rel); continue; }
      if (!/\.ts$/.test(name)) continue;
      if (ALLOW.has(rel)) continue;
      if (read(rel).includes("terminal.html?session=")) hits.push(rel);
    }
  };
  walk("web");
  ok(hits.length === 0,
    `④세션 주소를 직접 조립하는 파일이 없다 — web/lib/session-open.ts 를 쓰세요${hits.length ? ` (위반: ${hits.join(", ")})` : ""}`);
}

// ── ⑤ 목록 카드의 복원은 '되살린 세션'을 화면이 곧바로 그릴 수 있게 넘긴다 ──────────────
//  복원은 **새 id** 를 만든다. 그 id 로 주소를 옮겼는데 목록 폴링이 아직 모르면 "세션을 찾을 수 없어요"가 뜬다.
{
  const chat = read("web/session-chat.ts");
  const i = chat.indexOf("async function resumeSession(");
  const blk = chat.slice(i, i + 1600);
  ok((blk.match(/rememberCreated\(/g) || []).length >= 2,
    "⑤복원·이어받기 둘 다 생성 응답을 created-cache 에 남긴다(새 id 로 옮긴 직후의 '세션을 찾을 수 없어요' 방지)");
}

console.log(`\n${pass}건 통과`);

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

// ── ③ 세션 화면(v2) — **보기만 해서는 안 되살린다**(#2439) ──────────────────────────
//  ⚠ 종전 규칙은 «열자마자 되살린다»(#1820)였다. 그 전제는 «이 화면에 온 것 자체가 쓰겠다는 뜻» 인데,
//   그건 읽는 화면과 일하는 화면이 **갈려 있을 때**만 참이었다. 이제 한 화면이라 «읽으러 왔다» 와
//   «일하러 왔다» 가 겉으로 구분되지 않는다 — 그러면 읽기만 해도 컨테이너가 뜬다.
//   그게 이 프로젝트의 첫 요구사항이 지목한 오버헤드다(상민님: "실제 뜨는 시점은 프롬프트를 보낸 시점").
//  → 되살릴 수 있으면(canRevive) **기다린다.** 말을 걸거나 터미널을 열면 그때 되살아난다.
//  → 되살릴 수 **없는** 세션은 종전대로 자동 경로를 탄다(기다릴 이유가 없다).
{
  const views = read("web/v2/views.ts");
  ok(/autoResume:\s*shouldRestoreOnOpen\(/.test(views),
    "③-a renderSession 이 autoResume 판정을 넘긴다");
  const chat = read("web/session-chat.ts");
  ok(/opts\.autoResume\s*&&\s*!canRevive\(\)\s*&&\s*!resumeAuto/.test(chat),
    "③-b ★ 되살릴 수 있는 세션은 **열었다고 되살리지 않는다** — 말을 걸 때까지 기다린다");
  ok(/m\.canRestore\s*&&\s*!canRevive\(\)/.test(chat),
    "③-b2 프레임이 «박스 없음» 을 알려 온 자리도 같은 규칙(판정이 두 벌이면 한쪽이 먼저 되살린다)");
  ok(/if \(m === 'term' && canRevive\(\)/.test(chat),
    "③-b3 ★ 터미널을 여는 것은 «쓰겠다» 다 — 그때는 되살린다(안 그러면 붙을 tmux 가 없는 빈 터미널이 뜬다)");
  ok(/lively-term-gone/.test(chat),
    "③-c 프레임이 보낸 '박스 없음' 신호를 셸이 받아 라우팅까지 쥔다");
  const status = read("web/session-status.ts");
  ok(/export function shouldRestoreOnOpen/.test(status),
    "③-d 판정은 공용 모듈에 있다(화면마다 다른 술어를 쓰지 않게)");
  // ── #2439 ②③ — 멈춘 세션에 **말을 거는 것만으로** 되살아난다 ──────────────────────
  //  자동 복원(③-b)이 있어도 이 경로가 필요하다: 자동은 실패하거나(노드 오프라인·좌표 없음), 보이지 않는
  //  탭이거나, 연쇄 상한에 걸리면 돌지 않는다(#1834). 그때 입력창이 덮여 있으면 그 화면은 **막다른 길**이다.
  ok(/const canRevive = \(\): boolean =>/.test(chat),
    "③-g «말을 걸면 되살아날 수 있나» 축이 있다");
  ok(/if \(canRevive\(\)\) \{\s*\n\s*view\.setFooter\(null\);/.test(chat),
    "③-h 되살릴 수 있는 세션은 footer 로 입력창을 덮지 않는다(setFooter 는 폼을 숨긴다)");
  ok(/if \(!canType\(\) && canRevive\(\)\) \{ await reviveWithPrompt\(text\); return; \}/.test(chat),
    "③-i 멈춘 세션에 보내면 되살리기 경로로 간다");
  //  ⚠ 순서가 계약이다 — 되살리기 → **말 전달** → 라우팅. 옮겨 간 뒤에 보내면 이 컴포넌트는 destroy 된
  //   뒤라 실패해도 아무도 모른다. beforeRoute 훅이 그 순서를 강제한다.
  ok(/if \(beforeRoute\) await beforeRoute\(nextId\);[\s\S]{0,200}?opts\.onResumed\(nextId\)/.test(chat),
    "③-j 되살린 세션에 말을 넣는 일이 화면 이동보다 먼저다");
  ok(/rememberFirstPrompt\(newId, text\)/.test(chat) && /export function rememberFirstPrompt/.test(read("web/v2/quick-session.ts")),
    "③-k 방금 친 말이 옮겨 간 화면에서도 보이게 첫 지시로 등록된다");
  // #1851 — 휴지통에 있는 세션은 열어도 되살리지 않는다(판정표 한 줄). 화면(views.ts)이 trashed 를 판정표에 넘겨야
  //  이 규칙이 실제로 작동한다 — 판정표만 고치고 호출처가 안 넘기면 조용히 무효가 된다.
  ok(/trashed\?:\s*boolean/.test(status) && /!s\.trashed/.test(status),
    "③-e 판정표가 trashed 를 받아 휴지통 세션은 되살리지 않는다");
  ok(/autoResume:\s*shouldRestoreOnOpen\(\{[^}]*trashed:\s*isTrashedSess\(s\)/.test(views),
    "③-f 화면이 휴지통 여부를 판정표에 넘긴다");
  // 2026-08-26 — 프레임이 "되살릴 수 있다"고 말했으면 **그 말을 이어받기 분기까지 들고 간다**. 목록 행의
  //  restorable 만 보면, 목록이 좌표를 접느라 그 값을 못 받은 세션이 대화록 기반 이어받기로 흘러 빈 새 세션이 된다
  //  (실측: 프로젝트 하나에 「새 세션(원본 기반)」 4개). 신호를 만들어 놓고 안 넘기면 조용히 무효가 되는 자리다.
  //  ⚠ 창을 900자로 잡는다 — 같은 핸들러 안에 #2231(이미 이어진 세션이면 그리로 옮긴다)이 **먼저** 서 있다.
  //   그 분기가 앞서는 건 의도다(되살리면 같은 대화가 둘이 된다). 창이 좁으면 배선이 멀쩡한데 테스트만 빨개진다.
  ok(/lively-term-gone[\s\S]{0,900}resumeSession\(\s*null\s*,\s*\{[^}]*canRestore:\s*true/.test(chat),
    "③-g 프레임이 말한 canRestore 를 resumeSession 에 넘긴다");
  // ★ #2231 — 그 핸들러에서 **이정표(movedTo)가 canRestore 보다 앞**이어야 한다. 순서가 뒤집히면 이미 이어진
  //  세션을 한 번 더 되살려 같은 대화가 둘로 갈라진다(그리고 옛 화면은 계속 막다른 길에 남는다).
  {
    const h = chat.slice(chat.indexOf("lively-term-gone"));
    const iMoved = h.indexOf("m.movedTo");
    const iRestore = h.indexOf("m.canRestore");
    ok(iMoved > 0 && iRestore > 0 && iMoved < iRestore,
      "③-i 이미 이어진 세션이면 되살리기 전에 그리로 옮긴다(movedTo 가 canRestore 보다 먼저)");
  }
  ok(/if\s*\(isBox\s*&&\s*\(target\.raw\?\.restorable\s*\|\|\s*hint\?\.canRestore\)\)/.test(chat),
    "③-h 복원 분기가 목록의 restorable **또는** 프레임이 말한 canRestore 를 본다(둘 중 하나면 /restore)");
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
  const blk = chat.slice(i, i + 2200);   // #2231 로 이 함수에 이정표(movedTo) 처리가 들어와 길어졌다 — 창을 넓힌다
  ok((blk.match(/rememberCreated\(/g) || []).length >= 2,
    "⑤복원·이어받기 둘 다 생성 응답을 created-cache 에 남긴다(새 id 로 옮긴 직후의 '세션을 찾을 수 없어요' 방지)");
}

console.log(`\n${pass}건 통과`);

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
  //  #3752 ④ — 판정자가 `sessionGone` → `sessionGoneVerdict` 로 넓어졌다(«모름» 을 «살아 있음» 으로 접지
  //   않으려고). 이 가드가 지키는 것은 **판정을 하느냐와 그 순서**이지 함수 이름이 아니므로 둘 다 받는다.
  const gone = blk.search(/await sessionGone(Verdict)?\(/);
  const attach = blk.indexOf("await canAttach(");
  const dead = blk.indexOf("deadSessionMeta(");
  ok(gone > 0, "①-a 라우트가 sessionGone(Verdict) 으로 '지금 살아 있나'를 확인한다");
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
  //   #3847 이 그 사이에 한 분기(액자 걷기)를 더하며 900자를 넘겼다 — 재는 것은 «같은 핸들러 안인가» 다.
  ok(/lively-term-gone[\s\S]{0,1400}resumeSession\(\s*null\s*,\s*\{[^}]*canRestore:\s*true/.test(chat),
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
  //  ⚠ isBox 는 **함수**다(2026-09-08) — 종전엔 마운트 시점 `first.live` 로 얼어 있었는데, 그 한 틱에 행이
  //   잠깐 «중단됨»으로 보이면 그 탭이 영영 대화창에 갇혔다(터미널도 수기 전환 메뉴도 사라진다). 지금의 행으로 답한다.
  ok(/if\s*\(isBox\(\)\s*&&\s*\(target\.raw\?\.restorable\s*\|\|\s*hint\?\.canRestore\)\)/.test(chat),
    "③-h 복원 분기가 목록의 restorable **또는** 프레임이 말한 canRestore 를 본다(둘 중 하나면 /restore)");
  // ── #3847 — **프레임이 «박스 없음» 을 알리면 액자를 걷고 대화로 내려앉는다** ──────────────────
  //  왜(실측 2026-09-10 상민님 신고): 목록의 라이브 판정은 tmux 관측이라 흔들린다(중계가 못 보면 DB desired 행이
  //   observed:false 라이브 행으로 나가고 — #2544 — 회수 직후엔 한동안 라이브로 남는다. 같은 목록이 3분 사이
  //   라이브 168/중단 10 → 라이브 24/중단 154 로 뒤집혔다). 그 틱에 열면 화면은 터미널을 얹고, 프레임은 단건
  //   메타(has-session 확답)로 «중단됨» 을 받아 배너를 띄운다 — 사람이 보는 것은 그 배너 한 줄뿐이었다
  //   (대화도, 말 걸 입력창도, 이 화면의 안내 setNote 도 액자에 가린다).
  //  ⚠ 그러면서 **얼지는 않아야 한다**(2026-09-08 교훈) — 아래 세 줄이 그 균형을 지킨다.
  ok(/function dropTermFrame\(/.test(chat) && /dropTermFrame\(!!m\.canRestore\)/.test(chat),
    "③-l ★ 프레임이 '박스 없음'을 알리면 액자를 걷는다(대화·입력창이 배너에 가리지 않게)");
  ok(/goneByFrame = true;[\s\S]{0,500}setMode\('chat'\)/.test(chat),
    "③-m 액자를 걷은 뒤 대화 화면으로 내려앉는다");
  ok(/const dead = \(\): boolean => goneByFrame \|\|/.test(chat),
    "③-n 프레임이 말한 '박스 없음'이 목록의 라이브 판정을 이긴다 — 그래야 입력창이 '보내면 이어서 열립니다'로 동작한다");
  ok(/if \(goneByFrame && t\.live && t\.alive && !t\.raw\?\.restorable\) goneByFrame = false;/.test(chat),
    "③-o ★ 얼리지 않는다 — 행이 다시 '살아 있다'고 오면 걸쇠가 풀린다(2026-09-08 의 영구 갇힘 재발 금지)");
  ok(/if \(m === 'term'\) goneByFrame = false;/.test(chat),
    "③-p 사람이 터미널을 고르면 그 자리에서 걸쇠가 풀린다(수기 전환의 문은 늘 열려 있다)");
  ok(/termGoneN < 2 && mode === 'chat'/.test(chat),
    "③-q 자동 되돌리기는 한 번만 다시 시도한다 — blip 출구는 남기고 터미널↔대화 왕복은 막는다");
  //  #3891 이 같은 줄에 «전달 못 한 글을 들고 왔으면 대화로» 를 한 항 더 붙였다 — 재는 것은 observed:false 항이 살아 있나다.
  ok(/setMode\(chatHome\(\) \|\| target\.raw\?\.observed === false (\|\| draftBack )?\? 'chat' : 'term'\)/.test(chat),
    "③-r 서버가 '관측 못 함'(#2544 observed:false)이라 한 세션은 터미널이 아니라 대화로 연다");
  // 액자 안에서 복원하면 **액자인 채로** 옮겨야 한다 — embed 를 빠뜨리면 레거시 터미널 크롬이 액자 안에 또 뜬다.
  {
    const term = read("web/standalone/terminal.ts");
    const rs = term.slice(term.indexOf("async function restoreThisSession()"));
    ok(/location\.replace\([\s\S]{0,400}EMBED \? '&embed=1' : ''/.test(rs),
      "③-s 복원으로 옮겨 갈 때 embed=1 을 이고 간다(액자 안 레거시 상단바 이중 표시 방지)");
  }
}

// ── ③-T 터미널로 가는 문은 **얼면 안 된다** (2026-09-08 상민님 신고 · 재현 완료) ─────────────
//  증상: 살아서 도는 세션인데 웹으로 열면 대화창만 뜨고, 터미널도 없고, [⋯ ▸ 보기]에 수기 전환 줄조차 없다.
//  뿌리: `terminalSrc`(v2/views.ts) 와 `isBox`(session-chat.ts) 가 **마운트 시점 값**이었다. 매니지드에서는
//   세션 목록 한 틱이 허브 stall 로 19초씩 늦으며 살아 있는 세션을 잠깐 «중단됨» 으로 실어 온다(실측
//   2026-09-08 07:59:50 — 한 응답에서 restorable 112→105, 같은 세션이 3초 뒤 되돌아옴). 그 틱에 화면이
//   붙으면 두 값이 «터미널 없음» 으로 굳고, 터미널로 가는 문이 **전부** 그 뒤에 있어(모드 전환·iframe·
//   [⋯ ▸ 보기]·«터미널에서 답하기»·update 의 되돌리기) 그 탭은 스스로 못 빠져나왔다. panes-parts 의
//   mountStage 는 `mounted.ok` 라 다시 붙이지도 않는다 → 새로고침 전까지 영구.
//  → 규칙: 둘 다 **지금의 행**에 묻는다. 판정 규칙 자체는 여전히 views.ts 한 줄이다(두 벌 금지).
{
  const views = read("web/v2/views.ts");
  ok(/const termSrc = \(t: SessionChatTarget\): string \| null =>/.test(views) && /terminalSrc: termSrc,/.test(views),
    "③-T1 views 가 터미널 주소를 **함수**로 넘긴다(마운트 시점 문자열로 얼리지 않는다)");
  const chat = read("web/session-chat.ts");
  ok(/const isBox = \(\): boolean => target\.live/.test(chat),
    "③-T2 isBox 는 first(마운트 시점)가 아니라 target(지금의 행)을 본다");
  ok(/const termUrl = \(\): string \| null => \(opts\.terminalSrc \? opts\.terminalSrc\(target\) : null\)/.test(chat)
    && /const hasTerm = \(\): boolean => !!termUrl\(\) && isBox\(\)/.test(chat),
    "③-T3 터미널 가용 판정은 hasTerm() 한 술어로 모인다");
  // 문(門)들이 그 술어를 지나는가 — 하나라도 옛 값을 직접 보면 그 문만 얼어붙는다.
  ok(!/opts\.terminalSrc\s*&&/.test(chat) && !/!opts\.terminalSrc/.test(chat),
    "③-T4 opts.terminalSrc 를 **직접 조건으로 쓰지 않는다** — 전부 hasTerm() 을 지난다");
  ok(/if \(m === 'term' && !hasTerm\(\)\) m = 'chat'/.test(chat),
    "③-T5 setMode 의 강등이 지금의 가용성으로 판정한다");
  //  ⚠ 조건이 **더 붙는 것**은 막지 않는다 — #3847 이 «프레임이 박스 없음을 두 번 말한 뒤엔 자동으로 되돌리지
  //   않는다»(termGoneN)를 더했다. 그건 출구를 닫는 것이 아니라 **왕복을 멈추는 것**이고(첫 회복은 여전히 시도한다),
  //   수기 전환은 그대로다. 여기서 재는 것은 «그 출구가 hasTerm() 을 지나 살아 있는가» 다.
  ok(/!modeChosen && [^;\n]{0,24}mode === 'chat' && !chatHome\(\) && String\(target\.raw\?\.chatMode \|\| ''\) === 'tmux' && hasTerm\(\)/.test(chat),
    "③-T6 ★ blip 에서 스스로 빠져나오는 출구 — 행이 건강해지면 다음 갱신에 터미널로 돌아온다");
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
  //  창은 **함수 본문**으로 자른다(#3891) — 종전 고정 2200자 창은 #2231(이정표)·#3891(끊김 재시도) 로 함수가 길어질
  //   때마다 배선이 멀쩡한데 빨개졌다. 재는 것은 «이 함수 안에 둘 다 있나» 다.
  const blk = chat.slice(i, chat.indexOf("\n  }\n", i));
  ok((blk.match(/rememberCreated\(/g) || []).length >= 2,
    "⑤복원·이어받기 둘 다 생성 응답을 created-cache 에 남긴다(새 id 로 옮긴 직후의 '세션을 찾을 수 없어요' 방지)");
}

// ── ⑥ 목록이 «이미 이어진(은퇴한) id» 를 내보내지 않는다 (#2231 후속 · 2026-09-04 신고) ────────
//  ①과 같은 종류의 실패다: 판정은 멀쩡한데 **한쪽 경로가 그 판정을 안 부른다.** 목록의 DB 절반
//  (listAllSessionStates)은 superseded_by 로 거르는데, 라이브 관측(tmux)·노드 스냅샷은 안 거른다 —
//  이어진 뒤에도 옛 tmux 가 남아 있으면 그 id 가 «살아 있는 세션»으로 사이드바에 다시 오르고,
//  누르면 개별 조회가 movedTo 를 내 화면이 이어진 세션으로 튕긴다(그 세션이 죽어 있으면 무한 리로드).
//  실측: 은퇴 100건 중 7건이 목록에 올라 있었다.
{
  const src = read("src/terminal/routes.ts");
  const i = src.indexOf('app.get("/api/ui/terminal/sessions"');
  assert.ok(i > 0, "세션 목록 라우트를 찾지 못했습니다");
  const blk = src.slice(i, src.indexOf("res.json({ sessions: merged })", i));
  const merge = blk.indexOf("mergeSessionViews(");
  const retired = blk.indexOf("retiredSessionIds(");
  ok(retired > 0, "⑥-a 목록이 retiredSessionIds 로 은퇴행을 묻는다");
  ok(merge > 0 && merge < retired,
    "⑥-b 은퇴행 필터가 병합 **뒤**다 — 라이브·노드·복원가능 세 출처를 한꺼번에 걸러야 한 곳이라도 새지 않는다");
}

// ── ⑦ 이동(moved)도 연쇄에 상한이 있다 — 이동↔복원이 번갈아 돌면 어느 상한도 안 세던 자리 ────────
{
  const chat = read("web/session-chat.ts");
  ok(/function movedHopAllowed\(/.test(chat), "⑦-a 이동 연쇄 상한 판정이 있다");
  const i = chat.indexOf("lively-term-gone");
  const blk = chat.slice(i, i + 1200);
  ok(blk.indexOf("movedHopAllowed()") > 0 && blk.indexOf("movedHopAllowed()") < blk.indexOf("이어진 세션으로 옮겼습니다"),
    "⑦-b 프레임발 자동 이동이 옮기기 **전에** 상한을 묻는다");
}

// ── ⑧ 살아 있는 세션을 «복원 가능» 으로 답하지 않는다 — 그리고 already 는 새로고침이 아니다 ────────
//  실측 2026-09-09: admin 계정으로 **남의 살아있는 세션** 링크를 열면 화면이 '연결 준비 중…' 과 새로고침만
//  반복했다. 원인은 판정이 두 자리에서 갈린 것 — 메타 라우트는 canAttach 실패(권한 없음)를 deadSessionMeta 로
//  흘려 restorable 을 냈고(admin 은 소유자와 같은 축이라 kind:"ok"), 복원 라우트는 같은 tmux 를 보고
//  already:true 를 냈으며, 화면은 그 답에 location.reload() 로 응답했다. 셋이 맞물려 무한 루프가 됐다.
//  두 자리를 함께 잠근다: ⓐ 살아 있다는 확답이면 복원 신호를 만들지 않는다 ⓑ already 는 문서를 다시 받지 않는다.
{
  const src = read("src/terminal/routes.ts");
  const i = src.indexOf('app.get("/api/ui/terminal/sessions/:id"');
  const blk = src.slice(i, src.indexOf("app.get(", i + 10));
  const attach = blk.indexOf("await canAttach(");
  ok(i > 0 && attach > 0, "⑧-a0 메타 라우트와 그 안의 canAttach 게이트를 찾았다 — 못 찾으면 아래 가드가 공허하게 통과한다");
  const after = blk.slice(attach);
  ok(after.indexOf("deadSessionMeta(") === -1,
    "⑧-a canAttach 실패 갈래는 복원 신호를 만들지 않는다 — 그 자리에 온 이유는 죽음이 아니라 권한이다. 살아 있는 세션에 복원을 약속하면 부팅 게이트가 복원으로 가고 already 가 돌아온다(무한 새로고침)");

  const term = read("web/standalone/terminal.ts");
  const rs = term.slice(term.indexOf("async function restoreThisSession()"));
  const alreadyAt = rs.indexOf("r.already");
  ok(alreadyAt > 0, "⑧-b0 restoreThisSession 의 already 분기를 찾았다");
  const already = rs.slice(alreadyAt, rs.indexOf("\n", alreadyAt));   // 그 한 줄만 — 거리 창은 다음 분기까지 새어 오판한다
  ok(!/location\.reload\(/.test(already),
    "⑧-b already 응답에 새로고침으로 답하지 않는다 — 같은 부팅 게이트로 돌아가 제자리를 돈다");
  const alive = term.slice(term.indexOf("function resumeAlive()"));
  const aliveBody = alive.slice(0, alive.indexOf("\n}"));   // 함수 본문만 — 거리 상한(길이에 취약)이 아니라 블록으로 자른다
  ok(/resumeAlive\(\)/.test(already) && /connectNow\(\)/.test(aliveBody),
    "⑧-c already 는 그 자리에서 재연결한다(살아 있다면 할 일은 붙는 것뿐 — 못 붙으면 WS 가 4403/4410 로 사유를 준다)");
  ok(/sessionEnded = false/.test(aliveBody),
    "⑧-d 재연결 전에 종료 확정 플래그를 되돌린다 — 안 되돌리면 connectNow 가 즉시 반환해 화면이 영원히 '이어서 여는 중…' 이다");
}

// ── ⑨ 4403(입장 거부) 재시도 상한이 실제로 찬다 — «열렸다» 는 허가의 반증이 아니다 ────────────
//  실측 2026-09-09: 남의 세션을 열면 「연결 확인 중… (14회째)」 로 6초 간격 무한 재시도가 돌았다.
//  서버는 조용히 끊지 않으려 handleUpgrade 로 핸드셰이크를 완료한 뒤 close(4403) 하므로(#835) 거부에서도
//  onopen 이 뜨는데, onopen 이 denyRetries 를 0 으로 되돌리고 있어 MAX_DENY_RETRIES 가 영영 안 찼다.
{
  const term = read("web/standalone/terminal.ts");
  const openAt = term.indexOf("sock.onopen = () => {");
  ok(openAt > 0, "⑨-0 onopen 핸들러를 찾았다");
  const openBody = term.slice(openAt, term.indexOf("\n  };", openAt));
  ok(!/^\s*[^/\n]*denyRetries\s*=\s*0/m.test(openBody),
    "⑨-a onopen 이 denyRetries 를 되돌리지 않는다 — 4403 은 open 뒤에 오므로 여기서 되돌리면 상한이 영영 안 찬다");
  const msgAt = term.indexOf("sock.onmessage = (e) => {");
  const msgBody = term.slice(msgAt, term.indexOf("\n  };", msgAt));
  ok(/denyRetries = 0/.test(msgBody),
    "⑨-b 대신 첫 수신 바이트에서 되돌린다 — 서버가 보낸 바이트만이 입장 허가의 증거다");
}

// ── ⑩ 복원이 **도중에 끊겨도** 보낸 말을 잃지 않고, 다시 불러도 같은 대화를 둘로 만들지 않는다 (#3891) ─────────
//  실측(2026-09-11 08:45:00Z 매니지드, 상민님 신고): 회수된 세션 대화창에서 보냈는데 복원 요청이 롤 교대에 잘렸다 —
//   게이트웨이 SIGTERM 15ms 뒤 새 세션(d78e541c)의 메타 relay 가 죽었다. 새 세션은 떠 있었고 옛 행은 이정표 없이
//   남아 사이드바에 같은 세션이 두 줄 섰다. 화면은 실패를 삼키고(resumeSession 이 오류를 안 돌려줬다) 제자리 ·
//   보낸 말은 한 번도 전송되지 않았다. 새 줄을 누르면 이미 Claude Code 가 떠 있었고, 그 순간 두 줄이 하나로 접히며
//   대화창 쪽이 사라졌다(훅이 새 세션의 대화 id 를 보고해 목록이 접었다).
//  배선 넷(화면) + 셋(서버) — 판정 값은 restore-retry.test.mjs · src/terminal/restore-adopt.test.ts 가 잰다.
{
  const chat = read("web/session-chat.ts");
  const resume = chat.slice(chat.indexOf("async function resumeSession("));
  const resumeBody = resume.slice(0, resume.indexOf("\n  }\n"));
  // C1 — 복원 요청만 다시 묻는다. 이어보기(v6 resume)는 멱등이 아니라(부를 때마다 «이어보기» 세션이 선다) 안 건다.
  const wr = resumeBody.indexOf("withRetry(");
  ok(wr > 0 && /\/restore`/.test(resumeBody.slice(wr, resumeBody.indexOf(");", resumeBody.indexOf("/restore`", wr)) + 2)),
    "⑩-C1a ★ 복원 요청(/restore)은 끊김 재시도(withRetry)를 거친다 — 롤 교대에 잘린 요청을 제자리에서 다시 묻는다");
  const v6 = resumeBody.split("\n").filter((l) => l.includes("/api/ui/v6/sessions/") && l.includes("/resume?node="));
  ok(v6.length === 1 && !/withRetry/.test(v6[0]),
    "⑩-C1b 이어보기(v6 …/resume)는 다시 묻지 않는다 — 응답만 잃었으면 세션이 하나 더 선다");
  // C2 — 옮겨 갔는지를 돌려주고, 말로 되살리던 쪽이 실패를 제자리에서 마감한다(입력칸에 글 돌려주기).
  ok(/async function resumeSession\([^\n]*\): Promise<boolean> \{/.test(chat)
    && /opts\.onResumed\(nextId\);\s*\n\s*else location\.hash = [^\n]*\n\s*return true;/.test(resumeBody)
    && /btn\.textContent = orig \|\| '이어서 대화하기'; \}\s*\n\s*return false;/.test(resumeBody),
    "⑩-C2a resumeSession 이 옮겨 갔나(true/false)를 돌려준다 — 종전엔 실패를 삼켜 부른 쪽이 몰랐다");
  const revive = chat.slice(chat.indexOf("async function reviveWithPrompt("), chat.indexOf("async function resumeSession("));
  ok(/routed = await resumeSession\(/.test(revive) && /if \(routed \|\| destroyed\) return;/.test(revive)
    && /view\.input\.value = text;/.test(revive.slice(revive.indexOf("if (routed || destroyed) return;"))),
    "⑩-C2b ★ 끝내 못 열면 말풍선을 마감하고 친 글을 입력칸에 돌려준다(«이어서 여는 중…» 에 멈추지 않는다)");
  // C3 — 복원은 됐는데 말 전달만 실패해도 옮겨 간다. 그 글은 옮겨 간 화면의 입력칸으로.
  //  훅 본문은 **resumeSession 호출이 끝나는 자리**(finally)까지로 자른다 — 첫 `});` 로 자르면 api 호출 줄에서 끊겨
  //   catch 안의 throw 를 못 본다(뮤테이션으로 확인한 공허).
  const hook = revive.slice(revive.indexOf("async (newId) =>"), revive.indexOf("} finally { reviving = false; }"));
  ok(/try \{\s*\n\s*await api\(`\/api\/ui\/terminal\/sessions\/\$\{encodeURIComponent\(newId\)\}\/prompt`/.test(hook)
    && /takeFirstPrompt\(newId\);/.test(hook) && /rememberUnsentDraft\(newId, text\);/.test(hook) && hook.length > 0 && !/\bthrow\b/.test(hook),
    "⑩-C3a ★ 말 전달 실패가 라우팅을 막지 않는다 — 제자리에 남으면 두 줄·갇힘이 그대로다(글은 새 화면 입력칸으로)");
  ok(/draft: takeUnsentDraft\(s\.id\)/.test(read("web/v2/views.ts")) && /if \(opts\.draft && !view\.input\.value\) \{\s*\n\s*view\.input\.value = opts\.draft;/.test(chat),
    "⑩-C3b 옮겨 간 화면이 못 간 글을 입력칸에 되돌려 둔다(보낸 척 그리지 않는다)");
  ok(/const draftBack = !!opts\.draft && view\.input\.value === opts\.draft;\s*\n\s*if \(draftBack\) modeChosen = true;\s*\n\s*setMode\([^\n]*\|\| draftBack \? 'chat' : 'term'\);/.test(chat),
    "⑩-C3c ★ 그 글이 **보이는** 대화로 연다 — 터미널이 첫 화면이면 입력칸이 숨어 «입력칸에 넣어 두었어요» 가 거짓말이 된다");
  // C4 — 되살리는 중 또 보내면 복원을 하나 더 띄우지 않는다.
  const guardAt = revive.indexOf("if (reviving) {");
  ok(guardAt > 0 && guardAt < revive.indexOf("addPending(text)") && /reviving = true;/.test(revive) && /finally \{ reviving = false; \}/.test(revive),
    "⑩-C4 되살리는 중의 재전송은 두 번째 복원을 띄우지 않는다(친 글은 입력칸으로)");
}
{
  const src = read("src/terminal/routes.ts");
  const i = src.indexOf('app.post("/api/ui/terminal/sessions/:id/restore"');
  assert.ok(i > 0, "복원 라우트를 찾지 못했습니다");
  //  라우트 끝은 `})));` 다(restoreSerial.wrap 이 한 겹 더 감쌌다) — 못 찾으면 다음 라우트까지 새어 오판하므로 멈춘다.
  const end = src.indexOf("\n  })));", i);
  assert.ok(end > i, "복원 라우트의 끝(restoreSerial.wrap 로 감싼 `})));`)을 찾지 못했습니다");
  const blk = src.slice(i, end);
  // S4 — 같은 세션의 복원은 한 줄로 돈다. 뒤 요청은 **줄 안에서** 행을 다시 읽는다(줄 밖에서 읽으면 낡은 판정으로 만든다).
  const head = src.slice(i, src.indexOf("\n", i));
  ok(/wrap\(restoreSerial\.wrap\(\(req: express\.Request\) => `\$\{currentTenant\(\)\?\.id \?\? ""\}\|\$\{req\.params\.id\}`, async \(req: express\.Request, res: express\.Response\) => \{/.test(head)
    && blk.indexOf("const st = await getSessionState(id);") > 0,
    "⑩-S4 ★ 같은 세션(테넌트·id)의 복원 요청은 한 줄로 서고, 줄 안에서 행을 읽는다 — 동시에 두 번 불려도 둘 다 «아무도 안 만들었다» 를 보지 않는다");
  ok(/const restoreSerial = createKeyedSerializer\(\);/.test(src), "⑩-S4b 줄은 모듈에 하나다(요청마다 새로 만들면 아무것도 안 막는다)");
  // S5 — 후보를 못 물었으면 «없다» 가 아니라 «모른다»(만들지 않는다).
  ok(/conversationPeers\(id, mappedId, st\.owner\)\.catch\(\(\) => null\);\s*\n\s*if \(peers === null && !force\) \{\s*\n\s*throw new HttpError\(409,/.test(blk),
    "⑩-S5 같은 대화 후보 조회가 실패하면 새로 만들지 않고 409(force 면 사람이 고른 대로)");
  // S1 — 박스 복원: 옛 id 생존(already) 판정 뒤, createSession 앞에서 «이미 이 대화를 도는 세션» 을 묻는다.
  const oldAlive = blk.indexOf("await sessionGoneVerdict(id)");
  const adopt = blk.indexOf("adoptVerdict(");
  const create = blk.indexOf("await createSession(owner");
  ok(oldAlive > 0 && adopt > oldAlive && create > adopt,
    "⑩-S1a ★ 박스 복원이 새로 만들기 **전에** 같은 대화를 도는 산 세션을 찾는다(옛 id 생존 판정 뒤)", `oldAlive=${oldAlive} adopt=${adopt} create=${create}`);
  const adoptBlk = blk.slice(adopt, create);
  ok(/conversationPeers\(id, mappedId, st\.owner\)/.test(blk.slice(0, adopt)) && /sessionGoneVerdict\(p\.id\)/.test(blk.slice(0, adopt)),
    "⑩-S1b 후보는 같은 주인·같은 대화 행이고, 생사는 확답(has-session)으로 묻는다");
  ok(/adopt\.kind === "unknown"[\s\S]{0,80}throw new HttpError\(409/.test(adoptBlk) && /settleInterruptedRestore\(id, st, adopt\.id/.test(adoptBlk)
    && /movedTo: adopt\.id/.test(adoptBlk),
    "⑩-S1c 모르면 만들지 않고(409), 이으면 뒷정리를 채우고 이정표 갈래와 같은 모양(movedTo)으로 답한다");
  // S3 — 복원이 새 세션에 이 대화를 태어날 때부터 싣는다.
  ok(/carryConv: \{ convId: mappedId, transcriptPath: st\.transcript_path \?\? null \}/.test(blk.slice(create)),
    "⑩-S3 복원이 createSession 에 이어받는 대화를 넘긴다(끊겨도 그 세션이 대화로 찾아지게)");
  const settle = src.slice(src.indexOf("async function settleInterruptedRestore("));
  const settleBody = settle.slice(0, settle.indexOf("\n}\n"));
  ok(/recordSessionTenant\(newId\)\.catch/.test(settleBody) && !/killSession/.test(settleBody) && /markSessionSuperseded\(oldId, newId\)/.test(settleBody)
    && /carryOutbox\(oldId, newId\)/.test(settleBody),
    "⑩-S1d 이어 붙인 세션의 뒷정리는 세션을 죽이지 않는다(사람이 이미 쓰고 있을 수 있다) · 이정표와 대기 지시를 옮긴다");
}
{
  const src = read("src/terminal/sessions.ts");
  // S2 — desired 행이 서는 두 자리 모두에서 곧바로 대화를 적는다. 노드에선 안 한다(DB 가 없다).
  ok(/if \(mirrored\) await carryConvNow\(\);/.test(src) && /if \(upserted\) await carryConvNow\(\);/.test(src),
    "⑩-S2a ★ desired 행이 선 **그 자리**(새 경로 · 옛 경로)에서 이어받는 대화를 적는다");
  const fn = src.slice(src.indexOf("const carryConvNow = async"));
  ok(/onNode\(\)/.test(fn.slice(0, fn.indexOf("};"))) && /setClaudeSessionId\(id, c\.convId, ownerId\(user\)/.test(fn.slice(0, fn.indexOf("};"))),
    "⑩-S2b 대화 선기록은 게이트웨이에서만, 그 세션 주인 이름으로 적는다");
  const inside = src.indexOf("if (mirrored) await carryConvNow();");
  const ensure = src.indexOf("await ensureSessionContainerViaRelay(");
  ok(inside > 0 && ensure > inside, "⑩-S2c 새 경로는 컨테이너·판을 띄우기 **전에** 적는다(그 뒤에서 끊겨도 찾아진다)");
}

console.log(`\n${pass}건 통과`);

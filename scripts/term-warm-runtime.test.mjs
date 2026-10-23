#!/usr/bin/env node
// 말을 보낸 직후의 세션 화면 — **하네스가 그릴 때까지 대화창에 머물다가, 그린 순간 터미널로 넘긴다**(#4794, 런타임).
//
//  신고(상민님 2026-10-16): «대화창에서 프롬프트 보냈을 때 터미널로 넘어가는데, 터미널 화면으로 이동하고 실제 하네스 안에
//   내용이 보이기까지 2~3초 동안 빈 터미널 화면이 보인다 — 하네스 안에 내용이 보이게 되는 순간 넘기는 게 낫다.»
//  고침: 세션 화면(web/session-chat.ts termWarm)은 firstPrompt 를 들고 열리면 대화창을 보인 채 터미널 액자를 대화창 자리에
//   숨겨(visibility:hidden · inert) 먼저 붙이고, 액자(web/standalone/terminal.ts watchFirstPaint)가 «처음 그렸다»
//   (lively-term-painted)를 알리면 그때 넘긴다. 숨은 액자는 붙자마자 초점을 가져가지 않는다(frameHiddenNow).
//  후속(상민님 2026-10-16: «프롬프트가 실제로 전송된 시점에 전환하는 게 좋지 않을지»): 넘기는 때는 «그렸다» + «보낸 말이 대화
//   기록에 나타났다(에코)» 둘 다다. 그렸는데 말이 8초 안에 안 들어가면 그때 넘긴다(로그인·경고 창은 터미널에서 봐야 한다).
//   그래서 «그린 뒤 넘긴다» 를 재는 장면(W1·W5·W7·W8·W15·W17)은 말이 먼저 들어간 판으로 둔다(echoAt) — 그 순서는 W22 가 뒤집어 잰다.
//
//  엣지 표(행마다 장면 하나):
//   W1 말을 보내 연 화면 · 하네스가 0.8초 뒤 그린다 → 그리기 전엔 대화창(액자는 숨어 붙어 있음 · 대화창과 같은 크기 · 초점은 입력칸)
//      · 그린 뒤 터미널(숨김 걷힘 · 터미널에 초점) · 넘긴 때는 그린 때 뒤, 0.3초 남짓 안
//   W2 그냥 연 화면(firstPrompt 없음) → 종전처럼 처음부터 터미널(숨겨 붙이기 없음)
//   W3 하네스가 끝내 안 그린다(공백만 계속 온다) → 5초에도 · 20초에도 대화창 · 상한(25초) 뒤 터미널(종전 화면으로 물러남)
//   W4 숨겨 붙이는 중 사람이 [⋯ ▸ 보기 ▸ 터미널로] → 곧바로 터미널(초점도) · 그 뒤 신호가 와도 그대로
//   W5 숨겨 붙이는 중 입력칸에 글을 쓰고 있다 → 그려도 화면을 뺏지 않는다(대화창 · 글 그대로 · 초점 그대로) · 다음 목록 갱신도 안 뺏는다
//   W6 숨겨 붙이는 중 액자가 «박스 없음» → 액자를 걷고 대화창(터미널로 안 넘어감)
//   W7 숨겨 붙이는 중 목록 갱신이 «살아 있다» 를 다시 줘도 넘기지 않는다 → 그린 뒤에 넘긴다
//   W8 그린 뒤 스피너처럼 쉬지 않고 다시 그린다 → 멎기를 끝없이 기다리지 않는다(처음 그린 때부터 1.5초 상한)
//   W9 말을 보내 열었는데 터미널이 없다(멈춘 행) → 숨겨 붙이기 없음 · 대화창(종전)
//   W10 말을 보내 열 때 목록 행이 한 틱 늦어 터미널이 없었다 → 갱신으로 터미널이 생기면 곧바로 넘기지 않고 숨겨 붙인다 · 그린 뒤 넘긴다
//   W11 대화가 본자리인 화면(chatHome — 리브 탭도 첫 지시를 들고 온다) · 첫 지시 → 숨겨 붙이기 없음(대화창 · 액자 없음)
//   W12 못 간 글을 들고 온 화면(draft) · 첫 지시 → 숨겨 붙이기 없음 · 글은 입력칸에
//   W13 관측 못 한 행(observed:false) · 첫 지시 → 숨겨 붙이기 없음
//   W14 숨겨 붙이는 중 화면이 부서진다(destroy) → 상한이 지나도 아무 일 없음(오류 없음)
//   W15 숨은 탭(display:none)에서 열렸다가 보인다 → 숨은 액자가 그때 대화창 자리·크기로 맞춰진다 · 그린 뒤 넘긴다
//       ⚠ 이 헤드리스(--dump-dom · 가상 시간)는 그리기 단계를 안 돌려 requestAnimationFrame 도 ResizeObserver 도 한 번도 안 뜬다
//        (실측 2026-10-16: rAF 0회 · RO 0회 — display:none → flex 로 보여도). 그래서 이 장면만 가짜 RO 를 끼워, 대화창 칸을 지켜보는지와
//        그 콜백이 자리를 다시 맞추는지 · 끝나면 끊는지를 잰다(진짜 브라우저에선 탭이 보이는 순간 RO 가 뜬다).
//   W16 숨겨 붙이는 중 액자가 «끝났다»(status end) → 기다리지 않고 곧바로 터미널(그 배너를 봐야 한다)
//   W17 사람이 이 화면 밖(다른 입력칸)에 초점을 두고 있다 → 그려서 넘기되 초점은 빼앗지 않는다
//   W18 숨겨 붙이는 중 연결 오류(status err) → 넘기지 않되 머리줄 칩으로는 보인다
//   W19 숨겨 붙이는 중 목록 갱신이 «대화가 본자리»(대화 런타임 — chatHome)를 알려 온다 → 숨겨 붙이기를 접고 그려도 넘기지 않는다
//   W20 되살린 화면(기록이 이미 있다) · 매니지드 행(노드 칸 = 세션 호스트 — 큐 되살리기가 건너뛴다) → 기다리는 동안 방금 보낸 말이
//       대화창에 대기 말풍선으로 **한 번** 보인다(매니지드 실측: 되살린 뒤 6초 동안 그 말이 없었다)
//   W20b 같은데 기록의 마지막 사람 말이 이미 그 말이다 → 두 번 그리지 않는다(대기 말풍선 없음)
//   W21 멈춘 세션 대화창에서 말을 보내 되살리는 중(복원 요청이 느리다) 목록 갱신이 «살아 있다» 를 먼저 실어 온다
//       → 옛 화면은 터미널로 넘기지 않는다(곧 다시 마운트돼 숨겨 붙인다) · 복원이 끝나면 같은 id 로 옮겨 간다
//       (매니지드 실측: 옛 화면이 빈 터미널로 넘어갔다가 다시 마운트되며 대화창으로 돌아가는 깜빡임)
//   W22 되살린 화면(매니지드 행 · 기록 있음) · 하네스가 먼저 그리고 말은 2.6초에 들어간다 → 그린 뒤에도 대화창(대기 말풍선 그대로)
//       · 말이 기록에 나타난 뒤 터미널(읽는 주기 0.7초 안) · 대기 줄은 걷힌다
//   W23 그렸는데 말이 끝내 안 들어간다(로그인·경고 창) → 그린 뒤 4초에도 대화창 · 그린 때부터 8초 뒤 터미널(그 창을 보게)
//       · 읽는 주기: 그리기 전엔 느리게(3초) · 그린 뒤 기다리는 동안만 0.7초 · 넘긴 뒤엔 다시 느리게
//   W24 그 컴퓨터의 세션(노드 — 대화는 중앙 기록으로만 읽힌다) → 중앙 기록은 턴이 끝나야 자라 에코를 못 본다 · 기다리지 않고 그린 때 넘긴다
//   W25 기록 읽기가 느려 하네스가 먼저 그렸다 · 그 말은 이미 기록에 있다(들어갔다) → 읽는 동안은 대화창 · 다 읽은 그 자리에서 터미널
//       (그린 때도 아니고 8초 뒤도 아니다)
//   W26 읽기가 느린데(0.5초) 그 읽기 도중에 하네스가 그렸다 → 그린 순간 깨운 읽기가 도는 읽기와 같은 자리부터 겹친다(겹쳤는지도 잰다)
//       · 보낸 말은 한 번만 그려진다(겹친 읽기의 낡은 답은 버린다 — 고치기 전엔 두 번 그려졌다)
//   W27 새로 연 세션(홈 입력창) — 기록 파일이 아직 없다(404) · 말이 들어가면서 파일이 생긴다 → 그려도 그때까지 대화창 · 생긴 뒤 터미널
//   W28 첫 말이 빗금 명령(/compact) — 기록엔 다른 모양으로 적혀 대기 말풍선과 안 맞는다 → 기다리지 않고 그린 때 넘긴다
//   W29 멤버 PC 행(노드 칸 = 그 컴퓨터) — 박스 경로는 409 node 인데 대화 id 를 모른다 → 지켜볼 곳이 없어(src 없음 — 중앙 기록 좌표가 없다)
//       에코를 못 본다 → 기다리지 않고 그린 때 넘긴다(8초를 헛되이 쓰지 않는다 — 격리 검토가 찾음)
//   W29b 매니지드 행(노드 칸 = 세션 호스트)인데 대화 id 를 모르고 기록 파일도 아직 없다 → 세션 호스트는 «그 컴퓨터» 가 아니라(#4904)
//       박스 기록을 지켜본다 → W27 처럼 그 말이 기록에 나타날 때까지 대화창 · 나타난 뒤 터미널
//       (#4904 전엔 세션 호스트 좌표를 멤버 PC 로 읽어 src 가 없었고, 그래서 이 장면이 W29 였다)
//   W30 되살린 화면 · 그린 뒤 서버가 «다 쳤다»(outbox.typed — 세션 상태 통로) → 기록 에코를 기다리지 않고 그 자리에서 터미널
//       (에코는 Claude Code 가 제출 훅을 다 돈 뒤 적어 몇 초 늦다 — 매니지드 실측. 이 장면엔 에코가 아예 없다)
//   W31 «다 쳤다» 가 다른 말(다른 탭에서 보낸 것)의 것 → 넘기지 않는다
//   W32 «다 쳤다» 가 그리기 전에 왔다 → 그린 때 넘긴다
//   W33 리브 세션(#4940 — 셸이 물음 자리(livAsks)만 주고 대화 고정은 안 준다) · 첫 지시가 하네스 첫 실행 화면(글자 스타일 고르기)에
//       막혀 끝내 안 들어간다 → 그리기 전엔 tui 대화창(물음 카드는 입력칸 위) · 그린 때부터 8초 뒤 터미널 · 터미널을 보는 동안
//       물음 카드는 머리줄 아래(숨은 대화창 안에 갇히지 않는다). 실측 2026-10-23 셀프호스트: 대화 고정이라 «전달하는 중…» 에 갇혔다.
//   W33b 그 뒤 사람이 [⋯ ▸ 보기 ▸ 대화로] → 물음 카드가 입력칸 위(대화창 안)로 돌아온다
//   W34 리브 세션 · 물음 카드의 입력칸에 치는 중(비밀 값일 수 있다)에 저절로 터미널로 넘어간다 → 넘어가되 초점·값은 그 칸에 남는다
//       (격리 리뷰 실측: 카드를 옮기며 초점이 떨어지고 터미널이 가져가 이어 치는 값이 하네스 입력칸으로 갔다)
//   G  겹친 읽기 가드(배선 — 소스 글로 본다): 오프셋·지켜보는 곳 둘 다 보고 버린 뒤 곧 다시 읽는다 · 압축 뒤 두 번째 읽기도 · 다시 여는 중엔
//       읽지 않는다. 런타임으로 재기 어려운 갈래(지켜보는 곳 갈아타기 · 통보 중 30초 주기)는 격리 검토가 따로 재 두었다.
//  순수 판정(«그렸나» · 기다릴 시간 · «숨었나» 의 액자 밖)은 노드 시험 term-first-paint.test.mjs 가 맡는다.
//
//  가짜는 «서버» 와 «하네스 출력» 뿐이다. 세션 화면은 실제 모듈(web/session-chat.ts)을, 액자는 실제 터미널 모듈
//   (web/standalone/terminal.ts — watchFirstPaint · frameHiddenNow)과 실제 xterm(public/vendor)을 같은 출처(http)로 싣는다.
//   file:// 로는 액자·셸의 출처가 갈려 postMessage 를 잴 수 없다(headless-chrome.mjs serve 머리말).
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · public/styles · public/vendor/xterm 이 있는 곳)로 옛 코드를 물린다.
//  크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 보낸 뒤 터미널 넘기기 런타임 검증 미실행"); process.exit(0); }

const CSS = ["01-base.css", "03-components.css", "36-chat.css", "38-chat-tui.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const XTERM = ["xterm.min.js", "xterm.min.css"].map((f) => path.join(ROOT, "public/vendor/xterm", f));
for (const f of XTERM) if (!existsSync(f)) { console.error(`FAIL  vendored xterm 없음: ${f}`); process.exit(1); }
const sc = buildSync({
  stdin: { contents: "export { mountSessionChat } from './web/session-chat.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "SC", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;
const tm = buildSync({
  entryPoints: [path.join(ROOT, "web/standalone/terminal.ts")], bundle: true, format: "iife", globalName: "TM", write: false,
  platform: "browser", target: "es2020", define: { TERMJS_BUILD: JSON.stringify("test") }, logLevel: "silent",
}).outputFiles[0].text;

//  가짜 터미널 페이지 — 실제 모듈의 두 함수를 terminal.ts boot() 가 거는 자리 그대로 건다(나머지 boot 는 소켓·서버가 필요해 뺀다).
//   주소: frame.html?session=<id>&embed=1 [&ink=<ms> 그 뒤 하네스가 그린다] [&spin=1 그린 뒤 쉬지 않고 다시 그림]
//         [&blank=1 공백만 계속] [&gone=<ms> 그 뒤 «박스 없음»] [&end=<ms> 그 뒤 «끝났다»(status end)] [&err=<ms> 그 뒤 연결 오류(status err)]
//   test-* 메시지는 이 시험이 재는 관측(때 · 크기 · 초점)이다 — 세션 화면은 모르는 종류라 버린다.
const FRAME = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.min.css">
<style>html,body{margin:0;height:100%;overflow:hidden}#h{position:absolute;inset:0}</style><div id="h"></div>
<script src="xterm.min.js"></script><script src="tm.js"></script>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var id = q.get('session');
  var say = function (o) { try { parent.postMessage(Object.assign({ id: id }, o), location.origin); } catch (_) {} };
  var term = new Terminal({ cols: 80, rows: 24, fontSize: 13 });
  term.open(document.getElementById('h'));
  TM.__injectRefsForTest({ term: term });
  if (TM.watchFirstPaint) TM.watchFirstPaint();                       // boot() 가 term.onData 다음에 거는 자리
  var hidden = TM.frameHiddenNow ? TM.frameHiddenNow() : false;        // onopen 의 초점 가드 — 옛 판엔 없다(늘 초점)
  if (!hidden) term.focus();
  say({ type: 'test-boot', hidden: hidden, w: innerWidth, h: innerHeight, at: Date.now() });
  say({ type: 'lively-term-status', text: '연결됨', cls: 'ok', paneShell: false });
  window.addEventListener('message', function (ev) {                  // 종전 setupEmbedBridge 의 'focus' 명령과 같은 동작
    if (ev.source !== parent) return;
    var m = ev.data;
    if (m && m.type === 'lively-term' && m.cmd === 'focus') { term.focus(); say({ type: 'test-focused', at: Date.now() }); }
  });
  term.write('\\x1b[2J\\x1b[H');                                       // 하네스가 뜨기 전의 빈 pane
  if (q.get('blank')) setInterval(function () { term.write('\\x1b[H   \\r\\n  \\x1b[K'); }, 200);
  var ink = Number(q.get('ink') || -1);
  if (ink >= 0) setTimeout(function () {
    say({ type: 'test-ink', at: Date.now() });
    term.write('\\x1b[?1049h\\x1b[H\\u256d\\u2500\\u2500\\u2500\\u256e\\r\\n\\u2502 Welcome to Claude Code \\u2502\\r\\n\\u2570\\u2500\\u2500\\u2500\\u256f\\r\\n> ');
    if (q.get('spin')) { var i = 0; setInterval(function () { term.write('\\x1b[6;1H' + '|/-\\\\'.charAt(i++ % 4)); }, 100); }
  }, ink);
  var end = Number(q.get('end') || -1);
  if (end >= 0) setTimeout(function () { say({ type: 'lively-term-status', text: '세션 종료됨', cls: 'end' }); }, end);
  var err = Number(q.get('err') || -1);
  if (err >= 0) setTimeout(function () { say({ type: 'lively-term-status', text: '연결 끊김 — 재연결 중…', cls: 'err' }); }, err);
  var gone = Number(q.get('gone') || -1);
  if (gone >= 0) setTimeout(function () { parent.postMessage({ type: 'lively-term-gone', id: id, restorable: true, canRestore: true }, location.origin); }, gone);
})();
</script>`;

async function PAGE_MAIN() {
  const R = {};
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const until = async (fn, max) => { for (let t = 0; t < max && !fn(); t += 25) await sleep(25); };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  //  W20 의 기록 — 이미 오간 말이 있는 세션(되살리기는 늘 이 모양이다). 그 밖의 세션은 빈 기록.
  const line = (o) => JSON.stringify(o) + "\n";
  const said = (role, text, ts) => role === "user"
    ? line({ type: "user", timestamp: ts, message: { role: "user", content: text } })
    : line({ type: "assistant", timestamp: ts, message: { role: "assistant", model: "claude-opus-4-1", content: [{ type: "text", text }] } });
  const TRANSCRIPTS = {
    "box-w20": said("user", "이전에 물어본 말", "2026-10-16T01:00:00Z") + said("assistant", "이전 답", "2026-10-16T01:00:05Z"),
    "box-w20b": said("user", "이전에 물어본 말", "2026-10-16T01:00:00Z") + said("assistant", "이전 답", "2026-10-16T01:00:05Z")
      + said("user", "되살리며 보낸 말 W20", "2026-10-16T01:01:00Z"),
  };
  TRANSCRIPTS["box-w22"] = TRANSCRIPTS["box-w20"];
  TRANSCRIPTS["box-w25"] = TRANSCRIPTS["box-w20"] + said("user", "되살리며 보낸 말 W25", "2026-10-16T01:01:00Z");
  //  보낸 말이 «들어갔다» — 서버(아웃박스)가 하네스 입력창에 넣고 Enter 를 친 뒤 그 말이 대화 기록에 나타나는 때. 장면마다 건다.
  const ECHO = {};
  const echoAt = (id, ms, text) => { ECHO[id] = { at: Date.now() + ms, text }; };
  const SLOW = { "box-w25": 1500, "box-w26": 500, "box-w30": 1500 };  // W25 — 기록 읽기가 느리다(그사이 하네스가 그린다) · W26 — 읽기마다 0.5초
                                                                       //  · W30 — 읽기마다 1.5초(넘김이 다음 읽기 끝의 재확인이 아니라 알림 자체에서 나오는지 가른다)
  const NOTYET = {};                                                   // W27 — 그 때까지 기록 파일이 없다(404)
  //  세션 상태 통로(/events) — 이 장면들만 진짜 스트림으로 연다(나머지는 종전처럼 404). pushEv 로 서버 알림을 흘린다.
  const EV = {}, EV_ON = new Set(["box-w30", "box-w31", "box-w32"]);
  const pushEv = (sid, o) => { const c = EV[sid]; if (c) c.enqueue(new TextEncoder().encode("data: " + JSON.stringify(o) + "\n\n")); };
  const FETCHES = [];                                                  // 기록 읽기마다 { sid, start, end } — W23 주기 · W26 겹침
  window.fetch = async (url) => {
    const u = new URL(String(url), location.href);
    if (/\/transcript$/.test(u.pathname)) {
      //  진짜 서버처럼 창(from · 크기)을 머리에 싣는다 — 안 실으면 화면의 폴링이 «파일이 줄었다(교체)» 로 읽고 처음부터 다시 그린다(낙관 턴이 사라진다).
      const sid = decodeURIComponent((/\/sessions\/([^/]+)\/transcript$/.exec(u.pathname) || [])[1] || "");
      if (sid === "box-w29") return J({ error: "node" }, 409);   // W29 — 멤버 PC 의 세션: 박스 경로는 409 node 인데 대화 uuid 를 모른다(중앙 기록 좌표도 없다)
      if (sid === "box-w24") return J({ error: "node", uuid: "u-w24", node: "n-w24" }, 409);   // W24 — 그 컴퓨터의 세션: 서버가 중앙 기록 좌표를 알려 준다
      const fr = { sid, start: Date.now(), end: 0 }; FETCHES.push(fr);
      if (SLOW[sid]) await sleep(SLOW[sid]);
      fr.end = Date.now();
      if (NOTYET[sid] && Date.now() < NOTYET[sid]) return J({ error: "아직 없음" }, 404);
      const e = ECHO[sid];
      const all = (TRANSCRIPTS[sid] || "") + (e && Date.now() >= e.at ? said("user", e.text, new Date(e.at).toISOString()) : "");
      const from = u.searchParams.has("from") ? Math.min(Number(u.searchParams.get("from")) || 0, all.length) : 0;
      return new Response(all.slice(from), { status: 200, headers: { "content-type": "text/plain",
        "X-Log-Bytes": String(all.length), "X-Log-From": String(from), "X-Log-To": String(all.length) } });
    }
    if (/\/events$/.test(u.pathname)) {
      const sid = decodeURIComponent((/\/sessions\/([^/]+)\/events$/.exec(u.pathname) || [])[1] || "");
      if (!EV_ON.has(sid)) return J({ error: "no" }, 404);
      return new Response(new ReadableStream({ start(c) { EV[sid] = c; } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (/\/log$/.test(u.pathname)) {                                  // W24 — 중앙 기록(턴이 끝나야 자란다 — 그사이엔 빈 채)
      return new Response("", { status: 200, headers: { "content-type": "text/plain", "X-Log-Bytes": "0", "X-Log-From": "0", "X-Log-To": "0" } });
    }
    if (/\/outbox$/.test(u.pathname)) return J({ items: [] });
    if (/\/restore$/.test(u.pathname)) {                              // W21 — 느린 복원(같은 id 로 다시 띄웠다)
      const sid = decodeURIComponent((/\/sessions\/([^/]+)\/restore$/.exec(u.pathname) || [])[1] || "");
      await sleep(900);
      return J({ session: { id: sid } });
    }
    if (/\/prompt$/.test(u.pathname)) return J({ outbox_id: 7 });
    if (/\/api\/ui\/me\/liv$/.test(u.pathname)) return J({ mode: "ok", reason: "", findings: [], total: 0,   // W33 — 리브가 던진 물음 하나(객관식)
      secretAsk: { kind: "choice", allow_other: true, key: "w33", question: "W33 자료를 어디에 쌓아 두셨어요?", options: [{ id: "a", label: "슬랙" }, { id: "b", label: "노션" }] } });
    return J({ error: "no" }, 404);
  };
  localStorage.setItem("lively_ui_token", "t");
  const SC = (new Function(document.getElementById("src").textContent + "\n;return SC;"))();
  //  액자가 보낸 시험 관측(때 · 크기 · 초점).
  const fx = {};
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || typeof m.type !== "string" || !m.type.startsWith("test-")) return;
    (fx[m.id] ||= {})[m.type] = m;
  });
  const row = (id, alive) => ({ id, label: "세션", live: true, alive, node: null, owned: true, stateKey: alive ? "idle" : "restorable", stateLabel: alive ? "대기" : "중단됨",
    projectId: null, projectName: "", raw: alive ? { harness: "claude", chatMode: "tmux", agentState: "idle" } : { harness: "claude", chatMode: "tmux", restorable: true } });
  const mount = (id, frameQ, opts, alive = true, rawExtra = null, hidden = false, topExtra = null) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:0;top:0;width:1000px;height:700px;flex-direction:column;background:#fff;display:" + (hidden ? "none" : "flex");
    document.body.append(box);
    const t0 = Date.now();
    const r0 = row(id, alive);
    if (rawExtra) Object.assign(r0.raw, rawExtra);
    if (topExtra) Object.assign(r0, topExtra);
    const h = SC.mountSessionChat(box, r0, Object.assign({
      terminalSrc: (t) => (t.live && t.alive ? `frame.html?session=${encodeURIComponent(t.id)}&embed=1&${frameQ}` : null),
      onResumed: () => {},
    }, opts || {}));
    const wrap = box.querySelector(".sc-wrap");
    const chat = box.querySelector(".sc-chat");
    const th = box.querySelector(".sc-term");
    //  넘긴 때 — 터미널 모드가 처음 선 때(25ms 간격으로 본다)
    let termAt = 0;
    const iv = setInterval(() => { if (!termAt && wrap.classList.contains("sc-mode-term")) termAt = Date.now(); }, 25);
    const snap = () => {
      const fr = th.querySelector("iframe");
      const a = document.activeElement;
      return {
        term: wrap.classList.contains("sc-mode-term"), warm: wrap.classList.contains("sc-term-warm"),
        chatShown: !chat.hidden, termHidden: th.hidden, inert: th.hasAttribute("inert"), vis: getComputedStyle(th).visibility,
        inlineBox: !!(th.style.top || th.style.height), frame: !!fr,
        chip: (() => { const c = box.querySelector(".sc-termstat"); return c && !c.hidden ? c.textContent : null; })(),
        focus: a && fr && a === fr ? "frame" : a && a.classList && a.classList.contains("livc-input") ? "input" : a ? a.tagName.toLowerCase() : "",
      };
    };
    const geo = () => { const c = chat.getBoundingClientRect(), t = th.getBoundingClientRect(); return { chat: [Math.round(c.top), Math.round(c.height), Math.round(c.width)], term: [Math.round(t.top), Math.round(t.height), Math.round(t.width)] }; };
    return {
      box, h, snap, geo, t0, termAt: () => (termAt ? termAt - t0 : 0), fx: () => fx[id] || {},
      input: () => box.querySelector("textarea.livc-input"),
      done: () => { clearInterval(iv); try { h.destroy(); } catch (_) { /* 이미 */ } box.remove(); },
      //  대화창 안에서 그 글이 몇 번 보이나(글 마디 단위) · 대기 줄 글
      count: (text) => chat.innerText.split(text).length - 1,   // tui 모양은 글을 여러 마디로 쪼개 그린다 — 보이는 글(innerText)로 센다
      qstate: () => [...chat.querySelectorAll(".dt-qstate")].map((e) => e.textContent).join(" | "),
    };
  };
  try {
    // W1 — 말을 보내 연 화면 · 0.8초 뒤 그린다
    {
      echoAt("box-w1", 300, "첫 지시 — 하네스 띄워서 이걸 해 줘");     // 말이 먼저 들어간 판 — 넘기는 때는 그린 때(머리말)
      const v = mount("box-w1", "ink=800", { firstPrompt: "첫 지시 — 하네스 띄워서 이걸 해 줘" });
      await sleep(450);
      await until(() => v.fx()["test-boot"], 2000);                     // 첫 액자는 xterm 을 처음 읽느라 늦게 설 수 있다 — 그린 때(ink)는 선 때부터 센다
      R.w1 = { before: v.snap(), geo: v.geo(), boot: v.fx()["test-boot"] || null };
      await sleep(1600);
      R.w1.after = v.snap();
      R.w1.termAt = v.termAt();
      const ink = v.fx()["test-ink"];
      R.w1.inkAt = ink ? ink.at - v.t0 : null;
      R.w1.focused = !!v.fx()["test-focused"];
      v.done();
    }
    // W2 — 그냥 연 화면
    {
      const v = mount("box-w2", "ink=800", {});
      await sleep(200);
      R.w2 = { at200: v.snap() };
      v.done();
    }
    // W3 — 끝내 안 그린다(공백만)
    {
      const v = mount("box-w3", "blank=1", { firstPrompt: "첫 지시" });
      await sleep(5000);
      R.w3 = { at5s: v.snap() };
      await sleep(15000);
      R.w3.at20s = v.snap();
      await sleep(6000);
      R.w3.at26s = v.snap();
      R.w3.termAt = v.termAt();
      v.done();
    }
    // W4 — 숨겨 붙이는 중 사람이 [⋯ ▸ 보기 ▸ 터미널로]
    {
      const v = mount("box-w4", "ink=1500", { firstPrompt: "첫 지시" });
      await sleep(400);
      const more = document.querySelector('button[aria-label="더 보기"]');
      if (more) more.click();
      await sleep(150);
      const go = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "터미널로");
      R.w4 = { menu: !!more, btn: !!go };
      if (go) go.click();
      await sleep(150);
      R.w4.afterPick = v.snap();
      R.w4.focused = !!v.fx()["test-focused"];
      await sleep(2200);
      R.w4.afterInk = v.snap();
      R.w4.ink = !!v.fx()["test-ink"];
      v.done();
    }
    // W5 — 입력칸에 쓰는 중
    {
      echoAt("box-w5", 300, "첫 지시");
      const v = mount("box-w5", "ink=900", { firstPrompt: "첫 지시" });
      await sleep(300);
      const inp = v.input();
      inp.focus(); inp.value = "추가로 이것도"; inp.dispatchEvent(new Event("input"));
      await sleep(1700);
      R.w5 = { after: v.snap(), value: inp.value, ink: !!v.fx()["test-ink"] };
      v.h.update(row("box-w5", true));                                   // 다음 목록 갱신(20초 주기)
      await sleep(200);
      R.w5.afterUpdate = v.snap();
      v.done();
    }
    // W6 — 숨겨 붙이는 중 «박스 없음»
    {
      const v = mount("box-w6", "gone=500&ink=900", { firstPrompt: "첫 지시" });
      await sleep(1800);
      R.w6 = { after: v.snap(), termAt: v.termAt() };
      v.done();
    }
    // W7 — 목록 갱신이 «살아 있다» 를 다시 줘도
    {
      echoAt("box-w7", 300, "첫 지시");
      const v = mount("box-w7", "ink=1200", { firstPrompt: "첫 지시" });
      await sleep(300);
      v.h.update(row("box-w7", true));
      await sleep(200);
      R.w7 = { afterUpdate: v.snap() };
      await sleep(1800);
      R.w7.after = v.snap();
      v.done();
    }
    // W8 — 그린 뒤 쉬지 않고 다시 그린다
    {
      echoAt("box-w8", 300, "첫 지시");
      const v = mount("box-w8", "ink=500&spin=1", { firstPrompt: "첫 지시" });
      await sleep(3500);
      const ink = v.fx()["test-ink"];
      R.w8 = { after: v.snap(), termAt: v.termAt(), inkAt: ink ? ink.at - v.t0 : null };
      v.done();
    }
    // W9 — 말을 보내 열었는데 터미널이 없다(멈춘 행)
    {
      const v = mount("box-w9", "ink=300", { firstPrompt: "첫 지시" }, false);
      await sleep(900);
      R.w9 = { after: v.snap(), termAt: v.termAt() };
      v.done();
    }
    // W10 — 열 때 행이 늦었다(터미널 없음) → 갱신으로 생긴다
    {
      const v = mount("box-w10", "ink=600", { firstPrompt: "첫 지시" }, false);
      await sleep(300);
      R.w10 = { atOpen: v.snap() };
      v.h.update(row("box-w10", true));
      await sleep(300);
      R.w10.afterUpdate = v.snap();
      await sleep(2200);
      R.w10.after = v.snap();
      const ink = v.fx()["test-ink"];
      R.w10.inkAt = ink ? ink.at - v.t0 : null;
      R.w10.termAt = v.termAt();
      v.done();
    }
    // W11 — 대화가 본자리인 화면
    {
      const v = mount("box-w11", "ink=300", { firstPrompt: "첫 지시", chatHome: true });
      await sleep(1200);
      R.w11 = { after: v.snap(), termAt: v.termAt() };
      v.done();
    }
    // W12 — 못 간 글을 들고 온 화면
    {
      const v = mount("box-w12", "ink=300", { firstPrompt: "첫 지시", draft: "못 간 글" });
      await sleep(1200);
      R.w12 = { after: v.snap(), termAt: v.termAt(), value: v.input() ? v.input().value : null };
      v.done();
    }
    // W13 — 관측 못 한 행
    {
      const v = mount("box-w13", "ink=300", { firstPrompt: "첫 지시" }, true, { observed: false });
      await sleep(1200);
      R.w13 = { after: v.snap(), termAt: v.termAt() };
      v.done();
    }
    // W14 — 숨겨 붙이는 중 부서진다
    {
      const v = mount("box-w14", "ink=2000", { firstPrompt: "첫 지시" });
      await sleep(400);
      R.w14 = { before: v.snap() };
      const errs0 = pageErrors.length;
      const wrapEl = v.box.querySelector(".sc-wrap");
      v.done();
      R.w14.warmAfterDestroy = wrapEl.classList.contains("sc-term-warm");   // 부서질 때 곧바로 걷혔나(상한 타이머를 남기지 않았나)
      await sleep(2000);
      R.w14.newErrors = pageErrors.slice(errs0);
    }
    // W15 — 숨은 탭에서 열렸다가 보인다(가짜 RO — 머리말 ⚠)
    {
      const RealRO = window.ResizeObserver;
      const fakes = [];
      window.ResizeObserver = class { constructor(cb) { this.cb = cb; this.els = []; this.dead = false; fakes.push(this); } observe(el) { this.els.push(el); } unobserve() {} disconnect() { this.dead = true; } };
      try {
        echoAt("box-w15", 300, "첫 지시");
        const v = mount("box-w15", "ink=1500", { firstPrompt: "첫 지시" }, true, null, true);
        await sleep(400);
        R.w15 = { hiddenSnap: v.snap(), hiddenGeo: v.geo() };
        v.box.style.display = "flex";
        const chatEl = v.box.querySelector(".sc-chat");
        R.w15.watchesChat = fakes.some((f) => !f.dead && f.els.includes(chatEl));
        for (const f of fakes) if (!f.dead) f.cb([]);               // 탭이 보이는 순간 진짜 브라우저가 부르는 자리
        await sleep(100);
        R.w15.shownSnap = v.snap(); R.w15.geo = v.geo();
        await sleep(2500);
        R.w15.after = v.snap();
        const mine = fakes.filter((f) => f.els.includes(chatEl));      // 대화창 칸을 지켜보는 것(숨겨 붙이기의 것) — 다른 부품의 RO 는 제 몫이다
        R.w15.watchers = mine.length;
        R.w15.disconnected = mine.length > 0 && mine.every((f) => f.dead);
        v.done();
      } finally { window.ResizeObserver = RealRO; }
    }
    // W16 — 숨겨 붙이는 중 «끝났다»
    {
      const v = mount("box-w16", "end=500", { firstPrompt: "첫 지시" });
      await sleep(2200);
      const boot = v.fx()["test-boot"];
      R.w16 = { after: v.snap(), termAt: v.termAt(), endAt: boot ? boot.at - v.t0 + 500 : null };
      v.done();
    }
    // W17 — 이 화면 밖에 초점
    {
      const outside = document.createElement("input");
      outside.id = "outside-input"; outside.style.cssText = "position:fixed;right:0;bottom:0;width:120px";
      document.body.append(outside);
      echoAt("box-w17", 300, "첫 지시");
      const v = mount("box-w17", "ink=900", { firstPrompt: "첫 지시" });
      await sleep(300);
      outside.focus();
      await sleep(1800);
      R.w17 = { after: v.snap(), focusedFrame: !!v.fx()["test-focused"], active: document.activeElement === outside ? "outside" : (document.activeElement ? document.activeElement.tagName : "") };
      v.done(); outside.remove();
    }
    // W18 — 숨겨 붙이는 중 연결 오류
    {
      const v = mount("box-w18", "err=500", { firstPrompt: "첫 지시" });
      await sleep(2200);
      R.w18 = { after: v.snap() };
      v.done();
    }
    // W19 — 숨겨 붙이는 중 «대화가 본자리» 를 뒤늦게 안다
    {
      const v = mount("box-w19", "ink=900", { firstPrompt: "첫 지시" });
      await sleep(300);
      const r19 = row("box-w19", true); r19.raw.runtimeMode = "chat";
      v.h.update(r19);
      await sleep(200);
      R.w19 = { afterUpdate: v.snap() };
      await sleep(1600);
      R.w19.after = v.snap(); R.w19.ink = !!v.fx()["test-ink"]; R.w19.termAt = v.termAt();
      v.done();
    }
    // W20 — 되살린 화면 · 매니지드 행 · 이미 있는 기록
    {
      const v = mount("box-w20", "ink=1500", { firstPrompt: "되살리며 보낸 말 W20" }, true, null, false, { node: "sesshost-test" });
      await sleep(800);
      R.w20 = { during: v.snap(), n: v.count("되살리며 보낸 말 W20"), prev: v.count("이전에 물어본 말"), qstate: v.qstate() };
      v.done();
    }
    // W20b — 기록의 마지막 사람 말이 이미 그 말
    {
      const v = mount("box-w20b", "ink=1500", { firstPrompt: "되살리며 보낸 말 W20" }, true, null, false, { node: "sesshost-test" });
      await sleep(800);
      R.w20b = { during: v.snap(), n: v.count("되살리며 보낸 말 W20"), qstate: v.qstate() };
      v.done();
    }
    // W21 — 말로 되살리는 중 목록이 «살아 있다» 를 먼저 실어 온다
    {
      let routed = null;
      const v = mount("box-w21", "ink=300", { onResumed: (id) => { routed = id; } }, false);
      await sleep(400);
      const inp = v.input();
      R.w21 = { before: v.snap(), hasInput: !!inp };
      inp.value = "되살리며 보낸 말 W21"; inp.dispatchEvent(new Event("input"));
      const form = inp.closest("form");
      if (form && form.requestSubmit) form.requestSubmit(); else inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await sleep(300);
      v.h.update(row("box-w21", true));                                 // 복원 응답보다 먼저 온 목록 갱신
      await sleep(200);
      R.w21.duringRevive = v.snap();
      await sleep(1200);
      R.w21.routed = routed;
      R.w21.after = v.snap();
      v.done();
    }
    // W22 — 되살린 화면(매니지드 행) · 먼저 그리고 말은 2.6초에 들어간다
    {
      const v = mount("box-w22", "ink=600", { firstPrompt: "되살리며 보낸 말 W22" }, true, null, false, { node: "sesshost-test" });
      echoAt("box-w22", 2600, "되살리며 보낸 말 W22");
      await sleep(1800);
      const ink = v.fx()["test-ink"];
      R.w22 = { during: v.snap(), n: v.count("되살리며 보낸 말 W22"), qstate: v.qstate(), inkAt: ink ? ink.at - v.t0 : null, echoAt: ECHO["box-w22"].at - v.t0 };
      await sleep(2400);
      R.w22.after = v.snap(); R.w22.termAt = v.termAt(); R.w22.qstateAfter = v.qstate(); R.w22.focused = !!v.fx()["test-focused"];
      v.done();
    }
    // W23 — 그렸는데 말이 끝내 안 들어간다(그리기는 3초 뒤 — 그 전의 읽는 주기도 잰다)
    {
      const v = mount("box-w23", "ink=3000", { firstPrompt: "첫 지시 W23" });
      await sleep(8000);
      R.w23 = { at8s: v.snap(), qstate: v.qstate() };
      await sleep(7000);
      const ink = v.fx()["test-ink"];
      R.w23.at15s = v.snap(); R.w23.inkAt = ink ? ink.at - v.t0 : null; R.w23.termAt = v.termAt();
      R.w23.reads = FETCHES.filter((f) => f.sid === "box-w23").map((f) => f.start - v.t0);
      v.done();
    }
    // W24 — 그 컴퓨터의 세션(중앙 기록으로만 읽힌다)
    {
      const v = mount("box-w24", "ink=600", { firstPrompt: "첫 지시 W24" }, true, null, false, { node: "n-w24" });
      await sleep(2000);
      const ink = v.fx()["test-ink"];
      R.w24 = { after: v.snap(), qstate: v.qstate(), inkAt: ink ? ink.at - v.t0 : null, termAt: v.termAt() };
      v.done();
    }
    // W25 — 기록 읽기가 느리다 · 그 말은 이미 기록에 있다
    {
      const v = mount("box-w25", "ink=300", { firstPrompt: "되살리며 보낸 말 W25" }, true, null, false, { node: "sesshost-test" });
      await sleep(1100);
      R.w25 = { during: v.snap(), painted: !!v.fx()["test-ink"] };
      await sleep(1400);
      R.w25.after = v.snap(); R.w25.termAt = v.termAt(); R.w25.qstate = v.qstate();
      v.done();
    }
    // W26 — 읽기가 느린데(0.5초) 하네스가 그 읽기 도중에 그렸다 → 그린 순간의 읽기가 도는 읽기와 겹치면 같은 줄을 두 번 그린다
    {
      echoAt("box-w26", 700, "보낸 말 W26");
      const v = mount("box-w26", "ink=1000", { firstPrompt: "보낸 말 W26" });
      await sleep(300);
      const inp = v.input();
      inp.focus(); inp.value = "쓰는 중"; inp.dispatchEvent(new Event("input"));   // 화면을 대화창에 붙잡아 둔다(보이는 글로 센다)
      await sleep(3200);
      const f26 = FETCHES.filter((f) => f.sid === "box-w26");
      R.w26 = { n: v.count("보낸 말 W26"), after: v.snap(), ink: !!v.fx()["test-ink"],
        overlapped: f26.some((a, i) => f26.some((b, j) => j > i && a.start < b.end && b.start < a.end)) };
      v.done();
    }
    // W27 — 새로 연 세션 · 기록 파일이 말이 들어가면서 생긴다
    {
      NOTYET["box-w27"] = Date.now() + 2600;
      echoAt("box-w27", 2600, "첫 지시 W27");
      const v = mount("box-w27", "ink=600", { firstPrompt: "첫 지시 W27" });
      await sleep(1800);
      R.w27 = { during: v.snap(), n: v.count("첫 지시 W27"), echoAt: ECHO["box-w27"].at - v.t0, ink: !!v.fx()["test-ink"] };
      await sleep(2400);
      R.w27.after = v.snap(); R.w27.termAt = v.termAt();
      v.done();
    }
    // W29 — 멤버 PC 행 · 박스 경로 409 node · 대화 id 모름(지켜볼 곳이 없다)
    {
      const v = mount("box-w29", "ink=600", { firstPrompt: "첫 지시 W29" }, true, null, false, { node: "pc-test" });
      await sleep(2000);
      const ink = v.fx()["test-ink"];
      R.w29 = { after: v.snap(), n: v.count("첫 지시 W29"), inkAt: ink ? ink.at - v.t0 : null, termAt: v.termAt() };
      v.done();
    }
    // W29b — 매니지드 행(세션 호스트) · 대화 id 모름 · 기록 파일이 말이 들어가면서 생긴다(박스 기록을 지켜본다 — #4904)
    {
      NOTYET["box-w29b"] = Date.now() + 2600;
      echoAt("box-w29b", 2600, "첫 지시 W29b");
      const v = mount("box-w29b", "ink=600", { firstPrompt: "첫 지시 W29b" }, true, null, false, { node: "sesshost-test" });
      await sleep(1800);
      const ink = v.fx()["test-ink"];
      R.w29b = { during: v.snap(), n: v.count("첫 지시 W29b"), echoAt: ECHO["box-w29b"].at - v.t0, ink: !!ink };
      await sleep(2400);
      R.w29b.after = v.snap(); R.w29b.termAt = v.termAt();
      v.done();
    }
    // W30 — 되살린 화면 · 그린 뒤 서버가 «다 쳤다»(에코 없음)
    {
      const v = mount("box-w30", "ink=600", { firstPrompt: "되살리며 보낸 말 W30\n둘째 줄" }, true, null, false, { node: "sesshost-test" });
      await sleep(1600);
      R.w30 = { before: v.snap(), ink: v.fx()["test-ink"] ? v.fx()["test-ink"].at - v.t0 : null };
      pushEv("box-w30", { t: "outbox.typed", id: 7, head: "되살리며 보낸 말 W30 둘째 줄" });   // 서버는 줄바꿈을 공백으로 편 한 줄을 친다
      const typedAt = Date.now() - v.t0;
      await sleep(800);
      R.w30.after = v.snap(); R.w30.termAt = v.termAt(); R.w30.typedAt = typedAt;
      v.done();
    }
    // W31 — «다 쳤다» 가 다른 말의 것
    {
      const v = mount("box-w31", "ink=600", { firstPrompt: "되살리며 보낸 말 W31" }, true, null, false, { node: "sesshost-test" });
      await sleep(1600);
      pushEv("box-w31", { t: "outbox.typed", id: 8, head: "다른 탭에서 보낸 말" });
      await sleep(1400);
      R.w31 = { after: v.snap(), termAt: v.termAt(), ink: !!v.fx()["test-ink"] };
      v.done();
    }
    // W32 — «다 쳤다» 가 그리기 전에
    {
      const v = mount("box-w32", "ink=1500", { firstPrompt: "되살리며 보낸 말 W32" }, true, null, false, { node: "sesshost-test" });
      await sleep(600);
      pushEv("box-w32", { t: "outbox.typed", id: 9, head: "되살리며 보낸 말 W32" });
      await sleep(400);
      R.w32 = { before: v.snap() };
      await sleep(1600);
      const ink = v.fx()["test-ink"];
      R.w32.after = v.snap(); R.w32.inkAt = ink ? ink.at - v.t0 : null; R.w32.termAt = v.termAt();
      v.done();
    }
    // W28 — 첫 말이 빗금 명령
    {
      const v = mount("box-w28", "ink=600", { firstPrompt: "/compact" });
      await sleep(2000);
      const ink = v.fx()["test-ink"];
      R.w28 = { after: v.snap(), inkAt: ink ? ink.at - v.t0 : null, termAt: v.termAt() };
      v.done();
    }
    // W33 — 리브 세션 · 첫 지시가 첫 실행 화면에 막혀 안 들어간다(에코 없음) · 리브 물음 하나
    {
      const v = mount("box-w33", "ink=600", { firstPrompt: "liv-connect 스킬로 이 워크스페이스의 외부 앱 연결을 도와줘.", livAsks: true });
      //  물음 자리가 어디 있나 — 대화창 안(chat) · 세션 겉(머리줄 아래, wrap) · 없음
      const dockAt = () => {
        const d = v.box.querySelector(".sc-liv-askdock");
        if (!d) return { at: "none", card: false };
        const at = d.closest(".sc-chat") ? "chat" : d.parentElement && d.parentElement.classList.contains("sc-wrap") ? "wrap" : "other";
        return { at, card: d.childElementCount > 0, text: (d.textContent || "").slice(0, 40) };
      };
      await sleep(1500);
      R.w33 = { before: v.snap(), dockBefore: dockAt(), tui: !!v.box.querySelector(".livc-tui") };
      await sleep(9500);
      const ink = v.fx()["test-ink"];
      R.w33.after = v.snap(); R.w33.dockAfter = dockAt(); R.w33.inkAt = ink ? ink.at - v.t0 : null; R.w33.termAt = v.termAt();
      //  W33b — 사람이 대화로 돌아간다
      const more = v.box.querySelector('button[aria-label="더 보기"]');
      if (more) more.click();
      await sleep(150);
      const back = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "대화로");
      if (back) back.click();
      await sleep(200);
      R.w33.backBtn = !!back; R.w33.back = v.snap(); R.w33.dockBack = dockAt();
      v.done();
    }
    // W34 — 리브 세션 · 물음 카드 입력칸에 치는 중에 저절로 터미널로 넘어간다
    {
      const v = mount("box-w34", "ink=600", { firstPrompt: "liv-connect 스킬로 이 워크스페이스의 외부 앱 연결을 도와줘.", livAsks: true });
      await sleep(1200);
      const inp = v.box.querySelector(".sc-liv-askdock .liv-ask-input");
      R.w34 = { hasInput: !!inp, before: v.snap() };
      if (inp) { inp.focus(); inp.value = "sk-w34-secret"; inp.dispatchEvent(new Event("input", { bubbles: true })); }
      R.w34.focusedBefore = !!inp && document.activeElement === inp;
      await sleep(9500);
      const a = document.activeElement;
      const d = v.box.querySelector(".sc-liv-askdock");
      R.w34.after = v.snap();
      R.w34.inWrap = !!d && !d.closest(".sc-chat") && !!d.parentElement && d.parentElement.classList.contains("sc-wrap");
      R.w34.keptFocus = !!inp && a === inp;
      R.w34.active = a ? a.tagName + "." + String(a.className || "") : "";
      R.w34.value = inp ? inp.value : null;
      R.w34.termFocused = !!v.fx()["test-focused"];
      v.done();
    }
  } catch (e) { R.err = String(e && e.stack || e); }
  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const files = mkdtempSync(path.join(tmpdir(), "term-warm-src-"));
const write = (name, text) => { const f = path.join(files, name); writeFileSync(f, text); return f; };
const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script type="text/plain" id="src">${sc.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
let dom;
try {
  dom = await dumpDom(chrome, {
    html: page, serve: true, prefix: "term-warm-", virtualTimeBudget: 240000, timeoutMs: 60000, args: ["--window-size=1200,900"],
    copy: [...CSS, ...XTERM, write("frame.html", FRAME), write("tm.js", tm)],
  });
} finally { rmSync(files, { recursive: true, force: true }); }
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 400)}`); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const Js = (v) => JSON.stringify(v);
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${Js(got)}`); } };
if (R.fatal || R.err) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

const w1 = R.w1 || {};
const b1 = w1.before || {};
check(!b1.term && b1.warm && b1.chatShown && b1.frame && !b1.termHidden && b1.inert && b1.vis === "hidden",
  "W1 그리기 전 — 대화창이 보이고 터미널 액자는 숨은 채 붙어 있다(visibility:hidden · inert)", b1);
const g1 = w1.geo || { chat: [], term: [] };
check(g1.chat.length === 3 && g1.chat.every((x, i) => near(x, g1.term[i])) && !!w1.boot && near(w1.boot.w, g1.chat[2]) && near(w1.boot.h, g1.chat[1]),
  "W1 숨은 액자는 대화창과 같은 자리·같은 크기다(넘길 때 크기가 안 바뀐다)", { geo: g1, frame: w1.boot && [w1.boot.w, w1.boot.h] });
check(!!w1.boot && w1.boot.hidden === true && b1.focus === "input",
  "W1 숨은 액자는 붙자마자 초점을 가져가지 않는다 — 초점은 대화창 입력칸", { boot: w1.boot, focus: b1.focus });
const a1 = w1.after || {};
check(a1.term && !a1.warm && !a1.chatShown && !a1.termHidden && !a1.inert && a1.vis === "visible" && !a1.inlineBox,
  "W1 그린 뒤 — 터미널로 넘어갔다(숨김·inert·임시 자리 걷힘)", a1);
check(w1.inkAt != null && w1.termAt > 0 && w1.termAt >= w1.inkAt && w1.termAt - w1.inkAt <= 700,
  "W1 넘긴 때 = 하네스가 그린 뒤 · 멎기를 조금(0.3초) 기다린 만큼만 늦게", { inkAt: w1.inkAt, termAt: w1.termAt });
check(w1.focused && a1.focus === "frame", "W1 넘긴 뒤 터미널에 초점(바로 칠 수 있다)", { focused: w1.focused, focus: a1.focus });

const w2 = (R.w2 || {}).at200 || {};
check(w2.term && !w2.warm && w2.frame && !w2.inert, "W2 그냥 연 화면은 종전처럼 처음부터 터미널(숨겨 붙이기 없음)", w2);

const w3 = R.w3 || {};
check((w3.at5s || {}).warm && !(w3.at5s || {}).term && (w3.at20s || {}).warm && !(w3.at20s || {}).term, "W3 공백만 오면 «그렸다» 가 아니다 — 5초에도 · 20초에도 대화창(느린 하네스를 기다린다)", { at5s: w3.at5s, at20s: w3.at20s });
check((w3.at26s || {}).term && !(w3.at26s || {}).warm && w3.termAt >= 24500 && w3.termAt <= 26000,
  "W3 끝내 안 그리면 상한(25초) 뒤 종전처럼 터미널로", { at26s: w3.at26s, termAt: w3.termAt });

const w4 = R.w4 || {};
check(w4.menu && w4.btn && (w4.afterPick || {}).term && !(w4.afterPick || {}).warm && w4.focused && (w4.afterPick || {}).focus === "frame",
  "W4 숨겨 붙이는 중 사람이 [터미널로] → 곧바로 터미널 · 초점도 터미널(숨어 붙을 때 못 잡은 초점)", w4);
check(w4.ink && (w4.afterInk || {}).term && !(w4.afterInk || {}).warm, "W4 그 뒤 신호가 와도 그대로 터미널", w4.afterInk);

const w5 = R.w5 || {};
const a5 = w5.after || {};
check(w5.ink && !a5.term && !a5.warm && a5.chatShown && a5.termHidden && w5.value === "추가로 이것도" && a5.focus === "input",
  "W5 입력칸에 쓰는 중이면 그려도 화면을 뺏지 않는다(대화창 · 글 · 초점 그대로)", w5);
check(!(w5.afterUpdate || {}).term && (w5.afterUpdate || {}).chatShown, "W5 그 뒤 목록 갱신도 쓰던 대화창을 터미널로 안 가져간다(대화창을 고른 것으로 친다)", w5.afterUpdate);

const w6 = R.w6 || {};
const a6 = w6.after || {};
check(!a6.term && !a6.frame && !a6.warm && a6.chatShown && !w6.termAt,
  "W6 숨겨 붙이는 중 «박스 없음» → 액자를 걷고 대화창(터미널로 안 넘어감)", w6);

const w7 = R.w7 || {};
check((w7.afterUpdate || {}).warm && !(w7.afterUpdate || {}).term, "W7 목록 갱신이 «살아 있다» 를 다시 줘도 그리기 전엔 넘기지 않는다", w7.afterUpdate);
check((w7.after || {}).term && !(w7.after || {}).warm, "W7 그린 뒤에는 넘긴다", w7.after);

const w8 = R.w8 || {};
check((w8.after || {}).term && w8.inkAt != null && w8.termAt - w8.inkAt >= 1300 && w8.termAt - w8.inkAt <= 2200,
  "W8 쉬지 않고 다시 그려도 처음 그린 때부터 1.5초 상한에 넘긴다", { inkAt: w8.inkAt, termAt: w8.termAt });

const w9 = R.w9 || {};
const a9 = w9.after || {};
check(!a9.term && !a9.warm && !a9.frame && a9.chatShown && !w9.termAt, "W9 터미널이 없는 화면은 숨겨 붙이기 없이 대화창(종전)", w9);

const w10 = R.w10 || {};
check(!(w10.atOpen || {}).frame && !(w10.atOpen || {}).term && (w10.afterUpdate || {}).warm && (w10.afterUpdate || {}).frame && !(w10.afterUpdate || {}).term,
  "W10 열 때 터미널이 없었으면 — 갱신으로 생길 때 곧바로 넘기지 않고 숨겨 붙인다", w10);
check((w10.after || {}).term && w10.inkAt != null && w10.termAt >= w10.inkAt, "W10 그린 뒤에 넘긴다", { inkAt: w10.inkAt, termAt: w10.termAt, after: w10.after });

const noWarm = (x) => !!x && !x.term && !x.warm && !x.frame && x.chatShown;
check(noWarm((R.w11 || {}).after) && !(R.w11 || {}).termAt, "W11 대화가 본자리인 화면(chatHome)은 첫 지시가 있어도 숨겨 붙이지 않는다", R.w11);
check(noWarm((R.w12 || {}).after) && !(R.w12 || {}).termAt && (R.w12 || {}).value === "못 간 글", "W12 못 간 글을 들고 온 화면은 숨겨 붙이지 않는다 · 글은 입력칸에", R.w12);
check(noWarm((R.w13 || {}).after) && !(R.w13 || {}).termAt, "W13 관측 못 한 행(observed:false)은 숨겨 붙이지 않는다", R.w13);
const w14 = R.w14 || {};
check((w14.before || {}).warm && w14.warmAfterDestroy === false && Array.isArray(w14.newErrors) && !w14.newErrors.length, "W14 숨겨 붙이는 중 부서지면 그 자리에서 걷힌다(상한 타이머도 함께 거둔다) · 오류 0", w14);
const w15 = R.w15 || {};
const g15 = w15.geo || { chat: [], term: [] };
check((w15.hiddenSnap || {}).warm && w15.watchesChat && (w15.shownSnap || {}).warm && !(w15.shownSnap || {}).term && g15.chat.length === 3 && g15.chat[1] > 100 && g15.chat.every((x, i) => near(x, g15.term[i])),
  "W15 숨은 탭에서 열렸다 보이면(대화창 칸의 크기 변화) 숨은 액자가 그때 대화창 자리·크기로 맞춰진다", { watches: w15.watchesChat, hiddenGeo: w15.hiddenGeo, shown: w15.shownSnap, geo: g15 });
check((w15.after || {}).term && !(w15.after || {}).warm && w15.disconnected === true, "W15 그린 뒤 넘긴다 · 대화창 칸 지켜보기는 끊는다", { after: w15.after, watchers: w15.watchers, disconnected: w15.disconnected });
const w16 = R.w16 || {};
check((w16.after || {}).term && !(w16.after || {}).warm && w16.endAt != null && w16.termAt >= w16.endAt - 50 && w16.termAt <= w16.endAt + 400,
  "W16 액자가 «끝났다» 고 하면 기다리지 않고 그 자리에서 터미널로(배너를 보게)", w16);
const w17 = R.w17 || {};
check((w17.after || {}).term && !w17.focusedFrame && w17.active === "outside", "W17 이 화면 밖에 초점이 있으면 넘기되 초점은 빼앗지 않는다", w17);
const w18 = R.w18 || {};
check((w18.after || {}).warm && !(w18.after || {}).term && /재연결/.test(String((w18.after || {}).chip || "")), "W18 연결 오류는 넘기지 않되 머리줄 칩으로 보인다", w18.after);

const w19 = R.w19 || {};
check(!(w19.afterUpdate || {}).warm && !(w19.afterUpdate || {}).term && w19.ink && !(w19.after || {}).term && !w19.termAt,
  "W19 숨겨 붙이는 중 «대화가 본자리» 를 알게 되면 접고 · 그려도 터미널로 안 넘긴다", w19);

const w20 = R.w20 || {};
check((w20.during || {}).warm && !(w20.during || {}).term && w20.prev === 1 && w20.n === 1 && /전달 대기 중/.test(String(w20.qstate || "")),
  "W20 되살린 화면(매니지드 행 · 기록 있음) — 기다리는 동안 방금 보낸 말이 대화창에 대기 말풍선으로 한 번 보인다", w20);
const w20b = R.w20b || {};
check((w20b.during || {}).warm && w20b.n === 1 && !w20b.qstate, "W20b 기록에 이미 그 말이 있으면 두 번 그리지 않는다(대기 말풍선 없음)", w20b);

const w21 = R.w21 || {};
check(w21.hasInput && !(w21.duringRevive || {}).term && !(w21.after || {}).term && w21.routed === "box-w21",
  "W21 말로 되살리는 중 목록이 «살아 있다» 를 먼저 실어 와도 옛 화면을 빈 터미널로 넘기지 않는다 · 복원 뒤 같은 id 로 옮겨 간다", w21);

const w22 = R.w22 || {};
check(w22.inkAt != null && w22.inkAt < 1200 && (w22.during || {}).warm && !(w22.during || {}).term && (w22.during || {}).chatShown && w22.n === 1 && /전달 대기 중/.test(String(w22.qstate || "")),
  "W22 하네스가 그렸어도 보낸 말이 아직 안 들어갔으면 대화창에 머문다(대기 말풍선 그대로)", w22);
check((w22.after || {}).term && !(w22.after || {}).warm && w22.termAt >= w22.echoAt && w22.termAt <= w22.echoAt + 1000 && !w22.qstateAfter && w22.focused,
  "W22 말이 기록에 나타난 뒤(읽는 주기 0.7초 안)에 터미널로 · 대기 줄은 걷히고 터미널에 초점", { echoAt: w22.echoAt, termAt: w22.termAt, after: w22.after, qstateAfter: w22.qstateAfter });
const w23 = R.w23 || {};
check((w23.at8s || {}).warm && !(w23.at8s || {}).term && /전달 대기 중/.test(String(w23.qstate || "")) && w23.inkAt != null && w23.inkAt < 3600,
  "W23 그렸는데 말이 안 들어가면 — 그린 뒤 4초에도 대화창(대기 말풍선)", { at8s: w23.at8s, inkAt: w23.inkAt });
check((w23.at15s || {}).term && !(w23.at15s || {}).warm && w23.inkAt != null && w23.termAt - w23.inkAt >= 8200 && w23.termAt - w23.inkAt <= 8800,
  "W23 끝내 안 들어가면 그린 때부터 8초 뒤 터미널로(로그인·경고 창을 보게)", { inkAt: w23.inkAt, termAt: w23.termAt });
{
  const rd = w23.reads || [], ink = w23.inkAt ?? 0, sw = w23.termAt || 0;
  const n = (a, b) => rd.filter((t) => t >= a && t < b).length;
  const before = n(800, ink + 250), waiting = n(ink + 1300, ink + 7300), after = n(sw + 800, sw + 3600);
  check(before <= 1 && waiting >= 6 && after <= 1,
    "W23 읽는 주기 — 그리기 전엔 느리게 · 그린 뒤 말을 기다리는 동안만 0.7초 · 넘긴 뒤엔 다시 느리게", { before, waiting, after, reads: rd });
}
const w24 = R.w24 || {};
check((w24.after || {}).term && w24.inkAt != null && w24.termAt >= w24.inkAt && w24.termAt - w24.inkAt <= 700 && /전달 대기 중/.test(String(w24.qstate || "")),
  "W24 중앙 기록으로만 읽히는 세션은 에코를 기다리지 않고 그린 때 넘긴다(대기 말풍선은 있어도)", w24);
const w25 = R.w25 || {};
check(w25.painted && (w25.during || {}).warm && !(w25.during || {}).term,
  "W25 기록을 아직 읽는 중에 하네스가 그렸으면 — 다 읽을 때까지 대화창", w25.during);
check((w25.after || {}).term && w25.termAt >= 1450 && w25.termAt <= 2100 && !w25.qstate,
  "W25 다 읽어 보니 그 말이 이미 들어가 있으면 그 자리에서 터미널로(8초를 기다리지 않는다) · 대기 말풍선 없음", { termAt: w25.termAt, qstate: w25.qstate });

const w26 = R.w26 || {};
check(w26.ink && w26.overlapped && w26.n === 1 && (w26.after || {}).chatShown,
  "W26 그린 순간 깨운 읽기가 도는 읽기와 겹쳐도(겹침 확인) 보낸 말은 한 번만 그려진다 — 낡은 답은 버린다", w26);
const w27 = R.w27 || {};
check(w27.ink && (w27.during || {}).warm && !(w27.during || {}).term && w27.n === 1,
  "W27 새로 연 세션 — 기록 파일이 아직 없어도 보낸 말이 들어갈 때까지 대화창(그 말이 보인다)", w27);
check((w27.after || {}).term && w27.termAt >= w27.echoAt && w27.termAt <= w27.echoAt + 1000,
  "W27 기록 파일이 생기며 그 말이 나타난 뒤 터미널로", { echoAt: w27.echoAt, termAt: w27.termAt, after: w27.after });
const w28 = R.w28 || {};
check((w28.after || {}).term && w28.inkAt != null && w28.termAt >= w28.inkAt && w28.termAt - w28.inkAt <= 700,
  "W28 빗금 명령(/compact)은 에코를 기다리지 않고 그린 때 넘긴다", w28);
const w30 = R.w30 || {};
check(w30.ink != null && (w30.before || {}).warm && !(w30.before || {}).term,
  "W30 그렸어도 «다 쳤다» 전엔 대화창(에코 없음)", w30.before);
check((w30.after || {}).term && w30.termAt >= w30.typedAt && w30.termAt <= w30.typedAt + 300,
  "W30 서버가 그 말을 다 치고 Enter 까지 누른 순간(outbox.typed) 터미널로 — 기록 에코·8초를 기다리지 않는다", { typedAt: w30.typedAt, termAt: w30.termAt });
const w31 = R.w31 || {};
check(w31.ink && (w31.after || {}).warm && !(w31.after || {}).term && !w31.termAt,
  "W31 다른 말의 «다 쳤다» 로는 넘기지 않는다", w31);
const w32 = R.w32 || {};
check((w32.before || {}).warm && !(w32.before || {}).term && (w32.after || {}).term && w32.inkAt != null && w32.termAt >= w32.inkAt && w32.termAt - w32.inkAt <= 700,
  "W32 «다 쳤다» 가 그리기 전에 왔으면 — 그리기 전엔 대화창 · 그린 때 넘긴다", { before: w32.before, inkAt: w32.inkAt, termAt: w32.termAt });
const w33 = R.w33 || {};
check((w33.before || {}).warm && !(w33.before || {}).term && w33.tui && (w33.dockBefore || {}).at === "chat" && (w33.dockBefore || {}).card,
  "W33 리브 세션 — 그리기 전엔 tui 대화창(숨겨 붙임) · 물음 카드는 입력칸 위", { before: w33.before, tui: w33.tui, dock: w33.dockBefore });
check((w33.after || {}).term && w33.inkAt != null && w33.termAt - w33.inkAt >= 7800 && w33.termAt - w33.inkAt <= 8900,
  "W33 ★ 리브 세션도 첫 지시가 막혀 안 들어가면 그린 때부터 8초 뒤 터미널로 넘어간다(대화창에 머물지 않는다)", { after: w33.after, inkAt: w33.inkAt, termAt: w33.termAt });
check((w33.dockAfter || {}).at === "wrap" && (w33.dockAfter || {}).card,
  "W33 ★ 터미널을 보는 동안 리브 물음 카드가 머리줄 아래에 보인다(숨은 대화창 안에 갇히지 않는다)", w33.dockAfter);
check(w33.backBtn && !(w33.back || {}).term && (w33.dockBack || {}).at === "chat" && (w33.dockBack || {}).card,
  "W33b 대화로 돌아가면 리브 물음 카드도 입력칸 위(대화창 안)로 돌아온다", { btn: w33.backBtn, back: w33.back, dock: w33.dockBack });
const w34 = R.w34 || {};
check(w34.hasInput && w34.focusedBefore && (w34.after || {}).term && w34.inWrap,
  "W34 카드에 치는 중이어도 하네스가 뜨면 터미널로 넘어간다(카드는 머리줄 아래)", w34);
check(w34.keptFocus && w34.value === "sk-w34-secret" && !w34.termFocused,
  "W34 ★ 넘어갈 때 초점·값이 카드 입력칸에 남는다 — 터미널이 초점을 가져가면 이어 치는 비밀 값이 하네스 입력칸으로 간다", { keptFocus: w34.keptFocus, active: w34.active, value: w34.value, termFocused: w34.termFocused });
const w29 = R.w29 || {};
check((w29.after || {}).term && w29.inkAt != null && w29.termAt >= w29.inkAt && w29.termAt - w29.inkAt <= 700,
  "W29 지켜볼 기록이 없는 화면(멤버 PC 행 · 대화 id 모름 · 파일 없음)은 기다리지 않고 그린 때 넘긴다", w29);
const w29b = R.w29b || {};
check(w29b.ink && (w29b.during || {}).warm && !(w29b.during || {}).term && w29b.n === 1,
  "W29b 매니지드 행(세션 호스트 · 대화 id 모름 · 파일 없음) — 박스 기록을 지켜봐 그 말이 들어갈 때까지 대화창(#4904)", w29b);
check((w29b.after || {}).term && w29b.termAt >= w29b.echoAt && w29b.termAt <= w29b.echoAt + 1000,
  "W29b 기록 파일이 생기며 그 말이 나타난 뒤 터미널로(W27 과 같다)", { echoAt: w29b.echoAt, termAt: w29b.termAt, after: w29b.after });
{
  //  G — 겹친 읽기 가드의 배선(소스 글). 런타임으로 못 잡는 갈래를 한 글자도 안 빠뜨리게 박아 둔다.
  const scSrc = readFileSync(path.join(ROOT, "web/session-chat.ts"), "utf8");
  const pollBody = scSrc.slice(scSrc.indexOf("  async function poll(): Promise<void> {"), scSrc.indexOf("  function clearAll(): void {"));
  check(pollBody.length > 500
    && /if \(opening\) \{ schedule\(\); return; \}/.test(pollBody)
    && /if \(src !== src0 \|\| loadedTo !== from0\) \{ pokePoll\(\); return; \}/.test(pollBody)
    && /if \(src !== src0 \|\| loadedTo !== 0\) \{ pokePoll\(\); return; \}/.test(pollBody)
    && /warmSwitchIfDelivered\(\);[^\n]*\n\s*schedule\(\);\s*\n\s*\}\s*$/.test(pollBody),
    "G 겹친 읽기 가드 — 다시 여는 중엔 안 읽는다 · 오프셋·지켜보는 곳 둘 다 보고 버린 뒤 곧 다시 읽는다 · 압축 뒤 두 번째 읽기도 · 읽기 끝마다 넘길지 다시 본다",
    pollBody.length);
}

check(!(R.pageErrors || []).length, "E 페이지 오류 없음", R.pageErrors);
console.log(`\nterm-warm-runtime: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);

// 폰 곁칸 대응: 아이폰 확대 막기 · 문턱 한 벌 · 목록 한 벌 (#4443, 원준 2026-10-08 «이런 곁칸도 모바일에서 좀 대응되게»)
//  ⚠ stage 판: 붙은 앱(#4225 · session-app-pane)이 아직 없어 main 판의 SDK «쓰는 중» 신호(R) · 호스트 다리(H) · 머리줄 배선(W) 행은 뺐다.
//
//  화면 쪽(서랍의 독 · 쓰는 동안 아래 탭 바 · 크게 보기 · 머리줄 [붙은 앱])은 phone-side-pane-runtime.test.mjs 가 실제 크롬으로 본다.
//  여기는 빌드 없이(① ③) 또는 컴파일된 모듈로(②) 도는 값 시험이다.
//   ① 앱 화면 주입 문자열(web/v2/app-ui-runtime.ts APP_RUNTIME_JS)을 소스에서 꺼내 vm 에서 돌린다(app-sdk-bridge.test.mjs 와 같은 방법).
//   ② 호스트 다리(web/v2/app-ui.ts)는 컴파일된 public/app/v2/app-ui.js 를 가짜 iframe 으로 돌린다(빌드가 없으면 건너뛰고 적는다).
//   ③ public/index.html 의 아이폰 확대 막기 인라인 스크립트를 꺼내 vm 에서 돌린다.
//
// 사양(엣지 표, 행마다 단언 하나 이상):
//  R1 글 칸(textarea)에 초점 → ui/typing {on:true} 한 번 · R2 글 칸 → 다른 글 칸(입력칸): 더 보내지 않는다(끄고 켜지 않음)
//  R3 단추로 옮김 → {on:false} · R4 체크 상자 · 라디오 · 범위 · 파일 · 제출 · 되돌림 · 색 · 그림 · 숨김 · 단추형 입력칸은 글 상자가 아니다
//  R5 읽기 전용 · 꺼진 칸은 글 상자가 아니다 · R6 편집 가능한 글(contenteditable)은 글 상자다
//  R7a 앱 화면 밖을 눌러 프레임이 초점을 잃으면(칸에 focusout 이 오고 칸은 activeElement 로 남는다) {on:false}
//  R7b 창이 초점을 잃는데 칸에 focusout 이 안 와도(창 blur 만) {on:false}
//  R8 같은 칸에 초점 사건이 거듭 와도 한 번만 · R9 고르기 상자는 글 상자가 아니다(고르기 판은 자판이 아니고, 닫힌 뒤에도 초점이 남는다) · R10 type 없는 입력칸 · 검색 · 메일 · 숫자 · 암호는 글 상자
//  R11 document 가 없는 자리(시험용 vm)에서도 SDK 가 선다
//  H1 프레임이 보낸 ui/typing → onTyping(true) · H2 다른 창이 보낸 것은 무시 · H3 params 없음 · on 이 true 가 아닌 값 → false
//  H4 새 문서 인사(ui/initialize) → onTyping(false) · H5 다시 불러오기 → false · H6 내려가기 → false · H7 onTyping 없는 자리 → 던지지 않는다
//  H8 ui/typing 은 알림이다(답하지 않는다)
//  E1 아이폰 UA → viewport 에 «, maximum-scale=1» · E2 안드로이드 → 그대로 · E3 이미 maximum-scale 이 있으면 그대로
//  E4 Macintosh + 터치 5(아이패드) → 붙음 · E5 Macintosh + 터치 0(맥) → 그대로 · E6 iPad UA → 붙음 · E7 viewport meta 가 없어도 던지지 않는다
//  M1 HANDSET_MQ(mobile.ts) = 50-mobile.css «크게 보기» 블록의 미디어 조건(둘이 어긋나면 독은 없는데 창은 작거나 그 반대가 된다)
//  L1 50-mobile.css 의 «쓰는 중» 두 규칙(탭 바 숨김 · 서랍 bottom 0)의 :is() 목록이 같다
//  E0 viewport meta 가 확대 막기 스크립트보다 앞에 있다(뒤에 있으면 스크립트가 meta 를 못 찾아 조용히 아무 일도 안 한다)
//  W1 views.ts 가 appDoor 를 세션 화면(mountSessionChat)에 넘긴다 · W2 main.ts 가 칸 셸이 준 appDoor 를 renderSession 에 넘긴다
//   (appDoor 는 모든 고리에서 선택이라 tsc 가 빠진 고리를 못 잡는다. 셸 고리와 머리줄 단추는 phone-side-pane-runtime 이 실제로 세운다)
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = process.env.SRC_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
//  SOFT=1: 첫 실패에서 멈추지 않고 실패한 행을 다 적는다(fail-first 로 옛 판 · 돌연변이에 돌릴 때). 기본은 첫 실패에서 던진다.
const SOFT = process.env.SOFT === "1";
const fails = [];
const soft = (fn, name) => { try { fn(); pass++; } catch (e) { if (!SOFT) throw e; fails.push(name); } };
const plain = (v) => JSON.parse(JSON.stringify(v));
const eq = (a, b, name) => soft(() => assert.deepStrictEqual(plain(a), plain(b), name), name);
const ok = (v, name) => soft(() => assert.ok(v, name), name);
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };

// ══ ③ 아이폰 확대 막기(public/index.html 인라인 스크립트) ══
{
  const html = read("public/index.html");
  const m = /<script>(\(function\(\)\{[^<]*maximum-scale[^<]*)<\/script>/.exec(html);
  ok(m, "③ index.html 에 maximum-scale 을 붙이는 인라인 스크립트가 있다");
  const BASE = "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content";
  const run = (ua, touch, content = BASE, hasMeta = true) => {
    if (!m) return null;                                            // 스크립트가 없는 판(SOFT 로 옛 판을 돌릴 때). 아래 행이 실패로 적힌다
    const meta = { content, setAttribute(k, v) { if (k === "content") this.content = v; } };
    const ctx = vm.createContext({ navigator: { userAgent: ua, maxTouchPoints: touch }, document: { querySelector: (s) => (hasMeta && /viewport/.test(s) ? meta : null) } });
    vm.runInContext(m[1], ctx);
    return meta.content;
  };
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
  const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  eq(run(IPHONE, 5), BASE + ", maximum-scale=1", "E1 아이폰 → «, maximum-scale=1» 이 붙는다");
  eq(run(ANDROID, 5), BASE, "E2 안드로이드 → 그대로(손가락 확대를 막지 않는다)");
  eq(run(IPHONE, 5, BASE + ", maximum-scale=2"), BASE + ", maximum-scale=2", "E3 이미 maximum-scale 이 있으면 그대로");
  eq(run(MAC, 5), BASE + ", maximum-scale=1", "E4 Macintosh + 터치(아이패드 사파리) → 붙는다");
  eq(run(MAC, 0), BASE, "E5 맥(터치 없음) → 그대로");
  eq(run(IPAD, 5), BASE + ", maximum-scale=1", "E6 iPad UA → 붙는다");
  let threw = null; try { run(IPHONE, 5, BASE, false); } catch (e) { threw = e; }
  eq(threw, null, "E7 viewport meta 가 없어도 던지지 않는다");
}

// ══ M1 문턱 한 벌: JS(HANDSET_MQ) 와 CSS(«크게 보기» 블록) ══
{
  const js = /export const HANDSET_MQ = '([^']+)'/.exec(read("web/v2/mobile.ts"));
  ok(js, "M1 mobile.ts 에 HANDSET_MQ 가 있다");
  const css = read("public/styles/50-mobile.css");
  const at = css.indexOf(".v2-appui-ov {");
  ok(at > 0, "M1 50-mobile.css 에 «크게 보기» 규칙이 있다");
  const media = css.slice(0, at).match(/@media ([^{]+)\{[^@]*$/);
  eq(media && media[1].trim(), js && js[1], "M1 HANDSET_MQ = «크게 보기» 블록의 미디어 조건");
}

// ══ E0 · L1: 순서 · 목록 한 벌 ══
{
  const html = read("public/index.html");
  const meta = html.indexOf('<meta name="viewport"'), scr = html.indexOf("maximum-scale");
  ok(meta >= 0 && scr > meta, "E0 viewport meta 가 확대 막기 스크립트보다 앞에 있다");
  const css = read("public/styles/50-mobile.css");
  const lists = [...css.matchAll(/\.pn-pane\[data-zone="side"\](?: |:has\()+:is\(([\s\S]*?)\)\)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  eq([lists.length, lists[0] === lists[1]], [2, true], "L1 «쓰는 중» 두 규칙의 :is() 목록이 같다");
}

if (fails.length) { for (const n of fails) console.log("FAIL  " + n); console.log(`phone-side-pane: ${pass} 통과 · ${fails.length} 실패`); process.exit(1); }
console.log(`phone-side-pane: ${pass} 단언 통과`);

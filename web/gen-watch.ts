// web/gen-watch.ts — 낡은 화면 자가복구 (#1841, 정책 분기 #2126).
//
//  ── 왜 필요한가 ──
//  게이트웨이 자산이 갱신돼도 **이미 열려 있는 화면은 스스로 낡는다**. 브라우저 탭은 사람이
//  새로고침하면 되지만, 데스크톱 앱은 그 길이 사실상 없다:
//   · 창을 닫아도 죽지 않는다 — `close` 를 가로채 `hide()` 만 한다(desktop/main/main.mjs).
//   · 다시 열 때 주소·토큰이 그대로면 `loadURL` 을 **건너뛴다** — 그래서 처음 뜬 판을 계속 들고 있다.
//  실측(2026-08-21): 앱이 든 세대 7964959ed50d, 서버가 주는 세대 882a0a3d262e. 그 사이 dev 에 올라간
//  변경이 앱 사용자에게는 하나도 안 보였고, "반영 안 된 것 같다"가 세 번 반복됐다.
//
//  ── 어떻게 ──
//  화면이 **다시 보이는 순간**(hidden → visible, 창 포커스)에만 서버 세대를 묻고, 다르면 다시 싣는다.
//   · 그 순간을 고른 이유: 앱의 '닫기(=숨김) → 열기(=보임)'가 곧 사람이 화면을 다시 마주하는 때다.
//     주기적으로 폴링해 아무 때나 새로고침하면 **타이핑 중에 화면이 날아간다** — 그건 더 나쁘다.
//   · 처음 로드 직후에는 묻지 않는다(방금 받은 판이다).
//
//  ── 두 박스는 사정이 다르다 (#2126) ──
//  종전엔 세대가 다르면 **무조건** 다시 실었다. dev 박스는 그게 맞다 — serve-sync 가 60초마다
//  origin/stage 를 당겨 build:web 을 돌리므로(deploy/io.lvly.stage-sync.plist) 자산이 수시로 바뀌고,
//  개발자는 최신 판을 바로 보고 싶어 한다. 고객사 박스는 정반대다: 릴리스는 운영자가 수동으로 돌리는
//  드문 사건인데, 하필 그 한 번이 **글 쓰다 다른 창 갔다 돌아온 사람**의 입력을 통째로 날린다.
//  그래서 서버가 `/ui/__gen` 으로 정책을 함께 준다(src/web.ts assetReloadPolicy):
//   · auto   — 종전대로 즉시 다시 싣는다. 단 아래 isBusy() 가 걸리면 그때도 배너로 미룬다.
//   · notify — 배너만 띄우고 **사람이 누를 때** 싣는다. env 를 안 넣은 박스가 곧 고객사 박스이므로
//              이쪽이 기본이다. 정책을 모르는 구 서버에 붙어도 여기로 떨어진다(안전한 쪽).
//  ── 자기 세대를 읽는 법 (한 번 데였다) ──
//  처음엔 `import.meta.url` 의 `?v=` 만 봤는데, **이 모듈이 두 벌 로드되는 바람에** 안 먹었다:
//  클래식(main.js)은 `./gen-watch.js` 로, v2 는 `../gen-watch.js` 로 부르는데 서버 스탬퍼가 `./` 만
//  잡아서 후자엔 `?v=` 가 안 붙었다 → 다른 URL = 다른 인스턴스 = 세대를 못 읽고 조용히 아무것도 안 함.
//  스탬퍼는 고쳤지만(src/web.ts, `../` 도 처리), 여기서도 **문서의 진입 스크립트**를 폴백으로 본다 —
//  그건 HTML 스탬퍼가 늘 붙여 주는 값이라 모듈 경로가 어떻든 흔들리지 않는다.
function ownGen(): string {
  const fromModule = new URL(import.meta.url).searchParams.get("v");
  if (fromModule) return fromModule;
  const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src*="?v="]');
  return entry ? (new URL(entry.src, location.href).searchParams.get("v") || "") : "";
}
const MY_GEN = ownGen();
const MIN_GAP_MS = 5000;   // 연달아 보였다 숨었다 할 때 서버를 두들기지 않게
let lastAsk = 0;
let reloading = false;

type Policy = "auto" | "notify";

async function serverGen(): Promise<{ v: string; policy: Policy }> {
  const base = location.pathname.replace(/\/[^/]*$/, "/");   // /ui/ · /preview/<id>/ui/ 모두 그대로
  const r = await fetch(base + "__gen", { cache: "no-store", credentials: "same-origin" });
  if (!r.ok) throw new Error(String(r.status));
  const j = await r.json();
  // ⚠ 'auto 가 아니면 전부 notify' — 구 서버(필드 없음)·오타·깨진 응답이 전부 안전한 쪽으로 떨어진다.
  //  반대로 썼다가는 고객사 박스가 조용히 종전 동작으로 돌아간다(이 패치가 막으려던 그것).
  return {
    v: typeof j?.v === "string" ? j.v : "",
    policy: j?.reload === "auto" ? "auto" : "notify",
  };
}

/** 사람이 지금 뭔가 쓰고 있나 — 자동 리로드가 **날려 버릴 것**이 화면에 있나 (#2126).
 *
 *  판정 시점이 하필 '창에 막 돌아온 순간'이라, 브라우저가 포커스를 복원해 준 입력칸이 그대로 잡힌다 —
 *  그게 정확히 막고 싶은 경우다(글 쓰다 자리 비웠던 사람).
 *
 *  세기(harshness)를 필드 종류로 가른다:
 *   · input/select 은 **포커스가 있을 때만** — 검색창에 남은 글자 하나 때문에 auto 박스가 영영
 *     자동 갱신을 못 하면 dev 의 체감 속도를 잃는다.
 *   · textarea·contenteditable 은 **값만 있어도** — 긴 글일수록 잃으면 아프고, 되찾을 길이 없다.
 *   · iframe 에 포커스가 있으면 무조건 — 터미널·앱이 그 안에 있고 우리는 그 상태를 볼 수 없다.
 *   · 열린 모달(.ov-back, dialog[open])도 무조건 — 그 안에서 무언가 고르는 중이다.
 *  걸리더라도 막다른 길은 아니다: 배너로 미뤄 사람이 직접 누를 수 있다.
 */
function isBusy(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (a) {
    const tag = a.tagName;
    if (tag === "IFRAME") return true;
    if (a.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  }
  for (const t of Array.from(document.querySelectorAll("textarea"))) if (t.value.trim()) return true;
  for (const c of Array.from(document.querySelectorAll<HTMLElement>("[contenteditable]")))
    if (c.isContentEditable && (c.textContent || "").trim()) return true;
  if (document.querySelector(".ov-back, dialog[open]")) return true;
  return false;
}

// ── 갱신 배너 ────────────────────────────────────────────────────────────────
//  ⚠ 스타일을 **전부 인라인**으로 준다. 이 배너가 뜨는 판은 정의상 **낡은 판**이라, 새로 추가한 CSS
//   클래스가 그 판의 스타일시트에는 없다. 클래스에 기대면 하필 알려야 할 때 글자만 덩그러니 남는다.
//   색도 CSS 변수 대신 고정값이다(같은 이유 — 변수 이름이 그 판에 있으리라는 보장이 없다).
let banner: HTMLElement | null = null;
let noticedGen = "";   // 배너를 띄운 세대. 사람이 닫아도 다시 안 띄우고, **자동 리로드도 하지 않는다**

function showUpdateBanner(v: string): void {
  if (banner || noticedGen === v) return;
  noticedGen = v;
  const box = document.createElement("div");
  box.setAttribute("role", "status");
  box.setAttribute("aria-live", "polite");
  box.style.cssText = [
    "position:fixed", "left:50%", "top:16px", "transform:translateX(-50%)", "z-index:2147483000",
    // 좁은 화면에서는 버튼이 아랫줄로 접힌다 — 안 접으면 문구가 잘려 무슨 일인지 못 읽는다.
    "display:flex", "align-items:center", "gap:8px 12px", "flex-wrap:wrap", "justify-content:flex-end",
    "max-width:calc(100vw - 32px)", "padding:10px 12px 10px 16px",
    "border-radius:10px", "border:1px solid rgba(255,255,255,.14)",
    "background:#1f2430", "color:#f4f6fb",
    "box-shadow:0 8px 28px rgba(0,0,0,.32)",
    "font:500 13px/1.45 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Pretendard',sans-serif",
  ].join(";");

  const msg = document.createElement("span");
  msg.textContent = "새 버전이 나왔습니다.";
  //  ⚠ 자르지 않는다(종전 nowrap+ellipsis) — 이 배너의 문구는 한 줄뿐이라 잘리면 남는 게 없다.
  //   좁은 화면에서는 접히게 두고, 버튼은 위 flex-wrap 으로 아랫줄에 온전히 남는다.
  msg.style.cssText = "flex:1 1 auto;min-width:0";

  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "새로고침";
  go.style.cssText = [
    "flex:none", "padding:6px 12px", "border-radius:7px", "border:0", "cursor:pointer",
    "background:#4c8dff", "color:#fff", "font:600 13px/1 inherit",
  ].join(";");
  go.addEventListener("click", () => { reloading = true; location.reload(); });

  const later = document.createElement("button");
  later.type = "button";
  later.textContent = "나중에";
  later.setAttribute("aria-label", "이 알림 닫기");
  later.style.cssText = [
    "flex:none", "padding:6px 10px", "border-radius:7px", "cursor:pointer",
    "border:1px solid rgba(255,255,255,.18)", "background:transparent", "color:#c8cede",
    "font:500 13px/1 inherit",
  ].join(";");
  later.addEventListener("click", () => { box.remove(); banner = null; });

  box.append(msg, go, later);
  document.body.append(box);
  banner = box;
}

async function checkStale(): Promise<void> {
  if (reloading || !MY_GEN) return;
  const now = Date.now();
  if (now - lastAsk < MIN_GAP_MS) return;
  lastAsk = now;
  let got: { v: string; policy: Policy };
  try { got = await serverGen(); } catch { return; }   // 오프라인·게이트웨이 재시작 중 — 조용히 넘긴다
  if (!got.v || got.v === MY_GEN) return;
  // 한 번이라도 배너로 알린 세대는 사람의 결정에 맡긴다 — 알려 놓고 뒤에서 날리면 그게 더 놀랍다.
  if (got.policy === "auto" && noticedGen !== got.v && !isBusy()) {
    reloading = true;
    location.reload();
    return;
  }
  showUpdateBanner(got.v);
}

/** 화면이 다시 보이면 낡았는지 묻고, 정책에 따라 다시 싣거나 알린다. 진입점에서 한 번 부른다.
 *  ⚠ 두 번 불려도 리스너는 한 벌만 단다 — 클래식 진입점(main.ts)과 v2 진입점(bootV2)이 **둘 다** 부르고,
 *   v2 셸일 때는 그 둘이 같은 판에서 다 돌아 서버에 같은 질문을 두 번 하게 된다(실측). */
let armed = false;
export function watchStaleShell(): void {
  if (!MY_GEN || armed) return;
  armed = true;
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void checkStale(); });
  window.addEventListener("focus", () => { void checkStale(); });
}

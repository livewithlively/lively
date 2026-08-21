// web/gen-watch.ts — 낡은 화면 자가복구 (#1841).
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
//  ⚠ 자기 세대는 `import.meta.url` 의 `?v=` 에서 읽는다 — 서버가 모듈 스펙파이어에 심어 준 값이라
//   따로 주입할 자리가 필요 없다. 스탬프가 없으면(로컬 dev 등) 그냥 아무것도 하지 않는다.
const MY_GEN = new URL(import.meta.url).searchParams.get("v") || "";
const MIN_GAP_MS = 5000;   // 연달아 보였다 숨었다 할 때 서버를 두들기지 않게
let lastAsk = 0;
let reloading = false;

async function serverGen(): Promise<string> {
  const base = location.pathname.replace(/\/[^/]*$/, "/");   // /ui/ · /preview/<id>/ui/ 모두 그대로
  const r = await fetch(base + "__gen", { cache: "no-store", credentials: "same-origin" });
  if (!r.ok) throw new Error(String(r.status));
  const j = await r.json();
  return typeof j?.v === "string" ? j.v : "";
}

async function checkStale(): Promise<void> {
  if (reloading || !MY_GEN) return;
  const now = Date.now();
  if (now - lastAsk < MIN_GAP_MS) return;
  lastAsk = now;
  let v = "";
  try { v = await serverGen(); } catch { return; }   // 오프라인·게이트웨이 재시작 중 — 조용히 넘긴다
  if (!v || v === MY_GEN) return;
  reloading = true;
  location.reload();
}

/** 화면이 다시 보이면 낡았는지 묻고, 낡았으면 다시 싣는다. 진입점에서 한 번 부른다. */
export function watchStaleShell(): void {
  if (!MY_GEN) return;
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void checkStale(); });
  window.addEventListener("focus", () => { void checkStale(); });
}

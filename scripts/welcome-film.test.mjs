#!/usr/bin/env node
// 소개 영상(#5550, 원준님 2026-11-16 «리니어는 온보딩하면 맨 처음에 온보딩 영상 띄워 주잖아») — 인사 장면 · 재생기 · 자산.
//
//  (#5598, 상민 2026-11-24) 처음 설정의 영상과 셸의 안내 카드가 자리를 바꿨다 — 인사 장면에는 안내 카드 5장이, 온보딩 영상(기초)은
//   처음 설정을 지나 셸에 온 사람에게 창으로 한 번. 둘러보기 영상(INTRO_FILM)이 더해져 영상은 셋이다.
//
//  엣지 표 — 행마다 단언 하나 이상.
//   O1 인사 장면 = 안내 카드가 선다 · 영상은 없다 · [계속하기]는 숨는다(카드의 마지막 단추가 대신 누른다)
//   O2 카드 마지막 단추 → 확인 표식 · «영상 띄울 차례» 표식(★한 요청 — 둘로 나누면 서버의 통째 쓰기가 한쪽을 지운다) → 이름 장면 · 카드는 걷힌다 · 그 전에는 표식을 남기지 않는다
//   O3 카드를 못 세우면 그 자리에 종전 그림 · [계속하기]가 보이고 눌린다 → 이름
//   P1 처음 뜨는 영상 창 — 처음 설정을 지난 사람(due)에게 머리말과 함께 · «띄웠다» 표식을 남긴다 · 카드 팝업은 안 뜬다 · 소리 없음 · 인라인 · 상대경로 · 스스로 튼다
//   F1b 소리 — 내레이션 없는 영상엔 소리 단추가 없다 · 있는 영상은 음소거로 시작해 [소리 켜기] · 스피커로 켜고 끈다
//   F4 «움직임 줄이기» 면 스스로 틀지 않는다
//   F5 다시 보기 창 — 고른 영상이 뜬다 · 한 번에 하나 · Esc 로 닫히고 영상을 놓는다 · 머리말 없는 창은 종전 그대로
//   F6 영상 주소 — #/film/intro · tour · guide 가 제 영상을 가리킨다 · 모르는 이름 · 다른 주소는 null
//   S1 자산이 영상마다 있고(mp4 · 포스터), 영상은 머리(moov)가 앞에 있어 받는 대로 튼다 · 크기 상한
//   S2 사용 가이드 첫 화면에 영상 셋(라이블리 둘러보기 · 온보딩 영상(기초) · 사용 가이드(라이블리 동작원리))을 다시 보는 문이 있다 · 프리뷰가 mp4 를 영상 타입으로 준다
//  크롬이 없는 면에서는 런타임 행(O·P·F)을 조용히 건너뛴다(종료코드 0) — 정적 행(S1·S2)은 늘 돈다.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";
const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${String(e.message).split("\n")[0]}`); }
};

// ── 정적 ──
const FILM_FILES = [["welcome-film", 12], ["welcome-guide", 20], ["welcome-intro", 12]];   // [이름, 상한 MB] — 동작원리 영상은 길이가 두 배라 상한도 넉넉히
for (const [name, capMB] of FILM_FILES) t(`S1 자산 ${name} — mp4 · 포스터가 있고, 영상은 moov 가 mdat 앞(받는 대로 재생) · ${capMB}MB 아래`, () => {
  const mp4 = path.join(ROOT, `public/media/${name}.mp4`), poster = path.join(ROOT, `public/media/${name}-poster.jpg`);
  assert.ok(existsSync(mp4), `public/media/${name}.mp4 가 없다 — node scripts/welcome-film/render.mjs`);
  assert.ok(existsSync(poster), "포스터가 없다");
  const size = statSync(mp4).size;
  assert.ok(size > 200_000, `영상이 너무 작다(${size}바이트) — 굽다 만 파일`);
  assert.ok(size < capMB * 1048576, `영상이 ${capMB}MB 를 넘는다(${(size / 1048576).toFixed(1)}MB) — 이미지 · 저장소가 그만큼 무거워진다`);
  const buf = readFileSync(mp4);
  assert.equal(buf.subarray(4, 8).toString("latin1"), "ftyp", "mp4 가 아니다");
  const moov = buf.indexOf(Buffer.from("moov")), mdat = buf.indexOf(Buffer.from("mdat"));
  assert.ok(moov > 0 && mdat > 0 && moov < mdat, "★ moov 가 뒤에 있다(+faststart 없이 구웠다) — 다 받을 때까지 안 튼다");
  assert.equal(readFileSync(poster).subarray(0, 2).toString("hex"), "ffd8", "포스터가 JPEG 가 아니다");
});
t("S2 다시 보는 문 셋 · 프리뷰의 영상 타입 · 원본 도구", () => {
  const guide = read("web/guide/app.ts");
  assert.match(guide, /FILMS\.map\(\(f\) =>\s*el\('button', \{ class: 'gd-film'[^\n]*onclick: \(\) => openWelcomeFilm\(f\)/, "★ 사용 가이드 첫 화면이 영상마다 문을 세우지 않는다");
  assert.match(read("src/preview/routes.ts"), /"\.mp4": "video\/mp4"/, "프리뷰가 mp4 를 영상 타입으로 주지 않는다 — 미리 보기에서 영상이 안 뜬다");
  const wf = read("web/v2/welcome-film.ts");
  assert.match(wf, /src: 'media\/welcome-film\.mp4'/, "영상 주소가 문서 기준 상대경로가 아니다 — 프리뷰(/preview/<id>/ui/)에서 깨진다");
  assert.match(wf, /src: 'media\/welcome-guide\.mp4'/, "동작원리 영상 주소가 문서 기준 상대경로가 아니다");
  assert.match(wf, /label: '온보딩 영상\(기초\)'/, "★ 온보딩 영상 제목이 «온보딩 영상(기초)» 가 아니다(원준 2026-11-19)");
  assert.match(wf, /label: '사용 가이드\(라이블리 동작원리\)'/, "★ 동작원리 영상 제목이 «사용 가이드(라이블리 동작원리)» 가 아니다");
  assert.match(wf, /src: 'media\/welcome-intro\.mp4'/, "둘러보기 영상 주소가 문서 기준 상대경로가 아니다");
  assert.match(wf, /label: '라이블리 둘러보기'/, "둘러보기 영상 제목");
  assert.match(wf, /FILMS: readonly FilmSpec\[\] = \[INTRO_FILM, WELCOME_FILM, GUIDE_FILM\]/, "첫 화면에 늘어놓는 영상이 셋(개념 → 화면 → 원리)이 아니다");
  const ob = read("web/v2/onboarding.ts");
  assert.ok(!/mountWelcomeFilm|welcome-film\.js/.test(ob), "★ 처음 설정이 아직 영상을 문다 — 인사 장면에는 안내 카드가 선다");
  assert.ok(!/from '\.\/(apps|rail|shell-prefs|side)\.js'/.test(wf), "재생기가 셸을 문다 — 사용 가이드(클래식 번들)가 셸 전부를 끌고 온다");
  for (const f of ["film.html", "film.css", "film.js", "engine.js", "render.mjs", "gen-assets.mjs", "tour.html", "tour.js", "gen-tour.mjs", "guide.html", "guide.js", "guide.css", "gen-guide.mjs", "gen-common.mjs", "intro.html", "intro.css", "intro.js", "gen-intro.mjs", "share.css"]) assert.ok(existsSync(path.join(ROOT, "scripts/welcome-film", f)), `원본 도구가 없다: ${f}`);
});

// ── 런타임 ──
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 런타임 행(O·P·F)을 건너뜁니다(CHROME_BIN 으로 지정)"); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
const CSS = ["01-base.css", "41-onboarding.css", "54-share-guide.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const bundle = buildSync({
  stdin: { contents: "export { renderOnboarding } from './web/v2/onboarding.ts'; export { mountWelcomeFilm, openWelcomeFilm, filmOfRoute, WELCOME_FILM, GUIDE_FILM, INTRO_FILM } from './web/v2/welcome-film.ts'; export { maybeShowShareGuide, FIRST_FILM_HEAD } from './web/v2/share-guide.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "OB", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = { errors: [] };
  window.addEventListener("error", (e) => { if (e.message) R.errors.push(String(e.message)); });
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  //  서버는 가짜 — 보낸 POST 를 적어 두고, 프로필(GET liv-profile)은 행마다 갈아 끼운다.
  const posts = []; let profile = {};
  window.fetch = async (url, init) => {
    const p = new URL(String(url), location.href).pathname;
    if (init && init.method === "POST") posts.push([p, String(init.body || "")]);
    if (p === "/api/ui/me/welcome") return J({ progress: null });
    if (p === "/api/ui/me/liv-profile" && !(init && init.method === "POST")) return J(profile);
    return J({ ok: true });
  };
  const livPosts = () => posts.filter((x) => x[0] === "/api/ui/me/liv-profile").map((x) => x[1]);
  localStorage.setItem("lively_ui_token", "t");
  //  영상은 실제로 틀지 않는다 — play/pause 를 부른 횟수와 떠날 때 주소를 놓았는지만 잰다(파일이 없는 면이라 그대로 두면 곧 error 가 난다).
  let plays = 0, pauses = 0;
  HTMLMediaElement.prototype.play = function () { plays++; return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function () { pauses++; };
  HTMLMediaElement.prototype.load = function () { /* 받으러 가지 않는다 */ };
  let reduce = false;
  const oMM = window.matchMedia.bind(window);
  window.matchMedia = (q) => (/prefers-reduced-motion/.test(q) ? { matches: reduce, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : oMM(q));
  //  O3 — 카드를 세우는 순간(.sg-root 를 붙일 때)만 깨뜨린다.
  let failGuide = false;
  const oAppend = Node.prototype.appendChild;
  Node.prototype.appendChild = function (n) { if (failGuide && n && n.className === "sg-root") throw new Error("카드를 못 세운다(시험)"); return oAppend.call(this, n); };
  const OB = (new Function(document.getElementById("src").textContent + "\n;return OB;"))();
  let cur = null;
  const mount = () => {
    if (cur) { try { cur.destroy(); } catch (_) { /* 앞 판 */ } }
    sessionStorage.removeItem("lively-ob-v2");
    history.replaceState(null, "", "?scene=intro");
    const old = document.getElementById("root"); const host = document.createElement("div"); host.id = "root"; old.replaceWith(host);
    cur = OB.renderOnboarding(host, {});
    return host;
  };
  const shown = (n) => !!n && getComputedStyle(n).display !== "none";

  // O1
  let host = mount(); await sleep(30);
  const col = () => host.querySelector("#qcol");
  R.o1 = {
    scene: host.dataset.scene, card: !!host.querySelector("#qcol .ob-in-guide .sg-root"), steps: host.querySelectorAll('[data-sg="dots"] button').length,
    video: !!host.querySelector("video"), cls: col().classList.contains("ob-has-guide"), goShown: shown(host.querySelector("#introGo")), art: !!host.querySelector(".ob-in-art"),
    next: (host.querySelector('[data-sg="next"]') || {}).textContent, lead: shown(host.querySelector(".ob-in-lead")),
  };
  // O2 — 넷째 장까지는 표식 없이 넘어가고, 마지막 단추에서만 남긴다
  const n0 = livPosts().length;
  for (let i = 0; i < 4; i++) { host.querySelector('[data-sg="next"]').click(); await sleep(10); }
  R.o2 = { midScene: host.dataset.scene, midMarks: livPosts().slice(n0).filter((b) => /share_guide_seen|welcome_film_due/.test(b)), last: host.querySelector('[data-sg="next"]').textContent };
  host.querySelector('[data-sg="next"]').click(); await sleep(60);
  Object.assign(R.o2, { scene: host.dataset.scene, marks: livPosts().slice(n0).filter((b) => /share_guide_seen|welcome_film_due/.test(b)), card: !!document.querySelector(".sg-root"), cls: col().classList.contains("ob-has-guide") });
  // O3
  failGuide = true;
  host = mount(); await sleep(30);
  failGuide = false;
  R.o3 = { card: !!host.querySelector(".sg-root"), art: !!host.querySelector(".ob-in-art"), cls: col().classList.contains("ob-has-guide"), goShown: shown(host.querySelector("#introGo")), lead: shown(host.querySelector(".ob-in-lead")), slot: !!host.querySelector("#introGuide") };
  host.querySelector("#introGo").click(); await sleep(50);
  R.o3.after = host.dataset.scene;
  if (cur) { cur.destroy(); cur = null; }

  // P1 — 처음 설정을 지난 사람(due)이 셸에 왔다
  plays = 0; history.replaceState(null, "", location.pathname + "#/");
  profile = { share_guide_seen_at: "2026-11-24T00:00:00Z", welcome_film_due_at: "2026-11-24T00:00:01Z", welcome_film_seen_at: null };
  const n1 = livPosts().length;
  await OB.maybeShowShareGuide(); await sleep(30);
  {
    const m = document.querySelector(".wf-modal"), v = m && m.querySelector("video.wf-v");
    R.p1 = {
      modal: !!m, first: !!m && m.classList.contains("wf-first"), label: m && m.getAttribute("aria-label"),
      head: m && (m.querySelector(".wf-head b") || {}).textContent, note: m && (m.querySelector(".wf-head span") || {}).textContent,
      cards: !!document.querySelector(".sg-back"), marks: livPosts().slice(n1),
      src: v && v.getAttribute("src"), poster: v && v.getAttribute("poster"), muted: !!(v && v.muted), inline: !!(v && v.playsInline), controls: !!(v && v.controls), plays,
    };
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(20);
    R.p1.afterEsc = document.querySelectorAll(".wf-modal").length;
  }
  // F1b — 소리: 내레이션 없는 영상엔 소리 단추가 없다. 있는 영상(sound: true)은 음소거로 시작 · [소리 켜기] 로 켜고 걷힌다 · 스피커로 다시 끈다
  {
    const box = document.createElement("div"); document.body.append(box);
    const quiet = OB.mountWelcomeFilm({ autoplay: false }); box.append(quiet.root);
    R.f1b = { silent: { un: !!quiet.root.querySelector(".wf-unmute"), sp: !!quiet.root.querySelector(".wf-snd"), mutedCls: quiet.root.classList.contains("is-muted") } };
    quiet.destroy(); quiet.root.remove();
    const loud = OB.mountWelcomeFilm({ film: { ...OB.WELCOME_FILM, sound: true }, autoplay: false }); box.append(loud.root);
    const wf = loud.root, lv = wf.querySelector("video"), un = wf.querySelector(".wf-unmute"), sp = wf.querySelector(".wf-snd");
    Object.assign(R.f1b, { mutedCls: wf.classList.contains("is-muted"), un: !!un, sp: !!sp, spLabel0: sp && sp.getAttribute("aria-label") });
    un.click(); await sleep(10);
    R.f1b.afterUn = { muted: lv.muted, cls: wf.classList.contains("is-muted"), spLabel: sp.getAttribute("aria-label"), pressed: sp.getAttribute("aria-pressed") };
    sp.click(); await sleep(10);
    R.f1b.afterSp = { muted: lv.muted, cls: wf.classList.contains("is-muted") };
    loud.destroy(); box.remove();
  }
  // F4
  {
    reduce = true; plays = 0;
    const box = document.createElement("div"); document.body.append(box);
    const still = OB.mountWelcomeFilm({}); box.append(still.root);
    R.f4 = { plays, big: !!box.querySelector(".wf:not(.is-playing) .wf-big") };
    still.destroy(); box.remove(); reduce = false;
  }
  // F5
  OB.openWelcomeFilm(OB.GUIDE_FILM); OB.openWelcomeFilm();
  const m = document.querySelectorAll(".wf-modal");
  const mv = document.querySelector(".wf-modal video");
  R.f5 = { count: m.length, dialog: m[0] && m[0].getAttribute("role"), video: !!mv, label: m[0] && m[0].getAttribute("aria-label"), src: mv && mv.getAttribute("src"), first: m[0] && m[0].classList.contains("wf-first"), head: !!document.querySelector(".wf-modal .wf-head") };
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(20);
  R.f5.afterEsc = document.querySelectorAll(".wf-modal").length; R.f5.srcLeft = mv && mv.getAttribute("src");
  // F6
  const key = (h) => { const f = OB.filmOfRoute(h); return f ? f.src : null; };
  R.f6 = ["#/film/intro", "#/film/tour", "#/film/guide", "#/film/intro?from=cli", "#/film/nope", "#/film/", "#/films/intro", "#/film/constructor", "#/", ""].map(key);

  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre><div id="root"></div>
<script type="text/plain" id="src">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
const dom = await dumpDom(chrome, { html: page, serve: true, prefix: "ob-film-", virtualTimeBudget: 60000, timeoutMs: 90000, args: ["--window-size=1200,900"], copy: CSS });
const res = readOut(dom);
assert.ok(res.text !== null, `결과를 못 받았다 — ${res.out}`);
const R = JSON.parse(res.text);
assert.ok(!R.fatal, R.fatal);

t("O1 인사 장면에 안내 카드가 선다 — 영상은 없고 [계속하기]는 숨는다", () => {
  assert.equal(R.o1.scene, "intro");
  assert.equal(R.o1.card, true, "★ 인사 장면에 안내 카드가 없다");
  assert.equal(R.o1.steps, 5, `카드 장 수: ${R.o1.steps}`);
  assert.equal(R.o1.video, false, "★ 인사 장면에 아직 영상이 선다");
  assert.equal(R.o1.art, false, "카드와 종전 그림이 함께 선다");
  assert.equal(R.o1.cls, true); assert.equal(R.o1.lead, true, "«다섯 장으로 보여 드릴게요» 가 안 보인다");
  assert.equal(R.o1.goShown, false, "★ [계속하기]와 카드의 [다음]이 함께 보인다 — 어느 쪽이 다음인지 헷갈린다");
  assert.equal(R.o1.next, "다음");
});
t("O2 카드 마지막 단추 → 확인 표식 · «영상 띄울 차례» 표식 → 이름 · 카드는 걷힌다", () => {
  assert.equal(R.o2.midScene, "intro", "마지막 장 전에 장면이 넘어갔다");
  assert.deepEqual(R.o2.midMarks, [], "★ 끝까지 넘기기 전에 표식을 남긴다");
  assert.equal(R.o2.last, "확인 · 설정 시작하기", "마지막 단추 글");
  assert.equal(R.o2.scene, "name", "★ 마지막 단추가 다음 장면으로 안 간다");
  assert.deepEqual(R.o2.marks, ['{"share_guide_seen":true,"welcome_film_due":true}'], "★ 표식 둘을 한 요청으로 남기지 않는다 — 둘로 나눠 동시에 보내면 서버의 통째 쓰기가 한쪽을 지운다(카드 팝업이 또 뜨거나 영상 창이 안 뜬다)");
  assert.equal(R.o2.card, false, "떠난 카드가 남아 있다(키 입력을 계속 듣는다)"); assert.equal(R.o2.cls, false, "이름 장면까지 인사 칸 모양이다");
});
t("O3 카드를 못 세우면 종전 그림 + [계속하기] — 처음 설정은 그대로 간다", () => {
  assert.equal(R.o3.card, false);
  assert.equal(R.o3.art, true, "★ 종전 그림으로 되돌아가지 않는다(빈 자리)");
  assert.equal(R.o3.cls, false); assert.equal(R.o3.slot, false);
  assert.equal(R.o3.goShown, true, "★ 카드도 없고 [계속하기]도 없다 — 처음 설정이 막힌다");
  assert.equal(R.o3.lead, false, "카드가 없는데 «다섯 장으로 보여 드릴게요» 가 남았다");
  assert.equal(R.o3.after, "name", "[계속하기]가 죽었다");
});
t("P1 처음 설정을 지난 사람이 셸에 오면 온보딩 영상(기초)이 창으로 한 번 — 머리말 · «띄웠다» 표식 · 카드 팝업 없음", () => {
  assert.equal(R.p1.modal, true, "★ 영상 창이 안 뜬다");
  assert.equal(R.p1.first, true); assert.equal(R.p1.head, "라이블리 화면은 이렇게 생겼어요"); assert.match(R.p1.note || "", /사용 가이드/, "다시 볼 곳을 말하지 않는다");
  assert.equal(R.p1.label, "라이블리 화면은 이렇게 생겼어요");
  assert.equal(R.p1.cards, false, "★ 카드 팝업이 함께 뜬다");
  assert.deepEqual(R.p1.marks, ['{"welcome_film_seen":true}'], "★ «띄웠다» 를 안 남긴다 — 켤 때마다 뜬다");
  assert.equal(R.p1.src, "media/welcome-film.mp4"); assert.equal(R.p1.poster, "media/welcome-film-poster.jpg");
  assert.equal(R.p1.muted, true, "★ 소리가 켜져 있다 — 브라우저가 자동 재생을 막는다"); assert.equal(R.p1.inline, true, "아이폰에서 전체 화면으로 튄다");
  assert.equal(R.p1.controls, false, "브라우저 기본 조작줄이 함께 선다");
  assert.equal(R.p1.plays, 1, `스스로 튼 횟수: ${R.p1.plays}`);
  assert.equal(R.p1.afterEsc, 0, "Esc 로 안 닫힌다");
});
t("F1b 소리 — 내레이션 없는 영상엔 소리 단추가 없고, 있는 영상은 음소거로 시작해 [소리 켜기] 로 켜고 스피커로 다시 끈다", () => {
  assert.deepEqual(R.f1b.silent, { un: false, sp: false, mutedCls: false }, "★ 소리 없는 영상에 소리 단추가 선다 — 눌러도 아무 소리가 없다");
  assert.equal(R.f1b.mutedCls, true, "음소거 표시(is-muted)가 없다 — [소리 켜기] 가 안 뜬다");
  assert.ok(R.f1b.un && R.f1b.sp, "소리 단추가 없다");
  assert.equal(R.f1b.spLabel0, "소리 켜기");
  assert.deepEqual(R.f1b.afterUn, { muted: false, cls: false, spLabel: "소리 끄기", pressed: "true" }, "★ [소리 켜기] 를 눌러도 소리가 안 켜진다");
  assert.deepEqual(R.f1b.afterSp, { muted: true, cls: true }, "스피커로 다시 끄지 못한다");
});
t("F4 «움직임 줄이기» — 스스로 틀지 않고 재생 단추가 선다", () => { assert.equal(R.f4.plays, 0, `★ 스스로 튼 횟수: ${R.f4.plays}`); assert.equal(R.f4.big, true); });
t("F5 다시 보기 창 — 고른 영상 · 하나만 · Esc 로 닫히고 영상을 놓는다 · 머리말 없음", () => {
  assert.equal(R.f5.count, 1, `창 수: ${R.f5.count}`); assert.equal(R.f5.dialog, "dialog"); assert.equal(R.f5.video, true);
  assert.equal(R.f5.label, "사용 가이드(라이블리 동작원리)", "★ 고른 영상이 아니라 다른 영상이 뜬다"); assert.equal(R.f5.src, "media/welcome-guide.mp4");
  assert.equal(R.f5.first, false, "다시 보기 창이 처음 창의 모양이다"); assert.equal(R.f5.head, false);
  assert.equal(R.f5.afterEsc, 0, "Esc 로 안 닫힌다"); assert.equal(R.f5.srcLeft, null, "닫은 뒤에도 영상이 주소를 쥐고 있다");
});
t("F6 영상 주소 — #/film/intro · tour · guide · 모르는 이름은 null", () => {
  assert.deepEqual(R.f6, ["media/welcome-intro.mp4", "media/welcome-film.mp4", "media/welcome-guide.mp4", "media/welcome-intro.mp4", null, null, null, null, null, null]);
});
t("런타임 오류 없음", () => { assert.deepEqual(R.errors, []); });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

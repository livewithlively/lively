#!/usr/bin/env node
// 내 프로필 창 — **런타임** 회귀 테스트 (#4108, 원준 2026-09-20 신고 묶음)
//
// 사양(신고 그대로):
//  S1 알림 · 화면의 켜고 끄는 줄은 **체크박스가 아니라 스위치**다("체크박스 말고 이거 아이폰 토글처럼 좀 해봐").
//  S2 스위치를 누르면 그 자리에서 저장되고, 알약이 꺼진 모습으로 바뀐다.
//  S3 알림 설명에서 비유를 걷었다("놓치면 AI 가 그대로 서 있게 됩니다" 같은 문장이 없다).
//  S4 화면 ▸ AI 세션은 **두 줄 + 각 줄 밑 설명**이고, 둘을 되짚는 "첫째 칸 · 둘째 칸" 문단이 없다.
//  S5 둘째 줄은 첫째에 딸려 있다 — 첫째를 끄면 잠긴다.
//  S6 계정 · 보안의 [비밀번호]와 [계정 정리]는 **같은 얼굴**이다("같은 위계아니야? 왜 달라?").
//  S7 「라이블리를 최신 상태로 유지하기」가 [계정 · 보안]에 있다(종전 [AI 주입 문구] 발치).
//  S8 프로필 배경색은 12칸 표 말고 **연속으로** 고를 수 있다(색상환 + 색 코드 칸).
//  S9 밝은 색을 고르면 아바타 글자가 어두워진다 — 흰 글자가 안 보이는 색을 고를 수 있게 됐으므로.
//  S10 [AI 계정 연결]은 창 안에 카드를 또 그리지 않는다("박스 안에 박스가 또있는데 좀 어색한데").
//  S11 연결된 계정의 버튼은 [계정 바꾸기]다("다시로그인? 이게 뭐하는버튼인지 모르겠음").
//  S12 자격이 파일로 안 남는 하네스(agy)는 화면이 **스스로** 물어본다 — [확인] 버튼이 없다.
//
// 왜 소스 정규식으로 부족한가: 이 판의 절반이 **CSS 가 이기는가**(스위치가 실제로 알약으로 보이는가 ·
//  체크박스가 실제로 안 보이는가 · 글자색이 실제로 바뀌는가)와 **이벤트 순서**(끄면 아래가 잠기는가 ·
//  열자마자 프로브가 도는가)다. 이 프로젝트가 #830 에서 «문자열은 실렸는데 특이도에 져서 죽어 있던» 것을
//  밟았다 — 그래서 여기선 computed 로 닫는다.
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 내 프로필 창 런타임 검증 미실행");
  process.exit(0);
}

const bundle = buildSync({
  entryPoints: [path.join(ROOT, "web/v2/me-modal.ts")],
  bundle: true, format: "iife", globalName: "MEM", platform: "browser", target: "es2020",
  write: false, logLevel: "silent",
}).outputFiles[0].text;

const work = mkdtempSync(path.join(tmpdir(), "memodal-bundle-"));
const bundlePath = path.join(work, "memodal.js");
writeFileSync(bundlePath, bundle);

const STYLES = path.join(ROOT, "public/styles");
const cssFiles = readdirSync(STYLES).filter((n) => n.endsWith(".css")).sort();
const cssLinks = cssFiles.map((n) => `<link rel="stylesheet" href="./${n}">`).join("\n");

// 서버 대역 — 이 창이 여는 화면들이 부르는 것만.
const ACCOUNTS = [
  { key: "claude", label: "Claude Code", loggedIn: true, how: "file", where: "~/.claude", canLogout: true, scope: "member" },
  { key: "antigravity", label: "Antigravity", loggedIn: null, how: "probe", where: "-", canLogout: false, scope: "member" },
];

const html = `<!doctype html><html lang="ko"><meta charset="utf-8">
${cssLinks}
<body><pre id="out"></pre>
<script>
window.__posts = [];
window.fetch = async (url, opts) => {
  const u = String(url); const m = (opts && opts.method) || 'GET';
  if (m === 'POST') window.__posts.push({ u, body: opts && opts.body });
  const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('/api/ui/me/profile')) return J({ id: 'u1', display_name: 'Tester', email: 't@example.com', body_md: '' });
  if (u.includes('/api/ui/me/logins')) return J({ oidcAvailable: false });
  if (u.includes('/api/ui/me/liv-profile')) return J({});
  if (u.includes('/api/ui/me/notify-prefs')) return J({ prefs: { session_waiting: true, session_done: true, person: true } });
  if (u.includes('/api/ui/me/ai-accounts/check')) return J({ loggedIn: true, how: 'probe' });
  if (u.includes('/api/ui/me/ai-accounts')) return J({ accounts: window.__accounts });
  if (u.includes('/api/ui/me/headless')) return J({ harnesses: [] });
  if (u.includes('/api/ui/terminal/sessions')) return J({ sessions: [] });
  if (u.includes('/api/ui/org/runtime-config')) return J({ ok: true });
  if (u.includes('/api/ui/org')) return J({ canEdit: true, runtimeConfig: { hooks: { self_update: true } }, sections: {} });
  return J({});
};
window.__accounts = ${JSON.stringify(ACCOUNTS)};
</script>
<script src="./memodal.js"></script>
<script>
const out = document.getElementById('out');
const R = {};
const cs = (n, p) => n ? getComputedStyle(n).getPropertyValue(p) : null;
const nav = (label) => [...document.querySelectorAll('.v2me-nav-b')].find((b) => b.textContent.trim() === label);
const paneOf = (i) => [...document.querySelectorAll('.v2me-pane')][i];
const visible = () => [...document.querySelectorAll('.v2me-pane')].find((p) => !p.hidden);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    MEM.openMeModal({});
    for (let i = 0; i < 80 && !document.querySelector('.v2me-pane'); i++) await sleep(25);
    await sleep(80);

    // ── 알림 ──
    nav('알림').click();
    for (let i = 0; i < 80 && !visible().querySelector('.v2me-sw'); i++) await sleep(25);
    const nrows = [...visible().querySelectorAll('.v2me-sw')];
    R.notifyRows = nrows.length;
    R.notifyKnobs = nrows.filter((r) => r.querySelector('.v2a-sw')).length;
    const box0 = nrows[0].querySelector('input[type=checkbox]');
    R.boxOpacity = cs(box0, 'opacity');
    R.boxWidth = box0.getBoundingClientRect().width;
    const knob0 = nrows[0].querySelector('.v2a-sw');
    R.knobW = Math.round(knob0.getBoundingClientRect().width);
    R.knobH = Math.round(knob0.getBoundingClientRect().height);
    R.knobRadius = cs(knob0, 'border-radius');
    R.knobOnBg = cs(knob0, 'background-color');
    R.notifyText = visible().textContent;
    // 끄기 — 라벨을 누르면 체크박스가 바뀐다(진짜 입력이 살아 있다는 뜻이기도 하다)
    box0.click();
    await sleep(60);
    R.afterOff = knob0.classList.contains('off');
    R.knobOffBg = cs(knob0, 'background-color');
    R.postedNotify = window.__posts.filter((p) => p.u.includes('notify-prefs')).length;

    // ── 화면 ──
    nav('화면').click();
    await sleep(60);
    const lrows = [...visible().querySelectorAll('.v2me-sw')];
    R.lookRows = lrows.length;
    R.lookSub = lrows.length > 1 && lrows[1].classList.contains('v2me-sw-sub');
    R.lookSubIndent = lrows.length > 1 ? Math.round(lrows[1].getBoundingClientRect().left - lrows[0].getBoundingClientRect().left) : -1;
    R.lookText = visible().textContent;
    const aiBox = lrows[0].querySelector('input[type=checkbox]');
    const tabBox = lrows[1].querySelector('input[type=checkbox]');
    R.tabDisabledBefore = tabBox.disabled;
    aiBox.click(); await sleep(40);
    R.tabDisabledAfter = tabBox.disabled;
    R.subRo = lrows[1].classList.contains('ro');
    aiBox.click(); await sleep(40);
    R.tabDisabledBack = tabBox.disabled;

    // ── 계정 · 보안 ──
    nav('계정 · 보안').click();
    for (let i = 0; i < 80 && !visible().querySelector('.v2me-sw'); i++) await sleep(25);
    const acc = visible();
    R.accMoreRows = acc.querySelectorAll('.v2me-more').length;
    R.accFieldLabels = [...acc.querySelectorAll('.field > .field-label')].map((n) => n.textContent.trim());
    R.accHtmlHasUpdate = acc.textContent.includes('라이블리를 최신 상태로 유지하기');
    R.accWithdrawIsBtn = !![...acc.querySelectorAll('button.btn')].find((b) => b.textContent.trim() === '회원 탈퇴');

    // ── 프로필 ──
    nav('프로필').click();
    await sleep(60);
    const prof = visible();
    R.colorInputs = prof.querySelectorAll('input[type=color]').length;
    R.hexInputs = prof.querySelectorAll('.pjv-hex').length;
    const hex = prof.querySelector('.pjv-hex');
    const preview = () => prof.querySelector('.prof-ava-preview .pava');
    hex.value = '#ffe08a'; hex.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(30);
    R.lightBg = cs(preview(), 'background-color');
    R.lightInk = cs(preview(), 'color');
    hex.value = '#22305a'; hex.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(30);
    R.darkBg = cs(preview(), 'background-color');
    R.darkInk = cs(preview(), 'color');
    R.pickOn = !!prof.querySelector('.pjv-sw-pick.on');

    // ── AI 계정 연결 ──
    nav('AI 계정 연결').click();
    for (let i = 0; i < 120 && !visible().querySelector('.aiacct'); i++) await sleep(25);
    await sleep(250);
    const aip = visible();
    R.aiCards = aip.querySelectorAll('.card').length;
    R.aiRows = aip.querySelectorAll('.aiacct').length;
    R.aiBtns = [...aip.querySelectorAll('.aiacct-act button')].map((b) => b.textContent.trim());
    R.aiBadges = [...aip.querySelectorAll('.aiacct-badge')].map((b) => b.textContent.trim());
    R.probePosts = window.__posts.filter((p) => p.u.includes('ai-accounts/check')).length;
    R.aiText = aip.textContent;
  } catch (e) { R.error = String((e && e.stack) || e); }
  out.textContent = JSON.stringify(R);
  document.title = 'ENDRESULT';
  console.log('ENDRESULT');
})();
</script>`;

const dom = await dumpDom(chrome, {
  html, copy: [bundlePath, ...cssFiles.map((n) => path.join(STYLES, n))],
  marker: "ENDRESULT", prefix: "memodal-run-", virtualTimeBudget: 20000,
});
rmSync(work, { recursive: true, force: true });

const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!m && process.env.MEMODAL_DEBUG) console.log(dom.slice(0, 4000));
assert.ok(m, "결과를 못 받았습니다 — 페이지가 끝까지 안 돌았습니다");
const R = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
assert.ok(!R.error, "페이지에서 오류: " + R.error);

let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };

// S1 · S2 — 스위치
ok(R.notifyRows === 3, "S1a 알림 세 줄", String(R.notifyRows));
ok(R.notifyKnobs === 3, "S1b 세 줄 모두 스위치 알약을 갖는다", String(R.notifyKnobs));
ok(Number(R.boxWidth) <= 1 && R.boxOpacity === "0", "S1c 네이티브 체크박스는 눈에 안 보인다(지우진 않았다)", `w=${R.boxWidth} op=${R.boxOpacity}`);
ok(R.knobW === 38 && R.knobH === 22, "S1d 알약은 [AI 주입 문구] 탭과 같은 부품(38×22)", `${R.knobW}×${R.knobH}`);
ok(/999|50%|11px/.test(R.knobRadius), "S1e 알약은 둥글다", R.knobRadius);
ok(R.afterOff === true, "S2a 누르면 꺼진 모습으로 바뀐다");
ok(R.knobOnBg !== R.knobOffBg, "S2b 켜짐·꺼짐의 색이 실제로 다르다", `${R.knobOnBg} → ${R.knobOffBg}`);
ok(R.postedNotify === 1, "S2c 그 자리에서 한 번 저장한다", String(R.postedNotify));

// S3 — 비유 제거
ok(!R.notifyText.includes("그대로 서 있게"), "S3a 「AI 가 그대로 서 있게 됩니다」 없음");
ok(!R.notifyText.includes("화면 밖에 띄우는"), "S3b 「화면 밖에 띄우는」 없음");
ok(R.notifyText.includes("답하기 전까지 그 작업은 더 진행되지 않습니다"), "S3c 무슨 일이 벌어지는지 그대로 적는다");

// S4 · S5 — 화면 ▸ AI 세션
ok(R.lookRows === 2, "S4a AI 세션은 두 줄", String(R.lookRows));
ok(!R.lookText.includes("첫째 칸") && !R.lookText.includes("둘째 칸"), "S4b 되짚는 문단이 없다");
ok(R.lookText.includes("AI 세션도 같은 테마로"), "S4c 위 줄이 규칙을 말한다");
ok(R.lookSub === true && R.lookSubIndent >= 12, "S5a 아래 줄은 들여쓴 하위 항목", `indent=${R.lookSubIndent}`);
ok(R.tabDisabledBefore === false && R.tabDisabledAfter === true && R.tabDisabledBack === false,
  "S5b 위를 끄면 아래가 잠기고, 다시 켜면 풀린다", JSON.stringify([R.tabDisabledBefore, R.tabDisabledAfter, R.tabDisabledBack]));
ok(R.subRo === true, "S5c 잠긴 줄은 잠긴 얼굴을 한다(.ro)");

// S6 · S7 — 계정 · 보안
ok(R.accMoreRows === 0, "S6a [회원 탈퇴]가 «다른 화면으로 가는 링크» 얼굴을 벗었다", String(R.accMoreRows));
ok(R.accWithdrawIsBtn === true, "S6b [비밀번호]와 같은 단추 부품으로 선다");
ok(R.accFieldLabels.includes("비밀번호") && R.accFieldLabels.includes("계정 정리"),
  "S6c 둘이 같은 머리(field)로 선다", JSON.stringify(R.accFieldLabels));
ok(R.accHtmlHasUpdate === true, "S7 「라이블리를 최신 상태로 유지하기」가 이 탭에 있다");

// S8 · S9 — 배경색
ok(R.colorInputs === 1 && R.hexInputs === 1, "S8a 색상환 한 칸 + 색 코드 칸", `${R.colorInputs}/${R.hexInputs}`);
ok(R.lightBg === "rgb(255, 224, 138)" && R.darkBg === "rgb(34, 48, 90)", "S8b 표에 없는 색이 그대로 아바타에 실린다", `${R.lightBg} · ${R.darkBg}`);
ok(R.pickOn === true, "S8c 표 밖 색을 고르면 색상환 칸이 골라진 것으로 보인다");
ok(R.lightInk === "rgb(21, 35, 59)", "S9a 밝은 배경엔 어두운 글자", R.lightInk);
ok(R.darkInk !== R.lightInk, "S9b 어두운 배경엔 그대로 밝은 글자", R.darkInk);

// S10 · S11 · S12 — AI 계정 연결
ok(R.aiCards === 0, "S10 창 안에 카드를 또 그리지 않는다", String(R.aiCards));
ok(R.aiRows === 2, "S11a 계정 두 줄", String(R.aiRows));
ok(R.aiBtns.includes("계정 바꾸기"), "S11b 연결된 계정의 단추는 [계정 바꾸기]", JSON.stringify(R.aiBtns));
ok(!R.aiBtns.includes("다시 로그인"), "S11c 「다시 로그인」은 없다");
ok(!R.aiBtns.includes("확인"), "S12a [확인] 버튼이 없다", JSON.stringify(R.aiBtns));
ok(R.probePosts === 1, "S12b 화면이 열리자마자 스스로 한 번 물어본다", String(R.probePosts));
ok(R.aiBadges.filter((b) => b.includes("연결됨")).length === 2, "S12c 물어본 결과가 배지에 반영된다", JSON.stringify(R.aiBadges));
ok(!R.aiText.includes("확인 필요"), "S12d 사람에게 「확인 필요」를 남기지 않는다");

console.log(`\n✓ 내 프로필 창 런타임 ${pass}건 통과`);

// 낡은 화면 자가복구의 **정책·가드** 실행 검증 (#2126) — 회귀 대상: 릴리스가 사람의 입력을 날리는 것.
//
//  #1841 이 들인 gen-watch 는 자산 세대가 바뀌면 화면이 다시 보이는 순간 **무조건** 다시 실었다.
//  dev 박스는 그게 맞다(serve-sync 가 60초마다 stage 를 당겨 자산이 수시로 바뀐다). 고객사 박스는
//  정반대다 — 릴리스는 드문 사건인데 하필 그 한 번이 **글 쓰다 자리 비웠던 사람**의 입력을 통째로
//  날린다. 그래서 정책(서버, src/web.ts assetReloadPolicy)과 입력 중 가드(화면)를 들였다.
//
//  ⚠ 소스 문자열 검사가 아니라 **빌드 산출물을 실제로 실행**한다. gen-watch 는 우리 모듈 import 0 인
//   leaf 라(파일 머리 주석의 계약) DOM 스텁만으로 실물 그대로 돌아간다. 정규식으로 '분기가 있나'만
//   보면 분기가 있는 채로 뒤집혀도 통과한다 — 실제로 이 패치의 첫 판은 기본값이 auto 로 새 있었다.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILT = path.join(ROOT, "public", "app", "gen-watch.js");
// 없으면 **실패**시킨다 — 조용히 건너뛰면 '초록불인데 아무것도 안 본' 상태가 된다.
assert.ok(existsSync(BUILT), `빌드 산출물이 없다: ${BUILT} (npm run build 먼저 — 러너는 --build 로 붙인다)`);
const MOD = pathToFileURL(BUILT).href;

let caseNo = 0;

function makeEl(tag) {
  return {
    tagName: tag.toUpperCase(), style: { cssText: "" }, children: [], textContent: "", type: "",
    isContentEditable: false, attrs: {}, _on: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, h) { (this._on[k] ||= []).push(h); },
    click() { (this._on.click || []).forEach((h) => h()); },
    append(...kids) { this.children.push(...kids); },
    remove() { const i = globalThis.document.body.children.indexOf(this); if (i >= 0) globalThis.document.body.children.splice(i, 1); },
  };
}

/** 한 시나리오를 격리 실행 — 모듈 상태(MY_GEN·noticedGen·armed)가 다음 판에 새지 않게 매번 새로 import. */
async function run({ myGen, serverBody, textareaValue, activeTag, openModal }) {
  caseNo++;
  let reloads = 0;
  const body = { children: [], append(...k) { this.children.push(...k); } };
  const textareas = textareaValue === undefined ? [] : [{ value: textareaValue }];
  globalThis.document = {
    body, hidden: false,
    activeElement: activeTag ? { tagName: activeTag, isContentEditable: false } : null,
    createElement: makeEl,
    addEventListener() {},
    querySelector(sel) {
      if (sel.includes("script")) return { src: `http://x/ui/app/main.js?v=${myGen}` };
      if (sel.includes("ov-back")) return openModal ? {} : null;
      return null;
    },
    querySelectorAll(sel) { return sel === "textarea" ? textareas : []; },
  };
  const winListeners = {};
  globalThis.window = { addEventListener: (k, h) => { (winListeners[k] ||= []).push(h); } };
  globalThis.location = { pathname: "/ui/", href: "http://x/ui/", reload() { reloads++; } };
  globalThis.fetch = async () => ({ ok: true, json: async () => serverBody });

  const m = await import(`${MOD}?case=${caseNo}`);
  m.watchStaleShell();
  for (const h of winListeners.focus || []) await h();   // 창에 돌아온 순간 — 판정이 도는 유일한 지점
  await new Promise((r) => setTimeout(r, 0));            // checkStale 의 await 소화

  // ⚠ reloads 는 **getter** 다 — 스냅샷 숫자로 돌려주면 배너 버튼을 누른 뒤의 증가를 못 읽어
  //  '눌러도 안 실린다'는 거짓 실패가 난다(실제로 처음 그렇게 짰다).
  return { get reloads() { return reloads; }, banner: body.children.find((c) => c.attrs && c.attrs.role === "status") || null };
}

const OLD = "genA", NEW = "genB";
const notify = { v: NEW, reload: "notify" };
const auto = { v: NEW, reload: "auto" };
let n = 0;
const ok = (m) => { n++; console.log(`ok  ${m}`); };

// ── A. 고객사 박스(notify) — 말없이 날리지 않는다 ────────────────────────────
{
  const r = await run({ myGen: OLD, serverBody: notify });
  assert.equal(r.reloads, 0, "A1: notify 인데 말없이 다시 실었다 — 이 패치가 막으려던 바로 그것이다");
  assert.ok(r.banner, "A1: 알림도 없이 조용하면 사람은 낡은 판을 계속 쓴다");
  ok("A1 notify — 안 싣고 배너로 알린다");

  // 알림만 뜨고 방법이 없으면 막다른 길이다. 배너의 [새로고침] 이 실제로 동작해야 한다.
  const btn = r.banner.children.find((c) => c.textContent === "새로고침");
  assert.ok(btn, "A2: 배너에 [새로고침] 버튼이 없다");
  btn.click();
  assert.equal(r.reloads, 1, "A2: [새로고침] 을 눌러도 안 실린다 — notify 박스가 막다른 길이 된다");
  ok("A2 notify — 배너의 [새로고침] 이 실제로 다시 싣는다");
}

// ── B. dev 박스(auto) — 종전 속도를 지키되, 사람이 쓰던 것은 지킨다 ──────────
{
  const r = await run({ myGen: OLD, serverBody: auto });
  assert.equal(r.reloads, 1, "B1: auto 인데 안 실었다 — dev 의 개발 체감 속도를 잃는다");
  ok("B1 auto — 한가하면 종전대로 즉시 다시 싣는다");
}
for (const [label, opts] of [
  ["쓰던 글이 있는 textarea", { textareaValue: "쓰던 글" }],
  ["입력칸에 포커스", { activeTag: "INPUT" }],
  ["터미널(iframe)에 포커스", { activeTag: "IFRAME" }],
  ["열린 모달", { openModal: true }],
]) {
  const r = await run({ myGen: OLD, serverBody: auto, ...opts });
  assert.equal(r.reloads, 0, `B2: auto 라도 ${label} 상태에서 다시 실으면 사람이 쓰던 것이 날아간다`);
  assert.ok(r.banner, `B2: ${label} — 안 실었으면 대신 알려야 한다`);
  ok(`B2 auto — ${label} 이면 안 싣고 배너로 미룬다`);
}
{
  // 가드가 과하면 dev 가 영영 자동 갱신을 못 한다 — 빈 칸은 막지 않는다(공백만 있어도 빈 것으로 본다).
  const r = await run({ myGen: OLD, serverBody: auto, textareaValue: "   " });
  assert.equal(r.reloads, 1, "B3: 빈 입력칸까지 '작업 중'으로 보면 auto 박스가 영영 안 갱신된다");
  ok("B3 auto — 빈 입력칸은 막지 않는다");
}

// ── C. 세대·하위호환 ────────────────────────────────────────────────────────
{
  const r = await run({ myGen: NEW, serverBody: auto });
  assert.equal(r.reloads, 0, "C1: 세대가 같은데 다시 실었다(리로드 루프)");
  assert.equal(r.banner, null, "C1: 세대가 같은데 배너를 띄웠다");
  ok("C1 세대가 같으면 아무 일도 없다");
}
{
  // 정책을 모르는 구 게이트웨이. 'auto 가 아니면 전부 notify' 라서 안전한 쪽으로 떨어져야 한다.
  const r = await run({ myGen: OLD, serverBody: { v: NEW } });
  assert.equal(r.reloads, 0, "C2: 정책 없는 응답을 auto 로 읽었다 — 구 서버에 붙은 화면이 말없이 날린다");
  assert.ok(r.banner, "C2: 그 경우에도 알리기는 해야 한다");
  ok("C2 정책 없는 구 응답 → 안전한 쪽(배너)");
}

console.log(`gen-watch-policy: ${n} passed`);

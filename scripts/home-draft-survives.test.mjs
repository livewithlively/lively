// #2037 — "쳐 놓은 지시는 다른 창에 다녀와도 살아 있어야 한다".
//
// 원준 신고: *"새 작업으로 창 열어서 가운데 박스에 타이핑 쳐놨다가 프로젝트나 이런 다른 창 가서 뭐 좀 하다오면
//  타이핑해놓은 글자 전부 사라진다."* 원인은 둘이 겹친 것이었다:
//   ① 홈 탭은 '거쳐 가는 빈 탭'이라 거기서 연 화면이 **그 탭을 덮는다**(main.ts onHash ⓪ fromHome) —
//      쓰던 입력칸이 DOM 째로 사라졌다.
//   ② 홈의 입력칸은 값을 DOM 밖 어디에도 두지 않아 **되살릴 방법이 없었다**.
//
// ⚠ 왜 소스 텍스트를 보나: 이건 값이 아니라 **배선**의 성질이다(같은 규율: notification-banner-scope ·
//  pane-session-scope). 화면으로 재현하려면 셸 전체를 띄우고 창을 오가야 하는데, 그렇게 잡아도 정작
//  회귀는 '누가 이 배선을 지웠나'로 일어난다. 그 배선이 끊기는 것을 여기서 잡는다.
//  (화면 쪽 실증은 Playwright 로 따로 했다 — 엣지 표 8행, 스크래치패드 spec.md.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name, detail) => { assert.ok(cond, detail ? `${name}\n${detail}` : name); pass++; console.log(`ok  ${name}`); };

const VIEWS = read("web/v2/views.ts");
const MAIN = read("web/v2/main.ts");
const TABS = read("web/v2/tabs.ts");

function slice(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `구간 시작을 못 찾았다: ${from}`);
  const b = src.indexOf(to, a + 1);
  assert.ok(b > a, `구간 끝을 못 찾았다: ${to}`);
  return src.slice(a, b);
}

// ── 표 2·3행: 쓰던 글을 되받고, 고칠 때마다 밖에 알린다 ─────────────────────
const home = slice(VIEWS, "export function renderHome", "\n// nowList");
ok(/renderHome\([^)]*draft\?:\s*\{\s*text:\s*string;\s*onChange\(v:\s*string\):\s*void\s*\}/.test(home),
  "renderHome 은 초안(text·onChange)을 받는다",
  "  → 값을 DOM 안에만 두면 그 탭이 다른 화면으로 바뀌는 순간 함께 사라진다(#2037 원인 ②).");
ok(/ta\.value\s*=\s*draft\?\.text\s*\|\|\s*''/.test(home), "받은 초안을 입력칸에 되돌려 놓는다 (표 2·3행)");
ok(/addEventListener\('input',\s*\(\)\s*=>\s*\{[^}]*draft\?\.onChange\(ta\.value\)/.test(home),
  "글자를 칠 때마다 그 값을 밖(탭)으로 넘긴다 (표 7행)",
  "  → ⚠ 값만 넘긴다. 이 칸을 다시 그리면 한글 조합이 흩어진다(ime-safe-search-input-no-full-rerender).");

// ── 표 4·5행: 보내기는 **먼저 초안을 비우고** 서버를 부른다 ──────────────────
//  순서가 뒤집히면 라우터가 '쓰던 홈'으로 보고 방금 연 세션을 새 탭에 띄운다(홈 탭이 그 세션이 되어야 한다).
const submit = slice(home, "const submit = async", "send.onclick");
const clearAt = submit.indexOf("draft?.onChange('')");
const callAt = submit.indexOf("await openQuickSession");
ok(clearAt >= 0 && callAt > clearAt, "초안 비우기가 openQuickSession 호출보다 앞에 있다 (표 4행)",
  "  → 뒤에 두면 이동 시점엔 초안이 남아 있어 세션이 새 탭에 열린다(홈 탭 문법이 깨진다).");
ok(/if\s*\(!ok\)\s*\{\s*draft\?\.onChange\(ta\.value\)/.test(submit), "실패하면 초안을 되돌려 놓는다 (표 5행)",
  "  → 못 보냈는데 글까지 잃으면 두 번 잃는 것이다.");

// ── 표 1·6행: 쓰다 만 홈 탭만 덮이지 않는다(빈 홈은 종전대로 덮인다) ─────────
const onHash = slice(MAIN, "async function onHash()", "\n// Alt+클릭");
const guard = /if\s*\(!hop && fromHome && \(cur\.draft \|\| ''\)\.trim\(\)\)\s*\{\s*tabsApi\.add\(hash\); return; \}/.exec(onHash);
ok(!!guard, "쓰다 만 홈 탭이면 새 탭에서 연다 — 그 탭을 덮지 않는다 (표 1행)",
  "  → 홈을 '빈 새 탭'으로 보는 규칙(⓪)의 예외다: 사람이 이미 무언가를 쳐 뒀으면 빈 탭이 아니다.");
ok(!!guard && /\(cur\.draft \|\| ''\)\.trim\(\)/.test(guard[0]),
  "그 예외는 **글이 있을 때만** 걸린다 (표 6행 — 빈 홈은 종전대로 덮인다)",
  "  → 조건 없이 새 탭을 열면 [새 작업]을 누를 때마다 빈 홈 탭이 쌓인다(#1719 가 없앤 그 상태로 되돌아간다).");
const instAt = onHash.indexOf("!hop && !fromHome && (targetInstance || currentInstance)");
ok(instAt > onHash.indexOf(guard ? guard[0] : "\u0000"), "그 예외는 기존 새 탭 규칙보다 **앞에** 선다",
  "  → 뒤에 두면 프로젝트·앱으로 가는 이동이 먼저 그 탭을 덮어 버린다(원 신고의 그 경로).");

// ── 표 3행: 초안은 탭이 쥐고, 저장본에도 실린다(새로고침·앱 재시작을 넘긴다) ──
ok(/draft\?:\s*string;/.test(slice(TABS, "export interface ShellTab", "\n}")), "탭이 초안을 쥔다");
ok(/t\.draft\s*\?\s*\{\s*route:\s*t\.route,\s*title:\s*t\.title,\s*draft:/.test(TABS),
  "저장본에 초안이 함께 실린다", "  → 새로고침·앱 재시작을 넘기는 유일한 경로다.");
ok(/mkTab\(t\.route,[^)]*typeof t\.draft === 'string' \? t\.draft : undefined\)/.test(TABS),
  "복원할 때 그 초안을 탭에 되돌려 준다");
ok(/homeDraft\(tab\)/.test(MAIN) && /function homeDraft\(tab: ShellTab\)/.test(MAIN),
  "홈을 그릴 때 그 탭의 초안을 건네준다");

// ── 표 8행: 어느 창에 뭘 쓰다 말았는지 목록에서 갈린다 ───────────────────────
ok(/function draftLine\(/.test(MAIN) && /draftLine\(draft\) \|\| '아직 시작하지 않은 작업'/.test(MAIN),
  "쓰다 만 지시가 있으면 좌측 목록의 부제가 그 글로 바뀐다 (표 8행)",
  "  → [새 작업] 창이 여럿일 때 전부 '새 작업'이면 어느 것에 쓰다 말았는지 못 찾는다.");

// ── 배선 점검: 위 단언들이 **빈 문자열을 훑고 통과**하지 않았나 ───────────────
ok(VIEWS.length > 5000 && MAIN.length > 20000 && TABS.length > 5000, "세 소스를 실제로 읽었다",
  "  → 파일 경로가 어긋나 빈 문자열을 검사하면 정규식이 전부 거짓이 되어 오히려 시끄럽게 실패한다. 이 줄은 그 반대 —\n"
  + "     혹시라도 통과처럼 보이는 경로가 생기면 여기서 먼저 걸린다.");

console.log(`\n${pass} checks passed`);

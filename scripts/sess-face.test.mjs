// #2022 — "껐다 오랜만에 들어가면 세션 이름이 `세션 10979a` 로 뜨고 프로젝트 연결 정보가 안 뜬다".
//  사양·엣지 표(E1~E20)는 스크래치패드 spec.md — 아래 이름의 번호가 그 행이다(행 하나도 안 빠지게).
//
//  원인은 하나였다: 화면이 세션 이름을 아는 길이 **세션 목록 응답 하나**뿐이라(main.ts findSess),
//  ① 목록이 오기 전(부팅 첫 그림 — drawSide 가 loadData 앞에 선다)과 ② 목록에서 빠진 세션(회수·정리된 박스,
//  오프라인 노드, 기록 LIMIT 200 밖)에서 이름이 통째로 id 꼬리로, 소속이 '프로젝트 없음' 으로 떨어졌다.
//  정작 그 값은 DB(desired-state)에 그대로 있었다 — 실측 2026-08-26: 단건 조회
//  `GET /api/ui/terminal/sessions/box-yoon-f0f4b17a` → 200 `{"label":"타이틀 바 드래그","projectId":2024}` 인데
//  같은 세션이 목록엔 없었고, 내 세션 인스턴스 65건 중 26건이 어느 목록에도 없는 id 를 가리켰다.
//
//  ⚠ 왜 소스 텍스트까지 보나: 폴백 **규칙**이 맞아도 그걸 **안 부르면** 화면은 그대로다. 그리고 규칙이 맞아도
//   탭이 그 위에 id 꼬리를 덮어 저장하면(종전 tabs.ts paint) 다음 부팅에 같은 그림이 되살아난다 —
//   값만 보는 테스트로는 영영 안 잡힌다. 그래서 '어디서 무엇을 부르는가'를 함께 못 박는다.
//   (같은 규율: scripts/pane-session-scope.test.mjs · scripts/session-open-restore.test.mjs)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

const { pickSessFace } = await import(join(root, "public/app/v2/sess-face.js"));

const MAIN = read("web/v2/main.ts");
const TABS = read("web/v2/tabs.ts");
const INST = read("web/v2/app-instance.ts");
const CAP = read("src/capabilities/app-instances.ts");

/** 함수 하나만 잘라 본다 — 고정 길이로 자르면 그 함수가 자랐을 때 단언이 구간 밖으로 밀린다. */
function slice(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `구간 시작을 못 찾았다: ${from}`);
  const b = src.indexOf(to, a + 1);
  assert.ok(b > a, `구간 끝을 못 찾았다: ${to}`);
  return src.slice(a, b);
}

const ID = "box-yoon-10979afe";

// ══ 규칙 — 값으로 본다(순수 모듈이라 그대로 검증된다) ═════════════════════════════
{
  const r = pickSessFace(ID, { subject_label: "타이틀 바 드래그", subject_project_id: 2024 });
  ok(r.title === "타이틀 바 드래그" && r.projectId === 2024,
    "E1 서버가 실어 준 정본이 이름·소속이 된다 — DB 가 아는 것을 화면이 안 쓰던 게 이 버그였다");
}

ok(pickSessFace(ID, { subject_label: null, subject_project_id: 2024 }).projectId === 2024
  && pickSessFace(ID, { subject_label: null, subject_project_id: 2024 }).title === "",
  "E2 이름이 없어도 소속은 온다 — 이 값이 비면 화면이 'AI 세션 · 프로젝트 없음' 을 붙인다");

{
  const r = pickSessFace(ID, null, { n: "세션 메타 로딩" });
  ok(r.title === "세션 메타 로딩" && r.projectId === 0,
    "E3 인스턴스가 아직 없어도(부팅 첫 그림) 지난 판의 이름 기억이 그 자리를 받는다 — 소속은 지어내지 않는다");
}

ok(pickSessFace(ID, { subject_label: "정본", title: "옛 이름" }, { n: "기억" }).title === "정본"
  && pickSessFace(ID, { title: "옛 이름" }, { n: "기억" }).title === "기억",
  "E4 정본 > 기억 > 저장된 title — 저장된 title 은 인스턴스를 연 순간의 스냅샷이라 늙는다");

ok(pickSessFace(ID, { title: ID }).title === "",
  "E5 저장된 title 이 세션 id 그대로면 이름으로 치지 않는다(실측 'box-yoon-96519b67')");

ok(pickSessFace(ID, { subject_label: ID }, { n: ID }).title === "",
  "E6 id 배제는 정본·기억에도 똑같이 적용된다(한 곳만 막으면 다른 통로로 새어 들어온다)");

{
  const r = pickSessFace(ID);
  ok(r.title === "" && r.projectId === 0,
    "E7 아무것도 모르면 빈 값 — '모른다'를 지어내지 않는다(무엇으로 채울지는 호출부가 정한다)");
}

ok(pickSessFace(ID, { subject_project_id: 0, project_id: 1867 }).projectId === 1867
  && pickSessFace(ID, { subject_project_id: 2024, project_id: 1867 }).projectId === 2024,
  "E8 소속 0 은 '모름'이라 다음 후보로 내려간다(경계값) — 정본이 있으면 그것이 이긴다");

ok(pickSessFace("  " + ID + "  ", { title: ID }).title === "",
  "E9 id 비교 전에 공백을 턴다 — 안 그러면 같은 id 가 다른 이름으로 통과한다");

{
  const r = pickSessFace(ID, {}, {});
  ok(r.title === "" && r.projectId === 0,
    "E20 빈 객체와 부재(undefined)가 같은 답을 낸다 — 둘이 갈리면 '아는 척'하는 판이 생긴다");
}

// ══ 배선 — 규칙이 맞아도 안 부르면 화면은 그대로다 ══════════════════════════════
const LOAD = () => slice(MAIN, "async function loadData(", "\nconst findSess");
const TITLE_FOR = () => slice(MAIN, "function titleFor(route: string)", "\nfunction applyTabChrome(");
ok(/sessFallback\(/.test(TITLE_FOR()) && TITLE_FOR().indexOf("sessFallback(") < TITLE_FOR().indexOf("'세션 ' + tail"),
  "E10 탭·좌측 행 이름은 id 꼬리로 떨어지기 **전에** 폴백을 본다");

ok(/provisional: true/.test(TITLE_FOR()),
  "E11 id 꼬리 이름은 '아직 모른다'로 표시된다 — 저장본을 덮지 않고 소속을 단정하지 않게 하는 열쇠다");

const PROJ_FOR = () => slice(MAIN, "function projectIdForRoute(route: string)", "\n/** 소속 프로젝트");
ok(/sessFallback\(id\)\.projectId/.test(PROJ_FOR()) && /if \(s\) return s\.projectId \? Number\(s\.projectId\) : 0;/.test(PROJ_FOR()),
  "E12 소속도 폴백을 본다. 단 목록에 **있는** 세션의 0(프로젝트 없음)은 사실이라 폴백이 덮지 않는다");

const ROW_FACE = () => slice(MAIN, "function sideRowFace(route: string", "\n//  행 키 → 그 행을 여는 route");
ok(/info\.unresolved \? 'AI 세션' : 'AI 세션 · 프로젝트 없음'/.test(ROW_FACE()),
  "E13 모르는 것을 '프로젝트 없음' 이라 단정하지 않는다 — 모르는 것과 없는 것은 다르다");

const PAINT = () => slice(TABS, "function paint(): void {", "\n  function openTabMenu(");
ok(/if \(!info\.provisional \|\| !t\.title\) t\.title = info\.title;/.test(PAINT()),
  "E14 탭은 '아직 모르는 이름'으로 저장본을 덮지 않는다 — 종전엔 무조건 덮고 save() 해서 멀쩡한 이름이 id 꼬리로 굳었다");

ok(/if \(!info\.provisional \|\| !tab\.title\) tab\.title = info\.title;/.test(TABS.slice(TABS.indexOf("routed: (tab)"))),
  "E15 주소 이동(routed)에도 같은 규칙 — 한쪽만 막으면 다른 경로로 덮인다");

const ENSURE = () => slice(INST, "export function ensureSessionAppInstance(", "\n/** 설치된 앱을 새 실행 인스턴스로");
ok(!/'AI 세션'/.test(ENSURE()) && /\.\.\.\(opts\?\.title \? \{ title: opts\.title \} : \{\}\)/.test(ENSURE()),
  "E16 이름을 모르면 서버에 안 보낸다 — 서버가 conflict 시 title 을 COALESCE 로 덮으므로 자리표시자가 정본을 굳혀 버린다");

// ══ 서버 — 정본을 실어 보내는 쪽 ═════════════════════════════════════════════
const SUBJ = () => slice(CAP, "async function sessionSubjects(", "\nconst listInput = {");
ok(/getSessionStates\(ids\)/.test(SUBJ()) && !/for \(const r of sessionRows\) \{[\s\S]{0,240}getSessionState\(/.test(SUBJ()),
  "E17 desired-state 는 한 번의 일괄 조회로 읽는다(행마다 왕복하면 목록 하나가 세션 수만큼 쿼리를 낸다)");

ok(/label !== id \? label : null/.test(SUBJ()),
  "E18 서버도 id 를 이름으로 실어 보내지 않는다(화면이 '아는 이름'으로 오해한다)");

ok(/subject_state/.test(SUBJ()) && /"gone"/.test(SUBJ()),
  "E19 되살릴 수도 없는 세션(gone)을 화면이 구분할 수 있게 상태를 함께 준다");

ok(!/listSessions\(/.test(SUBJ()),
  "E21 이 목록은 tmux 를 훑지 않는다 — 같은 폴링이 이미 세션 목록에서 한 번 훑는다(두 번째 스캔 금지)");

ok(/st\.owner === owner \|\| !!st\.project_id/.test(SUBJ()),
  "E22 노출 범위는 세션 목록과 같다 — 내 세션이거나 프로젝트 세션일 때만 이름을 싣는다");

// ══ #2028(이미 main) 과의 통합 — 기억을 두 벌 두지 않는다 ═══════════════════════
const FALLBACK = () => slice(MAIN, "function sessFallback(id: string)", "\n// ── 라우터");
ok(/recallSessName\(id\)/.test(FALLBACK()) && /appInstances\.find/.test(FALLBACK()),
  "E23 폴백은 #2028 의 이름 기억(recallSessName)을 재료로 쓴다 — 같은 일을 하는 기억을 두 벌 두지 않는다");

const REPAIR = () => slice(MAIN, "async function repairUnknownSessNames(", "\n// ── 라우터");
ok(/pickSessFace\(ref, inst\)\.title/.test(REPAIR()),
  "E24 되찾기도 같은 규칙을 거친다 — 늙은 title·박스 id 를 그대로 이름으로 삼지 않는다");

// ══ #2022 E2E 가 잡은 것 — 정본이 첫 그림에 **도착해 있어야** 폴백이 산다 ═══════════
//  값·배선이 전부 통과하는데 화면만 틀렸던 자리다(2026-08-26 dev 실측): 세션 목록을 막고 첫 그림을
//  그리자 서버가 이름을 아는 세션인데도 좌측 행이 `세션 c368bd` 로 떨어졌다. 원인은 loadData 의
//  Promise.all 이 여섯 축을 한 덩어리로 묶은 것 — 폴백의 재료(앱 인스턴스)가 느린 축을 함께 기다렸다.
ok(/const instsP = listAppInstances\(\)/.test(LOAD()) && /void instsP\.then/.test(LOAD()),
  "E25 앱 인스턴스는 먼저 도착하는 대로 얹는다 — 폴백의 재료가 느린 축을 기다리면 정작 첫 그림에 없다");

ok(/if \(data\.sessions\.length\) return;/.test(LOAD()),
  "E26 그 조기 반영이 다시 그리는 건 아직 아무 세션도 못 그린 판뿐이다(매 폴링마다 덧그리지 않게)");

console.log(`sess-face: ${pass} passed`);

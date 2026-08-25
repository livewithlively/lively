// v2/shell-surfaces.ts — 셸의 **최상위 화면 대장**(#1780).
//
// 왜 이 파일이 있나 — 앱 계층(#1780)을 세워 두고도 화면은 계속 앱 **밖에서** 늘어났다. 새 화면 하나를
//  라우터 if-else 에 한 줄 더하면 끝이라, 앱 매니페스트·AppInstance·권한·창 규칙을 **아무도 안 거치고** 생긴다.
//  그렇게 생긴 화면은 탭·인스턴스 정체성이 없어서 프로젝트 귀속도, 권한 축소도, 재시작·복원도 못 받는다.
//
// 그래서 규칙을 파일 하나로 못박는다: **최상위 화면은 여기 등록되지 않으면 존재할 수 없다.**
//  · 라우터의 `page === '<x>'` 분기와 이 대장은 1:1 이어야 한다(가드: scripts/shell-surface-registry.test.mjs).
//  · 새 화면을 만들면 가드가 빨간불이 되고, 그때 셋 중 하나를 **명시적으로** 골라야 한다 —
//    앱(app)인가, OS 표면(os)인가, 아직 앱이 아니지만 앱화 대상(todo)인가.
//  · 맥락 없는 세션이 와도 이 선택을 건너뛸 수 없다. 그게 이 대장의 목적이다.
//
// ⚠ `todo` 는 **줄어들기만 한다**. 가드가 개수를 지켜본다 — 늘리려면 그 규칙을 먼저 고쳐야 하고,
//  그건 곧 "앱 계층을 안 쓰기로 한다"는 결정이라 사람 눈에 걸린다.
/**
 * 라우트 첫 segment → 그 화면의 정체. 빈 문자열('')은 홈이다.
 *
 * 설계 근거(지식 `os-app-layer-design-v2-1-consolidated-1780` §6): OS 가 소유하는 것은
 *  글로벌 좌측 사이드바 · 상단 탭 줄 · 탭 생애주기 · 사용자 인증 · 권한 중개 · AppInstance route 다.
 *  그 밖에 **client area 를 채우는 화면은 앱**이다. 아래 분류는 그 선을 그대로 따른다.
 */
export const SHELL_SURFACES = {
    // ── OS 표면 — 앱이 아니어야 하는 이유가 분명한 것 ──
    "": { kind: "os", why: "홈은 앱을 여는 런처 자체다. 앱을 여는 곳이 앱이면 순환이다(무엇으로 홈을 여나)." },
    dashboard: { kind: "os", why: "홈의 옛 주소 — 같은 화면으로 접힌다(routeKey 가 'home' 으로 정규화)." },
    welcome: { kind: "os", why: "처음 설정(#1813) — 앱을 열 자격 자체를 만드는 화면이라 앱보다 앞선다. 인증·온보딩은 OS 몫." },
    i: { kind: "os", why: "AppInstance 를 싣는 OS 라우트다. 이 라우트가 앱을 열지, 이것이 앱인 것은 아니다." },
    p: { kind: "os", why: "프로젝트 주소는 그 방의 맨 위 세션으로 보내는 문일 뿐 자체 화면이 없다(원준 2026-08-20 — '주소는 늘 세션')." },
    // ── 이미 앱인 것 ──
    s: { kind: "app", appId: "ai-session", note: "세션 딥링크. v2.2 §7 대로 #/s/<id> 를 정본으로 유지하고, AppInstance 는 subject 로 멱등 확보한다." },
    // ── 앱화 대상 — 줄어들기만 한다 ──
    app: { kind: "todo", plan: "클래식 화면 iframe(#/app/<key>). APPS 표의 항목을 하나씩 builtin AppPackage(system.renderer)로 옮기고, 표가 비면 이 라우트도 없앤다." },
    inbox: { kind: "app", appId: "inbox", note: "받은 알림 이력 + 지금 답을 기다리는 세션(#1891). project=global·single-instance 빌트인. 딥링크 #/inbox 를 정본으로 유지한다(세션의 #/s/ 와 같은 규칙)." },
    liv: { kind: "todo", plan: "리브 — 대화하는 화면이라 가장 앱다운 축에 든다. session subject 를 갖는 builtin 후보." },
    archive: { kind: "todo", plan: "아카이브 — 콘텐츠 목록. trash 와 한 앱(보관함)으로 묶을지 둘로 둘지 이식 때 정한다." },
    trash: { kind: "todo", plan: "휴지통 — 위와 같음. ⚠ 클래식 표에도 'trash' 가 있어 라우터에서 이 분기가 먼저 서야 한다(WIKI 옛 휴지통과 다르다)." },
    connect: { kind: "todo", plan: "외부 앱 연결 — 조직 자격·권한 중개라 OS 로 남길 여지가 있다. 이식 때 판정하고, OS 로 정하면 why 를 적어 os 로 옮긴다." },
};
/**
 * 아직 앱이 아닌 클래식 화면(`#/app/<key>`) — `web/v2/apps.ts` 의 `APPS` 표와 같은 집합이어야 한다.
 *
 * 이 표는 **'아직 안 옮긴 것' 목록**이라 늘어나면 안 된다. 새 화면이 필요하면 여기 한 줄을 더하는 게 아니라
 *  앱(builtin AppPackage)으로 만든다 — 가드가 개수를 지켜본다.
 */
export const CLASSIC_BACKLOG = [
    "dashboard", "terminal", "projects2", "knowledge", "context", "sessions", "system", "web", "learn",
];
/** 이 화면이 사이드바에서 어떤 키로 활성 표시되나 — 없으면 활성 표시를 하지 않는다. */
export function activeNavKey(page, id) {
    if (page === "" || page === "dashboard")
        return "home";
    if (page === "p" || page === "s")
        return page + ":" + (id ?? "");
    const s = SHELL_SURFACES[page];
    if (!s)
        return "";
    // OS 표면·앱화 대상 중 사이드바 도크에 자리가 있는 것만 활성 표시를 갖는다.
    return ["inbox", "connect", "archive", "trash", "liv"].includes(page) ? page : "";
}

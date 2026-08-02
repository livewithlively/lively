// v2 UI 가 부르는 4개 경로가 **실제로 서빙되는지** 확인한다.
//  코드에 라우트가 등록돼 있는 것과 그 프로세스가 그 경로에 응답하는 것은 다른 일이다
//  (v1 에서 배선 단언이 없어 401 로도 "차단됨"이 통과한 적이 있다).
const BASE = "http://127.0.0.1:8099";
const SEED = JSON.parse(process.env.SEED || "{}");
const TOK = SEED.tokens || {};
let pass = 0, fail = 0;
const chk = (n, c, why) => c ? (pass++, console.log(`ok   ${n}`)) : (fail++, console.log(`FAIL ${n} — ${why ?? ""}`));

async function hit(who, path, init = {}) {
  const r = await fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${TOK[who]}`, "content-type": "application/json", ...(init.headers || {}) } });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}

// 배선 — 토큰이 살아있지 않으면 아래 전부가 공허하게 통과한다
const me = await hit("in", "/api/ui/me");
chk("[배선] 토큰 유효", me.status === 200 && !!me.body?.userId, `status=${me.status}`);

// ① 배지 모드 — path 없이 부르면 잠긴 폴더 목록만 준다(폴더 브라우저가 🔒 를 그리는 용도)
const aclBadge = await hit("in", "/api/ui/terminal/browse/acl?root=shared&path=");
chk("★ 배지 모드가 서빙된다", aclBadge.status === 200 && Array.isArray(aclBadge.body?.acls), `status=${aclBadge.status} ${JSON.stringify(aclBadge.body)?.slice(0,80)}`);

// ② 모달 모드 — 실제 경로를 주면 폼이 읽는 계약(visibility·members·settable)이 와야 한다
const aclGet = await hit("in", "/api/ui/terminal/browse/acl?root=shared&path=" + encodeURIComponent("some-team-folder"));
chk("★ 모달 모드가 폼 계약을 채워 준다", aclGet.status === 200 && "visibility" in (aclGet.body || {}) && "settable" in (aclGet.body || {}),
  `status=${aclGet.status} ${JSON.stringify(aclGet.body)?.slice(0, 120)}`);

// ③ 프로젝트 폴더는 프로젝트 공개범위를 따르므로 여기서 못 고친다 — UI 는 이 플래그로 폼을 잠근다
const aclProj = await hit("in", "/api/ui/terminal/browse/acl?root=shared&path=" + encodeURIComponent("project/" + SEED.lockedProjectId));
chk("★ 프로젝트 폴더는 settable=false", aclProj.status === 200 && aclProj.body?.settable === false,
  `status=${aclProj.status} ${JSON.stringify(aclProj.body)?.slice(0, 120)}`);

// ② 같은 경로의 POST(설정 저장) — 잘못된 대상은 서버가 거절해야 한다(UI 는 실수만 줄인다)
const aclBad = await hit("in", "/api/ui/terminal/browse/acl", { method: "POST", body: JSON.stringify({ root: "shared", path: "", visibility: "members", members: ["nobody_such_member"] }) });
chk("★ 없는 멤버를 대상으로 주면 서버가 거절", aclBad.status >= 400, `status=${aclBad.status}`);

// ③ 스페이스/리스트 팀 지정
const teams = await hit("in", "/api/ui/teams");
chk("★ 팀 목록이 서빙된다", teams.status === 200 && Array.isArray(teams.body?.teams), `status=${teams.status}`);
const setTeams = await hit("in", `/api/ui/v6/project-lists/${SEED.lockedListId}/teams`, { method: "POST", body: JSON.stringify({ teams: [] }) });
chk("★ 리스트 팀 지정이 서빙된다", setTeams.status !== 404, `status=${setTeams.status}`);

// ④ 긴급열람 이력(관리 화면) — 비-admin 에겐 닫혀 있어야 한다
const bgOut = await hit("out", "/api/ui/vis/break-glass");
chk("★ 긴급열람 이력은 비-admin 에게 닫힘", bgOut.status === 403 || bgOut.status === 401, `status=${bgOut.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

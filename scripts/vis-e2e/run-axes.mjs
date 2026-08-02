// #1291 축 토글 e2e — 유형별 켜기/끄기가 **실제로 강제를 걷는가**.
//  이 기능의 전부가 "끄면 종전처럼 전원 공개, 켜면 다시 잠긴다"라서, 그 왕복을 실제 응답으로 확인한다.
//  ⚠ 토글은 조직 단위 상태를 바꾸므로 항상 **원상복구**하고 끝낸다(뒤 테스트가 오염되지 않게).
const BASE = process.env.BASE || "http://127.0.0.1:8099";
const SEED = JSON.parse(process.env.SEED || "{}");
const TOK = SEED.tokens || {};
let pass = 0, fail = 0;
const chk = (n, c, why) => c ? (pass++, console.log(`ok   ${n}`)) : (fail++, console.log(`FAIL ${n} — ${why ?? ""}`));

async function rest(who, path, init = {}) {
  const r = await fetch(`${BASE}${path}`, { ...init,
    headers: { authorization: `Bearer ${TOK[who]}`, "content-type": "application/json", ...(init.headers || {}) } });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}
const setAxis = (axis, on, confirm) =>
  rest("admin", "/api/ui/vis/axes", { method: "POST", body: JSON.stringify({ axis, on, confirm }) });
const sees = async (who, id) =>
  (await rest(who, `/api/ui/v6/projects/${id}`)).status === 200;

(async () => {
  const { lockedProjectId, lockedListId } = SEED;

  // 배선 — 토글 API 가 살아있고 축 5개를 돌려주나
  const list0 = await rest("admin", "/api/ui/vis/axes");
  chk("[배선] 축 목록 조회", list0.status === 200 && (list0.body?.axes || []).length === 5,
    `status=${list0.status} n=${(list0.body?.axes || []).length}`);
  const proj0 = (list0.body?.axes || []).find((a) => a.axis === "project");
  chk("[배선] 프로젝트 축이 켜져 있고 잠긴 항목을 센다", proj0?.on === true && proj0?.locked >= 1,
    JSON.stringify(proj0));

  // 기준선 — 비대상은 못 본다
  chk("기준선: 축 켜짐 → 비대상은 잠긴 프로젝트를 못 본다", !(await sees("out", lockedProjectId)));

  // ★ 확인 없이 끄면 거절 — 무엇이 공개되는지 알려주고 멈춰야 한다
  const noConfirm = await setAxis("project", false, false);
  chk("★ 잠긴 항목이 있는 축은 confirm 없이 못 끈다", noConfirm.status === 400,
    `status=${noConfirm.status}`);
  chk("  거절 응답이 무엇이 공개되는지 알려준다",
    JSON.stringify(noConfirm.body ?? "").includes("공개") && JSON.stringify(noConfirm.body ?? "").includes("locked"),
    JSON.stringify(noConfirm.body)?.slice(0, 200));
  chk("  거절됐으면 실제로 안 꺼져 있다(비대상 여전히 차단)", !(await sees("out", lockedProjectId)));

  // ★ confirm 하면 꺼지고, 강제가 걷힌다
  const off = await setAxis("project", false, true);
  chk("★ confirm 하면 꺼진다", off.status === 200 && off.body?.on === false, `status=${off.status}`);
  chk("★ 끄면 비대상도 잠긴 프로젝트를 본다(종전 동작 복귀)", await sees("out", lockedProjectId));
  const lists = await rest("out", "/api/ui/v6/project-lists");
  chk("★ 잠긴 리스트도 비대상 목록에 나온다",
    (lists.body?.lists || []).some((l) => l.id === lockedListId),
    JSON.stringify((lists.body?.lists || []).map((l) => l.id)));

  // ★ 다시 켜면 원래대로 — 설정이 살아있다(끄기가 데이터를 지우지 않는다)
  const on = await setAxis("project", true);
  chk("★ 다시 켜는 데는 confirm 이 필요 없다", on.status === 200 && on.body?.on === true, `status=${on.status}`);
  chk("★ 켜면 잠금이 그대로 돌아온다(설정 보존)", !(await sees("out", lockedProjectId)));

  // 다른 축은 독립적인가 — 지식 축을 꺼도 프로젝트 잠금은 유지돼야 한다
  const kOff = await setAxis("knowledge", false, true);
  chk("[독립성] 지식 축은 따로 끌 수 있다", kOff.status === 200, `status=${kOff.status}`);
  chk("★ 지식 축을 꺼도 프로젝트 잠금은 그대로", !(await sees("out", lockedProjectId)));
  await setAxis("knowledge", true);

  // 권한 — 비-admin 은 못 바꾼다
  const notAdmin = await rest("out", "/api/ui/vis/axes", {
    method: "POST", body: JSON.stringify({ axis: "project", on: false, confirm: true }) });
  chk("★ 비-admin 은 축을 못 끈다", notAdmin.status === 403 || notAdmin.status === 401, `status=${notAdmin.status}`);

  // 원상복구 확인 — 뒤 테스트가 오염되지 않게
  const final = await rest("admin", "/api/ui/vis/axes");
  chk("[정리] 모든 축이 켜진 상태로 복구됐다",
    (final.body?.axes || []).every((a) => a.on === true),
    JSON.stringify((final.body?.axes || []).map((a) => `${a.axis}=${a.on}`)));

  // ─────────────────────────────────────────────────────────────
  // ★ 끄기가 **작업기록에 실제로 남는가** — 설계엔 "남는다"고 적어 놓고 안 남았다.
  //    type:'config' 가 activity_type_chk 허용값이 아니라 INSERT 가 깨졌는데 .catch 가 삼켰다.
  //    "기록한다"는 코드를 넣은 것과 그 기록이 실제로 생기는 것은 다른 일이다.
  // ─────────────────────────────────────────────────────────────
  const beforeLog = await rest("admin", "/api/ui/activity/list?limit=30");
  //  이 엔드포인트는 배열을 그대로 돌려준다(감싸는 키가 없다) — 그걸 몰라 keys=0,1,2… 로 드러났다.
  const rowsOf = (b) => (Array.isArray(b) ? b : (b?.activities || b?.entries || b?.items || b?.rows || []));
  //  ⚠ 배선 — 목록 자체가 안 오면 아래 "늘었나"가 0 vs 0 으로 공허하게 통과한다(실제로 404 로 그랬다).
  chk("[배선] 작업기록 목록이 실제로 온다", beforeLog.status === 200 && Array.isArray(rowsOf(beforeLog.body)),
    `status=${beforeLog.status} keys=${Object.keys(beforeLog.body || {})}`);
  //  ⚠ 개수 증가로 판정하면 안 된다 — 반복 실행으로 최근 N건이 이미 '공개범위 사용' 으로 포화되면
  //   새 기록이 생겨도 창 안의 개수는 그대로다(실제로 before=28 after=28 로 거짓 실패했다).
  //   이번 실행만의 사유를 심고 **그게 실려 있는지**로 본다.
  const mark = "e2e-axes-" + Date.now();
  await rest("admin", "/api/ui/vis/axes", { method: "POST",
    body: JSON.stringify({ axis: "project", on: false, confirm: true, reason: mark }) });
  const afterLog = await rest("admin", "/api/ui/activity/list?limit=30");
  const hits = rowsOf(afterLog.body).filter((a) => String(a.title || "").includes("공개범위 사용"));
  const mine = hits.filter((a) => String(a.summary || "").includes(mark));
  chk("★ 축을 끄면 작업기록이 실제로 남는다", mine.length === 1,
    `mark=${mark} matched=${mine.length} status=${afterLog.status}`);
  chk("  그 기록이 무엇이 공개됐는지 말해 준다", String(hits[0]?.title || "").includes("전원 공개"),
    JSON.stringify(hits[0]?.title));
  await setAxis("project", true);

  // ─────────────────────────────────────────────────────────────
  // 화면이 축 상태를 알 수 있나 — 이걸 못 받으면 프론트가 꺼진 축의 설정 UI·자물쇠를 계속 그린다.
  //  (실제로 그랬다: 리스트 공개범위를 껐는데 사이드바 자물쇠가 그대로 남아 "일부공개"라고 거짓말했다.)
  // ─────────────────────────────────────────────────────────────
  const me1 = await rest("in", "/api/ui/me");
  chk("★ /api/ui/me 가 축 상태를 실어 준다(프론트가 UI 를 끄는 근거)",
    me1.body?.vis_axes && me1.body.vis_axes.project === true,
    JSON.stringify(me1.body?.vis_axes));

  await setAxis("project", false, true);
  const me2 = await rest("in", "/api/ui/me");
  chk("★ 축을 끄면 me 가 그 사실을 알려준다", me2.body?.vis_axes?.project === false,
    JSON.stringify(me2.body?.vis_axes));
  chk("  다른 축은 그대로 켜져 있다", me2.body?.vis_axes?.knowledge === true,
    JSON.stringify(me2.body?.vis_axes));
  await setAxis("project", true);
  const me3 = await rest("in", "/api/ui/me");
  chk("[정리] 다시 켜면 me 도 원복", me3.body?.vis_axes?.project === true, JSON.stringify(me3.body?.vis_axes));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("e2e 예외:", e?.stack || e); process.exit(1); });

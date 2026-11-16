// #5524 셀프호스트 기본 워크스페이스(primary) 이름 — PG 통합 시험. **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=postgres://… node src/org/tenancy/primary-workspace-name.pg-test.mjs
//
// 신고(상민님 2026-11-11): «셀프호스팅에서 워크스페이스 이름이 왜 안 바뀌냐 — 저장 눌러도 그대로임».
//  원인: 화면이 그리는 이름(등록부 gw_workspace 의 primary 행)과 저장이 쓰는 칸(org_profile)이 달랐다.
//   · 등록부 primary 행 이름은 **활성화 순간 한 번** org_profile.name 을 베껴 심고 그 뒤로 아무도 고치지 않았다
//     (설치 직후 활성화가 먼저 돌면 org_profile 이 비어 있어 «우리 워크스페이스» 로 굳는다 — 테스트 박스 실측).
//   · 설정 모달의 primary 저장은 org_profile 만 바꾼다 → 저장했어요 → 새로 고침 → 레일·목록은 등록부를 읽어 그대로.
//  고침: org_profile 의 보이는 이름(display_name 먼저, 없으면 name — 제품 전체의 규칙)이 바뀌면 primary 등록부 행이 따라간다.
//   이미 어긋난 박스는 부팅 스텝이 한 번 맞춘다.
//
//  사양 행:
//   N1 ★ registry · primary — 설정 모달이 보내는 값({name, display_name}) → me 의 레일 이름 · 목록의 primary 행 이름이 새 이름
//   N2 ★ registry · primary — 관리탭 [조직 정보] 가 보내는 값(display_name · gateway_url · timezone) → 등록부 이름 = 새 표시명
//   N3 registry · primary — 표시명을 비우면('') 보이는 이름은 name 이다 → 등록부 = name
//   N3b(경계) 표시명이 공백뿐이면 빈 것이다 → 등록부 = name
//   N4 registry · primary — 이름과 무관한 칸(timezone)만 → 등록부 이름 · updated_at 그대로(쓰지 않는다)
//   N5 registry · primary — 보이는 이름이 비면(name·display_name 모두 '') → 등록부를 비우지 않는다
//   N6 registry · 다른 워크스페이스 컨텍스트 → primary 등록부 행 그대로(남의 이름을 바꾸지 않는다)
//   N7 single(등록부 꺼짐) → 등록부 행을 건드리지 않고 저장은 성공
//   N8 ★ 부팅 스텝 — 이미 어긋난 박스(등록부 «우리 워크스페이스» · 표시명 있음)를 맞춘다 · 두 번째 실행은 아무것도 안 바꾼다
//   N9 부팅 스텝 — single 이면 아무것도 안 한다
//   N10 부팅 스텝은 등록부 활성화(workspace-registry) 뒤에 선다 — 앞에 서면 활성화 부팅에서 맞출 행이 아직 없다
//   N11(부재) registry 인데 등록부에 primary 행이 없다 → 저장은 성공 · 오류 없음 · 행을 새로 만들지 않는다(시드는 활성화의 몫)
for (const k of ["LIVELY_TENANT_HEADER_SECRET", "LIVELY_TENANT_BINDING", "LIVELY_TENANT_ID", "LIVELY_TENANCY_MODE"]) delete process.env[k];

const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { registry } = await import(`${DIST}/capabilities/index.js`);
const { PRIMARY_TENANT_ID } = await import(`${DIST}/org/tenancy/registry.js`);
const { withTenant } = await import(`${DIST}/org/tenant-context.js`);
const { DB_BOOT_STEPS } = await import(`${DIST}/boot/housekeeping.js`);

let pass = 0, fail = 0;
const chk = (n, got, want) => {
  if (got === want) { pass++; console.log(`ok  ${n}`); }
  else { fail++; console.error(`FAIL ${n}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
};

const ADMIN = { userId: "__pg5524_admin__", email: "pg5524@example.invalid", scopes: ["memory", "admin"], projects: ["*"], tokenSource: "db" };
const cap = (n) => { const c = registry.get(n); if (!c) throw new Error(`registry 에 ${n} 가 없다`); return c; };
const SAVE = cap("org_update_profile"), ME = cap("me"), LIST = cap("workspace_registry_status");
const SEC = { id: "55245524-2222-3333-4444-555555555555", slug: "pg5524-sec" };
const STEP = DB_BOOT_STEPS.find((s) => s.name === "primary-workspace-name");

const REGISTRY = () => { process.env.LIVELY_TENANCY_MODE = "registry"; };
const SINGLE = () => { delete process.env.LIVELY_TENANCY_MODE; };
//  updated_at 은 글자(마이크로초)로 읽는다 — Date 를 String() 하면 초 단위라 같은 초 안의 두 번째 쓰기가 안 보인다(돌연변이로 실측).
const row = async () => (await itemsPool.query(`SELECT name, updated_at::text AS updated_at FROM gw_workspace WHERE id=$1`, [PRIMARY_TENANT_ID])).rows[0];
const regName = async () => (await row())?.name;
const setRegName = (name) => itemsPool.query(`UPDATE gw_workspace SET name=$2 WHERE id=$1`, [PRIMARY_TENANT_ID, name]);
const setProfile = (name, display) => itemsPool.query(`UPDATE org_profile SET name=$1, display_name=$2 WHERE id=1`, [name, display]);
const meName = async () => (await ME.handler({}, ADMIN, {})).workspace_registry?.name;
const listName = async () => (await LIST.handler({}, ADMIN, {})).workspaces?.find((w) => w.is_primary)?.name;
const runStep = async () => { if (!STEP) throw new Error("부팅 스텝 primary-workspace-name 이 없다"); await STEP.run({}); };
const safe = async (n, fn) => { try { await fn(); } catch (e) { fail++; console.error(`FAIL ${n} — 던졌다: ${e?.message || e}`); } };

// ── 준비: 이 시험이 바꾸는 두 행을 기억해 두고 끝에 되돌린다(CI 는 한 DB 를 여러 시험이 나눠 쓴다) ──
await itemsPool.query(`INSERT INTO org_profile(id) VALUES(1) ON CONFLICT DO NOTHING`);
const before = (await itemsPool.query(`SELECT name, display_name, gateway_url, timezone FROM org_profile WHERE id=1`)).rows[0];
const hadPrimary = !!(await row());
const primaryBefore = hadPrimary ? await regName() : null;
if (!hadPrimary) {
  await itemsPool.query(`INSERT INTO gw_workspace(id, slug, name, kind, owner_member) VALUES($1, 'primary', '우리 워크스페이스', 'team', $2)`,
    [PRIMARY_TENANT_ID, ADMIN.userId]);
}

try {
  // 테스트 박스(selfhost-test, 2026-11-11)와 같은 출발점 — 활성화가 먼저 돌아 등록부는 «우리 워크스페이스», 프로필은 그 뒤에 채워졌다.
  await setRegName("우리 워크스페이스");
  await setProfile("셀프호스트 테스트", "셀프호스트 테스트");

  await safe("N1", async () => {
    REGISTRY();
    await SAVE.handler({ name: "고위드 정책 위키", display_name: "고위드 정책 위키" }, ADMIN, {});
    chk("N1 레일 이름(me.workspace_registry.name)", await meName(), "고위드 정책 위키");
    chk("N1 목록의 primary 행 이름", await listName(), "고위드 정책 위키");
  });

  await safe("N2", async () => {
    REGISTRY();
    await SAVE.handler({ display_name: "관리탭 표시명", gateway_url: "https://pg5524.example.invalid", timezone: "Asia/Seoul" }, ADMIN, {});
    chk("N2 등록부 이름 = 새 표시명", await regName(), "관리탭 표시명");
  });

  await safe("N3", async () => {
    REGISTRY();
    await SAVE.handler({ name: "이름 칸", display_name: "" }, ADMIN, {});
    chk("N3 표시명이 비면 name", await regName(), "이름 칸");
  });

  await safe("N3b", async () => {
    REGISTRY();
    //  공백뿐인 표시명은 API 가 미리 잘라 저장하지 않는다 — 그래서 DB 에 직접 둔다(옛 판·직접 SQL 로 들어온 값).
    //   그 상태에서 이름만 저장해도 보이는 이름은 name 이어야 한다.
    await setProfile("이전 이름", "   ");
    await SAVE.handler({ name: "공백 경계" }, ADMIN, {});
    chk("N3b 표시명이 공백뿐이면 name", await regName(), "공백 경계");
  });

  await safe("N4", async () => {
    REGISTRY();
    const r0 = await row();
    await SAVE.handler({ timezone: "UTC" }, ADMIN, {});
    const r1 = await row();
    chk("N4 이름 그대로", r1.name, r0.name);
    chk("N4 updated_at 그대로(쓰지 않았다)", r1.updated_at, r0.updated_at);
  });

  await safe("N5", async () => {
    REGISTRY();
    await setRegName("지키는 이름");
    await SAVE.handler({ name: "", display_name: "" }, ADMIN, {});
    chk("N5 빈 이름으로 비우지 않는다", await regName(), "지키는 이름");
  });

  await safe("N6", async () => {
    REGISTRY();
    await setRegName("primary 이름");
    await withTenant(SEC, () => SAVE.handler({ name: "남의 워크스페이스", display_name: "남의 워크스페이스" }, ADMIN, {}));
    chk("N6 다른 워크스페이스에서 저장해도 primary 행 그대로", await regName(), "primary 이름");
  });

  await safe("N7", async () => {
    SINGLE();
    await setRegName("단일 모드 이름");
    const r = await SAVE.handler({ name: "단일 저장", display_name: "단일 저장" }, ADMIN, {});
    chk("N7 저장은 성공", r?.profile?.display_name, "단일 저장");
    chk("N7 등록부 행 그대로", await regName(), "단일 모드 이름");
  });

  await safe("N8", async () => {
    REGISTRY();
    await setRegName("우리 워크스페이스");
    await setProfile("셀프호스트 테스트", "셀프호스트 테스트");
    await runStep();
    chk("N8 부팅 스텝이 맞춘다", await regName(), "셀프호스트 테스트");
    const r0 = await row();
    await runStep();
    chk("N8 두 번째 실행은 쓰지 않는다(updated_at 그대로)", (await row()).updated_at, r0.updated_at);
  });

  await safe("N9", async () => {
    SINGLE();
    await setRegName("우리 워크스페이스");
    await runStep();
    chk("N9 single 이면 부팅 스텝이 아무것도 안 한다", await regName(), "우리 워크스페이스");
  });

  await safe("N10", async () => {
    const at = DB_BOOT_STEPS.findIndex((s) => s.name === "primary-workspace-name");
    const reg = DB_BOOT_STEPS.findIndex((s) => s.name === "workspace-registry");
    chk("N10 스텝이 있다", at >= 0, true);
    chk("N10 등록부 활성화 뒤에 선다", at > reg && reg >= 0, true);
  });

  await safe("N11", async () => {
    REGISTRY();
    //  행 전체를 그대로 되살린다(owner_member · created_at · face · state 까지) — 다른 시험이 같은 DB 를 쓴다.
    const full = (await itemsPool.query(`SELECT row_to_json(w) AS j FROM gw_workspace w WHERE id=$1`, [PRIMARY_TENANT_ID])).rows[0].j;
    await itemsPool.query(`DELETE FROM gw_workspace WHERE id=$1`, [PRIMARY_TENANT_ID]);
    try {
      const r = await SAVE.handler({ name: "행 없음", display_name: "행 없음" }, ADMIN, {});
      chk("N11 저장은 성공", r?.profile?.display_name, "행 없음");
      chk("N11 행을 새로 만들지 않는다", await row(), undefined);
    } finally {
      await itemsPool.query(`INSERT INTO gw_workspace SELECT * FROM json_populate_record(NULL::gw_workspace, $1::json)`, [JSON.stringify(full)]);
    }
  });
} finally {
  SINGLE();
  await itemsPool.query(`UPDATE org_profile SET name=$1, display_name=$2, gateway_url=$3, timezone=$4 WHERE id=1`,
    [before.name, before.display_name, before.gateway_url, before.timezone]);
  if (hadPrimary) await setRegName(primaryBefore);
  else await itemsPool.query(`DELETE FROM gw_workspace WHERE id=$1`, [PRIMARY_TENANT_ID]);
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);

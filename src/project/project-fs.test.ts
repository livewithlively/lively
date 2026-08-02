// project-fs backfillMarkerSync — 구 마커에 sync:"pull" stamp(#905 P1-②). DB/WS 없이 순수 fs 검증.
//  실행: npm run build && node dist/project/project-fs.test.js
//
//  왜 이게 중요한가: pull 훅의 sync 게이트는 sync 없는 구 마커를 '폴더 소유권'으로 폴백 판정하는데, 그 폴백은
//   ~/lively/projects/<id>(꼴 고정) 만 인정한다. 박스 폴더는 folder 가 임의 문자열이라(라이브 실측: 286개 마커 중
//   'project/관리탭 수정'·'project/오케이-3'·'legacy-project/프로젝트 탭 만들기' 등 12개가 이름 기반) 구조로 소유를
//   알 수 없다 → 이 백필이 stamp 하지 못하면 그 폴더들의 자동 pull 이 조용히 멈춘다.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { backfillMarkerSync, grantSharedGroupWrite, backfillGroupWriteArgv, backfillSharedGroupWrite } from "./project-fs.js";

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

const readMarker = (base: string, sub: string, name: string): any =>
  JSON.parse(fs.readFileSync(path.join(base, sub, name, ".lively", "project.json"), "utf8"));

async function mkMarker(base: string, sub: string, name: string, meta: unknown, raw?: string): Promise<void> {
  const dir = path.join(base, sub, name, ".lively");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "project.json"), raw ?? JSON.stringify(meta, null, 2) + "\n");
}

async function main(): Promise<void> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-pfs-"));
  try {
    // 라이브에서 실제로 관측된 폴더 꼴들을 그대로 재현한다.
    await mkMarker(base, "project", "905", { project_id: 905, repos: ["context-ontology"] });        // 관례(id)
    await mkMarker(base, "project", "관리탭 수정", { project_id: 149, repos: [] });                    // 이름 기반(실측)
    await mkMarker(base, "project", "오케이-3", { project_id: 152, last_pull: 123 });                  // 이름+충돌접미사(실측)
    await mkMarker(base, "legacy-project", "프로젝트 탭 만들기", { project_id: 40 });                   // 보관+이름(실측)
    await mkMarker(base, "project", "already-none", { project_id: 7, sync: "none" });                 // 사람이 꺼둔 것
    await mkMarker(base, "project", "already-both", { project_id: 8, sync: "both" });                 // C3 양방향
    await mkMarker(base, "project", "broken", null, "{not json");                                     // 파손 마커
    await mkMarker(base, "project", "no-id", { repos: [] });                                          // project_id 없음
    await fsp.mkdir(path.join(base, "project", "no-marker"), { recursive: true });                    // 마커 없는 폴더
    await fsp.writeFile(path.join(base, "project", "stray.txt"), "x");                                // 파일(디렉터리 아님)

    const r = await backfillMarkerSync(base);
    assert.equal(r.stamped, 4, `stamp 대상은 sync 없는 정상 마커 4개여야 함 — 실제 ${JSON.stringify(r)}`);
    ok(`백필 stamp ${r.stamped}건 / scan ${r.scanned}건`);

    // ── 핵심: 이름 기반 박스 폴더(구조로 소유를 못 알아보는 것)가 stamp 돼야 pull 이 안 끊긴다 ──
    for (const [sub, name, pid] of [["project", "905", 905], ["project", "관리탭 수정", 149],
      ["project", "오케이-3", 152], ["legacy-project", "프로젝트 탭 만들기", 40]] as const) {
      const m = readMarker(base, sub, name);
      assert.equal(m.sync, "pull", `${sub}/${name} 에 sync:"pull" 이 stamp 돼야 함(아니면 이 폴더의 자동 pull 이 멈춘다)`);
      assert.equal(m.project_id, pid, `${sub}/${name} 의 project_id 가 보존돼야 함`);
    }
    ok("이름 기반·충돌접미사·legacy 폴더 전부 stamp(구조 폴백이 못 잡는 실측 꼴)");

    // ── 기존 키 보존 ──
    assert.deepEqual(readMarker(base, "project", "905").repos, ["context-ontology"], "repos 보존");
    assert.equal(readMarker(base, "project", "오케이-3").last_pull, 123, "last_pull 보존");
    ok("stamp 시 기존 키(repos·last_pull) 보존 — 다른 writer 의 키를 안 지운다");

    // ── 명시 sync 는 절대 안 건드린다(사람이 끈 걸 되살리지 않는다) ──
    assert.equal(readMarker(base, "project", "already-none").sync, "none", "사람이 none 으로 끈 것을 pull 로 되살리면 안 됨");
    assert.equal(readMarker(base, "project", "already-both").sync, "both", "both 를 pull 로 낮추면 안 됨");
    ok("명시 sync(none·both) 보존 — 백필이 사람의 선택을 덮지 않는다");

    // ── 파손·비대상은 손대지 않는다 ──
    assert.equal(fs.readFileSync(path.join(base, "project", "broken", ".lively", "project.json"), "utf8"), "{not json",
      "파손 마커는 그대로 둔다(추측해서 고치지 않는다)");
    assert.equal(readMarker(base, "project", "no-id").sync, undefined, "project_id 없는 마커는 대상 아님");
    ok("파손 마커·project_id 없는 마커는 무변경");

    // ── 멱등: 두 번째 실행은 0건 ──
    const r2 = await backfillMarkerSync(base);
    assert.equal(r2.stamped, 0, `두 번째 실행은 stamp 0 이어야 함(매 기동 도는 코드) — 실제 ${JSON.stringify(r2)}`);
    ok("멱등 — 재실행 stamp 0(부팅마다 돌아도 무변경·감사 노이즈 없음)");

    // ── 없는 base 는 조용히 0 (신규 설치·폴더 미생성) ──
    const empty = await backfillMarkerSync(path.join(base, "does-not-exist"));
    assert.deepEqual(empty, { scanned: 0, stamped: 0 }, "폴더가 없으면 조용히 0 — 부팅을 막지 않는다");
    ok("base 부재 → {0,0} (신규 설치에서 부팅 비차단)");

    // ══ #1246 공유폴더 하위 그룹권한 — 사양·엣지 표: scratchpad spec.md (G1~G7 · B1~B7 · S1) ══
    //  왜: 격리 박스에서 웹 '새 폴더'/업로드는 게이트웨이 소유 755/644 로 생겨, lively-shared 그룹으로만
    //  접근하는 box_ 세션(프로젝트 세션의 클로드)이 그 안에 파일을 못 쓴다 — 신고 증상 그대로.
    const mode = (p: string): number => fs.statSync(p).mode & 0o7777;

    // ── grantSharedGroupWrite ──
    // G1+G2: 3단 신규 폴더 전부 2770, stopBase(프로젝트 폴더 루트)는 직전에 멈춰 무변경.
    const proj = path.join(base, "project", "1246-perm");
    await fsp.mkdir(path.join(proj, "a", "b", "c"), { recursive: true });
    await fsp.chmod(proj, 0o700);   // 루트 무변경을 증명할 표식(2770 아닌 값)
    await grantSharedGroupWrite(path.join(proj, "a", "b", "c"), proj, "dir");
    for (const rel of ["a", "a/b", "a/b/c"]) {
      assert.equal(mode(path.join(proj, rel)), 0o2770, `G1: ${rel} 는 2770(그룹 rwx+setgid)이어야 — 중간 폴더가 빠지면 그 단에서 세션 쓰기가 막힌다`);
    }
    assert.equal(mode(proj), 0o700, "G2: stopBase(루트 자체)는 건드리지 않는다(별도 관할)");
    ok("G1·G2 — 중첩 새 폴더 전 단 2770 · 루트 직전 정지");

    // G3: 파일 660 + 그 부모 2770 (폴더 업로드가 만든 중간 폴더).
    await fsp.mkdir(path.join(proj, "x"), { recursive: true });
    await fsp.writeFile(path.join(proj, "x", "f.txt"), "u");
    await fsp.chmod(path.join(proj, "x", "f.txt"), 0o644);
    await grantSharedGroupWrite(path.join(proj, "x", "f.txt"), proj, "file");
    assert.equal(mode(path.join(proj, "x", "f.txt")), 0o660, "G3: 업로드 파일은 660(그룹 rw) — 아니면 세션이 그 파일을 못 고친다");
    assert.equal(mode(path.join(proj, "x")), 0o2770, "G3: 파일의 중간 폴더도 2770");
    ok("G3 — 파일 660 + 부모 폴더 2770");

    // G4·G5: stopBase 밖·루트 자신은 무변경·무예외(봉쇄를 chmod 가 한 번 더 지킨다).
    const stray = path.join(base, "project", "stray.txt");
    const strayBefore = mode(stray);
    await grantSharedGroupWrite(stray, proj, "file");
    assert.equal(mode(stray), strayBefore, "G4: stopBase 밖 경로는 chmod 하지 않는다");
    await grantSharedGroupWrite(proj, proj, "dir");
    assert.equal(mode(proj), 0o700, "G5: 루트 자신은 no-op");
    // G6: 부재 경로 — 예외가 API 응답을 죽이면 안 된다(무예외로 통과 자체가 단언).
    await grantSharedGroupWrite(path.join(proj, "none", "f"), proj, "file");
    // G7: 깊이 1 경계 — 부모가 곧 루트인 파일: 파일만 660, 루트 무변경.
    await fsp.writeFile(path.join(proj, "top.md"), "t");
    await fsp.chmod(path.join(proj, "top.md"), 0o644);
    await grantSharedGroupWrite(path.join(proj, "top.md"), proj, "file");
    assert.equal(mode(path.join(proj, "top.md")), 0o660, "G7: 루트 직속 파일도 660");
    assert.equal(mode(proj), 0o700, "G7: 그 때도 루트는 무변경");
    ok("G4~G7 — 밖/루트/부재 no-op · 루트 직속 파일 경계");

    // ── 소급 보정 find — argv 를 **실제 실행**해 부작용(모드)으로 검증(B1~B5·B7). ──
    const fx = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-pfs-fix-"));
    const rootA = path.join(fx, "project"), rootB = path.join(fx, "legacy-project");
    await fsp.mkdir(path.join(rootA, "d755"), { recursive: true });
    await fsp.chmod(path.join(rootA, "d755"), 0o755);                    // B1: 보장 미달 dir
    await fsp.mkdir(path.join(rootA, "d2770"), { recursive: true });
    await fsp.chmod(path.join(rootA, "d2770"), 0o2770);                  // B2: 이미 보장
    const wf = async (p: string, m: number): Promise<void> => { await fsp.writeFile(p, "x"); await fsp.chmod(p, m); };
    await wf(path.join(rootA, "f644.txt"), 0o644);                       // B3
    await wf(path.join(rootA, "f660.txt"), 0o660);                       // B4
    await wf(path.join(rootA, "f444.txt"), 0o444);                       // B5: 특이 모드 — 추가만
    await fsp.mkdir(rootB, { recursive: true });
    await wf(path.join(rootB, "g644.txt"), 0o644);                       // B7: 두 번째 루트
    const argv = backfillGroupWriteArgv([rootA, rootB], os.userInfo().username);
    const run = spawnSync(argv[0], argv.slice(1), { stdio: "pipe" });
    assert.equal(run.status, 0, `find 실행이 성공해야 함 — stderr: ${run.stderr}`);
    assert.equal(mode(path.join(rootA, "d755")), 0o2775, "B1: 미달 dir 은 그룹 rwx+setgid 추가(기타 비트 불변 → 2775)");
    assert.equal(mode(path.join(rootA, "d2770")), 0o2770, "B2: 이미 보장된 dir 불변");
    assert.equal(mode(path.join(rootA, "f644.txt")), 0o664, "B3: 미달 파일은 그룹 rw 추가(→664)");
    assert.equal(mode(path.join(rootA, "f660.txt")), 0o660, "B4: 이미 보장된 파일 불변");
    assert.equal(mode(path.join(rootA, "f444.txt")), 0o464, "B5: 특이 모드도 그룹 rw '추가만'(다른 비트 불변)");
    assert.equal(mode(path.join(rootB, "g644.txt")), 0o664, "B7: 두 번째 루트도 보정");
    // B6(타 유저 소유 불변)은 비루트로 재현 불가 → 소유자 필터가 argv 에 실제로 배선됐는지로 검증.
    const ui = argv.indexOf("-user");
    assert.ok(ui > 0 && argv[ui + 1] === os.userInfo().username, "B6: -user <게이트웨이 유저> 필터 배선 — 없으면 멤버 소유 파일까지 만진다");
    await fsp.rm(fx, { recursive: true, force: true }).catch(() => { /* */ });
    ok("B1~B7 — find 실행 시맨틱: 미달만 g+ 추가·보장분/타소유 불변·복수 루트");

    // ── S1: 게이트 — 대상 루트 부재(또는 비격리 박스)면 스폰 없이 false. ──
    const noRoots = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-pfs-empty-"));
    assert.equal(backfillSharedGroupWrite(noRoots), false, "S1: project/·legacy-project/ 없으면 아무것도 하지 않는다(신규 설치·맥 개발 비차단)");
    await fsp.rm(noRoots, { recursive: true, force: true }).catch(() => { /* */ });
    ok("S1 — 소급 보정 게이트(루트 부재/비격리 → 무동작)");

    console.log(`\n${pass} passed`);
  } finally {
    await fsp.rm(base, { recursive: true, force: true }).catch(() => { /* */ });
  }
}

await main();

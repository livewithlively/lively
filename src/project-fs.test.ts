// project-fs backfillMarkerSync — 구 마커에 sync:"pull" stamp(#905 P1-②). DB/WS 없이 순수 fs 검증.
//  실행: npm run build && node dist/project-fs.test.js
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
import { backfillMarkerSync } from "./project-fs.js";

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

    console.log(`\n${pass} passed`);
  } finally {
    await fsp.rm(base, { recursive: true, force: true }).catch(() => { /* */ });
  }
}

await main();

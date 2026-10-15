// 세션 폴더 ⇄ 설치 스테이지(#4481) — 게이트웨이 로컬 길(멤버 경계와 **같은 한 줄** WALK_JS · READ_JS · WRITE_JS 를 게이트웨이 node 로 돌린다).
// 실행: npm run build && node dist/apps/app-bundle-source.test.js
//  S1~S6. 이게 틀리면: app_save {dir} 가 node_modules · .git · .env(비밀)를 판에 싣거나, 심링크로 폴더 밖 파일을 읽거나, 매니페스트 없는 폴더를
//   앱으로 저장하거나, 상한을 넘는 폴더를 다 읽은 뒤에야 막거나, app_pull {dir} 이 남의 파일을 덮는다.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "../http-error.js";
import { stageFromDir, writeFilesToDir } from "./app-bundle-source.js";
import { APP_BUNDLE_POLICY_DEFAULT } from "./app-bundle-policy.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };
const root = mkdtempSync(path.join(tmpdir(), "bundle-src-test-"));
const walk = (d: string, rel = ""): string[] => readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => {
  const r = rel ? `${rel}/${e.name}` : e.name;
  return e.isDirectory() ? walk(d, r) : [r];
}).sort();
const status = async (p: Promise<unknown>): Promise<number | string> => { try { await p; return 200; } catch (e) { return e instanceof HttpError ? e.status : String(e); } };

try {
  const app = path.join(root, "proj", "my-app");
  mkdirSync(path.join(app, "dist/assets"), { recursive: true });
  mkdirSync(path.join(app, "node_modules/react"), { recursive: true });
  mkdirSync(path.join(app, ".git"), { recursive: true });
  writeFileSync(path.join(app, "lively-app.json"), "{}");
  writeFileSync(path.join(app, "package.json"), "{\"name\":\"x\"}");
  writeFileSync(path.join(app, "dist/index.html"), "<p>hi</p>");
  writeFileSync(path.join(app, "dist/assets/b.bin"), Buffer.from([0, 255, 1]));
  writeFileSync(path.join(app, "node_modules/react/index.js"), "x");
  writeFileSync(path.join(app, ".git/HEAD"), "ref");
  writeFileSync(path.join(app, ".env"), "SECRET=1");
  writeFileSync(path.join(root, "outside.txt"), "밖");
  symlinkSync(path.join(root, "outside.txt"), path.join(app, "dist/link.txt"));
  const acc = { base: app, osUser: null };
  {
    const st = await stageFromDir(acc, "my-app", APP_BUNDLE_POLICY_DEFAULT);
    try {
      assert.deepEqual(walk(st.dir), ["dist/assets/b.bin", "dist/index.html", "lively-app.json", "package.json"]);
      assert.deepEqual([...readFileSync(path.join(st.dir, "dist/assets/b.bin"))], [0, 255, 1], "바이트 그대로");
      assert.equal(st.meta.files, 4);
    } finally { await st.cleanup(); }
    assert.equal(existsSync(st.dir), false, "cleanup 이 스테이지를 지운다");
    ok("S1 폴더 → 스테이지 — node_modules · .git · .env · 심링크는 빼고 · 바이트 그대로 · 정리");
  }
  {
    const nomf = path.join(root, "proj", "no-manifest");
    mkdirSync(nomf, { recursive: true });
    writeFileSync(path.join(nomf, "index.html"), "x");
    assert.equal(await status(stageFromDir({ base: nomf, osUser: null }, "no-manifest", APP_BUNDLE_POLICY_DEFAULT)), 400);
    ok("S2 맨 위에 lively-app.json 이 없으면 400");
  }
  {
    assert.equal(await status(stageFromDir(acc, "my-app", { ...APP_BUNDLE_POLICY_DEFAULT, files_max: 3 })), 413, "파일 수");
    assert.equal(await status(stageFromDir(acc, "my-app", { ...APP_BUNDLE_POLICY_DEFAULT, files_max: 4 })), 200, "정확히 상한 개수는 된다");
    ok("S3 파일 수 상한 — 걷는 자리에서 413(경계: = 허용)");
  }
  {
    assert.equal(await status(stageFromDir({ base: path.join(root, "nope"), osUser: null }, "nope", APP_BUNDLE_POLICY_DEFAULT)), 404);
    assert.equal(await status(stageFromDir({ base: path.join(app, "package.json"), osUser: null }, "package.json", APP_BUNDLE_POLICY_DEFAULT)), 404, "파일을 폴더로 주면");
    ok("S4 없는 폴더 · 폴더 아닌 것 404");
  }
  {
    const dest = path.join(root, "proj", "copy");
    const items = [
      { p: "lively-app.json", s: 2, read: async () => Buffer.from("{}") },
      { p: "dist/assets/b.bin", s: 3, read: async () => Buffer.from([0, 255, 1]) },
    ];
    assert.equal(await writeFilesToDir({ base: dest, osUser: null }, "copy", items), 2);
    assert.deepEqual(walk(dest), ["dist/assets/b.bin", "lively-app.json"]);
    assert.deepEqual([...readFileSync(path.join(dest, "dist/assets/b.bin"))], [0, 255, 1]);
    assert.equal(await status(writeFilesToDir({ base: dest, osUser: null }, "copy", items)), 409, "비어 있지 않은 폴더엔 안 쓴다");
    assert.equal(readFileSync(path.join(dest, "lively-app.json"), "utf8"), "{}", "있던 파일은 그대로");
    ok("S5 판 → 새 폴더 · 비어 있지 않은 폴더 409(덮지 않음)");
  }
  {
    const dest = path.join(root, "proj", "esc");
    assert.equal(await status(writeFilesToDir({ base: dest, osUser: null }, "esc", [{ p: "../evil.txt", s: 1, read: async () => Buffer.from("x") }])), 409);
    assert.equal(existsSync(path.join(root, "proj", "evil.txt")), false, "폴더 밖에 아무것도 안 생긴다");
    ok("S6 폴더 밖을 가리키는 경로는 쓰지 않는다");
  }
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(`\n${pass} passed`);

// 세션 폴더 ⇄ 설치 스테이지(#4481) — 게이트웨이 로컬 길(멤버 경계와 **같은 한 줄** WALK_JS · READ_JS · WRITE_JS 를 게이트웨이 node 로 돌린다).
// 실행: npm run build && node dist/apps/app-bundle-source.test.js
//  S1~S11. 이게 틀리면: app_save {dir} 가 node_modules · .git · .env(비밀)를 판에 싣거나, 심링크로 폴더 밖 파일을 읽거나, 매니페스트 없는 폴더를
//   앱으로 저장하거나, 상한을 넘는 폴더를 다 읽은 뒤에야 막거나, app_pull {dir} 이 남의 파일을 덮거나, 비밀 열쇠 파일을 판에 싣거나,
//   심링크 하위 폴더 너머(폴더 밖)를 읽고 쓴다(격리 리뷰 B4).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "../http-error.js";
import { READ_JS, runDirJs, stageFromDir, takeSkipped, writeFilesToDir } from "./app-bundle-source.js";
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
  {
    //  비밀 열쇠 꼴 파일은 숨김이 아니어도 뺀다 — 이름만 meta.skipped 로 알린다(내용은 안 읽는다).
    const k = path.join(root, "proj", "keys");
    mkdirSync(path.join(k, "certs"), { recursive: true });
    writeFileSync(path.join(k, "lively-app.json"), "{}");
    writeFileSync(path.join(k, "certs/server.pem"), "-----BEGIN PRIVATE KEY-----");
    writeFileSync(path.join(k, "id_ed25519"), "key");
    writeFileSync(path.join(k, "store.P12"), "p12");
    writeFileSync(path.join(k, "keynote.txt"), "글");            // «key» 가 이름에 들어도 열쇠 확장자가 아니면 담는다
    const st = await stageFromDir({ base: k, osUser: null }, "keys", APP_BUNDLE_POLICY_DEFAULT);
    try {
      assert.deepEqual(walk(st.dir), ["keynote.txt", "lively-app.json"]);
      assert.deepEqual([...(st.meta as { skipped?: string[] }).skipped ?? []].sort(), ["certs/server.pem", "id_ed25519", "store.P12"]);
    } finally { await st.cleanup(); }
    ok("S7 비밀 열쇠 꼴(*.pem · id_ed25519 · *.p12 — 대소문자 무시)은 빼고 이름만 알린다 · 비슷한 이름의 글 파일은 담는다");
  }
  {
    //  중간 폴더가 폴더 밖을 가리키는 심링크면 읽지 않는다(걷기와 읽기 사이에 폴더를 바꿔치기한 경우 · 자가호스팅 로컬 길은 게이트웨이 권한).
    const outside = path.join(root, "outside-dir");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "secret.txt"), "밖의 비밀");
    const a = path.join(root, "proj", "swap");
    mkdirSync(a, { recursive: true });
    writeFileSync(path.join(a, "lively-app.json"), "{}");
    symlinkSync(outside, path.join(a, "sub"));
    const r = await runDirJs<{ files: Array<[string, string]>; err: string | null }>({ base: a, osUser: null }, READ_JS, { base: a, paths: ["lively-app.json", "sub/secret.txt"] });
    assert.equal(r.err, "outside:sub/secret.txt");
    assert.deepEqual(r.files.map(([p]) => p), ["lively-app.json"], "폴더 안 파일은 읽었다(관측 장치 확인) · 밖은 0");
    assert.equal(r.files.some(([, b]) => Buffer.from(b, "base64").toString().includes("밖의 비밀")), false);
    ok("S8 심링크 중간 폴더 너머(폴더 밖)는 읽지 않는다");
  }
  {
    //  풀 자리에 미리 심어 둔 심링크 하위 폴더 — 걷기는 심링크를 안 세어 «빈 폴더» 로 보지만, 쓰기가 폴더 밖으로 나가면 안 된다.
    const outside = path.join(root, "outside-w");
    mkdirSync(outside, { recursive: true });
    const dest = path.join(root, "proj", "planted");
    mkdirSync(dest, { recursive: true });
    symlinkSync(outside, path.join(dest, "dist"));
    const items = [
      { p: "lively-app.json", s: 2, read: async () => Buffer.from("{}") },
      { p: "dist/assets/evil.js", s: 1, read: async () => Buffer.from("x") },
    ];
    assert.equal(await status(writeFilesToDir({ base: dest, osUser: null }, "planted", items)), 409);
    assert.deepEqual(readdirSync(outside), [], "폴더 밖에 아무것도 안 생긴다");
    assert.equal(existsSync(path.join(dest, "lively-app.json")), true, "폴더 안 파일은 썼다(관측 장치 확인)");
    ok("S9 심링크 하위 폴더로 폴더 밖에 쓰지 않는다");
  }
  {
    //  한글 이름이 많은 폴더 — 걷기 결과(글)가 여러 조각으로 오면 조각 경계에 걸린 글자가 깨져 «없는 파일» 409 가 났다(격리 리뷰 재검토 4).
    const h = path.join(root, "proj", "hangul");
    mkdirSync(path.join(h, "dist/이미지"), { recursive: true });
    writeFileSync(path.join(h, "lively-app.json"), "{}");
    const names: string[] = [];
    for (let i = 0; i < 2500; i++) {
      const n = `dist/이미지/한글파일이름이아주긴그림-${String(i).padStart(4, "0")}.txt`;
      names.push(n);
      writeFileSync(path.join(h, n), "x");
    }
    const st = await stageFromDir({ base: h, osUser: null }, "hangul", APP_BUNDLE_POLICY_DEFAULT);
    try {
      const got = walk(st.dir);
      assert.equal(got.length, names.length + 1, "다 읽었다");
      assert.deepEqual(got.filter((x) => x !== "lively-app.json"), [...names].sort(), "이름이 한 글자도 안 깨졌다");
    } finally { await st.cleanup(); }
    ok("S10 한글 이름 2,500개 — 걷기 · 읽기 결과가 조각 경계에서 깨지지 않는다");
  }
  {
    //  뺀 열쇠 꼴 이름은 저장 응답에만 — 스테이지 meta(앱 행 source 로 남는다)에서 걷어 낸다.
    const meta = { kind: "inline", files: 2, from: "dir", skipped: ["certs/server.pem", "id_ed25519"] };
    assert.deepEqual(takeSkipped(meta), ["certs/server.pem", "id_ed25519"]);
    assert.equal("skipped" in meta, false, "meta 에 남지 않는다");
    assert.deepEqual(meta, { kind: "inline", files: 2, from: "dir" }, "다른 칸은 그대로");
    assert.deepEqual(takeSkipped({ kind: "inline" }), [], "없으면 빈 목록");
    ok("S11 뺀 열쇠 꼴 이름은 meta 에서 걷어 응답으로만");
  }
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(`\n${pass} passed`);

#!/usr/bin/env node
// 진단 전용(#4927, 병합 안 함) — 새 Windows 러너 이미지(OS 26100.33650)에서 tar.exe 가 키트 번들 압축(-czf)에서
//  0xC0000005 로 죽는 원인을 가른다: ① 내용(cursor-adapter.mjs) 탓인가 OS tar 탓인가 ② 압축 해제(-xzf — 구성원 자동 업데이트
//  경로)도 깨지는가. 결과를 한 줄 JSON 으로 찍고 늘 exit 0(잡을 깨지 않는다). Windows 가 아니면 건너뛴다.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform !== "win32") { console.log("skip — Windows 전용 진단"); process.exit(0); }
const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOX = mkdtempSync(join(tmpdir(), "wintar-diag-"));
const out = {};
const run = (args) => { const r = spawnSync("tar", args, { encoding: "utf8" }); return { status: r.status, signal: r.signal, err: String(r.stderr || "").slice(0, 200), oserr: r.error ? String(r.error.code || r.error.message) : null }; };

const where = spawnSync("where", ["tar"], { encoding: "utf8" });
out.where = String(where.stdout || "").trim().split(/\r?\n/);
out.version = String(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout || "").trim().split(/\r?\n/)[0];

const { buildKitBundle } = await import(pathToFileURL(join(KIT, "generator", "build-context.mjs")));
const stage = (name) => { const d = join(BOX, name); mkdirSync(d, { recursive: true }); return d; };
const A = stage("A-full"); buildKitBundle(A, { orgName: "테스트조직", orgLabel: "test", harness: "claude" });
const B = stage("B-no-cursor"); cpSync(A, B, { recursive: true }); rmSync(join(B, ".claude", "hooks", "cursor-adapter.mjs"), { force: true });
const C = stage("C-only-cursor"); mkdirSync(join(C, ".claude", "hooks"), { recursive: true }); cpSync(join(A, ".claude", "hooks", "cursor-adapter.mjs"), join(C, ".claude", "hooks", "cursor-adapter.mjs"));
const D = stage("D-tiny"); writeFileSync(join(D, "a.txt"), "hello\n");
out.cursorAdapterInA = existsSync(join(A, ".claude", "hooks", "cursor-adapter.mjs"));

for (const [k, dir] of [["A", A], ["A2", A], ["B", B], ["C", C], ["D", D]]) out[`czf_${k}`] = run(["-czf", join(BOX, `${k}.tgz`), "-C", dir, "."]);
out.cf_A = run(["-cf", join(BOX, "A.tar"), "-C", A, "."]);

// 압축 해제 — tar 없이 만든 tgz(우리가 쓴 ustar + zlib)를 tar -xzf 로 푼다(구성원 자동 업데이트와 같은 명령).
function ustar(root) {
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } };
  walk(root);
  const blocks = [];
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  for (const f of files) {
    const name = "./" + relative(root, f).split(sep).join("/");
    const data = readFileSync(f);
    const h = Buffer.alloc(512);
    let pre = "", nm = name;
    if (Buffer.byteLength(nm) > 99) { const i = nm.lastIndexOf("/", 154); pre = nm.slice(0, i); nm = nm.slice(i + 1); }
    h.write(nm, 0); h.write(oct(0o644, 8), 100); h.write(oct(0, 8), 108); h.write(oct(0, 8), 116);
    h.write(oct(data.length, 12), 124); h.write(oct(Math.floor(statSync(f).mtimeMs / 1000), 12), 136);
    h.write("        ", 148); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263); h.write(pre, 345);
    let sum = 0; for (const b of h) sum += b; h.write(oct(sum, 7) + " ", 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
for (const [k, dir] of [["A", A], ["B", B], ["C", C]]) {
  const tgz = join(BOX, `js-${k}.tgz`); writeFileSync(tgz, ustar(dir));
  const dest = stage(`x-${k}`);
  out[`xzf_js_${k}`] = run(["-xzf", tgz, "-C", dest]);
  out[`xzf_js_${k}_files`] = (() => { let n = 0; const w = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? w(join(d, e.name)) : n++; }; try { w(dest); } catch { /* */ } return n; })();
}
console.log("WINTAR-DIAG " + JSON.stringify(out));
try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ }
process.exit(0);

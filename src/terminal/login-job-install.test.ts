// 로그인 자격을 멤버 홈에 두는 고정 스크립트(INSTALL_LOGIN_JS) — 실제 파일로 본다 (#4067 K34).
//  운영에선 멤버 파일 op(memberNodeJson)가 그 멤버 uid 로 `node -e` 를 돌린다. 여기서는 같은 스크립트를 같은 방식
//  (stdin JSON → stdout JSON)으로 임시 홈에서 돌리고 **파일·권한·링크**를 관찰한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INSTALL_LOGIN_JS } from "./login-job.js";

if (process.platform === "win32") {
  console.log("skip  POSIX 권한·링크 전용");
  process.exit(0);
}

let pass = 0;
//  만든 임시 폴더는 끝날 때 치운다.
const made: string[] = [];
process.on("exit", () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};
const mode = (p: string): number => fs.lstatSync(p).mode & 0o777;
const sha = (p: string): string => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
function run(home: string, files: Array<{ path: string; content: string }>, account: Record<string, unknown> | null = null):
  { status: number | null; out: Record<string, unknown> | null; err: string } {
  const r = spawnSync(process.execPath, ["-e", INSTALL_LOGIN_JS], {
    input: JSON.stringify({ home, files, account }), encoding: "utf8", timeout: 10_000,
  });
  let out: Record<string, unknown> | null = null;
  try { out = JSON.parse(r.stdout || "null"); } catch { out = null; }
  return { status: r.status, out, err: r.stderr };
}
const freshHome = (): string => {
  const base = tmp("lj-home-");
  const home = path.join(base, "box_sangmin");
  fs.mkdirSync(home, { mode: 0o700 });
  return home;
};
const CREDS = JSON.stringify({ claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1" } });

await t("★ K34 새 홈 — 자격 폴더 0700 · 파일 0600 · 내용 그대로 · 임시 파일이 남지 않는다", () => {
  const home = freshHome();
  const r = run(home, [{ path: ".claude/.credentials.json", content: CREDS }]);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.out, { ok: true, merged: false });
  const f = path.join(home, ".claude", ".credentials.json");
  assert.equal(fs.readFileSync(f, "utf8"), CREDS);
  assert.equal(mode(f), 0o600);
  assert.equal(mode(path.join(home, ".claude")), 0o700);
  assert.deepEqual(fs.readdirSync(path.join(home, ".claude")), [".credentials.json"], "임시 파일이 남지 않는다");
  assert.equal(fs.existsSync(path.join(home, ".claude.json")), false, "계정 정보가 없으면 .claude.json 을 만들지 않는다");
});

await t("★ K34 덮어쓰기 — 옛 자격(느슨한 권한)을 새 자격 0600 으로 바꾼다 · 폴더 안 다른 파일은 그대로", () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, ".codex"), { mode: 0o755 });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{\"old\":true}", { mode: 0o644 });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "model = \"x\"\n", { mode: 0o644 });
  const keep = sha(path.join(home, ".codex", "config.toml"));
  const r = run(home, [{ path: ".codex/auth.json", content: "{\"new\":true}" }]);
  assert.equal(r.status, 0, r.err);
  assert.equal(fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"), "{\"new\":true}");
  assert.equal(mode(path.join(home, ".codex", "auth.json")), 0o600);
  assert.equal(sha(path.join(home, ".codex", "config.toml")), keep);
  assert.equal(mode(path.join(home, ".codex")), 0o755, "사람이 둔 폴더 권한은 건드리지 않는다");
});

await t("★ K34 oauthAccount 병합 — 다른 키와 파일 권한은 그대로 · 계정 칸만 바뀐다", () => {
  const home = freshHome();
  const cj = path.join(home, ".claude.json");
  fs.writeFileSync(cj, JSON.stringify({ numStartups: 7, projects: { "/w": { hasTrustDialogAccepted: true } }, oauthAccount: { emailAddress: "old@x" } }), { mode: 0o640 });
  const account = { emailAddress: "new@example.com", organizationUuid: "org-9" };
  const r = run(home, [{ path: ".claude/.credentials.json", content: CREDS }], account);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.out, { ok: true, merged: true });
  const got = JSON.parse(fs.readFileSync(cj, "utf8"));
  assert.deepEqual(got, { numStartups: 7, projects: { "/w": { hasTrustDialogAccepted: true } }, oauthAccount: account });
  assert.equal(mode(cj), 0o640, "사람의 설정 파일 권한을 바꾸지 않는다");
  assert.deepEqual(fs.readdirSync(home).sort(), [".claude", ".claude.json"], "임시 파일이 남지 않는다");
});

await t("K34 .claude.json 이 없으면 계정 칸만 가진 0600 파일을 만든다", () => {
  const home = freshHome();
  const r = run(home, [{ path: ".claude/.credentials.json", content: CREDS }], { emailAddress: "a@b" });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.out, { ok: true, merged: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")), { oauthAccount: { emailAddress: "a@b" } });
  assert.equal(mode(path.join(home, ".claude.json")), 0o600);
});

await t("★ K34 .claude.json 이 링크·JSON 아님·배열이면 건드리지 않는다(자격은 둔다)", () => {
  for (const kind of ["link", "garbage", "array", "dir"] as const) {
    const home = freshHome();
    const cj = path.join(home, ".claude.json");
    const outside = path.join(path.dirname(home), "victim.json");
    fs.writeFileSync(outside, "{\"victim\":true}");
    if (kind === "link") fs.symlinkSync(outside, cj);
    if (kind === "garbage") fs.writeFileSync(cj, "{not json");
    if (kind === "array") fs.writeFileSync(cj, "[1,2]");
    if (kind === "dir") fs.mkdirSync(cj);
    const before = kind === "dir" ? "" : fs.readFileSync(cj, "utf8");
    const r = run(home, [{ path: ".claude/.credentials.json", content: CREDS }], { emailAddress: "x@y" });
    assert.equal(r.status, 0, `${kind}: ${r.err}`);
    assert.deepEqual(r.out, { ok: true, merged: false }, kind);
    assert.equal(fs.readFileSync(outside, "utf8"), "{\"victim\":true}", `${kind}: 링크 너머를 쓰지 않는다`);
    if (kind !== "dir") assert.equal(fs.readFileSync(cj, "utf8"), before, kind);
    if (kind === "link") assert.ok(fs.lstatSync(cj).isSymbolicLink(), "링크를 바꿔치기하지도 않는다");
    assert.equal(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8"), CREDS, `${kind}: 자격은 둔다`);
  }
});

await t("★ K34 자격 폴더·홈이 링크면 거절한다 — 같은 uid 의 다른 자리로 쓰기가 새지 않는다", () => {
  const home = freshHome();
  const elsewhere = path.join(path.dirname(home), "other-member-claude");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(home, ".claude"));
  const r = run(home, [{ path: ".claude/.credentials.json", content: CREDS }], { emailAddress: "x@y" });
  assert.notEqual(r.status, 0);
  assert.match(r.err, /링크 자리/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], "링크 너머에 아무것도 안 썼다");
  assert.equal(fs.existsSync(path.join(home, ".claude.json")), false, "앞에서 멈추면 계정 칸도 안 쓴다");

  const real = freshHome();
  const linkHome = path.join(path.dirname(real), "box_link");
  fs.symlinkSync(real, linkHome);
  const r2 = run(linkHome, [{ path: ".codex/auth.json", content: "{}" }]);
  assert.notEqual(r2.status, 0);
  assert.equal(fs.existsSync(path.join(real, ".codex")), false);

  const fileDir = freshHome();
  fs.writeFileSync(path.join(fileDir, ".grok"), "not a dir");
  const r3 = run(fileDir, [{ path: ".grok/auth.json", content: "{}" }]);
  assert.notEqual(r3.status, 0);
  assert.match(r3.err, /폴더가 아닙니다/);
});

await t("K34 자격 파일 자리 자체가 링크면 바꿔치기한다(링크 너머를 안 쓴다)", () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, ".grok"), { mode: 0o700 });
  const outside = path.join(path.dirname(home), "planted");
  fs.writeFileSync(outside, "keep");
  fs.symlinkSync(outside, path.join(home, ".grok", "auth.json"));
  const r = run(home, [{ path: ".grok/auth.json", content: "{\"k\":1}" }]);
  assert.equal(r.status, 0, r.err);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  assert.ok(!fs.lstatSync(path.join(home, ".grok", "auth.json")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(home, ".grok", "auth.json"), "utf8"), "{\"k\":1}");
});

await t("K34 홈 밖 자리는 거절한다(게이트웨이 검사를 지나도 스크립트가 한 번 더)", () => {
  const home = freshHome();
  const r = run(home, [{ path: "../escape.json", content: "{}" }]);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /홈 밖/);
  assert.equal(fs.existsSync(path.join(path.dirname(home), "escape.json")), false);
});

await t("★ K38 새 멤버 — 홈이 아직 없으면 0700 으로 만든다(세션보다 로그인이 먼저인 새 워크스페이스) · 부모가 없거나 링크면 안 만든다", () => {
  const homes = tmp("lj-homes-");
  const home = path.join(homes, "box_newbie");
  const r = run(home, [{ path: ".claude/.credentials.json", content: CREDS }], { emailAddress: "n@b" });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.out, { ok: true, merged: true });
  assert.equal(mode(home), 0o700, "브로커가 만드는 홈과 같은 모양");
  assert.equal(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8"), CREDS);
  assert.equal(mode(path.join(home, ".claude", ".credentials.json")), 0o600);

  const missingParent = path.join(homes, "no-such-dir", "box_x");
  const r2 = run(missingParent, [{ path: ".codex/auth.json", content: "{}" }]);
  assert.notEqual(r2.status, 0, "경로를 지어내지 않는다");
  assert.equal(fs.existsSync(path.join(homes, "no-such-dir")), false);

  const realParent = tmp("lj-real-");
  const linkParent = path.join(homes, "linked");
  fs.symlinkSync(realParent, linkParent);
  const r3 = run(path.join(linkParent, "box_y"), [{ path: ".codex/auth.json", content: "{}" }]);
  assert.notEqual(r3.status, 0);
  assert.match(r3.err, /링크 자리/);
  assert.deepEqual(fs.readdirSync(realParent), [], "링크 너머에 홈을 만들지 않는다");
});

console.log(`\n${pass} passed`);

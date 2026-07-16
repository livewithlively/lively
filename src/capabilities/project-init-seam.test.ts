// #905 C2a 서버 이음매 — REST parse 계약 + 라우트 순서. DB 없이 순수 검증.
//  실행: npm run build && node dist/capabilities/project-init-seam.test.js
//
//  왜 parse 를 따로 보나: **REST 경로는 capability 의 zod input 을 태우지 않는다** — `parse` 가 유일한 게이트다.
//   그래서 zod 에 z.enum 을 써 둬도 REST 로 잘못된 값이 들어오면 그대로 DB 까지 내려가 CHECK 에서 터진다
//   (라이브 실측: sync:"PULL-ALL" → **HTTP 500**, 400 이어야 정상). 그 계약을 여기서 고정한다.
import assert from "node:assert/strict";
import { projectV6Capabilities } from "./projects-v6.js";

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

const cap = (name: string) => {
  const c = projectV6Capabilities.find((x) => x.name === name);
  assert.ok(c, `capability '${name}' 이 등록돼야 함`);
  return c!;
};
const restOf = (name: string) => (cap(name).expose as any).rest[0];
const parse = (name: string, req: any) => restOf(name).parse(req);

// ── 라우트 순서 — 정적 경로가 :id 보다 **먼저** 등록돼야 한다(#631 과 같은 함정). ──
//  Express first-match 라 뒤에 있으면 POST /projects/:id(project_update_v6)가 'find-by-origin' 을 id 로 삼켜
//  이 엔드포인트는 영원히 400 이 된다(라이브에서 미배포 상태일 때 실제로 그 400 을 봤다).
{
  const posts: { name: string; p: string }[] = [];
  for (const c of projectV6Capabilities) {
    for (const r of ((c.expose as any)?.rest ?? [])) {
      if (r.method !== "POST") continue;
      for (const p of (r.paths ?? [])) posts.push({ name: c.name, p });
    }
  }
  const fbo = posts.findIndex((r) => r.p === "/api/ui/v6/projects/find-by-origin");
  const idPost = posts.findIndex((r) => r.p === "/api/ui/v6/projects/:id");
  assert.ok(fbo >= 0, "POST /projects/find-by-origin 이 등록돼야 함");
  assert.ok(idPost >= 0, "POST /projects/:id 가 있어야(비교 대상)");
  assert.ok(fbo < idPost, `find-by-origin(${fbo})이 :id(${idPost})보다 먼저 등록돼야 함 — 아니면 :id 가 삼켜 영구 400`);
  ok("라우트 순서 — POST /projects/find-by-origin 이 /projects/:id 보다 먼저(정적 경로가 :id 에 안 먹힘)");
}

// ── find-by-origin parse ──
{
  assert.deepEqual(parse("project_find_by_origin_v6", { body: { git_url: " git@github.com:o/r.git " } }), { git_url: "git@github.com:o/r.git" });
  assert.throws(() => parse("project_find_by_origin_v6", { body: {} }), /git_url/);
  assert.throws(() => parse("project_find_by_origin_v6", { body: { git_url: "  " } }), /git_url/);
  ok("find-by-origin parse — git_url 필수·trim");
}

// ── folder-binding parse — 🔴 잘못된 sync 는 **400 으로** 막는다(DB CHECK 500 이 아니라) ──
{
  const req = (body: any) => ({ params: { id: "905" }, body });
  const good = parse("project_bind_folder_v6", req({ node_id: "mbp", abs_path: "/Users/me/code", sync: "none", git_url: "https://x/y.git" }));
  assert.deepEqual(good, { id: 905, node_id: "mbp", abs_path: "/Users/me/code", sync: "none", git_url: "https://x/y.git" });

  for (const m of ["none", "pull", "both"]) {
    assert.equal(parse("project_bind_folder_v6", req({ node_id: "n", abs_path: "/p", sync: m })).sync, m);
  }
  assert.throws(() => parse("project_bind_folder_v6", req({ node_id: "n", abs_path: "/p", sync: "PULL-ALL" })), /sync 는 none\|pull\|both/,
    "🔴 잘못된 sync 는 parse 에서 400 — 안 막으면 DB CHECK 까지 내려가 500 이 난다(라이브 실측)");
  assert.throws(() => parse("project_bind_folder_v6", req({ node_id: "n", abs_path: "/p", sync: "PULL" })), /sync 는 none\|pull\|both/, "대문자도 거부(어휘는 정확히 3값)");
  assert.equal(parse("project_bind_folder_v6", req({ node_id: "n", abs_path: "/p" })).sync, undefined, "sync 생략 = 허용(핸들러가 none 으로)");
  assert.equal(parse("project_bind_folder_v6", req({ node_id: "n", abs_path: "/p", sync: "" })).sync, undefined, "빈 문자열도 미지정 취급");

  assert.throws(() => parse("project_bind_folder_v6", req({ abs_path: "/p" })), /node_id/);
  assert.throws(() => parse("project_bind_folder_v6", req({ node_id: "n" })), /abs_path/);
  ok("folder-binding parse — 🔴 sync 어휘 3값만(오타 400) · node_id·abs_path 필수 · 생략/빈값은 미지정");
}

// ── member_id 는 입력 계약에 없다 — 인증 주체로만 정해진다(남의 이름으로 바인딩 못 심게). ──
{
  const out: any = parse("project_bind_folder_v6", { params: { id: "1" }, body: { node_id: "n", abs_path: "/p", member_id: "someone-else" } });
  assert.equal(out.member_id, undefined, "member_id 를 body 로 받으면 안 된다(인증 주체가 권위)");
  assert.ok(!("member_id" in (cap("project_bind_folder_v6").input as any)), "input 스키마에도 member_id 가 없어야 함");
  ok("member_id 는 입력이 아님 — 인증 주체 권위(스푸핑 차단)");
}

console.log(`\n${pass} passed`);

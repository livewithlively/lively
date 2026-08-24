// ═══════════════════════════════════════════════════════════════════════════
// 프로젝트 자산화 코어 (#905 C2a/C5) — MCP 툴(lively-mcp-local.mjs)과 CLI(lively.mjs `init`)가 공유한다.
//  드리프트 0: 두 표면이 이 한 벌의 로직을 각자의 컨텍스트만 주입해 호출한다(repo-worktree-core 와 같은 모델).
//
//  주입 컨텍스트  ctx = {
//    cwd,                                            // 하네스/사람이 선 작업 디렉터리
//    sh(cmd, args, { allowFail }) → { stdout, code },// 로컬 셸(git)
//    api(path, { method, body })  → parsed JSON,     // 게이트웨이 REST(Bearer 자동)
//  }
//
//  이 코어가 지키는 것(깨지면 그대로 사고):
//   🔴 마커 sync:"none" — 사용자 폴더는 사용자 파일이 사는 곳이다. pull 훅이 서버 공유폴더를 여기 내려받으면
//      CLAUDE.md 가 무음으로 날아간다(#905 §2 — 재현된 사고). 이 값이 그걸 막는 유일한 것.
//   🔴 후보 0/다수 → create 안 함 — 마커는 동기화되지 않아 두 번째 멤버에겐 탐색이 원리적 100% 미스라,
//      create 폴백은 '중복 프로젝트 양산'이 기본 동작이 된다.
//   🔴 중앙 생성은 롤백이 없다(트랜잭션 0 + ClickUp 푸시 큐잉) → 마커 쓰기를 **사전점검**하고 실패하면
//      생성 전에 중단(고아 프로젝트 방지).
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, realpathSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { findProjectMarkerUp } from "./repo-worktree-core.mjs";
import { entrypointHostEffects } from "./host-effects.mjs";

const hostEffects = entrypointHostEffects();
const execFileSync = (...args) => hostEffects.execFileSync(...args);

// origin URL 에서 자격(userinfo)을 벗긴다 — 게이트웨이로 토큰을 보내지 않기 위한 방어.
//  ⚠ 정규화(신원 키 산출)는 여기서 하지 않는다 — 서버(project-origin.ts)가 유일 SoT 다.
//  두 구현이 갈리면 같은 레포가 다른 키가 되어 **중복 프로젝트**가 생기므로, 클라이언트는 URL 만 나른다.
function stripGitCredentials(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (!s.includes("://")) return s;             // scp 식(git@host:path) — 임베드 시크릿 없음
  try {
    const u = new URL(s);
    u.password = "";
    if (u.protocol !== "ssh:" && u.protocol !== "git+ssh:") u.username = ""; // ssh 로그인 유저(git@)는 시크릿 아님 → 보존
    return u.toString();
  } catch { return ""; }                        // 해석 불가 → 안 보낸다(fail-closed)
}

// 그 폴더의 git origin(없으면 "") — 워크트리·서브디렉터리에서도 레포 루트를 따라 올라가 찾는다.
function originUrlOf(ctx, dir) {
  const r = ctx.sh("git", ["-C", dir, "remote", "get-url", "origin"], { allowFail: true });
  return r.code === 0 ? stripGitCredentials(r.stdout.trim()) : "";
}

const HOSTNAME_SLUG = () => {
  try {
    return (execFileSync("hostname", [], { encoding: "utf8" }).split(".")[0] || "node")
      .trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "node";
  } catch { return "node"; }
};

// 이 폴더를 프로젝트로 — mode: auto(제안만·무변경) | create | bind.
export async function projectInit(ctx, args = {}) {
    const dir = realpathSync(resolve(ctx.cwd, args.path || "."));
    const mode = args.mode || "auto";

    // ── ① 마커 상향탐색 — 이미 프로젝트면 여기서 끝(중첩 불허). ──
    const found = findProjectMarkerUp(dir); // 마커 리더는 공용 코어 하나 — 40단계 계약을 리더끼리 갈리지 않게
    if (found) {
      return ({
        status: "already_project",
        project_id: found.meta.project_id,
        marker: found.file,
        same_folder: found.dir === dir,
        note: found.dir === dir
          ? `이 폴더는 이미 프로젝트 #${found.meta.project_id} 입니다 — 할 일 없음.`
          : `상위 폴더(${found.dir})가 이미 프로젝트 #${found.meta.project_id} 라 이 폴더도 그 프로젝트에 속합니다. 프로젝트 중첩은 허용하지 않습니다 — 별도 프로젝트가 정말 필요하면 사용자에게 확인하세요.`,
      });
    }

    // ── ③ 결정적 키 = git origin(마커는 동기화되지 않으므로 두 번째 멤버에겐 ①이 원리적으로 항상 미스다). ──
    const gitUrl = originUrlOf(ctx, dir);
    const found_by_origin = gitUrl
      ? await ctx.api("/api/ui/v6/projects/find-by-origin", { method: "POST", body: { git_url: gitUrl } })
      : { origin_key: null, candidates: [], note: "이 폴더는 git 레포가 아니거나 origin 이 없습니다 — 크로스멤버 신원 키가 없어 기존 프로젝트를 확신할 수 없습니다." };
    // ⑤ done 제외 — 끝난 프로젝트에 새 작업을 붙이지 않는다(후보로는 보여준다).
    const active = (found_by_origin.candidates || []).filter((c) => c.status !== "done");
    // 서버가 센 진짜 개수(응답 후보는 상한으로 잘려 있을 수 있다). 구 게이트웨이면 필드가 없으니 로컬 개수로 폴백.
    const activeTotal = Number.isInteger(found_by_origin.active_total) ? found_by_origin.active_total : active.length;

    if (mode === "auto") {
      // **판정하지 않는다 — 무엇을 할지 제안만.** ⑥ 애매하면 사람에게 묻기(create 폴백 금지).
      //  ⚠ origin 이 '멤버 간 합의 가능한 값'인 것과 '프로젝트를 특정하는 값'인 것은 다르다 — 레포↔프로젝트는 N:M 이라
      //   모노레포면 한 origin 에 프로젝트 수십 개가 달린다(실측: 우리 레포에 활성 37개). 그땐 origin 은 판별력이 없다.
      const suggestion = activeTotal === 1
        ? { action: "bind", project_id: active[0].project_id,
            why: `이 폴더의 git origin 이 기존 프로젝트 #${active[0].project_id}(${active[0].name}) 의 레포와 같고, 그 레포를 쓰는 진행 중 프로젝트가 그것 하나뿐입니다 — 결정적 일치입니다.`,
            next: `lively_local_project_init { mode:"bind", project_id:${active[0].project_id} }` }
        : activeTotal > 1
          ? { action: "ask_user",
              why: `이 레포를 진행 중 프로젝트 ${activeTotal}개가 공유합니다(레포↔프로젝트는 N:M — 모노레포면 흔하다). **origin 으로는 어느 프로젝트인지 특정할 수 없습니다.**`,
              next: activeTotal > 5
                ? "후보가 많아 나열이 의미 없습니다 — 사용자에게 '이 폴더가 어느 프로젝트 작업인지' 직접 물으세요(project_list_v6 로 목록을 좁혀 제시해도 좋습니다). 고른 뒤 mode:\"bind\"."
                : "후보를 사용자에게 보여주고 고르게 한 뒤 mode:\"bind\" 로 호출하세요." }
          : { action: "ask_user",
              why: gitUrl
                ? "이 origin 을 쓰는 진행 중 프로젝트가 없습니다. 다만 **마커도 origin 도 '없음'을 증명하지 못합니다** — 레포가 프로젝트에 연결만 안 됐을 수도, 다른 멤버가 다른 이름으로 만들었을 수도 있습니다."
                : "git origin 이 없어 결정적 신원이 없습니다.",
              next: "사용자에게 '새로 만들까요, 기존 프로젝트에 붙일까요?'를 묻고(필요하면 project_list_v6/project_search 로 기존 목록 제시) mode:\"create\" 또는 mode:\"bind\" 로 호출하세요. **임의로 create 하지 마세요 — 중복 프로젝트가 이렇게 생깁니다.**" };
      return ({ status: "suggestion", dry_run: true, dir, git_url: gitUrl || null,
        origin_key: found_by_origin.origin_key ?? null,
        origin_discriminates: activeTotal === 1,
        active_total: activeTotal, total: found_by_origin.total ?? (found_by_origin.candidates || []).length,
        truncated: !!found_by_origin.truncated,
        candidates: found_by_origin.candidates || [], active_candidates: active,
        suggestion, note: found_by_origin.note });
    }

    // ── 쓰기 사전점검 — 중앙 생성은 **롤백이 없다**(트랜잭션 0 + ClickUp 푸시까지 큐잉). 마커를 못 쓸 폴더면
    //    프로젝트만 덩그러니 남으므로, 되돌릴 수 없는 일을 하기 **전에** 여기서 막는다. ──
    const dotLively = join(dir, ".lively");
    const markerFile = join(dotLively, "project.json");
    try {
      mkdirSync(dotLively, { recursive: true });
      const probe = join(dotLively, ".init-probe");
      writeFileSync(probe, "");
      unlinkSync(probe);
    } catch (e) {
      throw new Error(`이 폴더에 마커를 쓸 수 없습니다(${dir}): ${e.message}. 중앙에 프로젝트를 만들기 전에 중단했습니다(고아 프로젝트 방지).`);
    }

    let projectId, projectName;
    if (mode === "bind") {
      projectId = Number(args.project_id);
      if (!Number.isInteger(projectId) || projectId <= 0) throw new Error('mode:"bind" 에는 project_id 가 필요합니다.');
      const p = await ctx.api(`/api/ui/v6/projects/${projectId}`);
      const proj = p.project || p;
      if (!proj || !proj.id) throw new Error(`프로젝트 #${projectId} 를 찾을 수 없습니다.`);
      projectName = proj.name;
    } else { // create
      projectName = String(args.name || "").trim() || basename(dir);
      // list_id 는 넘기지 않으면 '미분류' — **추측하지 않는다**(숨은 두 번째 자율판단 회피). 사용자가 주면 그대로.
      const body = { name: projectName };
      if (Number.isInteger(args.list_id) && args.list_id > 0) body.list_id = args.list_id;
      const created = await ctx.api("/api/ui/v6/projects", { method: "POST", body });
      projectId = (created.project || created).id;
      if (!projectId) throw new Error("프로젝트 생성 응답에 id 가 없습니다.");
    }

    // ── 마커 — read→merge→write(마커 writer 는 5개다: 통째 덮어쓰기 금지). ──
    //  🔴 sync:"none" 이 **핵심 안전값**이다. 이 폴더는 사용자 파일이 사는 곳이라, pull 훅이 서버 공유폴더를
    //   여기에 내려받으면 사용자의 CLAUDE.md/AGENTS.md 를 무음으로 덮어쓴다(#905 §2 — 실제로 재현된 사고).
    //   공유폴더를 이 폴더에 받고 싶으면 사람이 명시적으로 "pull" 로 바꾼다.
    let marker = {};
    try { marker = JSON.parse(readFileSync(markerFile, "utf8")); } catch { /* 신규/파손 */ }
    marker.project_id = projectId;
    marker.sync = marker.sync || "none";
    writeFileSync(markerFile, JSON.stringify(marker, null, 2) + "\n");

    // ── 바인딩 — "이 프로젝트가 내 환경 이 경로에 산다"(중앙 인벤토리). 실패해도 로컬 연결은 이미 유효하다. ──
    let bound = null, bindError = null;
    try {
      bound = await ctx.api(`/api/ui/v6/projects/${projectId}/folder-binding`, {
        method: "POST",
        body: { node_id: HOSTNAME_SLUG(), abs_path: dir, sync: marker.sync, git_url: gitUrl || undefined },
      });
    } catch (e) { bindError = e.message; }

    return ({
      status: mode === "bind" ? "bound" : "created",
      project_id: projectId, name: projectName, dir, marker: markerFile,
      sync: marker.sync,
      binding: bound ? bound.bound : null,
      binding_error: bindError,
      note: `이 폴더는 이제 프로젝트 #${projectId}(${projectName}) 입니다. `
        + `공유폴더 동기화는 **sync:"${marker.sync}"** — 사용자 폴더라 서버 파일을 여기에 내려받지 않습니다(당신 파일을 덮어쓰지 않기 위함). `
        + `다음 세션부터 이 폴더에서 프로젝트 맥락이 뜹니다.`
        + (bindError ? ` ⚠ 중앙 폴더 인벤토리 등록만 실패했습니다(${bindError}) — 로컬 연결은 정상입니다.` : ""),
    });
}

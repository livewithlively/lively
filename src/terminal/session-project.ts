// 세션 ↔ 프로젝트 소속을 **나중에** 바꾼다 (#1719 홈 입력창 — "일단 프로젝트 없이 열고, 언제든 붙인다").
//
//  ── 모델 ──
//  세션 전용 폴더(<루트>/sessions/<세션id>)는 세션의 것이고 **cwd 는 바뀌지 않는다.** 프로젝트 소속은 세 자리에 적는다:
//   ① tmux `@box_project`(+`@box_project_src`) — 목록·귀속·복원의 표시값(종전 프로젝트 세션과 같은 자리).
//   ② 세션 폴더 **안** — `.lively/project.json` 마커(훅·CLI 가 cwd 에서 위로 찾는 그 마커, 단 `kind:"session"`·`project_dir`
//      를 함께 적어 "이 폴더가 프로젝트 폴더"로 오독되지 않게) + `project` 링크(POSIX 심링크 / Windows 정션) +
//      AGENTS.md·CLAUDE.md 셔틀(다음에 뜨는 하네스가 프로젝트 규칙을 읽게).
//   ③ DB `session_project`(시간구간 — 재바인딩은 새 구간, 과거 작업은 옛 프로젝트에 남는다) — 게이트웨이 라우트가 적는다(노드엔 DB 없음).
//
//  ── 왜 cwd 자체를 프로젝트 폴더로 심링크하지 않나(대표 제안 검토) ──
//   · 실행 중 프로세스의 cwd 는 **inode 참조**라 링크를 갈아끼워도 따라오지 않는다(재시작 전엔 무효). 그러면 "언제든 바꾼다"가
//     "바꾸면 하네스를 다시 띄운다"가 되고, 이어받기 id·트랜스크립트 키(cwd 물리경로 기준)가 프로젝트마다 갈려 복원이 위험해진다.
//   · 이미 만들어 둔 파일을 옮겨야 링크로 바꿀 수 있다(비어 있지 않은 폴더는 링크로 대체 불가).
//   · 관리형(#1437)에선 세션 컨테이너 마운트가 기동 시 고정이라 어차피 "폴더 안 링크 + 공유 루트 마운트"가 필요하다.
//   그래서 cwd 는 세션 것으로 두고, 소속은 그 **안**의 링크·마커·DB 로 표현한다 — 어느 환경(박스·관리형·맥/윈 노드)에서도 같은 코드다.
//
//  ── 노드(맥·윈 로컬 세션) ──
//  게이트웨이가 `setProject` op 로 릴레이하면 노드가 이 모듈의 applySessionProject 를 자기 파일시스템·mux 에 그대로 적용한다
//  (정책=게이트웨이 F7, 실행=노드). 프로젝트 폴더가 그 머신에 없으면 **만든다**(#1856) — 종전엔 건너뛰어서 원격 노드는
//  링크도 문서 pull 도 성립하지 않았고, 그래서 프로젝트 문서를 영영 못 받았다(폴더를 만드는 경로가 레포 provision 뿐이었다).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PROJECT_SHARED_BASE } from "../project/project-fs.js";
import { HttpError } from "../http-error.js";
import { getOpt, tmux, tmuxQuiet, sessionDir } from "./tmux-exec.js";
import { ownerId, sessionOsUser } from "./profiles.js";
import { memberNodeJson } from "./terminal-member-fs.js";
import type { LivelyUser } from "../context.js";

/** <루트>/sessions/<세션id> — 세션 전용 폴더가 사는 하위 이름(createSession · restore 가 같은 이름을 쓴다). */
export const SESSION_DIR_SUBDIR = "sessions";
/** 세션 폴더 안의 프로젝트 링크 이름. */
export const PROJECT_LINK_NAME = "project";
const OWNED_MARK = "<!-- lively:session-project -->";   // 우리가 쓴 셔틀 파일의 첫 줄 — 이 줄이 있을 때만 덮어쓰거나 지운다

//  agentsMd — 게이트웨이가 실어 보내는 프로젝트 AGENTS.md 전문(#1856). 노드가 프로젝트 폴더를 **처음 만들 때**
//   그 자리에 함께 써서, pull 이 한 바퀴 돌기 전에도 다음 세션이 프로젝트 규칙을 읽는다(빈 폴더 + import 실패 회피).
export interface SessionProjectBind { projectId: number; folder: string; name?: string | null; src?: "v6" | "org"; agentsMd?: string | null }

/** 이 호스트에서 프로젝트 폴더가 놓이는 절대경로. folder 는 'project/<id>' 꼴 상대경로. 워크스페이스 밖이면 null.
 *  ⚠ **존재 여부는 보지 않는다**(#1856) — 있는지는 probe 가 답하고, 없을 때 만들지는 planSessionProjectFs 가 정한다.
 *   종전엔 여기서 existsSync 로 걸러 null 을 돌려줬는데, 그러면 폴더가 없는 노드(맥·윈)에서 **영영 만들어지지 않아**
 *   링크도 문서 pull 도 성립하지 않았다(프로젝트 폴더를 만드는 유일한 경로가 레포 provision 뿐이었다). */
export function projectDirPath(folder: string): string | null {
  const rel = String(folder || "").replace(/^[/\\]+/, "");
  if (!rel) return null;
  const abs = path.resolve(PROJECT_SHARED_BASE, rel);
  if (abs !== PROJECT_SHARED_BASE && !abs.startsWith(PROJECT_SHARED_BASE + path.sep)) return null;   // 워크스페이스 밖이면 안 잇는다
  return abs;
}

/** 이 호스트에 **실재하는** 프로젝트 폴더의 절대경로(없으면 null).
 *  ⚠ projectDirPath 와 의도적으로 다른 함수다 — 이름 하나로 합치지 마라. "있는 것만 만진다"가 곧 안전인 자리가 쓴다:
 *   세션 완전삭제(#1850)는 이 값으로 폴더를 `rm -rf` 하므로, 존재 확인 없이 경로만 받으면 그 안전 가정이 사라진다.
 *   반대로 바인딩(#1856)은 "없으면 만든다"가 목적이라 존재 판정을 probe 로 미뤄야 한다. 그래서 둘 다 남는다. */
export function projectDirOnThisHost(folder: string): string | null {
  const abs = projectDirPath(folder);
  return abs && fs.existsSync(abs) ? abs : null;
}

// ── 폴더 안 표현의 실행 통로(io) — 게이트웨이 자신(fs) 또는 격리 멤버 uid(terminal-member-fs.memberNodeJson) ──
//  격리 박스(#524)·관리형에선 세션 폴더가 멤버 홈(700) 안이라 게이트웨이(lively)가 직접 못 쓴다 → 같은 계획을 멤버 uid 로 실행한다.
//  계획(planSessionProjectFs)은 순수라 두 통로가 **같은 파일을 같은 내용으로** 만든다.
//  projDir*/projAgents*/projMarker* — **프로젝트 폴더** 쪽 관측(#1856). 계획 함수가 순수하려면 파일시스템 질문은
//   전부 여기로 와야 한다(종전엔 planSessionProjectFs 안에서 fs.existsSync 로 프로젝트 AGENTS.md 를 직접 봤는데,
//   격리 통로에선 게이트웨이 uid 로 본 결과라 멤버가 보는 것과 갈릴 수 있었다).
export interface SessionDirProbe {
  linkIsSymlink: boolean; agentsHead: string | null; claudeHead: string | null;
  projDirExists?: boolean; projAgentsExists?: boolean; projMarkerExists?: boolean;
}
export type SessionDirOp =
  | { op: "unlink"; p: string } | { op: "rm"; p: string } | { op: "mkdir"; p: string }
  | { op: "write"; p: string; data: string } | { op: "symlink"; target: string; p: string; type: "junction" | "dir" };
/** probe 대상 경로. proj* 는 프로젝트 폴더가 이 호스트 경로모델 안일 때만 실린다(밖이면 undefined). */
export interface SessionDirPaths { link: string; agents: string; claude: string; projDir?: string; projAgents?: string; projMarker?: string }
export interface SessionDirIo {
  probe(paths: SessionDirPaths): Promise<SessionDirProbe>;
  run(ops: SessionDirOp[]): Promise<{ linkFailed: boolean }>;
}
const head = async (f: string): Promise<string | null> => { try { return (await fsp.readFile(f, "utf8")).slice(0, 200); } catch { return null; } };
const exists = async (f: string | undefined): Promise<boolean> => { if (!f) return false; try { await fsp.stat(f); return true; } catch { return false; } };
export const localIo: SessionDirIo = {
  async probe(p) {
    let linkIsSymlink = false;
    try { linkIsSymlink = (await fsp.lstat(p.link)).isSymbolicLink(); } catch { /* 없음 */ }
    return {
      linkIsSymlink, agentsHead: await head(p.agents), claudeHead: await head(p.claude),
      projDirExists: await exists(p.projDir), projAgentsExists: await exists(p.projAgents), projMarkerExists: await exists(p.projMarker),
    };
  },
  async run(ops) {
    let linkFailed = false;
    for (const o of ops) {
      if (o.op === "unlink") await fsp.unlink(o.p).catch(() => { /* 없음 */ });
      else if (o.op === "rm") await fsp.rm(o.p, { force: true }).catch(() => { /* 없음 */ });
      else if (o.op === "mkdir") await fsp.mkdir(o.p, { recursive: true });
      else if (o.op === "write") await fsp.writeFile(o.p, o.data);
      else if (o.op === "symlink") { try { await fsp.symlink(o.target, o.p, o.type); } catch (e) { linkFailed = true; console.warn(`[terminal] 프로젝트 링크 실패(${o.p} → ${o.target}) — 마커만 남긴다:`, (e as Error)?.message ?? e); } }
    }
    return { linkFailed };
  },
};
// 멤버 uid 실행기 — stdin JSON {probe}|{ops} → stdout JSON. 스크립트는 고정 리터럴(값은 전부 stdin).
export const MEMBER_JS =   // export = 테스트용(로컬 uid 로 같은 리터럴을 돌려 계약을 검증한다)
  "const fs=require('fs');const inp=JSON.parse(fs.readFileSync(0,'utf8'));" +
  "if(inp.probe){const P=inp.probe;let l=false;try{l=fs.lstatSync(P.link).isSymbolicLink()}catch{}" +
  "const h=(f)=>{try{return fs.readFileSync(f,'utf8').slice(0,200)}catch{return null}};" +
  "const e=(f)=>{try{return !!f&&fs.existsSync(f)}catch{return false}};" +
  "process.stdout.write(JSON.stringify({linkIsSymlink:l,agentsHead:h(P.agents),claudeHead:h(P.claude)," +
  "projDirExists:e(P.projDir),projAgentsExists:e(P.projAgents),projMarkerExists:e(P.projMarker)}))}" +
  "else{let lf=false;for(const o of inp.ops||[]){if(o.op==='unlink'){try{fs.unlinkSync(o.p)}catch{}}" +
  "else if(o.op==='rm'){fs.rmSync(o.p,{force:true})}else if(o.op==='mkdir'){fs.mkdirSync(o.p,{recursive:true})}" +
  "else if(o.op==='write'){fs.writeFileSync(o.p,o.data)}else if(o.op==='symlink'){try{fs.symlinkSync(o.target,o.p,o.type)}catch{lf=true}}}" +
  "process.stdout.write(JSON.stringify({linkFailed:lf}))}";
export function memberIo(osUser: string): SessionDirIo {
  return {
    probe: (paths) => memberNodeJson<SessionDirProbe>(osUser, MEMBER_JS, { probe: paths }),
    run: (ops) => memberNodeJson<{ linkFailed: boolean }>(osUser, MEMBER_JS, { ops }),
  };
}

const ownedOrAbsent = (h: string | null): boolean => h === null || h.startsWith(OWNED_MARK);

/** planSessionProjectFs 의 선택지 — 프로젝트 폴더를 **이 호스트에 확보할지**와, 확보할 때 함께 심을 AGENTS.md 전문. */
export interface SessionProjectPlanOpts {
  /** 프로젝트 폴더가 없으면 만든다(#1856). 노드·비격리 박스에서만 true — 격리(멤버 uid) 통로에선 공유폴더를
   *  멤버 권한으로 만들면 안 되므로 false 로 둔다(그 환경엔 서버가 이미 만들어 둔 폴더가 있다). */
  createProjectDir?: boolean;
  /** 게이트웨이가 실어 보낸 프로젝트 AGENTS.md 전문 — 폴더를 새로 만들 때만 심는다(있으면 pull 에 맡긴다). */
  agentsMd?: string | null;
}

/** 세션 폴더 안 표현을 계획한다(순수) — bind=null 이면 걷어내는 계획. 링크가 진짜 폴더면 건드리지 않는다(사용자 것). */
export function planSessionProjectFs(dir: string, sessionId: string, bind: SessionProjectBind | null, projectDir: string | null, probe: SessionDirProbe, platform: string = process.platform, opts: SessionProjectPlanOpts = {}): { ops: SessionDirOp[]; wantLink: boolean; createdProjectDir: boolean } {
  const markerDir = path.join(dir, ".lively");
  const marker = path.join(markerDir, "project.json");
  const link = path.join(dir, PROJECT_LINK_NAME);
  const agents = path.join(dir, "AGENTS.md");
  const claude = path.join(dir, "CLAUDE.md");
  const ops: SessionDirOp[] = [];
  // 링크는 늘 걷어낸 뒤 다시 건다(대상이 바뀌었을 수 있다). 링크가 아니라 진짜 폴더면 건드리지 않는다.
  if (probe.linkIsSymlink) ops.push({ op: "unlink", p: link });
  if (!bind) {
    ops.push({ op: "rm", p: marker });
    if (ownedOrAbsent(probe.agentsHead)) ops.push({ op: "rm", p: agents });
    if (ownedOrAbsent(probe.claudeHead)) ops.push({ op: "rm", p: claude });
    return { ops, wantLink: false, createdProjectDir: false };
  }
  // ── 프로젝트 폴더 확보(#1856) — 이 호스트에 없으면 만든다. 없던 시절엔 링크가 안 걸리고(그래서 셔틀의
  //  @project/AGENTS.md 도 없고) 문서 pull 의 진입 조건(마커 있는 프로젝트 폴더)도 성립하지 않아, 원격 노드는
  //  프로젝트 문서를 **영영** 못 받았다. 폴더를 만드는 유일한 경로가 레포 provision 뿐이었기 때문이다.
  //  마커는 sync:"pull" — 이 폴더는 서버가 정본인 공유폴더의 로컬 사본이라 받기만 한다(세션 폴더의 none 과 대비).
  const createdProjectDir = !!projectDir && !probe.projDirExists && !!opts.createProjectDir;
  if (createdProjectDir && projectDir) {
    ops.push({ op: "mkdir", p: path.join(projectDir, ".lively") });   // recursive — 프로젝트 폴더까지 함께 생긴다
    if (!probe.projMarkerExists) {
      const projMeta = { project_id: bind.projectId, sync: "pull" };
      ops.push({ op: "write", p: path.join(projectDir, ".lively", "project.json"), data: JSON.stringify(projMeta, null, 2) + "\n" });
    }
  }
  // 방금 만든 빈 폴더엔 AGENTS.md 가 없다 → pull 이 한 바퀴 돌기 전까지 셔틀의 @project/AGENTS.md 가 깨진 import 가
  //  된다. 게이트웨이가 전문을 실어 보냈으면 그 자리에 심어 첫 세션부터 성립하게 한다(이미 있으면 pull 에 맡긴다).
  const seedAgents = createdProjectDir && !probe.projAgentsExists && !!opts.agentsMd && !!projectDir;
  if (seedAgents && projectDir) ops.push({ op: "write", p: path.join(projectDir, "AGENTS.md"), data: String(opts.agentsMd) });
  ops.push({ op: "mkdir", p: markerDir });
  // 마커 — 훅(세션 기록 귀속)·CLI(워크트리 슬롯) 가 cwd 에서 위로 찾는 그 파일. `kind:"session"` + `project_dir` 로 "이 폴더는
  //  세션 폴더이고 프로젝트 폴더는 저기"를 말한다. sync:"none" — 공유폴더 pull/push 훅이 이 폴더에 서버 파일을 쓰지 않게(fail-safe).
  //  ⚠ project_dir 은 **이 호스트에 실재하는 폴더일 때만** 적는다 — pull 훅이 이 값을 따라가므로(#1856),
  //   없는 경로를 적으면 훅이 유령 폴더에 받으려 든다.
  const haveProjectDir = !!projectDir && (!!probe.projDirExists || createdProjectDir);
  const meta = { kind: "session", session_id: sessionId, project_id: bind.projectId, project_dir: haveProjectDir ? projectDir : null, sync: "none", bound_at: new Date().toISOString() };
  ops.push({ op: "write", p: marker, data: JSON.stringify(meta, null, 2) + "\n" });
  // Windows 는 정션(관리자 권한 불요·절대경로 필수) · 그 밖은 디렉터리 심링크. 실패해도 마커는 남는다(링크는 편의).
  if (haveProjectDir && projectDir) ops.push({ op: "symlink", target: projectDir, p: link, type: platform === "win32" ? "junction" : "dir" });
  // 셔틀 — 다음에 이 폴더에서 뜨는(또는 이어받는) 하네스가 프로젝트 규칙을 읽게. 실행 중 하네스는 다음 세션부터 본다
  //  (Claude Code 는 CLAUDE.md 를 시작 때 읽는다). 우리가 쓴 파일(첫 줄 표식)만 덮어쓴다.
  const title = bind.name ? `#${bind.projectId} «${bind.name}»` : `#${bind.projectId}`;
  const hasProjAgents = haveProjectDir && (!!probe.projAgentsExists || seedAgents);   // probe/계획 기준 — 순수 유지(#1856)
  const agentsBody = [
    OWNED_MARK,
    `# 이 세션은 프로젝트 ${title} 에 속합니다`,
    "",
    "> 라이블리가 세션↔프로젝트 소속을 바꿀 때 자동으로 다시 씁니다(사람이 편집하지 마세요 — 지워집니다).",
    "",
    haveProjectDir
      ? `- 프로젝트 폴더: \`./${PROJECT_LINK_NAME}\` → \`${projectDir}\``
      : "- 프로젝트 폴더는 이 컴퓨터에 없습니다 — 프로젝트 본문·지식은 lively MCP(`project_get_v6`)로 봅니다.",
    `- 프로젝트 상세·태스크·필요지식: \`project_get_v6(${bind.projectId})\` (lively MCP)`,
    hasProjAgents ? `- 프로젝트 규칙·레포·필요지식 요약은 \`./${PROJECT_LINK_NAME}/AGENTS.md\` 에 있습니다 — 먼저 읽으세요.` : "",
    "- 산출물은 이 세션 폴더가 아니라 **프로젝트 폴더 안**에 두면 프로젝트를 보는 모두가 봅니다.",
    "",
  ].filter((l) => l !== "").join("\n") + "\n";
  if (ownedOrAbsent(probe.agentsHead)) ops.push({ op: "write", p: agents, data: agentsBody });
  if (ownedOrAbsent(probe.claudeHead)) {
    const lines = [OWNED_MARK, "@AGENTS.md"];
    if (hasProjAgents && projectDir) lines.push(`@${PROJECT_LINK_NAME}/AGENTS.md`);
    ops.push({ op: "write", p: claude, data: lines.join("\n") + "\n" });
  }
  return { ops, wantLink: haveProjectDir, createdProjectDir };
}

/** 세션 폴더 안의 표현(마커·링크·셔틀)을 프로젝트에 맞춘다. bind=null 이면 걷어낸다. io 로 게이트웨이/멤버 uid 를 가른다(기본 로컬 fs).
 *  opts.createProjectDir 로 "이 호스트에 프로젝트 폴더가 없으면 만든다"를 켠다(#1856 — 기본 false 로 종전 동작 유지). */
export async function applySessionProjectFs(dir: string, sessionId: string, bind: SessionProjectBind | null, io: SessionDirIo = localIo, opts: SessionProjectPlanOpts = {}): Promise<{ linked: boolean; projectDir: string | null; createdProjectDir: boolean }> {
  const projectDir = bind ? projectDirPath(bind.folder) : null;
  const paths: SessionDirPaths = {
    link: path.join(dir, PROJECT_LINK_NAME), agents: path.join(dir, "AGENTS.md"), claude: path.join(dir, "CLAUDE.md"),
    ...(projectDir ? { projDir: projectDir, projAgents: path.join(projectDir, "AGENTS.md"), projMarker: path.join(projectDir, ".lively", "project.json") } : {}),
  };
  const probe = await io.probe(paths);
  const { ops, wantLink, createdProjectDir } = planSessionProjectFs(dir, sessionId, bind, projectDir, probe, process.platform, opts);
  const r = await io.run(ops);
  // 링크가 실패해도 폴더는 만들어졌다 — projectDir 은 '이 호스트에서 쓸 수 있는 프로젝트 폴더'를 뜻하므로 링크 성패와 별개다.
  const usable = wantLink ? projectDir : null;
  return { linked: wantLink && !r.linkFailed, projectDir: usable, createdProjectDir };
}

/** 이 세션이 세션 전용 폴더에서 도는가(@box_session_dir) — 그럴 때만 폴더 안을 만진다. */
export async function isSessionDirSession(id: string): Promise<boolean> {
  return (await getOpt(id, "@box_session_dir")) === "1";
}

/**
 * 이 호스트의 세션에 프로젝트 소속을 적용한다 — tmux 옵션 + (세션 전용 폴더면) 폴더 안 표현.
 *  인가는 호출자(라우트 = 소유자, 노드 op = 게이트웨이가 검증) 몫이지만 assertManage 로 한 번 더 막는다(소유자 아니면 throw).
 *  DB 는 안 만진다(노드엔 없다) — 게이트웨이 라우트가 recordSessionProject·desired-state 를 적는다.
 */
export async function applySessionProject(user: LivelyUser, id: string, bind: SessionProjectBind | null): Promise<{ ok: true; projectId: number | null; linked: boolean; projectDir: string | null; sessionDir: boolean }> {
  // 소유자만(sessions.ts assertManage 와 같은 규칙 — 방향 규약상 이 모듈은 sessions.ts 를 import 하지 않아 tmux 메타로 판정).
  const owner = await getOpt(id, "@box_owner");
  if (!owner || owner !== ownerId(user)) throw new HttpError(403, "본인 세션이 아닙니다");
  if (bind) {
    await tmux(["set-option", "-t", id, "@box_project", String(bind.projectId)]);
    await tmux(["set-option", "-t", id, "@box_project_src", bind.src === "org" ? "org" : "v6"]);
  } else {
    await tmuxQuiet(["set-option", "-t", id, "-u", "@box_project"]);
    await tmuxQuiet(["set-option", "-t", id, "-u", "@box_project_src"]);
  }
  const inSessionDir = await isSessionDirSession(id);
  let linked = false; let projectDir: string | null = null;
  if (inSessionDir) {
    const dir = await sessionDir(id);
    // 격리(#524)면 세션 폴더가 멤버 홈(700) 안 — 게이트웨이가 못 쓰므로 멤버 uid 로 같은 계획을 실행한다. 비격리·노드는 로컬 fs.
    const osUser = await sessionOsUser(id).catch(() => null);
    // createProjectDir 는 **비격리에서만**(#1856) — 격리 박스·관리형의 프로젝트 폴더는 공유폴더(그룹 권한·서버 소유)라
    //  멤버 uid 로 만들면 권한이 어긋난다. 그 환경엔 게이트웨이가 ensureAgentsMd 로 이미 만들어 둔 폴더가 있다.
    ({ linked, projectDir } = await applySessionProjectFs(dir, id, bind, osUser ? memberIo(osUser) : localIo, {
      createProjectDir: !osUser, agentsMd: bind?.agentsMd ?? null,
    }));
  }
  return { ok: true, projectId: bind ? bind.projectId : null, linked, projectDir, sessionDir: inSessionDir };
}

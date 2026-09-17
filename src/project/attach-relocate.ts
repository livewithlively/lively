// 첫 지시의 **명시 첨부**를 그 세션의 프로젝트 공유폴더로 옮긴다 (#3787).
//
// ── 왜 ──────────────────────────────────────────────────────────────────────
//  홈 런처에서 새 세션을 열 때는 **첨부 시점에 프로젝트가 없다** — 프로젝트는 첫 지시로 자동 생성된다
//  (terminal/routes.ts firstPromptProjectPlan). 그래서 컴포저는 개인 폴더로 올리고, 그 결과
//   ① 프로젝트 자료함에 안 뜬다(자료가 개인 소속이다)
//   ② 로컬 노드 세션이 못 찾는다(개인 폴더는 동기화 축이 아니다)
//  원준님 판단(2026-09-14): **«사용자가 프롬프트에 명시적으로 첨부한 파일은 공유폴더로 당연히 옮겨져야»** 한다.
//  여기서 옮기면 셋이 한 번에 풀린다 — 자료가 프로젝트 소속이 되고, 동기화가 나르고, 좌표가 프로젝트 것이 된다.
//
// ── 어디서 ──────────────────────────────────────────────────────────────────
//  세션 생성이 프로젝트를 확정한 **직후** 한 자리에서. 컴포저·터미널·MCP·liv 가 전부 그 문을 지나므로
//  입구마다 같은 코드를 두지 않는다(#3787 이 그 «입구마다 따로» 때문에 난 사고다).
//
// ── 안전 ────────────────────────────────────────────────────────────────────
//  · **자기 개인 폴더의 파일만** 옮긴다. 좌표의 member 가 요청자와 다르면 건너뛴다(남의 파일을 옮기지 않는다).
//  · 옮기기는 copy→unlink 가 아니라 **rename 우선**(같은 파일시스템이면 원자적), 실패하면 copy 후 원본 유지.
//    원본을 지우다 실패하면 사용자 폴더에서 파일이 사라진 것처럼 보인다 — 그쪽 실패는 되돌릴 수 없다.
//  · 실패는 **첨부 하나 단위**로 삼킨다. 옮기기가 안 돼도 세션은 열려야 하고, 그 첨부는 종전 좌표 그대로
//    지시문에 남아 주입 훅이 «이 컴퓨터에 없습니다» 로 크게 말한다(무음 오답은 안 난다).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { localExternalId, parseLocalExternalId } from "../ingest/local-file-core.js";
import { resolveLocalFile, ingestLocalUpload, supersedeLocalPath } from "../ingest/local-file.js";
import { projectStorage, type ProjectStorage } from "./project-storage.js";   // #4064 — 옮겨 갈 자리·실행 주체
import { memberReadTo, memberRm, memberMv } from "../terminal/terminal-member-fs.js";   // 격리 멤버(#524) 개인 폴더는 그 uid 로만 읽힌다
import { logger } from "../log.js";

/** 지시문에 박힌 좌표 표기 — 컴포저 tail() 이 `- <이름>  [lively:<ref>]` 로 적는다. */
const REF_RE = /\[lively:([^\]]+)\]/g;

/** 순수 — 지시문에서 좌표를 뽑는다(중복 제거, 등장 순서 유지). */
export function refsInPrompt(prompt: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  REF_RE.lastIndex = 0;
  for (let m = REF_RE.exec(prompt); m; m = REF_RE.exec(prompt)) {
    const r = m[1].trim();
    if (r && !seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out;
}

/** 순수 — 지시문의 좌표 표기를 새 좌표로 바꾼다(표시 이름은 그대로 둔다). */
export function rewriteRefs(prompt: string, moved: Map<string, string>): string {
  if (!moved.size) return prompt;
  return prompt.replace(REF_RE, (whole, ref) => {
    const next = moved.get(String(ref).trim());
    return next ? `[lively:${next}]` : whole;
  });
}

/** 폴더 안에서 비어 있는 이름 — 겹치면 `이름-2.확장자`, `이름-3.확장자`… (컴포저 attachName 과 같은 규칙). */
async function freeName(store: ProjectStorage, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 100; i++) {
    const cand = i === 1 ? name : `${stem}-${i}${ext}`;
    if (!(await store.stat(path.resolve(store.base, cand)))) return cand;
  }
  return `${stem}-${Date.now()}${ext}`;
}

export interface RelocateResult { prompt: string; moved: number; failed: number }

/**
 * 첫 지시의 개인 폴더 첨부를 프로젝트 공유폴더로 옮기고, 지시문의 좌표를 새 좌표로 바꿔 돌려준다.
 *  프로젝트 좌표이거나 남의 개인 폴더면 손대지 않는다. 어떤 실패도 던지지 않는다(세션 생성을 막지 않는다).
 */
export async function relocateAttachmentsToProject(o: {
  prompt: string; projectId: number; folder: string; memberId: string;
}): Promise<RelocateResult> {
  const refs = refsInPrompt(o.prompt);
  if (!refs.length || !o.folder) return { prompt: o.prompt, moved: 0, failed: 0 };
  //  옮겨 갈 자리는 프로젝트 저장소가 정한다(#4064) — 매니지드면 세션이 일하는 멤버 저장소다. 게이트웨이 로컬로
  //  옮기면 세션은 그 첨부를 못 읽는다(주입 훅이 «이 컴퓨터에 없습니다» 로 말하게 된다).
  let store: ProjectStorage;
  try { store = await projectStorage(o.folder, { memberId: o.memberId }); }
  catch (e) {
    logger.warn({ err: e, projectId: o.projectId }, "[attach-relocate] 프로젝트 저장소를 못 열었다 — 첨부는 종전 좌표로 둔다");
    return { prompt: o.prompt, moved: 0, failed: 0 };
  }
  const base = store.base;
  const moved = new Map<string, string>();
  let failed = 0;

  for (const ref of refs) {
    const p = parseLocalExternalId(ref);
    //  프로젝트 좌표는 이미 제자리다. shared 는 팀 폴더라 사람 동의 없이 옮기지 않는다.
    if (!p || p.root.kind !== "personal") continue;
    //  **자기 것만** — 남의 개인 폴더 파일을 프로젝트로 끌어오지 않는다.
    if (p.root.member !== o.memberId) continue;
    try {
      const src = await resolveLocalFile(p);
      if (!src) { failed++; continue; }
      await store.mkdirp(base);
      //  이름 충돌은 **비켜 간다** — 갓 만든 프로젝트 폴더엔 AGENTS.md 가 이미 있고, 같은 이름 첨부가 오면
      //  덮어쓰기는 그 프로젝트의 규칙 문서를 지우는 일이 된다. 사람이 올린 것을 잃지 않는 쪽으로 이름을 바꾼다.
      const name = await freeName(store, path.basename(p.rel));
      const dest = path.resolve(base, name);
      if (dest !== base && !dest.startsWith(base + path.sep)) { failed++; continue; }
      if (store.osUser) {
        // 멤버 저장소(#4064) — 옮기기 자체를 멤버 경계에서 한다. 개인 폴더와 프로젝트 폴더가 **같은 경계**
        //  (같은 사람의 계정)일 때만 한 번의 mv 로 끝난다. 다른 경계면 옮기지 않는다(종전 좌표로 둔다).
        //  mv 는 장치가 다르면 복사 뒤 원본을 지운다 — 원본 지우기가 실패하면 사본과 원본이 둘 다 남는다(잃지 않는다).
        if (src.osUser !== store.osUser) { failed++; continue; }
        await memberMv(store.osUser, src.abs, dest);
      } else if (src.osUser) {
        // 격리 멤버(#524)의 개인 폴더는 700 이라 **게이트웨이가 직접 못 읽는다** — 그 uid 로 읽어 내보낸다.
        //  읽기가 끝난 뒤에만 원본을 지운다(옮기기지 복사가 아니다). 지우기 실패는 무시 — 사본은 이미 섰다.
        await new Promise<void>((resolve, reject) => {
          const w = fs.createWriteStream(dest);
          w.on("error", reject); w.on("finish", () => resolve());
          memberReadTo(src.osUser as string, src.abs, w).catch(reject);
        });
        await memberRm(src.osUser, src.abs).catch(() => { /* 원본이 남을 뿐 — 자료는 새 좌표로 수렴한다 */ });
      } else {
        //  rename 우선 — 같은 파일시스템이면 원자적이고 원본이 남지 않는다. 다른 장치면 copy 로 떨어진다.
        //  ⚠ copy 뒤 원본을 지우지 않는다: 지우다 실패하면 사용자 폴더에서 파일이 사라진 것처럼 보이고
        //   되돌릴 수 없다. 사본이 둘인 편이 훨씬 낫다(자료는 새 좌표 하나로 수렴한다).
        try { await fsp.rename(src.abs, dest); }
        catch { await fsp.copyFile(src.abs, dest); }
      }
      await store.grantGroup(dest, "file").catch(() => { /* 그룹 권한 실패는 비치명 */ });
      //  ⚠ 자료 등록은 **기다리지 않는다**. 이 함수는 세션 생성 POST 안에서 돌고, ingest 는 큰 PDF·OOXML 을
      //   본문 추출까지 하므로 초 단위로 늘어질 수 있다 — 그만큼 사람이 빈 화면을 본다. 세션이 그 파일을 읽는 데
      //   필요한 것은 **파일이 그 자리에 있는 것**뿐이고(위에서 끝났다), 자료함 표시는 한 박자 늦어도 된다.
      //   개인 좌표의 자료 행 내리기도 같이 뒤로 — 같은 파일이 두 자료로 남으면 자료함에 유령이 생긴다.
      void ingestLocalUpload({
        root: { kind: "project", id: o.projectId }, folder: o.folder, base, abs: dest, osUser: store.osUser,
        uploader: { id: o.memberId, name: null }, channelFallback: "uploads",
      })
        .then(() => supersedeLocalPath(p.root, p.rel))
        .catch((e) => logger.warn({ err: e, ref }, "[attach-relocate] 자료 등록·정리 실패 — 파일 이동은 이미 끝났다"));
      moved.set(ref, localExternalId({ kind: "project", id: o.projectId }, name));
    } catch (e) {
      failed++;
      logger.warn({ err: e, ref }, "[attach-relocate] 첨부 이동 실패 — 종전 좌표로 둔다");
    }
  }
  return { prompt: rewriteRefs(o.prompt, moved), moved: moved.size, failed };
}

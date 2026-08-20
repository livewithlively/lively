// 앱 패키지 지문 — content_hash(#1780, design R2-3).
//  왜 publish.ts 의 hashStage 를 그대로 못 쓰나(적대검증 R2-3 확정):
//   ① hashStage 는 모듈 프라이빗(export 안 됨) ② `.slice(0,12)`=48비트(변경감지엔 족하나 공급망 핀엔 충돌내성 0)
//   ③ walkRel 이 isFile/isDirectory 만 봐 **심링크·특수파일이 지문에서 조용히 빠진다**(심링크 타깃만 바꾼 패키지가 같은 해시)
//   ④ VERSION_EXCLUDE 에 kit 전용 경로가 박혀 있다.
//  그래서 앱용 변형을 둔다: 전체 길이 sha256 · 심링크/특수파일은 **거부**(경로 탈출 방어와 한 몸) · exclude 없음.
//
// 이 모듈은 설치 파이프라인이 tar 추출 **후** 스테이지 디렉터리에 대해 호출한다. 심링크 거부가 여기서
//  1차선(경로 탈출·심링크 공격 차단), 매니페스트 파서가 상대경로 형식을, 추출기가 절대·`..` 탈출을 막는다(다층).
import { createHash } from "node:crypto";
import { readdir, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../http-error.js";

const MAX_FILES = 5000;      // 앱 패키지 파일 수 상한(폭주 방어)
const MAX_TOTAL_BYTES = 128 * 1024 * 1024; // 128MB 상한

/**
 * 스테이지 디렉터리의 content_hash 를 계산한다(전체 sha256 hex).
 *  - 심링크·소켓·FIFO·디바이스 등 일반 파일/디렉터리가 아닌 항목을 만나면 **거부**(HttpError 400).
 *  - 해시는 정렬된 상대경로 + 파일 내용에 대해 결정론적(플랫폼·순회순서 무관).
 * @returns { hash, files, bytes }
 */
export async function hashAppPackage(stageDir: string): Promise<{ hash: string; files: number; bytes: number }> {
  const root = path.resolve(stageDir);
  const rels: string[] = [];
  await collect(root, "", rels);
  rels.sort(); // 결정론 — 순회 순서에 의존하지 않는다.

  const h = createHash("sha256");
  let bytes = 0;
  for (const rel of rels) {
    const buf = await readFile(path.join(root, rel));
    bytes += buf.length;
    if (bytes > MAX_TOTAL_BYTES) throw new HttpError(400, `앱 패키지가 너무 큽니다(> ${MAX_TOTAL_BYTES} 바이트)`);
    // 경로와 길이를 내용과 함께 섞어 '파일 경계'를 해시에 반영(내용 이어붙이기 충돌 방지).
    h.update(rel, "utf8");
    h.update("\0");
    h.update(String(buf.length));
    h.update("\0");
    h.update(buf);
  }
  return { hash: h.digest("hex"), files: rels.length, bytes };
}

async function collect(root: string, rel: string, out: string[]): Promise<void> {
  const abs = path.join(root, rel);
  const entries = await readdir(abs, { withFileTypes: true });
  for (const e of entries) {
    const childRel = rel ? path.join(rel, e.name) : e.name;
    const childAbs = path.join(root, childRel);
    // withFileTypes 는 심링크를 isSymbolicLink 로 보고한다(따라가지 않는다). lstat 로 한 번 더 확증.
    const st = await lstat(childAbs);
    if (st.isSymbolicLink()) {
      throw new HttpError(400, `앱 패키지에 심링크가 있습니다(허용 안 됨): ${childRel}`);
    }
    if (st.isDirectory()) {
      await collect(root, childRel, out);
      continue;
    }
    if (!st.isFile()) {
      throw new HttpError(400, `앱 패키지에 일반 파일이 아닌 항목이 있습니다(허용 안 됨): ${childRel}`);
    }
    out.push(childRel);
    if (out.length > MAX_FILES) throw new HttpError(400, `앱 패키지 파일 수가 너무 많습니다(> ${MAX_FILES})`);
  }
}

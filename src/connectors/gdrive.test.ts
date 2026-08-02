// #541 gdrive 커넥터 테스트 — 순수 함수(DB/네트워크 불요).
//   실행: npm run build && node dist/connectors/gdrive.test.js
//   목적: 쿼리 인젝션 가드(since/폴더 보간) + [BINARY] 메타-스텁 포맷(통합 distill 프롬프트·slack 과의 계약) 회귀 잠금.
//   (OOXML 추출 골든은 ./ooxml.test.ts 로 분리 — 공용 유틸.)
import assert from "node:assert/strict";
import { buildFilesQuery, isRfc3339, buildBinaryStub } from "./gdrive.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 쿼리/인젝션 가드 — 폴더/휴지통 제외 유지 + since 는 RFC3339 만 통과(보간 인젝션 차단). ──
t("buildFilesQuery/isRfc3339: 폴더·휴지통 제외 유지·인젝션 가드 불변", () => {
  assert.ok(buildFilesQuery().includes("mimeType != 'application/vnd.google-apps.folder'"));
  assert.ok(buildFilesQuery().includes("trashed = false"));
  assert.ok(!isRfc3339("2026-06-30' or '1'='1")); // 인젝션 시도 거부
  assert.ok(isRfc3339("2026-06-30T00:00:00Z"));
  assert.ok(buildFilesQuery({ since: "2026-06-30T00:00:00Z" }).includes("modifiedTime > '2026-06-30T00:00:00Z'"));
  // 형식 이상 since 는 절 생략(전체 백필 폴백) — 인젝션 문자열이 q 에 안 들어감.
  assert.ok(!buildFilesQuery({ since: "bogus' or 1=1" }).includes("bogus"));
  // 폴더 id 는 허용 문자만 보간 — 이상치는 드랍.
  assert.ok(buildFilesQuery({ folderIds: ["ABC_123"] }).includes("'ABC_123' in parents"));
  assert.ok(!buildFilesQuery({ folderIds: ["bad') or ('1'='1"] }).includes("bad"));
});

// ── [BINARY] 스텁 — 마커·filename·mime·size·url·owner·modified 포함(distill 판단 + source_artifact 계약). ──
t("buildBinaryStub: 마커·메타 필드 포함(통합 distill·slack 공용 계약)", () => {
  const file = {
    id: "1AbC_xyz-9", name: "계약서.pdf", mimeType: "application/pdf", size: "245760",
    webViewLink: "https://drive.google.com/file/d/1AbC_xyz-9/view",
    owners: [{ emailAddress: "cto@ernest.ai", displayName: "CTO" }],
    modifiedTime: "2026-06-30T00:00:00Z",
  };
  const stub = buildBinaryStub(file as never);
  assert.ok(stub.startsWith("[BINARY] "), stub.slice(0, 40)); // 통합 프롬프트가 이 시작 토큰으로 분기
  assert.ok(stub.includes("filename=계약서.pdf"));
  assert.ok(stub.includes("mime=application/pdf"));
  assert.ok(stub.includes("size=245760"));
  assert.ok(stub.includes("url=https://drive.google.com/file/d/1AbC_xyz-9/view"));
  assert.ok(stub.includes("owner=cto@ernest.ai"));
  assert.ok(stub.includes("modified=2026-06-30T00:00:00Z"));
  assert.ok(stub.includes("source_artifact")); // distill 에게 on-demand 페치 경로 안내
});

t("buildBinaryStub: size/owner 부재 시 해당 필드 생략·url 합성(딥링크)", () => {
  const stub = buildBinaryStub({ id: "ZZZ", mimeType: "image/png" } as never);
  assert.ok(stub.startsWith("[BINARY] filename=ZZZ")); // name 부재 → id 로 폴백
  assert.ok(stub.includes("mime=image/png"));
  assert.ok(!stub.includes("size="), "size 부재 시 필드 생략");
  assert.ok(!stub.includes("owner="), "owner 부재 시 필드 생략");
  assert.ok(stub.includes("url=https://drive.google.com/file/d/ZZZ")); // webViewLink 부재 → 합성
});

console.log(`\n${pass} passed (gdrive 쿼리 인젝션 가드 + [BINARY] 스텁 계약)`);

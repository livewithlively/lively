// 임베딩 끄기가 store 까지 내리지 않는다 (#4501) — `deploy/disable-embeddings.sh` 회귀락.
//  종전 `dc compose --profile embeddings down --remove-orphans` 는 **profile 없는 서비스(items-db)까지** 지웠다
//  (compose v2.29·v5.5 에서 장난감 프로젝트로 실측: items-db 컨테이너 제거, 볼륨은 남음). 네이티브 게이트웨이는
//  그 순간 DB 를 잃는데 스크립트는 «완료» 를 찍는다 — 박스에서 임베딩을 끌 때만 드러나는 조용한 장애다.
//  그래서 «compose 에 profile=embeddings 로 선언된 서비스만, 이름을 지정해 지운다» 를 락한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sh = fs.readFileSync(path.join(here, "disable-embeddings.sh"), "utf8");
const compose = fs.readFileSync(path.join(here, "..", "docker-compose.yml"), "utf8");

// compose 에서 profile=embeddings 서비스 이름을 뽑는다(최상위 services 아래 2칸 들여쓴 이름 → 그 블록의 profiles 줄).
const embeddingServices = [];
let current = null;
for (const line of compose.split("\n")) {
  const svc = /^ {2}([a-z][\w-]*):\s*(#.*)?$/.exec(line);
  if (svc) { current = svc[1]; continue; }
  if (current && /^\s+profiles:\s*\[\s*"embeddings"\s*\]/.test(line)) embeddingServices.push(current);
}
// 배선 단언 — 파싱이 비면 아래 단언이 전부 헛돈다(vacuous 방지).
assert.deepEqual([...embeddingServices].sort(), ["embeddings", "embeddings-init"], `compose 의 embeddings profile 서비스 파싱 결과: ${embeddingServices}`);

const composeCalls = sh.split("\n").filter((l) => /^\s*dc compose\b/.test(l));
assert.ok(composeCalls.length > 0, "disable-embeddings.sh 에서 dc compose 호출을 찾지 못했다(테스트가 대상을 잃음)");

// D1 — down 금지. profile 을 줘도 down 은 profile 없는 서비스까지 내린다.
for (const l of composeCalls) {
  assert.ok(!/\bdown\b/.test(l), `down 을 쓰지 않는다(items-db 까지 내린다): ${l.trim()}`);
}

// D2 — 사이드카 정지는 embeddings profile 서비스를 **정확히** 이름으로 지정한다(새 사이드카가 생기면 여기서 걸린다).
const rm = composeCalls.find((l) => /\brm\b/.test(l));
assert.ok(rm, "사이드카를 지우는 dc compose rm 호출이 없다");
assert.match(rm, /\brm\s+-sf\b/, "rm 은 -s(멈춘 뒤)·-f(확인 없이) 로 부른다");
const named = rm.replace(/^.*\brm\s+-sf\b/, "").replace(/>.*$/, "").trim().split(/\s+/);   // `--profile embeddings` 는 대상이 아니다
assert.deepEqual(named.sort(), [...embeddingServices].sort(), `rm 대상 = embeddings profile 서비스 전부: ${rm.trim()}`);

// D3 — store 는 어떤 호출도 대상으로 삼지 않는다(DB off 는 exec psql 로만 — 컨테이너 수명은 건드리지 않는다).
for (const l of composeCalls.filter((c) => !/\bexec\b/.test(c))) {
  assert.ok(!/\bitems-db\b/.test(l), `items-db 의 수명을 건드리는 호출이 있다: ${l.trim()}`);
}

console.log("✓ disable-embeddings — 임베딩 사이드카만 이름으로 지우고 items-db 는 건드리지 않는다");

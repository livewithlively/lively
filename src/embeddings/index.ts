// 임베딩(pgvector 시맨틱 검색) 진입점 — **기본 OFF**. EMBEDDINGS_ENABLED!=='1' 이면 모든 경로가 휴면이고
// 동작 변화는 0 이다(embedding 컬럼·CREATE EXTENSION 미실행, 검색=ILIKE 그대로). ON 코드는 컴파일되되 OFF 에선
// 진입조차 안 한다.
//
// 절대 제약: embedding 컬럼·vector 확장·hnsw 인덱스는 **여기서만(조건부)** 추가한다 — schema.ts 의 기본 DDL 엔
// 절대 넣지 않는다(pgvector 부재 서버에서 CREATE TABLE 이 깨지지 않도록). 그리고 pgvector 가 없을 수 있으므로
// initEmbeddings 의 모든 DDL 은 try/catch 로 감싸 **실패 시 throw 하지 않고** logger.warn + 내부 disabled 플래그를
// set 한 뒤 정상 반환한다(부팅 graceful 폴백 — 부팅·검색이 깨지지 않는다).
import { itemsPool } from "../items/store.js";
import { logger } from "../log.js";
import { makeHttpEmbeddingProvider, type EmbeddingProvider } from "./provider.js";

// ON/OFF 토글 — 기본 OFF. LIVELY_OFF==='1' 관례와 동일하게 명시적 '1' 만 ON.
export function embeddingsEnabled(): boolean {
  return process.env.EMBEDDINGS_ENABLED === "1";
}

// provider 메모이즈 — enabled 일 때만 1회 생성(URL/DIM 없으면 null → 사실상 휴면).
let providerMemo: EmbeddingProvider | null | undefined;
export function getProvider(): EmbeddingProvider | null {
  if (!embeddingsEnabled()) return null;
  if (providerMemo === undefined) providerMemo = makeHttpEmbeddingProvider();
  return providerMemo;
}

// initEmbeddings 가 DDL(확장/컬럼/인덱스) 적용에 성공해 임베딩 컬럼이 사용 가능한지. 초기엔 false,
//  성공 시 true. pgvector 부재로 실패하면 false 로 남는다(=사실상 OFF, ILIKE 폴백).
let columnReady = false;

// searchKnowledge/upsertKnowledge 가 임베딩 경로를 탈지 결정하는 단일 게이트.
//  enabled && provider 존재 && DDL 성공(컬럼 사용가능) 셋을 모두 만족해야 true.
export function embeddingsUsable(): boolean {
  return embeddingsEnabled() && getProvider() !== null && columnReady;
}

// 부팅 와이어 — initOrgSchema 직후 호출(비치명). enabled 일 때만:
//   CREATE EXTENSION vector → ALTER TABLE ADD COLUMN embedding vector(DIM) → CREATE hnsw INDEX.
// 전부 try/catch — 어느 단계든 실패(pgvector 부재 등)하면 warn 후 columnReady=false 로 두고 throw 없이 반환한다.
export async function initEmbeddings(): Promise<void> {
  if (!embeddingsEnabled()) return; // OFF: 아무것도 안 함(컬럼·확장 미생성).
  const provider = getProvider();
  if (!provider) {
    logger.warn(
      "EMBEDDINGS_ENABLED=1 이지만 provider(EMBEDDINGS_PROVIDER_URL/EMBEDDINGS_DIM)가 미설정 — 임베딩 비활성(ILIKE 폴백)",
    );
    return;
  }
  const dim = provider.dim;
  try {
    // 1) vector 확장 — 부재 서버에서 여기서 throw 될 수 있다(catch 가 흡수).
    await itemsPool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    // 2) embedding 컬럼(이 한 곳에서만 추가) — schema.ts 의 기본 DDL 엔 없음.
    await itemsPool.query(
      `ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS embedding vector(${dim})`,
    );
    // 3) 코사인 거리 hnsw 인덱스.
    await itemsPool.query(
      `CREATE INDEX IF NOT EXISTS knowledge_unit_embedding_idx
         ON knowledge_unit USING hnsw (embedding vector_cosine_ops)`,
    );
    columnReady = true;
    logger.info({ dim }, "임베딩(pgvector) 초기화 완료 — 시맨틱 검색 활성");
  } catch (err) {
    // pgvector 부재 등 — 부팅을 깨지 않고 graceful 폴백(사실상 OFF, ILIKE 검색 그대로).
    columnReady = false;
    logger.warn({ err }, "임베딩 초기화 실패(pgvector 부재 등) — 임베딩 비활성, ILIKE 검색으로 폴백");
  }
}

// 단건 임베딩 — usable 아니면 null. 실패 시 best-effort(null), 호출자가 폴백한다.
export async function embedOne(text: string): Promise<number[] | null> {
  if (!embeddingsUsable()) return null;
  const provider = getProvider();
  if (!provider) return null;
  try {
    const [vec] = await provider.embed([text]);
    return vec ?? null;
  } catch (err) {
    logger.warn({ err }, "임베딩 계산 실패 — 건너뜀");
    return null;
  }
}

// pgvector 텍스트 리터럴 — pg 는 vector 를 '[a,b,c]' 텍스트로 처리(전용 클라이언트 불필요).
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// 테스트/리셋 훅(스크립트 전용) — 메모/플래그 초기화. 라이브 경로에서 호출하지 않는다.
export function __resetEmbeddingsStateForTest(): void {
  providerMemo = undefined;
  columnReady = false;
}

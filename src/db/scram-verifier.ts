// Postgres `CREATE/ALTER ROLE ... PASSWORD '<값>'` 에 평문 대신 넣을 SCRAM-SHA-256 verifier 를 클라이언트에서 만든다.
//
// 왜 평문을 보내지 않나: DDL 은 바인드 파라미터를 못 받아 비밀번호가 문장 텍스트에 들어간다. 서버가 log_statement
//  (all·ddl)이나 pgaudit 로 문장을 남기면 그 텍스트가 그대로 로그에 실린다 — 평문이면 로그가 곧 자격 유출이다.
//  verifier 는 로그에 남아도 그것만으로 로그인할 수 없다(로그인에는 ClientKey 가 필요한데 verifier 에는 그 해시인
//  StoredKey 만 있다). 로그 설정·접속 권한(슈퍼유저 여부)과 무관하게 성립하므로 `SET LOCAL log_statement` 로
//  그 문장만 끄는 쪽(슈퍼유저 전용 · 비슈퍼유저 배포에서는 못 끈다)보다 이쪽을 택했다.
//
// ⚠ Postgres 는 이 형식으로 읽히지 않는 값을 오류 없이 **평문 비밀번호로** 저장한다 — 형식이 틀리면 조용히
//  «verifier 문자열이 비밀번호» 가 되어 원래 비밀번호로는 로그인이 안 된다. 형식은 PG 의 parse_scram_secret
//  (src/backend/libpq/auth-scram.c)이 정하고, 회귀는 org/tenancy/activate-role-password.pg-test.mjs 가 실제 로그인으로 잡는다.
import crypto from "node:crypto";

export function scramSha256Verifier(password: string, opts: { salt?: Buffer; iterations?: number } = {}): string {
  // SCRAM 은 비밀번호를 SASLprep 으로 정규화한 뒤 해시한다. 출력 가능한 ASCII 는 SASLprep 이 바꾸지 않으므로
  //  그 범위만 받는다 — 밖의 문자를 정규화 없이 해시하면 서버가 기대하는 값과 갈려 로그인이 깨진다.
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error("SCRAM verifier 는 공백 없는 출력 가능 ASCII 비밀번호만 만든다");
  const salt = opts.salt ?? crypto.randomBytes(16);
  const iterations = opts.iterations ?? 4096;
  const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = crypto.createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = crypto.createHash("sha256").update(clientKey).digest();
  const serverKey = crypto.createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

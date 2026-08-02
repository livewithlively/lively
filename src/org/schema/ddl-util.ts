// DDL 반복 패턴 3헬퍼(#1313 R19a) — org/schema.ts·v6/schema.ts 에서 30+회 반복되던 멱등 idiom 을 접는다.
//  ⚠ ensureCheck/redefineCheck 는 **SQL 텍스트 생성기**다(실행 아님) — 호출부 템플릿 리터럴에 끼워,
//   기존 쿼리 배치(한 pool.query 에 여러 문장)를 그대로 유지한다. '치환 전후 실행 SQL 시퀀스 동일'이
//   이 파일의 계약이고 scripts/schema-init.itest.mjs 의 SCHEMA_SQL_LOG 스냅샷 diff 0 으로 증명했다 —
//   여기 출력 형태(토큰 순서)를 바꾸면 그 증명을 다시 떠라(공백·개행은 정규화되므로 자유).
//  ⚠ 식별자(table/name)·식(expr)은 코드 상수만 — 사용자 입력 금지(이스케이프 없음, DDL 은 파라미터 불가).
export function ensureCheck(table: string, checks: Record<string, string>): string {
  // pg_constraint 프로브형: 제약이 '없을 때만' ADD — 이미 있으면 그대로 둔다(라이브 제약 불변).
  //  enum 확장 등 기존 제약을 '바꿔야' 하면 redefineCheck 를 써라(프로브형으론 라이브 제약이 안 바뀐다).
  const body = Object.entries(checks).map(([name, expr]) =>
    `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='${table}'::regclass AND conname='${name}') THEN
        ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr});
      END IF;`).join("\n      ");
  return `DO $$ BEGIN
      ${body}
    END $$;`;
}

export function redefineCheck(table: string, name: string, expr: string): string {
  // DROP+ADD형: CHECK 허용값 확장/변경용(프로브형과 의도 구분 — IF NOT EXISTS 만으론 라이브 제약이 안 바뀜). 멱등.
  //  ⚠ 기존 행이 새 expr 를 어기면 ADD 가 throw 해 부팅이 중단된다 — 확장은 안전, 축소는 선행 데이터 정규화 필수.
  return `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name};
    ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr});`;
}

export async function softUniqueIndex(
  pool: { query(sql: string): Promise<unknown> },
  createIndexSql: string,
  warnLabel: string,
): Promise<void> {
  // .catch 보류형: 기존 중복 데이터로 유니크 생성이 실패하면 **비치명적**으로 보류(경고만) — 중복 정리 후
  //  다음 부팅에 자동 적용, 그 사이 신규 중복은 앱 검증이 막는다(org_member_email idiom). SQL 은 그대로 실행.
  await pool.query(createIndexSql).catch((e) => { console.warn(`${warnLabel}:`, (e as Error)?.message); });
}

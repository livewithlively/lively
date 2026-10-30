// child-env 의 계약 타입 — 순수 조립부가 DB·바인딩 모듈을 import 하지 않도록 분리한다(테스트 가능 유지).

/** 부모 프로세스의 테넌트 바인딩 상태(조립에 필요한 최소 정보). */
export interface TenantBinding {
  /** 바인딩이 켜져 있나(꺼진 자가호스팅 단일 워크스페이스면 false). */
  active: boolean;
  /** 부모가 쿼리에 걸 바로 그 테넌트 id. 없거나 형식이 틀리면 자식에 바인딩을 넘기지 않는다. */
  tenantId: string | null;
}

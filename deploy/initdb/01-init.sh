#!/bin/bash
# pgvector(items) 컨테이너 최초 init 시 1회 실행(데이터 볼륨이 비어있을 때만).
#  · domainmap DB 생성 — 옛 배치의 별 DB. 지금 게이트웨이는 쓰지 않는다(도메인맵 테이블은 items DB 로 병합, DOMAINMAP_DATABASE_URL
#    도 더 안 읽는다). 빈 DB 하나라 무해하고, 이 스크립트·마운트를 빼면 items-db 정의가 바뀌어 기존 박스에서 재생성되므로 둔다.
#  · items DB(POSTGRES_DB)의 테이블·vector 확장은 게이트웨이가 부팅 시 자가 마이그레이션(소유자=POSTGRES_USER 라 가능).
#  · db_query 용 고객 제품 DB(DATABASE_URL)는 여기서 안 만든다 — 웹UI(org_db_source)로 나중에 등록(읽기전용 리플리카).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE DATABASE domainmap OWNER \"$POSTGRES_USER\";"
echo "[initdb] domainmap database created (owner=$POSTGRES_USER)"

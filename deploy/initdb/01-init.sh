#!/bin/bash
# pgvector(items) 컨테이너 최초 init 시 1회 실행(데이터 볼륨이 비어있을 때만).
#  · domainmap DB 생성 — 게이트웨이 DOMAINMAP_DATABASE_URL 이 붙는 별 DB.
#  · items DB(POSTGRES_DB)의 테이블·vector 확장은 게이트웨이가 부팅 시 자가 마이그레이션(소유자=POSTGRES_USER 라 가능).
#  · db_query 용 고객 제품 DB(DATABASE_URL)는 여기서 안 만든다 — 웹UI(org_db_source)로 나중에 등록(읽기전용 리플리카).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE DATABASE domainmap OWNER \"$POSTGRES_USER\";"
echo "[initdb] domainmap database created (owner=$POSTGRES_USER)"

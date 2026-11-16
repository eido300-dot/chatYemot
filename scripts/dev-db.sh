#!/usr/bin/env bash
set -euo pipefail
cd /workspace/chatYemot
if [ ! -f .env ]; then
  umask 077
  DB_DEV_PASSWORD=$(openssl rand -hex 24)
  cp .env.example .env
  sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=$DB_DEV_PASSWORD/" .env
fi
# This helper only reads known local DB fields; never source arbitrary .env files.
DB_DEV_PASSWORD=$(sed -n 's/^DB_PASSWORD=//p' .env)
if [ -z "$DB_DEV_PASSWORD" ]; then echo 'Set DB_PASSWORD securely in .env'; exit 1; fi
for DB_KIND in dev test; do
  DB_CONTAINER=chatyemot-db; DB_LOCAL_PORT=3306; DB_LOCAL_NAME=chatyemot
  if [ "$DB_KIND" = test ]; then DB_CONTAINER=chatyemot-test-db; DB_LOCAL_PORT=3307; DB_LOCAL_NAME=chatyemot_test; fi
  if docker container inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    docker start "$DB_CONTAINER" >/dev/null
  else
    export MARIADB_RANDOM_ROOT_PASSWORD=1 MARIADB_DATABASE="$DB_LOCAL_NAME" MARIADB_USER=chatyemot MARIADB_PASSWORD="$DB_DEV_PASSWORD"
    docker run -d --name "$DB_CONTAINER" -p "127.0.0.1:$DB_LOCAL_PORT:3306" -v "$DB_CONTAINER:/var/lib/mysql" -e MARIADB_RANDOM_ROOT_PASSWORD -e MARIADB_DATABASE -e MARIADB_USER -e MARIADB_PASSWORD mariadb:11.4 >/dev/null
    unset MARIADB_PASSWORD
  fi
  DB_READY=false
  for DB_TRY in {1..40}; do
    if docker exec "$DB_CONTAINER" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then DB_READY=true; break; fi
    sleep 1
  done
  if [ "$DB_READY" != true ]; then echo "$DB_CONTAINER did not become ready"; exit 1; fi
  echo "$DB_CONTAINER ready"
done

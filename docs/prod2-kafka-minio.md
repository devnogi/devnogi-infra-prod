# prod2 Kafka·MinIO 전환

이 문서는 prod1의 테스트 Kafka·MinIO 데이터를 복사하지 않고 prod2에 새 클러스터와 새 오브젝트 저장소를 만드는 승인된 전환 절차다. DB에 남은 기존 테스트 이미지 URL은 수정하지 않는다. prod1 컨테이너는 전환 완료 직후 정지하지만 데이터 디렉터리는 7일 동안 보존한다.

## 배포 전 준비

1. prod1에서 실행 중인 Kafka와 Kafka UI의 단일 `RepoDigest`, MinIO의 실행 image ID를 기록한다. Kafka 계열은 `repository@sha256:...`, MinIO는 `sha256:...` 형식으로 각각 `KAFKA_IMAGE`, `KAFKA_UI_IMAGE`, `MINIO_IMAGE`에 설정한다. `latest`나 tag-only 값은 사용하지 않는다.
2. legacy `minio/minio` 이미지를 현재 registry의 다른 제품으로 대체하거나 업그레이드하지 않는다. prod1에서 정확한 실행 이미지를 `docker image save`로 root 전용 archive에 내보내고 SHA-256 checksum을 만든다. archive와 checksum을 승인된 SSH 경로로 prod2에 전송하고 checksum 확인 후 `docker image load`한다. `docker save`/`load`는 registry digest reference를 보존하지 않으므로 prod2에서 로드된 image ID가 prod1 기록과 정확히 같은지 확인하고 `MINIO_IMAGE=sha256:<검증한-image-id>`로 고정한다. 이미지 안에서 `mc --version`과 `mc ready --help`가 모두 성공하는지 확인한 뒤에만 Compose를 실행한다. Compose healthcheck는 이미지에 포함된 `mc ready`를 사용하므로 이 조건이 충족되지 않으면 배포를 중단하고 임의로 curl 기반 probe로 바꾸지 않는다. archive는 staging mode 0700 아래에서 다루고 검증 완료 후 정확한 파일만 삭제한다.
3. `minio-init`도 동일한 `MINIO_IMAGE`에 포함된 `/usr/bin/mc`를 사용한다. 별도 client 이미지나 AIStor 이미지를 추가하지 않는다. root secret은 `MC_HOST_*` 환경으로만 전달하고, 애플리케이션 access/secret 쌍은 표준입력으로 `mc admin user add`에 전달해 실제 secret이 프로세스 인자나 로그에 나타나지 않게 한다. root와 애플리케이션 secret은 URI 구분자가 없는 URL-safe 값으로 생성한다. 격리 환경에서 같은 server digest를 기동해 `mc --version`, `MC_HOST_*` 연결, 표준입력 user add, bucket 생성, policy overwrite, 기존 사용자 secret 갱신, policy 재attach를 포함한 init 전체를 두 번 연속 실행하고 두 번째 실행도 성공하는지 확인한다.
4. 새 KRaft cluster ID를 생성해 `KAFKA_CLUSTER_ID`에 저장한다. prod1 cluster ID는 재사용하지 않는다.
5. 새 MinIO root, Auth, Community 자격증명과 Kafka UI 로그인 정보를 생성한다. 실제 값은 저장소, 명령행, 로그에 남기지 않고 `devnogi-infra-prod`의 repository Actions secret `PROD2_ENV_FILE`에 설정한다. 배포 workflow는 `production` environment에서 실행되지만 현재 이 secret은 environment-level이 아니라 repository-level로 관리된다.
6. `/opt/kafka/data`와 `/opt/infra/minio-data`가 비어 있는 새 경로인지 확인한다. pinned 이미지의 실제 실행 UID/GID가 쓸 수 있도록 디렉터리 소유권을 설정한다. MySQL `/opt/mysql/data`와 Redis `/opt/infra/redis-data`는 변경하지 않는다.
7. prod2의 `infra_devnogi-network`에 Auth, Community, Batch가 모두 연결되어 있는지 확인한다.

필수 prod2 값은 다음 계약을 따른다.

- Kafka: `KAFKA_IMAGE`, `KAFKA_CLUSTER_ID`
- Kafka UI: `KAFKA_UI_IMAGE`, `KAFKA_UI_PORT=9112`, timezone/locale/JVM/login 값
- MinIO: exact local image ID 형식의 `MINIO_IMAGE=sha256:...`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_SERVER_URL=https://storage.memonogi.com`, `MINIO_BROWSER_REDIRECT_URL=http://localhost:9000`
- Auth MinIO: `AUTH_MINIO_ACCESS_KEY`, `AUTH_MINIO_SECRET_KEY`, `AUTH_MINIO_BUCKET=auth-profile`
- Community MinIO: `COMMUNITY_MINIO_ACCESS_KEY`, `COMMUNITY_MINIO_SECRET_KEY`, `COMMUNITY_MINIO_BUCKET=memonogi-community-bucket`. `community-media-rw` 정책은 Java MinIO SDK가 객체 작업 전에 수행하는 bucket region 조회를 위해 bucket 리소스에 `s3:GetBucketLocation`과 `s3:ListBucket`을 허용한다.

## 인프라 배포 검증

운영 배포기는 기존 MySQL, Redis, autoheal의 image, mount, network, port를 먼저 검증하고 승인된 신규 persistent 서비스만 추가한다. Kafka와 MinIO가 healthy가 된 뒤 bootstrap profile의 init 서비스를 각각 실행하고 종료 코드 0을 확인한다. init 컨테이너는 상시 서비스 집합에 포함하거나 재시작하지 않는다. 같은 init을 다시 실행해도 성공해야 한다.

기존 MinIO 사용자 정책만 변경한 경우 main 배포가 완료된 뒤 `Reconcile prod2 MinIO policy` workflow를 main에서 수동 실행한다. 이 workflow는 배포된 revision과 Compose의 정책 계약을 확인하고 prod2 배포 lock을 획득한 뒤 `minio-init`만 반복 실행한다. 새 정책을 사용하는 애플리케이션의 실제 SDK probe가 성공하기 전에는 복구 완료로 판단하지 않는다.

reconcile이 실패하면 원격 출력은 `/opt/infra/.minio-reconcile-failures/<40자리 revision>-<run id>-<attempt>.log`에 mode `0600`으로 보존되고 workflow는 정확한 경로만 출력한다. 원인을 확인한 뒤 경로 형식을 다시 검증하고 해당 파일 하나만 삭제한다. 상위 디렉터리 전체나 glob을 사용해 삭제하지 않는다.

```sh
docker compose --project-directory /opt/infra --env-file /opt/infra/.env.infra2 -f /opt/infra/docker-compose-prod2.yml --profile bootstrap run --rm kafka-init
docker compose --project-directory /opt/infra --env-file /opt/infra/.env.infra2 -f /opt/infra/docker-compose-prod2.yml --profile bootstrap run --rm minio-init
```

성공 후 다음을 확인한다.

```sh
docker compose --project-directory /opt/infra --env-file /opt/infra/.env.infra2 -f /opt/infra/docker-compose-prod2.yml ps --all
docker exec kafka kafka-topics --bootstrap-server kafka:29092 --list
docker exec kafka kafka-metadata-quorum --bootstrap-server kafka:29092 describe --status
curl --fail --silent http://127.0.0.1:9001/minio/health/ready
curl --fail --silent http://127.0.0.1:9112/actuator/health
```

토픽은 `USER_INFO_UPDATE_EVENT`, `USER_VERIFICATION_VERIFY_EVENT`, `USER_INFO_UPDATE_EVENT.DLT`만 생성되어야 한다. `minio-init`은 `auth-profile`과 `memonogi-community-bucket`을 만들고 Auth 버킷만 익명 download를 허용한다. 실제 자격증명이나 policy JSON을 진단 로그에 출력하지 않는다.

## storage.memonogi.com 전환

현재 prod2 origin 인증서는 `memonogi.com`과 `www.memonogi.com`만 포함하고 `storage.memonogi.com`을 포함하지 않는다. 이 인증서를 storage vhost에 재사용하지 않는다. 승인된 zone-scoped DNS-01 절차로 `storage.memonogi.com` 단독 또는 해당 이름을 포함하는 wildcard 공개 CA 인증서를 먼저 발급한다. 토큰과 private key는 root 전용으로 보관하고 저장소·명령행·로그에 남기지 않는다. 일반 클라이언트와 Cloudflare Full (strict)가 모두 검증할 수 있는 인증서가 준비되지 않으면 Nginx 설치와 DNS 전환을 중단한다.

발급 후 `/etc/nginx/snippets/memonogi-storage-tls.conf`를 root 전용으로 준비한다. `ssl_certificate`와 `ssl_certificate_key`에는 새 인증서 경로를 정확히 한 개씩 선언하고 기존 TLS 정책을 함께 둔다. `openssl x509 -in <certificate> -noout -checkhost storage.memonogi.com`이 성공하는지 확인한다. 적용 전에 현재 `nginx -T`, vhost, 인증서 참조를 root 전용 백업에 기록한다. 설치기도 같은 SAN 검사를 수행하며 실패하면 파일을 변경하지 않는다.

승인 후 stable ops package에서 다음을 실행한다.

```sh
sudo sh /opt/infra/incoming2/ops/prod2/nginx/install-storage-minio.sh
```

설치기는 기존 Nginx 구성이 유효한지 먼저 확인하고, 이전 storage vhost를 timestamp backup에 보존한다. 후보를 live include glob 밖에서 별도 Nginx main config로 먼저 검증한 뒤 같은 filesystem의 임시 파일을 원자적으로 rename한다. 적용 후 전체 `nginx -t`, reload 또는 signal 처리 중 실패하면 이전 vhost를 복구하고 다시 검증·reload한다. 출력된 정확한 backup 경로를 전환 기록에 남긴다.

DNS 변경 전 prod2 origin을 직접 검증한다.

```sh
curl --resolve storage.memonogi.com:443:220.127.88.196 \
  https://storage.memonogi.com/minio/health/ready
```

인증서 검증을 우회하지 않는다. 잘못된 기존 인증서로 `curl -k` 테스트만 통과시키는 것은 배포 완료로 인정하지 않는다. 임시 Auth·Community 자격증명으로 각 버킷의 upload/read/delete와 브라우저 URL을 검증한 뒤 Cloudflare의 기존 `storage.memonogi.com` record 원본만 prod2로 바꾼다. hostname과 프록시/TLS 정책은 유지한다.

## 애플리케이션 전환

서버의 기존 `.env.prod`를 먼저 백업하고, 각 저장소의 현재 production workflow가 실제로 참조하는 secret 계약을 갱신한다. Auth는 전체 파일형 `AUTH_SERVER_ENV`, Community는 개별 `PROD_MINIO_*`·`PROD_KAFKA_*`, Batch는 공유 `spring-prod` workflow의 `batch` profile에 상속되는 production secret을 사용한다. 존재하지 않는 공통 `PROD2_ENV_FILE`을 가정하지 않는다. 다음 애플리케이션 값만 변경한다.

- Auth: `KAFKA_BOOTSTRAP_SERVERS=kafka:29092`, `MINIO_ENDPOINT=https://storage.memonogi.com`, 새 Auth access/secret, `S3_BUCKET=auth-profile`
- Community: `KAFKA_BOOTSTRAP_SERVERS=kafka:29092`, 같은 공개 MinIO endpoint, 새 Community access/secret, 기존 bucket 이름
- Batch: `KAFKA_BOOTSTRAP_SERVERS=kafka:29092`

Auth와 Batch를 먼저 중지하고 Community를 재배포한다. Community consumer group 할당을 확인한 다음 Auth, Batch 순서로 재배포한다. 회원가입과 Community projection, verification event, 두 서비스의 이미지 upload/read/delete를 확인한다. Gateway와 React 환경은 변경하지 않는다.

## 복구와 prod1 종료

- 애플리케이션 실패: 백업한 환경 값으로 Community, Auth, Batch를 재배포한다.
- Kafka 실패: prod1 Kafka를 재기동하고 이전 bootstrap 주소를 복구한다.
- MinIO/Nginx 실패: 설치기가 출력한 backup의 `previous-state`를 확인해 정확한 vhost를 복구하고 `nginx -t` 후 reload한다. Cloudflare 원본도 prod1으로 되돌린다.
- prod2 Compose 실패: 배포기의 이전 Compose/env rollback을 사용한다. volume을 삭제하거나 `down -v`를 실행하지 않는다.

모든 검증이 성공한 뒤 prod1 Kafka, Kafka UI, MinIO를 정지하고 관련 listener를 닫는다. `/opt/kafka/data`와 `/opt/infra/minio-data`는 7일 동안 변경 없이 보존한다. 7일 동안 오류와 복구가 없을 때 별도 prod1 제거 PR과 승인된 운영 절차로 컨테이너, workflow, secret, 네트워크 규칙, 데이터 디렉터리를 제거한다.

# devnogi-infra-prod

Kafka·MinIO·MySQL·Redis의 운영 Compose와 로컬 개발용 의존 서비스를 관리하는 독립 저장소입니다. 애플리케이션 코드는 포함하지 않습니다.

prod2 애플리케이션 로그, 일일 MySQL 백업 및 암호화된 Google Drive 보관의 설치·복구 절차는 [운영 가이드](ops/prod2/README.md)를 확인합니다. 실제 운영 적용은 별도 승인이 필요합니다.

공인 TLS, origin 접근 경계 및 요청 제한의 수동 적용·검증·복구 절차는 [origin 운영 가이드](ops/prod2/nginx/README.md)를 따릅니다.

## 표준 검증

Node.js 20 이상, Bash(Windows는 Git for Windows), Docker Compose v2를 준비하고 실행합니다. 설정 검사에는 Docker 데몬이나 운영 비밀값이 필요하지 않습니다.

```sh
node scripts/verify.mjs
```

사용법과 준비 조건은 Docker 설치 없이 확인할 수 있습니다.

```sh
node scripts/verify.mjs --help
node --test tests/verify.test.mjs
```

도움말은 종료 코드 0으로 끝나며 테스트·Docker를 호출하거나 환경 fixture를 읽지 않습니다. 알 수 없는 인수 또는 `--help extra` 같은 조합은 오류와 도움말 안내를 출력하고 종료 코드 2로 끝납니다. CLI 테스트는 실제 컨테이너나 운영 비밀값을 사용하지 않습니다. PR의 `verify`도 이 테스트 후 표준 검증을 실행합니다.

표준 검증은 먼저 `tests/bootstrap-local-auth.test.mjs`에서 실제 bootstrap 스크립트를 가짜 MySQL 명령으로 실행해 허용된 SQL, 잘못된 계정, 실패 처리와 비밀값 미출력을 검사합니다. 이어서 로컬·운영 Compose 3개를 임시 디렉터리와 `tests/compose.env`의 가짜 값으로 검사합니다. 기존 `.env`를 수정하지 않고 컨테이너도 실행하지 않습니다. 이 검사는 서비스 기동·실제 DB 통합 테스트를 대체하지 않습니다.

## 로컬 의존 서비스

Docker 엔진이 실행 중이어야 합니다. 아래 명령은 이 저장소 폴더에서 실행합니다. 샘플 값은 로컬 개발 전용입니다.

```sh
docker compose --project-name devnogi-local-infra -f compose.local.yml --env-file .env.example config --quiet
docker compose --project-name devnogi-local-infra -f compose.local.yml --env-file .env.example up -d
docker compose --project-name devnogi-local-infra -f compose.local.yml --env-file .env.example ps
```

| 서비스 | 호스트 연결 주소 | 용도 |
| --- | --- | --- |
| MySQL | `localhost:3316` | `devnogi`와 인증용 `auth` 개발 DB, 사용자·암호는 `.env.example` |
| Redis | `localhost:6389` | 로컬 캐시·인증 상태 |
| Kafka | `localhost:9102` | 호스트에서 실행하는 애플리케이션용 브로커 |
| MinIO | `http://localhost:9001` | 오브젝트 API |
| MinIO Console | `http://localhost:9000` | 로컬 파일 저장소 관리 |

포트는 loopback에만 공개하고 데이터는 이름 있는 Docker volume에 보관합니다. 운영 `/opt` 디렉터리나 Docker socket을 연결하지 않습니다. 기본 네트워크 이름은 `memonogi-local`입니다. 다른 서비스의 Compose override가 이 외부 네트워크에 참여하면 Kafka는 `devnogi-local-kafka:29092`, MySQL은 `devnogi-local-mysql:3306`으로 접근합니다. Kafka의 내부 advertised listener도 같은 별칭을 반환합니다. 호스트용 `localhost:9102`를 다른 컨테이너의 주소로 복사하지 마세요.

서비스들의 Redis·MinIO와 포트 충돌 없이 공통 MySQL·Kafka만 준비할 때는 다음 명령을 사용합니다. 서비스별 네트워크 override와 DB 이름·계정·초기화는 공동 루트의 Docker 안내와 해당 서비스 문서를 함께 확인하세요.

```sh
docker compose --project-name devnogi-local-infra -f compose.local.yml --env-file .env.example up -d mysql kafka
```

종료는 `docker compose --project-name devnogi-local-infra -f compose.local.yml --env-file .env.example down`입니다. 데이터 볼륨은 유지합니다. 기존 서비스의 전용 DB Compose와 동시에 실행하면 포트가 충돌할 수 있어 필요한 쪽만 실행하세요. MinIO 버킷은 각 서비스 설정에 맞게 준비해야 합니다.

### 로컬 인증 DB 준비

`docker/local/mysql/20-auth-schema.sh`는 기존 애플리케이션 계정에 `auth.*` 권한을 추가합니다. `devnogi` DB와 기존 데이터·권한·암호를 변경하지 않습니다. 인증 서비스는 `DB_SCHEMA=auth`로 설정하고 공통 MySQL의 `DB_USER`·`DB_PASSWORD`를 사용합니다. 기존 `devnogi` 사용 서비스는 DB 이름을 유지합니다. 애플리케이션 테이블은 인증 서비스의 Flyway가 관리합니다.

**새 데이터 볼륨:** 위 MySQL 기동 명령만 실행하면 됩니다. MySQL 이미지가 `devnogi` DB와 애플리케이션 계정을 만든 다음 읽기 전용으로 연결된 초기화 스크립트를 실행합니다. `auth` DB 생성과 권한 부여가 완료되면 로그에 `Local auth schema and existing app-user grant are ready.`가 표시됩니다.

**기존 데이터 볼륨:** MySQL 이미지의 초기화 스크립트는 빈 데이터 디렉터리에만 자동 적용됩니다. 아래 명령으로 변경된 로컬 설정을 반영하고 스크립트를 명시적으로 실행하세요. 볼륨이나 컨테이너 데이터를 삭제할 필요가 없고 반복 실행할 수 있습니다.

```sh
docker compose --project-name devnogi-local-infra -f compose.local.yml --env-file .env.example up -d mysql
docker compose --project-name devnogi-local-infra -f compose.local.yml --env-file .env.example exec -T mysql sh /docker-entrypoint-initdb.d/20-auth-schema.sh
```

기존 볼륨을 만들 때 별도 환경 파일이나 프로젝트 이름을 사용했다면 두 명령 모두 **그 로컬 환경 파일과 프로젝트 이름**을 명시하세요. 계정·암호는 최초 생성 당시 값과 일치해야 합니다. 환경 변수 값을 바꾸는 것만으로 기존 MySQL 암호가 변경되지는 않습니다. MySQL 시작이 완료되기 전에 실행해 연결 오류가 나면 준비 상태를 확인한 뒤 같은 명령을 다시 실행하면 됩니다.

`DB_USER`는 영문·숫자·밑줄로 된 1~32자이며 `root`가 아닌 계정이어야 합니다. 해당 계정의 `%` 호스트 항목이 이미 있어야 하며, 없으면 계정이나 암호를 새로 만들지 않고 실패합니다. 스크립트는 로컬 Compose가 지정한 `DEVNOGI_LOCAL_BOOTSTRAP=1`을 확인하고 해당 컨테이너의 MySQL 소켓만 사용합니다. 운영 Compose에는 스크립트나 이 설정을 연결하지 않습니다.

## PR와 운영 배포

prod2의 호스트 로그 설정을 수동 적용하거나 확인할 때는 [prod2 로그 설정](docs/prod2-logging.md)을 따릅니다.

PR은 `verify`와 `secret-scan`을 실행합니다. 현재 GitHub Ruleset은 PR과 두 검사를 필수로 요구하며, 필수 승인 수는 0명입니다. PR 작성자가 다른 사람의 Approve 없이 병합할 수 있어도 필수 CI와 대화 해결 조건은 충족해야 합니다. 설정 파일만 추가했다고 서버 보호가 활성화된 것은 아닙니다. `node scripts/secret-scan.mjs`는 현재 파일의 기본 비밀값 패턴을 검사하고 값은 출력하지 않습니다. Git 이력 검사나 자격 증명 교체를 대신하지 않습니다.

운영 배포는 `main` push에서 자동 실행되며 복구 시 `main`에서 수동 실행할 수 있습니다. GitHub의 `production` environment는 `main`만 허용합니다. 두 운영 Compose는 실제 운영 데이터와 자격 증명을 사용하므로 로컬에서 실행하지 않습니다. 배포 실패 시 이전 Compose로 복구하며 volume은 삭제하지 않습니다.

각 서버의 검증된 Ed25519 SSH 공개키 지문을 `PROD1_HOST_FINGERPRINT`, `PROD2_HOST_FINGERPRINT` secret에 설정해야 합니다. 두 서버의 파일 전송과 원격 실행은 모두 runner의 native OpenSSH를 사용하며, Ed25519 host key를 다시 수집해 저장된 fingerprint와 일치할 때만 진행합니다. `StrictHostKeyChecking=yes`, 전용 `known_hosts`, `HostKeyAlgorithms=ssh-ed25519`와 `IdentitiesOnly=yes`를 강제합니다. fingerprint mismatch가 발생하면 검증을 우회하거나 재실행하지 말고 별도 신뢰 경로로 현재 서버 지문을 확인합니다.

전송 단계만 최대 세 번 제한적으로 재시도하며, 입력은 commit SHA와 workflow run ID별 staging 디렉터리에 격리한 뒤 읽기 전용으로 고정합니다. 원격 rollout은 SSH 세션과 분리된 host-owned 프로세스로 실행하므로 runner/SSH가 끊겨도 계속 진행합니다. commit-ready를 받은 watchdog은 ACK 후에도 살아 있고, rollout이 lock을 닫아 `SUCCESS`를 기록한 뒤 lock을 직접 획득해 terminal result를 확인하고 `finished`를 기록합니다. ACK 이후 `SUCCESS` 전에 rollout이 사라지면 watchdog이 lock을 획득해 전체 이전 상태를 복구합니다. runner는 `result`와 `finished`가 모두 확인된 경우에만 성공 staging을 정리합니다. 완료되지 않은 다른 rollout이 lock을 보유하면 새 배포는 변경 전에 중단됩니다.

기존 컨테이너가 healthcheck를 제공하면 반드시 `healthy`여야 하고 후보도 healthcheck를 유지해 `healthy`가 되어야 합니다. 기존 Compose에 healthcheck가 없는 최초 전환은 컨테이너가 `running`일 때만 허용합니다. 변경 전에는 현재 Compose가 실제 mount/network, HostIp/HostPort, healthcheck readiness를 서비스별로 정확히 재현하는지 먼저 확인하며 drift가 있으면 컨테이너를 변경하지 않습니다. 롤백은 배포 전 기록한 서비스별 readiness(`healthy` 또는 healthcheck 없는 `running`)를 그대로 검증합니다. 후보의 서비스별 image 매핑과 실제 mount/network가 기존 실행 상태와 다르거나, 현재 서비스별 실행 이미지가 정확히 하나의 RepoDigest로 확인되지 않으면 변경 전에 배포를 중단합니다. prod2의 모든 published port 후보는 `127.0.0.1` binding이어야 하며 배포 후 실제 HostIp/HostPort가 후보와 정확히 같아야 합니다. 롤백은 배포 전에 기록한 HostIp/HostPort를 정확히 복구합니다. 포트 변경은 허용하지만 이미지 변경은 별도 digest 승격 절차가 필요합니다.

현재 Compose의 `0.0.0.0` wildcard는 변경 전 재현 검사에서만 Docker가 같은 port를 `0.0.0.0`과 `::` 두 binding으로 확장한 경우와 동등하게 봅니다. 단독 IPv6, custom 주소, target/protocol/HostPort 불일치는 거부하며 후보 배포 후와 롤백 검증은 정규화하지 않습니다. Compose healthcheck는 `configured`, `disabled`, `absent`를 구분합니다. Container/image의 `Config.Healthcheck.Test`가 `NONE`, `null`, empty이면 inactive `running`으로 보고, 유효한 `CMD` 또는 `CMD-SHELL`만 active `healthy`로 인정합니다. 알 수 없거나 잘못된 metadata는 배포를 중단합니다. `absent`는 정확히 pin된 동일 image의 active Dockerfile healthcheck metadata가 확인될 때만 기존 `healthy` 상태를 재현한다고 판단하며, 명시적 disable·제거 또는 image 매핑 변경은 거부합니다.

prod2 운영 패키지는 성공 후보에서 임시 디렉터리를 거쳐 `/opt/infra/incoming2/ops/prod2`로 원자적으로 교체합니다. 최종 완료 전 오류나 watchdog rollback이 발생하면 배포 전에 snapshot한 stable ops를 복구하거나 이전에 경로가 없었던 경우 제거합니다. 성공한 staging은 owner 쓰기·탐색 권한을 복원한 뒤 삭제를 검증하므로 환경 secret을 남기지 않습니다. 실패하거나 결과를 확인하지 못한 staging은 mode `0700` 아래 진단용으로 보존합니다. 진단 후에는 정확한 경로가 `/opt/infra/.deploy-staging/prod<server>-<40자리-sha>-<run-id>-<attempt>` 형식인지 확인하고 `chmod -R u+rwX '<정확한-stage-경로>' && rm -rf -- '<정확한-stage-경로>'`로 개별 삭제합니다. glob이나 `.deploy-staging` 상위 디렉터리 전체 삭제는 사용하지 않습니다.

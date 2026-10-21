# devnogi-infra-prod

Kafka·MinIO·MySQL·Redis의 운영 Compose와 로컬 개발용 의존 서비스를 관리하는 독립 저장소입니다. 애플리케이션 코드는 포함하지 않습니다.

## 표준 검증

Node.js 20 이상과 Docker Compose v2를 준비하고 실행합니다. 설정 검사에는 Docker 데몬이나 운영 비밀값이 필요하지 않습니다.

```sh
node scripts/verify.mjs
```

사용법과 준비 조건은 Docker 설치 없이 확인할 수 있습니다.

```sh
node scripts/verify.mjs --help
node --test tests/verify.test.mjs
```

도움말은 종료 코드 0으로 끝나며 Docker를 호출하거나 환경 fixture를 읽지 않습니다. 알 수 없는 인수 또는 `--help extra` 같은 조합은 오류와 도움말 안내를 출력하고 종료 코드 2로 끝납니다. CLI 테스트는 실제 컨테이너나 운영 비밀값을 사용하지 않습니다. PR의 `verify`도 이 테스트 후 아래 Compose 검사를 실행합니다.

로컬·운영 Compose 3개를 임시 디렉터리와 `tests/compose.env`의 가짜 값으로 검사합니다. 기존 `.env`를 수정하지 않고 컨테이너도 실행하지 않습니다. 이 검사는 YAML·Compose 설정 검증이며 서비스 기동·통합 테스트를 대체하지 않습니다.

## 로컬 의존 서비스

Docker 엔진이 실행 중이어야 합니다. 아래 명령은 이 저장소 폴더에서 실행합니다. 샘플 값은 로컬 개발 전용입니다.

```sh
docker compose -f compose.local.yml --env-file .env.example config --quiet
docker compose -f compose.local.yml --env-file .env.example up -d
docker compose -f compose.local.yml --env-file .env.example ps
```

| 서비스 | 호스트 연결 주소 | 용도 |
| --- | --- | --- |
| MySQL | `localhost:3316` | `devnogi` 개발 DB, 사용자·암호는 `.env.example` |
| Redis | `localhost:6389` | 로컬 캐시·인증 상태 |
| Kafka | `localhost:9102` | 호스트에서 실행하는 애플리케이션용 브로커 |
| MinIO | `http://localhost:9001` | 오브젝트 API |
| MinIO Console | `http://localhost:9000` | 로컬 파일 저장소 관리 |

포트는 loopback에만 공개하고 데이터는 이름 있는 Docker volume에 보관합니다. 운영 `/opt` 디렉터리나 Docker socket을 연결하지 않습니다. 기본 네트워크 이름은 `memonogi-local`입니다. 다른 서비스의 Compose override가 이 외부 네트워크에 참여하면 Kafka는 `devnogi-local-kafka:29092`, MySQL은 `devnogi-local-mysql:3306`으로 접근합니다. Kafka의 내부 advertised listener도 같은 별칭을 반환합니다. 호스트용 `localhost:9102`를 다른 컨테이너의 주소로 복사하지 마세요.

서비스들의 Redis·MinIO와 포트 충돌 없이 공통 MySQL·Kafka만 준비할 때는 다음 명령을 사용합니다. 서비스별 네트워크 override와 DB 이름·계정·초기화는 공동 루트의 Docker 안내와 해당 서비스 문서를 함께 확인하세요.

```sh
docker compose -f compose.local.yml --env-file .env.example up -d mysql kafka
```

종료는 `docker compose -f compose.local.yml --env-file .env.example down`입니다. `down -v`는 로컬 데이터를 삭제하므로 초기화가 필요할 때만 사용합니다. 기존 서비스의 전용 DB Compose와 동시에 실행하면 포트가 충돌할 수 있어 필요한 쪽만 실행하세요. 서비스별 DB 이름·계정·스키마와 MinIO 버킷 생성은 각 서비스 설정에 맞게 준비해야 합니다.

## PR와 운영 배포

PR은 `verify`와 `secret-scan`을 실행합니다. 현재 GitHub Ruleset은 PR과 두 검사를 필수로 요구하며, 필수 승인 수는 0명입니다. PR 작성자가 다른 사람의 Approve 없이 병합할 수 있어도 필수 CI와 대화 해결 조건은 충족해야 합니다. 설정 파일만 추가했다고 서버 보호가 활성화된 것은 아닙니다. `node scripts/secret-scan.mjs`는 현재 파일의 기본 비밀값 패턴을 검사하고 값은 출력하지 않습니다. Git 이력 검사나 자격 증명 교체를 대신하지 않습니다.

운영 배포는 `main`에서 `Deploy to On-Premise 1/2`를 수동 실행할 때만 가능하며 별도 사람 승인이 필요합니다. GitHub의 `production` environment에 리뷰어와 배포 브랜치 제한을 설정하세요. 두 운영 Compose는 실제 `/opt` 데이터와 운영 자격 증명을 사용하므로 로컬 실행 안내로 사용하지 않습니다.

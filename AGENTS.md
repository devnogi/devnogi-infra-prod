# 인프라 작업 규칙

- 이 폴더는 독립 Git 저장소다. 수정 전 Git 루트·브랜치·기존 변경을 확인한다.
- 표준 검증은 Node.js 20 이상과 Docker Compose v2를 준비한 뒤 `node scripts/verify.mjs`다. 비밀값 없는 fixture로 Compose 설정만 검사하며 컨테이너를 실행하지 않는다.
- 로컬 실습은 `compose.local.yml`과 `.env.example`만 사용한다. 운영 Compose에는 호스트 경로와 실제 서비스 데이터가 있으므로 로컬에서 실행하지 않는다.
- 운영 파일·계약 변경은 승인된 기획 범위에서 구현하고, 독립 리뷰에 diff·검증 결과·배포 및 복구 순서를 제공한다.
- 실제 `.env`·운영 데이터·키를 commit하거나 출력하지 않는다. 검증 실패와 Docker 미설치 같은 실행 환경 문제를 구분한다.
- 운영 배포는 `main`의 수동 workflow와 `production` environment를 통해 별도 사람 승인 뒤 실행한다. push 또는 PR은 배포 승인으로 해석하지 않는다.

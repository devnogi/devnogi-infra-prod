# 1차 설정 검증

2026-10-21, `codex/ai-workspace-phase1`. commit/push/배포는 수행하지 않았다.

- `node scripts/verify.mjs`: 로컬·운영 Compose 3개 합성 환경의 config 검사 통과. 독립 검토자가 별도 재실행해 통과 확인.
- `node scripts/secret-scan.mjs`: 0건.
- 배포 workflow YAML 구문, 수동 dispatch/main/production 조건 및 `git diff --check` 확인.
- 로컬 공용 네트워크 `memonogi-local`, Kafka 내부 advertised alias `devnogi-local-kafka:29092`, MySQL alias `devnogi-local-mysql:3306`를 backend shared override와 대조.
- 실제 컨테이너 기동·운영 환경·GitHub 보호 규칙은 미검증. `.env.example` 값은 개발 전용이다.

## infra-verify-help v2 로컬 구현 검증

2026-10-21, `feat/infra-verify-help`. 위 1차 설정 당시 기록과 구분한 후속 기능 검증이다.

- 승인 기획: 공동 루트 `docs/features/infra-verify-help.md` v2, SHA-256 `b197dc872d28f4b23a6002acd8b6bd2062de06b501c42363ec9a0fa0efd62f46`. 승인 원문과 최종 리뷰는 공동 루트의 시범 결과 기록에서 관리한다.
- 테스트 우선 commit `d79f0afadde0e515f0386e677700ab87ca3a7eba`의 [PR #4](https://github.com/devnogi/devnogi-infra-prod/pull/4)와 [CI 실행 39557005030](https://github.com/devnogi/devnogi-infra-prod/actions/runs/39557005030)에서 미구현 도움말 회귀 테스트의 `verify` 실패와 `secret-scan` 성공을 확인했다. 리더가 draft 해제, 충돌 없음, base 뒤처짐 없음, 필수 승인 0명과 활성 필수 검사를 함께 조회했고 `mergeStateStatus=BLOCKED`를 기록했다. merge 호출이나 보호 규칙 변경은 하지 않았다.
- `node --test tests/verify.test.mjs`: Windows Node.js 24.22.0에서 11개 통과. Docker 없는 PATH의 실제 CLI, 잘못된 인수 4종, fixture와 사용 가능한 임시 경로 없는 도움말·인수 처리, import 부수 효과 없음, 가짜 실행기의 세 Compose 순서·합성 환경, 두 번째 검사 실패·Docker 실행 오류의 중단과 정리를 검사했다.
- Node.js 20.20.2로 같은 테스트 11개와 `scripts/verify.mjs`를 별도로 실행해 통과했다. Linux Node.js 20의 최종 PR CI 성공은 아직 확인 전이며 이 로컬 결과로 대신하지 않는다.
- `node scripts/verify.mjs --help`: 한국어 사용법과 준비 조건 출력, 종료 코드 0. 인수 없는 `node scripts/verify.mjs`: Docker Compose 5.6.0으로 세 파일의 합성 환경 config 검사 통과.
- `node scripts/secret-scan.mjs`: 0건. `git diff --check` 통과.
- 기존 PR 검증 job의 테스트 실행 단계를 유지했다. 배포 workflow·운영 Compose·제품 계약·GitHub 보호 설정은 변경하지 않았다. 실제 컨테이너 실행·merge·운영 배포는 수행하지 않았다.

이 기록은 구현자의 로컬 검증과 이미 관측된 실패 CI 증거만 포함한다. 독립 리뷰, 수정 후 최종 SHA의 CI, Copilot 의견 판단은 해당 단계가 끝난 뒤 별도로 확인한다.

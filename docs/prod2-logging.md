# prod2 로그 설정

GitHub Actions가 `/opt/infra/incoming2/ops/prod2`에 운영 파일을 전송한 뒤 실행합니다. 이 작업은 로그 설정만 활성화하며 DB 백업·Drive 전송 타이머는 시작하지 않습니다.

## 1. 설정 설치

```sh
cd /opt/infra
test -s incoming2/ops/prod2/install-logging.sh
sudo sh incoming2/ops/prod2/install-logging.sh
```

## 2. rsyslog 적용

```sh
sudo rsyslogd -N1
sudo logrotate -d /etc/logrotate.d/memonogi
sudo systemctl restart rsyslog
sudo systemctl is-active rsyslog
```

## 3. 컨테이너 로그 드라이버 확인

```sh
for name in auth-server devnogi-community-server devnogi-batch-app-prod devnogi-gateway-app-prod nextjs-app-prod; do
  docker inspect --format '{{.Name}} {{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "tag"}}' "$name"
done
```

다섯 컨테이너 모두 `syslog`여야 합니다. Auth가 `json-file`이면 기존 로그를 보존하고 Auth 운영 배포로 컨테이너를 재생성한 뒤 다시 확인합니다.

```sh
capture="/var/log/memonogi/auth/pre-transition-$(date -u +%Y%m%dT%H%M%SZ).log.gz"
sudo bash -o pipefail -c 'umask 077; docker logs --timestamps auth-server 2>&1 | gzip > "$1"' _ "$capture"
sudo gzip -t "$capture"
docker inspect --format '{{.HostConfig.LogConfig.Type}}' auth-server
```

## 4. 파일 생성 확인

`logger` 시험이 아니라 각 실제 서비스에 정상 요청을 한 번 보낸 뒤, 컨테이너 로그와 파일을 함께 확인합니다.

```sh
for name in auth-server devnogi-community-server devnogi-batch-app-prod devnogi-gateway-app-prod nextjs-app-prod; do
  docker logs --since 1m --tail 5 "$name"
done

sudo find /var/log/memonogi -name application.log -type f -printf '%u:%g %m %s %p\n'
sudo tail -n 20 /var/log/memonogi/auth/application.log
sudo tail -n 20 /var/log/memonogi/community/application.log
sudo tail -n 20 /var/log/memonogi/batch/application.log
sudo tail -n 20 /var/log/memonogi/gateway/application.log
sudo tail -n 20 /var/log/memonogi/react/application.log
```

`install-logging.sh`는 Node.js와 rclone을 요구하지 않으며 백업 unit이나 타이머를 설치·시작하지 않습니다. 타이머는 별도 검증과 승인 전까지 활성화하지 않습니다.

```sh
systemctl is-enabled memonogi-db-backup.timer memonogi-drive-upload.timer
```

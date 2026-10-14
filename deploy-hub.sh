#!/bin/sh
# Push the hub to devbox and rebuild it. devbox:~/docker/oneterm/data and .env are never touched.
set -e
cd "$(dirname "$0")"
ssh devbox 'mkdir -p ~/docker/oneterm/data ~/docker/oneterm/src ~/docker/oneterm/web ~/docker/oneterm/hub'
rsync -a src/hub.ts devbox:docker/oneterm/src/
rsync -a web/index.html devbox:docker/oneterm/web/
rsync -a hub/Dockerfile devbox:docker/oneterm/hub/
rsync -a hub/docker-compose.yml devbox:docker/oneterm/
ssh devbox 'cd ~/docker/oneterm && docker compose up -d --build'

#!/bin/sh
# Copy the hub to a server over ssh and rebuild it: ./deploy-hub.sh HOST
# It never touches ~/docker/oneterm/data or .env on the server.
set -e
host=${1:?usage: ./deploy-hub.sh HOST}
cd "$(dirname "$0")"
ssh "$host" 'mkdir -p ~/docker/oneterm/data ~/docker/oneterm/src ~/docker/oneterm/web/fonts ~/docker/oneterm/hub'
rsync -a src/hub.ts "$host":docker/oneterm/src/
rsync -a web/index.html "$host":docker/oneterm/web/
rsync -a --delete web/fonts/ "$host":docker/oneterm/web/fonts/
rsync -a hub/Dockerfile "$host":docker/oneterm/hub/
rsync -a hub/docker-compose.yml "$host":docker/oneterm/
ssh "$host" 'cd ~/docker/oneterm && docker compose up -d --build'

FROM node:24-alpine
WORKDIR /app
COPY src/hub.ts ./src/hub.ts
COPY web/index.html ./web/index.html
COPY web/fonts ./web/fonts
USER node
ENV ONETERM_DATA=/data ONETERM_PORT=7317
EXPOSE 7317
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:7317/healthz || exit 1
CMD ["node", "--no-warnings", "src/hub.ts"]

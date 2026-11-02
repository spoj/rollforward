FROM node:26-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv poppler-utils sqlite3 ca-certificates curl libreoffice-calc-nogui \
    git jq zip unzip fonts-noto-cjk bubblewrap socat \
 && rm -rf /var/lib/apt/lists/*
RUN ln -sf /bin/bash /bin/sh
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY requirements.txt ./
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir -r requirements.txt
COPY . .
COPY demo/snapshot /data
COPY demo/sources /data-sources
# Runs are sandboxes without a systemd scope of their own here; the demo's sources are theirs to read.
ENV RF_HOST=0.0.0.0 RF_SANDBOX_SCOPE= RF_SANDBOX_RO=/data-sources
EXPOSE 8780
CMD ["node", "src/server.ts", "/data", "8780"]

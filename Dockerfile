FROM node:26-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv poppler-utils sqlite3 ca-certificates curl libreoffice-calc-nogui \
    git jq zip unzip fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
RUN ln -sf /bin/bash /bin/sh
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Chromium and its libraries, for the browser that Tool use runs in the server.
RUN node node_modules/playwright/cli.js install --with-deps chromium && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir -r requirements.txt
COPY . .
COPY demo/snapshot /data
COPY demo/sources /data-sources
RUN mkdir -p /root/.pi/agent && echo '{"steeringMode": "all"}' > /root/.pi/agent/settings.json
ENV RF_HOST=0.0.0.0
EXPOSE 8780
CMD ["node", "src/server.ts", "/data", "8780"]

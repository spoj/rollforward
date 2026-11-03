# The server, on the agent image, which is also its runs' userland (RF_AGENT_ROOT=/): build agent/ first, as rollforward-agent.
FROM rollforward-agent
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# Runs are sandboxes without a systemd scope of their own here.
ENV RF_HOST=0.0.0.0 RF_SANDBOX_SCOPE= RF_AGENT_ROOT=/
EXPOSE 8780
CMD ["node", "src/server.ts", "/data", "8780"]

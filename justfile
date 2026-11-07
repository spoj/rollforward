set dotenv-load

# List the recipes
default:
    @just --list

# Install the Node dependencies, the Chromium that the page's tests drive, and the agent image this checkout runs
setup:
    npm install
    npx playwright install chromium
    node scripts/agent.ts

# Serve a data root at http://127.0.0.1:PORT
start root port="8780":
    node src/server.ts '{{root}}' {{port}}

# Run the tests; those of websites too when .env sets RF_BROWSER_URL and RF_BROWSER_KEY
test:
    node --test test/

# Check that the server reaches the browser service with .env's RF_BROWSER_URL and RF_BROWSER_KEY: prints its open sessions
browser-check:
    curl -fsS -H "authorization: Bearer $RF_BROWSER_KEY" "${RF_BROWSER_URL:-http://127.0.0.1:8797}/sessions" && echo

live := "rf-tailnet"
cache := home_directory() / ".cache" / live

# Let EMAIL sign in with Microsoft, as a user or, with role=admin, an admin
invite email role="user":
    rf user add '{{email}}' {{role}}

# Cut EMAIL off: their sessions end and they can no longer sign in
revoke email:
    rf user disable '{{email}}'

# List who can sign in, with their role and last sign-in
people:
    rf people

# Follow the live server's log
logs:
    podman logs -f --tail 50 {{live}}

# Rebuild the live server from the committed main branch and restart it; a run it cuts carries on after the restart
deploy:
    git -C {{cache}}/repo fetch -q {{justfile_directory()}} main
    git -C {{cache}}/repo checkout -q --detach FETCH_HEAD
    podman build -q -t rollforward-agent {{cache}}/repo/agent
    podman build -q -t rollforward-public {{cache}}/repo
    podman rm -f {{live}}
    podman run -d --name {{live}} --init --restart=always --security-opt 'unmask=/proc/*' -p 127.0.0.1:8790:8780 --env-file {{cache}}/env -v {{live}}-data:/data rollforward-public

set dotenv-load

# List the recipes
default:
    @just --list

# Install the Node and Python dependencies
setup:
    npm install
    uv venv --allow-existing .venv
    uv pip install --python .venv/bin/python -r requirements.txt

# Serve a data root at http://127.0.0.1:PORT
start root port="8780":
    node src/server.ts '{{root}}' {{port}}

# Serve a scratch copy of the demo, made on first use; delete /tmp/rf-demo to start over
demo port="8780":
    [ -d /tmp/rf-demo ] || cp -r demo/snapshot /tmp/rf-demo
    node src/server.ts /tmp/rf-demo {{port}}

# Run the tests; those of websites and Windows too when .env sets RF_MACHINES_URL and RF_MACHINES_KEY
test:
    node --test test/

# Check that the server reaches the machines service with .env's RF_MACHINES_URL and RF_MACHINES_KEY: prints its open sessions
machines-check:
    curl -fsS -H "authorization: Bearer $RF_MACHINES_KEY" "${RF_MACHINES_URL:-http://127.0.0.1:8797}/sessions" && echo

live := "rf-tailnet"
cache := home_directory() / ".cache" / live

# Let EMAIL sign in with Microsoft, as a user or, with role=admin, an admin
invite email role="user":
    podman exec {{live}} node src/auth.ts /data add '{{email}}' {{role}}

# Cut EMAIL off: their sessions end and they can no longer sign in
revoke email:
    podman exec {{live}} node src/auth.ts /data disable '{{email}}'

# List who can sign in, with their role and last sign-in
people:
    podman exec {{live}} node src/auth.ts /data list

# Follow the live demo's log
logs:
    podman logs -f --tail 50 {{live}}

# The demo series in the volume read their sources at this repo's demo/run/data-sources.
# Rebuild the live demo from the committed main branch and restart it, moving its data to folders by id the first time;
# a run it cuts carries on after the restart
deploy:
    git -C {{cache}}/repo fetch -q {{justfile_directory()}} main
    git -C {{cache}}/repo checkout -q --detach FETCH_HEAD
    podman build -q -t rollforward-public {{cache}}/repo
    podman rm -f {{live}}
    podman run --rm -v {{live}}-data:/data rollforward-public sh -c 'test -e /data/.rf/tree.json || node scripts/migrate-ids.ts /data'
    podman run -d --name {{live}} --init --restart=always --security-opt 'unmask=/proc/*' -p 127.0.0.1:8790:8780 --env-file {{cache}}/env -e RF_SANDBOX_RO={{justfile_directory()}}/demo/run/data-sources -v {{live}}-data:/data -v {{cache}}/data-sources:{{justfile_directory()}}/demo/run/data-sources rollforward-public

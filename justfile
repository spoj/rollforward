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

# Run the tests
test:
    node --test test/

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
# Rebuild the live demo from the committed main branch and restart it, unless a run is going
deploy:
    git -C {{cache}}/repo fetch -q {{justfile_directory()}} main
    git -C {{cache}}/repo checkout -q --detach FETCH_HEAD
    podman build -q -t rollforward-public {{cache}}/repo
    if podman top {{live}} args 2>/dev/null | grep -q cli.js; then echo 'A run is going; deploy when it ends.'; exit 1; fi
    podman rm -f {{live}}
    podman run -d --name {{live}} --init --restart=always -p 127.0.0.1:8790:8780 --env-file {{cache}}/env -v {{live}}-data:/data -v {{cache}}/data-sources:{{justfile_directory()}}/demo/run/data-sources rollforward-public

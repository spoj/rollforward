#!/bin/bash
set +vx
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C

usage() { cat <<'EOF'
On the designated host only, as root, from the reviewed root-owned copy:
  umask 077
  /bin/bash /root/cutover-v0.8.0.sh --preflight PIN COPY_PARENT AUTH_JSON PULL_PATH
  setsid -f nohup /bin/bash /root/cutover-v0.8.0.sh --execute PIN COPY_PARENT AUTH_JSON PULL_PATH \
    </dev/null >>/root/rf080-cutover.log 2>&1
PIN: approved full SHA of annotated Manual: v0.8.0. Stage both tags/objects offline.
COPY_PARENT: root-controlled, same reflink-enabled filesystem as the data, outside
checkout/data and searchable by UID 8004. Check any applicable quotas separately.
AUTH_JSON: root-owned (0600/0400) existing rf config; admin is fine. Its URL is ignored.
Old/live probes record normal bearer use; admin GETs may read provider credit status.
PULL_PATH: a known small file (≤2 MiB) or directory of small files.
Preflight leaves the unit, updater, and checkout alone. Execute repeats those
checks before draining. Retain the whole stopped original and both credential sources.
Pause other data writers and restart supervisors; choose a quiet window. The old
server still takes requests while draining. The proxy may stay up: verification
serves existing authenticated reads, rejects writes/sign-ins/upgrades with 503,
and starts no work. Stop/boot gaps are unavailable. Warn users of the outage.
Review, then touch activate or abort within 20 minutes; activation need not wait.
Retain the control directory and live permit.
Before granting live permission the script can restore v0.7.9; after that,
reconcile any new work before rolling back. On SIGKILL/reboot inspect the log,
permits, drop-in and both roots before starting anything.
EOF
}
[[ ${1-} != --help ]] || { usage; exit 0; }
[[ $# == 5 && ( $1 == --execute || $1 == --preflight ) && $EUID == 0 ]] || { usage >&2; exit 1; }
readonly operation=$1
readonly uid=8004 checkout=/u01/rollforward/rollforward old=4f5bec04cba66b72af67c35b7fafe47ce4c178a1
readonly unit=rollforward.service updater=rollforward-update.service timer=rollforward-update.timer
readonly pin=$2 parent=$3 auth=$4 pull=$5 runtime=/run/user/$uid base=http://127.0.0.1:8780
stage=preflight; managed=0; old_stop=0; verifying=0; cli_home=; report=
log() { printf '[%ss] %s\n' "$SECONDS" "$*" >&2; }
die() { log "$*"; exit 1; }
step() { stage=$1; log "$stage"; }
safe_path() { [[ $1 =~ ^(/[A-Za-z0-9_.@+-]+)+$ ]]; }
separate() { [[ $1 != "$2" && $1 != "$2/"* && $2 != "$1/"* ]]; }
run() { runuser -u "$user" -- env -i HOME="$home" PATH="$PATH" LC_ALL=C XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" "$@"; }
ctl() { run timeout 8s systemctl --user --no-pager "$@"; }
show() { ctl show "$1" -p "$2" --value; }
g() { run env GIT_ALLOW_PROTOCOL= GIT_NO_LAZY_FETCH=1 git -C "$checkout" -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
clean() { local s; s=$(g status --porcelain --untracked-files=all) && [[ -z $s || $s == '?? nohup.out' ]] && [[ ! -L $checkout/nohup.out ]]; }
node_run() { run "$node" --no-warnings "$@"; }
cli() { local rev=$1; shift; run env HOME="$cli_home" timeout 30s "$node" "$cli_home/$rev/cli/rf.mjs" "$@"; }
unit_args() { local s; s=$(show "$unit" ExecStartEx) && [[ $s == "{ path=$node ; argv[]=${prefix[*]} $1 8780${2:+ $2} ; flags= ; "* && $s != *'} {'* ]]; }
unit_hash() { ctl cat "$unit" | sha256sum; }
identity() {
    local p=$1 row; shift; local -a fields
    [[ $p =~ ^[1-9][0-9]*$ && $(stat -c %u "/proc/$p") == "$uid" && $(readlink "/proc/$p/cwd") == "$checkout" && $(readlink "/proc/$p/exe") == "$exe" ]] || return 1
    cmp -s "/proc/$p/cmdline" <(printf '%s\0' "${prefix[@]}" "$1" 8780 "${@:2}") &&
        read -r row <"/proc/$p/stat" && read -ra fields <<<"${row##*) }" && printf '%s:%s\n' "$p" "${fields[19]}"
}
current() {
    local p sockets; p=$(show "$unit" MainPID) && sockets=$(ss -Hlntp 'sport = :8780') || return 1
    [[ $sockets != *$'\n'* && $sockets == *'127.0.0.1:8780 '* && $sockets == *"pid=$p,"* ]] && identity "$p" "$@"
}
quiet() {
    local s sockets jobs; s=$(show "$unit" ActiveState) && sockets=$(ss -Hlntp 'sport = :8780') && jobs=$(ctl list-jobs --no-legend) || return 1
    [[ $s =~ ^(inactive|failed)$ && $(show "$unit" MainPID) == 0 && -z $sockets && $jobs != *"$unit"* ]] &&
        { [[ ! -d $cg ]] || grep -Fxq 'populated 0' "$cg/cgroup.events"; }
}
wait_stopped() { local end=$((SECONDS+90)); until quiet; do (( SECONDS < end )) || return 1; sleep 1; done; }
stop_pid() { [[ $(show "$unit" MainPID) == "${1%:*}" && $(identity "${1%:*}" "${@:2}") == "$1" ]] && ctl stop --no-block "$unit" && wait_stopped; }
idle_updater() {
    local t u jobs; t=$(show "$timer" ActiveState) && u=$(show "$updater" ActiveState) && jobs=$(ctl list-jobs --no-legend) || return 1
    [[ $t =~ ^(inactive|failed)$ && $u =~ ^(inactive|failed)$ && $jobs != *rollforward-update.* ]]
}
# The three guarded starts have separate root-owned permits; hold never has one.
install_override() {
    local mode=$1 root=$2 arg=${3-} permit=$work/$1.permit loaded
    if [[ $mode != remove ]]; then [[ ! -e $permit ]] || return 1; fi
    { if [[ $mode != remove ]]; then
        printf '[Unit]\nConditionPathExists=%s\n[Service]\n' "$permit"
        if [[ $mode != live ]]; then printf 'SendSIGKILL=no\n'; fi
        if [[ $mode == verify ]]; then printf 'Restart=no\n'; fi
        if [[ $mode != hold ]]; then printf 'ExecStart=\nExecStart=%s %s 8780%s\n' "${prefix[*]}" "$root" "${arg:+ $arg}"; fi
      fi
    } | run /bin/bash -euc '
        p=$1 mark=$2; [[ $(realpath -m -- "$p") == "$p" ]]
        if [[ -e $p ]]; then [[ -f $p ]] && IFS= read -r first <"$p" && [[ $first == "$mark" ]] || exit 1; fi
        if [[ $3 == remove ]]; then rm -f -- "$p"; exit; fi
        mkdir -p -- "${p%/*}"; tmp=$(mktemp "$p.XXXXXXXX"); trap '\''rm -f -- "$tmp"'\'' EXIT
        { printf "%s\n" "$mark"; cat; } >"$tmp"; mv -fT -- "$tmp" "$p"
    ' _ "$override" "# rf080: $work" "$mode" && ctl daemon-reload && unit_args "$root" "$arg" || return 1
    if [[ $mode == remove ]]; then [[ $(unit_hash) == "$original_unit" ]]; else
        loaded=$(run timeout 8s busctl --user get-property org.freedesktop.systemd1 /org/freedesktop/systemd1/unit/rollforward_2eservice org.freedesktop.systemd1.Unit Conditions) || return 1
        [[ $loaded == *"\"ConditionPathExists\" false false \"$permit\" "* && " $(show "$unit" DropInPaths)" == *" $override"
            && ( $mode == live || $(show "$unit" SendSIGKILL) == no ) && ( $mode != verify || $(show "$unit" Restart) == no ) ]]
    fi
}
probe() {
    node_run --input-type=module -e '
      import {readFileSync} from "node:fs";
      try {
        const [file,version,mode]=process.argv.slice(1), verify=mode==="--verify-only", {url,token}=JSON.parse(readFileSync(file));
        const get=async p=>{const r=await fetch(url+p,{headers:{authorization:`Bearer ${token}`},redirect:"error",signal:AbortSignal.timeout(8000)}); if(r.status!==200)throw 0; return r.json();};
        const m=await get("/me"), s=await get("/api/status"), keys="running queued ownership asks expired requests proposals failed".split(" ");
        if(m.version!==version || !["user","admin"].includes(m.role) || !m.email || m.verifyOnly!==(verify?true:undefined) || !keys.every(k=>Array.isArray(s[k])))throw 0;
        if(verify){
          if(!Array.isArray(s.noteNotices) || s.running.length || s.queued.length)throw 0;
          const refused=await fetch(url+"/api/messages",{method:"POST",body:"{}",headers:{authorization:`Bearer ${token}`},redirect:"error",signal:AbortSignal.timeout(8000)});
          if(refused.status!==503)throw 0;
        }
        console.log(JSON.stringify(m.email));
      } catch {process.exitCode=1}
    ' "$cli_home/.config/rollforward.json" "$1" "${2-}"
}
ready() {
    local v=$1 r=$2 end=$((SECONDS+180)) id; shift 2
    while (( SECONDS < end )); do
        if id=$(current "$r" "$@" 2>/dev/null) && [[ $(probe "$v" "${1-}") == "$person" && $(current "$r" "$@") == "$id" ]]; then printf '%s\n' "$id"; return; fi
        sleep 1
    done; return 1
}
rollback() {
    local id end=$((SECONDS+20)) restart=0 rev
    rm -f -- "$work/verify.permit" "$report/COMMITTED" || return 1
    if (( verifying )); then
        until quiet; do
            if id=$(identity "$(show "$unit" MainPID)" "$copy" --verify-only 2>/dev/null); then stop_pid "$id" "$copy" --verify-only || return 1; break; fi
            (( SECONDS < end )) || return 1; sleep 1
        done
    fi
    if quiet || { { (( old_stop )) || [[ $(show "$unit" MainPID) == 0 ]]; } && wait_stopped; }; then restart=1
    elif (( old_stop )) || ! current "$data" >/dev/null; then return 1; fi
    idle_updater && rev=$(g rev-parse HEAD) || return 1
    if [[ $rev == "$pin" ]] && (( restart )); then
        clean && g checkout -q --detach --no-overwrite-ignore --no-recurse-submodules "$old" && clean || return 1
    fi
    [[ $(g rev-parse HEAD) == "$old" ]] && install_override remove "$data" || return 1
    if (( restart )); then ctl start --no-block "$unit" || return 1; fi
    ready v0.7.9 "$data" >/dev/null || return 1
    if [[ $timer_was == active ]]; then ctl start "$timer" && [[ $(show "$timer" ActiveState) == active ]] || return 1; fi
    log 'v0.7.9 healthy on original data; previous timer state restored.'
}
finish() {
    local rc=$1; trap - EXIT; trap '' INT TERM; set +e
    if (( rc )); then log "FAILED: $stage (exit $rc)"
        if [[ -n $report && -e $report/COMMITTED && -e $work/live.permit ]]; then
            rm -f -- "$work/live.permit" || log 'Remove the live start permit manually before any restart.'
            [[ $(show "$timer" ActiveState) =~ ^(inactive|failed)$ ]] || ctl stop "$timer" || log 'Stop the updater timer manually.'
            log "Live effects may exist. Keep updater off, ask users to stop writing, and preserve $data and $copy. Inspect the user unit and reconcile new work before rollback; drain before any live stop."
        elif (( managed )); then
            rollback || log "Rollback incomplete. Keep ingress/updater off; inspect $work and the user unit before any start or stop. Neither data tree was removed."
        fi
    fi
    if [[ -n $cli_home ]]; then run rm -rf -- "$cli_home" || log "Remove private CLI HOME $cli_home locally."; fi
    if [[ $operation == --preflight ]] && (( rc )); then exit 1; fi
    exit "$rc"
}
trap 'finish $?' EXIT; trap 'die Interrupted' INT TERM; trap 'log "Command failed at line $LINENO (exit $?)"' ERR

[[ $pin =~ ^[0-9a-f]{40}$ && $pin != "$old" && -n $pull && $pull != -* ]] || die 'Expected full SHA and small pull path.'
IFS=: read -r user _ actual _ _ home _ <<<"$(getent passwd "$uid")"
[[ $actual == "$uid" && -S $runtime/bus ]] && safe_path "$home" || die 'UID 8004 user manager unavailable.'
cd /; exec 9>/run/rollforward-v0.8.0.cutover.lock; flock -n 9 || die 'Another controller holds the cutover lock.'
old_pid=$(show "$unit" MainPID); [[ $(show "$unit" ActiveState) == active && $old_pid =~ ^[1-9][0-9]*$ ]] || die 'Old unit not active.'
mapfile -td '' argv <"/proc/$old_pid/cmdline"; n=${#argv[@]}; [[ $n == 4 || $n == 5 ]] || die 'Unexpected native argv.'
node=${argv[0]}; exe=$(realpath -e -- "$node"); entry=${argv[n-3]}; data=${argv[n-2]}; prefix=("${argv[@]:0:n-2}"); envfile=
[[ $node == */node && ( $entry == src/server.ts || $entry == "$checkout/src/server.ts" ) && ${argv[n-1]} == 8780 ]] || die 'Not the expected native entrypoint.'
if (( n == 5 )); then [[ ${argv[1]} == --env-file=* ]] || die 'Unsupported Node flags.'; envfile=${argv[1]#*=}; safe_path "$envfile" && separate "$envfile" "$data" || die 'Unsupported env-file.'; fi
safe_path "$node" || die 'Unsafe Node path.'
for p in "$checkout" "$data" "$parent" "$auth"; do safe_path "$p" && [[ $(realpath -e -- "$p") == "$p" ]] || die "Need canonical absolute path: $p"; done
[[ -d $data && $(stat -c %u "$data") == "$uid" && -d $parent && -f $auth && $(stat -c '%u:%a:%h' "$auth") =~ ^0:(400|600):1$ ]] || die 'Unsafe source/copy/auth paths.'
separate "$checkout" "$data" && separate "$parent" "$data" && separate "$parent" "$checkout" && separate "$auth" "$data" && separate "$auth" "$checkout" || die 'Paths overlap.'
for d in "$parent" "${auth%/*}"; do
    while :; do read -r owner mode < <(stat -c '%u %a' "${d:-/}"); [[ $owner == 0 ]] && (( !(8#$mode & 022) )) || die 'Copy/auth ancestors must be root-controlled.'; [[ -n $d ]] || break; d=${d%/*}; done
done
work=$(mktemp -d "$parent/rf080.XXXXXXXX"); chmod 0711 "$work"; report=$work/private; mkdir "$report"
copy=$work/data; override=$home/.config/systemd/user/$unit.d/zz-rf080-cutover.conf
log "Original: $data; copy: $copy; private diagnostics: $report"; run test -x "$work"
[[ ! -e $override && ! -L $override ]] || die 'Existing cutover override; inspect first.'
old_id=$(current "$data"); [[ ${old_id%:*} == "$old_pid" ]] && unit_args "$data" '' || die 'Native listener or loaded ExecStart mismatch.'
props=$(ctl show "$unit" -p NeedDaemonReload,WorkingDirectory,Type,RootDirectory,RootImage,ExecCondition,ExecStartPre,ExecStartPost,ExecStop,ExecStopPost,KillMode,KillSignal)
for p in 'NeedDaemonReload=no' "WorkingDirectory=$checkout" 'KillSignal=15'; do grep -Fxq "$p" <<<"$props" || die "Expected $p"; done
grep -Eq '^Type=(simple|exec)$' <<<"$props" && grep -Eq '^KillMode=(mixed|control-group)$' <<<"$props" &&
    ! grep -Eq '^(RootDirectory|RootImage|ExecCondition|ExecStartPre|ExecStartPost|ExecStop|ExecStopPost)=.+' <<<"$props" || die 'Unsupported native unit configuration.'
cg=/sys/fs/cgroup$(show "$unit" ControlGroup); [[ $cg == */"$unit" && -r $cg/cgroup.events ]] || die 'Expected native cgroup v2.'; original_unit=$(unit_hash)
cred=; drain_min=; host=; drain_set=0
while IFS= read -rd '' e; do
    case $e in CREDENTIALS_DIRECTORY=*) cred=${e#*=};; RF_DRAIN_MIN=*) drain_min=${e#*=}; drain_set=1;; RF_HOST=*) host=${e#*=};; NODE_OPTIONS=?*) die 'Unsupported NODE_OPTIONS.';; esac
done <"/proc/$old_pid/environ"
[[ -z $cred ]] || safe_path "$cred" || die 'Unexpected credential directory.'
keys=${cred:+/proc/$old_pid/root$cred}; keys=${keys:-$data/.rf}
for k in session.key seal.key; do [[ -f $keys/$k && ! -L $keys/$k && $(stat -c %s "$keys/$k") == 32 ]] || die "Recover missing or invalid $k first."; done
[[ $(node_run --version) == v26.* ]] || die 'Need the deployed Node 26.'
env_stamp=
if [[ -n $envfile ]]; then
    boot=$(awk '$1=="btime" { print $2; exit }' /proc/stat); ticks=$(getconf CLK_TCK)
    [[ $boot =~ ^[0-9]+$ && $ticks =~ ^[1-9][0-9]*$ ]] || die 'Cannot establish service launch time.'
    # /proc/environ omits Node's dotenv values; only trust the unchanged launch file.
    (( $(stat -Lc %Z "$envfile") < boot + ${old_id#*:}/ticks - 1 )) || die 'Env file changed since launch, or launch was too recent to prove its drain lease.'
    env_stamp=$(stat -Lc '%d:%i:%s:%y:%z' "$envfile")
fi
lease=$(node_run -e '
    const [file,has,value,host]=process.argv.slice(1), e=file?require("node:util").parseEnv(require("node:fs").readFileSync(file,"utf8")):{};
    const sec=Math.floor(60*Number(has==="1"?value:e.RF_DRAIN_MIN??15));
    if(e.NODE_OPTIONS || e.CREDENTIALS_DIRECTORY || (host||e.RF_HOST||"127.0.0.1")!=="127.0.0.1" || !(sec>=120 && sec<=2147483))process.exit(1); console.log(sec);
' "$envfile" "$drain_set" "$drain_min" "$host") || die 'Need loopback and a drain lease of at least two minutes for baseline probes.'
[[ $(g rev-parse --show-toplevel) == "$checkout" && $(g rev-parse HEAD) == "$old" && $(g rev-parse 'refs/tags/v0.7.9^{commit}') == "$old" &&
   $(g rev-parse 'refs/tags/v0.8.0^{commit}') == "$pin" && $(g cat-file -t refs/tags/v0.8.0) == tag &&
   $(g describe --tags --always "$old") == v0.7.9 && $(g describe --tags --always "$pin") == v0.8.0 ]] || die 'Release SHA/tag mismatch.'
! g symbolic-ref -q HEAD && clean && g merge-base --is-ancestor "$old" "$pin" || die 'Expected a clean detached v0.7.9 contained in candidate.'
notes=$(g for-each-ref --format='%(contents)' refs/tags/v0.8.0); grep -q '^Manual:' <<<"$notes" || die 'Candidate is not a Manual: release.'
g diff --quiet "$old" "$pin" -- agent/ scripts/agent.ts src/agent.ts package.json package-lock.json || die 'Candidate changes dependencies or image inputs.'

step 'stage both CLIs outside checkout and authenticate old service'
cli_home=$(run mktemp -d "$runtime/rf080-cli.XXXXXXXX"); run mkdir "$cli_home/.config"
node_run -e '
    try {const fs=require("node:fs"), {token}=JSON.parse(fs.readFileSync(0,"utf8")); if(typeof token!=="string" || !/^rft_[\w-]{32}$/.test(token))throw 0;
    fs.writeFileSync(process.argv[1],JSON.stringify({url:process.argv[2],token}),{mode:0o600,flag:"wx"});} catch {process.exitCode=1}
' "$cli_home/.config/rollforward.json" "$base" <"$auth" || die 'Invalid private rf config.'
for rev in "$old" "$pin"; do
    run mkdir "$cli_home/$rev"; g archive "$rev" LICENSE cli/package.json cli/build.mjs src/rf-people.ts | run tar -x -C "$cli_home/$rev"
    node_run "$cli_home/$rev/cli/build.mjs"
done
[[ $(cli "$old" --version) == 0.19.2 && $(cli "$pin" --version) == 0.20.0 ]] || die 'Wrong staged CLI versions.'
person=$(probe v0.7.9) && [[ $(current "$data") == "$old_id" ]] || die 'Old /me or /api/status failed; check the existing rf config and native service.'
snapshot() {
    local rev=$1 name=$2 cmd
    for cmd in ls waiting; do
        cli "$rev" "$cmd" --json | run tee "$cli_home/$name.$cmd.json" >"$report/$name.$cmd.json" || return 1
    done 2>"$report/$name.cli.err"
    node_run --input-type=module -e '
        import {readFileSync} from "node:fs";
        const {url,token}=JSON.parse(readFileSync(process.argv[1]));
        const r=await fetch(url+"/api",{headers:{authorization:`Bearer ${token}`},redirect:"error",signal:AbortSignal.timeout(8000)});
        if(r.status!==200)process.exit(1); console.log(JSON.stringify(await r.json()));
    ' "$cli_home/.config/rollforward.json" | run tee "$cli_home/$name.tree.json" >"$report/$name.tree.json" &&
    cli "$rev" pull "$pull" "$cli_home/pull-$name" --max-size 2M 2>>"$report/$name.cli.err" >"$report/$name.pull" &&
        grep -Eq '^fetched [1-9][0-9]*, 0 up to date, in ' "$report/$name.pull"
}
listing_stamp() {
    node_run -e '
        const fs=require("node:fs"), {createHash}=require("node:crypto"), {join}=require("node:path"), root=process.argv[1], hash=createHash("sha256");
        const record=p=>{const s=fs.lstatSync(join(root,p),{bigint:true,throwIfNoEntry:false}); hash.update(JSON.stringify([p,s&&`${s.ino}:${s.size}:${s.ctimeNs}:${s.mtimeNs}`])+"\n"); return s;};
        for(const p of ["wakes","tree","users","grants","capabilities"]) record(`.rf/${p}.json`);
        for(const [dir,fields] of [["instances",["instance.json","screen.json","log.jsonl"]],["series",["series.json"]],[".rf/seen",[""]]]){
            if(!record(dir) && dir===".rf/seen")continue;
            for(const id of fs.readdirSync(join(root,dir)).sort()) for(const f of fields) record(join(dir,id,f));
        }
        console.log(hash.digest("hex"));
    ' "$data"
}
drained() { curl --noproxy '*' -sS --max-time 3 -o /dev/null -w '%{http_code}' "$base/drained"; }
step 'preflight old CLI, pull, unit and reflink capacity'
snapshot "$old" preflight || die 'Old CLI list, Waiting, status or sample pull failed; see private diagnostics.'
[[ $(drained) =~ ^(200|503)$ ]] || die 'Unexpected /drained response; no signal sent.'
u=$(show "$updater" ActiveState); [[ $u =~ ^(inactive|failed)$ ]] || die 'Updater busy; do not interrupt it.'
timer_was=$(show "$timer" ActiveState); [[ $timer_was =~ ^(active|inactive|failed)$ ]] || die 'Unexpected timer state.'
jobs=$(ctl list-jobs --no-legend) && [[ $jobs != *rollforward-update.* ]] || die 'Cannot confirm updater jobs are idle; retry later.'
run timeout 8s busctl --user get-property org.freedesktop.systemd1 /org/freedesktop/systemd1/unit/rollforward_2eservice org.freedesktop.systemd1.Unit Conditions >/dev/null || die 'Cannot query native start conditions.'
[[ -f $data/.rf/tree.json && ! -L $data/.rf/tree.json && -s $data/.rf/tree.json ]] || die 'Missing regular old tree manifest for clone probe.'
cp --reflink=always -- "$data/.rf/tree.json" "$report/reflink-probe" || die 'Reflink unavailable between data and COPY_PARENT; no full-copy fallback.'
rm -- "$report/reflink-probe"
inventory=$(node_run - "$data" <<'JS'
const fs=require('node:fs'), {join,resolve,isAbsolute}=require('node:path'), root=process.argv[2], inside=p=>p===root || p.startsWith(root+'/');
if(fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').some(l=>l.split(' ')[4]?.replace(/\\([0-7]{3})/g,(_,n)=>String.fromCharCode(parseInt(n,8))).startsWith(root+'/')))throw Error('nested mount in original');
let entries=1, streams=0, logs=0, backupBytes=0, backupEntries=0;
function scan(rel){
  for(const e of fs.readdirSync(join(root,rel),{withFileTypes:true})){
    const r=join(rel,e.name), p=join(root,r), parts=r.split('/'); entries++;
    const backup=parts[0]==='.rf' && !parts.some(n=>n==='index'||n==='runs');
    if(backup)backupEntries++;
    if(e.name==='.git' && (!e.isDirectory() || fs.existsSync(p+'/commondir') || fs.existsSync(p+'/objects/info/alternates')))throw Error(`non-self-contained Git repository: ${r}`);
    if(e.isSymbolicLink()){
      const t=fs.readlinkSync(p);
      if(isAbsolute(t)||!inside(resolve(root,rel,t))||!inside(fs.realpathSync(p)))throw Error(`escaping symlink: ${r}`);
    }
    else if(e.isDirectory()){
      if(parts.length===2 && ['instances','series'].includes(parts[0]))streams++;
      scan(r);
    } else if(e.isFile()){
      if(backup)backupBytes+=fs.lstatSync(p).size;
      if(/^(?:instances\/[^/]+\/log\.jsonl|series\/[^/]+\/notes\/log\.jsonl|\.rf\/(?:tree|wakes)\.json)$/.test(r))logs+=fs.lstatSync(p).size;
    } else throw Error(`special file in original: ${r}`);
  }
}
scan('');
console.log(entries,streams,logs,backupEntries,backupBytes);
JS
) || die 'Source tree inventory failed.'
read -r entries streams logs backup_entries backup_bytes <<<"$inventory"
read -r blocks bytes_per_block inodes free_inodes < <(stat -fc '%a %S %c %d' "$work")
# Reserve for the clone's metadata, new streams, and the normal startup copy of .rf (without index/run caches).
need_inodes=$((entries + 2*streams + backup_entries + 1024))
need_bytes=$((2*logs + backup_bytes + 8192*need_inodes + 1073741824))
free_bytes=$((blocks*bytes_per_block))
log "Reflink verified: $entries entries, $logs B converter input, $backup_bytes B startup backup; need $need_bytes/$free_bytes B and $need_inodes/$free_inodes inodes (required/available)."
(( free_bytes >= need_bytes && (inodes == 0 || free_inodes >= need_inodes) )) || die 'Insufficient free blocks or inodes for reflink cutover.'
[[ $(current "$data") == "$old_id" && $(unit_hash) == "$original_unit" && $(g rev-parse HEAD) == "$old" ]] && clean || die 'Process, unit or checkout changed during preflight.'
[[ -z $envfile || $(stat -Lc '%d:%i:%s:%y:%z' "$envfile") == "$env_stamp" ]] || die 'Env file changed during preflight.'
log 'Preflight passed; no service, updater or checkout changes.'
[[ $operation != --preflight ]] || exit 0

step 'pause updater and fence starts'
managed=1; if [[ $timer_was == active ]]; then ctl stop "$timer"; fi
idle_updater && [[ $(unit_hash) == "$original_unit" && $(current "$data") == "$old_id" ]] || die 'Updater/unit changed during preflight.'
install_override hold "$data" || die 'Could not fence native starts.'
step 'drain v0.7.9 without cutting work'
code=$(drained); [[ $code =~ ^(200|503)$ ]] || die 'Unexpected /drained response before signalling.'; end=$((SECONDS+900))
while (( SECONDS < end )); do
    [[ $(current "$data") == "$old_id" ]] || die 'Old MainPID/listener changed.'
    renewed=$SECONDS; ctl kill --kill-whom=main --signal=SIGUSR2 "$unit"; code=$(drained)
    case $code in 200) break;; 503) sleep 2;; *) die "Unexpected /drained HTTP $code; no stop.";; esac
done
[[ $code == 200 ]] && (( SECONDS < end )) || die 'Drain timed out; v0.7.9 was not stopped. Its lease expires.'
step 'capture drained v0.7.9 CLI baseline and stop'
baseline=$(listing_stamp)
snapshot "$old" old || die 'Old ls, waiting, requests or pull failed; see private diagnostics.'
[[ $(listing_stamp) == "$baseline" ]] || die 'Listing inputs changed during the baseline; no stop.'
[[ -z $envfile || $(stat -Lc '%d:%i:%s:%y:%z' "$envfile") == "$env_stamp" ]] && idle_updater &&
    [[ $(drained) == 200 && $(current "$data") == "$old_id" ]] && (( SECONDS < end && SECONDS-renewed+20 < lease )) || die 'Drain deadline/lease or process changed; no stop.'
old_stop=1; stop_pid "$old_id" "$data" || die 'Old stop did not complete; no forced kill.'
[[ $(listing_stamp) == "$baseline" ]] || die 'Listing inputs changed before the stop; retry with a fresh baseline.'

step 'reflink the stopped original and convert'
cp -a --no-preserve=links --reflink=always -T -- "$data" "$copy" || die 'Stopped reflink copy failed; original retained.'
quiet && idle_updater && [[ $(g rev-parse HEAD) == "$old" ]] && clean || die 'Unit or checkout changed while copying.'
g checkout -q --detach --no-overwrite-ignore --no-recurse-submodules "$pin"; [[ $(g rev-parse HEAD) == "$pin" ]] && clean || die 'Checkout does not match v0.8.0 pin.'
migrate() {
    node_run "$checkout/scripts/migrate-messages.ts" --stopped-copy "$copy" --source "$data" "$1" | node_run -e '
      const {status,...v}=JSON.parse(require("node:fs").readFileSync(0,"utf8")), keys="series instances messages notes instanceMessages events requests".split(" ");
      if(status!==process.argv[1] || Object.keys(v).length!==keys.length || keys.some(k=>!Number.isSafeInteger(v[k])||v[k]<0))process.exit(1);
      console.log(keys.map(k=>`${k}=${v[k]}`).join(" "));
    ' "$2"
}
planned=$(migrate --dry-run 'dry run'); log "Dry run: $planned"
applied=$(migrate --apply converted) && repeat=$(migrate --dry-run 'already converted') &&
    [[ $applied == "$planned" && $repeat == "$planned" ]] || die 'Apply/repeat projection counters differ or conversion refused.'

step 'verify converted copy, no live work'
quiet && idle_updater && install_override verify "$copy" --verify-only || die 'Could not install verify-only override.'
verifying=1; : >"$work/verify.permit"; ctl start --no-block "$unit"
verify_id=$(ready v0.8.0 "$copy" --verify-only) || die 'Verify /me or /api/status failed; inspect user journal.'
snapshot "$pin" verify || die 'New ls, waiting, requests or pull failed; see private diagnostics.'
run diff --no-dereference -qr "$cli_home/pull-old" "$cli_home/pull-verify" >"$report/pull.diff" || die 'Pulled filenames or bytes differ; see private diagnostics.'
node_run --input-type=module - "$data" "$checkout" "$copy" "$person" "$cli_home" <<'JS'
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual as eq } from 'node:util';

const ok = x => { if (!x) throw 0; }, json = f => JSON.parse(readFileSync(f, 'utf8'));
const str = x => typeof x === 'string', id = x => str(x) && /^[\w-]+$/.test(x);
const arr = x => (ok(Array.isArray(x)), x), pos = x => Number.isSafeInteger(x) && x > 0;
const bag = xs => xs.map(x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)).sort();
const same = (a, b) => eq(bag(a), bag(b));
const put = (m, k, v) => { ok(!m.has(k)); m.set(k, v); };
// Instance.answered from v0.7.9; in particular, an unlinked word in the thread used to count.
const oldAnswered = (log, c) => log.some(e => e.seq > c.seq && e.seq <= log.length &&
  (e.op === 'close' && e.accepted?.includes(`c${c.seq}`) || e.thread === c.thread && (e.on === c.seq ? ['signoff','reject','withdraw'].includes(e.op)
    : e.parent === c.seq ? e.op === 'comment' && c.ask !== 'proposal' && !(c.ask === 'question' && e.by === 'agent')
    : e.parent === undefined && e.on === undefined && ['comment','signoff','resolve'].includes(e.op))));
const ask = e => e.by === 'agent' && e.op === 'comment' && !!e.ask;
let check = 'inputs';
try {
  const [source, checkout, copy, actorJSON, home] = process.argv.slice(2), actor = JSON.parse(actorJSON);
  ok(process.argv.length === 7 && source !== copy && str(actor) && actor.includes('@'));
  const load = f => import(pathToFileURL(join(checkout, 'src', f + '.ts')).href);
  const { readEntries, validateInstanceLog } = await load('message-store'), { waitsOn } = await load('messages');
  function snapshot(name, verify) {
    const read = f => arr(json(join(home, `${name}.${f}.json`)));
    const ls = read('ls'), waiting = read('waiting'), tree = read('tree');
    const books = new Map(), paths = new Map(), instances = new Map(), reqs = new Map(), listed = [], scopes = [], requestWait = [];
    for (const w of tree) for (const s of arr(w.series)) {
      const path = `${w.name}/${s.name}`;
      ok(id(w.id) && id(s.id) && str(w.name) && str(s.name) && typeof s.single === 'boolean' && Number.isSafeInteger(s.epoch) && s.epoch >= 0 && (s.owner === null || str(s.owner)));
      put(books, s.id, s); scopes.push([w.id, s.id, s.epoch, s.single]);
      listed.push({ id:s.id, path, owner:s.owner, wakes:arr(s.wakes), requests:arr(s.requests).length });
      for (const i of arr(s.instances)) {
        const at = `${path}/${i.label}`, summaries = arr(i.asks);
        ok(id(i.id) && str(i.label) && i.owner === (s.owner ?? '') && typeof i.running === 'boolean' && ['open','closed','abandoned','deleted'].includes(i.status));
        ok(i.deleted === null ? i.status !== 'deleted' : i.status === 'deleted' && str(i.deleted?.by) && str(i.deleted?.at));
        ok(summaries.every(a => str(a.who) && ['ask','question','proposal','note'].includes(a.kind)) && (i.status === 'open' || !summaries.length));
        const p = { i, s, workspace:w.id, asks:summaries.filter(a => a.kind !== 'note' && !Object.hasOwn(a, 'from')) };
        put(paths, at, p); put(instances, i.id, p);
        listed.push({ id:i.id, path:at, owner:i.owner, status:i.status, running:i.running, wakes:arr(i.wakes), asks:summaries.length,
          ...(i.deleted && { deleted:i.deleted }), ...(i.wakeCheck && { wakeCheck:i.wakeCheck }) });
      }
      for (const { message, ...r } of s.requests) {
        ok((verify ? pos(message) : message === undefined) && id(r.id) && r.series === s.id && r.who === s.owner && str(r.from) && str(r.at) && str(r.label)
          && (r.inst === undefined || id(r.inst)) && (r.target === undefined || id(r.target) && s.instances.some(i => i.id === r.target)) && (r.text === undefined || str(r.text)));
        put(reqs, r.id, r);
        if ((r.who ?? actor) === actor) requestWait.push({kind:'request', path, since:r.at, id:r.id,
          text:`${r.from} asks to ${r.target ? 'wake' : 'start'} ${r.label}${r.text ? `: ${r.text}` : ''}`});
      }
    }
    ok(paths.size && same(ls, listed) && same(requestWait, waiting.filter(r => r.kind === 'request')));
    const stable = [], askRows = Map.groupBy(waiting.filter(r => r.kind === 'ask'), r => r.path);
    for (const r of waiting) {
      if (r.kind === 'ask' || r.kind === 'note') {
        ok(paths.get(r.path)?.i.status === 'open' && str(r.since) && str(r.text));
      } else if (verify && ['open','settled'].includes(r.kind)) ok(str(r.id) && /^[cn][1-9]\d*$/.test(r.id) && str(r.path) && str(r.at) && str(r.text));
      else if (r.kind !== 'request') { ok(['owner','proposal','expired','refused','grant'].includes(r.kind)); stable.push(r); }
    }
    for (const [path, p] of paths) ok(p.asks.filter(a => a.who === actor).length === (askRows.get(path)?.length ?? 0));
    return { books, paths, instances, reqs, askRows, stable, scopes, ls:ls.map(({ requests, asks, ...r }) => r) };
  }
  const old = snapshot('old', false), verify = snapshot('verify', true);
  check = 'ls'; ok(same(old.ls, verify.ls) && same(old.scopes, verify.scopes));
  check = 'requests';
  for (const [k, r] of verify.reqs) ok(eq(old.reqs.get(k), r));
  const instFile = (root, k, f) => join(root, 'instances', k, f);
  function tombstone(k) {
    const p = old.instances.get(k), f = instFile(source, k, 'log.jsonl'), st = lstatSync(f);
    if (p?.i.deleted === null || !st.isFile() || st.size > 65536) return false;
    const line = readFileSync(f, 'utf8');
    if (!line.endsWith('\n') || line.indexOf('\n') !== line.length - 1) return false;
    const e = JSON.parse(line), m = json(instFile(source, k, 'instance.json'));
    return e?.op === 'delete' && pos(e.seq) && str(e.by) && Number.isFinite(Date.parse(e.at)) && id(m.series) && str(m.label)
      && (!p || m.series === p.s.id && m.label === p.i.label && eq(p.i.deleted, { by:e.by, at:e.at }));
  }
  let tombstones = 0, changed = 0;
  for (const [k, r] of old.reqs) if (!verify.reqs.has(k)) {
    const s = old.books.get(r.series);
    ok((r.inst && tombstone(r.inst)) || (r.target && tombstone(r.target)) || s.instances.some(i => i.deleted &&
      ((r.target === undefined && i.label === r.label) || (s.single && s.instances.length === 1)) && tombstone(i.id)));
    tombstones++;
  }
  check = 'waiting'; ok(same(old.stable, verify.stable));
  check = 'asks';
  for (const [path, a] of old.paths) {
    const b = verify.paths.get(path), before = old.askRows.get(path) ?? [], after = verify.askRows.get(path) ?? [];
    if (same(a.asks, b.asks) && same(before, after)) continue;
    const { i, s, workspace } = a, m = json(instFile(source, i.id, 'instance.json'));
    ok(i.status === 'open' && m.series === s.id && m.label === i.label && eq(m, json(instFile(copy, i.id, 'instance.json'))));
    const log = readEntries(instFile(source, i.id, 'log.jsonl'));
    ok(eq(log, readEntries(instFile(copy, i.id, 'log.jsonl')))); validateInstanceLog('parity', log);
    const copied = log.findLast(e => e.op === 'duplicate')?.seq ?? 0, owner = s.owner ?? '';
    const was = log.filter(e => e.seq > copied && ask(e) && !oldAnswered(log,e)).map(e => ({ who:e.to ?? owner, e })).filter(x => x.who);
    const now = waitsOn({log,copied}, owner, 0, 0, { epoch:s.epoch, workspace }).filter(({e}) => ask(e));
    for (const [waits, rows, p] of [[was,before,a],[now,after,b]]) {
      ok(same(p.asks, waits.map(({who,e}) => ({who, kind:e.ask === true ? 'ask' : e.ask}))));
      ok(same(rows, waits.filter(x => x.who === actor).map(({e}) => ({kind:'ask', path, since:e.at, text:e.text}))));
    }
    changed++;
  }
  console.log(`parity ls=${old.ls.length} stable_waiting=${verify.stable.length} requests=${verify.reqs.size} tombstoned=${tombstones} ask_scopes=${changed}`);
} catch { console.error(`parity failed: ${check}`); process.exitCode = 1; }
JS
step 'await explicit approval in read-only verification'
log "Verified v0.8.0 /me, /api/status, write refusal (503), CLI and projections. Root: touch $report/activate (or $report/abort)."
end=$((SECONDS+1200))
while [[ ! -f $report/activate ]]; do
    [[ ! -e $report/abort && $(current "$copy" --verify-only) == "$verify_id" ]] && (( SECONDS < end )) || die 'Review aborted, expired, or verify process changed.'; sleep 2
done
[[ ! -e $report/abort ]] && (( SECONDS < end )) || die 'Approval aborted or expired.'
step 'stop verification and recheck stopped projection counts'
rm -- "$work/verify.permit"; stop_pid "$verify_id" "$copy" --verify-only || die 'Cannot safely stop our verify-only process.'; verifying=0
repeat=$(migrate --dry-run 'already converted') && [[ $repeat == "$planned" ]] || die 'Post-verification projection validation failed.'
quiet && idle_updater && clean && [[ ! -e $report/abort && $(g rev-parse HEAD) == "$pin" ]] && install_override live "$copy" || die 'Live start preconditions changed.'
step 'launch live v0.8.0 (commit point)'
[[ ! -e $work/verify.permit && ! -e $work/live.permit && -f $report/activate && ! -e $report/abort ]] || die 'Start permits or approval changed.'
[[ -z $envfile || $(stat -Lc '%d:%i:%s:%y:%z' "$envfile") == "$env_stamp" ]] || die 'Env file changed during review.'
: >"$report/COMMITTED"; sync -f "$report/COMMITTED"
[[ ! -e $report/abort ]] || die 'Operator aborted before granting live permission.'
: >"$work/live.permit"; ctl start --no-block "$unit"
ready v0.8.0 "$copy" >/dev/null || die 'Live /me or /api/status failed; inspect user journal.'
step 'restore previous updater timer state'
idle_updater || die 'Updater state changed during live boot.'
if [[ $timer_was == active ]]; then ctl start "$timer" && [[ $(show "$timer" ActiveState) == active ]] || die 'Could not restore updater timer.'; fi
log "Live v0.8.0 healthy; keep $override and $work/live.permit, and retain original $data. Normal use may resume."

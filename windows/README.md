# Windows workers

`worker.ps1` turns a Windows machine into one of rollforward's Windows workers (docs/system.md, Windows workers): it runs runs' PowerShell commands in a signed-in desktop session, where desktop Office's COM and macros work, and reaches nothing but the rollforward server. It needs Windows PowerShell 5.1 and .NET Framework 4.5 or later, as Windows 10 and 11 have them, and nothing else.

The machine is the boundary: a run's command may do anything there, so it holds no credentials but its own key, joins no domain it needn't, and reaches nothing but the server. The jobs a worker takes share the machine, though: a command can read the worker's key, take the jobs of the workspaces that key names, and leave things for later jobs there. So give each worker only workspaces whose runs may see each other's work, and, better still, restore the machine to a clean snapshot between jobs or each night.

## On the rollforward server

A certificate for the worker listener, which workers pin by fingerprint, so self-signed is fine, and a key per worker:

    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
      -subj /CN=rollforward-windows -keyout /etc/rollforward/windows.key -out /etc/rollforward/windows.crt
    chown rollforward: /etc/rollforward/windows.key && chmod 600 /etc/rollforward/windows.key
    openssl x509 -noout -fingerprint -sha256 -in /etc/rollforward/windows.crt     # the workers' fingerprint
    openssl rand -hex 32                                                           # each worker's key

In the server's environment, then restart it:

    RF_WINDOWS_LISTEN=10.0.0.5:8781              # an address the workers reach, not the site's
    RF_WINDOWS_KEYS=win1:KEY1:WORKSPACE_ID       # name:key:workspaces, one per worker; the workspaces' ids, comma-separated, or *
    RF_WINDOWS_TLS_CERT=/etc/rollforward/windows.crt
    RF_WINDOWS_TLS_KEY=/etc/rollforward/windows.key

Let only the workers reach that port (firewalld: a rich rule for each worker's address), and opt series owners in, as admins are not by default: `rf can windows --add EMAIL`. Taking a worker's pair out of `RF_WINDOWS_KEYS` and restarting revokes it.

## On the Windows machine

1. **An account of its own**, a local standard user, such as `rfworker`, with no admin rights. Office's COM needs a signed-in desktop session, not a service's: sign it in automatically at boot (Sysinternals Autologon keeps the password encrypted, not in the registry in clear) and lock the screen.
2. **The worker**, in a folder only that account and admins can read, as its config holds the key:

       C:\rfworker\worker.ps1
       C:\rfworker\worker.json   {"url": "https://10.0.0.5:8781", "key": "KEY1", "fingerprint": "AB:CD:...",
                                  "workdir": "C:\\rfjobs", "inventory": {"notes": "what a run should know of this machine"}}

       icacls C:\rfworker /inheritance:r /grant:r "rfworker:(OI)(CI)RX" "Administrators:(OI)(CI)F"

3. **Start it at sign-in**, in that session, restarting if it stops:

       $a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& C:\rfworker\worker.ps1 *>> C:\rfworker\worker.log"'
       $t = New-ScheduledTaskTrigger -AtLogOn -User rfworker
       $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
       Register-ScheduledTask rfworker -Action $a -Trigger $t -Settings $s -User rfworker -RunLevel Limited

4. **The network**: outbound to the server's `RF_WINDOWS_LISTEN` only, nothing inbound but what administering it needs:

       New-NetFirewallRule -DisplayName "rfworker to rollforward" -Direction Outbound -RemoteAddress 10.0.0.5 -RemotePort 8781 -Protocol TCP -Action Allow
       Set-NetFirewallProfile -All -DefaultOutboundAction Block -DefaultInboundAction Block

   Office's activation, Windows Update and the like then need their own decisions: a machine whose Office is activated offline, or its updates brought by hand.

5. **Office**: open each program once as the account, so first-run prompts are done, and in Excel's Trust Center allow the macros runs need (a trusted location, such as `C:\rfjobs`).

`worker.log` says what it did, job by job. A run sees the machine at `curl $RF_WINDOWS`, with what the worker reported it has.

## What a job does there

The worker takes the oldest queued job of its workspaces, puts its files in `workdir\<job>\`, runs its command with `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass` there, in a Windows job object, with `$env:RF_OUT` for outputs, streams its output every 2 seconds and beats every 15 from a thread of its own, and at its timeout or a cancel kills the command's processes, those it left behind, and the Office programs started meanwhile in its session, which COM starts apart from them. Then it sends `RF_OUT`'s files, ends the job, and removes its folder. One job at a time: more workers run more at once.

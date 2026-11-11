# Windows laptop as a k3s agent (WSL2)

The laptop runs Ubuntu 24.04 in WSL2 and joins the cluster as `apps-node` over Tailscale
(tainted `location=home:NoSchedule`, only tolerating workloads land there). k3s itself is installed
by Ansible (`ansible/playbooks/k3s.yml --limit k3s_agents`); this page covers the Windows side.

## Inside WSL

`/etc/wsl.conf`:

```ini
[boot]
systemd=true

[network]
hostname=apps-node
```

Then, from Windows: `wsl --shutdown`, open Ubuntu again, and check `systemctl is-system-running`.
Tailscale and sshd must be enabled (`systemctl enable --now tailscaled ssh`).

## Keep WSL running without any open window

WSL stops a distribution when no Windows process uses it, so the node would drop out as soon as the
last terminal or VS Code window closes. A scheduled task starts it at boot and keeps it open.

PowerShell **as administrator**:

```powershell
$a = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wsl.exe' -Argument '-d Ubuntu-24.04 --exec /bin/sleep infinity'
$t = New-ScheduledTaskTrigger -AtStartup
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'WSL k3s node' -Action $a -Trigger $t -Settings $s -User 'Karim' -Password (Read-Host 'Windows password') -RunLevel Highest
Start-ScheduledTask -TaskName 'WSL k3s node'
```

- Run `sleep` directly with `--exec`, never through `sh -c '...'`: Windows does not treat single
  quotes as quotes, `sh` gets a broken command and exits at once (task result `2`).
- `-ExecutionTimeLimit 0`: the default stops the task after 3 days.
- The password is the Windows account password, not the PIN.

Check:

```powershell
Get-ScheduledTask -TaskName 'WSL k3s node' | Select-Object State                       # Running
Get-ScheduledTaskInfo -TaskName 'WSL k3s node' | Select-Object LastRunTime, LastTaskResult   # 267009 = running
wsl -l -v                                                                                # Ubuntu-24.04 Running
```

Test: close every terminal and VS Code window, wait 2 minutes, `kubectl get nodes` → `apps-node Ready`.
Then reboot the laptop without opening anything: `apps-node` is `Ready` again within ~2 minutes.

## Power settings

A sleeping laptop pauses WSL and the node goes `NotReady`; root then waits on apps with a pod on it
(node-exporter, Promtail, Falco). Settings → System → Power: sleep **Never** when plugged in;
Control Panel → Power Options → closing the lid: **Do nothing** when plugged in.

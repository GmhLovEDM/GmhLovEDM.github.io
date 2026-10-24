---
title: "How Containers Really Work: Namespaces, cgroups v2, OverlayFS, and the Runtime Stack"
tag: devops
description: A container is not a lightweight VM but an ordinary Linux process with a restricted view of the system. This article builds one by hand with namespaces, limits it with cgroups v2, gives it a layered root filesystem with OverlayFS, locks it down with capabilities and seccomp, then walks up the stack (runc, containerd, the kubelet) and explains the production consequences — CPU throttling, OOM kills, PID 1, and when to reach for gVisor or Kata
date: "2026-10-24T13:20:00.000Z"
---

## Goal

"Containers are lightweight virtual machines" is the most common mental model, and it is wrong in ways that cause real incidents. There is no container object in the Linux kernel. What we call a container is a normal process that the kernel has been asked to treat specially in three independent ways:

1. **Namespaces** change *what the process can see* (its PIDs, mounts, network interfaces, hostname, users).
2. **cgroups** change *how much the process can use* (CPU time, memory, I/O, number of processes).
3. **Security mechanisms** — capabilities, seccomp, LSMs such as AppArmor/SELinux — change *what the process is allowed to do*.

Add a root filesystem assembled from image layers (usually with OverlayFS) and you have everything Docker, containerd and Kubernetes actually do on a node. This article builds each piece by hand, then climbs the stack and connects the mechanisms to the problems you meet in production.

## Namespaces: A Private View of Shared Resources

A namespace wraps a global kernel resource so that processes inside it see their own isolated instance. Linux currently has eight types:

| Namespace | Flag | Isolates | Since |
|---|---|---|---|
| Mount | `CLONE_NEWNS` | Mount table | 2.4.19 |
| UTS | `CLONE_NEWUTS` | Hostname, domain name | 2.6.19 |
| IPC | `CLONE_NEWIPC` | System V IPC, POSIX message queues | 2.6.19 |
| PID | `CLONE_NEWPID` | Process ID number space | 2.6.24 |
| Network | `CLONE_NEWNET` | Interfaces, routes, iptables/nftables, sockets | 2.6.29 |
| User | `CLONE_NEWUSER` | UID/GID mappings, capabilities | 3.8 |
| cgroup | `CLONE_NEWCGROUP` | View of the cgroup hierarchy | 4.6 |
| Time | `CLONE_NEWTIME` | `CLOCK_MONOTONIC` / `CLOCK_BOOTTIME` offsets | 5.6 |

Three system calls do all the work: `clone()` creates a child in new namespaces, `unshare()` moves the caller into new ones, and `setns()` joins an existing one (this is what `docker exec` and `kubectl exec` use, via `nsenter`-style logic). Each namespace is visible as a file under `/proc/<pid>/ns/`:

```bash
$ ls -l /proc/self/ns
lrwxrwxrwx ... cgroup -> 'cgroup:[4026531835]'
lrwxrwxrwx ... mnt -> 'mnt:[4026531841]'
lrwxrwxrwx ... net -> 'net:[4026531840]'
lrwxrwxrwx ... pid -> 'pid:[4026531836]'
...
```

Two processes are in the same namespace exactly when those inode numbers match. A Kubernetes Pod is simply several containers that **share** network, IPC and (optionally) PID namespaces while keeping separate mount namespaces — which is why containers in a Pod talk over `localhost`.

### Building a container with one command

`unshare` from util-linux is enough to see the idea, without root, thanks to user namespaces:

```bash
$ unshare --user --map-root-user --pid --fork --mount-proc \
          --uts --net --ipc bash
# whoami
root
# hostname box && hostname
box
# ps aux
USER  PID ... COMMAND
root    1 ... bash
root    8 ... ps aux
# ip link
1: lo: <LOOPBACK> mtu 65536 state DOWN ...
```

Inside, the shell is PID 1, believes it is root, has its own hostname, and sees only a loopback interface. Outside, it is an unprivileged process with an ordinary PID. Nothing was virtualised; the kernel is just answering questions differently.

The same thing in Go, which is how early container runtimes were written:

```go
package main

import (
	"os"
	"os/exec"
	"syscall"
)

func main() {
	cmd := exec.Command("/bin/sh")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags: syscall.CLONE_NEWUSER | syscall.CLONE_NEWUTS |
			syscall.CLONE_NEWPID | syscall.CLONE_NEWNS |
			syscall.CLONE_NEWNET | syscall.CLONE_NEWIPC,
		// Map container root (0) to the invoking user on the host.
		UidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}},
		GidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}},
	}
	if err := cmd.Run(); err != nil {
		panic(err)
	}
}
```

### Why the user namespace matters so much

The user namespace is the one that changes the security story. Inside it, a process can hold `CAP_SYS_ADMIN` and be UID 0, but those privileges apply **only to resources owned by that namespace**. Mapped back to the host, it is UID 100000 (or whatever range `/etc/subuid` grants). A container escape from a user-namespaced container lands as an unprivileged user rather than real root.

This is why rootless Docker and Podman exist, and why Kubernetes added `hostUsers: false` on Pods (beta since v1.30). Historically, most containers ran *without* a user namespace, so "root in the container" was real root on the host restricted only by capabilities, seccomp and LSMs — keep that in mind when reading any container CVE.

## Root Filesystems: Pivot, Layers, and OverlayFS

A new mount namespace starts as a copy of the parent's mounts. To give the process its own root, the runtime mounts the image filesystem somewhere, then calls `pivot_root(new_root, put_old)` and unmounts the old root. (`chroot` is not used for this because it is trivially escapable by a process with `CAP_SYS_CHROOT`; `pivot_root` actually swaps the mount namespace's root.)

Images are stacks of read-only layers. Copying the whole stack for every container would be slow and wasteful, so runtimes use a union filesystem — almost always **OverlayFS** (mainline since Linux 3.18):

```bash
mkdir lower upper work merged
echo "from image" > lower/app.conf
sudo mount -t overlay overlay \
  -o lowerdir=lower,upperdir=upper,workdir=work merged

echo "changed" > merged/app.conf   # triggers copy-up
rm merged/other-file               # creates a whiteout in upper/
ls -l upper/
```

The mechanics worth knowing:

- **Lookups** go top-down: `upperdir` first, then each `lowerdir` in order (multiple layers are colon-separated).
- **Copy-up**: the first write to a lower file copies the *entire file* into `upperdir`. Appending one line to a 2 GB file in an image layer copies 2 GB. This is why databases and logs belong on volumes, not in the container's writable layer.
- **Whiteouts**: deleting a lower file creates a character device with device number 0/0 in `upperdir` that hides it; deleting a directory and recreating it marks it *opaque* via an extended attribute. That is also why `RUN rm -rf /big` in a later Dockerfile layer never makes an image smaller — the bytes still live in the earlier layer.
- **Inode and rename quirks**: renaming a lower directory historically returned `EXDEV` unless `redirect_dir` is enabled, and hard links can break across copy-up. Most software never notices; some package managers and build tools do.

containerd's snapshotter abstraction makes this pluggable (overlayfs, native, btrfs, zfs, and lazy-pulling snapshotters such as stargz that fetch file contents on demand).

## cgroups v2: Accounting and Limits

Namespaces do not limit anything; a process in its own PID namespace can still allocate all host memory. Control groups do that. cgroup v2 (the unified hierarchy, merged in Linux 4.5 and now the default on current distributions) exposes a single tree under `/sys/fs/cgroup`, where each directory is a group and each file is a knob or a statistic:

```bash
cd /sys/fs/cgroup
cat cgroup.controllers             # e.g. cpuset cpu io memory hugetlb pids rdma misc
echo "+cpu +memory +pids" | sudo tee cgroup.subtree_control

sudo mkdir demo
echo "50000 100000" | sudo tee demo/cpu.max      # 50 ms per 100 ms = 0.5 CPU
echo 256M          | sudo tee demo/memory.max
echo 128           | sudo tee demo/pids.max
echo $$            | sudo tee demo/cgroup.procs  # move this shell in

cat demo/memory.current demo/memory.events demo/cpu.stat
```

Compared with v1, where every controller had its own hierarchy and a process could be in different places in each, v2 enforces one tree, a "no internal processes" rule (only leaves hold processes when controllers are enabled), and delegation that is safe to hand to unprivileged users — the foundation for rootless containers.

### CPU: weights versus quotas

There are two very different CPU controls, and confusing them is the root of many latency mysteries.

- **`cpu.weight`** (1–10000, default 100) is *proportional sharing*. It only matters under contention: a group with weight 200 gets twice the CPU of one with weight 100 when both are busy, and can use idle CPU freely when they are not.
- **`cpu.max`** (`quota period`) is a *hard ceiling* enforced by the CFS bandwidth controller. With `50000 100000`, the group may run for 50 ms of CPU time in every 100 ms window — summed across **all** its threads and cores.

The second point is the trap. A service with a limit of 1 CPU running 8 busy threads on an 8-core machine burns its 100 ms of quota in about 12.5 ms of wall time, then is **throttled for the remaining ~87.5 ms** of the period. Average utilisation looks like "1 CPU, fine", but p99 latency includes those stalls. You can see it directly:

```bash
$ cat /sys/fs/cgroup/<pod-cgroup>/cpu.stat
usage_usec 81234567
nr_periods 51234
nr_throttled 20345
throttled_usec 912345678
```

A high `nr_throttled / nr_periods` ratio on a latency-sensitive service is a red flag. Remedies, in rough order of preference: make the runtime aware of its limit so it does not spawn more parallelism than it can use (the JVM has honoured container limits by default since JDK 10 / 8u191; Go 1.25 made the default `GOMAXPROCS` respect the cgroup CPU limit, and older Go versions can use `go.uber.org/automaxprocs`); raise or remove CPU limits while keeping requests; and use `cpu.max.burst` where available to allow short bursts above quota.

### Memory: max, high, and the OOM killer

Memory has several knobs with distinct semantics:

| File | Behaviour |
|---|---|
| `memory.max` | Hard limit. When reclaim cannot get usage below it, the kernel OOM-kills a process in the group. |
| `memory.high` | Throttle point. Above it the group is forced into reclaim and slowed down, but not killed. |
| `memory.low` / `memory.min` | Soft / hard protection from reclaim caused by pressure elsewhere. |
| `memory.events` | Counters: `high`, `max`, `oom`, `oom_kill`. |
| `memory.oom.group` | If `1`, kill the whole group together instead of one victim. |

Two facts routinely surprise people. First, `memory.current` includes **page cache** — files the process read or wrote — not just heap. Much of that cache is reclaimable, which is why Kubernetes reports a "working set" (usage minus inactive file pages) and evicts based on it, and why a container that only streams files can look "near its limit" without being in danger. Second, a cgroup OOM kill is invisible to the application: the process receives `SIGKILL` and the container exits with code 137. Look at `memory.events`, `dmesg`, and the Pod's `lastState.terminated.reason: OOMKilled` instead of application logs.

### PSI: measuring contention instead of guessing

Since Linux 4.20, Pressure Stall Information reports how much time tasks spent *stalled* waiting for a resource, per cgroup: `cpu.pressure`, `memory.pressure`, `io.pressure`.

```text
some avg10=12.50 avg60=8.31 avg300=4.02 total=123456789
full avg10=3.10 avg60=1.95 avg300=0.88 total=23456789
```

`some` is the share of time at least one task was stalled; `full` is the share of time *all* non-idle tasks were stalled. PSI answers "is this workload actually suffering?" far better than utilisation does, and it is what systemd-oomd and Meta's oomd use to act before the kernel OOM killer does.

## Locking It Down: Capabilities, seccomp, LSMs

Namespaces and cgroups isolate and meter; they do not stop a process from calling dangerous kernel interfaces. Three further layers do:

- **Capabilities** split root's power into about 40 units (`CAP_NET_ADMIN`, `CAP_SYS_ADMIN`, `CAP_SYS_PTRACE`, ...). Docker and containerd start containers with a short allowlist (e.g. `CHOWN`, `NET_BIND_SERVICE`, `SETUID`) and drop the rest. `--privileged` grants all of them and disables most other protections — treat it as "not a container".
- **seccomp-bpf** filters system calls with a BPF program evaluated on every syscall. Docker's default profile blocks dozens of rarely needed and historically dangerous calls such as `kexec_load`, `open_by_handle_at`, `bpf`, and namespace-creating `clone`/`unshare` variants. Kubernetes does *not* apply it by default; set `securityContext.seccompProfile.type: RuntimeDefault` (or enable kubelet's `--seccomp-default`).
- **LSMs** — AppArmor or SELinux — apply mandatory access control to files and operations even for root.

`no_new_privs` (set via `allowPrivilegeEscalation: false` in Kubernetes) completes the picture by ensuring setuid binaries cannot regain privileges after `execve`.

A hardened Pod spec puts these together:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
```

## The Runtime Stack: From `kubectl apply` to `execve`

With the primitives understood, the layers of software make sense:

```text
kubelet ──CRI (gRPC)──► containerd / CRI-O
                            │  pulls image, unpacks layers via snapshotter
                            ▼
                      containerd-shim-runc-v2  (one per Pod/container, survives daemon restarts)
                            │  OCI bundle: config.json + rootfs
                            ▼
                          runc  (exits after start)
                            │  clone(namespaces) → cgroups → mounts → pivot_root
                            │  → capabilities → seccomp → execve(entrypoint)
                            ▼
                      your process (PID 1 in its PID namespace)
```

- The **OCI Runtime Specification** defines the `config.json` contract — namespaces, mounts, cgroup path and limits, capabilities, seccomp profile, process args. The **OCI Image Specification** defines layers and manifests. Any compliant runtime (runc, crun, youki) can execute the same bundle.
- **runc** is a short-lived setup tool. It configures everything, `execve`s your entrypoint, and exits. The **shim** stays behind as the process's parent so that containerd can restart without killing containers, and so that exit codes and stdio are preserved.
- The ordering matters for security. runc has had serious escapes precisely in this setup phase: CVE-2019-5736 let a malicious container overwrite the host `runc` binary through `/proc/self/exe`, and CVE-2024-21626 ("Leaky Vessels") leaked a host directory file descriptor into the container via the working directory. Both were fixed, but they illustrate that a shared kernel and a privileged setup path are the real attack surface.

## PID 1 Is Special

The entrypoint becomes PID 1 inside its PID namespace, and the kernel treats PID 1 differently:

- Signals without an installed handler are **ignored** for PID 1. A program that relies on default `SIGTERM` behaviour will not stop on `docker stop`/Pod termination and gets `SIGKILL`ed after the grace period (30 s by default in Kubernetes).
- PID 1 must **reap orphaned children**. A shell script or Node process that spawns subprocesses without reaping them accumulates zombies until `pids.max` is hit.
- When PID 1 exits, the kernel kills every other process in the namespace.

Fixes: handle `SIGTERM` explicitly, use the exec form of `ENTRYPOINT` (`["app"]`, not `app` via `/bin/sh -c`, which leaves the shell as PID 1), or run a minimal init such as `tini` (`docker run --init`, or `shareProcessNamespace` patterns in Kubernetes).

## When the Shared Kernel Is Not Enough

Every container on a node shares one kernel. A kernel bug reachable through an allowed syscall is a cross-tenant escape. For untrusted code — CI jobs from forks, user-submitted functions, multi-tenant SaaS — stronger boundaries exist, each plugged in as an alternative OCI runtime (Kubernetes `RuntimeClass`):

| Runtime | Isolation model | Cost |
|---|---|---|
| runc / crun | Namespaces + cgroups + seccomp on the host kernel | Near-native; largest kernel attack surface |
| gVisor (`runsc`) | User-space kernel (Sentry) intercepts syscalls; only a small set reaches the host | Syscall-heavy and I/O-heavy workloads slow down; some incompatibilities |
| Kata Containers | Each Pod in a lightweight VM with its own guest kernel | Extra memory per Pod, slower start; strong hardware boundary |
| Firecracker microVMs | Minimal VMM designed for serverless (used by AWS Lambda and Fargate) | Fast boot for a VM; needs an orchestration layer around it |

The general rule: runc for code you trust and wrote, a sandboxed runtime for code you do not.

## Production Checklist

- **CPU:** set requests on everything; be deliberate about limits on latency-sensitive services; watch `nr_throttled`; make runtimes limit-aware (`GOMAXPROCS`, JVM container support, thread pool sizes).
- **Memory:** size limits on working set plus headroom; alert on `memory.events` `oom_kill` and on restarts with reason `OOMKilled`; remember page cache counts.
- **Filesystem:** keep heavy writes on volumes; use `readOnlyRootFilesystem` and an `emptyDir` for scratch; squash or use multi-stage builds rather than deleting files in later layers.
- **Security:** run as non-root, drop all capabilities, `RuntimeDefault` seccomp, no `privileged`, consider `hostUsers: false`; patch runc/containerd promptly.
- **Lifecycle:** exec-form entrypoints, explicit `SIGTERM` handling, an init process when you spawn children.
- **Debugging:** `nsenter -t <pid> -n` to enter just a container's network namespace with host tools; `cat /proc/<pid>/cgroup` to find its cgroup; `kubectl debug` with an ephemeral container to share its namespaces.

## Summary

A container is a process with a private view (namespaces), a budget (cgroups), a reduced set of permissions (capabilities, seccomp, LSMs) and a root filesystem stitched from layers (OverlayFS). runc wires those together from an OCI bundle and gets out of the way; containerd and the kubelet manage lifecycle around it. Nearly every container surprise in production — throttled latency under "low" CPU usage, mysterious exit code 137, slow writes into big files, containers that ignore shutdown, and escapes that reach the host — follows directly from those kernel mechanisms, and becomes debuggable once you know which file under `/proc` or `/sys/fs/cgroup` to read.

## References

- Linux man-pages: [namespaces(7)](https://man7.org/linux/man-pages/man7/namespaces.7.html), [user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html), [cgroups(7)](https://man7.org/linux/man-pages/man7/cgroups.7.html), [pivot_root(2)](https://man7.org/linux/man-pages/man2/pivot_root.2.html)
- Linux kernel documentation, [Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- Linux kernel documentation, [Overlay Filesystem](https://docs.kernel.org/filesystems/overlayfs.html)
- Linux kernel documentation, [PSI — Pressure Stall Information](https://docs.kernel.org/accounting/psi.html)
- Open Container Initiative, [Runtime Specification](https://github.com/opencontainers/runtime-spec) and [Image Specification](https://github.com/opencontainers/image-spec)
- Kubernetes documentation, [About cgroup v2](https://kubernetes.io/docs/concepts/architecture/cgroups/) and [User Namespaces](https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/)
- Docker documentation, [Seccomp security profiles for Docker](https://docs.docker.com/engine/security/seccomp/)
- Go blog, [Container-aware GOMAXPROCS](https://go.dev/blog/container-aware-gomaxprocs) (2025)
- [gVisor documentation](https://gvisor.dev/docs/) and [Kata Containers](https://katacontainers.io/)

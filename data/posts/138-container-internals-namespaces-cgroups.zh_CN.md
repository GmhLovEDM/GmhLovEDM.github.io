---
title: "容器到底是怎么工作的：Namespace、cgroups v2、OverlayFS 与运行时栈"
tag: devops
description: 容器不是轻量级虚拟机，而是一个被限制了视野的普通 Linux 进程。本文用 Namespace 亲手搭一个容器，用 cgroups v2 给它限额，用 OverlayFS 给它分层的根文件系统，再用 capabilities 和 seccomp 加固；然后沿着 runc、containerd、kubelet 往上走，解释生产环境中的后果——CPU 节流、OOM 被杀、PID 1 问题，以及何时该用 gVisor 或 Kata
date: "2026-10-24T13:20:00.000Z"
---

## 目标

"容器就是轻量级虚拟机"是最常见的心智模型，但它错得足以引发真实事故。Linux 内核里根本没有"容器"这个对象。我们所说的容器，是一个普通进程，只是内核被要求从三个相互独立的方面特殊对待它：

1. **Namespace（命名空间）** 改变进程*能看到什么*（PID、挂载点、网卡、主机名、用户）。
2. **cgroups（控制组）** 改变进程*能用多少*（CPU 时间、内存、I/O、进程数）。
3. **安全机制**——capabilities、seccomp、AppArmor/SELinux 等 LSM——改变进程*被允许做什么*。

再加上一个由镜像层拼出来的根文件系统（通常用 OverlayFS），就是 Docker、containerd 和 Kubernetes 在节点上真正做的全部事情。本文逐个手工搭建这些部件，再沿着软件栈往上走，把机制和生产中遇到的问题对应起来。

## Namespace：共享资源上的私有视图

Namespace 把一个全局内核资源包起来，让其中的进程看到自己独立的一份。Linux 目前有八种：

| Namespace | 标志 | 隔离内容 | 引入版本 |
|---|---|---|---|
| Mount | `CLONE_NEWNS` | 挂载表 | 2.4.19 |
| UTS | `CLONE_NEWUTS` | 主机名、域名 | 2.6.19 |
| IPC | `CLONE_NEWIPC` | System V IPC、POSIX 消息队列 | 2.6.19 |
| PID | `CLONE_NEWPID` | 进程号空间 | 2.6.24 |
| Network | `CLONE_NEWNET` | 网卡、路由、iptables/nftables、套接字 | 2.6.29 |
| User | `CLONE_NEWUSER` | UID/GID 映射、capabilities | 3.8 |
| cgroup | `CLONE_NEWCGROUP` | cgroup 层级的视图 | 4.6 |
| Time | `CLONE_NEWTIME` | `CLOCK_MONOTONIC` / `CLOCK_BOOTTIME` 偏移 | 5.6 |

所有工作由三个系统调用完成：`clone()` 在新 Namespace 中创建子进程，`unshare()` 把调用者移入新 Namespace，`setns()` 加入已有的 Namespace（`docker exec`、`kubectl exec` 用的就是这种类似 `nsenter` 的逻辑）。每个 Namespace 都以文件形式出现在 `/proc/<pid>/ns/` 下：

```bash
$ ls -l /proc/self/ns
lrwxrwxrwx ... cgroup -> 'cgroup:[4026531835]'
lrwxrwxrwx ... mnt -> 'mnt:[4026531841]'
lrwxrwxrwx ... net -> 'net:[4026531840]'
lrwxrwxrwx ... pid -> 'pid:[4026531836]'
...
```

两个进程处于同一个 Namespace，当且仅当这些 inode 号相同。Kubernetes 的 Pod 就是几个**共享**网络、IPC（以及可选的 PID）Namespace、但各自拥有独立挂载 Namespace 的容器——这正是 Pod 内容器能通过 `localhost` 互相通信的原因。

### 一条命令造一个容器

借助 util-linux 的 `unshare`，再加上 User Namespace，无需 root 就能看清原理：

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

在里面，这个 shell 是 PID 1，以为自己是 root，有自己的主机名，只能看到一个回环网卡；在外面，它只是一个拥有普通 PID 的非特权进程。没有任何东西被虚拟化，只是内核对同样的问题给出了不同的回答。

用 Go 写也一样，早期的容器运行时就是这么写的：

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
		// 把容器内的 root(0) 映射为宿主机上的当前用户
		UidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}},
		GidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}},
	}
	if err := cmd.Run(); err != nil {
		panic(err)
	}
}
```

### 为什么 User Namespace 如此重要

User Namespace 是改变安全格局的那一个。在它内部，进程可以拥有 `CAP_SYS_ADMIN`、可以是 UID 0，但这些特权**只作用于该 Namespace 所拥有的资源**。映射回宿主机，它是 UID 100000（或 `/etc/subuid` 分配的任意范围）。从启用了 User Namespace 的容器逃逸出去，落地的是一个非特权用户，而不是真正的 root。

这就是 rootless Docker 和 Podman 存在的原因，也是 Kubernetes 为 Pod 增加 `hostUsers: false`（自 v1.30 起为 beta）的原因。历史上大多数容器*没有*使用 User Namespace，所以"容器里的 root"就是宿主机上真正的 root，只是被 capabilities、seccomp 和 LSM 限制住——阅读任何容器 CVE 时都要记住这一点。

## 根文件系统：pivot_root、分层与 OverlayFS

新的挂载 Namespace 一开始是父进程挂载表的副本。为了给进程一个自己的根目录，运行时先把镜像文件系统挂到某处，再调用 `pivot_root(new_root, put_old)`，然后卸载旧的根。（这里不用 `chroot`，因为拥有 `CAP_SYS_CHROOT` 的进程可以轻易逃出 chroot；`pivot_root` 是真正替换挂载 Namespace 的根。）

镜像是一摞只读层。每启动一个容器就把整摞层复制一遍既慢又浪费，所以运行时使用联合文件系统——几乎总是 **OverlayFS**（Linux 3.18 起进入主线）：

```bash
mkdir lower upper work merged
echo "from image" > lower/app.conf
sudo mount -t overlay overlay \
  -o lowerdir=lower,upperdir=upper,workdir=work merged

echo "changed" > merged/app.conf   # 触发 copy-up
rm merged/other-file               # 在 upper/ 中生成 whiteout
ls -l upper/
```

值得了解的机制：

- **查找**自上而下：先查 `upperdir`，再按顺序查每个 `lowerdir`（多层用冒号分隔）。
- **Copy-up**：对下层文件的第一次写入会把*整个文件*复制到 `upperdir`。给镜像层里一个 2 GB 的文件追加一行，就要复制 2 GB。所以数据库和日志应该放在卷（volume）上，而不是容器的可写层。
- **Whiteout**：删除下层文件会在 `upperdir` 中创建一个设备号为 0/0 的字符设备把它遮住；删除目录再重建，会通过扩展属性把它标记为 *opaque*。这也解释了为什么在 Dockerfile 后面的层里 `RUN rm -rf /big` 永远不会让镜像变小——字节仍留在前面的层里。
- **inode 与重命名的怪癖**：在未开启 `redirect_dir` 时，重命名下层目录历史上会返回 `EXDEV`；硬链接在 copy-up 之后可能断开。大多数软件察觉不到，但某些包管理器和构建工具会踩坑。

containerd 的 snapshotter 抽象让这一层可插拔（overlayfs、native、btrfs、zfs，以及 stargz 这类按需拉取文件内容的懒加载 snapshotter）。

## cgroups v2：计量与限额

Namespace 不限制任何东西：处于独立 PID Namespace 的进程仍然可以吃光宿主机全部内存。限制靠控制组。cgroup v2（统一层级，Linux 4.5 合入，如今是主流发行版的默认）在 `/sys/fs/cgroup` 下暴露一棵树，每个目录是一个组，每个文件是一个旋钮或一项统计：

```bash
cd /sys/fs/cgroup
cat cgroup.controllers             # 例如 cpuset cpu io memory hugetlb pids rdma misc
echo "+cpu +memory +pids" | sudo tee cgroup.subtree_control

sudo mkdir demo
echo "50000 100000" | sudo tee demo/cpu.max      # 每 100ms 用 50ms = 0.5 核
echo 256M          | sudo tee demo/memory.max
echo 128           | sudo tee demo/pids.max
echo $$            | sudo tee demo/cgroup.procs  # 把当前 shell 移进去

cat demo/memory.current demo/memory.events demo/cpu.stat
```

v1 中每个控制器各有一棵层级树，一个进程在不同树中可以处于不同位置；v2 则强制只有一棵树，有"内部节点不放进程"规则（启用控制器后只有叶子节点挂进程），并且支持可以安全委派给非特权用户的子树——这是 rootless 容器的基础。

### CPU：权重与配额

CPU 有两种完全不同的控制方式，把它们搞混是很多延迟谜案的根源。

- **`cpu.weight`**（1–10000，默认 100）是*按比例分享*。它只在争抢时起作用：两个组都忙时，权重 200 的组拿到的 CPU 是权重 100 的两倍；不忙时可以自由使用空闲 CPU。
- **`cpu.max`**（`配额 周期`）是由 CFS 带宽控制器执行的*硬上限*。设为 `50000 100000` 时，该组在每 100ms 窗口内最多运行 50ms 的 CPU 时间——这是**所有**线程、所有核加起来的总和。

第二点就是陷阱。一个限额 1 核的服务，在 8 核机器上跑 8 个繁忙线程，大约 12.5ms 墙钟时间就耗光了 100ms 配额，然后在该周期剩余的约 87.5ms 内**被节流**。平均利用率看起来是"1 核，没问题"，但 p99 延迟里全是这些停顿。可以直接看到：

```bash
$ cat /sys/fs/cgroup/<pod-cgroup>/cpu.stat
usage_usec 81234567
nr_periods 51234
nr_throttled 20345
throttled_usec 912345678
```

对延迟敏感的服务，`nr_throttled / nr_periods` 比例很高就是危险信号。处理办法大致按优先级：让运行时感知自己的限额，不要创建超出可用 CPU 的并行度（JVM 自 JDK 10 / 8u191 起默认遵循容器限额；Go 1.25 让默认 `GOMAXPROCS` 遵循 cgroup CPU 限额，更早的 Go 版本可以用 `go.uber.org/automaxprocs`）；保留 requests 的同时提高或去掉 CPU limits；在支持的内核上用 `cpu.max.burst` 允许短时突破配额。

### 内存：max、high 与 OOM killer

内存有几个语义不同的旋钮：

| 文件 | 行为 |
|---|---|
| `memory.max` | 硬上限。回收后仍无法降到上限以下时，内核会在组内 OOM 杀掉一个进程。 |
| `memory.high` | 节流点。超过后组被强制回收并减速，但不会被杀。 |
| `memory.low` / `memory.min` | 针对外部压力引发回收的软 / 硬保护。 |
| `memory.events` | 计数器：`high`、`max`、`oom`、`oom_kill`。 |
| `memory.oom.group` | 设为 `1` 时整组一起杀，而不是只挑一个受害者。 |

有两件事经常让人意外。第一，`memory.current` 包含**页缓存**——进程读写过的文件——而不仅仅是堆。其中很多缓存可回收，因此 Kubernetes 报告的是"working set"（用量减去非活跃文件页）并据此驱逐；一个只是流式读写文件的容器看起来"接近上限"，其实并不危险。第二，cgroup OOM 对应用是不可见的：进程收到 `SIGKILL`，容器以退出码 137 结束。应该去看 `memory.events`、`dmesg` 以及 Pod 的 `lastState.terminated.reason: OOMKilled`，而不是应用日志。

### PSI：度量争抢，而不是猜

自 Linux 4.20 起，PSI（Pressure Stall Information）按 cgroup 报告任务因等待资源而*停滞*的时间占比：`cpu.pressure`、`memory.pressure`、`io.pressure`。

```text
some avg10=12.50 avg60=8.31 avg300=4.02 total=123456789
full avg10=3.10 avg60=1.95 avg300=0.88 total=23456789
```

`some` 表示至少有一个任务停滞的时间比例；`full` 表示*所有*非空闲任务都停滞的时间比例。回答"这个负载是不是真的在受苦"，PSI 远比利用率靠谱；systemd-oomd 和 Meta 的 oomd 也正是用它在内核 OOM killer 出手之前采取行动。

## 加固：Capabilities、seccomp、LSM

Namespace 和 cgroup 负责隔离与计量，却不能阻止进程调用危险的内核接口。还有三层来做这件事：

- **Capabilities** 把 root 的权力拆成约 40 个单元（`CAP_NET_ADMIN`、`CAP_SYS_ADMIN`、`CAP_SYS_PTRACE` 等）。Docker 和 containerd 启动容器时只保留一个很短的允许列表（如 `CHOWN`、`NET_BIND_SERVICE`、`SETUID`），其余全部丢弃。`--privileged` 会授予全部能力并关闭大多数其他保护——应把它视为"已经不是容器"。
- **seccomp-bpf** 用一段在每次系统调用时执行的 BPF 程序过滤系统调用。Docker 默认配置会拦截几十个很少需要、历史上又很危险的调用，比如 `kexec_load`、`open_by_handle_at`、`bpf`，以及创建 Namespace 的 `clone`/`unshare` 变体。Kubernetes 默认*不*启用它；需要设置 `securityContext.seccompProfile.type: RuntimeDefault`（或开启 kubelet 的 `--seccomp-default`）。
- **LSM**——AppArmor 或 SELinux——即使对 root 也施加强制访问控制。

`no_new_privs`（在 Kubernetes 中由 `allowPrivilegeEscalation: false` 设置）补上最后一环，确保 setuid 程序在 `execve` 之后无法重新获得特权。

一个加固过的 Pod 配置把它们组合起来：

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

## 运行时栈：从 `kubectl apply` 到 `execve`

理解了这些原语，各层软件的分工就清楚了：

```text
kubelet ──CRI (gRPC)──► containerd / CRI-O
                            │  拉取镜像，通过 snapshotter 解包各层
                            ▼
                      containerd-shim-runc-v2  （每个 Pod/容器一个，containerd 重启也不受影响）
                            │  OCI bundle：config.json + rootfs
                            ▼
                          runc  （启动完成即退出）
                            │  clone(namespaces) → cgroups → 挂载 → pivot_root
                            │  → capabilities → seccomp → execve(entrypoint)
                            ▼
                      你的进程（在其 PID Namespace 中是 PID 1）
```

- **OCI 运行时规范**定义了 `config.json` 契约——Namespace、挂载、cgroup 路径与限额、capabilities、seccomp 配置、进程参数。**OCI 镜像规范**定义了层与 manifest。任何符合规范的运行时（runc、crun、youki）都能执行同一个 bundle。
- **runc** 是一个短命的初始化工具：配置好一切，`execve` 你的入口程序，然后退出。**shim** 留下来作为进程的父进程，使 containerd 重启时不会杀掉容器，并保住退出码和标准输入输出。
- 这个顺序对安全至关重要。runc 恰恰在这个初始化阶段出过严重的逃逸漏洞：CVE-2019-5736 让恶意容器能通过 `/proc/self/exe` 覆盖宿主机上的 `runc` 二进制；CVE-2024-21626（"Leaky Vessels"）经由工作目录把宿主机目录的文件描述符泄漏进容器。两者都已修复，但它们说明真正的攻击面是共享内核和特权初始化路径。

## PID 1 很特殊

入口程序在自己的 PID Namespace 中成为 PID 1，而内核对 PID 1 区别对待：

- 对于没有安装处理函数的信号，PID 1 会**忽略**。依赖 `SIGTERM` 默认行为的程序在 `docker stop` 或 Pod 终止时不会退出，宽限期（Kubernetes 默认 30 秒）结束后被 `SIGKILL`。
- PID 1 必须**回收孤儿子进程**。一个派生子进程却不回收的 shell 脚本或 Node 进程会不断积累僵尸进程，直到触及 `pids.max`。
- PID 1 退出时，内核会杀掉该 Namespace 中的所有其他进程。

解决办法：显式处理 `SIGTERM`；使用 exec 形式的 `ENTRYPOINT`（`["app"]`，而不是经由 `/bin/sh -c` 的 `app`，后者会让 shell 成为 PID 1）；或者运行一个极简 init，比如 `tini`（`docker run --init`）。

## 当共享内核不够用时

节点上所有容器共享同一个内核。任何能通过被允许的系统调用触达的内核漏洞，都是跨租户逃逸。对于不可信代码——来自 fork 的 CI 任务、用户提交的函数、多租户 SaaS——有更强的隔离边界，它们都作为替代 OCI 运行时接入（Kubernetes `RuntimeClass`）：

| 运行时 | 隔离模型 | 代价 |
|---|---|---|
| runc / crun | 在宿主机内核上用 Namespace + cgroup + seccomp | 接近原生；内核攻击面最大 |
| gVisor（`runsc`） | 用户态内核（Sentry）拦截系统调用，只有一小部分到达宿主机 | 系统调用和 I/O 密集型负载变慢；存在部分兼容性问题 |
| Kata Containers | 每个 Pod 运行在带独立客户机内核的轻量级虚拟机里 | 每个 Pod 额外内存、启动更慢；有硬件级边界 |
| Firecracker microVM | 为 Serverless 设计的极简 VMM（AWS Lambda 与 Fargate 在用） | 作为虚拟机启动很快；需要外围编排层 |

一般原则：自己写、自己信任的代码用 runc，不信任的代码用沙箱运行时。

## 生产检查清单

- **CPU**：所有负载都设 requests；对延迟敏感的服务慎重设置 limits；关注 `nr_throttled`；让运行时感知限额（`GOMAXPROCS`、JVM 容器支持、线程池大小）。
- **内存**：按 working set 加余量设置上限；对 `memory.events` 中的 `oom_kill` 以及原因为 `OOMKilled` 的重启告警；记住页缓存也算在内。
- **文件系统**：大量写入放到卷上；使用 `readOnlyRootFilesystem` 并用 `emptyDir` 做临时空间；用多阶段构建，而不是在后面的层里删文件。
- **安全**：非 root 运行、丢弃所有 capabilities、`RuntimeDefault` seccomp、不用 `privileged`、考虑 `hostUsers: false`；及时给 runc/containerd 打补丁。
- **生命周期**：exec 形式的入口、显式处理 `SIGTERM`、会派生子进程时加一个 init。
- **排障**：`nsenter -t <pid> -n` 只进入容器的网络 Namespace 并使用宿主机上的工具；`cat /proc/<pid>/cgroup` 找到它的 cgroup；用 `kubectl debug` 加临时容器共享其 Namespace。

## 总结

容器是一个拥有私有视图（Namespace）、预算（cgroup）、受限权限（capabilities、seccomp、LSM）和由多层拼接而成的根文件系统（OverlayFS）的进程。runc 根据 OCI bundle 把这些组装起来然后退场；containerd 和 kubelet 围绕它管理生命周期。生产中几乎所有容器意外——CPU 使用率"不高"却延迟被节流、神秘的退出码 137、往大文件里写入很慢、容器不响应关停、以及能打到宿主机的逃逸——都直接源于这些内核机制；一旦知道该去读 `/proc` 或 `/sys/fs/cgroup` 下的哪个文件，它们就变得可以排查了。

## 参考资料

- Linux man-pages：[namespaces(7)](https://man7.org/linux/man-pages/man7/namespaces.7.html)、[user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)、[cgroups(7)](https://man7.org/linux/man-pages/man7/cgroups.7.html)、[pivot_root(2)](https://man7.org/linux/man-pages/man2/pivot_root.2.html)
- Linux 内核文档，[Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- Linux 内核文档，[Overlay Filesystem](https://docs.kernel.org/filesystems/overlayfs.html)
- Linux 内核文档，[PSI — Pressure Stall Information](https://docs.kernel.org/accounting/psi.html)
- Open Container Initiative，[Runtime Specification](https://github.com/opencontainers/runtime-spec) 与 [Image Specification](https://github.com/opencontainers/image-spec)
- Kubernetes 文档，[About cgroup v2](https://kubernetes.io/docs/concepts/architecture/cgroups/) 与 [User Namespaces](https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/)
- Docker 文档，[Seccomp security profiles for Docker](https://docs.docker.com/engine/security/seccomp/)
- Go 博客，[Container-aware GOMAXPROCS](https://go.dev/blog/container-aware-gomaxprocs)（2025）
- [gVisor 文档](https://gvisor.dev/docs/) 与 [Kata Containers](https://katacontainers.io/)

/**
 * Tourbillon sandbox egress filter (LD_PRELOAD).
 *
 * Landlock: deny all TCP except (proxy mode) loopback helper port 17999.
 * seccomp (x86_64): deny AF_INET/AF_INET6 in deny mode; deny SOCK_DGRAM in proxy mode.
 * Proxy mode: a constructor helper listens on 127.0.0.1:PORT and forwards to
 * TOURBILLON_EGRESS_PROXY_SOCKET. Combined with bwrap --unshare-net, that port
 * is only reachable on the sandbox loopback (no same-port internet bypass).
 *
 * TCP/53 is never allowed. The host-side proxy performs DNS.
 */
#define _GNU_SOURCE

#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif
#ifndef __NR_seccomp
#define __NR_seccomp 317
#endif

#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#endif
#ifndef SECCOMP_SET_MODE_FILTER
#define SECCOMP_SET_MODE_FILTER 1
#endif
#ifndef SECCOMP_RET_ERRNO
#define SECCOMP_RET_ERRNO 0x00050000U
#endif
#ifndef SECCOMP_RET_ALLOW
#define SECCOMP_RET_ALLOW 0x7fff0000U
#endif
#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS 0x80000000U
#endif
#ifndef SOCK_TYPE_MASK
#define SOCK_TYPE_MASK 0xf
#endif

static int ll_create_ruleset(const struct landlock_ruleset_attr *attr, size_t size, unsigned int flags)
{
	return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int ll_add_rule(int fd, enum landlock_rule_type type, const void *attr, unsigned int flags)
{
	return (int)syscall(__NR_landlock_add_rule, fd, type, attr, flags);
}

static int ll_restrict_self(int fd, unsigned int flags)
{
	return (int)syscall(__NR_landlock_restrict_self, fd, flags);
}

static void fail_closed(const char *msg)
{
	fprintf(stderr, "tourbillon-egress-filter: %s (errno=%d)\n", msg, errno);
	const char *enf = getenv("TOURBILLON_EGRESS_ENFORCE");
	if (enf && strcmp(enf, "1") == 0) {
		_exit(78);
	}
}

static int allow_port(int ruleset_fd, unsigned long port, __u64 access)
{
	struct landlock_net_port_attr net = {
		.allowed_access = access,
		.port = port,
	};
	return ll_add_rule(ruleset_fd, LANDLOCK_RULE_NET_PORT, &net, 0);
}

static int apply_landlock(int proxy_mode, unsigned long proxy_port)
{
	int abi = ll_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
	if (abi < 4) {
		fail_closed("Landlock network ABI 4+ is required");
		return -1;
	}

	struct landlock_ruleset_attr attr;
	memset(&attr, 0, sizeof(attr));
	attr.handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP;

	int fd = ll_create_ruleset(&attr, sizeof(attr), 0);
	if (fd < 0) {
		fail_closed("landlock_create_ruleset failed");
		return -1;
	}

	if (proxy_mode) {
		__u64 both = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP;
		if (allow_port(fd, proxy_port, both) != 0) {
			close(fd);
			fail_closed("failed to allow helper port");
			return -1;
		}
	}

	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 && errno != EPERM) {
		close(fd);
		fail_closed("PR_SET_NO_NEW_PRIVS failed");
		return -1;
	}
	if (ll_restrict_self(fd, 0) != 0) {
		close(fd);
		fail_closed("landlock_restrict_self failed");
		return -1;
	}
	close(fd);
	return 0;
}

#ifdef __x86_64__
static int apply_seccomp(int deny_all_inet)
{
	struct sock_filter filter_deny_all[] = {
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 2, 0),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & 0xffff)),
	};
	struct sock_filter filter_deny_dgram[] = {
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 2, 0),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
		BPF_STMT(BPF_ALU | BPF_AND | BPF_K, SOCK_TYPE_MASK),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_DGRAM, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & 0xffff)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_RAW, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & 0xffff)),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
	};

	struct sock_fprog prog;
	if (deny_all_inet) {
		prog.len = (unsigned short)(sizeof(filter_deny_all) / sizeof(filter_deny_all[0]));
		prog.filter = filter_deny_all;
	} else {
		prog.len = (unsigned short)(sizeof(filter_deny_dgram) / sizeof(filter_deny_dgram[0]));
		prog.filter = filter_deny_dgram;
	}
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 && errno != EPERM) {
		fail_closed("PR_SET_NO_NEW_PRIVS failed");
		return -1;
	}
	if (syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) != 0) {
		fail_closed("seccomp filter failed");
		return -1;
	}
	return 0;
}
#else
static int apply_seccomp(int deny_all_inet)
{
	(void)deny_all_inet;
	fail_closed("seccomp UDP block requires x86_64");
	return -1;
}
#endif

/* bwrap --unshare-net leaves lo down; HTTP_PROXY=127.0.0.1 needs it up. */
static void bring_lo_up(void)
{
	int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0) {
		return;
	}
	struct ifreq ifr;
	memset(&ifr, 0, sizeof(ifr));
	strncpy(ifr.ifr_name, "lo", IFNAMSIZ - 1);
	if (ioctl(fd, SIOCGIFFLAGS, &ifr) == 0) {
		ifr.ifr_flags |= IFF_UP | IFF_RUNNING;
		ioctl(fd, SIOCSIFFLAGS, &ifr);
	}
	close(fd);
}

static int write_all(int fd, const char *p, ssize_t left)
{
	while (left > 0) {
		ssize_t w = write(fd, p, (size_t)left);
		if (w <= 0) {
			return -1;
		}
		left -= w;
		p += w;
	}
	return 0;
}

static void pump(int a, int b)
{
	struct pollfd fds[2];
	char buf[8192];
	int a_open = 1;
	int b_open = 1;

	while (a_open || b_open) {
		int nfd = 0;
		if (a_open) {
			fds[nfd].fd = a;
			fds[nfd].events = POLLIN;
			nfd++;
		}
		if (b_open) {
			fds[nfd].fd = b;
			fds[nfd].events = POLLIN;
			nfd++;
		}
		if (nfd == 0) {
			break;
		}
		if (poll(fds, (nfds_t)nfd, -1) < 0) {
			if (errno == EINTR) {
				continue;
			}
			break;
		}
		for (int i = 0; i < nfd; i++) {
			if (!(fds[i].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL))) {
				continue;
			}
			int from = fds[i].fd;
			int to = from == a ? b : a;
			ssize_t n = read(from, buf, sizeof(buf));
			if (n <= 0) {
				shutdown(to, SHUT_WR);
				if (from == a) {
					a_open = 0;
				} else {
					b_open = 0;
				}
				continue;
			}
			if (write_all(to, buf, n) != 0) {
				a_open = 0;
				b_open = 0;
				break;
			}
		}
	}
	close(a);
	close(b);
}

struct forwarder_state {
	int lfd;
	char sock[108];
};

static void *forwarder_main(void *arg)
{
	struct forwarder_state *st = arg;
	int lfd = st->lfd;
	struct sockaddr_un un;
	memset(&un, 0, sizeof(un));
	un.sun_family = AF_UNIX;
	strncpy(un.sun_path, st->sock, sizeof(un.sun_path) - 1);
	free(st);
	signal(SIGCHLD, SIG_IGN);

	for (;;) {
		int client = accept(lfd, NULL, NULL);
		if (client < 0) {
			if (errno == EINTR) {
				continue;
			}
			break;
		}
		int upstream = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
		if (upstream < 0) {
			close(client);
			continue;
		}
		if (connect(upstream, (struct sockaddr *)&un, sizeof(un)) != 0) {
			close(upstream);
			close(client);
			continue;
		}
		pid_t cpid = fork();
		if (cpid < 0) {
			close(upstream);
			close(client);
			continue;
		}
		if (cpid == 0) {
			close(lfd);
			pump(client, upstream);
			_exit(0);
		}
		close(client);
		close(upstream);
	}
	close(lfd);
	return NULL;
}

static int bind_loopback(int family, unsigned long port)
{
	int lfd = socket(family, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (lfd < 0) {
		return -1;
	}
	int yes = 1;
	setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
	if (family == AF_INET6) {
		setsockopt(lfd, IPPROTO_IPV6, IPV6_V6ONLY, &yes, sizeof(yes));
		struct sockaddr_in6 addr;
		memset(&addr, 0, sizeof(addr));
		addr.sin6_family = AF_INET6;
		addr.sin6_addr = in6addr_loopback;
		addr.sin6_port = htons((uint16_t)port);
		if (bind(lfd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(lfd, 32) != 0) {
			close(lfd);
			return -1;
		}
		return lfd;
	}
	struct sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	addr.sin_port = htons((uint16_t)port);
	if (bind(lfd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(lfd, 32) != 0) {
		close(lfd);
		return -1;
	}
	return lfd;
}

static void __attribute__((constructor)) tourbillon_apply_egress_filter(void)
{
	const char *mode = getenv("TOURBILLON_EGRESS_MODE");
	int proxy_mode = mode && strcmp(mode, "proxy") == 0;
	unsigned long port = 17999;
	const char *port_s = getenv("TOURBILLON_EGRESS_PROXY_PORT");
	if (port_s && port_s[0]) {
		char *end = NULL;
		unsigned long parsed = strtoul(port_s, &end, 10);
		if (end != port_s && parsed > 0 && parsed <= 65535) {
			port = parsed;
		}
	}

	const char *sock = getenv("TOURBILLON_EGRESS_PROXY_SOCKET");
	if (proxy_mode && (!sock || !sock[0])) {
		fail_closed("TOURBILLON_EGRESS_PROXY_SOCKET is required in proxy mode");
		return;
	}

	if (apply_landlock(proxy_mode, port) != 0) {
		return;
	}
	if (proxy_mode) {
		bring_lo_up();
	}
	if (apply_seccomp(!proxy_mode) != 0) {
		return;
	}

	if (!proxy_mode) {
		return;
	}

	int lfds[2] = {
		bind_loopback(AF_INET, port),
		bind_loopback(AF_INET6, port),
	};
	if (lfds[0] < 0 && lfds[1] < 0) {
		/* Parent shell already started the helper. */
		return;
	}
	for (int i = 0; i < 2; i++) {
		if (lfds[i] < 0) continue;
		struct forwarder_state *st = malloc(sizeof(*st));
		if (!st) {
			close(lfds[i]);
			continue;
		}
		st->lfd = lfds[i];
		memset(st->sock, 0, sizeof(st->sock));
		strncpy(st->sock, sock, sizeof(st->sock) - 1);
		pid_t pid = fork();
		if (pid < 0) {
			free(st);
			close(lfds[i]);
			continue;
		}
		if (pid == 0) {
			prctl(PR_SET_PDEATHSIG, SIGKILL);
			forwarder_main(st);
			_exit(0);
		}
		close(lfds[i]);
	}
}

/**
 * Tourbillon sandbox egress Landlock filter (Linux ABI 4+).
 *
 * Loaded via LD_PRELOAD. A constructor applies a Landlock network ruleset
 * that is inherited by children and cannot be unset (unlike LD_PRELOAD itself).
 *
 * Environment:
 *   TOURBILLON_EGRESS_PROXY_PORT  If set, TCP connect is allowed only to this
 *                                 port (the per-run egress proxy) and to port 53
 *                                 (TCP DNS). If unset, all TCP connect is denied.
 *   TOURBILLON_EGRESS_ENFORCE     If "1", abort the process when Landlock cannot
 *                                 be applied (fail closed).
 */
#define _GNU_SOURCE

#include <errno.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
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

#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
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

static int allow_connect_port(int ruleset_fd, unsigned long port)
{
	struct landlock_net_port_attr net = {
		.allowed_access = LANDLOCK_ACCESS_NET_CONNECT_TCP,
		.port = port,
	};
	return ll_add_rule(ruleset_fd, LANDLOCK_RULE_NET_PORT, &net, 0);
}

static void fail_closed(const char *msg)
{
	fprintf(stderr, "tourbillon-egress-landlock: %s (errno=%d)\n", msg, errno);
	if (getenv("TOURBILLON_EGRESS_ENFORCE") && strcmp(getenv("TOURBILLON_EGRESS_ENFORCE"), "1") == 0) {
		_exit(78);
	}
}

static void __attribute__((constructor)) tourbillon_apply_egress_landlock(void)
{
	int abi = ll_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
	if (abi < 4) {
		fail_closed("Landlock network ABI 4+ is required to enforce egress");
		return;
	}

	struct landlock_ruleset_attr attr;
	memset(&attr, 0, sizeof(attr));
	attr.handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP;

	int fd = ll_create_ruleset(&attr, sizeof(attr), 0);
	if (fd < 0) {
		fail_closed("landlock_create_ruleset failed");
		return;
	}

	const char *port_s = getenv("TOURBILLON_EGRESS_PROXY_PORT");
	if (port_s && port_s[0] != '\0') {
		char *end = NULL;
		unsigned long port = strtoul(port_s, &end, 10);
		if (end == port_s || port == 0 || port > 65535) {
			close(fd);
			fail_closed("invalid TOURBILLON_EGRESS_PROXY_PORT");
			return;
		}
		if (allow_connect_port(fd, port) != 0) {
			close(fd);
			fail_closed("failed to allow proxy port");
			return;
		}
		/* TCP DNS so allowed hosts can be resolved by name. */
		if (allow_connect_port(fd, 53) != 0) {
			close(fd);
			fail_closed("failed to allow DNS port");
			return;
		}
	}

	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 && errno != EPERM) {
		/* EPERM means no_new_privs is already set — that is fine. */
		if (errno != EPERM) {
			close(fd);
			fail_closed("PR_SET_NO_NEW_PRIVS failed");
			return;
		}
	}

	if (ll_restrict_self(fd, 0) != 0) {
		close(fd);
		fail_closed("landlock_restrict_self failed");
		return;
	}
	close(fd);
}

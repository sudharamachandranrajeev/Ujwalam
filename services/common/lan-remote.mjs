// SPDX-License-Identifier: GPL-3.0-or-later
// LAN-only rules for "Allow remote connections" (D327 IN1; LAN remote rules of the settled design: token + pairing,
// never reachable from outside the LAN). Pure functions, Node stdlib only; used by the event-core LAN listener and the
// Integrations page.
//
//   - Bind address: one private IPv4 address of this machine (10/8, 172.16/12, 192.168/16). Never 0.0.0.0, never a
//     public address, never IPv6 (a global IPv6 address is reachable from outside the LAN on most home routers).
//   - Peers: only addresses in the same subnet as the bind address (interface netmask). A forwarded port from the
//     router arrives with an outside address and is refused at the socket, before any byte is read.
//   - Link-local (169.254/16), loopback and CGNAT (100.64/10, shared with the provider) are not "the LAN" here.

import os from 'node:os';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4 dotted quad to a 32-bit unsigned number, or null. Accepts the IPv4-mapped IPv6 form (::ffff:a.b.c.d). */
export function ipv4ToInt(s) {
  if (typeof s !== 'string') return null;
  const m = IPV4.exec(s.startsWith('::ffff:') ? s.slice(7) : s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255) || m.slice(1).some((x) => x.length > 1 && x.startsWith('0'))) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const inNet = (ip, net, bits) => (bits === 0 ? true : ((ip ^ net) >>> (32 - bits)) === 0);
const PRIVATE = [[ipv4ToInt('10.0.0.0'), 8], [ipv4ToInt('172.16.0.0'), 12], [ipv4ToInt('192.168.0.0'), 16]];

/** True only for an RFC 1918 private IPv4 address (dotted quad). */
export function isPrivateIPv4(s) {
  const ip = ipv4ToInt(s);
  if (ip === null || s.startsWith('::ffff:')) return false;
  return PRIVATE.some(([n, b]) => inNet(ip, n, b));
}

/** Prefix length of a dotted netmask (255.255.255.0 -> 24), or null when it is not a contiguous mask. */
export function prefixOf(mask) {
  const m = ipv4ToInt(mask);
  if (m === null) return null;
  const host = (~m) >>> 0; // host bits must be 0...01...1
  if ((host & (host + 1)) !== 0) return null;
  return host === 0 ? 32 : Math.clz32(host);
}

/**
 * The private IPv4 addresses of this machine: [{ address, prefixLen, iface }], from os.networkInterfaces().
 * A subnet wider than /8 is left out (a mask like that is not a home or office LAN). interfaces: test seam.
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [iface, list] of Object.entries(interfaces ?? {})) {
    for (const a of list ?? []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || !isPrivateIPv4(a.address)) continue;
      const prefixLen = typeof a.cidr === 'string' ? Number(a.cidr.split('/')[1]) : prefixOf(a.netmask);
      if (!Number.isInteger(prefixLen) || prefixLen < 8 || prefixLen > 30) continue;
      out.push({ address: a.address, prefixLen, iface });
    }
  }
  return out;
}

/**
 * The bind address for the LAN listener: the preferred address when it is one of lanAddresses(), else the first one.
 * null when this machine has no private IPv4 address (then remote connections stay off).
 */
export function chooseLanBind({ preferred, interfaces } = {}) {
  const all = lanAddresses(interfaces);
  if (preferred !== undefined && preferred !== null && preferred !== '') return all.find((a) => a.address === preferred) ?? null;
  return all[0] ?? null;
}

/** True when peer (a socket's remoteAddress) is an IPv4 address in the bind address's subnet. */
export function sameSubnet(peer, bind) {
  const ip = ipv4ToInt(peer);
  const net = ipv4ToInt(bind?.address);
  if (ip === null || net === null || !Number.isInteger(bind.prefixLen) || bind.prefixLen < 8 || bind.prefixLen > 30) return false;
  return isPrivateIPv4(peer.startsWith('::ffff:') ? peer.slice(7) : peer) && inNet(ip, net, bind.prefixLen);
}

/** Throws unless bind is a usable LAN bind ({ address: private IPv4, prefixLen 8..30 }). */
export function assertLanBind(bind) {
  if (!bind || typeof bind !== 'object') throw new RangeError('remote connections need a LAN bind address');
  if (!isPrivateIPv4(bind.address)) throw new RangeError('remote connections bind a private IPv4 LAN address only (never 0.0.0.0 or a public address)');
  if (!Number.isInteger(bind.prefixLen) || bind.prefixLen < 8 || bind.prefixLen > 30) throw new RangeError('remote connections need the LAN subnet (prefix 8..30)');
}

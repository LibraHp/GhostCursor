import { validIpv4, type MappedUdp } from './network';

// Advertise an extra srflx candidate for the same local ICE socket. Keep the
// original LAN candidate as well; don't rewrite the peer's local description.
export function mappedCandidate(candidate: RTCIceCandidateInit, mapping: MappedUdp): RTCIceCandidateInit | null {
  if (!Number.isInteger(mapping.localPort) || mapping.localPort < 1024 || mapping.localPort > 65535 || !Number.isInteger(mapping.publicPort) || mapping.publicPort < 1 || mapping.publicPort > 65535) return null;
  const tokens = candidate.candidate?.trim().split(/\s+/);
  if (!tokens || tokens.length < 8 || !tokens[0].startsWith('candidate:') || tokens[1] !== '1' || tokens[2].toLowerCase() !== 'udp' || Number(tokens[5]) !== mapping.localPort || tokens[6] !== 'typ' || tokens[7] !== 'host' || !validIpv4(mapping.publicHost)) return null;
  // IPv6 sockets cannot be advertised behind an IPv4 port mapping. Chromium
  // may conceal IPv4 host addresses with mDNS; raddr is allowed to be hidden.
  if (tokens[4].includes(':')) return null;
  const ufrag = candidate.usernameFragment || (() => { const index = tokens.indexOf('ufrag'); return index >= 0 ? tokens[index + 1] : undefined; })();
  return {
    candidate: `candidate:gcmap 1 udp 1694498815 ${mapping.publicHost} ${mapping.publicPort} typ srflx raddr 0.0.0.0 rport 0${ufrag ? ` ufrag ${ufrag}` : ''}`,
    sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex,
    ...(ufrag ? { usernameFragment: ufrag } : {}),
  };
}

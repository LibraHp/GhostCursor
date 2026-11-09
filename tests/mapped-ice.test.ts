import test from 'node:test';
import assert from 'node:assert/strict';
import { mappedCandidate } from '../src/shared/mapped-ice';
import { DEFAULT_NETWORK, rtcConfiguration, storedNetwork, validNetwork, type NetworkSettings } from '../src/shared/network';

const mapping = { localPort: 40000, publicHost: '203.0.113.10', publicPort: 45000 };
const host: RTCIceCandidateInit = { candidate: 'candidate:123 1 udp 2122260223 192.168.1.20 40000 typ host generation 0 ufrag sessionA', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'sessionA' };

test('fixed mapping advertises the external port and preserves ICE credentials and media identity', () => {
  const original = { ...host };
  const mapped = mappedCandidate(host, mapping)!;
  assert.match(mapped.candidate!, /203\.0\.113\.10 45000 typ srflx raddr 0\.0\.0\.0 rport 0 ufrag sessionA$/);
  assert.equal(mapped.sdpMid, host.sdpMid);
  assert.equal(mapped.sdpMLineIndex, host.sdpMLineIndex);
  assert.equal(mapped.usernameFragment, 'sessionA');
  assert.deepEqual(host, original);
  assert.equal(mappedCandidate({ ...host, usernameFragment: undefined }, mapping)?.usernameFragment, 'sessionA');
  assert.ok(mappedCandidate({ ...host, candidate: host.candidate!.replace('192.168.1.20', 'random-id.local') }, mapping));
});

test('fixed mapping rejects unrelated ports, TCP, IPv6, non-host candidates and invalid addresses', () => {
  for (const candidate of [host.candidate!.replace('40000', '40001'), host.candidate!.replace('udp', 'tcp'), host.candidate!.replace('192.168.1.20', '2001:db8::1'), host.candidate!.replace('typ host', 'typ srflx'), host.candidate!.replace(' 1 udp', ' 2 udp'), '']) assert.equal(mappedCandidate({ ...host, candidate }, mapping), null);
  assert.equal(mappedCandidate(host, { ...mapping, publicHost: 'example.com' }), null);
});

test('fixed mode ignores saved STUN and TURN policy and requires a usable IPv4 mapping', () => {
  const settings: NetworkSettings = { ...DEFAULT_NETWORK, transport: 'webrtc-mapped', mappedUdp: mapping, relayOnly: true };
  assert.equal(validNetwork(settings), true);
  assert.deepEqual(rtcConfiguration(settings), { iceServers: [], iceTransportPolicy: 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  for (const publicHost of ['', '256.1.1.1', '127.0.0.1', '224.1.1.1', 'https://203.0.113.10', '203.0.113.10:45000']) assert.equal(validNetwork({ ...settings, mappedUdp: { ...mapping, publicHost } }), false);
  assert.equal(validNetwork({ ...settings, mappedUdp: { ...mapping, localPort: 1023 } }), false);
  assert.equal(validNetwork({ ...settings, mappedUdp: { ...mapping, publicPort: 65536 } }), false);
});

test('old network settings acquire mapping defaults without changing transport or custom STUN', () => {
  const { mappedUdp: _, autoStun: __, ...old } = DEFAULT_NETWORK;
  const restored = storedNetwork({ ...old, transport: 'webrtc', stunUrls: ['stun:custom.example.com:3478'] })!;
  assert.equal(restored.transport, 'webrtc');
  assert.equal(restored.autoStun, false);
  assert.deepEqual(restored.mappedUdp, DEFAULT_NETWORK.mappedUdp);
  assert.equal(validNetwork(restored), true);
});

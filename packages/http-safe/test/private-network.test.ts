import { describe, expect, it } from 'vitest';
import { isPrivateOrLoopbackAddress } from '../src/private-network.js';

describe('isPrivateOrLoopbackAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.0.1', true],
    ['192.168.255.255', true],
    ['169.254.1.1', true],
    ['0.0.0.0', true],
  ])('bloqueia IPv4 %s', (ip, expected) => {
    expect(isPrivateOrLoopbackAddress(ip)).toBe(expected);
  });

  it.each([
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.32.0.1', false], // fora do /12 de 172.16.0.0
    ['192.169.0.1', false],
    ['203.0.113.10', false],
  ])('permite IPv4 público %s', (ip, expected) => {
    expect(isPrivateOrLoopbackAddress(ip)).toBe(expected);
  });

  it.each([
    ['::1', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12:3456:789a::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:10.0.0.5', true],
  ])('bloqueia IPv6 %s', (ip, expected) => {
    expect(isPrivateOrLoopbackAddress(ip)).toBe(expected);
  });

  it.each([
    ['2001:4860:4860::8888', false],
    ['::ffff:8.8.8.8', false],
  ])('permite IPv6 público %s', (ip, expected) => {
    expect(isPrivateOrLoopbackAddress(ip)).toBe(expected);
  });

  it('trata string não-IP (hostname não resolvido) como não confiável', () => {
    expect(isPrivateOrLoopbackAddress('exemplo.com')).toBe(true);
  });
});

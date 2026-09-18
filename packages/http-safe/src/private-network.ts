import { isIP } from 'node:net';

/**
 * Detecta endereços loopback, link-local e de rede privada — o alvo mínimo
 * que o `SafeHttpClient` (M4) precisa bloquear para não virar um proxy para
 * a rede interna (SSRF). Não é um registro exaustivo de faixas reservadas
 * IANA — é o conjunto que a especificação do M4 pede explicitamente:
 * "destinos loopback, link-local e redes privadas".
 */

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inIpv4Range(ip: string, base: string, prefixLength: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const IPV4_BLOCKED_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['127.0.0.0', 8], // loopback
  ['10.0.0.0', 8], // privada
  ['172.16.0.0', 12], // privada
  ['192.168.0.0', 16], // privada
  ['169.254.0.0', 16], // link-local
  ['0.0.0.0', 8], // "esta rede" / inválido como destino
];

function isPrivateOrLoopbackIpv4(ip: string): boolean {
  return IPV4_BLOCKED_RANGES.some(([base, prefix]) => inIpv4Range(ip, base, prefix));
}

/** IPv6 simplificado: só os prefixos que a spec do M4 pede — loopback, link-local, unique-local. */
function isPrivateOrLoopbackIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true; // loopback
  if (normalized.startsWith('fe80:') || normalized.startsWith('fe8') || /^fe[89ab][0-9a-f]:/.test(normalized)) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // unique local fc00::/7
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — extrai o IPv4 e valida de novo.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateOrLoopbackIpv4(mapped[1]!);
  return false;
}

export function isPrivateOrLoopbackAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateOrLoopbackIpv4(ip);
  if (version === 6) return isPrivateOrLoopbackIpv6(ip);
  // Não é um IP literal válido — quem chama decidiu resolver DNS antes; trata como não confiável.
  return true;
}

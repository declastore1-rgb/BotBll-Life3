import {
  createHmac,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(nodeScrypt);
const SESSION_DURATION_MS = 12 * 60 * 60 * 1_000;
const SESSION_DURATION_SECONDS = Math.floor(SESSION_DURATION_MS / 1_000);
const PRINCIPAL_TYPES = new Set(['staff', 'client']);

export function safeTokenEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: Buffer.from(derived).toString('hex') };
}

export async function verifyPassword(password, salt, expectedHash) {
  const derived = await scrypt(password, salt, 64);
  return safeTokenEqual(Buffer.from(derived).toString('hex'), expectedHash);
}

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function createSession(principalId, secret, sessionVersion = 1, principalType = 'staff') {
  if (!PRINCIPAL_TYPES.has(principalType)) throw new Error('El tipo de sesión no es válido.');
  const payload = Buffer.from(
    JSON.stringify({
      principalId,
      principalType,
      sessionVersion,
      csrf: randomBytes(24).toString('base64url'),
      expiresAt: Date.now() + SESSION_DURATION_MS,
    }),
  ).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !safeTokenEqual(sign(payload, secret), signature)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const principalId = decoded.principalId ?? decoded.userId;
    const principalType = decoded.principalType ?? 'staff';
    if (
      typeof principalId !== 'string'
      || !principalId
      || !PRINCIPAL_TYPES.has(principalType)
      || !Number.isInteger(decoded.sessionVersion)
      || typeof decoded.csrf !== 'string'
      || !decoded.csrf
      || !Number.isFinite(decoded.expiresAt)
      || decoded.expiresAt <= Date.now()
    ) return null;
    return {
      principalId,
      principalType,
      userId: principalId,
      sessionVersion: decoded.sessionVersion,
      csrf: decoded.csrf,
      expiresAt: decoded.expiresAt,
    };
  } catch {
    return null;
  }
}

export function readCookie(request, name) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function sessionCookie(token, secure) {
  const attributes = [
    `bll_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_DURATION_SECONDS}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearSessionCookie(secure) {
  return `bll_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const E2E_PUBLIC_KEY_BYTES = 32;
const E2E_PRIVATE_KEY_BYTES = 32;
const E2E_NONCE_BYTES = 24;
const SECRETBOX_ZEROBYTES = 32;
const POLY1305_KEY_BYTES = 32;
const POLY1305_TAG_BYTES = 16;
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SIGMA_WORDS = [
  0x61707865,
  0x3320646e,
  0x79622d32,
  0x6b206574,
];

export const DEFAULT_DESKTOP_E2E_KEY_PATH = join(homedir(), '.migel', 'desktop-connector', 'e2e-key.json');

export class DesktopE2EError extends Error {
  constructor(message, {
    code = 'desktop_e2e_error',
  } = {}) {
    super(message);
    this.name = 'DesktopE2EError';
    this.code = code;
  }
}

export function createDesktopE2ECrypto({
  enabled = true,
  keyPath = DEFAULT_DESKTOP_E2E_KEY_PATH,
  keyPair = null,
} = {}) {
  let cachedKeyPair = normalizeKeyPair(keyPair);
  const resolvedKeyPath = normalizeKeyPath(keyPath);

  function requireKeyPair() {
    if (!enabled) {
      throw new DesktopE2EError('Desktop Connector E2E 未启用。', {
        code: 'e2e_disabled',
      });
    }
    if (!cachedKeyPair) {
      cachedKeyPair = loadOrCreateDesktopE2EKeyPair({
        keyPath: resolvedKeyPath,
      });
    }
    return cachedKeyPair;
  }

  return {
    enabled: Boolean(enabled),
    keyPath: resolvedKeyPath,
    publicKeyBase64() {
      return requireKeyPair().publicKey.toString('base64');
    },
    decryptJsonFrame(frame, peerPublicKeyBase64) {
      const plaintext = decryptPayloadFrame(frame, {
        keyPair: requireKeyPair(),
        peerPublicKeyBase64,
      });
      return parseJsonPayload(plaintext);
    },
    encryptJsonFrame(payload, peerPublicKeyBase64) {
      return encryptPayloadFrame(Buffer.from(JSON.stringify(payload || {}), 'utf8'), {
        keyPair: requireKeyPair(),
        peerPublicKeyBase64,
      });
    },
  };
}

export function loadOrCreateDesktopE2EKeyPair({
  keyPath = DEFAULT_DESKTOP_E2E_KEY_PATH,
} = {}) {
  const resolvedPath = normalizeKeyPath(keyPath);
  const existing = readDesktopE2EKeyPair(resolvedPath);
  if (existing) return existing;

  const generated = generateKeyPairSync('x25519');
  const keyPair = {
    publicKey: exportRawX25519PublicKey(generated.publicKey),
    privateKey: exportRawX25519PrivateKey(generated.privateKey),
  };
  writeDesktopE2EKeyPair(resolvedPath, keyPair);
  return keyPair;
}

export function isEncryptedPayloadFrame(frame) {
  return Boolean(frame
    && typeof frame === 'object'
    && typeof frame.nonce === 'string'
    && typeof frame.ciphertext === 'string');
}

export function encryptedPayloadFromContainer(container) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return null;
  if (isEncryptedPayloadFrame(container)) return container;
  if (isEncryptedPayloadFrame(container.encrypted)) return container.encrypted;
  if (container.e2e && typeof container.e2e === 'object' && isEncryptedPayloadFrame(container.e2e.encrypted)) {
    return container.e2e.encrypted;
  }
  return null;
}

export function peerPublicKeyFromContainer(container) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return '';
  return normalizeText(container.clientPublicKey)
    || normalizeText(container.publicKey)
    || normalizeText(container.pubkey)
    || normalizeText(container.e2ePublicKey)
    || normalizeText(container.e2e?.clientPublicKey)
    || normalizeText(container.e2e?.publicKey);
}

export function createEncryptedRelayFrame(frame, {
  crypto,
  peerPublicKeyBase64,
} = {}) {
  if (!crypto || typeof crypto.encryptJsonFrame !== 'function') {
    throw new DesktopE2EError('缺少 Desktop Connector E2E 加密器。', {
      code: 'missing_e2e_crypto',
    });
  }
  const publicKey = normalizeText(peerPublicKeyBase64);
  if (!publicKey) {
    throw new DesktopE2EError('缺少 Android E2E 公钥，无法加密回包。', {
      code: 'missing_peer_public_key',
    });
  }
  const encrypted = crypto.encryptJsonFrame(frame, publicKey);
  return compactFrame({
    type: normalizeText(frame?.type),
    version: numericOrUndefined(frame?.version),
    jobId: normalizeText(frame?.jobId),
    permissionId: normalizeText(frame?.permissionId),
    requestId: normalizeText(frame?.requestId),
    conversationId: normalizeText(frame?.conversationId),
    targetDeviceId: normalizeText(frame?.targetDeviceId),
    fromDeviceId: normalizeText(frame?.fromDeviceId),
    e2e: true,
    encrypted,
  });
}

function decryptPayloadFrame(frame, {
  keyPair,
  peerPublicKeyBase64,
} = {}) {
  const normalizedFrame = encryptedPayloadFromContainer(frame);
  if (!normalizedFrame) {
    throw new DesktopE2EError('E2E 加密帧缺少 nonce 或 ciphertext。', {
      code: 'invalid_encrypted_frame',
    });
  }
  const peerPublicKey = decodeBase64Bytes(peerPublicKeyBase64, E2E_PUBLIC_KEY_BYTES);
  if (!peerPublicKey) {
    throw new DesktopE2EError('Android E2E 公钥无效。', {
      code: 'invalid_peer_public_key',
    });
  }
  const sharedKey = computeX25519SharedKey(keyPair.privateKey, peerPublicKey);
  return decryptSecretBoxFrame(normalizedFrame, sharedKey);
}

function encryptPayloadFrame(plaintext, {
  keyPair,
  peerPublicKeyBase64,
} = {}) {
  const peerPublicKey = decodeBase64Bytes(peerPublicKeyBase64, E2E_PUBLIC_KEY_BYTES);
  if (!peerPublicKey) {
    throw new DesktopE2EError('Android E2E 公钥无效。', {
      code: 'invalid_peer_public_key',
    });
  }
  const sharedKey = computeX25519SharedKey(keyPair.privateKey, peerPublicKey);
  return encryptSecretBoxFrame(plaintext, sharedKey);
}

function parseJsonPayload(plaintext) {
  const text = Buffer.isBuffer(plaintext)
    ? plaintext.toString('utf8')
    : String(plaintext || '');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to a legacy content wrapper.
  }
  return {
    content: text,
  };
}

function readDesktopE2EKeyPair(keyPath) {
  if (!existsSync(keyPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(keyPath, 'utf8'));
    const publicKey = decodeBase64Bytes(parsed?.publicKey, E2E_PUBLIC_KEY_BYTES);
    const privateKey = decodeBase64Bytes(parsed?.privateKey, E2E_PRIVATE_KEY_BYTES);
    if (!publicKey || !privateKey) return null;
    return { publicKey, privateKey };
  } catch {
    return null;
  }
}

function writeDesktopE2EKeyPair(keyPath, keyPair) {
  mkdirSync(dirname(keyPath), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    keyPath,
    `${JSON.stringify({
      publicKey: keyPair.publicKey.toString('base64'),
      privateKey: keyPair.privateKey.toString('base64'),
    }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

function normalizeKeyPair(keyPair) {
  if (!keyPair || typeof keyPair !== 'object') return null;
  const publicKey = Buffer.isBuffer(keyPair.publicKey)
    ? keyPair.publicKey
    : decodeBase64Bytes(keyPair.publicKey, E2E_PUBLIC_KEY_BYTES);
  const privateKey = Buffer.isBuffer(keyPair.privateKey)
    ? keyPair.privateKey
    : decodeBase64Bytes(keyPair.privateKey, E2E_PRIVATE_KEY_BYTES);
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
  };
}

function encryptSecretBoxFrame(plaintext, sharedKey) {
  const bytes = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext || ''), 'utf8');
  const nonce = randomBytes(E2E_NONCE_BYTES);
  const padded = Buffer.concat([Buffer.alloc(SECRETBOX_ZEROBYTES), bytes]);
  const boxed = cryptoStreamXor(padded, nonce, sharedKey);
  const tag = poly1305Authenticate(boxed.subarray(SECRETBOX_ZEROBYTES), boxed.subarray(0, POLY1305_KEY_BYTES));
  return {
    v: 1,
    nonce: nonce.toString('base64'),
    ciphertext: Buffer.concat([tag, boxed.subarray(SECRETBOX_ZEROBYTES)]).toString('base64'),
  };
}

function decryptSecretBoxFrame(frame, sharedKey) {
  const nonce = decodeBase64Bytes(frame.nonce, E2E_NONCE_BYTES);
  const ciphertext = decodeBase64Bytes(frame.ciphertext);
  if (!nonce || !ciphertext || ciphertext.length < POLY1305_TAG_BYTES) {
    throw new DesktopE2EError('无效的 E2E 加密帧。', {
      code: 'invalid_encrypted_frame',
    });
  }

  const tag = ciphertext.subarray(0, POLY1305_TAG_BYTES);
  const body = ciphertext.subarray(POLY1305_TAG_BYTES);
  const firstBlock = cryptoStream(SECRETBOX_ZEROBYTES, nonce, sharedKey);
  const expectedTag = poly1305Authenticate(body, firstBlock.subarray(0, POLY1305_KEY_BYTES));
  if (!constantTimeEqual(tag, expectedTag)) {
    throw new DesktopE2EError('无法验证 E2E 加密帧。', {
      code: 'e2e_authentication_failed',
    });
  }
  const opened = cryptoStreamXor(Buffer.concat([Buffer.alloc(SECRETBOX_ZEROBYTES), body]), nonce, sharedKey);
  return opened.subarray(SECRETBOX_ZEROBYTES);
}

function computeX25519SharedKey(privateKey, peerPublicKey) {
  const secret = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, privateKey]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, peerPublicKey]),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = diffieHellman({ privateKey: secret, publicKey });
  return hsalsa20(sharedSecret, Buffer.alloc(16));
}

function exportRawX25519PublicKey(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - E2E_PUBLIC_KEY_BYTES);
}

function exportRawX25519PrivateKey(privateKey) {
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return der.subarray(der.length - E2E_PRIVATE_KEY_BYTES);
}

function decodeBase64Bytes(value, expectedLength = null) {
  const text = normalizeText(value);
  if (!text) return null;
  try {
    const bytes = Buffer.from(text, 'base64');
    if (expectedLength != null && bytes.length !== expectedLength) return null;
    return bytes;
  } catch {
    return null;
  }
}

function cryptoStreamXor(message, nonce, key) {
  const output = Buffer.alloc(message.length);
  let offset = 0;
  let counter = 0n;
  while (offset < message.length) {
    const block = salsa20Block(hsalsa20(key, nonce.subarray(0, 16)), nonce.subarray(16, 24), counter);
    const length = Math.min(block.length, message.length - offset);
    for (let index = 0; index < length; index += 1) {
      output[offset + index] = message[offset + index] ^ block[index];
    }
    offset += length;
    counter += 1n;
  }
  return output;
}

function cryptoStream(length, nonce, key) {
  return cryptoStreamXor(Buffer.alloc(length), nonce, key);
}

function hsalsa20(key, nonce16) {
  const state = [
    SIGMA_WORDS[0],
    readUint32LE(key, 0),
    readUint32LE(key, 4),
    readUint32LE(key, 8),
    readUint32LE(key, 12),
    SIGMA_WORDS[1],
    readUint32LE(nonce16, 0),
    readUint32LE(nonce16, 4),
    readUint32LE(nonce16, 8),
    readUint32LE(nonce16, 12),
    SIGMA_WORDS[2],
    readUint32LE(key, 16),
    readUint32LE(key, 20),
    readUint32LE(key, 24),
    readUint32LE(key, 28),
    SIGMA_WORDS[3],
  ];
  const x = salsaCore(state);
  const out = Buffer.alloc(32);
  writeUint32LE(out, x[0], 0);
  writeUint32LE(out, x[5], 4);
  writeUint32LE(out, x[10], 8);
  writeUint32LE(out, x[15], 12);
  writeUint32LE(out, x[6], 16);
  writeUint32LE(out, x[7], 20);
  writeUint32LE(out, x[8], 24);
  writeUint32LE(out, x[9], 28);
  return out;
}

function salsa20Block(key, nonce8, counter) {
  const state = [
    SIGMA_WORDS[0],
    readUint32LE(key, 0),
    readUint32LE(key, 4),
    readUint32LE(key, 8),
    readUint32LE(key, 12),
    SIGMA_WORDS[1],
    readUint32LE(nonce8, 0),
    readUint32LE(nonce8, 4),
    Number(counter & 0xffffffffn),
    Number((counter >> 32n) & 0xffffffffn),
    SIGMA_WORDS[2],
    readUint32LE(key, 16),
    readUint32LE(key, 20),
    readUint32LE(key, 24),
    readUint32LE(key, 28),
    SIGMA_WORDS[3],
  ];
  const x = salsaCore(state);
  const out = Buffer.alloc(64);
  for (let index = 0; index < 16; index += 1) {
    writeUint32LE(out, (x[index] + state[index]) >>> 0, index * 4);
  }
  return out;
}

function salsaCore(input) {
  const x = input.map((value) => value >>> 0);
  for (let round = 0; round < 10; round += 1) {
    x[4] ^= rotateLeft((x[0] + x[12]) >>> 0, 7);
    x[8] ^= rotateLeft((x[4] + x[0]) >>> 0, 9);
    x[12] ^= rotateLeft((x[8] + x[4]) >>> 0, 13);
    x[0] ^= rotateLeft((x[12] + x[8]) >>> 0, 18);
    x[9] ^= rotateLeft((x[5] + x[1]) >>> 0, 7);
    x[13] ^= rotateLeft((x[9] + x[5]) >>> 0, 9);
    x[1] ^= rotateLeft((x[13] + x[9]) >>> 0, 13);
    x[5] ^= rotateLeft((x[1] + x[13]) >>> 0, 18);
    x[14] ^= rotateLeft((x[10] + x[6]) >>> 0, 7);
    x[2] ^= rotateLeft((x[14] + x[10]) >>> 0, 9);
    x[6] ^= rotateLeft((x[2] + x[14]) >>> 0, 13);
    x[10] ^= rotateLeft((x[6] + x[2]) >>> 0, 18);
    x[3] ^= rotateLeft((x[15] + x[11]) >>> 0, 7);
    x[7] ^= rotateLeft((x[3] + x[15]) >>> 0, 9);
    x[11] ^= rotateLeft((x[7] + x[3]) >>> 0, 13);
    x[15] ^= rotateLeft((x[11] + x[7]) >>> 0, 18);
    x[1] ^= rotateLeft((x[0] + x[3]) >>> 0, 7);
    x[2] ^= rotateLeft((x[1] + x[0]) >>> 0, 9);
    x[3] ^= rotateLeft((x[2] + x[1]) >>> 0, 13);
    x[0] ^= rotateLeft((x[3] + x[2]) >>> 0, 18);
    x[6] ^= rotateLeft((x[5] + x[4]) >>> 0, 7);
    x[7] ^= rotateLeft((x[6] + x[5]) >>> 0, 9);
    x[4] ^= rotateLeft((x[7] + x[6]) >>> 0, 13);
    x[5] ^= rotateLeft((x[4] + x[7]) >>> 0, 18);
    x[11] ^= rotateLeft((x[10] + x[9]) >>> 0, 7);
    x[8] ^= rotateLeft((x[11] + x[10]) >>> 0, 9);
    x[9] ^= rotateLeft((x[8] + x[11]) >>> 0, 13);
    x[10] ^= rotateLeft((x[9] + x[8]) >>> 0, 18);
    x[12] ^= rotateLeft((x[15] + x[14]) >>> 0, 7);
    x[13] ^= rotateLeft((x[12] + x[15]) >>> 0, 9);
    x[14] ^= rotateLeft((x[13] + x[12]) >>> 0, 13);
    x[15] ^= rotateLeft((x[14] + x[13]) >>> 0, 18);
  }
  return x.map((value) => value >>> 0);
}

function poly1305Authenticate(message, key) {
  let r = bufferToLittleEndianBigInt(key.subarray(0, 16));
  r &= 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = bufferToLittleEndianBigInt(key.subarray(16, 32));
  const p = (1n << 130n) - 5n;
  let accumulator = 0n;

  for (let offset = 0; offset < message.length; offset += 16) {
    const block = message.subarray(offset, offset + 16);
    let number = bufferToLittleEndianBigInt(block);
    number += 1n << BigInt(8 * block.length);
    accumulator = ((accumulator + number) * r) % p;
  }

  const tagNumber = (accumulator + s) % (1n << 128n);
  return littleEndianBigIntToBuffer(tagNumber, POLY1305_TAG_BYTES);
}

function bufferToLittleEndianBigInt(buffer) {
  let value = 0n;
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) + BigInt(buffer[index]);
  }
  return value;
}

function littleEndianBigIntToBuffer(value, length) {
  const out = Buffer.alloc(length);
  let current = value;
  for (let index = 0; index < length; index += 1) {
    out[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return out;
}

function constantTimeEqual(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function rotateLeft(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function readUint32LE(buffer, offset) {
  return buffer.readUInt32LE(offset) >>> 0;
}

function writeUint32LE(buffer, value, offset) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function compactFrame(frame) {
  return Object.fromEntries(
    Object.entries(frame).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

function numericOrUndefined(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

function normalizeKeyPath(value) {
  const text = normalizeText(value) || DEFAULT_DESKTOP_E2E_KEY_PATH;
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return join(homedir(), text.slice(2));
  return resolve(text);
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

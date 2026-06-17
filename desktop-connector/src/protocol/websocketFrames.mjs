const TEXT_FRAME_OPCODE = 0x1;
const CONTINUATION_FRAME_OPCODE = 0x0;
const BINARY_FRAME_OPCODE = 0x2;
const FIN_TEXT_FRAME_BYTE = 0x80 | TEXT_FRAME_OPCODE;
const MASK_BIT = 0x80;
const SHORT_PAYLOAD_LIMIT = 125;
const EXTENDED_16_BIT_PAYLOAD = 126;
const EXTENDED_64_BIT_PAYLOAD = 127;
const CLOSE_FRAME_OPCODE = 0x8;
const PING_FRAME_OPCODE = 0x9;
const PONG_FRAME_OPCODE = 0xa;
const CONTROL_FRAME_PAYLOAD_LIMIT = 125;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export function decodeTextFrame(buffer) {
  const result = readFrame(buffer);
  if (!result || result.opcode !== TEXT_FRAME_OPCODE) return null;
  return result.payload.toString('utf8');
}

export function createTextFrameDecoder(options = {}) {
  const maxMessageBytes = positiveInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES);
  const maxBufferedBytes = positiveInteger(options.maxBufferedBytes, maxMessageBytes + 14);
  const requireMasked = Boolean(options.requireMasked);
  const onControlFrame = typeof options.onControlFrame === 'function' ? options.onControlFrame : null;
  let pending = Buffer.alloc(0);
  let fragmentedTextPayloads = [];
  let fragmentedTextBytes = 0;

  return {
    push(chunk) {
      if (!chunk || chunk.length === 0) return [];
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (pending.length + incoming.length > maxBufferedBytes) {
        throw new WebSocketFrameError(
          `WebSocket frame buffer exceeded ${formatBytes(maxBufferedBytes)}.`,
          'frame_buffer_limit',
        );
      }

      pending = pending.length > 0
        ? Buffer.concat([pending, incoming])
        : incoming;

      const messages = [];
      let consumed = 0;
      while (consumed < pending.length) {
        const result = readFrame(pending.subarray(consumed), {
          maxMessageBytes,
          requireMasked,
        });
        if (!result) break;

        consumed += result.bytesRead;
        if (isControlOpcode(result.opcode)) {
          onControlFrame?.({
            opcode: result.opcode,
            payload: result.payload,
            type: controlFrameType(result.opcode),
          });
          continue;
        }

        if (result.opcode === TEXT_FRAME_OPCODE) {
          if (fragmentedTextPayloads.length > 0) {
            throw new WebSocketFrameError(
              'WebSocket received a new text frame before the previous fragmented message ended.',
              'interleaved_fragmented_message',
            );
          }
          if (result.fin) {
            messages.push(result.payload.toString('utf8'));
          } else {
            fragmentedTextPayloads = [result.payload];
            fragmentedTextBytes = result.payload.length;
          }
          continue;
        }

        if (result.opcode === CONTINUATION_FRAME_OPCODE) {
          if (fragmentedTextPayloads.length === 0) {
            throw new WebSocketFrameError(
              'WebSocket continuation frame arrived without an active fragmented message.',
              'unexpected_continuation_frame',
            );
          }
          fragmentedTextPayloads.push(result.payload);
          fragmentedTextBytes += result.payload.length;
          if (fragmentedTextBytes > maxMessageBytes) {
            throw new WebSocketFrameError(
              `WebSocket fragmented text message exceeded ${formatBytes(maxMessageBytes)}.`,
              'message_size_limit',
            );
          }
          if (result.fin) {
            messages.push(Buffer.concat(fragmentedTextPayloads).toString('utf8'));
            fragmentedTextPayloads = [];
            fragmentedTextBytes = 0;
          }
        }
      }

      pending = consumed > 0
        ? (consumed >= pending.length ? Buffer.alloc(0) : Buffer.from(pending.subarray(consumed)))
        : pending;
      return messages;
    },
    reset() {
      pending = Buffer.alloc(0);
      fragmentedTextPayloads = [];
      fragmentedTextBytes = 0;
    },
  };
}

export function encodeTextFrame(text) {
  const payload = Buffer.from(String(text || ''), 'utf8');
  if (payload.length <= SHORT_PAYLOAD_LIMIT) {
    return Buffer.concat([Buffer.from([FIN_TEXT_FRAME_BYTE, payload.length]), payload]);
  }
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = FIN_TEXT_FRAME_BYTE;
    header[1] = EXTENDED_16_BIT_PAYLOAD;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = FIN_TEXT_FRAME_BYTE;
  header[1] = EXTENDED_64_BIT_PAYLOAD;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

export function encodePongFrame(payload = Buffer.alloc(0)) {
  return encodeControlFrame(PONG_FRAME_OPCODE, payload);
}

export class WebSocketFrameError extends Error {
  constructor(message, code = 'protocol_error') {
    super(message);
    this.name = 'WebSocketFrameError';
    this.code = code;
  }
}

function readFrame(buffer, options = {}) {
  if (!buffer || buffer.length < 2) return null;

  const maxMessageBytes = positiveInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES);
  const requireMasked = Boolean(options.requireMasked);
  const fin = (buffer[0] & 0x80) !== 0;
  const rsvBits = buffer[0] & 0x70;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & MASK_BIT) !== 0;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;

  if (rsvBits !== 0) {
    throw new WebSocketFrameError('WebSocket frame uses unsupported reserved bits.', 'unsupported_extension');
  }

  if (!isSupportedOpcode(opcode)) {
    throw new WebSocketFrameError(`Unsupported WebSocket opcode ${opcode}.`, 'unsupported_opcode');
  }

  if (isControlOpcode(opcode) && !fin) {
    throw new WebSocketFrameError('WebSocket control frames must not be fragmented.', 'fragmented_control_frame');
  }

  if (requireMasked && !masked) {
    throw new WebSocketFrameError('WebSocket client frame must be masked.', 'unmasked_client_frame');
  }

  if (payloadLength === EXTENDED_16_BIT_PAYLOAD) {
    if (buffer.length < offset + 2) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === EXTENDED_64_BIT_PAYLOAD) {
    if (buffer.length < offset + 8) return null;
    payloadLength = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
    if (!Number.isSafeInteger(payloadLength)) {
      throw new WebSocketFrameError('WebSocket frame length is too large to process safely.', 'message_size_limit');
    }
  }

  if (isControlOpcode(opcode) && payloadLength > CONTROL_FRAME_PAYLOAD_LIMIT) {
    throw new WebSocketFrameError('WebSocket control frame payload is too large.', 'control_frame_size_limit');
  }

  if (payloadLength > maxMessageBytes) {
    throw new WebSocketFrameError(
      `WebSocket message exceeded ${formatBytes(maxMessageBytes)}.`,
      'message_size_limit',
    );
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    bytesRead: offset + payloadLength,
    fin,
    opcode,
    payload,
  };
}

function isSupportedOpcode(opcode) {
  return opcode === CONTINUATION_FRAME_OPCODE
    || opcode === TEXT_FRAME_OPCODE
    || opcode === BINARY_FRAME_OPCODE
    || opcode === CLOSE_FRAME_OPCODE
    || opcode === PING_FRAME_OPCODE
    || opcode === PONG_FRAME_OPCODE;
}

function isControlOpcode(opcode) {
  return opcode >= CLOSE_FRAME_OPCODE;
}

function controlFrameType(opcode) {
  if (opcode === CLOSE_FRAME_OPCODE) return 'close';
  if (opcode === PING_FRAME_OPCODE) return 'ping';
  if (opcode === PONG_FRAME_OPCODE) return 'pong';
  return 'control';
}

function encodeControlFrame(opcode, payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  if (bytes.length > CONTROL_FRAME_PAYLOAD_LIMIT) {
    throw new WebSocketFrameError('WebSocket control frame payload is too large.', 'control_frame_size_limit');
  }
  return Buffer.concat([
    Buffer.from([0x80 | opcode, bytes.length]),
    bytes,
  ]);
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown bytes';
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} bytes`;
}

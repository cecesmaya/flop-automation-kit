/**
 * Logger with built-in secret redaction.
 *
 * RULE: nothing secret ever reaches a log line. Any value that looks like a
 * credential is replaced before output, both in free text and inside objects.
 * Callers must still avoid passing secrets to the logger; redaction is a
 * second line of defence, not permission to log secrets.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// A field is secret when one of its whole words (camelCase/snake-case split)
// is a secret word. Splitting matters: "promptTokens" / "totalTokens" are
// counts and must NOT be redacted, while "apiKey" / "authToken" must be.
const SECRET_WORDS = new Set([
  'password', 'passwd', 'secret', 'key', 'token', 'private', 'mnemonic',
  'seed', 'signature', 'authorization', 'bearer', 'passphrase', 'apikey',
  'accesstoken',
]);

export function isSecretKey(key) {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  return words.some((w) => SECRET_WORDS.has(w));
}

// Free-text patterns that indicate a secret value.
const TEXT_PATTERNS = [
  // Authorization: Bearer <token>
  { re: /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/g, replacement: 'Bearer [REDACTED]' },
  // API keys like sk-... / pk_live_... / flop_...
  { re: /\b(sk|pk|rk|flop)[-_][A-Za-z0-9\-_]{8,}\b/g, replacement: '[REDACTED]' },
  // sr25519 signatures and other 64-byte values: 0x + 128 hex chars
  { re: /0x[0-9a-fA-F]{128}\b/g, replacement: '0x[REDACTED]' },
  // Long bare hex blobs (>= 96 hex chars) that are not part of a larger word
  { re: /\b[0-9a-fA-F]{96,}\b/g, replacement: '[REDACTED]' },
];

export function redactText(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const { re, replacement } of TEXT_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Deep-redact an arbitrary value: objects/arrays are walked, secret keys masked. */
export function redact(value, depth = 0) {
  if (depth > 6) return '[DEPTH]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? '[REDACTED]' : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

function formatValue(value) {
  const redacted = redact(value);
  if (typeof redacted === 'string') return redacted;
  try {
    return JSON.stringify(redacted);
  } catch {
    return String(redacted);
  }
}

export class Logger {
  constructor({ level = 'info', stream = process.stderr } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.stream = stream;
  }

  #write(level, message, meta) {
    if (LEVELS[level] > this.level) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg: redactText(String(message)),
    };
    if (meta !== undefined) line.meta = redact(meta);
    this.stream.write(`${JSON.stringify(line)}\n`);
  }

  error(message, meta) { this.#write('error', message, meta); }
  warn(message, meta) { this.#write('warn', message, meta); }
  info(message, meta) { this.#write('info', message, meta); }
  debug(message, meta) { this.#write('debug', message, meta); }
}

/** Default process-wide logger; level taken from FLOP_LOG_LEVEL. */
export const logger = new Logger({ level: process.env.FLOP_LOG_LEVEL ?? 'info' });

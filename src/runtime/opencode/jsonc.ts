/**
 * Minimal strict JSONC parser for the OpenCode config guard (design doc §20.5).
 *
 * Why not `JSON.parse`: the guard must inspect exactly what OpenCode will see,
 * and it must fail closed on the raw bytes that will later be written to disk.
 * A hand-written parser lets us do both:
 *
 * - it rejects **duplicate keys** (`{"apiKey":"secret","apiKey":"{env:X}"}`),
 *   which `JSON.parse` silently collapses to the last value while the raw
 *   literal stays on disk;
 * - it decodes string escapes, so `\u007e`, a backslash-escaped slash, or an
 *   escaped key cannot hide a reference;
 * - it rejects an unterminated block comment rather than truncating the input.
 *
 * Accepts JSON plus comments and trailing commas. Local to the adapter.
 */
export function parseJsonc(text: string): unknown {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const parser = new Parser(stripComments(withoutBom));
  const value = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.atEnd()) throw new Error('unexpected content after the top-level value');
  return value;
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && text.charAt(i + 1) === '/') {
      i += 2;
      while (i < text.length && text.charAt(i) !== '\n' && text.charAt(i) !== '\r') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && text.charAt(i + 1) === '*') {
      i += 2;
      let terminated = false;
      while (i < text.length) {
        if (text.charAt(i) === '*' && text.charAt(i + 1) === '/') {
          terminated = true;
          break;
        }
        i += 1;
      }
      if (!terminated) throw new Error('unterminated block comment');
      i += 2;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

class Parser {
  private index = 0;

  constructor(private readonly text: string) {}

  atEnd(): boolean {
    return this.index >= this.text.length;
  }

  skipWhitespace(): void {
    while (this.index < this.text.length && isWhitespace(this.text.charAt(this.index))) {
      this.index += 1;
    }
  }

  parseValue(): unknown {
    this.skipWhitespace();
    const ch = this.text.charAt(this.index);
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"') return this.parseString();
    if (this.text.startsWith('true', this.index)) return this.literal('true', true);
    if (this.text.startsWith('false', this.index)) return this.literal('false', false);
    if (this.text.startsWith('null', this.index)) return this.literal('null', null);
    return this.parseNumber();
  }

  private literal(word: string, value: unknown): unknown {
    this.index += word.length;
    return value;
  }

  private parseObject(): Record<string, unknown> {
    this.index += 1; // {
    const seen = new Set<string>();
    const entries: [string, unknown][] = [];
    this.skipWhitespace();
    if (this.text.charAt(this.index) === '}') {
      this.index += 1;
      return {};
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text.charAt(this.index) !== '"') {
        throw new Error('object key must be a string');
      }
      const key = this.parseString();
      if (seen.has(key)) throw new Error(`duplicate key "${key}"`);
      seen.add(key);
      this.skipWhitespace();
      if (this.text.charAt(this.index) !== ':') throw new Error('expected ":" after an object key');
      this.index += 1;
      entries.push([key, this.parseValue()]);
      this.skipWhitespace();
      const separator = this.text.charAt(this.index);
      if (separator === ',') {
        this.index += 1;
        this.skipWhitespace();
        if (this.text.charAt(this.index) === '}') {
          this.index += 1;
          break;
        }
        continue;
      }
      if (separator === '}') {
        this.index += 1;
        break;
      }
      throw new Error('expected "," or "}" in an object');
    }
    return Object.fromEntries(entries);
  }

  private parseArray(): unknown[] {
    this.index += 1; // [
    const items: unknown[] = [];
    this.skipWhitespace();
    if (this.text.charAt(this.index) === ']') {
      this.index += 1;
      return items;
    }
    for (;;) {
      items.push(this.parseValue());
      this.skipWhitespace();
      const separator = this.text.charAt(this.index);
      if (separator === ',') {
        this.index += 1;
        this.skipWhitespace();
        if (this.text.charAt(this.index) === ']') {
          this.index += 1;
          break;
        }
        continue;
      }
      if (separator === ']') {
        this.index += 1;
        break;
      }
      throw new Error('expected "," or "]" in an array');
    }
    return items;
  }

  private parseString(): string {
    this.index += 1; // opening quote
    let out = '';
    for (;;) {
      if (this.atEnd()) throw new Error('unterminated string');
      const ch = this.text.charAt(this.index);
      this.index += 1;
      if (ch === '"') return out;
      if (ch !== '\\') {
        // JSON forbids unescaped control characters in strings; accepting them
        // would let the guard parse input OpenCode's parser rejects.
        if (ch.charCodeAt(0) <= 0x1f) throw new Error('unescaped control character in string');
        out += ch;
        continue;
      }
      const escape = this.text.charAt(this.index);
      this.index += 1;
      switch (escape) {
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          const hex = this.text.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('invalid \\u escape');
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
          break;
        }
        default:
          throw new Error(`invalid string escape \\${escape}`);
      }
    }
  }

  private parseNumber(): number {
    const match = NUMBER_PATTERN.exec(this.text.slice(this.index));
    if (!match) throw new Error('expected a value');
    this.index += match[0].length;
    return Number(match[0]);
  }
}

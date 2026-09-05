import { StringDecoder } from 'node:string_decoder';

export interface BoundedOutputSnapshot {
  text: string;
  totalBytes: number;
  retainedBytes: number;
  truncated: boolean;
}

type RetentionMode = 'prefix' | 'head-tail';

/** Omit an incomplete trailing code point without inventing a replacement character. */
function completePrefix(buffer: Buffer): string {
  return new StringDecoder('utf8').write(buffer);
}

function completeTail(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString('utf8');
}

function bytes(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

/** Retain either a prefix or non-overlapping head/tail while counting every drained byte. */
export class BoundedOutputBuffer {
  private totalBytes = 0;
  private retainedBytes = 0;
  private truncated = false;
  private readonly prefix: Buffer[] = [];
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);

  constructor(private readonly limit: number, private readonly mode: RetentionMode) {}

  push(chunk: unknown): void {
    const buffer = bytes(chunk);
    const nextBytes = this.totalBytes + buffer.length;
    if (this.mode === 'prefix') {
      const available = Math.max(0, this.limit - this.retainedBytes);
      if (available > 0) {
        const retained = Buffer.from(buffer.subarray(0, available));
        this.prefix.push(retained);
        this.retainedBytes += retained.length;
      }
      this.totalBytes = nextBytes;
      this.truncated = nextBytes > this.limit;
      return;
    }

    const headBytes = Math.ceil(this.limit / 2);
    const tailBytes = Math.floor(this.limit / 2);
    if (!this.truncated && nextBytes <= this.limit) {
      const retained = Buffer.from(buffer);
      this.prefix.push(retained);
      this.retainedBytes += retained.length;
    } else if (!this.truncated) {
      const previous = Buffer.concat(this.prefix);
      const neededHead = Math.max(0, headBytes - previous.length);
      this.head = previous.length >= headBytes
        ? Buffer.from(previous.subarray(0, headBytes))
        : Buffer.concat([previous, Buffer.from(buffer.subarray(0, neededHead))]);
      if (tailBytes > 0) {
        this.tail = buffer.length >= tailBytes
          ? Buffer.from(buffer.subarray(buffer.length - tailBytes))
          : Buffer.concat([previous.subarray(Math.max(0, previous.length - (tailBytes - buffer.length))), buffer]);
      }
      this.prefix.length = 0;
      this.retainedBytes = this.head.length + this.tail.length;
      this.truncated = true;
    } else if (tailBytes > 0) {
      if (buffer.length >= tailBytes) {
        this.tail = Buffer.from(buffer.subarray(buffer.length - tailBytes));
      } else {
        const combined = Buffer.concat([this.tail, buffer]);
        this.tail = Buffer.from(combined.subarray(Math.max(0, combined.length - tailBytes)));
      }
    }
    this.totalBytes = nextBytes;
  }

  snapshot(): BoundedOutputSnapshot {
    const text = this.truncated && this.mode === 'head-tail'
      ? completePrefix(this.head) + completeTail(this.tail)
      : this.truncated
        ? completePrefix(Buffer.concat(this.prefix))
        : Buffer.concat(this.prefix).toString('utf8');
    // Invalid source bytes may expand to UTF-8 replacement characters when decoded.
    const decodingTruncated = Buffer.byteLength(text) > this.limit;
    const boundedText = decodingTruncated
      ? completePrefix(Buffer.from(text).subarray(0, this.limit))
      : text;
    return {
      text: boundedText,
      totalBytes: this.totalBytes,
      retainedBytes: this.retainedBytes,
      truncated: this.truncated || decodingTruncated,
    };
  }
}

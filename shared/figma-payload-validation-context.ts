export interface ImportPayloadLimits {
  aggregateBytes: number;
  totalEntries: number;
  nodes: number;
  depth: number;
  textChars: number;
  imageChars: number;
  svgChars: number;
  arrayEntries: number;
  recordEntries: number;
  recordKeyChars: number;
  tokenGroup: number;
  motionSteps: number;
}

export const IMPORT_PAYLOAD_LIMITS: ImportPayloadLimits = {
  aggregateBytes: 64 * 1024 * 1024,
  totalEntries: 5_000_000,
  nodes: 100_000,
  depth: 256,
  textChars: 1024 * 1024,
  imageChars: 16 * 1024 * 1024,
  svgChars: 16 * 1024 * 1024,
  arrayEntries: 100_000,
  recordEntries: 10_000,
  recordKeyChars: 16_384,
  tokenGroup: 10_000,
  motionSteps: 10_000,
};

export class PayloadValidationError extends Error {
  readonly code = 'E_INVALID_ARGS';

  constructor(message: string) {
    super(`IMPORT_PAYLOAD rejected: ${message}`);
    this.name = 'PayloadValidationError';
  }
}

export type ObjectValue = Record<string, unknown>;

function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit === 0x22 || unit === 0x5c) bytes += 2;
    else if (unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d) bytes += 2;
    else if (unit < 0x20) bytes += 6;
    else if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff
      && i + 1 < value.length && (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else if (unit >= 0xd800 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

export class ValidationContext {
  readonly limits: ImportPayloadLimits;
  private aggregateBytes = 0;
  private totalEntries = 0;
  private nodeCount = 0;
  private readonly active = new WeakSet<object>();

  constructor(overrides: Partial<ImportPayloadLimits> = {}) {
    this.limits = { ...IMPORT_PAYLOAD_LIMITS, ...overrides };
  }

  fail(path: string, message: string): never {
    throw new PayloadValidationError(`${path} ${message}`);
  }

  private addBytes(bytes: number, path: string): void {
    this.aggregateBytes += bytes;
    if (this.aggregateBytes > this.limits.aggregateBytes) {
      this.fail(path, `exceeds aggregate budget ${this.limits.aggregateBytes} bytes`);
    }
  }

  private addEntry(path: string): void {
    this.totalEntries += 1;
    if (this.totalEntries > this.limits.totalEntries) {
      this.fail(path, `exceeds aggregate entry budget ${this.limits.totalEntries}`);
    }
  }

  object<T>(
    value: unknown,
    path: string,
    allowed: ReadonlySet<string> | null,
    visit: (item: ObjectValue) => T,
    maxKeys = allowed?.size ?? this.limits.recordEntries,
  ): T {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
      this.fail(path, 'must be a plain object');
    }
    if (this.active.has(value)) this.fail(path, 'must not contain an active cycle');
    this.active.add(value);
    this.addBytes(2, path);
    try {
      let count = 0;
      for (const key in value as ObjectValue) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        count += 1;
        if (count > maxKeys) this.fail(path, `must have at most ${maxKeys} fields`);
        if (key.length > this.limits.recordKeyChars) {
          this.fail(`${path} key`, `must be at most ${this.limits.recordKeyChars} characters`);
        }
        this.addEntry(`${path}.${key}`);
        this.addBytes(jsonStringBytes(key) + 2, `${path}.${key}`);
        if (allowed && !allowed.has(key)) this.fail(`${path}.${key}`, 'is not a supported field');
      }
      return visit(value as ObjectValue);
    } finally {
      this.active.delete(value);
    }
  }

  array(
    value: unknown,
    path: string,
    max: number,
    visit: (entry: unknown, index: number) => void,
    min = 0,
  ): void {
    if (!Array.isArray(value) || value.length < min || value.length > max) {
      this.fail(path, `must be an array with ${min}..${max} entries`);
    }
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const index = Number(key);
      if (key.length > this.limits.recordKeyChars || !Number.isInteger(index)
        || index < 0 || index >= value.length || String(index) !== key) {
        this.fail(path, 'must not contain enumerable non-index fields');
      }
    }
    if (this.active.has(value)) this.fail(path, 'must not contain an active cycle');
    this.active.add(value);
    this.addBytes(2, path);
    try {
      for (let i = 0; i < value.length; i++) {
        this.addEntry(`${path}[${i}]`);
        this.addBytes(1, `${path}[${i}]`);
        visit(value[i], i);
      }
    } finally {
      this.active.delete(value);
    }
  }

  string(value: unknown, path: string, max = this.limits.textChars): string {
    if (typeof value !== 'string' || value.length > max) {
      this.fail(path, `must be a string no longer than ${max} characters`);
    }
    this.addBytes(jsonStringBytes(value), path);
    return value;
  }

  number(value: unknown, path: string, min = -Infinity, max = Infinity): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      this.fail(path, `must be a finite number between ${min} and ${max}`);
    }
    this.addBytes(24, path);
    return value;
  }

  integer(value: unknown, path: string, min = 0): number {
    const parsed = this.number(value, path, min);
    if (!Number.isInteger(parsed)) this.fail(path, 'must be an integer');
    return parsed;
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') this.fail(path, 'must be boolean');
    this.addBytes(5, path);
    return value;
  }

  enumValue<T extends string>(value: unknown, path: string, values: readonly T[]): T {
    const parsed = this.string(value, path, 128) as T;
    if (!values.includes(parsed)) this.fail(path, `must be one of ${values.join(', ')}`);
    return parsed;
  }

  node(path: string, depth: number): void {
    if (depth > this.limits.depth) this.fail(path, `exceeds maximum depth ${this.limits.depth}`);
    this.nodeCount += 1;
    if (this.nodeCount > this.limits.nodes) this.fail(path, `exceeds maximum node count ${this.limits.nodes}`);
  }
}

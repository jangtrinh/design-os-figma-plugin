export const MAX_GRADIENT_IMAGE_SIDE = 4096;

// 4096² RGBA is 67,108,864 raw bytes. PNG adds one filter byte per row;
// zlib's compressBound formula and required PNG chunks bring the worst-case
// encoded pixel stream to 67,133,513 bytes. 68 MiB retains ~4 MiB for normal
// ancillary chunks without admitting unbounded metadata.
export const MAX_GRADIENT_PNG_BYTES = 68 * 1024 * 1024;
export const MAX_GRADIENT_PNG_BASE64_CHARS = 4 * Math.ceil(MAX_GRADIENT_PNG_BYTES / 3);
export const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const PNG_HEADER_BYTES = 33;

export class GradientImageAdmissionError extends Error {
  readonly code = 'E_INVALID_ARGS';
  constructor(message: string) {
    super(message);
    this.name = 'GradientImageAdmissionError';
  }
}

export interface GradientPixelSize {
  readonly width: number;
  readonly height: number;
}

export function validateGradientDimensions(width: number, height: number, scale: number): GradientPixelSize {
  if (![width, height, scale].every((value) => Number.isFinite(value) && value > 0)) {
    throw new GradientImageAdmissionError('gradient bake needs finite positive width, height, and scale');
  }
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (!Number.isSafeInteger(pixelWidth) || !Number.isSafeInteger(pixelHeight) || pixelWidth < 1 || pixelHeight < 1) {
    throw new GradientImageAdmissionError('gradient bake produced invalid integer pixel dimensions');
  }
  if (pixelWidth > MAX_GRADIENT_IMAGE_SIDE || pixelHeight > MAX_GRADIENT_IMAGE_SIDE) {
    throw new GradientImageAdmissionError(`gradient images cannot exceed ${MAX_GRADIENT_IMAGE_SIDE}px on either side`);
  }
  return { width: pixelWidth, height: pixelHeight };
}

export function assertGradientPngByteLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < PNG_HEADER_BYTES || length > MAX_GRADIENT_PNG_BYTES) {
    throw new GradientImageAdmissionError(`gradient PNG must be ${PNG_HEADER_BYTES}-${MAX_GRADIENT_PNG_BYTES} bytes`);
  }
}

export function assertGradientPngBase64Length(length: number): void {
  if (!Number.isSafeInteger(length) || length < 4 || length > MAX_GRADIENT_PNG_BASE64_CHARS || length % 4 !== 0) {
    throw new GradientImageAdmissionError(`gradient PNG base64 length is outside the supported bound`);
  }
}

function isBase64Character(code: number): boolean {
  return (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || (code >= 48 && code <= 57)
    || code === 43
    || code === 47;
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : 63;
}

export function decodedLengthOfCanonicalBase64(value: string): number {
  assertGradientPngBase64Length(value.length);
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index++) {
    if (!isBase64Character(value.charCodeAt(index))) {
      throw new GradientImageAdmissionError('gradient PNG data URL must contain canonical base64');
    }
  }
  for (let index = contentLength; index < value.length; index++) {
    if (value.charCodeAt(index) !== 61) {
      throw new GradientImageAdmissionError('gradient PNG data URL must contain canonical base64 padding');
    }
  }
  if ((padding === 2 && (base64Value(value.charCodeAt(contentLength - 1)) & 15) !== 0)
      || (padding === 1 && (base64Value(value.charCodeAt(contentLength - 1)) & 3) !== 0)) {
    throw new GradientImageAdmissionError('gradient PNG data URL must use zeroed canonical base64 padding bits');
  }
  const decodedLength = (value.length / 4) * 3 - padding;
  assertGradientPngByteLength(decodedLength);
  return decodedLength;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

export function validateGradientPngHeader(
  bytes: Uint8Array,
  expected?: GradientPixelSize,
): GradientPixelSize {
  assertGradientPngByteLength(bytes.length);
  for (let index = 0; index < PNG_SIGNATURE.length; index++) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new GradientImageAdmissionError('gradient image is missing the PNG signature');
    }
  }
  if (readUint32(bytes, 8) !== 13
      || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
    throw new GradientImageAdmissionError('gradient image is missing a canonical IHDR chunk');
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (width < 1 || height < 1 || width > MAX_GRADIENT_IMAGE_SIDE || height > MAX_GRADIENT_IMAGE_SIDE) {
    throw new GradientImageAdmissionError('gradient PNG dimensions are outside the supported bound');
  }
  if (expected && (width !== expected.width || height !== expected.height)) {
    throw new GradientImageAdmissionError(
      `gradient PNG dimensions ${width}x${height} do not match requested ${expected.width}x${expected.height}`,
    );
  }
  return { width, height };
}

export function decodeGradientPngDataUrl(dataUrl: unknown, expected?: GradientPixelSize): Uint8Array {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new GradientImageAdmissionError(`gradient capture must use the exact ${PNG_DATA_URL_PREFIX} prefix`);
  }
  assertGradientPngBase64Length(dataUrl.length - PNG_DATA_URL_PREFIX.length);
  const base64 = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  const predictedLength = decodedLengthOfCanonicalBase64(base64);
  const decodeBase64 = (globalThis as unknown as { atob?: (value: string) => string }).atob;
  if (typeof decodeBase64 !== 'function') {
    throw new GradientImageAdmissionError('gradient PNG decoding is unavailable in this environment');
  }
  let binary: string;
  try { binary = decodeBase64.call(globalThis, base64); }
  catch { throw new GradientImageAdmissionError('gradient PNG data URL contains invalid base64'); }
  if (binary.length !== predictedLength) {
    throw new GradientImageAdmissionError('gradient PNG decoded length did not match its canonical base64');
  }
  assertGradientPngByteLength(binary.length);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  validateGradientPngHeader(bytes, expected);
  return bytes;
}

function validateByte(value: unknown, index: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new GradientImageAdmissionError(`gradient image byte ${index} is not an integer from 0 to 255`);
  }
}

export function gradientBytesFromUnknown(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) {
    assertGradientPngByteLength(raw.length);
    return raw;
  }
  if (Array.isArray(raw)) {
    assertGradientPngByteLength(raw.length);
    const keys = Object.keys(raw);
    if (keys.length !== raw.length) throw new GradientImageAdmissionError('gradient image array must be dense and carry no extra keys');
    for (let index = 0; index < raw.length; index++) {
      if (keys[index] !== String(index)) throw new GradientImageAdmissionError('gradient image array keys must be contiguous');
      validateByte(raw[index], index);
    }
    return new Uint8Array(raw);
  }
  if (raw !== null && typeof raw === 'object') {
    const keys = Reflect.ownKeys(raw);
    assertGradientPngByteLength(keys.length);
    const source = raw as Record<string, unknown>;
    for (let index = 0; index < keys.length; index++) {
      if (keys[index] !== String(index)) throw new GradientImageAdmissionError('gradient image object keys must be contiguous canonical integers');
      validateByte(source[String(index)], index);
    }
    const bytes = new Uint8Array(keys.length);
    for (let index = 0; index < keys.length; index++) bytes[index] = source[String(index)] as number;
    return bytes;
  }
  throw new GradientImageAdmissionError('gradient image bytes must be a Uint8Array, dense array, or numeric-keyed object');
}

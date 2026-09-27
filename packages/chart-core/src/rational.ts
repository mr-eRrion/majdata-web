import type { Rational } from './types.js';

export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
/** Parser-compatible reduced denominator ceiling; all rational components stay JS-safe integers. */
export const MAX_RATIONAL_DENOMINATOR = Number.MAX_SAFE_INTEGER;

function integer(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
  return BigInt(value);
}

function fromBigInts(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new RangeError('Rational denominator cannot be zero');
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const gcd = greatestCommonDivisor(numerator < 0n ? -numerator : numerator, denominator);
  numerator /= gcd;
  denominator /= gcd;
  if (numerator > BigInt(MAX_SAFE_INTEGER) || numerator < -BigInt(MAX_SAFE_INTEGER))
    throw new RangeError('Rational numerator exceeds the safe integer range');
  if (denominator > BigInt(MAX_RATIONAL_DENOMINATOR))
    throw new RangeError(`Rational denominator exceeds ${MAX_RATIONAL_DENOMINATOR}`);
  return { numerator: Number(numerator), denominator: Number(denominator) };
}

function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

export function rational(numerator: number, denominator = 1): Rational {
  return fromBigInts(integer(numerator, 'Numerator'), integer(denominator, 'Denominator'));
}

export function validateRational(value: Rational): Rational {
  if (!value || typeof value !== 'object') throw new TypeError('Rational value is required');
  return rational(value.numerator, value.denominator);
}

export function addRational(left: Rational, right: Rational): Rational {
  const a = validateRational(left);
  const b = validateRational(right);
  const denominator = BigInt(a.denominator) * BigInt(b.denominator);
  const numerator = BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator);
  return fromBigInts(numerator, denominator);
}

export function subtractRational(left: Rational, right: Rational): Rational {
  const a = validateRational(left);
  const b = validateRational(right);
  const denominator = BigInt(a.denominator) * BigInt(b.denominator);
  const numerator = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  return fromBigInts(numerator, denominator);
}

export function multiplyRational(left: Rational, right: Rational): Rational {
  const a = validateRational(left);
  const b = validateRational(right);
  return fromBigInts(BigInt(a.numerator) * BigInt(b.numerator), BigInt(a.denominator) * BigInt(b.denominator));
}

export function divideRational(left: Rational, right: Rational): Rational {
  const a = validateRational(left);
  const b = validateRational(right);
  if (b.numerator === 0) throw new RangeError('Cannot divide by zero');
  return fromBigInts(BigInt(a.numerator) * BigInt(b.denominator), BigInt(a.denominator) * BigInt(b.numerator));
}

export function compareRational(left: Rational, right: Rational): number {
  const a = validateRational(left);
  const b = validateRational(right);
  const difference = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function equalRational(left: Rational, right: Rational): boolean {
  return compareRational(left, right) === 0;
}

export function rationalToNumber(value: Rational): number {
  const normalized = validateRational(value);
  return normalized.numerator / normalized.denominator;
}

/** Converts the shortest decimal representation of a finite number exactly. */
export function rationalFromNumber(value: number): Rational {
  if (!Number.isFinite(value)) throw new RangeError('Value must be finite');
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) throw new RangeError('Value has no finite decimal representation');
  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = match[3] ?? '';
  let numerator = BigInt(`${match[2]}${fraction}`) * sign;
  let scale = fraction.length - Number(match[4] ?? 0);
  if (scale < 0) {
    numerator *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return fromBigInts(numerator, 10n ** BigInt(scale));
}

export function rationalKey(value: Rational): string {
  const normalized = validateRational(value);
  return `${normalized.numerator}/${normalized.denominator}`;
}

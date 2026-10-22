/**
 * Stable hashing used to bucket products and applicants.
 *
 * Two products with the same criteria signature are interchangeable for the
 * matcher, and two applicants with the same fact bucket receive the same
 * LLM verdict.  The hash therefore has to be deterministic and must not
 * depend on object key order, which is why the input is serialised through
 * `canonicalise` first.
 */

/**
 * Serialise a value into a canonical string with sorted object keys.
 *
 * @param {*} value any JSON compatible value
 * @returns {string} canonical representation
 */
function canonicalise(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalise(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, '');
  }
  return JSON.stringify(value);
}

/**
 * FNV-1a 64 bit hash rendered as hexadecimal.
 *
 * The n8n Code node sandbox does not expose `crypto`, so a small, well known
 * non cryptographic hash is used.  It only has to be stable and fast, the
 * values never leave the system.
 *
 * @param {string} value input string
 * @returns {string} 16 character hex digest
 */
function fnv1a64(value) {
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    hash ^= BigInt(code & 0xff);
    hash = (hash * prime) & mask;
    hash ^= BigInt(code >> 8);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Compute the signature of a normalised criteria object.
 *
 * @param {object} criteria normalised criteria
 * @returns {string} signature
 */
function criteriaSignature(criteria) {
  return fnv1a64(canonicalise(criteria));
}

module.exports = {
  canonicalise,
  criteriaSignature,
  fnv1a64,
};

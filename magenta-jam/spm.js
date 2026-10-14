/**
 * Dependency-free SentencePiece **unigram** tokenizer for the browser.
 *
 * Reproduces Python `sentencepiece`'s `EncodeAsIds()` output exactly (same
 * ids, same tie-breaking) for unigram models that use a precompiled-
 * charsmap normalizer and byte-fallback — the common configuration for
 * Google's "nmt_nfkc"-style models. No DOM APIs are used, so this module
 * runs fine inside a Web Worker.
 *
 * This is a from-scratch reimplementation, ported line-by-line from the
 * relevant parts of google/sentencepiece (src/normalizer.cc,
 * src/unigram_model.cc, src/model_interface.cc,
 * third_party/darts_clone/darts.h). Three non-obvious pieces are worth
 * calling out up front because they are easy to get subtly wrong:
 *
 * 1. Normalization uses a "precompiled charsmap": a serialized darts-clone
 *    double-array trie (see `parseCharsmap`/`trieCommonPrefixSearch`) that
 *    maps runs of input bytes to replacement strings. Sentencepiece walks
 *    the *raw UTF-8 bytes* of the input, at every position taking the
 *    longest matching replacement (or, if none matches, one raw UTF-8
 *    character verbatim) — see `normalize`.
 * 2. Segmentation ("Model::EncodeOptimized" in unigram_model.cc) is a
 *    single left-to-right O(n·k) Viterbi DP over UTF-8 byte positions,
 *    scored with the pieces' log-probabilities. Ties are broken by
 *    strict-greater-than comparisons in a specific iteration order (outer
 *    loop over start position, ascending) — the longer piece ending at a
 *    given position wins a tie. See `_viterbi`.
 * 3. Piece scores are 32-bit floats in the model file, and the reference
 *    C++ does all score arithmetic in `float`. We mirror that with
 *    `Math.fround` after every addition so ties resolve identically to
 *    the reference (plain double arithmetic can disagree in the last bit).
 *
 * A character with no matching vocabulary piece becomes a single UNK node
 * in the lattice; sentencepiece then decomposes that UNK's UTF-8 bytes into
 * the model's byte-fallback pieces (`<0x00>`..`<0xFF>`) instead of emitting
 * `<unk>`, provided byte_fallback is enabled (see `encode`).
 */

// ---- SentencePiece.SentencePiece.Type enum (sentencepiece_model.proto) ----
const PIECE_TYPE = {
  NORMAL: 1,
  UNKNOWN: 2,
  CONTROL: 3,
  USER_DEFINED: 4,
  UNUSED: 5,
  BYTE: 6,
};

// UTF-8 leading-byte -> character byte length, indexed by (byte >> 4).
// Ported verbatim from sentencepiece's string_util::OneCharLen.
const ONE_CHAR_LEN = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 4];
function oneCharLen(byte) {
  return ONE_CHAR_LEN[byte >>> 4];
}

function byteToPiece(byte) {
  return `<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`;
}

// ---------------------------------------------------------------------
// Minimal protobuf wire-format reader (varint / fixed32 / length-delimited
// only — everything ModelProto needs). Every malformed-input path throws.
// ---------------------------------------------------------------------

class ByteReader {
  constructor(bytes) {
    this.b = bytes;
    this.p = 0;
  }

  byte() {
    if (this.p >= this.b.length) throw new Error('spm: unexpected end of buffer');
    return this.b[this.p++];
  }

  /**
   * Reads a protobuf varint as a plain Number. A varint can use up to 10
   * bytes (it must be able to represent a full 64-bit field), so we allow
   * up to 10 bytes before giving up — even though every varint field this
   * parser actually reads (lengths, enum tags, small bools) is far smaller.
   * Fields we skip that legitimately carry a big 64-bit value (e.g.
   * trainer_spec's random_seed) lose precision past 2^53, which is fine
   * since we only need to consume the right number of bytes for those.
   */
  varintNum() {
    let result = 0;
    let shift = 0;
    let byte;
    let bytesRead = 0;
    do {
      byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (++bytesRead > 10) throw new Error('spm: varint too long (corrupt protobuf?)');
    } while (byte & 0x80);
    return result;
  }

  float32() {
    if (this.p + 4 > this.b.length) throw new Error('spm: truncated float32 field');
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getFloat32(0, true);
    this.p += 4;
    return v;
  }

  bytes(len) {
    if (len < 0 || this.p + len > this.b.length) throw new Error('spm: truncated length-delimited field');
    const out = this.b.subarray(this.p, this.p + len);
    this.p += len;
    return out;
  }

  string(len) {
    return new TextDecoder('utf-8').decode(this.bytes(len));
  }

  skip(wireType) {
    switch (wireType) {
      case 0: this.varintNum(); break; // varint
      case 1: this.p += 8; break; // fixed64
      case 2: { const len = this.varintNum(); this.p += len; break; } // length-delimited
      case 5: this.p += 4; break; // fixed32
      default: throw new Error(`spm: unsupported protobuf wire type ${wireType}`);
    }
    if (this.p > this.b.length) throw new Error('spm: field length exceeds buffer (corrupt protobuf?)');
  }
}

/**
 * Reads (field_number, wire_type) tags from `r` until `end`, calling
 * `onField(fieldNumber, wireType)` for each — which must fully consume the
 * field's value (read it, or call `r.skip(wireType)`). Verifies the message
 * consumed exactly its declared length, which catches most corruption.
 */
function parseMessage(r, end, onField) {
  if (end > r.b.length) throw new Error('spm: message length exceeds buffer (corrupt protobuf?)');
  while (r.p < end) {
    const tag = r.varintNum();
    onField(tag >>> 3, tag & 7);
  }
  if (r.p !== end) throw new Error('spm: message boundary mismatch (corrupt protobuf?)');
}

function parseSentencePiece(r, end) {
  let piece = '';
  let score = 0;
  let type = PIECE_TYPE.NORMAL; // proto default
  parseMessage(r, end, (fn, wt) => {
    if (fn === 1 && wt === 2) piece = r.string(r.varintNum());
    else if (fn === 2 && wt === 5) score = r.float32();
    else if (fn === 3 && wt === 0) type = r.varintNum();
    else r.skip(wt);
  });
  if (!piece) throw new Error('spm: encountered a piece with an empty string');
  return { piece, score, type };
}

/** Parses a serialized ModelProto into {pieces, byteFallback, normalizerSpec}. */
function parseModelProto(bytes) {
  const r = new ByteReader(bytes);
  const pieces = [];
  let byteFallback = false;
  let treatWhitespaceAsSuffix = false;
  const normalizerSpec = {
    name: '',
    precompiledCharsmap: null,
    // NormalizerSpec proto defaults:
    addDummyPrefix: true,
    removeExtraWhitespaces: true,
    escapeWhitespaces: true,
  };

  parseMessage(r, bytes.length, (fn, wt) => {
    if (fn === 1 && wt === 2) { // pieces (repeated SentencePiece)
      const len = r.varintNum();
      const end = r.p + len;
      pieces.push(parseSentencePiece(r, end));
    } else if (fn === 2 && wt === 2) { // trainer_spec
      const len = r.varintNum();
      const end = r.p + len;
      parseMessage(r, end, (fn2, wt2) => {
        if (fn2 === 35 && wt2 === 0) byteFallback = r.varintNum() !== 0;
        else if (fn2 === 24 && wt2 === 0) treatWhitespaceAsSuffix = r.varintNum() !== 0;
        else r.skip(wt2);
      });
    } else if (fn === 3 && wt === 2) { // normalizer_spec
      const len = r.varintNum();
      const end = r.p + len;
      parseMessage(r, end, (fn2, wt2) => {
        if (fn2 === 1 && wt2 === 2) normalizerSpec.name = r.string(r.varintNum());
        else if (fn2 === 2 && wt2 === 2) normalizerSpec.precompiledCharsmap = r.bytes(r.varintNum());
        else if (fn2 === 3 && wt2 === 0) normalizerSpec.addDummyPrefix = r.varintNum() !== 0;
        else if (fn2 === 4 && wt2 === 0) normalizerSpec.removeExtraWhitespaces = r.varintNum() !== 0;
        else if (fn2 === 5 && wt2 === 0) normalizerSpec.escapeWhitespaces = r.varintNum() !== 0;
        else r.skip(wt2);
      });
    } else {
      r.skip(wt);
    }
  });

  normalizerSpec.treatWhitespaceAsSuffix = treatWhitespaceAsSuffix;
  if (pieces.length === 0) throw new Error('spm: model has no pieces');
  return { pieces, byteFallback, normalizerSpec };
}

// ---------------------------------------------------------------------
// Precompiled charsmap: <uint32 trie byte-size><darts-clone double-array
// trie><NUL-separated replacement strings>. See google/sentencepiece's
// Normalizer::DecodePrecompiledCharsMap and third_party/darts_clone/darts.h.
// ---------------------------------------------------------------------

function parseCharsmap(buf) {
  if (buf.length <= 4) throw new Error('spm: precompiled_charsmap is too short');
  const header = new DataView(buf.buffer, buf.byteOffset, 4);
  const trieSize = header.getUint32(0, true);
  // darts unit size is 4 bytes, and the darts-clone builder always pads to a multiple of 1024 bytes.
  if (trieSize < 1024 || (trieSize & 0x3ff) !== 0) {
    throw new Error('spm: precompiled_charsmap trie size is invalid (corrupt model?)');
  }
  if (4 + trieSize >= buf.length) throw new Error('spm: precompiled_charsmap trie size exceeds buffer');

  const trieBytes = buf.subarray(4, 4 + trieSize);
  const trieView = new DataView(trieBytes.buffer, trieBytes.byteOffset, trieBytes.byteLength);
  const units = new Uint32Array(trieSize / 4);
  for (let i = 0; i < units.length; i++) units[i] = trieView.getUint32(i * 4, true);

  const normalized = buf.subarray(4 + trieSize);
  if (normalized.length === 0 || normalized[normalized.length - 1] !== 0) {
    throw new Error('spm: precompiled_charsmap replacement table is not NUL-terminated');
  }
  return { units, normalized };
}

// darts-clone unit bit layout (see darts.h DoubleArrayUnit).
function unitHasLeaf(u) { return ((u >>> 8) & 1) === 1; }
function unitValue(u) { return u & 0x7fffffff; }
// label() also carries bit 31 (see darts.h): a unit that is itself pure
// leaf/value storage (no outgoing label at all) sets that bit so it can
// never spuriously match a real input byte (which is always 0-255) — drop
// it and a value slot's low byte can coincidentally alias a real label,
// corrupting the walk (found the hard way: it sent commonPrefixSearch to a
// wildly out-of-range node on real charsmap data).
function unitLabel(u) { return (u & 0x800000ff) >>> 0; }
function unitOffset(u) { return (u >>> 10) << ((u & 0x200) >>> 6); }

/**
 * darts-clone commonPrefixSearch: walks `units` following the byte
 * transitions of `bytes` starting at `start`, collecting every prefix
 * (increasing length) that lands on a leaf. Ported from
 * DoubleArrayImpl::commonPrefixSearch in darts.h.
 */
function trieCommonPrefixSearch(units, bytes, start) {
  const results = [];
  let nodePos = 0 ^ unitOffset(units[0]);
  for (let i = start; i < bytes.length; i++) {
    const b = bytes[i];
    nodePos ^= b;
    if (nodePos < 0 || nodePos >= units.length) {
      throw new Error('spm: darts trie transition out of range (corrupt precompiled_charsmap?)');
    }
    const unit = units[nodePos];
    if (unitLabel(unit) !== b) break;
    nodePos ^= unitOffset(unit);
    if (unitHasLeaf(unit)) {
      if (nodePos < 0 || nodePos >= units.length) {
        throw new Error('spm: darts trie leaf out of range (corrupt precompiled_charsmap?)');
      }
      results.push({ length: i - start + 1, value: unitValue(units[nodePos]) });
    }
  }
  return results;
}

/**
 * Normalizer::NormalizePrefix: finds the replacement for the start of
 * `bytes` (from `pos` on). Returns {bytes: <replacement or passthrough
 * bytes>, consumed: <input bytes consumed>}.
 */
function normalizePrefix(bytes, pos, charsmap) {
  let longestLen = 0;
  let longestVal = 0;
  if (charsmap) {
    for (const m of trieCommonPrefixSearch(charsmap.units, bytes, pos)) {
      if (m.length > longestLen) { longestLen = m.length; longestVal = m.value; }
    }
  }
  if (longestLen === 0 || longestLen > bytes.length - pos || longestVal >= charsmap.normalized.length) {
    // No rule matched: pass one raw UTF-8 character through unchanged.
    // (Input bytes always come from TextEncoder, which is always
    // well-formed UTF-8, so we don't need sentencepiece's malformed-UTF-8
    // replacement-character fallback here.)
    const mblen = Math.min(oneCharLen(bytes[pos]), bytes.length - pos);
    return { bytes: bytes.subarray(pos, pos + mblen), consumed: mblen };
  }
  const table = charsmap.normalized;
  let end = longestVal;
  while (table[end] !== 0) end++;
  return { bytes: table.subarray(longestVal, end), consumed: longestLen };
}

/**
 * Normalizer::Normalize: applies the precompiled charsmap plus dummy-prefix
 * / whitespace-escaping / extra-whitespace-collapsing, matching
 * src/normalizer.cc exactly (including its specific order of operations).
 */
function normalize(text, spec, charsmap) {
  if (text.length === 0) return '';
  const bytes = new TextEncoder().encode(text);
  const total = bytes.length;
  let pos = 0;

  // Ignore heading whitespace.
  if (spec.removeExtraWhitespaces) {
    while (pos < total) {
      const p = normalizePrefix(bytes, pos, charsmap);
      if (!(p.bytes.length === 1 && p.bytes[0] === 0x20)) break;
      pos += p.consumed;
    }
  }
  if (pos >= total) return '';

  const kSpaceSymbol = spec.escapeWhitespaces ? [0xe2, 0x96, 0x81] : [0x20]; // U+2581
  const out = [];
  const addWs = () => out.push(...kSpaceSymbol);

  if (!spec.treatWhitespaceAsSuffix && spec.addDummyPrefix) addWs();

  let isPrevSpace = spec.removeExtraWhitespaces;
  while (pos < total) {
    const p = normalizePrefix(bytes, pos, charsmap);
    const sp = p.bytes;
    let start = 0;
    // Removes heading spaces in this replacement if the previous one ended with whitespace.
    while (isPrevSpace && start < sp.length && sp[start] === 0x20) start++;
    if (start < sp.length) {
      for (let n = start; n < sp.length; n++) {
        if (sp[n] === 0x20) addWs();
        else out.push(sp[n]);
      }
      isPrevSpace = sp[sp.length - 1] === 0x20;
    }
    pos += p.consumed;
    if (!spec.removeExtraWhitespaces) isPrevSpace = false;
  }

  // Ignore trailing whitespace.
  if (spec.removeExtraWhitespaces) {
    const ws = kSpaceSymbol;
    while (out.length >= ws.length && ws.every((v, i) => out[out.length - ws.length + i] === v)) {
      out.length -= ws.length;
    }
  }

  if (spec.treatWhitespaceAsSuffix && spec.addDummyPrefix) addWs();

  return new TextDecoder('utf-8').decode(new Uint8Array(out));
}

// ---------------------------------------------------------------------
// Unigram Viterbi segmentation (Model::EncodeOptimized in unigram_model.cc).
// ---------------------------------------------------------------------

/** A byte-keyed trie over vocabulary pieces, used to find every piece matching a prefix of the input. */
class PieceTrie {
  constructor() {
    this.root = { children: null, leaf: null };
  }

  insert(bytesKey, id, type) {
    let node = this.root;
    for (const b of bytesKey) {
      node.children ??= new Map();
      let next = node.children.get(b);
      if (!next) { next = { children: null, leaf: null }; node.children.set(b, next); }
      node = next;
    }
    if (node.leaf) throw new Error(`spm: piece is already defined (id ${id})`);
    node.leaf = { id, type };
  }
}

const kUserDefinedScore = (length) => 0.1 * (length - 1); // Model::GetUserDefinedScore

export class SentencePiece {
  /** Parses a serialized ModelProto (Uint8Array). Throws on malformed input. */
  static fromBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('spm: fromBytes expects a Uint8Array');
    return new SentencePiece(parseModelProto(bytes));
  }

  constructor({ pieces, byteFallback, normalizerSpec }) {
    this.pieces = pieces; // index === vocab id
    this.byteFallback = byteFallback;
    this.normalizerSpec = normalizerSpec;
    this.charsmap = normalizerSpec.precompiledCharsmap ? parseCharsmap(normalizerSpec.precompiledCharsmap) : null;

    // Mirrors ModelInterface::InitializePieces: NORMAL/USER_DEFINED/UNUSED
    // pieces are searchable (go in the trie); CONTROL/UNKNOWN/BYTE pieces
    // are only reachable by exact match (e.g. byte-fallback lookups).
    this.trie = new PieceTrie();
    this.reservedIdMap = new Map();
    const encoder = new TextEncoder();
    let minScore = Infinity;
    let unkId = -1;

    for (let id = 0; id < pieces.length; id++) {
      const p = pieces[id];
      const isSearchable = p.type === PIECE_TYPE.NORMAL || p.type === PIECE_TYPE.USER_DEFINED || p.type === PIECE_TYPE.UNUSED;
      if (isSearchable) {
        this.trie.insert(encoder.encode(p.piece), id, p.type);
      } else {
        if (this.reservedIdMap.has(p.piece)) throw new Error(`spm: piece "${p.piece}" is already defined`);
        this.reservedIdMap.set(p.piece, id);
      }
      if (p.type === PIECE_TYPE.NORMAL) minScore = Math.min(minScore, p.score);
      if (p.type === PIECE_TYPE.UNKNOWN) {
        if (unkId >= 0) throw new Error('spm: model defines more than one UNKNOWN piece');
        unkId = id;
      }
      if (p.type === PIECE_TYPE.BYTE && !byteFallback) {
        throw new Error(`spm: byte piece "${p.piece}" is present but byte_fallback is disabled`);
      }
    }
    if (unkId < 0) throw new Error('spm: model defines no UNKNOWN piece');
    this.unkId = unkId;
    this.minScore = Number.isFinite(minScore) ? minScore : 0;
  }

  /** id -> piece string (for debugging). */
  idToPiece(id) {
    const p = this.pieces[id];
    if (!p) throw new Error(`spm: invalid piece id ${id}`);
    return p.piece;
  }

  /** text -> array of piece ids (no BOS/EOS added), matching sentencepiece EncodeAsIds. */
  encode(text) {
    if (typeof text !== 'string') throw new Error('spm: encode expects a string');
    const normalized = normalize(text, this.normalizerSpec, this.charsmap);
    if (normalized.length === 0) return [];
    const bytes = new TextEncoder().encode(normalized);

    const ids = [];
    for (const seg of this._viterbi(bytes)) {
      if (seg.id === this.unkId && this.byteFallback) {
        // Byte-fallback: decompose the unmatched character's UTF-8 bytes
        // into individual byte pieces instead of emitting a single <unk>.
        for (let i = seg.start; i < seg.end; i++) {
          const piece = byteToPiece(bytes[i]);
          const id = this.reservedIdMap.get(piece);
          if (id === undefined) throw new Error(`spm: model is missing byte-fallback piece ${piece}`);
          ids.push(id);
        }
      } else {
        ids.push(seg.id);
      }
    }
    return ids;
  }

  /**
   * The O(n·k) Viterbi DP from Model::EncodeOptimized: for every byte
   * position, remembers only the best-scoring path ending there (and which
   * piece produced it), then backtracks once at the end. `bestScore` is
   * kept in a Float32Array, and every score sum is rounded with
   * Math.fround, to reproduce the reference's 32-bit float arithmetic
   * (and, with it, identical tie-breaking).
   */
  _viterbi(bytes) {
    const size = bytes.length;
    const unkScore = Math.fround(this.minScore - 10.0); // kUnkPenalty
    const bestScore = new Float32Array(size + 1);
    const bestStart = new Int32Array(size + 1).fill(-1);
    const bestId = new Int32Array(size + 1).fill(-1);

    const consider = (end, startsAt, id, score) => {
      if (bestStart[end] === -1 || score > bestScore[end]) {
        bestScore[end] = score;
        bestStart[end] = startsAt;
        bestId[end] = id;
      }
    };

    let startsAt = 0;
    while (startsAt < size) {
      const scoreTillHere = bestScore[startsAt];
      const mblen = Math.min(oneCharLen(bytes[startsAt]), size - startsAt);
      let hasSingleNode = false;

      let node = this.trie.root;
      for (let keyPos = startsAt; keyPos < size; keyPos++) {
        node = node.children ? node.children.get(bytes[keyPos]) : undefined;
        if (!node) break;
        if (node.leaf && node.leaf.type !== PIECE_TYPE.UNUSED) {
          const { id, type } = node.leaf;
          const length = keyPos - startsAt + 1;
          const pieceScore = type === PIECE_TYPE.USER_DEFINED
            ? Math.fround(kUserDefinedScore(length))
            : this.pieces[id].score;
          consider(keyPos + 1, startsAt, id, Math.fround(pieceScore + scoreTillHere));
          if (!hasSingleNode && length === mblen) hasSingleNode = true;
        }
      }
      if (!hasSingleNode) {
        consider(startsAt + mblen, startsAt, this.unkId, Math.fround(unkScore + scoreTillHere));
      }
      startsAt += mblen;
    }

    const segments = [];
    let endsAt = size;
    while (endsAt > 0) {
      const start = bestStart[endsAt];
      if (start === -1) throw new Error('spm: Viterbi failed to find a path (corrupt lattice)');
      segments.push({ start, end: endsAt, id: bestId[endsAt] });
      endsAt = start;
    }
    segments.reverse();
    return segments;
  }
}

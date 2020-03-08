const ainUtil = require('@ainblockchain/ain-util');
const ConsensusUtil = require('../consensus/util');

// NOTE(seo): To keep the blockchain deterministic as much as possibble over time,
// we keep util functions here self-contained as much as possible.
class BuiltInRuleUtil {
  constructor(db, blockchain) {
    this.db = db;
    this.bc = blockchain;
  }

  isNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  isString(value) {
    return typeof value === 'string';
  }

  isArray(value) {
    return Array.isArray(value);
  }

  isDict(value) {
    return (typeof value === 'object' && value !== null && !Array.isArray(value));
  }

  keys(value) {
    if (this.isDict(value)) {
      return Object.keys(value);
    }
    return [];
  }

  length(value) {
    if (this.isString(value) || this.isArray(value)) {
      return value.length;
    }
    if (this.isDict(value)) {
      return this.keys(value).length;
    }
    return 0;
  }

  isValAddr(addr) {
    return this.isString(addr) && ainUtil.isValidAddress(addr);
  }

  isCksumAddr(addr) {
    return this.isValAddr(addr) && addr === ainUtil.toChecksumAddress(addr);
  }

  isProposerForNumber(number, addr) {
    return ConsensusUtil.isProposerForNumber(this.db, this.bc, Number(number), addr);
  }

  isValidatorForNumber(number, addr) {
    return ConsensusUtil.isValidatorForNumber(this.db, Number(number), addr);
  }
}

module.exports = BuiltInRuleUtil
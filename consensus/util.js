const seedrandom = require('seedrandom');
const logger = require('../logger');
const ChainUtil = require('../chain-util');
const { ConsensusRef, ConsensusDefaultValues, ConsensusMessageTypes } = require('./constants');
const { PredefinedDbPaths, WriteDbOperations } = require('../constants');
const get = require('lodash/get');

class ConsensusUtil {
  static isValidOpType(tx) {
    switch(tx.operation.type) {
      case WriteDbOperations.SET_VALUE:
        return true;
      case WriteDbOperations.SET:
        for (let op of tx.operation.op_list) {
          if (op.type !== undefined && op.type !== WriteDbOperations.SET_VALUE) {
            return false;
          }
        }
        return true;
      default:
        return false;
    }
  }

  static isValidRef(tx) {
    if (tx.operation.type === WriteDbOperations.SET_VALUE) {
      const parsedPath = ChainUtil.parsePath(tx.operation.ref);
      // '/consensus/number/${number}/${prevote|precommit}/${address}' ==> 5
      return parsedPath.length === 5 || parsedPath[0] === 'consensus';
    } else {
      if (tx.operation.op_list.length !== 3) return false;
      for (let op of tx.operation.op_list) {
        const parsedPath = ChainUtil.parsePath(op.ref);
        // '/consensus/number/{number}/{propose|next_round_validators|next_round_propose}' ==> 4
        if (!parsedPath.length || parsedPath[0] !== 'consensus' ||
            parsedPath.length !== 4 || op.type !== WriteDbOperations.SET_VALUE) {
          return false;
        }
      }
      return true;
    }
  }

  static parseConsensusTransaction(tx) {
    logger.debug(`[parseConsensusTransaction] tx: ${JSON.stringify(tx)}`)
    const result = { address: tx.address };
    if (tx.operation.op_list) {
      // Propose (SET):
      //   SET_VALUE at /consensus/number/${number}/propose
      //   SET_VALUE at /consensus/number/${number}/next_round_validators
      //   SET_VALUE at /consensus/number/${number}/next_round_proposer
      result['block'] = tx.block;
      result['type'] = ConsensusMessageTypes.PROPOSE;
      const opList = get(tx, 'operation.op_list');
      for (let i = 0; i < opList.length; i++) {
        // TODO (lia): check if the next_round_validators and next_round_proposer
        // values are valid.
        const op = opList[i];
        const parsedPath = ChainUtil.parsePath(op.ref);
        if (parsedPath[3] === 'propose') {
          result['block_hash'] = op.value.block_hash;
        }
        if (result.number === undefined) {
          result['number'] = Number(parsedPath[2]);
        }
      }
    } else {
      // Prevote or precommit:
      //   SET_VALUE at /consensus/number/${number}/{prevote|precommit}
      const parsedPath = ChainUtil.parsePath(tx.operation.ref);
      result['type'] = parsedPath[3] === 'prevote' ?
          ConsensusMessageTypes.PREVOTE : ConsensusMessageTypes.PRECOMMIT;
      result['block_hash'] = tx.operation.value.voted_for;
      result['number'] = Number(parsedPath[2]);
    }
    return result;
  }

  static getNextRoundValidatorsFromState(db, number) {
    let nextRoundValidators = db.getValue(ConsensusRef.nextRoundValidators(number));
    if (!nextRoundValidators) {
      logger.debug(`Failed to get the next round validators. ` +
          `Consensus state at number ${number} doesn't exist.`);
      // TODO (lia): throw error?
      return null;
    }
    return nextRoundValidators;
  }

  // TODO (lia): Adjust voting power after each round
  static getWeightedRandomProposer(validators, seed) {
    if (!validators || !Object.keys(validators).length) {
      logger.debug(`Failed to get the proposer: no validators given.`);
      // TODO (lia): throw error?
      return false;
    }
    if (!seed) {
      logger.debug(`Failed to get the proposer: no seed for proposer selection algorithm.`);
      // TODO (lia): throw error?
      return false;
    }
    const alphabeticallyOrderedValidators = Object.keys(validators).sort();
    const totalAtStake = Object.values(validators)
        .reduce(
          function(a, b) {
            return a + b;
          }, 0);
    const randomNumGenerator = seedrandom(seed);
    const targetValue = randomNumGenerator() * totalAtStake;
    let cumulative = 0;
    for (let i = 0; i < alphabeticallyOrderedValidators.length; i++) {
      cumulative += validators[alphabeticallyOrderedValidators[i]];
      if (cumulative > targetValue) {
        logger.debug(`Proposer is ${alphabeticallyOrderedValidators[i]}`);
        return alphabeticallyOrderedValidators[i];
      }
    }
    logger.debug(`Failed to get the proposer.
                 validators: ${alphabeticallyOrderedValidators}
                 totalAtStake: ${totalAtStake}
                 seed: ${seed}
                 targetValue: ${targetValue}`);
    return false;
  }

  static getProposerForNumber(db, number) {
    logger.debug(`Current consensus status @ number ${number} from state:` + JSON.stringify(db.getValue(`/consensus/number/${number}`), null, 2))
    return db.getValue(`/consensus/number/${number}/proposer`);
  }

  static isProposerForNumber(db, bc, number, address) {
    let proposer = ConsensusUtil.getProposerForNumber(db, number);
    logger.debug(`[ConsensusUtil:isProposerForNumber] proposer from state: ${proposer}`);
    if (proposer) {
      logger.debug(`[ConsensusUtil:isProposerForNumber] proposer ${proposer} set in state for number ${number}`);
      // proposer is set in the global state
      return proposer === address;
    } else if (number === 1) {
      // TODO (lia): also check the consensus deposit of {addr}
      return db.getValue(ConsensusRef.baseForNumber(number)) === null;
    }
    // proposer is yet to be set (it's at the beginning of a new round/number)
    const validators = ConsensusUtil.getNextRoundValidatorsFromState(db, number - 1);
    if (number > 5 && bc.chain.length < 5) {
      logger.debug(`Failed to get the proposer: Invalid number ${number}. Current chain length is ${bc.chain.length}`);
      return false;
    }
    const seed = (number <= 5 ? bc.chain[0].hash : bc.chain[bc.chain.length - 5]).hash;
    proposer = ConsensusUtil.getWeightedRandomProposer(validators, seed);
    logger.debug(`[ConsensusUtil:isProposerForNumber] proposer ${proposer} calculated for number ${number}`)
    return proposer === address;
  }

  static getValidatorSetForNumber(db, number) {
    return db.getValue(`/consensus/number/${number}/validators`);
  }

  static isValidatorForNumber(db, number, address) {
    const registered = db.getValue(`/consensus/number/${number}/validators/${address}`);
    return registered !== null && registered > 0;
  }

  static getStakeForNumber(db, number, address) {
    const ref = ChainUtil.resolveDbPath([ConsensusRef.validators(number), address]);
    return db.getValue(ref) || 0;
  }

  static getValidConsensusDeposit(db, address) {
    const deposit = db.getValue(ChainUtil.resolveDbPath([
        PredefinedDbPaths.DEPOSIT_ACCOUNTS_CONSENSUS,
        address
      ]));
    if (deposit && deposit.value > 0 && deposit.expire_at > Date.now() + ConsensusDefaultValues.DAY_MS) {
      return deposit.value;
    }
    return 0;
  }

  static getLatestNumber(db) {
    return db.getValue(ConsensusRef.latestNumber()) || 0;
  }
}

module.exports = ConsensusUtil;
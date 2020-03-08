const logger = require('../logger');
const { PredefinedDbPaths, FunctionResultCode, DefaultValues } = require('../constants');
const { ConsensusRef, ConsensusDefaultValues } = require('../consensus/constants');
const ChainUtil = require('../chain-util');
const {FunctionProperties} = require('../constants')
const axios = require('axios')

const FUNC_PARAM_PATTERN = /^{(.*)}$/;
const EventListenerWhitelist = {'https://events.ainetwork.ai/trigger': true,
  'http://localhost:3000/trigger': true}

const FunctionPaths = {
  TRANSFER: `${PredefinedDbPaths.TRANSFER}/{from}/{to}/{key}/${PredefinedDbPaths.TRANSFER_VALUE}`,
  DEPOSIT: `${PredefinedDbPaths.DEPOSIT}/{service}/{user}/{deposit_id}/${PredefinedDbPaths.DEPOSIT_VALUE}`,
  WITHDRAW: `${PredefinedDbPaths.WITHDRAW}/{service}/{user}/{withdraw_id}/${PredefinedDbPaths.WITHDRAW_VALUE}`,
  PROPOSE: `${ConsensusRef.base()}/{block_number}/propose`,
  NEXT_ROUND_PROPOSER: `${ConsensusRef.base()}/{block_number}/next_round_proposer`,
  NEXT_ROUND_VALIDATORS: `${ConsensusRef.base()}/{block_number}/next_round_validators`,
  PREVOTE: `${ConsensusRef.base()}/{block_number}/prevote/{user}`,
  PRECOMMIT: `${ConsensusRef.base()}/{block_number}/precommit/{user}`,
};

/**
 * Built-in functions with function paths.
 */
class Functions {
  constructor(db) {
    this.db = db;
    this.funcMap = {
      [FunctionPaths.TRANSFER]: this._transfer.bind(this),
      [FunctionPaths.DEPOSIT]: this._deposit.bind(this),
      [FunctionPaths.WITHDRAW]: this._withdraw.bind(this),
      [FunctionPaths.PROPOSE]: this._propose.bind(this),
      [FunctionPaths.NEXT_ROUND_PROPOSER]: this._setNextRoundProposer.bind(this),
      [FunctionPaths.NEXT_ROUND_VALIDATORS]: this._setNextRoundValidators.bind(this),
      [FunctionPaths.PREVOTE]: this._prevote.bind(this),
      [FunctionPaths.PRECOMMIT]: this._precommit.bind(this),
    };
  }

  /**
   * Runs functions of function paths matched with given database path.
   *
   * @param {Array} parsedValuePath parsed value path
   * @param {*} value value set on the database path
   * @param {Number} timestamp the time at which the transaction was created and signed
   */
  runBuiltInFunctions(parsedValuePath, value, address, timestamp, currentTime) {
    const matches = this.matchFunctionPaths(parsedValuePath);
    matches.forEach((elem) => {
      logger.info(
        `  ==> Running built-in function '${elem.func.name}' with value '${JSON.stringify(value)}', address '${address}', timestamp '${timestamp}', currentTime '${currentTime}' and params: ` +
        JSON.stringify(elem.params));
      elem.func(value, { params: elem.params, address, timestamp, currentTime });
    })
  }

  triggerEvent(transaction) {
    const parsedValuePath = ChainUtil.parsePath(transaction.operation.ref);
    const match = this.matchTriggerPaths(parsedValuePath);
    if (match && match.event_listener) {
      if (match.event_listener in EventListenerWhitelist) {
        logger.info(
          `  ==> Triggering function event'${match.event_listener}' with transaction '${transaction}'`)
        return axios.post(match.event_listener, {
          transaction: transaction,
          function: match
        })
      }
    }
  }

  // TODO(seo): Optimize function path matching (e.g. using Aho-Corasick-like algorithm).
  matchFunctionPaths(parsedValuePath) {
    let funcs = [];
    Object.keys(this.funcMap).forEach((path) => {
      const parsedFuncPath = ChainUtil.parsePath(path);
      const result = Functions.matchPaths(parsedValuePath, parsedFuncPath);
      if (result !== null) {
        funcs.push({ func: this.funcMap[path], params: result.params })
      }
    });
    return funcs;
  }

  static matchPaths(parsedValuePath, parsedFuncPath) {
    if (parsedFuncPath.length === parsedValuePath.length) {
      let params = {};
      let matched = true;
      for (let i = 0; i < parsedFuncPath.length; i++) {
        if (parsedFuncPath[i].match(FUNC_PARAM_PATTERN)) {
          const paramName = parsedFuncPath[i].replace(FUNC_PARAM_PATTERN, '$1');
          params[paramName] = parsedValuePath[i];
        } else if (parsedFuncPath[i] !== parsedValuePath[i]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { params };
      }
    }
    return null
  }

  matchTriggerPaths(parsedValuePath) {
    let params = {};
    let matched = true;
    let currentRef = this.db.getRefForReading([PredefinedDbPaths.FUNCTIONS_ROOT])
    if (!currentRef) {
      return null;
    }
    for (let i = 0; i < parsedValuePath.length; i++) {
      if (currentRef[parsedValuePath[i]]) {
        currentRef = currentRef[parsedValuePath[i]]
      } else {
        // check for wildcards.
        const keys = Object.keys(currentRef);
        let found = false;
        for (let j = 0; j < keys.length; j++) {
          if (keys[j].startsWith('$')) {
            currentRef = currentRef[keys[j]];
            // TODO(minhyun): Support multiple match.
            found = true;
            break;
          }
        }
        if (!found) {
          return null;
        }
      }
    }
    if (currentRef) {
      return currentRef[FunctionProperties.FUNCTION]
    }
    return null;
  }

  // TODO(seo): Add adress validity check.
  _transfer(value, context) {
    const from = context.params.from;
    const to = context.params.to;
    const key = context.params.key;
    const fromBalancePath = this._getBalancePath(from);
    const toBalancePath = this._getBalancePath(to);
    const resultPath = this._getTransferResultPath(from, to, key);
    if (this._transferInternal(fromBalancePath, toBalancePath, value)) {
      this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(resultPath)),
          { code: FunctionResultCode.SUCCESS });
    } else {
      this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(resultPath)),
          { code: FunctionResultCode.INSUFFICIENT_BALANCE });
    }
  }

  _deposit(value, context) {
    const service = context.params.service;
    const user = context.params.user;
    const depositId = context.params.deposit_id;
    const timestamp = context.timestamp;
    const currentTime = context.currentTime;
    const resultPath = this._getDepositResultPath(service, user, depositId);
    const depositCreatedAtPath = this._getDepositCreatedAtPath(service, user, depositId);
    this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(depositCreatedAtPath)), timestamp);
    if (timestamp > currentTime) { // TODO (lia): move this check to when we first receive the transaction
      this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(resultPath)),
          { code: FunctionResultCode.FAILURE });
      return;
    }
    const userBalancePath = this._getBalancePath(user);
    const depositAmountPath = this._getDepositAmountPath(service, user);
    if (this._transferInternal(userBalancePath, depositAmountPath, value)) {
      const lockup = this.db.getValue(this._getDepositLockupDurationPath(service)) ||
          DefaultValues.DEPOSIT_LOCKUP_DURATION_MS;
      const expirationPath = this._getDepositExpirationPath(service, user);
      this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(expirationPath)),
          Number(timestamp) + Number(lockup));
      this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(resultPath)),
          { code: FunctionResultCode.SUCCESS });
    } else {
      this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(resultPath)),
          { code: FunctionResultCode.INSUFFICIENT_BALANCE });
    }
  }

  _withdraw(value, context) {
    const service = context.params.service;
    const user = context.params.user;
    const withdrawId = context.params.withdraw_id;
    const timestamp = context.timestamp;
    const currentTime = context.currentTime;
    const depositAmountPath = this._getDepositAmountPath(service, user);
    const userBalancePath = this._getBalancePath(user);
    const resultPath = this._getWithdrawResultPath(service, user, withdrawId);
    const withdrawCreatedAtPath = this._getWithdrawCreatedAtPath(service, user, withdrawId);
    this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(withdrawCreatedAtPath)), timestamp);
    if (this._transferInternal(depositAmountPath, userBalancePath, value)) {
      const expireAt = this.db.getValue(this._getDepositExpirationPath(service, user));
      if (expireAt <= currentTime) {
        this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(resultPath)),
            { code: FunctionResultCode.SUCCESS });
      } else {
        // Still in lock-up period.
        this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(resultPath)),
            { code: FunctionResultCode.IN_LOCKUP_PERIOD });
      }
    } else {
      // Not enough deposit.
      this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(resultPath)),
          { code: FunctionResultCode.INSUFFICIENT_BALANCE });
    }
  }

  // Triggered by setting a value at '/consensus/number/{block_number}/propose'
  // sets values at:
  //    /consensus/number/{block_number}/proposer
  //    /consensus/number/{block_number}/validators
  //    /consensus/number/{block_number}/total_at_stake
  _propose(value, context) {
    const number = Number(context.params.block_number);
    const proposer = context.address;
    if (number > 1) {
      // Do something.
    } else {
      // Set (current) validators and total_at_stake for the very first round.  
      const depositAmountPath = this._getDepositAmountPath('consensus', proposer);
      const depositExpirationPath = this._getDepositExpirationPath('consensus', proposer);
      const consensusDeposit = this.db.getValue(depositAmountPath);
      const expiration = this.db.getValue(depositExpirationPath);
      if (consensusDeposit > 0 && expiration > context.currentTime + ConsensusDefaultValues.DAY_MS) {
        logger.debug(`Updating proposer, validators and total_at_stake for number ${number}.`)
        this.db.writeDatabase(this._getFullValuePath(
          ChainUtil.parsePath(ConsensusRef.proposer(number))), proposer);
        this.db.writeDatabase(this._getFullValuePath(
            ChainUtil.parsePath(ConsensusRef.validators(number))), {[proposer]: consensusDeposit});
        this.db.writeDatabase(this._getFullValuePath(
            ChainUtil.parsePath(ConsensusRef.totalAtStake(number))), consensusDeposit);
      } else {
        logger.debug(`The proposer doesn't have enough consensus deposit. ` +
            `Deposit amount: ${consensusDeposit}, expiration: ${expiration}, currentTime: ${context.currentTime}`);
      } 
    }
    this._updateLatestBlockNumber(number + 1);
  }

  _setNextRoundProposer(value, context) {
    const number = Number(context.params.block_number);
    // const proposerPath = this._getProposerPath(number + 1);
      // TODO (lia): Things to check:
      // 1.The next proposer is in the next validator set
      // 2. ..
      // Add the checks in the rules?
    const proposerPath = ConsensusRef.proposer(number + 1);
    this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(proposerPath)), value);
  }

  _setNextRoundValidators(value, context) {
    const number = Number(context.params.block_number);
    // const validatorsPath = this._getValidatorsPath(number + 1);
    let totalAtStake = 0;
    let addresses = Object.keys(value);
    for (let addr of addresses) {
      // TODO (lia): Things to check:
      // 1. The staking values are numbers before triggering a built-in func.
      // 2. The validators actually have valid deposits.
      // Add the checks in the rules?
      totalAtStake += Number(value[addr]);
    }
    logger.debug(`value: ${JSON.stringify(value)}, context: ${JSON.stringify(context)}, totalAtStake: ${totalAtStake}`)
    const validatorsPath = ConsensusRef.validators(number + 1);
    const totalAtStakePath = ConsensusRef.totalAtStake(number + 1);
    this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(validatorsPath)), value);
    this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(totalAtStakePath)), totalAtStake);
  }

  _prevote(value, context) {
    const number = Number(context.params.block_number);
    // const prevoteSumPath = this._getPrevoteSumPath(number);
    const prevoteSumPath = ConsensusRef.prevoteSum(number);
    const currentSum = this.db.getValue(prevoteSumPath) || 0;
    logger.debug(`value: ${JSON.stringify(value)}, context: ${JSON.stringify(context)}, currentSum: ${currentSum}`)
    this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(prevoteSumPath)), currentSum + value);
  }

  _precommit(value, context) {
    const number = Number(context.params.block_number);
    // const precommitSumPath = this._getPrecommitSumPath(number);
    const precommitSumPath = ConsensusRef.precommitSum(number);
    const currentSum = this.db.getValue(precommitSumPath) || 0;
    logger.debug(`value: ${JSON.stringify(value)}, context: ${JSON.stringify(context)}, currentSum: ${currentSum}`)
    this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(precommitSumPath)), currentSum + value);
  }

  _transferInternal(fromPath, toPath, value) {
    const fromBalance = this.db.getValue(fromPath);
    if (fromBalance < value) return false;
    const toBalance = this.db.getValue(toPath);
    this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(fromPath)), fromBalance - value);
    this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(toPath)), toBalance + value);
    return true;
  }

  _updateLatestBlockNumber(newNumber) {
    const latestNumberPath = ConsensusRef.latestNumber();
    const currentNumber = this.db.getValue(latestNumberPath) || 0;
    if (currentNumber < newNumber) {
      logger.debug(`Updating /consensus/latest_number to ${newNumber}`);
      this.db.writeDatabase(this._getFullValuePath(ChainUtil.parsePath(latestNumberPath)), newNumber);
    }
  }

  _getBalancePath(address) {
    return `${PredefinedDbPaths.ACCOUNTS}/${address}/${PredefinedDbPaths.BALANCE}`;
  }

  _getTransferResultPath(from, to, key) {
    return (
      `${PredefinedDbPaths.TRANSFER}/${from}/${to}/${key}/${PredefinedDbPaths.TRANSFER_RESULT}`);
  }

  _getAllDepositsPath(service, user) {
    return (`${PredefinedDbPaths.DEPOSIT}/${service}/${user}`);
  }

  _getDepositLockupDurationPath(service) {
    return (`${PredefinedDbPaths.DEPOSIT_ACCOUNTS}/${service}/${PredefinedDbPaths.DEPOSIT_CONFIG}/${PredefinedDbPaths.DEPOSIT_LOCKUP_DURATION}`);
  }

  _getDepositAmountPath(service, user) {
    return (`${PredefinedDbPaths.DEPOSIT_ACCOUNTS}/${service}/${user}/${PredefinedDbPaths.DEPOSIT_VALUE}`);
  }

  _getDepositExpirationPath(service, user) {
    return (`${PredefinedDbPaths.DEPOSIT_ACCOUNTS}/${service}/${user}/${PredefinedDbPaths.DEPOSIT_EXPIRE_AT}`);
  }

  _getDepositCreatedAtPath(service, user, depositId) {
    return (`${PredefinedDbPaths.DEPOSIT}/${service}/${user}/${depositId}/${PredefinedDbPaths.DEPOSIT_CREATED_AT}`);
  }

  _getDepositResultPath(service, user, depositId) {
    return (`${PredefinedDbPaths.DEPOSIT}/${service}/${user}/${depositId}/${PredefinedDbPaths.DEPOSIT_RESULT}`);
  }

  _getWithdrawCreatedAtPath(service, user, withdrawId) {
    return (`${PredefinedDbPaths.WITHDRAW}/${service}/${user}/${withdrawId}/${PredefinedDbPaths.WITHDRAW_CREATED_AT}`);
  }

  _getWithdrawResultPath(service, user, withdrawId) {
    return (`${PredefinedDbPaths.WITHDRAW}/${service}/${user}/${withdrawId}/${PredefinedDbPaths.WITHDRAW_RESULT}`);
  }

  _getFullValuePath(parsedPath) {
    return this.db.getFullPath(parsedPath, PredefinedDbPaths.VALUES_ROOT);
  }
}

module.exports = Functions;


const ConsensusMessageTypes = {
  // NEW_ROUND: 'new_round',
  PROPOSE: 'propose',
  PREVOTE: 'prevote',
  PRECOMMIT: 'precommit',
};

const ConsensusSteps = {
  NEW_NUMBER: 1,
  PROPOSE: 2,
  PREVOTE: 3,
  PRECOMMIT: 4,
  COMMIT: 5
}

const ConsensusRoutineIds = {
  HANDLE_VOTE: 'handle_vote',
  PROCEED: 'proceed'
}

const ConsensusDefaultValues = {
  TWO_THIRDS: 2 / 3,
  DAY_MS: 86400000
}

class Ref {
  base() {
    return '/consensus/number';
  }

  latestNumber() {
    return '/consensus/latest_number';
  }

  baseForNumber(number) {
    return `${this.base()}/${number}`;
  }

  validators(number) {
    return `${this.baseForNumber(number)}/validators`;
  }

  nextRoundValidators(number) {
    return `${this.baseForNumber(number)}/next_round_validators`;
  }

  proposer(number) {
    return `${this.baseForNumber(number)}/proposer`;
  }

  nextRoundProposer(number) {
    return `${this.baseForNumber(number)}/next_round_proposer`;
  }

  propose(number) {
    return `${this.baseForNumber(number)}/propose`;
  }

  prevote(number) {
    return `${this.baseForNumber(number)}/prevote`;
  }

  prevoteSum(number) {
    return `${this.baseForNumber(number)}/prevote_sum`;
  }

  precommit(number) {
    return `${this.baseForNumber(number)}/precommit`;
  }

  precommitSum(number) {
    return `${this.baseForNumber(number)}/precommit_sum`;
  }

  totalAtStake(number) {
    return `${this.baseForNumber(number)}/total_at_stake`;
  }
}


module.exports = {
  ConsensusMessageTypes,
  ConsensusSteps,
  ConsensusRoutineIds,
  ConsensusDefaultValues,
  ConsensusRef: new Ref(),
}
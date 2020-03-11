/**
 * AI Network Blockchain's Consensus module.
 * TODOs:
 *   - Add a timeout for each step (ref: https://github.com/tendermint/tendermint/blob/4bfec797e8f9c8be5d3666554bb9d6c1ff47f475/consensus/state.go#L741) 
 *   - 
 */
const logger = require('../logger');
const Transaction = require('../tx-pool/transaction');
const { Block } = require('../blockchain/block');
const ChainUtil = require('../chain-util');
const ConsensusUtil = require('./util');
const PushId = require('../db/push-id');
const {
  MessageTypes,
  STAKE,
  WriteDbOperations,
  DEBUG,
  PredefinedDbPaths
} = require('../constants');
const {
  ConsensusMessageTypes,
  ConsensusSteps,
  ConsensusDefaultValues,
  ConsensusRef,
  ConsensusRoutineIds
} = require('./constants');

class Consensus {
  constructor(server, node) {
    this.server = server;
    this.node = node;
    this.initialized = false;
    this.voteQueue = [];
    this.voteRoutine = null;
    this.state = {
      number: 1,
      step: 0,
      proposedBlock: null,
      votes: {}
    };
  }

  init(peerState) {
    this.catchUp(peerState);
    
    // Stake if we haven't already.
    // TODO (lia): Improve staking / restaking logic
    const currentStake = ConsensusUtil.getStakeForNumber(this.node.db, this.state.number, this.node.account.address);
    logger.info("[Consensus:init] Current stake: " + currentStake);
    if (!currentStake && !!STAKE) {
      this.stake(STAKE);
    } else if (!currentStake && !STAKE) {
      logger.info(`[Consensus:init] Exiting consensus initialization: Node doesn't have any stakes`);
      return;
    }

    this.initialized = true;
    logger.info(`[Consensus:init] Initialized to number ${this.state.number}`);
    this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
    this.startConsensusRoutine();
  }

  startConsensusRoutine() {
    if (this.voteRoutine) {
      clearInterval(this.voteRoutine);
    }
    this.voteRoutine = setInterval(() => {
      logger.debug(`[Consensus:startConsensusRoutine] Queue length before: ${this.voteQueue.length}`);
      const message = this.voteQueue.shift();
      logger.debug(`[Consensus:startConsensusRoutine] Queue length after: ${this.voteQueue.length}`);
      logger.debug(`[Consensus:startConsensusRoutine] Current state: number ${this.state.number}, step ${this.state.step}`)
      // Try proceeding to the next step if the queue is empty (message is undefined).
      // Do not process message if it's no longer relevant.
      if (message === undefined || message.id === ConsensusRoutineIds.PROCEED) {
        if (message !== undefined && (message.number < this.state.number ||
              (message.number === this.state.number && message.step < this.state.step))) {
          return;
        }
        switch (this.state.step) {
          case ConsensusSteps.NEW_NUMBER:
            this.enterOrStayInPropose();
            break;
          case ConsensusSteps.PROPOSE:
            this.enterOrStayInPrevote();
            break;
          case ConsensusSteps.PREVOTE:
            this.enterOrStayInPrevote();
            break;
          case ConsensusSteps.PRECOMMIT:
            this.enterOrStayInPrecommit();
            break;
          case ConsensusSteps.COMMIT:
            this.enterOrStayInNewNumber();
            break;
        }
      } else if (message.id === ConsensusRoutineIds.HANDLE_VOTE) {
        this.handleConsensusTransaction(message.tx, message.from);
      }
    // }, 1000);
    }, 300);
  }

  stopConsensusRoutine() {
    // TODO (lia): Implement this function
  }

  enqueue(message) {
    if (!message) {
      return;
    }
    logger.debug(`[Consensus:enqueue] message id: ${message.id}`);
    logger.debug(`[Consensus:enqueue] Queue length before: ${this.voteQueue.length}`);
    this.voteQueue.push(message);
    logger.debug(`[Consensus:enqueue] Queue length after: ${this.voteQueue.length}`);
  }

  /**
   * Try to update the consensus state to the last committed block.
   * The votes for this 'block' and last_votes have to be applied by catchUpConsensusState().
   * @param {*} block 
   */
  // tryUpdateToLastBlockState(block, shouldUpdateVoteSet) {
  //   if (!block || this.state.number > block.number) {
  //     logger.debug(`[Consensus:tryUpdateToLastBlockState] Can't update consensus state.`)
  //     return false;
  //   }
  //   if (this.node.bc.lastBlockNumber() !== block.number) {
  //     logger.debug(`[Consensus:tryUpdateToLastBlockState] lastBlockNumber (${this.node.bc.lastBlockNumber()}) doesn't equal block.number (${block.number}). state.number: ${this.state.number}`)
  //     return false;
  //   }
  //   logger.debug(`[Consensus:tryUpdateToLastBlockState] Updating state to number ${block.number}`);
  //   // TODO (lia): execute and add last_votes of block.
  //   this.state = {
  //     number: block.number, // + 1, // To get the votes for the committed block (last_votes for the block to be proposed)
  //     step: ConsensusSteps.NEW_NUMBER,
  //     proposedBlock: null,
  //     votes: {}
  //   };

  //   // FIX ME: Fix reconstructing chain and starting consensus logic.
  //   if (shouldUpdateVoteSet) {
  //     const secondToLastBlock = this.node.bc.chain[this.node.bc.chain.length - 2];
  //     this.addVoteListFromBlocks(block, secondToLastBlock);
  //     this.startConsensusRoutine()
  //   }
  // }

  catchUpConsensusState(consensusState) {
    if (!consensusState) {
      logger.debug("[Consensus:catchUpConsensusState] No consensus state received");
      return false;
    }
    const currentNumber = this.state.number;
    if (consensusState.number < currentNumber) {
      logger.debug(`Peer's consensus state is behind mine`);
      // TODO (lia): send my consensus state to the peer?
      return;
    }
    // TODO (lia): store the peer's state separately? (for each peer?)
    const keys = Object.keys(consensusState.votes).sort();
    logger.debug("[Consensus:catchUpConsensusState] votes:" + JSON.stringify(consensusState.votes, null, 2))
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] >= currentNumber - 1) {
        const voteList = consensusState.votes[keys[i]];
        for (let j = 0; j < voteList.length; j++) {
          const vote = voteList[j];
          if (vote.type === ConsensusMessageTypes.PROPOSE && vote.block !== undefined) {
            vote.tx.block = vote.block;
          }
          this.handleConsensusTransaction(vote.tx);
        }
      } else {
        logger.debug(`keys[i] (${keys[i]}) < currentNumber (${currentNumber})`)
      }
    }
  }

  catchUp(peerState) {
    // 1. Set consensus state number and step according to the last finalized block I have.
    const lastBlockNumber = this.node.bc.lastBlockNumber();
    if (peerState && this.state.number > peerState.number) {
      logger.debug(`[Consensus:catchUp] Failed to catch up: My state (${this.state.number}) is ahead of peer's (${peerState.number})`);
      return;
    }
    if (this.state.number > lastBlockNumber + 1) {
      logger.debug(`[Consensus:catchUp] Failed to catch up: My state (${this.state.number}) is ahead of my blockchain (${lastBlockNumber})`);
      return;
    }
    this.state.number = lastBlockNumber + 1;
    this.state.step = ConsensusSteps.NEW_NUMBER;
    // FIX ME: These two values might have to be adjusted case by case
    this.state.proposedBlock = null;
    this.state.proposer = null;
    // 2. Apply last_votes in the unfinalized block (candidate) from the blockPool. This is the block
    //    that comes after the last finalized block but I do not have votes for it yet.
    const candidate = this.node.bc.blockPool[this.state.number];
    if (lastBlockNumber < 0) {
      throw Error(`[Consensus:catchUp] Failed to catch up: Invalid lastBlockNumber (${lastBlockNumber})`);
    }
    if (lastBlockNumber > 0) {
      if (!candidate) {
        throw Error(`[Consensus:catchUp] Failed to catch up: No candidate block that contains votes for lastBlock.`);
      }
      // Execute last_votes of the candidate block (votes for the lastBlock)
      this.addVoteListFromBlocks(candidate, this.node.bc.lastBlock());
    }
    // 3. Try to catch up to the peer's state (may contain votes for the candidate block and more).
    if (peerState) {
      logger.debug(`[Consensus:catchUp] Catching up consensus state from peer's state:` + JSON.stringify(peerState, null, 2))
      this.catchUpConsensusState(peerState);
    }
  }

  handleConsensusTransaction(rawTx, from) {
    const inTxPool = this.node.tp.transactions[rawTx.hash];
    if (inTxPool) {
      // Consensus tx only exists in txPool's tx tracker if it's been
      // included in a block.
      logger.degug("[Consensus:handleConsensusTransaction] vote already in tx tracker");
      return;
    }
    if (!rawTx || !Transaction.hasRequiredFields(rawTx) || rawTx.nonce !== -1 ||
        !ConsensusUtil.isValidOpType(rawTx) || !ConsensusUtil.isValidRef(rawTx)) {
      logger.error("Invalid tx type or ref (possibly a get or a rule/owner setting transaction)");
      return;
    }
    const parsedTx = ConsensusUtil.parseConsensusTransaction(rawTx);
    logger.debug(`[Consensus:handleConsensusTransaction] tx from ${from}:\nrawTx:` + JSON.stringify(rawTx, null, 2) + "\n\nparsedTx:" + JSON.stringify(parsedTx, null, 2))
    if (!parsedTx) {
      // TODO (lia): reset temporary proposed block snapshot
      logger.error("Invalid consensus transaction received." + JSON.stringify(rawTx, null, 2));
      return;
    }
    if (this.hasSeenVote(rawTx.hash, parsedTx.number)) {
      if (parsedTx.number <= this.state.number) {
        logger.debug("[Consensus:handleConsensusTransaction] already seen this vote:" + JSON.stringify(parsedTx, null, 2));
        return;
      }
    } else {
      const response = this.server.executeAndBroadcastTransaction(rawTx, from, MessageTypes.CONSENSUS);
      if (!ChainUtil.txExecutedSuccessfully(response)) {
        logger.error("Consensus tx failed. Tx:" + JSON.stringify(rawTx, null, 2) + "result:" + JSON.stringify(response));
        // TODO (lia): return better error codes
        if (parsedTx.number > this.state.number) {
          logger.debug(`[${parsedTx.number} / ${this.state.number}] Tx failed possibly because we're out of sync. Requesting chain subsections to catch up...`);
          this.server.requestChainSubsection(this.node.bc.lastBlock());
        }
        return;
      }
    }
    // TODO (lia): reduce the number of times a tx is unmarshalled
    const tx = new Transaction(rawTx);
    switch (parsedTx.type) {
      case ConsensusMessageTypes.PROPOSE:
        this.handleProposal(tx, parsedTx);
        return;
      case ConsensusMessageTypes.PREVOTE:
      case ConsensusMessageTypes.PRECOMMIT:
        this.handleVote(tx, parsedTx)
        return;
      default:
        logger.error("Invalid voting action type received.");
    }
  }

  handleProposal(tx, parsedTx) {
    const { block, block_hash, number, address } = parsedTx;
    if (this.state.number !== number) {
      // if (this.node.bc.lastBlockNumber() !== number /*|| this.proposalFromVoteList(number)*/) {
        if (number > this.state.number) {
          logger.debug(`[Consensus:handleProposal] Received a future proposal. Adding to the vote set.`);
          // TODO (lia): validate proposal
          this.addVote(tx, parsedTx);
          this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
        } else if (number === this.state.number - 1 && !this.proposalFromVoteList(number)) {
          logger.debug(`[Consensus:handleProposal] Trying to add a proposal for a previous number`);
          this.addVote(tx, parsedTx);
        } else {
          logger.debug(`[Consensus:handleProposal] Received a proposal for a wrong block number (Expected: ${this.state.number}, Received: ${number})`);
        }
        return;
      // } else {
      //   logger.debug("[Consensus:handleProposal] Catching up.. received a proposal for the last committed block.");
      // }
    }

    if (this.state.proposedBlock) {
      if (this.state.proposedBlock.hash !== block_hash) {
        logger.error(`Invalid proposal received for number ${this.state.number}.\n` +
            `Currently have ${this.state.proposedBlock.hash} and got another proposal for ${block_hash} from ${address}`);
        return;
      } else {
        // Received the same proposal. Ignore.
        // this.enterOrStayInPropose();
        this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
        return;
      }
    }

    if (this.checkProposal({ block, block_hash })) {
      this.addVote(tx, parsedTx);
      this.state.proposedBlock = block;
      this.state.proposer = address;
      // this.enterOrStayInPropose();
      this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
    } else {
      // TODO (lia): reset proposed block snapshot
    }
  }

  // We might need to consider adding "straggler commit from the previous commit"
  // (ref: https://github.com/tendermint/tendermint/blob/7d7b47a39a91e565278135d8c76f9706c8a6c65b/consensus/state.go#L1695)
  handleVote(tx, parsedTx) {
    this.addVote(tx, parsedTx);
    if (parsedTx.number !== this.state.number) {
      if (DEBUG) {
        logger.debug(`Received a ${parsedTx.type} for a wrong block number.` +
            `Expected: ${this.state.number}) / Actual: ${parsedTx.number}`);
      }
      return;
    }
    if (parsedTx.type === ConsensusMessageTypes.PREVOTE) {
      // this.enterOrStayInPrevote();
      this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
    } else {
      // this.enterOrStayInPrecommit();
      this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
    }
  }

  twoThirdsAgreed(type) {
    const blockNumber = this.state.number;
    const totalAtStake = this.node.db.getValue(ConsensusRef.totalAtStake(blockNumber));
    const majority = totalAtStake * ConsensusDefaultValues.TWO_THIRDS;
    let tallied = 0;
    let ref;
    if (type === ConsensusMessageTypes.PREVOTE) {
      ref = ConsensusRef.prevoteSum(blockNumber);
    } else if (type === ConsensusMessageTypes.PRECOMMIT) {
      ref = ConsensusRef.precommitSum(blockNumber);
    } else {
      logger.error(`[Consensus:twoThirdsAgreed] Invalid type: ${type}`);
      return false;
    }
    tallied = this.node.db.getValue(ref);
    logger.debug(`[Consensus:twoThirdsAgreed] type: ${type}, totalAtStake: ${totalAtStake}, majority: ${majority}, tallied: ${tallied}`);
    if (!tallied) return false;
    // TODO (lia): Return the majority voted block's hash if tallied >= majority.
    return tallied >= majority;
  }

  addVoteListFromBlocks(lastBlock, secondToLastBlock) {
    if (!lastBlock || !secondToLastBlock) {
      throw Error('[Consensus:addVoteListFromBlocks] Trying to start consensus with an invalid chain.');
    }
    // TODO (lia): validate the last_votes
    lastBlock.last_votes.forEach(vote => {
      this.server.executeTransaction(vote, MessageTypes.CONSENSUS);
      const parsed = ConsensusUtil.parseConsensusTransaction(vote);
      if (parsed.type === ConsensusMessageTypes.PROPOSE) {
        parsed['block'] = secondToLastBlock;
      }
      this.addVote(vote, parsed);
    })
  }

  addVote(consensusTx, parsedTx) {
    const number = parsedTx.number;
    logger.debug(`Adding a vote @ number ${number}:` + JSON.stringify(parsedTx, null, 2));
    if (!this.state.votes[number]) {
      this.state.votes[number] = [];
    }
    let votesForNumber = this.state.votes[number];
    if (!(votesForNumber.filter(vote => vote.tx.hash === consensusTx.hash).length)) {
      const item = {
        type: parsedTx.type,
        tx: consensusTx
      }
      if (parsedTx.type === ConsensusMessageTypes.PROPOSE) {
        item['block'] = parsedTx.block;
      }
      votesForNumber.push(item);
      logger.debug("[Consensus:addVote] Success:" + JSON.stringify(this.state.votes, null, 2))
      return true;
    }
    // if (DEBUG) {
      logger.debug(`Failed to add to votes: tx (${consensusTx.hash}) from ${consensusTx.address} of type ${parsedTx.type} already received.`);
    // }
    return false;
  }

  // Applies votes from this.state.votes that are for blocks with numbers >= 'number'.
  applyVotesToDb(number) {
    const keys = Object.keys(this.state.votes).sort();
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] >= number) {
        const voteList = this.state.votes[keys[i]];
        for (let j = 0; j < voteList.length; j++) {
          const vote = voteList[j];
          if (vote.type === ConsensusMessageTypes.PROPOSE && vote.block !== undefined) {
            vote.tx.block = vote.block;
          }
          this.server.executeTransaction(vote.tx, MessageTypes.CONSENSUS);
        }
      } else {
        logger.debug(`keys[i] (${keys[i]}) < number (${number})`)
      }
    }
  }

  proposalFromVoteList(number) {
    const voteList = this.state.votes[number];
    if (!voteList) return null;
    const proposal = voteList.filter((vote) => { return vote.type === ConsensusMessageTypes.PROPOSE });
    if (proposal.length > 1) {
      logger.info(`[Consensus:proposalFromVoteList] Multiple proposals received for number ${number}:` + JSON.stringify(proposal, null, 2));
    }
    if (proposal.length) {
      proposal[0].tx['block'] = proposal[0].block;
      return proposal[0];
    }
    return null;
  }

  enterOrStayInNewNumber() {
    logger.debug(`\n[Consensus:enterOrStayInNewNumber] number: ${this.state.number}, step: ${this.state.step}\n`)
    const newNumber = this.node.bc.lastBlockNumber() + 1;
    if (this.state.number !== newNumber - 1) {
      logger.debug(`Failed to enter new number. New number (${newNumber}) ` +
          `is not the number following current state's number (${this.state.number})`);
      return;
    }
    if (this.state.number !== 0 && this.state.step !== ConsensusSteps.COMMIT) {
      logger.debug(`Failed to enter new number. Current step (${this.state.step}) is not "commit".`);
      return;
    }
    this.state.number = newNumber;
    this.state.step = ConsensusSteps.NEW_NUMBER;
    // sleep(2000);
    // this.enterOrStayInPropose();
    this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
  }

  enterOrStayInPropose() {
    logger.debug(`\n[Consensus:enterOrStayInPropose] number: ${this.state.number}, step: ${this.state.step}\n`)
    if (this.state.step !== ConsensusSteps.NEW_NUMBER && this.state.step !== ConsensusSteps.PROPOSE) {
      logger.debug(`Failed to enter PROPOSE step: Current step is ${this.state.step}`);
      return;
    }

    if (!this.state.proposedBlock) {
      logger.debug(`[Consensus:enterOrStayInPropose] No proposedBlock set`);
      if (this.isProposer(this.node.account.address)) {
        logger.debug(`[Consensus:enterOrStayInPropose] I'm the next proposer. Proposing a block..`);
        // A block may be in the blockPool. 
        // TODO (lia): Validate candidateBlock.
        const candidateBlock = this.node.bc.blockPool[this.state.number];
        const proposalBlock = candidateBlock ? candidateBlock : this.createProposalBlock();
        const proposal = this.createProposal(proposalBlock);
        this.server.executeTransaction(proposal, MessageTypes.CONSENSUS);
        this.state.proposedBlock = proposalBlock;
        this.state.proposer = this.node.account.address;
        this.state.step = ConsensusSteps.PROPOSE;
        const proposalWithBlock = Object.assign({}, proposal, { block: proposalBlock });
        this.addVote(proposal, ConsensusUtil.parseConsensusTransaction(proposalWithBlock));
        this.server.broadcastTransaction(proposalWithBlock, '', MessageTypes.CONSENSUS);
        // this.enterOrStayInPrevote();
        this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
      } else {
        // Check if we've received a proposal earlier
        const proposalTx = this.proposalFromVoteList(this.state.number);
        if (proposalTx) {
          logger.debug(`[Consensus:enterOrStayInPropose] Proposal has been received`);
          this.state.proposedBlock = proposalTx.block;
          this.state.proposer = proposalTx.address;
          this.state.step = ConsensusSteps.PROPOSE;
          this.enterOrStayInPrevote();
          // this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
        } else {
          logger.debug(`[Consensus:enterOrStayInPropose] No proposal has been received`);
        }
      }
    } else {
      logger.debug(`[Consensus:enterOrStayInPropose] Proposal block already set`);
      this.state.step = ConsensusSteps.PROPOSE;
      this.enterOrStayInPrevote();
      // this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
    }
  }

  enterOrStayInPrevote() {
    logger.debug(`\n[Consensus:enterOrStayInPrevote] number: ${this.state.number}, step: ${this.state.step}\n`)
    if (this.state.step !== ConsensusSteps.PROPOSE && this.state.step !== ConsensusSteps.PREVOTE) {
      logger.debug(`Failed to enter PREVOTE step: Current step is ${this.state.step}`);
      return;
    }
    if (!this.state.proposedBlock) {
      logger.debug(`Failed to enter PREVOTE: proposedBlock is not set.`);
      return;
    }
    if (this.state.step === ConsensusSteps.PROPOSE) {
      this.state.step = ConsensusSteps.PREVOTE;
      if (this.node.db.getValue(ConsensusRef.validators(this.state.number))[this.node.account.address]) {
        const prevoteResult = this.prevote();
        if (!ChainUtil.txExecutedSuccessfully(prevoteResult)) {
          logger.debug(`Failed to prevote for block number ${this.state.number}`);
        }
      }
    }
    const majorityAgreed = this.twoThirdsAgreed(ConsensusMessageTypes.PREVOTE);
    if (majorityAgreed/* && this.state.proposedBlock.hash === majorityAgreed*/) {
      this.enterOrStayInPrecommit();
    } else {
      this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
    }
  }

  enterOrStayInPrecommit() {
    logger.debug(`\n[Consensus:enterOrStayInPrecommit] number: ${this.state.number}, step: ${this.state.step}\n`)
    if (this.state.step !== ConsensusSteps.PREVOTE && this.state.step !== ConsensusSteps.PRECOMMIT) {
      logger.debug(`Failed to enter PRECOMMIT step: Current step is ${this.state.step}`);
      return;
    }
    if (!this.state.proposedBlock) {
      logger.debug(`Failed to enter PRECOMMIT: proposedBlock is not set.`);
      return;
    }
    if (this.state.step === ConsensusSteps.PREVOTE) {
      this.state.step = ConsensusSteps.PRECOMMIT;
      if (this.node.db.getValue(ConsensusRef.validators(this.state.number))[this.node.account.address]) {
        const precommitResult = this.precommit();
        if (!ChainUtil.txExecutedSuccessfully(precommitResult)) {
          logger.debug(`Failed to precommit for block number ${this.state.number}`);
        }
      }
    }
    const majorityAgreed = this.twoThirdsAgreed(ConsensusMessageTypes.PRECOMMIT);
    if (majorityAgreed/* && this.state.proposedBlock.hash === majorityAgreed*/) {
      this.enterOrStayInCommit();
    } else {
      this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
    }
  }

  enterOrStayInCommit() {
    logger.debug(`\n[Consensus:enterOrStayInCommit] number: ${this.state.number}, step: ${this.state.step}\n`)
    if (this.state.step !== ConsensusSteps.PRECOMMIT) {
      logger.debug(`Failed to enter COMMIT step: Current step is ${this.state.step}`);
      return;
    }
    if (!this.state.proposedBlock) {
      logger.debug(`Failed to enter COMMIT: proposedBlock is not set.`);
      return;
    }
    const majorityAgreed = this.twoThirdsAgreed(ConsensusMessageTypes.PRECOMMIT);
    if (!majorityAgreed) {
      logger.debug(`Failed to finalize a commit for number ${this.state.number}: no +2/3 agreed.`);
      return;
    }
    this.state.step = ConsensusSteps.COMMIT;
    /* TODO(lia): uncomment this after changing this.twoThirdsAgreed()
    if (this.state.proposedBlock.hash !== majorityAgreed) {
      logger.debug(`Failed to finalize a commit for number ${this.state.number}:\n` +
          `proposedBlock ${this.state.proposedBlock.hash} is not what the majority agreed upon ${majorityAgreed}`);
      return;
    }*/
    this.commit();
    // this.enterOrStayInNewNumber();
    this.enqueue({id: ConsensusRoutineIds.PROCEED, number: this.state.number, step: this.state.step});
  }

  // TODO (lia): update blockPool
  commit() {
    logger.debug(`\n[Consensus:commit] number: ${this.state.number}, step: ${this.state.step}\n`)
    const  catchingUp = this.node.bc.lastBlockNumber() >= this.state.number;
    logger.debug(`[Consensus:commit] catching up: ${catchingUp} (lastBlockNumber: ${this.node.bc.lastBlockNumber()})`);
    if (catchingUp || this.node.bc.addNewBlock(this.state.proposedBlock)) {
      // TODO (lia): reset tempSnapshot and apply block's last_votes and transactions to the db's tempSnapshot
      if (!catchingUp) {
        this.node.db.setDbToSnapshot(this.node.bc.backupDb);
        if (!this.node.bc.backupDb.applyBlock(this.state.proposedBlock)) {
          logger.debug(`Failed to apply the new committed block. Something is wrong.\n`+
              `proposedBlock: ${this.state.proposedBlock}`);
          return;
        }
        this.node.db.setDbToSnapshot(this.node.bc.backupDb);
        // Since db set to finalized db and last committed block of number n applied,
        // we need to apply the votes for m >= n as well as valid txs from txPool.
        this.applyVotesToDb(this.state.number);
      }
      // Remove committed txs from txpool and update tx and nonce trackers
      this.node.tp.cleanUpForNewBlock(this.state.proposedBlock);
      this.node.db.executeTransactionList(this.node.tp.getValidTransactions());
      logger.debug(`\nthis.state BEFORE: ${JSON.stringify(this.state)}\n`);
      if (this.state.votes[this.state.number - 1]) {
        // Leave votes for current block as lastVotes for next block
        delete this.state.votes[this.state.number - 1];
      }
      this.state.proposedBlock = null;
      this.state.proposer = null;
      logger.debug(`\nthis.state AFTER: ${JSON.stringify(this.state)}\n`);
      if (this.node.bc.blockPool[this.state.number]) {
        logger.debug(`[Consensus:commit] deleting ` + JSON.stringify(this.node.bc.blockPool[this.state.number]) + `from blockPool`);
        delete this.node.bc.blockPool[this.state.number];
      }
    } else {
      // TODO (lia): reset tempSnapshot
      logger.debug(`Failed to commit a block: unable to append the block to the blockchain.`);
    }
  }

  createProposalBlock() {
    const transactions = this.node.tp.getValidTransactions();
    const blockNumber = this.state.number; // Use this.node.bc.lastBlockNumber() + 1 ?
    const proposer = this.node.account.address;
    const ref = ConsensusRef.validators(blockNumber);
    const validators = this.node.db.getValue(ref);
    const lastVoteTxList = this.state.votes[blockNumber - 1] || [];
    const lastVoteTxListSanitized = [];
    logger.debug(`Getting last votes (${blockNumber - 1})` + JSON.stringify(lastVoteTxList, null, 2));
    // Extract only the transactions.
    for (let vote of lastVoteTxList) {
      logger.debug("Adding a last vote to a new block:" + JSON.stringify(vote.tx, null, 2));
      let voteTx = Object.assign({}, vote.tx);
      if (voteTx.block) {
        delete voteTx.block;
      }
      lastVoteTxListSanitized.push(voteTx);
    }
    return Block.createBlock(this.node.bc.lastBlock().hash, lastVoteTxListSanitized,
        transactions, blockNumber, proposer, validators);
  }

  /*
   * Creates a transaction for a block proposal and setting the next_round_proposer
   *  as well as the next_round_proposer.
   * TODO (lia): make genesis block with createProposal as well?
   */
  createProposal(block) {
    logger.debug(`Proposing block with hash ${block.hash} and number ${block.number}`);
    const number = block.number;
    const nextRoundValidators = this.getNextRoundValidators();
    if ((!nextRoundValidators || !Object.keys(nextRoundValidators).length) && number > 1) {
      logger.debug(`Failed to create a proposal: No next round validators.`);
      return null;
    }
    const seed = (number <= 5 ? this.node.bc.chain[0] : this.node.bc.chain[this.node.bc.chain.length - 5]).hash;
    const nextRoundProposer = ConsensusUtil.getWeightedRandomProposer(nextRoundValidators, seed);
    if (!nextRoundProposer) {
      logger.debug(`Failed to create a proposal: No next round proposer selected.`);
      return null;
    }
    const proposal = this.node.createTransaction({
        operation: {
          type: WriteDbOperations.SET,
          op_list: [
            {
              type: WriteDbOperations.SET_VALUE,
              ref: ConsensusRef.propose(number),
              value: { block_hash: block.hash }
            },
            {
              type: WriteDbOperations.SET_VALUE,
              ref: ConsensusRef.nextRoundValidators(number),
              value: nextRoundValidators
            },
            {
              type: WriteDbOperations.SET_VALUE,
              ref: ConsensusRef.nextRoundProposer(number),
              value: nextRoundProposer
            }
          ]
        }
      }, false);
    return proposal;
  }

  checkProposal(proposal) {
    const proposedBlock = Block.parse(proposal.block);
    if (proposedBlock.hash !== proposal.block_hash) {
      // if (DEBUG) {
        logger.debug(`[Consensus:checkProposal] Received a proposal with an invalid hash (Received block's hash: ${proposedBlock.hash}, ` +
            `Block hash written to the state: ${proposal.block_hash})`);
      // }
      // TODO (lia): punish/blacklist the proposer node
      return false;
    }
    logger.debug(`[Consensus:checkProposal] lastBlock: ${this.node.bc.lastBlockNumber()}, ${this.node.bc.lastBlock() ? this.node.bc.lastBlock().hash : null}\nIncoming proposal: ${proposal.block.number}, ${proposal.block_hash}`)
    if (proposal.block.number === this.node.bc.lastBlockNumber() &&
        proposal.block_hash === this.node.bc.lastBlock().hash) {
      // Receiving a proposal for the (already committed) last block.
      return true;
    }
    // Perform basic checks (hashes and nonces) on the proposedBlock
    if (!Block.validateProposedBlock(proposedBlock, this.node.bc)) {
      // if(DEBUG) {
        logger.debug(`[Consensus:checkProposal] PROPOSED BLOCK DIDN'T PASS THE BASIC CHECKS: ${proposedBlock}`);
      // }
      return false;
    }
    // Validate and execute the last_votes and transactions from the proposedBlock.
    // TODO (lia): Validate the block against a snapshot of the finalized db.
    // this.node.db.setDbToSnapshot(this.node.bc.backupDb);
    // if (!this.node.db.applyBlock(proposedBlock)) {
    //   // if(DEBUG) {
    //     logger.debug(`[Consensus:checkProposal] REJECTING BLOCK DUE TO INVALID TXS: ${proposedBlock}`);
    //   // }
    //   return false;
    // }
    // this.applyVotesToDb(proposedBlock.number);
    return true;
  }

  prevote() {
    const blockNumber = this.state.number;
    const address = this.node.account.address;
    const value = blockNumber > 1 ?
        this.node.db.getValue(ConsensusRef.validators(blockNumber))[address]
        : ConsensusUtil.getValidConsensusDeposit(this.node.db, address);
    const prevoteTx = this.node.createTransaction({
      operation: {
        type: WriteDbOperations.SET_VALUE,
        ref: ChainUtil.resolveDbPath([ConsensusRef.prevote(blockNumber), address]),
        value
      }
    }, false);
    const result = this.server.executeAndBroadcastTransaction(prevoteTx, '', MessageTypes.CONSENSUS);
    if (ChainUtil.txExecutedSuccessfully(result)) {
      this.addVote(prevoteTx, ConsensusUtil.parseConsensusTransaction(prevoteTx));
    }
    return result;
  }

  precommit() {
    const blockNumber = this.state.number;
    const address = this.node.account.address;
    const value = blockNumber > 1 ?
        this.node.db.getValue(ConsensusRef.validators(blockNumber))[address]
        : ConsensusUtil.getValidConsensusDeposit(this.node.db, address);
    const precommitTx = this.node.createTransaction({
      operation: {
        type: WriteDbOperations.SET_VALUE,
        ref: ChainUtil.resolveDbPath([ConsensusRef.precommit(blockNumber), address]),
        value
      }
    }, false);
    const result = this.server.executeAndBroadcastTransaction(precommitTx, '', MessageTypes.CONSENSUS);
    if (ChainUtil.txExecutedSuccessfully(result)) {
      this.addVote(precommitTx, ConsensusUtil.parseConsensusTransaction(precommitTx));
    }
    return result;
  }

  isProposer(address) {
    return ConsensusUtil.isProposerForNumber(
        this.node.db,
        this.node.bc,
        this.state.number,
        address
      );
  }

  getNextRoundValidators() {
    const allDeposits = this.node.db.getValue(PredefinedDbPaths.DEPOSIT_ACCOUNTS_CONSENSUS);
    logger.debug(`\n[Consensus:getNextRoundValidators] allDeposits: ${JSON.stringify(allDeposits)}\n`);
    if (!allDeposits) {
      return null;
    }
    const nextRoundValidators = {};
    for (let addr of Object.keys(allDeposits)) {
      const deposit = allDeposits[addr];
      if (deposit.value > 0 && deposit.expire_at > Date.now() + ConsensusDefaultValues.DAY_MS) {
        nextRoundValidators[addr] = deposit.value;
      }
    }
    logger.debug(`\nNEXT ROUND VALIDATORS: ${JSON.stringify(nextRoundValidators)}\n`);
    return nextRoundValidators;
  }

  stake(amount) {
    if (!amount || amount <= 0) {
      logger.debug(`Invalid staking amount received: ${amount}`);
      return null;
    }
    const depositTx = this.node.createTransaction({
      operation: {
        type: WriteDbOperations.SET_VALUE,
        ref: ChainUtil.resolveDbPath([
            PredefinedDbPaths.DEPOSIT_CONSENSUS,
            this.node.account.address,
            PushId.generate(),
            PredefinedDbPaths.DEPOSIT_VALUE
          ]),
        value: amount
      }
    }, false);
    return this.server.executeAndBroadcastTransaction(depositTx, '', MessageTypes.TRANSACTION);
  }

  hasSeenVote(hash, number) {
    return this.state.votes[number] ? this.state.votes[number].filter(vote => vote.tx.hash === hash).length : false;
  }

  setNumber(newNumber) {
    logger.debug(`[Consensus.setNumber] Before: ${this.state.number}, after: ${newNumber}`);
    this.state.number = newNumber;
  }

  setStep(newStep) {
    logger.debug(`[Consensus.setStep] Before: ${this.state.step}, after: ${newStep}`);
    this.state.step = newStep;
  }
}

module.exports = Consensus;
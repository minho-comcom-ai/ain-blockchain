const ainUtil = require('@ainblockchain/ain-util');
const logger = require('../logger');
const { PORT, ACCOUNT_INDEX, GenesisAccounts } = require('../constants');
const Blockchain = require('../blockchain');
const TransactionPool = require('../tx-pool');
const DB = require('../db');
const Transaction = require('../tx-pool/transaction');

class Node {
  constructor() {
    this.bc = new Blockchain(String(PORT));
    this.tp = new TransactionPool();
    this.db = new DB(this);
    this.nonce = null;
    // TODO(lia): Add account importing functionality.
    this.account = ACCOUNT_INDEX !== null ?
        GenesisAccounts.others[ACCOUNT_INDEX] : ainUtil.createAccount();
    this.initialized = false;
    logger.info(`Creating new node with account: ${this.account.address}`);
  }

  // For testing purpose only.
  setAccountForTesting(accountIndex) {
    this.account = GenesisAccounts.others[accountIndex];
  }

  init(isFirstNode) {
    logger.info('Initializing node..');
    const initialChain = this.bc.init(isFirstNode, this.account);
    this.verifyAndAppendChain(initialChain);
    const nonceFromNonceTracker = this.tp.committedNonceTracker[this.account.address];
    this.nonce = nonceFromNonceTracker !== undefined ? nonceFromNonceTracker : 0;
    this.initialized = true;
  }

  getNonce() {
    // TODO (Chris): Search through all blocks for any previous nonced transaction with current
    //               publicKey
    let nonce = 0;
    for (let i = this.bc.chain.length - 1; i > -1; i--) {
      for (let j = this.bc.chain[i].transactions.length -1; j > -1; j--) {
        if (ainUtil.areSameAddresses(this.bc.chain[i].transactions[j].address,
                                     this.account.address)
            && this.bc.chain[i].transactions[j].nonce > -1) {
          // If blockchain is being restarted, retreive nonce from blockchain
          nonce = this.bc.chain[i].transactions[j].nonce + 1;
          break;
        }
      }
      if (nonce > 0) {
        break;
      }
    }
    logger.info(`Setting nonce to ${nonce}`);
    return nonce;
  }

  /**
    * Validates transaction is valid according to AIN database rules and returns a transaction
    * instance
    *
    * @param {dict} operation - Database write operation to be converted to transaction
    * @param {boolean} isNoncedTransaction - Indicates whether transaction should include nonce or
    *                                        not
    * @return {Transaction} Instance of the transaction class
    */
  createTransaction(txData, isNoncedTransaction = true) {
    if (Transaction.isBatchTransaction(txData)) {
      const txList = [];
      txData.tx_list.forEach((subData) => {
        txList.push(this.createSingleTransaction(subData, isNoncedTransaction));
      })
      return { tx_list: txList };
    }
    return this.createSingleTransaction(txData, isNoncedTransaction);
  }

  createSingleTransaction(txData, isNoncedTransaction) {
    // Workaround for skip_verif with custom address
    if (txData.address !== undefined) {
      txData.skip_verif = true;
    }
    if (txData.nonce === undefined) {
      let nonce;
      if (isNoncedTransaction) {
        nonce = this.nonce;
        this.nonce++;
      } else {
        nonce = -1;
      }
      txData.nonce = nonce;
    }
    return Transaction.newTransaction(this.account.private_key, txData);
  }

  filterVerifiedTransactions(transactions) {
    const filtered = [];
    transactions.forEach(tx => {
      if (this.db.verifyTransactionOnSnapshot(tx)) {
        filtered.push(tx);
      }
    })
    return filtered;
  }

  verifyAndAppendBlock(block) {
    // TODO(lia): verify the last_votes of block
    // 1. Verify block
    const snapshot = this.db.verifyBlockOnSnapshot(block);
    if (snapshot === null) {
      logger.info("Verification of the block against the snapshot failed.");
      return false;
    }
    // 2. Append block
    if (!this.bc.addNewBlock(block)) {
      return false;
    }
    // 3. Apply block to the finalized state
    this.db.updateFinalizedDbForNewBlock(snapshot.dbData);
    this.db.setDbToFinalizedDb();
    this.tp.cleanUpForNewBlock(block);
    this.bc.updateBlockPoolForNewBlock(block);
    this.db.executeTransactionList(this.tp.getValidTransactions());
    return true;
  }

  // Repeat the verify-append-apply process for each of the block in the chain subsection.
  verifyAndAppendChain(chainSubSection) {
    if (!this.bc.shouldAppendChainSubsection(chainSubSection)) {
      return;
    }
    if (chainSubSection.length === 1) {
      // We haven't seen the votes for this block. Maybe we should not append it
      // and just put it in this.bc.blockPool?
      return this.verifyAndAppendBlock(chainSubSection[0]);
    }
    let appended = false;
    let blockWithoutVotes = chainSubSection[0];
    const snapshot = this.db.createSnapshot();
    const subsectionLen = chainSubSection.length;
    for (let i = 0; i < subsectionLen - 1; i++) {
      const block = chainSubSection[i];
      const nextBlock = chainSubSection[i + 1];
      const lastBlockNumber = this.bc.lastBlockNumber();
      if (block.number > lastBlockNumber + 1) {
        // Anything after this is invalid. Note that blocks that came before
        // might have been applied and appended if they were valid.
        break;
      } else if (block.number === lastBlockNumber + 1) {
        // TODO(lia): verify that the last_votes in 'nextBlock' form a commitment to 'block'.
        if (this.db.verifyBlockOnSnapshot(block, snapshot) === null) {
          logger.info("Verification of the block against the snapshot failed.");
          break;
        }
        if (!this.bc.addNewBlock(block)) {
          break;
        }
        this.db.updateFinalizedDbForNewBlock(snapshot.dbData);
        this.tp.cleanUpForNewBlock(block);
        this.bc.updateBlockPoolForNewBlock(block);
        appended = true;
        blockWithoutVotes = nextBlock;
      } else {
        // block number is too small (keep looking)
      }
    }
    if (appended) {
      this.db.setDbToFinalizedDb();
      this.db.executeTransactionList(this.tp.getValidTransactions());
      this.bc.blockPool.set(blockWithoutVotes.number, blockWithoutVotes);
    }
    return appended;
  }
}

module.exports = Node;

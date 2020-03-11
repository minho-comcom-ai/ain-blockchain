const logger = require('../logger');
const { DEBUG, TRANSACTION_POOL_TIME_OUT_MS, TRANSACTION_TRACKER_TIME_OUT_MS,
  TransactionStatus } = require('../constants');
const Transaction = require('./transaction');

class TransactionPool {
  constructor() {
    // MUST IMPLEMENT WAY TO RESET NONCE WHEN TRANSACTION IS LOST IN NETWORK
    this.transactions = {};
    this.committedNonceTracker = {};
    this.pendingNonceTracker = {};
    // TODO (lia): do not store txs in the pool
    // (they're already tracked by this.transactions..)
    this.transactionTracker = {};
  }

  addTransaction(tx) {
    // Quick verification of transaction on entry
    // TODO (lia): pull verification out to the very front
    // (closer to the communication layers where the node first receives transactions)
    if (!Transaction.verifyTransaction(tx)) {
      logger.info('Invalid transaction');
      if (DEBUG) {
        logger.debug(`NOT ADDING: ${JSON.stringify(tx)}`);
      }
      return false;
    }

    if (!(tx.address in this.transactions)) {
      this.transactions[tx.address] = [];
    }
    this.transactions[tx.address].push(tx);
    this.transactionTracker[tx.hash] = {
      status: TransactionStatus.POOL_STATUS,
      address: tx.address,
      index: this.transactions[tx.address].length - 1,
      timestamp: tx.timestamp,
    };
    if (tx.nonce >= 0 &&
        (!(tx.address in this.pendingNonceTracker) ||
            tx.nonce > this.pendingNonceTracker[tx.address])) {
      this.pendingNonceTracker[tx.address] = tx.nonce;
    }

    if (DEBUG) {
      logger.debug(`ADDING: ${JSON.stringify(tx)}`);
    }
    return true;
  }

  isTimedOut(txTimestamp, lastBlockTimestamp, timeout) {
    if (lastBlockTimestamp < 0) {
      return false;
    }
    return lastBlockTimestamp >= txTimestamp + timeout;
  }

  isTimedOutFromPool(txTimestamp, lastBlockTimestamp) {
    return this.isTimedOut(txTimestamp, lastBlockTimestamp, TRANSACTION_POOL_TIME_OUT_MS);
  }

  isTimedOutFromTracker(txTimestamp, lastBlockTimestamp) {
    return this.isTimedOut(txTimestamp, lastBlockTimestamp, TRANSACTION_TRACKER_TIME_OUT_MS);
  }

  isNotEligibleTransaction(tx) {
    return ((tx.address in this.transactions) &&
        (this.transactions[tx.address].find((trans) => trans.hash === tx.hash) !== undefined)) ||
        (tx.nonce >= 0 && tx.nonce <= this.committedNonceTracker[tx.address]) ||
        (tx.nonce < 0 && tx.hash in this.transactionTracker);
  }

  getValidTransactions() {
    // Transactions are first ordered by nonce in their individual lists by address
    const unvalidatedTransactions = JSON.parse(JSON.stringify(this.transactions));
    for (const address in unvalidatedTransactions) {
      // Order by noncing if transactions are nonced, else by timestamp
      unvalidatedTransactions[address].sort((a, b) => (a.nonce < 0 || b.nonce < 0) ?
            ((a.timestamp > b.timestamp) ? 1 : ((b.timestamp > a.timestamp) ? -1 : 0)) :
                (a.nonce > b.nonce) ? 1 : ((b.nonce > a.nonce) ? -1 : 0));
    }
    // Secondly transactions are combined and ordered by timestamp, while still remaining
    // ordered noncing from the initial sort by nonce
    const orderedUnvalidatedTransactions = Object.values(unvalidatedTransactions);
    while (orderedUnvalidatedTransactions.length > 1) {
      const tempNonceTracker = JSON.parse(JSON.stringify(this.committedNonceTracker));
      const list1 = orderedUnvalidatedTransactions.shift();
      const list2 = orderedUnvalidatedTransactions.shift();
      const newList = [];
      let listToTakeValue;
      while (list1.length + list2.length > 0) {
        if ((list2.length == 0 || (list1.length > 0 && list1[0].timestamp <= list2[0].timestamp))) {
          listToTakeValue = list1;
        } else {
          listToTakeValue = list2;
        }
        if (listToTakeValue[0].nonce === tempNonceTracker[listToTakeValue[0].address] + 1) {
          tempNonceTracker[listToTakeValue[0].address] = listToTakeValue[0].nonce;
          newList.push(listToTakeValue.shift());
        } else if (!(listToTakeValue[0].address in tempNonceTracker) &&
            listToTakeValue[0].nonce === 0) {
          tempNonceTracker[listToTakeValue[0].address] = 0;
          newList.push(listToTakeValue.shift());
        } else if (listToTakeValue[0].nonce < 0) {
          newList.push(listToTakeValue.shift());
        } else {
          const invalidNoncedTransaction = listToTakeValue.shift();
          logger.info('Dropping transactions!: ' + JSON.stringify(invalidNoncedTransaction));
        }
      }

      orderedUnvalidatedTransactions.push(newList);
    }
    return orderedUnvalidatedTransactions.length > 0 ? orderedUnvalidatedTransactions[0]: [];
  }

  removeTimedOutTxsFromPool(blockTimestamp) {
    // Get timed-out transactions.
    const timedOutTxs = new Set();
    for (const address in this.transactions) {
      this.transactions[address].forEach((tx) => {
        if (this.isTimedOutFromPool(tx.timestamp, blockTimestamp)) {
          timedOutTxs.add(tx.hash);
        }
      });
    }
    // Remove transactions from the pool.
    for (const address in this.transactions) {
      this.transactions[address] = this.transactions[address].filter((tx) => {
        return !timedOutTxs.has(tx.hash);
      });
    }
    return timedOutTxs.size > 0;
  }

  removeTimedOutTxsFromTracker(blockTimestamp) {
    // Remove transactions from transactionTracker.
    let removed = false;
    for (const hash in this.transactionTracker) {
      const txData = this.transactionTracker[hash];
      if (this.isTimedOutFromTracker(txData.timestamp, blockTimestamp)) {
        delete this.transactionTracker[hash];
        removed = true;
      }
    }
    return removed;
  }

  cleanUpForNewBlock(block) {
    // Get in-block transaction set.
    const inBlockTxs = new Set();
    for (let i = 0; i < block.transactions.length; i++) {
      const tx = block.transactions[i];
      // Update committed nonce tracker.
      if (tx.nonce >= 0) {
        this.committedNonceTracker[tx.address] = tx.nonce;
      }
      // Update transaction tracker.
      this.transactionTracker[tx.hash] = {
        status: TransactionStatus.BLOCK_STATUS,
        number: block.number,
        index: i,
        timestamp: tx.timestamp,
      };
      inBlockTxs.add(tx.hash);
    }

    for (let i = 0; i < block.last_votes.length; i++) {
      const tx = block.last_votes[i];
      // Update committed nonce tracker.
      if (tx.nonce >= 0) {
        // This shouldn't happen..
        logger.debug("Found a consensus transaction with a nonce >= 0: " + JSON.stringify(tx, null, 2));
        this.committedNonceTracker[tx.address] = tx.nonce;
      }
      // Update transaction tracker.
      this.transactionTracker[tx.hash] = {
        status: TransactionStatus.BLOCK_STATUS,
        number: block.number,
        index: i,
        timestamp: tx.timestamp,
      };
      inBlockTxs.add(tx.hash);
    }

    for (const address in this.transactions) {
      // Remove transactions from the pool.
      this.transactions[address] = this.transactions[address].filter((tx) => {
        return !inBlockTxs.has(tx.hash);
      });
      if (this.transactions[address].length === 0) {
        delete this.transactions[address];
      } else {
        // Update transaction index.
        this.transactions[address].forEach((tx) => {
          this.transactionTracker[tx.hash].index = this.transactions[address].indexOf(tx);
        });
      }
    }

    this.removeTimedOutTxsFromTracker(block.timestamp);
    if (this.removeTimedOutTxsFromPool(block.timestamp)) {
      this.rebuildPendingNonceTracker();
    }
  }

  updateNonceTrackers(transactions) {
    transactions.forEach((tx) => {
      if (tx.nonce >= 0) {
        if (this.committedNonceTracker[tx.address] === undefined ||
            this.committedNonceTracker[tx.address] < tx.nonce) {
          this.committedNonceTracker[tx.address] = tx.nonce;
        }
        if (this.pendingNonceTracker[tx.address] === undefined ||
            this.pendingNonceTracker[tx.address] < tx.nonce) {
          this.pendingNonceTracker[tx.address] = tx.nonce;
        }
      }
    });
  }

  rebuildPendingNonceTracker() {
    const newNonceTracker = JSON.parse(JSON.stringify(this.committedNonceTracker));
    for (const address in this.transactions) {
      this.transactions[address].forEach((tx) => {
        if (tx.nonce >= 0 &&
            (!(tx.address in newNonceTracker) || tx.nonce > newNonceTracker[tx.address])) {
          newNonceTracker[tx.address] = tx.nonce;
        }
      });
    }
    this.pendingNonceTracker = newNonceTracker;
  }

  getPoolSize() {
    let size = 0;
    for (const address in this.transactions) {
      size += this.transactions[address].length;
    }
    return size;
  }
}

module.exports = TransactionPool;

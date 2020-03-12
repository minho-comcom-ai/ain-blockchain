const url = require('url');
const Websocket = require('ws');
const sleep = require('sleep');
const ip = require('ip');
const publicIp = require('public-ip');
const axios = require('axios');
const semver = require('semver');
const disk = require('diskusage');
const os = require('os');
const get = require('lodash/get');
const logger = require('../logger');
const { MessageTypes, P2P_PORT, TRACKER_WS_ADDR } = require('../constants');
const Consensus = require('../consensus');
const { ConsensusRoutineIds } = require('../consensus/constants');
const { Block } = require('../blockchain/block');
const Transaction = require('../tx-pool/transaction');
const ChainUtil= require('../chain-util');
const { DEBUG, HOSTING_ENV } = require('../constants');
const GCP_EXTERNAL_IP_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip';
const CURRENT_PROTOCOL_VERSION = require('../package.json').version;
const RECONNECT_INTERVAL_MS = 10000;
const UPDATE_TO_TRACKER_INTERVAL_MS = 10000;
const DISK_USAGE_PATH = os.platform() === 'win32' ? 'c:' : '/';

// A util function for testing/debugging.
function setTimer(ws, timeSec) {
  setTimeout(() => {
    ws.close();
  }, timeSec * 1000);
}

// A peer-to-peer network server that broadcasts changes in the database.
// TODO(seo): Sign messages to tracker or peer.
class P2pServer {
  constructor(node, minProtocolVersion, maxProtocolVersion) {
    this.isStarting = true;
    this.ipAddress = null;
    this.trackerWebSocket = null;
    this.interval = null;
    this.node = node;
    this.consensus = new Consensus(this, node);
    this.managedPeersInfo = {}
    this.sockets = [];
    this.votingInterval = null;
    this.waitInBlocks = 4;
    this.minProtocolVersion = minProtocolVersion;
    this.maxProtocolVersion = maxProtocolVersion;
  }

  listen() {
    const server = new Websocket.Server({port: P2P_PORT});
    server.on('connection', (socket) => this.setSocket(socket, null));
    logger.info(`Listening for peer-to-peer connections on: ${P2P_PORT}\n`);
    this.setIntervalForTrackerConnection();
  }

  setIntervalForTrackerConnection() {
    this.connectToTracker();
    this.intervalConnection = setInterval(() => {
      this.connectToTracker();
    }, RECONNECT_INTERVAL_MS)
  }

  clearIntervalForTrackerConnection() {
    clearInterval(this.intervalConnection)
    this.intervalConnection = null;
  }

  setIntervalForTrackerUpdate() {
    this.updateNodeStatusToTracker();
    this.intervalUpdate = setInterval(() => {
      this.updateNodeStatusToTracker();
    }, UPDATE_TO_TRACKER_INTERVAL_MS)
  }

  clearIntervalForTrackerUpdate() {
    clearInterval(this.intervalUpdate)
    this.intervalUpdate = null;
  }

  connectToTracker() {
    logger.info(`[TRACKER] Reconnecting to tracker (${TRACKER_WS_ADDR})`);
    this.getIpAddress()
    .then(() => {
      this.trackerWebSocket = new Websocket(TRACKER_WS_ADDR);
      this.trackerWebSocket.on('open', () => {
        logger.info(`[TRACKER] Connected to tracker (${TRACKER_WS_ADDR})`);
        this.clearIntervalForTrackerConnection();
        this.setTrackerEventHandlers();
        this.setIntervalForTrackerUpdate();
      });
      this.trackerWebSocket.on('error', (error) => {
        logger.info(`[TRACKER] Error in communication with tracker (${TRACKER_WS_ADDR}): ` +
            `${JSON.stringify(error, null, 2)}`)
      });
    });
  }

  getIpAddress() {
    return Promise.resolve()
    .then(() => {
      if (HOSTING_ENV === 'gcp') {
        return axios.get(GCP_EXTERNAL_IP_URL, {
          headers: {'Metadata-Flavor': 'Google'},
          timeout: 3000
        })
        .then((res) => {
          return res.data;
        })
        .catch((err) => {
          logger.error(`Failed to get ip address: ${JSON.stringify(err, null, 2)}`);
          process.exit(0);
        });
      } else if (HOSTING_ENV === 'local') {
        return ip.address();
      } else {
        return publicIp.v4();
      }
    })
    .then((ipAddr) => {
      this.ipAddress = ipAddr;
      return ipAddr;
    });
  }

  async setTrackerEventHandlers() {
    this.trackerWebSocket.on('message', (message) => {
      try {
        const parsedMsg = JSON.parse(message);
        logger.info(`\n[TRACKER] << Message from tracker: ` +
            `${JSON.stringify(parsedMsg, null, 2)}`)
        if (this.connectToPeers(parsedMsg.newManagedPeerInfoList)) {
          logger.info(`[TRACKER] Updated managed peers info: ` +
              `${JSON.stringify(this.managedPeersInfo, null, 2)}`);
        }
        if (this.isStarting) {
          this.isStarting = false;
          if (parsedMsg.numLivePeers === 0) {
            this.node.init(true);
            this.node.bc.syncedAfterStartup = true;
            this.consensus.init();
          } else {
            this.node.init(false);
            this.requestChainSubsection(this.node.bc.lastBlock());
          }
        }
      } catch (error) {
        logger.error(error.stack);
      }
    });

    this.trackerWebSocket.on('close', (code) => {
      logger.info(`\n[TRACKER] Disconnected from tracker ${TRACKER_WS_ADDR} with code: ${code}`);
      this.clearIntervalForTrackerUpdate();
      this.setIntervalForTrackerConnection();
    });
  }

  updateNodeStatusToTracker() {
    const updateToTracker = {
      url: url.format({
        protocol: 'ws',
        hostname: this.ipAddress,
        port: P2P_PORT
      }),
      ip: this.ipAddress,
      address: this.node.account.address,
      updatedAt: Date.now(),
      lastBlock: {
        number: this.node.bc.lastBlockNumber(),
        timestamp: this.node.bc.lastBlockTimestamp(),
      },
      consensusStatus: {
        state: this.consensus.state
      },
      txStatus: {
        txPoolSize: this.node.tp.getPoolSize(),
        txTrackerSize: Object.keys(this.node.tp.transactionTracker).length,
        committedNonceTrackerSize: Object.keys(this.node.tp.committedNonceTracker).length,
        pendingNonceTrackerSize: Object.keys(this.node.tp.pendingNonceTracker).length,
      },
      managedPeersInfo: this.managedPeersInfo,
    };
    const diskUsage = this.getDiskUsage();
    if (diskUsage !== null) {
      updateToTracker.diskUsage = diskUsage;
    }
    logger.info(`\n[TRACKER] >> Update to tracker ${TRACKER_WS_ADDR}: ` +
        `${JSON.stringify(updateToTracker, null, 2)}`)
    this.trackerWebSocket.send(JSON.stringify(updateToTracker));
  }

  getDiskUsage() {
    try {
      return disk.checkSync(DISK_USAGE_PATH);
    }
    catch (err) {
      logger.error(err);
      return null;
    }
  }

  connectToPeers(newManagedPeerInfoList) {
    let updated = false;
    newManagedPeerInfoList.forEach((peerInfo) => {
      if (this.managedPeersInfo[peerInfo.address]) {
        logger.info(`[PEER] Node ${peerInfo.address} is already a managed peer. ` +
            `Something is wrong.`)
      } else {
        logger.info(`[PEER] Connecting to peer ${JSON.stringify(peerInfo, null, 2)}`);
        this.managedPeersInfo[peerInfo.address] = peerInfo;
        updated = true;
        const socket = new Websocket(peerInfo.url);
        socket.on('open', () => {
          logger.info(`[PEER] Connected to peer ${peerInfo.address} (${peerInfo.url}).`)
          this.setSocket(socket, peerInfo.address);
        });
      }
    });
    return updated;
  }

  setSocket(socket, address) {
    this.sockets.push(socket);
    this.setPeerEventHandlers(socket, address);
    // TODO (lia): Send a request only to the newly connected peer?
    this.requestChainSubsection(this.node.bc.lastBlock());
  }

  setPeerEventHandlers(socket, address) {
    socket.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        const version = data.protoVer;
        if (!version || !semver.valid(version)) {
          return;
        }
        if (semver.gt(this.minProtocolVersion, version) ||
            (this.maxProtocolVersion && semver.lt(this.maxProtocolVersion, version))) {
          return;
        }

        switch (data.type) {
          case MessageTypes.CONSENSUS:
            if (DEBUG) {
              logger.debug(`RECEIVING: ${JSON.stringify(data.transaction)}`);
            }
            if (this.node.tp.transactionTracker[data.transaction.hash]) {
              logger.debug("Already have the transaction in my tx tracker");
              break;
            }
            if (this.node.bc.syncedAfterStartup) {
              this.consensus.enqueue({id: ConsensusRoutineIds.HANDLE_VOTE, tx: data.transaction});
            } else {
              logger.info(`\n\nNeeds syncing...\n\n`)
            }
            break;
          case MessageTypes.TRANSACTION:
            if (DEBUG) {
              logger.debug(`RECEIVING: ${JSON.stringify(data.transaction)}`);
            }
            if (this.node.tp.transactionTracker[data.transaction.hash]) {
              logger.debug("Already have the transaction in my tx tracker");
              break;
            } else if (this.node.initialized) {
              this.executeAndBroadcastTransaction(data.transaction, MessageTypes.TRANSACTION);
            } else {
              // Put the tx in the txPool?
            }
            break;
          case MessageTypes.CHAIN_SUBSECTION:
            const isEndOfChain = data.number > 0 && data.number === data.chainSubsection[data.chainSubsection.length - 1].number;
            logger.info(`\n\nCHAIN_SUBSECTION RECEIVED (${data.number}, [ ${data.chainSubsection[0].number} ... ${data.chainSubsection[data.chainSubsection.length - 1].number} ], ${isEndOfChain})\n\n`)
            if (!this.node.initialized) {
              logger.info(`Node is not yet initialized`);
              return;
            }
            if (this.node.verifyAndAppendChain(data.chainSubsection)) {
              const lastBlockNumberAfterMerge = this.node.bc.lastBlockNumber();
              // If the chain is still at number 1, wait for more.
              if (data.number === lastBlockNumberAfterMerge + 1 && lastBlockNumberAfterMerge > 1) {
                if (!this.node.bc.syncedAfterStartup) {
                  logger.info(`\nNODE SYNCED AFTER START UP\n`)
                  this.node.bc.syncedAfterStartup = true;
                }
                if (!this.consensus.initialized) {
                  this.consensus.init(data.consensusState);
                } else {
                  this.consensus.catchUp(data.consensusState);
                }
              } else {
                // Continuously request the blockchain in subsections until
                // your local blockchain matches the height of the consensus blockchain.
                this.requestChainSubsection(this.node.bc.lastBlock());
              }
            } else {
              logger.info(`\nFailed to merge incoming chain subsection.\nMy consensus state:`, this.consensus.state, `\nNew consensus state:`, data.consensusState)
              // Still might be able to update consensus state?
              // If the chain is still at number 1, wait for more.
              if (isEndOfChain && data.number > 1) {
                if (!this.consensus.initialized) {
                  this.consensus.init(data.consensusState);
                } else {
                  // should I catch up consensus state here?
                  // this.consensus.catchUp(data.consensusState);
                }
              } else {
                this.requestChainSubsection(this.node.bc.lastBlock());
              }
            }
            break;
          case MessageTypes.CHAIN_SUBSECTION_REQUEST:
            logger.debug(`\n\nCHAIN_SUBSECTION_REQUEST RECEIVED (${data.lastBlock ? data.lastBlock.number : null})\n\n`)
            if (this.node.bc.chain.length === 0) {
              logger.debug("## JUST RETURNING.. ##")
              return;
            }
            // Send a chunk of 20 blocks from  your blockchain to the requester.
            // Requester will continue to request blockchain chunks
            // until their blockchain height matches the consensus blockchain height
            const chainSubsection = this.node.bc.requestBlockchainSection(
                data.lastBlock ? Block.parse(data.lastBlock) : null);
            if (chainSubsection) {
              logger.debug("## SENDING CHAIN SUBSECTION ##")
              this.sendChainSubsection(
                  socket, chainSubsection, this.node.bc.lastBlockNumber());
            } else {
              logger.debug("## NO CHAIN SUBSECTION TO SEND ##")
            }
            break;
        }
      } catch (error) {
        logger.error(error.stack);
      }
    });

    socket.on('close', () => {
      logger.info(`\n[PEER] Disconnected from a peer: ${address || 'unknown'}`);
      this.removeFromListIfExists(socket);
      if (address && this.managedPeersInfo[address]) {
        delete this.managedPeersInfo[address];
        logger.info(`[PEER] => Updated managed peers info: ` +
            `${JSON.stringify(this.managedPeersInfo, null, 2)}`);
      }
    });

    socket.on('error', (error) => {
      logger.error(`[PEER] Error in communication with peer ${address}: ` +
          `${JSON.stringify(error, null, 2)}`);
    });
  }

  removeFromListIfExists(entry) {
    const index = this.sockets.indexOf(entry);
    if (index >= 0) {
      this.sockets.splice(index, 1);
      return true;
    }
    return false;
  }

  sendChainSubsection(socket, chainSubsection, number) {
    const message = {
      type: MessageTypes.CHAIN_SUBSECTION,
      chainSubsection,
      number,
      protoVer: CURRENT_PROTOCOL_VERSION
    }
    if (this.consensus) {
      logger.debug(`Sending consensus state along`)
      message['consensusState'] = this.consensus.state;
    }
    socket.send(JSON.stringify(message));
  }

  requestChainSubsection(lastBlock) {
    this.sockets.forEach((socket) => {
      socket.send(JSON.stringify({
          type: MessageTypes.CHAIN_SUBSECTION_REQUEST,
          lastBlock,
          protoVer: CURRENT_PROTOCOL_VERSION
        }));
    });
  }

  broadcastChainSubsection(chainSubsection) {
    this.sockets.forEach((socket) => this.sendChainSubsection(socket, chainSubsection));
  }

  broadcastTransaction(transaction, type) {
    // if (DEBUG) {
      logger.debug(`SENDING: ${JSON.stringify(transaction)}`);
    // }
    this.sockets.forEach((socket) => {
      socket.send(JSON.stringify({
          type,
          transaction,
          protoVer: CURRENT_PROTOCOL_VERSION
        }));
    });
  }

  /**
   * Adds transaction to the transactionPool and executes the operations specified
   * in the transaction.
   * @param {Object} transactionWithSig An object with a signature and a transaction.
   */
  // TODO(seo): Remove new Transaction() use cases.
  // TODO(lia): Execute different txs on different snapshots (regular vs consensus)
  executeTransaction(transactionWithSig, type = MessageTypes.TRANSACTION) {
    if (!transactionWithSig) return null;
    const transaction = transactionWithSig instanceof Transaction ?
        transactionWithSig : new Transaction(transactionWithSig);
    if (DEBUG) {
      logger.debug(`EXECUTING: ${JSON.stringify(transaction)}`);
    }
    if (this.node.tp.isTimedOutFromPool(transaction.timestamp, this.node.bc.lastBlockTimestamp())) {
      if (DEBUG) {
        logger.debug(`TIMED-OUT TRANSACTION: ${JSON.stringify(transaction)}`);
      }
      logger.info('Timed-out transaction');
      return null;
    }
    if (this.node.tp.isNotEligibleTransaction(transaction)) {
      // if (DEBUG) {
        logger.debug(`ALREADY RECEIVED: ${JSON.stringify(transaction)}`);
      // }
      logger.info('Transaction already received');
      return null;
    }
    const result = this.node.db.executeTransaction(transaction);
    if (ChainUtil.txExecutedSuccessfully(result)) {
      if (type === MessageTypes.TRANSACTION) {
        // Add transaction to pool
        this.node.tp.addTransaction(transaction);
      } else {
        logger.info(`Not adding tx to the tx-pool. Message type: ${type}, Tx hash: ${transaction.hash}`);
      }
    } else if (DEBUG) {
      logger.debug(
          `FAILED TRANSACTION: ${JSON.stringify(transaction)}\t RESULT:${JSON.stringify(result)}`);
    }
    return result;
  }

  executeAndBroadcastTransaction(transactionWithSig, type = MessageTypes.TRANSACTION) {
    if (!transactionWithSig) return null;
    if (type !== MessageTypes.TRANSACTION && type !== MessageTypes.CONSENSUS) {
      logger.error("Invalid transaction message type.");
      return null;
    }
    if (Transaction.isBatchTransaction(transactionWithSig)) {
      const resultList = [];
      const txListSucceeded = [];
      transactionWithSig.tx_list.forEach((tx) => {
        const transaction = tx instanceof Transaction ? tx : new Transaction(tx);
        const response = this.executeTransaction(transaction, type);
        resultList.push(response);
        if (ChainUtil.txExecutedSuccessfully(response)) {
          txListSucceeded.push(tx);
        }
      })
      if (txListSucceeded.length > 0) {
        this.broadcastTransaction({ tx_list: txListSucceeded }, type);
      }
      return resultList;
    } else {
      const transaction = transactionWithSig instanceof Transaction ?
          transactionWithSig : new Transaction(transactionWithSig);
      const response = this.executeTransaction(transaction, type);
      logger.debug(`\nRESPONSE: ` + JSON.stringify(response))
      if (ChainUtil.txExecutedSuccessfully(response)) {
        this.broadcastTransaction(transactionWithSig, type);
      }
      return response;
    }
  }
}

module.exports = P2pServer;

const Websocket = require('ws');
const P2P_PORT = process.env.P2P_PORT || 5001;
const ip = require("ip")
const trackerWebSocketAddr =  process.env.TRACKER_IP || "ws://localhost:3001"
const trackerWebSocket = process.env.TRACKER_IP !== "TEST" ?  new Websocket(trackerWebSocketAddr) : null
const HOST = "ws://" + ip.address()
const SERVER = HOST + ":" + P2P_PORT
const {MESSAGE_TYPES, VOTING_STATUS} = require("../config")
const InvalidPermissionsError = require("../errors")
const {ForgedBlock} = require('../blockchain/block')



class P2pServer {

    constructor(db, bc, tp, stake){
        this.db = db
        this.blockchain = bc
        this.transactionPool = tp
        this.sockets = []
        this.stake = stake
        this.serviceExecutor = null
        this.waitInBlocks = 4

    }

    setServiceExecutor(se){
        this.serviceExecutor = se
    }

    connectTracker(){
 
        trackerWebSocket.on('message', message => {
            const peers = JSON.parse(message);
            this.connectToPeers(peers)
            
            if (peers.length === 0){
                initiate(this)
            }
        });

        trackerWebSocket.send(JSON.stringify(SERVER))      
    }
     
    listen(){
        const server = new Websocket.Server({port: P2P_PORT});
        server.on('connection', socket => this.connectSocket(socket));
        trackerWebSocket.on('open', () => this.connectTracker());
        console.log(`Listening for peer-to-peer connections on: ${P2P_PORT}`)
        this.requestChainSubsection(this.blockchain.lastBlock())
        
    }

    connectToPeers(peers) {
        peers.forEach(peer => {
            console.log(`Connecting to peer ${peer}`)
            const socket = new Websocket(peer);
            socket.on('open', () => this.connectSocket(socket));
        });
    }

    connectSocket(socket) {
        this.sockets.push(socket);
        this.messageHandler(socket);
        this.requestChainSubsection(this.blockchain.lastBlock())
    }

    messageHandler(socket){
        socket.on('message', (message) => {
            try{
                const data = JSON.parse(message);

                switch(data.type){
                    case MESSAGE_TYPES.transaction:
                        this.executeTrans(data.transaction)
                        break
                    case MESSAGE_TYPES.proposed_block:
                        this.proposeBlock(data.block)
                        break
                    case MESSAGE_TYPES.chain_subsection:
                        if(this.blockchain.merge(data.chainSubsection)){
                            if (data.height === this.blockchain.height()){

                                data.transactions.forEach((trans) => {
                                    if(this.transactionPool.isAlreadyAdded(trans)){
                                        this.transactionPool.addTransaction(trans)
                                    }
                                })

                                if( this.blockchain.status === VOTING_STATUS.START_UP){
                                    this.blockchain.status = VOTING_STATUS.SYNCING
                                }
                            }

                            for(var i=0; i<data.chainSubsection.length; i++){
                                this.transactionPool.removeCommitedTransactions(data.chainSubsection[i])
                            }
                            this.db.reconstruct(this.blockchain, this.transactionPool)
                            this.requestChainSubsection(this.blockchain.lastBlock())

                        }

                        break
                    case MESSAGE_TYPES.chain_subsection_request:
                        if(this.blockchain.chain.length === 0){
                            return
                        }
                        const chainSubsection = this.blockchain.requestBlockchainSection(data.lastBlock)
                        if(chainSubsection){
                            this.sendChainSubsection(socket, chainSubsection, this.blockchain.height())
                        } 
                        break
                }
            } catch (error){
                console.log(error.stack)
            }
        })

        socket.on('close', () => {
            this.sockets.splice(this.sockets.indexOf(socket), 1)
        })
    }


    sendChainSubsection(socket, chainSubsection, height){
        var transactions = []
        if (chainSubsection.length < 10){
            transactions = this.transactionPool.validTransactions()
        }
        socket.send(JSON.stringify({type: MESSAGE_TYPES.chain_subsection, chainSubsection, height, transactions}))
    }

    requestChainSubsection(lastBlock){
        console.log("Sending request !!!!")
        this.sockets.forEach(socket => socket.send(JSON.stringify({type: MESSAGE_TYPES.chain_subsection_request, lastBlock})))
    }

    broadcastChainSubsection(chainSubsection){
        this.sockets.forEach(socket => this.sendChainSubsection(socket, chainSubsection))
    }

    broadcastTransaction(transaction, previousSocket=null){
        this.sockets.forEach(socket => {
            if (socket !== previousSocket){
                socket.send(JSON.stringify({type: MESSAGE_TYPES.transaction, transaction}))
            }
        })
    }

    broadcastBlock(address, broadcasterSocket=null){
        console.log(`Broadcasting new block ${this.blockchain._proposedBlock.hash}`)
        this.sockets.forEach(socket => {
            if (socket !== broadcasterSocket){
                socket.send(JSON.stringify({type: MESSAGE_TYPES.proposed_block, block: this.blockchain._proposedBlock, address}))
            }
        })
    }


    // Function for gRPC
    proposeBlock(block=null){
        if (block !== null && this.blockchain.getProposedBlock(block.hash) !== null){
            return
        }
      
        if (block == null){
            block = this.blockchain.forgeBlock(this.db, this.transactionPool)
        }
        else if (!(block instanceof ForgedBlock)){
            block =  ForgedBlock.parse(block)
        }

        block.data.forEach(transaction =>{
            this.executeTrans(transaction)
        })

        this.blockchain.addProposedBlock(block)
        this.broadcastBlock()
        return block
    }

    // Function for gRPC
    executeTrans(transaction){
        transaction.dependantTransactions.forEach((t) => {
            this._executeTransaction(t)
        })

        var tran =  transaction
        while (tran !== null){
            tran = this._executeTransaction(tran)
            
        }
    }

    _executeTransaction(transaction){
        if(this.transactionPool.isAlreadyAdded(transaction)){
            console.log("Transaction already received")
            return null
        }
        if (this.blockchain.status === VOTING_STATUS.START_UP){
            this.transactionPool.addTransaction(transaction)
            return null
        }

        try{
            this.db.execute(transaction.output, transaction.address, transaction.timestamp)
        } catch (error){
            if(error instanceof InvalidPermissionsError){
                console.log("Invalid permissions")
                return null
            }else {
                throw error
            }
        }

        this.transactionPool.addTransaction(transaction)
        this.broadcastTransaction(transaction)
        return this.serviceExecutor.executeTransactionFunction(transaction)

    }

}

module.exports = P2pServer;


function initiate(p2pServer){
    console.log("Initialising voting !!")
    p2pServer.blockchain.status = "synced"
    // This method should only be called by the very first node on the network !!
    // This user should establish themselves as the first node on the network, instantiate the first _voting entry t db
    // and commit this to the blockchain so it will be picked up by new peers on the network
    const stakeTransaction = p2pServer.db.createTransaction({type: "SET", ref: `stakes/${p2pServer.db.publicKey}`, value: p2pServer.stake})
    p2pServer.executeTrans(stakeTransaction)
    var firstVotingData = {validators: {}, next_round_validators: {}, threshold: 0, forger: p2pServer.db.publicKey, preVotes: 1, 
                             preCommits: 1, time: Date.now(), blockHash: "", height: p2pServer.blockchain.lastBlock().height + 1,  lastHash: p2pServer.blockchain.lastBlock().hash}
    const initVotingTransaction = p2pServer.db.createTransaction({type: "SET", ref: `_voting`, value: firstVotingData})
    p2pServer.executeTrans(initVotingTransaction)
}

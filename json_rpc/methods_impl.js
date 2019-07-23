'use strict';

module.exports = function getJsonRpcApi(blockchain, transactionPool){
    return {
        blockchainClosure: getBlockchainClosure(blockchain),
        transactionPoolClosure: getTransactionPoolClosure(transactionPool)
    }
}

function getBlockchainClosure(blockchain) {
    // Wraps blockchain instance in a closure with a set of functions. 
    // These functions will be invoked through JSON-RPC calls to ../medthod.js 
    // that allows clients to query information from the blockchain 

    return {
        getBlocks(query) {
            const to = ("to" in query) ? query.to: bc.length
            const from = ("from" in query) ? query.from: 0
            return blockchain.getChainSection(from, to)
        },

        getLastBlock(){
            return blockchain.lastBlock()
        },

        getBlockHeaders(query){
            const blockHeaders = []
            const blocks = getBlocks(query)
            blocks.forEach((block) => {
                blockHeaders.push(block.header())
            })
            return blockHeaders
        }
    }
}

function getTransactionPoolClosure(transactionPool) {
    // Wraps transactionPool instance in a closure with a set of functions. 
    // These functions will be invoked through JSON-RPC calls to ../medthod.js 
    // that allows clients to query information from the transactionPool 

    return {
        getTransactions() {
            return transactionPool.transactions
        }
    }
}

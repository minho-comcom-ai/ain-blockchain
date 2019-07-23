'use strict';

const getJsonRpcApi = require('./methods_impl');

module.exports = function getMethods(blockchain, transactionPool) {
    // Returns dict of functions which are compatible with jayson JSON-RPC library
    // for querying both blockchain and transactionPool
    
    const methodsImpl = getJsonRpcApi(blockchain, transactionPool)
    return {     
            getBlocks: function(args, done){
                const queryDict = (typeof args === "undefined" || args.length < 1) ? {} : args[0]
                const blocks = methodsImpl.blockchainClosure.getBlockBodies(queryDict)
                done(null, blocks)
            },
    
            getLastBlock: function(args, done){
                const block = methodsImpl.blockchainClosure.getLastBlock()
                done(null, block)
            },
    
            getTransactions: function(args, done){
                const trans =  methodsImpl.transactionPoolClosure.getTransactions()
                done(null, trans)
            },

            getBlockHeaders: function(args, done){
                const queryDict = (typeof args === "undefined" || args.length < 1) ? {} : args[0]
                const blockHeaders =  methodsImpl.blockchainClosure.getBlockHeaders(queryDict)
                done(null, blockHeaders)
            }
    }
}

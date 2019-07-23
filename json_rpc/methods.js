'use strict';

const getJsonRpcApi = require('./methods_impl');

module.exports = function getMethods(blockchain, transactionPool) {
    
    const methodsImpl = getJsonRpcApi(blockchain, transactionPool)
    return {     
            getBlocks: function(args, done){
                const blocks = methodsImpl.blockchainClosure.getBlocks(args[0])
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
                const blockHeaders =  methodsImpl.blockchainClosure.getBlockHeaders(args[0])
                done(null, blockHeaders)
            }
    }
}

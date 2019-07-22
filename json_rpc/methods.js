'use strict';

const getJsonRpcApi = require('./methods_impl');

module.exports = function getMethods(bc, tp) {
    
    const _methods_impl = getJsonRpcApi(bc, tp)
    return {     
            getBlocks: function(args, done){
                const blocks = _methods_impl.blockchainProc.getBlocks(args[0])
                done(null, blocks)
            },
    
            getLastBlock: function(args, done){
                const block = _methods_impl.blockchainProc.getLastBlock()
                done(null, block)
            },
    
            getTransactions: function(args, done){
                const trans =  _methods_impl.transactionpoolProc.getTransactions()
                done(null, trans)
            },

            getBlockHeaders: function(args, done){
                const blockHeaders =  _methods_impl.blockchainProc.getBlockHeaders(args[0])
                done(null, blockHeaders)
            }
    }
}

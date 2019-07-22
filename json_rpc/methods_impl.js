'use strict';

module.exports = function getJsonRpcApi(bc, tp){
    return {
        blockchainProc: bcProc(bc),
        transactionpoolProc: tpProc(tp)
    }
}

function bcProc(bc) {
    // Returns functions which are callable through json-rpc

    return {
        getBlocks(query) {
            const to = ("to" in query) ? query.to: bc.length
            const from = ("from" in query) ? query.from: 0
            return bc.getChainSection(from, to)

        },

        getLastBlock(){
            return bc.lastBlock()
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


function tpProc(tp) {
    // Returns functions which are callable through json-rpc

    return {
        getTransactions() {
            return tp.transactions
        }
    }
}

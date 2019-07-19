const Blockchain = require('../blockchain');

class BlockchainExplorer {
    
    constructor(port) {
        this.port = port
    }
    
    showAllBlocks() {
        const bc = new Blockchain(String(this.port));
        console.log(bc)
    }
}

module.exports = BlockchainExplorer
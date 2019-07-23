const Blockchain = require('../blockchain');

const pg = require('pg');

// User as 'tester', Database as 'test'
const connectionString = 'postgres://tester@localhost:5432/test';

class BlockchainExplorer {
    
    /**
     * Port: where to get blockchain data
     */
    constructor(port) {
        this.port = port
    }
    
    // For debugging purpose only.
    showAllBlocks() {
        const bc = new Blockchain(String(this.port));
        console.log(bc.chain[1])
    }

    /**
     * Retrieve all blockchain data from node.
     * Input: nothing
     * Output: Blockchain object
     */
    getAllBlockData() {
        const bc = new Blockchain(String(this.port));
        return bc
    }

    /**
     * Temporal function for test database.
     * req, res, next
     * queryString: query as string
     * data as array
     */
    query(req, res, next, queryString, data) {
        pg.connect(connectionString, function(err, client, done) {
            if(err){
                done();
                console.log(err);
                res.status(400).send(err);
            }

            client.query(queryString, data, (err, result) => {
                if (err) {
                    console.log(err);
                    res.status(400).send(err);
                }
                // console.log(result);
                client.end();
            });
        });
    }
}

module.exports = BlockchainExplorer
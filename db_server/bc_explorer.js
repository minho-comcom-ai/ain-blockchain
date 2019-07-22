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
     */
    createTable(req, res, next) {
        pg.connect(connectionString, function(err, client, done) {
            if(err){
                done();
                console.log(err);
                res.status(400).send(err);
            }

            client.query(query0, (err, result) => {
                if (err) {
                    console.log(err);
                    res.status(400).send(err);
                }
                console.log(result);
                client.end();
            });
        });
    }

    showData(req, res, next) {
        pg.connect(connectionString, function(err, client, done) {
            if(err){
                done();
                console.log(err);
                res.status(400).send(err);
            }
            // const data = { id: "1", name: "abc", rollnumber: "11111" }; // dummy data for now.
            // client.query('INSERT INTO Student(id, name, rollnumber) values($1, $2, $3)', [data.id, data.name, data.rollnumber]);

            client.query('SELECT * FROM student where id = $1', [1], function(err, result) {
                if (err) {
                    console.log(err);
                    res.status(400).send(err);
                }
                res.status(200).send(result.rows);
            });
         });
    }
}

/**
 * Temporal place for Queries.
 */

 // Create block table.
const query0 = `CREATE TABLE Blocks(height serial PRIMARY KEY,
                                    timestamp int not null,
                                    lasthash BYTEA NOT NULL,
                                    hash BYTEA NOT NULL,
                                    forger BYTEA not null,
                                    threshold int not null);`;

module.exports = BlockchainExplorer
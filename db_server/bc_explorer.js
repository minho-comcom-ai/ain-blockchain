const Blockchain = require('../blockchain');

const pg = require('pg');

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
        console.log(bc.chain[0])
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

    showData(req, res, next) {
        pg.connect(connectionString, function(err, client, done) {
            if(err){
                done();
                console.log(err);
                res.status(400).send(err);
            }
            // const data = { id: "1", name: "abc", rollnumber: "11111" }; // dummy data for now.

            /***
             * CREATE TABLE for testcases
            client.query('CREATE TABLE Student(id int not null, name text not null, rollnumber int not null);', (err, res) => {
                if (err) {
                    throw err;
                }
                console.log(res);
                client.end();
            });
            */
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

module.exports = BlockchainExplorer
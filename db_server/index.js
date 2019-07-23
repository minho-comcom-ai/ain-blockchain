const express = require('express');

const BlockchainExplorer = require('./bc_explorer');

const TESTPORT = 8080;

const app = express();
const be = new BlockchainExplorer(TESTPORT);

app.get('/', function (req, res, next) {
    be.query(req, res, next, testQuery, [1]);
    // be.query(req, res, next, testQuery, []);
});

app.listen(4000, function() {
    console.log("init localhost");
});

/**
 * Temporal place for Queries.
 */
// Test Query Examples.
// const testQuery = 'SELECT * FROM student';
const testQuery = 'SELECT * FROM student where id = $1';
// const data = { id: "1", name: "abc", rollnumber: "11111" }; // dummy data for now.
// client.query('INSERT INTO Student(id, name, rollnumber) values($1, $2, $3)', [data.id, data.name, data.rollnumber]);

// Create block table.
const query0 = `CREATE TABLE Blocks(height serial PRIMARY KEY,
                                    timestamp int not null,
                                    lasthash BYTEA NOT NULL,
                                    hash BYTEA NOT NULL,
                                    forger BYTEA not null,
                                    threshold int not null);`;
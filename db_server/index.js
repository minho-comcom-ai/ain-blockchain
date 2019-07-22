const express = require('express');

const BlockchainExplorer = require('./bc_explorer');

const TESTPORT = 8080;

const app = express();
const be = new BlockchainExplorer(TESTPORT);

app.get('/', function (req, res, next) {
    be.showData(req, res, next);
});

app.listen(4000, function() {
    console.log("init localhost");
});
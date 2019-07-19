const BlockchainExtractor = require('../db_server/bc_explorer');

const chai = require('chai');
const expect = chai.expect;
const assert = chai.assert;

const TESTPORT = 8080;

/***
 * It hasn't been developed for mocha unittest.
 * Temporal test.
 */
be = new BlockchainExtractor(TESTPORT);
be.showAllBlocks()

/*
describe('Blockchain Extractor Test', () => {

    beforeEach(() => {
        be = new BlockchainExtractor(TESTPORT)
    });

    it('starts with genesis block', () => {
        expect().to.equal()
    });
*/
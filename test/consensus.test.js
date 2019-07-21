const DB = require('../db')
const TransactionPool = require("../db/transaction-pool")
const Blockchain = require('../blockchain')
const ServiceExecutor = require("../service_executor")
const chai = require('chai');
const expect = chai.expect;
const assert = chai.assert;
process.env.TRACKER_IP = "TEST"
const rimraf = require("rimraf");
const P2pServer = require('../server')

const {RULES_FILE_PATH} = require('../config')

describe("Consensus and Triggering", () => {
    let db1, db2, db3, bc1, bc2, bc3, tp1, tp2, tp3, p2p

    beforeEach(() => {
        tp1 = new TransactionPool()
        tp2 = new TransactionPool()
        tp3 = new TransactionPool()
        bc1 = new Blockchain("db-test-1")
        bc2 = new Blockchain("db-test-2")
        bc3 = new Blockchain("db-test-3")
        bc1.status = "synced"
        bc2.status = "synced"
        bc3.status = "synced"

        db1 = DB.getDatabase(bc1, tp1)
        db2 = DB.getDatabase(bc2, tp2)
        db3 = DB.getDatabase(bc3, tp3)
        
        p2p = new P2pServer(db1, bc1, tp1, 0)
        se = new ServiceExecutor(db1, bc1, tp1, p2p)
        p2p.setServiceExecutor(se)
    })

    afterEach(() => {
        rimraf.sync(bc1._blockchainDir());
        rimraf.sync(bc2._blockchainDir());
        rimraf.sync(bc3._blockchainDir());
    });
    

    it("test if I am forger and only validater, trigger order is  '_voting' -> 'next_round_validators' -> 'blockHash' -> 'recentForgers'" , () => {
        // Must set Stake first !!!
        const stakeTransaction = db1.createTransaction({type: "SET", ref: `stakes/${db1.publicKey}`, value:200})
        p2p.executeTrans(stakeTransaction)
        var firstVotingData = {validators: {}, next_round_validators: {}, threshold: 0, forger: db1.publicKey, preVotes: 1, 
                                 preCommits: 1, time: Date.now(), blockHash: "", height: bc1.lastBlock().height + 1,  lastHash: bc1.lastBlock().hash}
        const initVotingTransaction = db1.createTransaction({type: "SET", ref: `_voting`, value: firstVotingData})
        p2p.executeTrans(initVotingTransaction)
        // Check that a new block has been forged and that the forger has been written to the database
        console.log(JSON.stringify(db1.db))
        expect(db1.get("_recentForgers")[0]).to.equal(db1.publicKey)
        expect(bc1.lastBlock().forger).to.equal(db1.publicKey)
    })

    it("test if I am forger, trigger order is  '_voting' -> 'next_round_validators' -> 'blockHash' -> (wait for voting) ->'recentForgers'" , () => {
        // Must set Stake first !!!
        const stakeTransaction1 = db1.createTransaction({type: "SET", ref: `stakes/${db1.publicKey}`, value:200})
        const stakeTransaction2 = db2.createTransaction({type: "SET", ref: `stakes/${db2.publicKey}`, value:200})
        const stakeTransaction3 = db3.createTransaction({type: "SET", ref: `stakes/${db3.publicKey}`, value:200})
        p2p.executeTrans(stakeTransaction1)
        p2p.executeTrans(stakeTransaction2)
        p2p.executeTrans(stakeTransaction3)
         
        var validators = JSON.parse(JSON.stringify(db1.get("stakes")))
        delete validators[db1.publicKey]

        var firstVotingData = {validators, next_round_validators: {}, threshold: Number(400/3) * 2, forger: db1.publicKey, preVotes: 0, 
                                 preCommits: 0, time: Date.now() , blockHash: "", height: bc1.lastBlock().height + 1,  lastHash: bc1.lastBlock().hash}
        const initVotingTransaction = db2.createTransaction({type: "SET", ref: `_voting`, value: firstVotingData})
        p2p.executeTrans(initVotingTransaction)

        // Blockhash should now be broadcasted but block not yet commited
        expect(bc1._proposedBlock.hash).to.equal(db1.get("_voting/blockHash"))
        expect(bc1.height()).to.equal(0)
        expect(Object.keys(db1.get("_voting/next_round_validators")).length).to.equal(1)


        // After two pre commits this should be the same 
        p2p.executeTrans(db2.createTransaction({type: "INCREASE", diff: {"_voting/preVotes": 200}} ))
        p2p.executeTrans(db3.createTransaction({type: "INCREASE", diff: {"_voting/preVotes": 200}} ))

        
        expect(bc1._proposedBlock.hash).to.equal(db1.get("_voting/blockHash"))
        expect(bc1.height()).to.equal(0)
        expect(db1.get("_recentForgers")).to.equal(null)
        

        // After two pre commits block should now be added to forgers blockchain
        p2p.executeTrans(db2.createTransaction({type: "INCREASE", diff: {"_voting/preCommits": 200}}))
        p2p.executeTrans(db3.createTransaction({type: "INCREASE", diff: {"_voting/preCommits": 200}}))

        expect(bc1._proposedBlock.hash).to.equal(db1.get("_voting/blockHash"))
        expect(bc1.height()).to.equal(1)
        expect(db1.get("_recentForgers")[0]).to.equal(db1.publicKey)

    })

    it("test if I am validator, trigger order is  '_voting' -> 'next_round_validators' -> (wait for hash) -> 'preVote' (wait for prevote) -> 'preCommit  -> (wait for preCommit)" , () => {
            // Must set Stake first !!!
            const stakeTransaction1 = db1.createTransaction({type: "SET", ref: `stakes/${db1.publicKey}`, value:200})
            const stakeTransaction2 = db2.createTransaction({type: "SET", ref: `stakes/${db2.publicKey}`, value:200})
            const stakeTransaction3 = db3.createTransaction({type: "SET", ref: `stakes/${db3.publicKey}`, value:200})
            p2p.executeTrans(stakeTransaction1)
            p2p.executeTrans(stakeTransaction2)
            p2p.executeTrans(stakeTransaction3)
                
            var validators = JSON.parse(JSON.stringify(db1.get("stakes")))
            delete validators[db2.publicKey]
    
            var firstVotingData = {validators, next_round_validators: {}, threshold: Number(400/3) * 2, forger: db2.publicKey, preVotes: 0, 
                                        preCommits: 0, time: Date.now() , blockHash: "", height: bc1.lastBlock().height + 1,  lastHash: bc1.lastBlock().hash}
            const initVotingTransaction = db1.createTransaction({type: "SET", ref: "_voting", value: firstVotingData})
            p2p.executeTrans(initVotingTransaction)

            // NO blockhash yet so prevotes will be equal to 0
            expect(db1.get("_voting").preVotes).to.equal(0)

            expect(bc1.height()).to.equal(0)
            expect(Object.keys(db1.get("_voting/next_round_validators"))[0]).to.equal(db1.publicKey)
            
            var block = bc2.forgeBlock(db1, tp2)
            p2p.proposeBlock(block)
            p2p.executeTrans(db2.createTransaction({type: "SET", ref: '_voting/blockHash', value: block.hash}))

            // Valid block was received so preVote should have been triggered
            expect(bc1._proposedBlock.hash).to.equal(db1.get("_voting/blockHash"))
            expect(db1.get("_voting/preVotes")).to.equal(200)
            expect(db1.get("_voting").preCommits).to.equal(0)


            console.log(Object.keys(db1.get("_voting/validators")).indexOf())
            console.log(db1.publicKey)

            // After second preVote preCommit should be triggered but height still equal 0 
            p2p.executeTrans(db3.createTransaction({type: "INCREASE", diff: {"_voting/preVotes": 200}} ))    
            
            expect(db1.get("_voting").preCommits).to.equal(200)
            expect(bc1.height()).to.equal(0)            
    
            // After second preCommit block should be added
            p2p.executeTrans(db3.createTransaction({type: "INCREASE", diff: {"_voting/preCommits": 200}}))
    
            expect(bc1.height()).to.equal(1)
    })


})

   
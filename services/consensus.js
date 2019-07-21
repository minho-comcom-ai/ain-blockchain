// All functions return either nothign or a transaction which is broadcast to the network

const shuffleSeed = require('shuffle-seed')
const seedrandom = require('seedrandom')
const {VOTING_STATUS} = require("../config")

module.exports =  function services(db, blockchain, tp, p2pServer){
    const preCommitDep = []
    const BLOCK_CREATION_INTERVAL = 6000
    const recentForgerDep = [] 
    var preVote = false
    var preCommit = false

    return {
        "_recentForgers": {
            "trigger": (transaction) => {
                    if(transaction.address === db.publicKey){
                        console.log("Starting new voting round in 6 second")
                        setTimeout(() => {
                            console.log("Starting new voting round now")
                            p2pServer.executeTrans(startNewRound(blockchain, db))
                        }, BLOCK_CREATION_INTERVAL)
                        
                    }
                },
        },
        "_voting": {
            "trigger": (transaction) => {
                    console.log(`New voting round has been started by ${transaction.address}`)
                    // First check if blockchain is synced with network
                    preCommitDep.length = 0
                    recentForgerDep.length = 0
                    preVote = false
                    preCommit = false
                    if(blockchain.height() + 1 !== transaction.output.value.height){
                        p2pServer.requestChainSubsection(blockchain.lastBlock())
                    }


                    // Register for next round of validators
                    var ref = `_voting/next_round_validators/${db.publicKey}`
                    var value = db.get(`stakes/${db.publicKey}`)
                    if (p2pServer.stake > 0  && value === null) {
                        return db.createTransaction({type: "SET", ref: `stakes/${db.publicKey}`, value: p2pServer.stake})
                    }
                    return db.createTransaction({type: "SET", ref, value})
                },

            "blockHash":{
                "trigger": (transaction) => {
                    console.log(`Block proposer  ${transaction.address} has proposed a new block`)
                    var block =  blockchain.getProposedBlock(transaction.output.value)
                    console.log(`Block is ${JSON.stringify(block)}`)
                    // If block is valid and you are only validator/  
                    if (block !== null && blockchain.isValidBlock(block) && block.hash === transaction.output.value && Boolean(db.get(`_voting/validators/${db.publicKey}`))){
                        // Prevote for block
                        var stake =  db.get(`_voting/validators/${db.publicKey}`)
                        var diff = {"_voting/preVotes": stake}
                        // Append validating transaction to block so validators can be held accountable
                        var validatingTransaction =  db.createTransaction({type: "INCREASE", diff}, dependantTransactions=[transaction])
                        return validatingTransaction
                    } else if (Object.keys(db.get(`_voting/validators`)).length === 0){
                        blockchain.addNewBlock(block)
                        tp.removeCommitedTransactions(block)
                        db.reconstruct(blockchain, tp)
                        if (db.publicKey === db.get(`_voting/forger`)){
                            return db.createTransaction({type: "SET", ref: '_recentForgers', value: updateForgers(db)})
                        }
                    }  else if ((db.publicKey !== db.get(`_voting/forger`))){
                        p2pServer.requestChainSubsection(blockchain.lastBlock())
                    }
                }
            }, 

            "preVotes":{
                "trigger": (transaction) => {
                    console.log(`Prevote registered by ${transaction.address}`)
                    preCommitDep.push(transaction)
                    // Add incoming validator Transaction to block
                    blockchain.getProposedBlock(db.get("_voting/blockHash")).addValidatingTransaction(transaction)
                    
                    // If enough preVotes have been received and I have not already preCommitted
                    if (db.get('_voting/preVotes') > db.get("_voting/threshold") && db.get(`_voting/validators/${db.publicKey}`) !== null && !preVote){
                        // PreCommit for block
                        preVote = true
                        var stake =  db.get(`_voting/validators/${db.publicKey}`)
                        var diff = {"_voting/preCommits": stake}
                        // Append validating transaction to block so validators can be held accountable
                        var validatingTransaction =  db.createTransaction({type: "INCREASE", diff})
                        return validatingTransaction
                    }   
                }
            },
            "preCommits": {
                "trigger": (transaction) => {
                    console.log(`PreCcommit registered by ${transaction.address}`)
                    recentForgerDep.push(transaction)
                    // Add incoming validator Transaction to block
                    const block =  blockchain.getProposedBlock(db.get("_voting/blockHash"))
                    block.addValidatingTransaction(transaction)
                    // If enough preVotes have been received and I have not already preCommitted
                    if (db.get('_voting/preCommits') > db.get("_voting/threshold") && !preCommit){
                        console.log(`Adding new block at height ${block.height}`)
                        preCommit = true
                        // Commit Block
                        
                        blockchain.addNewBlock(block)
                        tp.removeCommitedTransactions(block)
                        db.reconstruct(blockchain, tp)
                        
                        // Allow yourself to start next round (this logic is kinda messty so maybe keep it in seperate class)
                        if (db.publicKey === db.get("_voting/forger")){
                            return db.createTransaction({type: "SET", ref: '_recentForgers', value: updateForgers(db)}, dependantTransactions=recentForgerDep)
                        } 
                    }   
                }
            },
            "next_round_validators": {
                "$id": {
                    "trigger": (transaction) => {
                        // Next round validators means that a new round of voting has begun
                        // If you are the forger, forge the block and publish the blockHash
                        console.log(`Registering ${transaction.address} for next round of voting`)
                        if (db.get('_voting/forger') === transaction.address &&  transaction.address  === db.publicKey){
                            var block = blockchain.forgeBlock(db, tp)
                            p2pServer.proposeBlock(block)
                            return db.createTransaction({type: "SET", ref: '_voting/blockHash', value: block.hash})
                        }  
                    }
                }
            }
        }
    }
}

function updateForgers(db){
    var ref = `_recentForgers`
    var recentForgers = JSON.parse(JSON.stringify(db.get(ref)))
    if (recentForgers == null){
        recentForgers = []
    }
    else if (recentForgers.length == 20){
        recentForgers.shift()
    }

    if (recentForgers.indexOf(db.publicKey) >= 0){
        recentForgers.splice(recentForgers.indexOf(db.publicKey), 1)
    }
    recentForgers.push(db.publicKey)
    return recentForgers
}

function  getForger(stakeHolders, bc){
    var alphabeticallyOrderedStakeHolders  = Object.keys(stakeHolders).sort()
    var totalStakedAmount = Object.values(stakeHolders).reduce(function(a, b) { return a + b; }, 0);
    var seed = bc.chain.length > 5 ? bc.chain[bc.chain.length - 4].hash : bc.chain[0].hash 
    
    alphabeticallyOrderedStakeHolders = shuffleSeed.shuffle(alphabeticallyOrderedStakeHolders, seed)
    var cumulativeStakeFromPotentialValidators = 0
    var randomNumGenerator = seedrandom(seed)
    var targetValue = randomNumGenerator() * totalStakedAmount
    for(var i=0; i < alphabeticallyOrderedStakeHolders.length; i++){
        cumulativeStakeFromPotentialValidators += stakeHolders[alphabeticallyOrderedStakeHolders[i]]
        if(targetValue < cumulativeStakeFromPotentialValidators){
            console.log(`Forger is ${alphabeticallyOrderedStakeHolders[i]}`)
            return alphabeticallyOrderedStakeHolders[i]
        }
    }
    throw Error("Chris your function is absolutely useless ! Sort your life out")
}


function startNewRound(bc, db){
    var lastRound = db.get("_voting")
    var time = Date.now()
    let forger
    if (Object.keys(lastRound.next_round_validators).length){
        forger = getForger(lastRound.next_round_validators, bc)
        delete lastRound.next_round_validators[forger]
    } else{
        forger = db.publicKey
    }
    var threshold = Math.round(Object.values(lastRound.next_round_validators).reduce(function(a, b) { return a + b; }, 0) * .666) - 1
    var nextRound = {validators: lastRound.next_round_validators, next_round_validators:{}, threshold, forger:forger, preVotes: 0, preCommits: 0, time, blockHash: null}
    if (lastRound.preCommits > lastRound.threshold){
        // Should be1
        nextRound =  Object.assign({}, nextRound, {height: lastRound.height + 1, lastHash: lastRound.blockHash})
    } else {
        // Start same round
        nextRound =  Object.assign({}, nextRound, {height: lastRound.height,  lastHash: lastRound.lastHash})
    }

    return db.createTransaction({type: "SET", ref: "_voting", value: nextRound})
}
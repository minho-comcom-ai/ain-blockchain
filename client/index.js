#! /usr/bin/node
/**
 * Copyright 2017, Google, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

// Require process, so we can mock environment variables
const process = require('process');
const PORT = process.env.PORT || 8080;

// Initiate logging
const LOG = process.env.LOG || false;
var LAST_NONCE = 0
var CURRENT_NONCE = 0
const TX_PER_SECOND_AUTOBATCHING = 200

if(LOG){
  var fs = require('fs');
  var util = require('util');
  var log_dir = __dirname + '/' + ".logs"
  if (!(fs.existsSync(log_dir))){
    fs.mkdirSync(log_dir);
}
  var log_file = fs.createWriteStream(log_dir + '/' + PORT +'debug.log', {flags : 'w'});
  var log_stdout = process.stdout;

  console.log = function(d) { 
    log_file.write(util.format(d) + '\n');
    log_stdout.write(util.format(d) + '\n');
  }
}


// [START gae_flex_mysql_app]
const express = require('express');
// const crypto = require('crypto');
// var Promise = require("bluebird");
// var bodyParser = require('body-parser')
const P2pServer = require('../server')
const Database = require('../db')
// Define peer2peer server here which will broadcast changes in the database
// and also track which servers are in the network

// Applictation dependencies
const Blockchain = require('../blockchain');
const TransactionPool = require('../db/transaction-pool')
const InvalidPerissonsError = require("../errors")


const app = express();


const transactionBatch = []

app.use(express.json()); // support json encoded bodies
// app.use(bodyParser.urlencoded({ extended: false })); // support encoded bodies

const bc = new Blockchain(String(PORT));
const tp = new TransactionPool()
const db = Database.getDatabase(bc, tp)
const p2pServer = new P2pServer(db, bc, tp, process.env.STAKE? Number(process.env.STAKE) : null)
const jayson = require('jayson')


const json_rpc_methods = require('../json_rpc/methods')(bc, tp)
app.post('/json-rpc', jayson.server(json_rpc_methods).middleware())


app.get('/', (req, res, next) => {
  try{
    res
      .status(200)
      .set('Content-Type', 'text/plain')
      .send('Welcome to afan-tx-server')
      .end();
    } catch (error){
      console.log(error)
    }
})


app.get('/stake', (req, res, next) => {
  var statusCode = 201
  var result = null

  try{
    result = stake(req.query.ref)
  } catch (error){
    if(error instanceof InvalidPerissonsError){
      statusCode = 401
    } else {
      statusCode = 400
    }
    console.log(error.stack)
  }
  res
  .status(statusCode)
  .set('Content-Type', 'application/json')
  .send({code: result ? 0 : -1, result})
  .end();
})

app.post('/update', (req, res, next) => {
  var data = req.body.data;
  let result = db.update(data)
  createTransaction({op: "update", data})
  res
    .status(201)
    .set('Content-Type', 'application/json')
    .send({code: 0, result})
    .end();
})

app.get('/get', (req, res, next) => {
  var statusCode = 200
  var result = null
  try{
    result = db.get(req.query.ref)
  } catch (error){
    if(error instanceof InvalidPerissonsError){
      statusCode = 401
    } else {
      statusCode = 400
    }
    console.log(error.stack)
  }
  res
  .status(statusCode)
  .set('Content-Type', 'application/json')
  .send({code: result ? 0 : -1, result})
  .end();
})

app.post('/set', (req, res, next) => {
  var statusCode = 201
  try{
    var ref = req.body.ref;
    var value = req.body.value
    db.set(ref, value)
    createTransaction({op: "set", ref, value})
  } catch (error){
    if(error instanceof InvalidPerissonsError){
      statusCode = 401
    } else {
      statusCode = 400
    }
    console.log(error.stack)
  }
  res.status(statusCode).set('Content-Type', 'application/json').send({code: statusCode < 299? 0: 1}).end();
})


app.post('/batch', (req, res, next) => {
  var batch_list = req.body.batch_list
  try{
    var result_list = db.batch(batch_list)
    createTransaction({op: "batch", batch_list})
  }catch (err){
    console.log(err)
  }
  res
    .status(200)
    .set('Content-Type', 'application/json')
    .send(result_list)
    .end();
})

app.post('/increase', (req, res, next) => {
  var statusCode = 201
  let result
  try{
    var diff = req.body.diff;
    result = db.increase(diff)
    createTransaction({op: "increase", diff})
  } catch (error){
    if(error instanceof InvalidPerissonsError){
      statusCode = 401
    } else {
      statusCode = 400
    }
    console.log(error.stack)
  }
  res
  .status(statusCode)
  .set('Content-Type', 'application/json')
  .send({code: statusCode < 400 ? 0 : 1, result})
  .end();
})

// We will want changes in ports and the database to be broadcast across
// all instances so lets pass this info into the p2p server
app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
  console.log('Press Ctrl+C to quit.');
});
// [END gae_flex_mysql_app]


// Lets start this p2p server up so we listen for changes in either DATABASE
// or NUMBER OF SERVERS
p2pServer.listen()

module.exports = app;

function createBatchTransaction(trans){
  if (transactionBatch.length == 0){
    setTimeout(() => {
      broadcastBatchTransaction()
    }, 100)
  }
  CURRENT_NONCE += 1
  transactionBatch.push(trans)
}

function broadcastBatchTransaction(){
  if (transactionBatch.length > 0){
    var batch_list =  JSON.parse(JSON.stringify(transactionBatch))
    transactionBatch.length = 0
    let transaction =  db.createTransaction({type: "BATCH", batch_list}, tp)
    p2pServer.broadcastTransaction(transaction)
  }
}

function createSingularTransaction(trans){
  CURRENT_NONCE += 1
  let transaction
  switch(trans.op){
    case "batch":
      transaction = db.createTransaction({type: "BATCH", batch_list: trans.batch_list}, tp)
      break
    case "increase":
      transaction = db.createTransaction({type: "INCREASE", diff: trans.diff}, tp)
      break
    case "update":
      transaction = db.createTransaction({type: "UPDATE", data: trans.data}, tp)
      break
    case "set":
      transaction = db.createTransaction({type: "SET", ref: trans.ref, value: trans.value}, tp)
      break
  }
  p2pServer.broadcastTransaction(transaction)
}

let createTransaction 
createTransaction = createSingularTransaction


// Here we specity
setInterval(() => {
  if(CURRENT_NONCE - LAST_NONCE > TX_PER_SECOND_AUTOBATCHING){
    createTransaction = createBatchTransaction
  } else {
    broadcastBatchTransaction()
    createTransaction = createSingularTransaction
  }

  LAST_NONCE = CURRENT_NONCE
}, 1000)
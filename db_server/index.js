const express = require('express');
const pg = require('pg');

const app = express();
const connectionString = 'postgres://tester@localhost:5432/test';


app.get('/', function (req, res, next) {
    const data = { id: "1", name: "abc", rollnumber: "11111" }; // dummy data for now.

    pg.connect(connectionString, function(err, client, done) {
       if(err){
           done();
           console.log(err);
           res.status(400).send(err);
       }
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
       client.query('INSERT INTO Student(id, name, rollnumber) values($1, $2, $3)', [data.id, data.name, data.rollnumber]);
       client.query('SELECT * FROM student where id = $1', [1], function(err, result) {
           if (err) {
               console.log(err);
               res.status(400).send(err);
           }
           res.status(200).send(result.rows);
       });
    });
});

app.listen(4000, function() {
    console.log("init localhost");
});
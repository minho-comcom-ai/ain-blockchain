const glob = require( 'glob' )
const path = require( 'path' );
const ChainUtil = require('../chain-util')

class ServiceExecutor {

    constructor(db, blockchain, tp, p2p) {
        const services = []
        glob.sync( './services/*.js' ).forEach( function( file ) {
            services.push(require( path.resolve( file ) )(db, blockchain, tp, p2p));
          });
        this.services = services.reduce(function (r, o) {
            Object.keys(o).forEach(function (k) { r[k] = o[k]; });
            return r;
        }, {});
        

    }

    executeTransactionFunction(transaction){
        let functionPath  
        switch(transaction.output.type){
            case "SET":
                functionPath = ChainUtil.queryParser(transaction.output.ref)
                break
            case "INCREASE":
                // Currently only works for 
                functionPath = ChainUtil.queryParser(Object.keys(transaction.output.diff)[0])
                break
            default:
                console.log("Not yet supported ")
                return null
        }

       return  this._execute(functionPath, transaction)
    }

    _execute(functionPath, transaction){
        var func =  this.services
        try{
            functionPath.forEach(function(key){
                if (!(key in func)){
                    for(var wildKey in func){
                        if (wildKey.startsWith("$")) {
                            key = wildKey
                            break
                        }
                    }
                }
                func = func[key]
            })
        } catch (error) {
            console.log(`No function for path ${functionPath}`)
            return null
        }
        var response = null
        if (typeof func !=="undefined" && "trigger" in func){
            response = func.trigger(transaction)
        } 
 
        return typeof response == "undefined" ?  null : response

    }
    
}


module.exports = ServiceExecutor;

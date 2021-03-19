const Flashloan = artifacts.require("Flashloan");
const { mainnet: addresses } = require('../addresses'); // rename 'mainnet' to 'addresses', require('../addresses') is shorthand notation for require('../addresses/index.js')

module.exports = function (deployer, _network, [beneficiaryAddress, _]) { // array of accounts in module.exports contains only one address (i.e. the one added in truffle-config.js via new HDWalletProvider). _ ignores any following values
    deployer.deploy(
        Flashloan, // smart contract to be deployed
        addresses.kyber.kyberNetworkProxy, // arguments to the smart contract constructor
        addresses.uniswap.router, // arguments to the smart contract constructor
        addresses.tokens.weth, // arguments to the smart contract constructor
        addresses.tokens.dai, // arguments to the smart contract constructor
        beneficiaryAddress // arguments to the smart contract constructor
    );
};

// to deploy to mainnet: truffle migrate --network mainnet --reset
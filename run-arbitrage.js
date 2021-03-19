require('dotenv').config();
const Web3 = require('web3');
const abis = require('./abis'); // import kyber abi = json document describing the solidity interface of the kyber smart contract
const { mainnet: addresses } = require('./addresses');
const { ChainId, Token, TokenAmount, Pair, Fetcher } = require('@uniswap/sdk'); // import uniswap sdk
const Flashloan = require('./build/contracts/Flashloan.json');

const web3 = new Web3(
    new Web3.providers.WebsocketProvider(process.env.INFURA_URL) // connect to the blockchain via web3 & infura websocket url
);

// add eth address: 0x25981A0a9654b690C2a68c4F9ba334EBC6222A43
const { address: admin } = web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY);

// establish connection to kyber
const kyber = new web3.eth.Contract(
    abis.kyber.kyberNetworkProxy,
    addresses.kyber.kyberNetworkProxy
);

// adjustable params:
// cast to BNs = guarantee that there will be no precision errors when doing calculations
const ONE_WEI = web3.utils.toBN(web3.utils.toWei('1')); // .toWei() function expects a string as input
// i.e. arbitrage for 20000 DAI: compromise between an amount too low to make profit and an amount too high that will create slippage
const AMOUNT_DAI_WEI = web3.utils.toBN(web3.utils.toWei('20000')); // .toWei() function expects a string as input
const DIRECTION = {
    KYBER_TO_UNISWAP: 0,
    UNISWAP_TO_KYBER: 1
};

const init = async () => {
    // instantiate flashloan smart contract
    const networkId = await web3.eth.net.getId();
    const flashloan = new web3.eth.Contract(
        Flashloan.abi, 
        Flashloan.networks[networkId].address
    );
    
    // fetch the latest ETH price periodically from kyber
    let ethPrice;
    const updateEthPrice = async () => {
        const results = await kyber.methods.getExpectedRate(
            '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 
            addresses.tokens.dai, 
            1
        ).call();
        ethPrice = web3.utils.toBN('1').mul(web3.utils.toBN(results.expectedRate)).div(ONE_WEI);
    }
    await updateEthPrice();
    setInterval(updateEthPrice, 15000); // update the ETH price every 15 seconds

    // listen to new blocks
    web3.eth.subscribe('newBlockHeaders') // just subscribe to the block headers, not the whole block (too much information)
    .on('data', async block => { // emit an event 'data' whenever there is a new block, triggering callback
        console.log(`New block received. Block # ${block.number}`);

        // instantiate uniswap tokens: dai & weth
        const [dai, weth] = await Promise.all(
            [addresses.tokens.dai, addresses.tokens.weth].map(tokenAddress => (
                //Token.fetchData(ChainId.MAINNET, tokenAddress)
                Fetcher.fetchTokenData(ChainId.MAINNET, tokenAddress)
        )));
        // instantiate uniswap pair: dai & weth
        // const daiWeth = await Pair.fetchData(dai, weth);
        const daiWeth = await Fetcher.fetchPairData(dai, weth);

        // pull ETH prices (in DAI) every time there is a new block posted to the ethereum blockchain (optimized for speed)
        const amountsEth = await Promise.all([
            // fetch from kyber: this ETH price is fed into amountsDai[1] below
            kyber.methods.getExpectedRate(
                addresses.tokens.dai, 
                '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // destination token, note: ETH is not a token, so use special kyber convention = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
                AMOUNT_DAI_WEI
            ).call(), // read-only transaction, so no transaction fee!
            // fetch from uniswap: this ETH price is fed into amountsDai[0] below
            daiWeth.getOutputAmount(new TokenAmount(dai, AMOUNT_DAI_WEI)),
        ]);
        const ethFromKyber = AMOUNT_DAI_WEI.mul(web3.utils.toBN(amountsEth[0].expectedRate)).div(ONE_WEI); // .mul() and .div() are BN functions
        const ethFromUniswap = web3.utils.toBN(amountsEth[1][0].raw.toString());
        
        // pull DAI prices (in ETH) every time there is a new block posted to the ethereum blockchain
        const amountsDai = await Promise.all([
            // fetch from kyber
            kyber.methods.getExpectedRate(
                '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 
                addresses.tokens.dai, 
                ethFromUniswap.toString()
            ).call(),
            // fetch from uniswap
            daiWeth.getOutputAmount(new TokenAmount(weth, ethFromKyber.toString())),
        ]);
        const daiFromKyber = ethFromUniswap.mul(web3.utils.toBN(amountsDai[0].expectedRate)).div(ONE_WEI);
        const daiFromUniswap = web3.utils.toBN(amountsDai[1][0].raw.toString());
    
        console.log(`Kyber -> Uniswap. DAI input / output: ${web3.utils.fromWei(AMOUNT_DAI_WEI.toString())} / ${web3.utils.fromWei(daiFromUniswap.toString())}`);
        console.log(`Uniswap -> Kyber. DAI input / output: ${web3.utils.fromWei(AMOUNT_DAI_WEI.toString())} / ${web3.utils.fromWei(daiFromKyber.toString())}`);

        // evaluate arbitrage opportunities
        if(daiFromUniswap.gt(AMOUNT_DAI_WEI)) { // .gt() is a BN function
            const tx = flashloan.methods.initiateFlashloan(
                addresses.dydx.solo, 
                addresses.tokens.dai, 
                AMOUNT_DAI_WEI,
                DIRECTION.KYBER_TO_UNISWAP
            );
            // determine gas price and cost
            // note: sometime the estimateGas() function does not do a good job: console.log the calculated gas cost and add 10-20% to it
            const [gasPrice, gasCost] = await Promise.all([
                web3.eth.getGasPrice(), // fetch the latest gas price: returns a string
                tx.estimateGas({from: admin}), // estimate gas cost for the transaction (i.e. initiateFlashloan): returns a string
            ]);
    
            const txCost = web3.utils.toBN(gasCost).mul(web3.utils.toBN(gasPrice)).mul(ethPrice);
            // calculate profit when buying ETH on kyber and selling on uniswap (in DAI)
            const profit = daiFromUniswap.sub(AMOUNT_DAI_WEI).sub(txCost);
    
            if(profit > 0) {
                console.log('Arbitrage opportunity found Kyber -> Uniswap!');
                console.log(`Expected profit: ${web3.utils.fromWei(profit)} DAI`);
                // send a transaction to the flashloan smart contract from the backend (different as compared to sending a tx with metamask)
                const data = tx.encodeABI(); // build data param of the transaction = describe which function will be called with which arguments
                const txData = {
                    from: admin,
                    to: flashloan.options.address,
                    data,
                    gas: gasCost,
                    gasPrice
                };
                const receipt = await web3.eth.sendTransaction(txData); // send the transaction
                console.log(`Transaction hash: ${receipt.transactionHash}`);
            }
        }
        
        else if(daiFromKyber.gt(AMOUNT_DAI_WEI)) {
            const tx = flashloan.methods.initiateFlashloan(
                addresses.dydx.solo, 
                addresses.tokens.dai, 
                AMOUNT_DAI_WEI,
                DIRECTION.UNISWAP_TO_KYBER
            );
            // determine gas price and cost
            // note: sometime the estimateGas() function does not do a good job: console.log the calculated gas cost and add 10-20% to it
            const [gasPrice, gasCost] = await Promise.all([
                web3.eth.getGasPrice(), // fetch the latest gas price: returns a string
                tx.estimateGas({from: admin}), // estimate gas cost for the transaction (i.e. initiateFlashloan): returns a string
            ]);
            const txCost = web3.utils.toBN(gasCost).mul(web3.utils.toBN(gasPrice)).mul(ethPrice);
            // calculate profit when buying ETH on uniswap and selling on kyber (in DAI)
            const profit = daiFromKyber.sub(AMOUNT_DAI_WEI).sub(txCost);
    
            if(profit > 0) {
                console.log('Arbitrage opportunity found Uniswap -> Kyber!');
                console.log(`Expected profit: ${web3.utils.fromWei(profit)} DAI`);
                // send a transaction to the flashloan smart contract from the backend (different as compared to sending a tx with metamask)
                const data = tx.encodeABI(); // build data param of the transaction = describe which function will be called with which arguments
                const txData = {
                    from: admin,
                    to: flashloan.options.address,
                    data,
                    gas: gasCost,
                    gasPrice
                };
                const receipt = await web3.eth.sendTransaction(txData); // send the transaction
                console.log(`Transaction hash: ${receipt.transactionHash}`);
            }
        }

        else {
            console.log('No arbitrage opportunities found at this time...');
        }

    })
    .on('error', error => { // also listen to the error event in case an error is returned
        console.log(error);
    });
}

init();
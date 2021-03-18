require('dotenv').config();
const Web3 = require('web3');
const abis = require('./abis'); // import kyber abi = json document describing the solidity interface of the kyber smart contract
const { mainnet: addresses } = require('./addresses');
const { ChainId, Token, TokenAmount, Pair, Fetcher } = require('@uniswap/sdk'); // import uniswap sdk

const web3 = new Web3(
    new Web3.providers.WebsocketProvider(process.env.INFURA_URL) // connect to the blockchain via web3 & infura websocket url
);

// add eth address: 0x25981A0a9654b690C2a68c4F9ba334EBC6222A43
web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY);

// establish connection to kyber
const kyber = new web3.eth.Contract(
    abis.kyber.kyberNetworkProxy,
    addresses.kyber.kyberNetworkProxy
);

// adjustable params:
const AMOUNT_ETH = 100; // i.e. arbitrage for 100 ether: compromise between an amount too low to make profit and an amount too high that will create slippage
const RECENT_ETH_PRICE = 1825; // in USD. // TODO: update from static param into dynamicly updated value
const AMOUNT_ETH_IN_WEI = web3.utils.toWei(AMOUNT_ETH.toString()); // .toWei() function expects a string as input
const AMOUNT_DAI_IN_WEI = web3.utils.toWei((AMOUNT_ETH * RECENT_ETH_PRICE).toString());

const init = async () => {
    // instantiate uniswap tokens: dai & weth
    const [dai, weth] = await Promise.all(
        [addresses.tokens.dai, addresses.tokens.weth].map(tokenAddress => (
            //Token.fetchData(ChainId.MAINNET, tokenAddress)
            Fetcher.fetchTokenData(ChainId.MAINNET, tokenAddress)
    )));
    // instantiate uniswap pair: dai & weth
    // const daiWeth = await Pair.fetchData(dai, weth);
    const daiWeth = await Fetcher.fetchPairData(dai, weth);

    // listen to new blocks
    web3.eth.subscribe('newBlockHeaders') // just subscribe to the block headers, not the whole block (too much information)
    .on('data', async block => { // emit an event 'data' whenever there is a new block, triggering callback
        console.log(`New block received. Block # ${block.number}`);
        
        // pull prices from KYBER every time there is a new block posted to the ethereum blockchain
        const kyberResults = await Promise.all([
            kyber.methods.getExpectedRate(
                addresses.tokens.dai, // source token
                '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // destination token, note: ETH is not a token, so use special kyber convention = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
                AMOUNT_DAI_IN_WEI
            ).call(), // read-only transaction, so no transaction fee!
            kyber.methods.getExpectedRate(
                '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                addresses.tokens.dai,
                AMOUNT_ETH_IN_WEI
            ).call()
        ]);
        const kyberRates = {
            buy: parseFloat(1 / (kyberResults[0].expectedRate / (10**18))),
            sell: parseFloat(kyberResults[1].expectedRate / (10**18))
        };
        console.log('Kyber ETH/DAI');
        console.log(kyberRates);

        // pull prices from UNISWAP every time there is a new block posted to the ethereum blockchain
        const uniswapResults = await Promise.all([
            daiWeth.getOutputAmount(new TokenAmount(dai, AMOUNT_DAI_IN_WEI)),
            daiWeth.getOutputAmount(new TokenAmount(weth, AMOUNT_ETH_IN_WEI))
        ]);
        const uniswapRates = {
            buy: parseFloat(AMOUNT_DAI_IN_WEI / (uniswapResults[0][0].toExact() * (10**18))),
            sell: parseFloat(uniswapResults[1][0].toExact() / AMOUNT_ETH)
        };
        console.log('Uniswap ETH/DAI');
        console.log(uniswapRates);

        // evaluate arbitrage opportunity
        // fetch latest gas price
        const gasPrice = await web3.eth.getGasPrice(); // returns a string
        const txCost = 200000 * parseInt(gasPrice);
        const currentEthPrice = (uniswapRates.buy + uniswapRates.sell) / 2;
        // calculate profit when buying ETH on kyber and selling on uniswap (in USD)
        const profit1 = (parseInt(AMOUNT_ETH_IN_WEI) / (10**18)) * (uniswapRates.sell - kyberRates.buy) - ((txCost / (10**18)) * currentEthPrice);
        // calculate profit when buying ETH on uniswap and selling on kyber (in USD)
        const profit2 = (parseInt(AMOUNT_ETH_IN_WEI) / (10**18)) * (kyberRates.sell - uniswapRates.buy) - ((txCost / (10**18)) * currentEthPrice);

        if (profit1 > 0) {
            console.log('Arbitrage opportunity found!');
            console.log(`Buy ETH on Kyber at ${kyberRates.buy} DAI`);
            console.log(`Sell ETH on Uniswap at ${uniswapRates.sell} DAI`);
            console.log(`Expected profit: ${profit1} DAI`);
        } else if (profit2 > 0) {
            console.log('Arbitrage opportunity found!');
            console.log(`Buy ETH on Uniswap at ${uniswapRates.buy} DAI`);
            console.log(`Sell ETH on Kyber at ${kyberRates.sell} DAI`);
            console.log(`Expected profit: ${profit2} DAI`);
        } else {
            console.log('No arbitrage opportunities found at this time...');
        }

    })
    .on('error', error => { // also listen to the error event in case an error is returned
        console.log(error);
    });
}

init();
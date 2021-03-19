pragma solidity ^0.5.0;
pragma experimental ABIEncoderV2;

import "@studydefi/money-legos/dydx/contracts/DydxFlashloanBase.sol";
import "@studydefi/money-legos/dydx/contracts/ICallee.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { KyberNetworkProxy as IKyberNetworkProxy } from '@studydefi/money-legos/kyber/contracts/KyberNetworkProxy.sol';
// import "./IUniswapV2Router01.sol";
import "./IUniswapV2Router02.sol";
import "./IWeth.sol";


contract Flashloan is ICallee, DydxFlashloanBase {
    
    // direction of the arbitrage
    enum Direction { KyberToUniswap, UniswapToKyber }
    
    struct ArbInfo {
        Direction direction;
        uint256 repayAmount;
    }

    event NewArbitrage(Direction direction, uint profit, uint date);

    IKyberNetworkProxy kyber;
    IUniswapV2Router02 uniswap;
    IWeth weth;
    IERC20 dai;
    address constant KYBER_ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE; // kyber convention for ether >>> optimization: constant can save gas, as the compiler will know it will never change in the lifetime of the smart contract
    address beneficiary;

    constructor (address kyberAddress, address uniswapAddress, address wethAddress, address daiAddress, address beneficiaryAddress) public {
        kyber = IKyberNetworkProxy(kyberAddress);
        uniswap = IUniswapV2Router02(uniswapAddress);
        weth = IWeth(wethAddress);
        dai = IERC20(daiAddress);
        beneficiary = beneficiaryAddress;
    }

    // This is the function that will be called postLoan (after loan withdrawal)
    // i.e. Encode the logic to handle your flashloaned funds here = the arbitrage logic
    function callFunction(
        address sender,
        Account.Info memory account,
        bytes memory data // passing parameters in bytes is way more flexible when it is not known upfront what data will be passed
    ) public {
        ArbInfo memory arbInfo = abi.decode(data, (ArbInfo));
        uint256 balanceDai = dai.balanceOf(address(this));

        if (arbInfo.direction == Direction.KyberToUniswap) {
            // buy ETH on kyber
            dai.approve(address(kyber), balanceDai); // approve DAI to be spent on kyber
            (uint expecteRate, ) = kyber.getExpectedRate(dai, IERC20(KYBER_ETH_ADDRESS), balanceDai); // get expected rate for the trade
            kyber.swapTokenToEther(dai, balanceDai, expecteRate); // do the buy swap

            // sell ETH on uniswap (more complicated and involves specifying a path/route)
            address[] memory path = new address[](2);
            path[0] = address(weth); // uniswap only deals with WETH
            path[1] = address(dai);
            uint[] memory minOuts = uniswap.getAmountsOut(address(this).balance, path); // get DAI price
            uniswap.swapExactETHForTokens.value(address(this).balance)(minOuts[1], path, address(this), now); // do the sell swap
        } else {
            // buy ETH on uniswap
            dai.approve(address(uniswap), balanceDai); // approve DAI to be spent on uniswap
            address[] memory path = new address[](2);
            path[0] = address(dai); // uniswap only deals with WETH
            path[1] = address(weth);
            uint[] memory minOuts = uniswap.getAmountsOut(balanceDai, path); // get DAI price
            uniswap.swapExactTokensForETH(balanceDai, minOuts[1], path, address(this), now); // do the buy swap    

            // sell ETH on kyber
            (uint expecteRate, ) = kyber.getExpectedRate(IERC20(KYBER_ETH_ADDRESS), dai, address(this).balance); // get expected rate for the trade
            kyber.swapEtherToToken.value(address(this).balance)(dai, expecteRate); // do the sell swap        
        }

        require(dai.balanceOf(address(this)) >= arbInfo.repayAmount, "Not enough funds to repay DyDx loan!"); // check if there is enough tokens made from the trade to pay back the flashloan
    
        uint profit = dai.balanceOf(address(this)) - arbInfo.repayAmount;
        dai.transfer(beneficiary, profit);
        emit NewArbitrage(arbInfo.direction, profit, now);
    }

    function initiateFlashLoan(
        address _solo, 
        address _token, 
        uint256 _amount,
        Direction _direction
        ) external
    {
        ISoloMargin solo = ISoloMargin(_solo);

        // Get marketId from token address
        uint256 marketId = _getMarketIdFromTokenAddress(_solo, _token);

        // Calculate repay amount (_amount + (2 wei))
        // Approve transfer from
        uint256 repayAmount = _getRepaymentAmountInternal(_amount);
        IERC20(_token).approve(_solo, repayAmount);

        // build an array of operations
        // 1. Withdraw $ = borrow the flashloan from dydx
        // 2. Call callFunction(...) = any arbitrary smart contract execution, i.e. the arbitrage logic
        // 3. Deposit back $ = pay back the flashloan
        Actions.ActionArgs[] memory operations = new Actions.ActionArgs[](3);

        operations[0] = _getWithdrawAction(marketId, _amount);
        operations[1] = _getCallAction(
            // Encode MyCustomData for callFunction
            abi.encode(ArbInfo({direction: _direction, repayAmount: repayAmount})) // encode into bytes
        );
        operations[2] = _getDepositAction(marketId, repayAmount);

        Account.Info[] memory accountInfos = new Account.Info[](1);
        accountInfos[0] = _getAccountInfo();

        solo.operate(accountInfos, operations);
    }

    function() external payable {}
}
import { BalanceCheckFlag, TxResult } from '@dolomite-margin/dist/src';
import { GenericTraderType } from '@dolomite-margin/dist/src/modules/GenericTraderProxyV1';
import { BaseRouter, Router } from '@pendle/sdk-v2';
import { CHAIN_ID_MAPPING } from '@pendle/sdk-v2/dist/common/ChainId';
import { expect } from 'chai';
import { BigNumber, BigNumberish } from 'ethers';
import {
  IPendlePtToken,
  PendlePtGLP2024IsolationModeTokenVaultV1,
  PendlePtGLP2024IsolationModeTokenVaultV1__factory,
  PendlePtGLP2024IsolationModeUnwrapperTraderV2,
  PendlePtGLP2024IsolationModeVaultFactory,
  PendlePtGLP2024IsolationModeWrapperTraderV2,
  PendlePtGLP2024Registry,
  PendlePtGLPPriceOracle,
} from '../../../src/types';
import { Account } from '../../../src/types/IDolomiteMargin';
import { IGenericTraderProxyBase } from '../../../src/types/LiquidatorProxyV4WithGenericTrader';
import { BYTES_EMPTY, Network, NO_EXPIRY, ONE_BI, ZERO_BI } from '../../../src/utils/no-deps-constants';
import { getRealLatestBlockNumber, revertToSnapshotAndCapture, snapshot, waitTime } from '../../utils';
import {
  expectProtocolBalance,
  expectProtocolBalanceIsGreaterThan,
  expectThrow,
  expectWalletBalance,
  expectWalletBalanceOrDustyIfZero,
} from '../../utils/assertions';
import {
  createPendlePtGLP2024IsolationModeTokenVaultV1,
  createPendlePtGLP2024IsolationModeUnwrapperTraderV2,
  createPendlePtGLP2024IsolationModeVaultFactory,
  createPendlePtGLP2024IsolationModeWrapperTraderV2,
  createPendlePtGLP2024Registry,
  createPendlePtGLPPriceOracle,
} from '../../utils/ecosystem-token-utils/pendle';
import { setExpiry } from '../../utils/expiry-utils';
import { getCalldataForParaswap } from '../../utils/liquidation-utils';
import {
  CoreProtocol,
  setupCoreProtocol,
  setupTestMarket,
  setupUSDCBalance,
  setupUserVaultProxy,
} from '../../utils/setup';
import TraderParamStruct = IGenericTraderProxyBase.TraderParamStruct;

const defaultAccountNumber = '0';
const otherAccountNumber = '420';
const heldAmountWei = BigNumber.from('200000000000000000000'); // $200
const minCollateralizationNumerator = BigNumber.from('115');
const minCollateralizationDenominator = BigNumber.from('100');
const liquidationSpreadNumerator = BigNumber.from('105');
const liquidationSpreadDenominator = BigNumber.from('100');
const expirationCollateralizationNumerator = BigNumber.from('150');
const expirationCollateralizationDenominator = BigNumber.from('100');
const FIVE_BIPS = 0.0005;

describe('PendlePtGLP2024IsolationModeLiquidation', () => {
  let snapshotId: string;

  let core: CoreProtocol;
  let underlyingToken: IPendlePtToken;
  let underlyingMarketId: BigNumber;
  let pendleVaultRegistry: PendlePtGLP2024Registry;
  let unwrapper: PendlePtGLP2024IsolationModeUnwrapperTraderV2;
  let wrapper: PendlePtGLP2024IsolationModeWrapperTraderV2;
  let factory: PendlePtGLP2024IsolationModeVaultFactory;
  let vault: PendlePtGLP2024IsolationModeTokenVaultV1;
  let priceOracle: PendlePtGLPPriceOracle;
  let defaultAccountStruct: Account.InfoStruct;
  let liquidAccountStruct: Account.InfoStruct;
  let solidAccountStruct: Account.InfoStruct;
  let router: BaseRouter;

  before(async () => {
    const blockNumber = await getRealLatestBlockNumber(true, Network.ArbitrumOne);
    core = await setupCoreProtocol({
      blockNumber,
      network: Network.ArbitrumOne,
    });
    underlyingToken = core.pendleEcosystem!.ptGlpToken.connect(core.hhUser1);
    const userVaultImplementation = await createPendlePtGLP2024IsolationModeTokenVaultV1();
    pendleVaultRegistry = await createPendlePtGLP2024Registry(core);
    factory = await createPendlePtGLP2024IsolationModeVaultFactory(
      core,
      pendleVaultRegistry,
      underlyingToken,
      userVaultImplementation,
    );
    unwrapper = await createPendlePtGLP2024IsolationModeUnwrapperTraderV2(core, factory, pendleVaultRegistry);
    wrapper = await createPendlePtGLP2024IsolationModeWrapperTraderV2(core, factory, pendleVaultRegistry);
    priceOracle = await createPendlePtGLPPriceOracle(core, factory, pendleVaultRegistry);

    underlyingMarketId = await core.dolomiteMargin.getNumMarkets();
    await setupTestMarket(core, factory, true, priceOracle);

    await factory.connect(core.governance).ownerInitialize([unwrapper.address, wrapper.address]);
    await core.dolomiteMargin.connect(core.governance).ownerSetGlobalOperator(factory.address, true);

    await factory.createVault(core.hhUser1.address);
    const vaultAddress = await factory.getVaultByAccount(core.hhUser1.address);
    vault = setupUserVaultProxy<PendlePtGLP2024IsolationModeTokenVaultV1>(
      vaultAddress,
      PendlePtGLP2024IsolationModeTokenVaultV1__factory,
      core.hhUser1,
    );
    defaultAccountStruct = { owner: vault.address, number: defaultAccountNumber };
    liquidAccountStruct = { owner: vault.address, number: otherAccountNumber };
    solidAccountStruct = { owner: core.hhUser5.address, number: defaultAccountNumber };

    router = Router.getRouter({
      chainId: CHAIN_ID_MAPPING.ARBITRUM,
      provider: core.hhUser1.provider,
      signer: core.hhUser1,
    });

    const usdcAmount = heldAmountWei.div(1e12).mul(8);
    await setupUSDCBalance(core, core.hhUser1, usdcAmount, core.gmxEcosystem!.glpManager);
    await core.gmxEcosystem!.glpRewardsRouter.connect(core.hhUser1)
      .mintAndStakeGlp(core.usdc.address, usdcAmount, 0, 0);
    const glpAmount = heldAmountWei.mul(4);
    await core.gmxEcosystem!.sGlp.connect(core.hhUser1)
      .approve(core.pendleEcosystem!.pendleRouter.address, glpAmount);

    await router.swapExactTokenForPt(
      core.pendleEcosystem!.ptGlpMarket.address as any,
      core.gmxEcosystem!.sGlp.address as any,
      glpAmount,
      FIVE_BIPS,
    );
    await core.pendleEcosystem!.ptGlpToken.connect(core.hhUser1).approve(vault.address, heldAmountWei);
    await vault.depositIntoVaultForDolomiteMargin(defaultAccountNumber, heldAmountWei);

    expect(await underlyingToken.connect(core.hhUser1).balanceOf(vault.address)).to.eq(heldAmountWei);
    expect((await core.dolomiteMargin.getAccountWei(defaultAccountStruct, underlyingMarketId)).value)
      .to
      .eq(heldAmountWei);

    await core.dolomiteMargin.ownerSetGlobalOperator(core.liquidatorProxyV4.address, true);

    snapshotId = await snapshot();
  });

  beforeEach(async () => {
    snapshotId = await revertToSnapshotAndCapture(snapshotId);
  });

  describe('Perform liquidation with full integration', () => {
    it('should work when liquid account is borrowing the output token (USDC)', async () => {
      const [supplyValue, borrowValue] = await core.dolomiteMargin.getAccountValues(defaultAccountStruct);
      expect(borrowValue.value).to.eq(ZERO_BI);

      const usdcPrice = await core.dolomiteMargin.getMarketPrice(core.marketIds.usdc);
      const usdcDebtAmount = supplyValue.value.mul(minCollateralizationDenominator)
        .div(minCollateralizationNumerator)
        .div(usdcPrice.value);
      await vault.transferIntoPositionWithUnderlyingToken(defaultAccountNumber, otherAccountNumber, heldAmountWei);
      await vault.transferFromPositionWithOtherToken(
        otherAccountNumber,
        defaultAccountNumber,
        core.marketIds.usdc,
        usdcDebtAmount,
        BalanceCheckFlag.To,
      );
      await core.testPriceOracle!.setPrice(core.usdc.address, '1050000000000000000000000000000');
      await core.dolomiteMargin.ownerSetPriceOracle(core.marketIds.usdc, core.testPriceOracle!.address);

      const newAccountValues = await core.dolomiteMargin.getAccountValues(liquidAccountStruct);
      // check that the position is indeed under collateralized
      expect(newAccountValues[0].value)
        .to
        .lt(newAccountValues[1].value.mul(minCollateralizationNumerator).div(minCollateralizationDenominator));

      const plvGlpPrice = await core.dolomiteMargin.getMarketPrice(underlyingMarketId);
      const heldUpdatedWithReward = await newAccountValues[1].value.mul(liquidationSpreadNumerator)
        .div(liquidationSpreadDenominator)
        .div(plvGlpPrice.value);
      const usdcOutputAmount = await unwrapper.getExchangeCost(
        factory.address,
        core.usdc.address,
        heldUpdatedWithReward,
        BYTES_EMPTY,
      );

      const txResult = await core.liquidatorProxyV4!.connect(core.hhUser5).liquidate(
        solidAccountStruct,
        liquidAccountStruct,
        [underlyingMarketId, core.marketIds.usdc],
        [],
        [],
        [],
        NO_EXPIRY,
      );
      const receipt = await txResult.wait();
      console.log('\tliquidatorProxy#liquidate gas used:', receipt.gasUsed.toString());

      await expectProtocolBalance(
        core,
        solidAccountStruct.owner,
        solidAccountStruct.number,
        underlyingMarketId,
        ZERO_BI,
      );
      await expectProtocolBalanceIsGreaterThan(
        core,
        solidAccountStruct,
        core.marketIds.usdc,
        usdcOutputAmount.sub(usdcDebtAmount),
        '5',
      );
      await expectProtocolBalanceIsGreaterThan(
        core,
        liquidAccountStruct,
        underlyingMarketId,
        heldAmountWei.sub(heldUpdatedWithReward),
        '5',
      );
      await expectProtocolBalance(
        core,
        liquidAccountStruct.owner,
        liquidAccountStruct.number,
        core.marketIds.usdc,
        ZERO_BI,
      );

      await expectWalletBalance(core.liquidatorProxyV4!.address, factory, ZERO_BI);
      await expectWalletBalance(core.liquidatorProxyV4!.address, core.weth, ZERO_BI);
      await expectWalletBalanceOrDustyIfZero(
        core,
        unwrapper.address,
        core.pendleEcosystem!.ptGlpToken.address,
        ZERO_BI,
      );
      await expectWalletBalanceOrDustyIfZero(core, unwrapper.address, core.usdc.address, ZERO_BI);
    });

    it('should work when liquid account is borrowing a different output token (WETH)', async () => {
      const [supplyValue, borrowValue] = await core.dolomiteMargin.getAccountValues(defaultAccountStruct);
      expect(borrowValue.value).to.eq(ZERO_BI);

      const wethPrice = await core.dolomiteMargin.getMarketPrice(core.marketIds.weth);
      const wethDebtAmount = supplyValue.value.mul(minCollateralizationDenominator)
        .div(minCollateralizationNumerator)
        .div(wethPrice.value);
      await vault.transferIntoPositionWithUnderlyingToken(defaultAccountNumber, otherAccountNumber, heldAmountWei);
      await vault.transferFromPositionWithOtherToken(
        otherAccountNumber,
        defaultAccountNumber,
        core.marketIds.weth,
        wethDebtAmount,
        BalanceCheckFlag.To,
      );
      // set the price of USDC to be 105% of the current price
      await core.testPriceOracle!.setPrice(
        core.weth.address,
        wethPrice.value.mul(liquidationSpreadNumerator).div(liquidationSpreadDenominator),
      );
      await core.dolomiteMargin.ownerSetPriceOracle(core.marketIds.weth, core.testPriceOracle!.address);

      const newAccountValues = await core.dolomiteMargin.getAccountValues(liquidAccountStruct);
      // check that the position is indeed under collateralized
      expect(newAccountValues[0].value)
        .to
        .lt(newAccountValues[1].value.mul(minCollateralizationNumerator).div(minCollateralizationDenominator));

      const glpPrice = await core.dolomiteMargin.getMarketPrice(underlyingMarketId);
      const heldUpdatedWithReward = await newAccountValues[1].value.mul(liquidationSpreadNumerator)
        .div(liquidationSpreadDenominator)
        .div(glpPrice.value);
      const usdcOutputAmount = await unwrapper.getExchangeCost(
        factory.address,
        core.usdc.address,
        heldUpdatedWithReward,
        BYTES_EMPTY,
      );
      const { calldata: paraswapCalldata, outputAmount: wethOutputAmount } = await getCalldataForParaswap(
        usdcOutputAmount,
        core.usdc,
        6,
        ONE_BI,
        core.weth,
        18,
        core.hhUser5,
        core.liquidatorProxyV4!,
        core,
      );

      const txResultPromise = core.liquidatorProxyV4!.connect(core.hhUser5).liquidate(
        solidAccountStruct,
        liquidAccountStruct,
        [underlyingMarketId, core.marketIds.weth],
        [],
        [],
        [],
        NO_EXPIRY,
      );
      try {
        const txResult = await txResultPromise;
        const receipt = await txResult.wait();
        console.log('\tliquidatorProxy#liquidate gas used:', receipt.gasUsed.toString());
      } catch (e) {
        await expectThrow(
          txResultPromise,
          'ParaswapTraderProxyWithBackup: External call failed',
        );
        console.warn(
          '\tParaswap call failed. This can happen when mixing a mainnet data with  Skipping the rest of the test.',
        );
        return;
      }

      await expectProtocolBalance(
        core,
        solidAccountStruct.owner,
        solidAccountStruct.number,
        underlyingMarketId,
        ZERO_BI,
      );
      await expectProtocolBalance(
        core,
        solidAccountStruct.owner,
        solidAccountStruct.number,
        core.marketIds.usdc,
        ZERO_BI,
      );
      await expectProtocolBalanceIsGreaterThan(
        core,
        solidAccountStruct,
        core.marketIds.weth,
        wethOutputAmount.sub(wethDebtAmount),
        '500',
      );
      await expectProtocolBalanceIsGreaterThan(
        core,
        liquidAccountStruct,
        underlyingMarketId,
        heldAmountWei.sub(heldUpdatedWithReward),
        '10',
      );
      await expectProtocolBalance(
        core,
        liquidAccountStruct.owner,
        liquidAccountStruct.number,
        core.marketIds.weth,
        ZERO_BI,
      );

      await expectWalletBalance(
        core.liquidatorProxyV4!.address,
        core.usdc,
        ZERO_BI,
      );
      await expectWalletBalance(
        core.liquidatorProxyV4!.address,
        core.weth,
        ZERO_BI,
      );
      await expectWalletBalanceOrDustyIfZero(
        core,
        unwrapper.address,
        core.pendleEcosystem!.ptGlpToken.address,
        ZERO_BI,
      );
      await expectWalletBalanceOrDustyIfZero(core, unwrapper.address, core.usdc.address, ZERO_BI);
    });
  });

  describe('Perform expiration with full integration', () => {
    it('should work when expired account is borrowing the output token (USDC)', async () => {
      await vault.transferIntoPositionWithUnderlyingToken(defaultAccountNumber, otherAccountNumber, heldAmountWei);
      const [supplyValue, borrowValue] = await core.dolomiteMargin.getAccountValues(liquidAccountStruct);
      expect(borrowValue.value).to.eq(ZERO_BI);

      const usdcPrice = await core.dolomiteMargin.getMarketPrice(core.marketIds.usdc);
      const usdcDebtAmount = supplyValue.value.mul(expirationCollateralizationDenominator)
        .div(expirationCollateralizationNumerator)
        .div(usdcPrice.value);
      await vault.transferFromPositionWithOtherToken(
        otherAccountNumber,
        defaultAccountNumber,
        core.marketIds.usdc,
        usdcDebtAmount,
        BalanceCheckFlag.To,
      );

      await setExpiry(core, liquidAccountStruct, core.marketIds.usdc, 1);
      const rampTime = await core.expiry.g_expiryRampTime();
      await waitTime(rampTime.add(ONE_BI).toNumber());
      const expiry = await core.expiry.getExpiry(liquidAccountStruct, core.marketIds.usdc);
      expect(expiry).to.not.eq(0);

      const newAccountValues = await core.dolomiteMargin.getAccountValues(liquidAccountStruct);
      // check that the position is over collateralized
      expect(newAccountValues[0].value)
        .to
        .gte(newAccountValues[1].value.mul(minCollateralizationNumerator).div(minCollateralizationDenominator));

      const [heldPrice, owedPriceAdj] = await core.expiry.getSpreadAdjustedPrices(
        underlyingMarketId,
        core.marketIds.usdc,
        expiry,
      );

      const heldUpdatedWithReward = usdcDebtAmount.mul(owedPriceAdj.value).div(heldPrice.value);
      const usdcOutputAmount = await unwrapper.getExchangeCost(
        factory.address,
        core.usdc.address,
        heldUpdatedWithReward,
        BYTES_EMPTY,
      );

      const txResult = await core.liquidatorProxyV4!.connect(core.hhUser5).liquidate(
        solidAccountStruct,
        liquidAccountStruct,
        [underlyingMarketId, core.marketIds.usdc],
        [],
        [],
        [],
        expiry,
      );
      const receipt = await txResult.wait();
      console.log('\tliquidatorProxy#liquidate gas used:', receipt.gasUsed.toString());

      await expectProtocolBalance(
        core,
        solidAccountStruct.owner,
        solidAccountStruct.number,
        underlyingMarketId,
        ZERO_BI,
      );
      await expectProtocolBalanceIsGreaterThan(
        core,
        solidAccountStruct,
        core.marketIds.usdc,
        usdcOutputAmount.sub(usdcDebtAmount),
        '5',
      );
      await expectProtocolBalanceIsGreaterThan(
        core,
        liquidAccountStruct,
        underlyingMarketId,
        heldAmountWei.sub(heldUpdatedWithReward),
        '5',
      );
      await expectProtocolBalance(
        core,
        liquidAccountStruct.owner,
        liquidAccountStruct.number,
        core.marketIds.usdc,
        ZERO_BI,
      );

      await expectWalletBalance(core.liquidatorProxyV4!.address, factory, ZERO_BI);
      await expectWalletBalance(core.liquidatorProxyV4!.address, core.weth, ZERO_BI);
      await expectWalletBalanceOrDustyIfZero(
        core,
        unwrapper.address,
        core.pendleEcosystem!.ptGlpToken.address,
        ZERO_BI,
      );
      await expectWalletBalanceOrDustyIfZero(core, unwrapper.address, core.usdc.address, ZERO_BI);
    });

    it('should work when expired account is borrowing a different output token (WETH)', async () => {
      const [supplyValue, borrowValue] = await core.dolomiteMargin.getAccountValues(defaultAccountStruct);
      expect(borrowValue.value).to.eq(ZERO_BI);

      const wethPrice = await core.dolomiteMargin.getMarketPrice(core.marketIds.weth);
      const wethDebtAmount = supplyValue.value.mul(expirationCollateralizationDenominator)
        .div(expirationCollateralizationNumerator)
        .div(wethPrice.value);
      await vault.transferIntoPositionWithUnderlyingToken(defaultAccountNumber, otherAccountNumber, heldAmountWei);
      await vault.transferFromPositionWithOtherToken(
        otherAccountNumber,
        defaultAccountNumber,
        core.marketIds.weth,
        wethDebtAmount,
        BalanceCheckFlag.To,
      );

      const newAccountValues = await core.dolomiteMargin.getAccountValues(liquidAccountStruct);
      // check that the position is indeed over collateralized
      expect(newAccountValues[0].value)
        .to
        .gte(newAccountValues[1].value.mul(minCollateralizationNumerator).div(minCollateralizationDenominator));

      const rampTime = await core.expiry.g_expiryRampTime();
      await setExpiry(core, liquidAccountStruct, core.marketIds.weth, 1);
      await waitTime(rampTime.add(ONE_BI).toNumber());
      const expiry = await core.expiry.getExpiry(liquidAccountStruct, core.marketIds.weth);
      expect(expiry).to.not.eq(0);

      const [heldPrice, owedPriceAdj] = await core.expiry.getSpreadAdjustedPrices(
        underlyingMarketId,
        core.marketIds.weth,
        expiry,
      );

      const heldUpdatedWithReward = wethDebtAmount.mul(owedPriceAdj.value).div(heldPrice.value);
      const usdcOutputAmount = await unwrapper.getExchangeCost(
        factory.address,
        core.usdc.address,
        heldUpdatedWithReward,
        BYTES_EMPTY,
      );
      const { calldata: paraswapCalldata, outputAmount: wethOutputAmount } = await getCalldataForParaswap(
        usdcOutputAmount,
        core.usdc,
        6,
        wethDebtAmount,
        core.weth,
        18,
        core.hhUser5,
        core.liquidatorProxyV4!,
        core,
      );

      const txResultPromise = core.liquidatorProxyV4!.connect(core.hhUser5).liquidate(
        solidAccountStruct,
        liquidAccountStruct,
        [underlyingMarketId, core.marketIds.weth],
        [],
        [],
        [],
        expiry,
      );
      try {
        const txResult = await txResultPromise;
        const receipt = await txResult.wait();
        console.log('\tliquidatorProxy#liquidate gas used:', receipt.gasUsed.toString());
      } catch (e) {
        await expectThrow(
          txResultPromise,
          'ParaswapTraderProxyWithBackup: External call failed',
        );
        console.warn(
          '\tParaswap call failed. This can happen when mixing a mainnet data with  Skipping the rest of the test.',
        );
        return;
      }

      await expectProtocolBalance(
        core,
        solidAccountStruct.owner,
        solidAccountStruct.number,
        underlyingMarketId,
        ZERO_BI,
      );
      await expectProtocolBalance(
        core,
        solidAccountStruct.owner,
        solidAccountStruct.number,
        core.marketIds.usdc,
        ZERO_BI,
      );
      await expectProtocolBalanceIsGreaterThan(
        core,
        solidAccountStruct,
        core.marketIds.weth,
        wethOutputAmount.sub(wethDebtAmount),
        '500',
      );
      await expectProtocolBalanceIsGreaterThan(
        core,
        liquidAccountStruct,
        underlyingMarketId,
        heldAmountWei.sub(heldUpdatedWithReward),
        '10',
      );
      await expectProtocolBalance(
        core,
        liquidAccountStruct.owner,
        liquidAccountStruct.number,
        core.marketIds.weth,
        ZERO_BI,
      );

      await expectWalletBalance(
        core.liquidatorProxyV4!.address,
        core.usdc,
        ZERO_BI,
      );
      await expectWalletBalance(
        core.liquidatorProxyV4!.address,
        core.weth,
        ZERO_BI,
      );
      await expectWalletBalanceOrDustyIfZero(
        core,
        unwrapper.address,
        core.pendleEcosystem!.ptGlpToken.address,
        ZERO_BI,
      );
      await expectWalletBalanceOrDustyIfZero(core, unwrapper.address, core.usdc.address, ZERO_BI);
    });
  });

  function getParaswapTraderParam(encodedTradeData: string): IGenericTraderProxyBase.TraderParamStruct {
    return {
      traderType: GenericTraderType.ExternalLiquidity,
      makerAccountIndex: 0,
      trader: core.paraswapTrader!.address,
      tradeData: encodedTradeData,
    };
  }

  function liquidateWithDefaultUnwrapper(
    marketIdsPath: BigNumberish[],
    amountWeisPath: BigNumberish[],
    unwrapperTradeData: string,
    paraswapTraderParam: IGenericTraderProxyBase.TraderParamStruct | undefined,
    expiry: BigNumberish,
  ): Promise<TxResult> {
    const defaultUnwrapperTraderParam: TraderParamStruct = {
      traderType: GenericTraderType.IsolationModeUnwrapper,
      makerAccountIndex: 0,
      trader: unwrapper.address,
      tradeData: unwrapperTradeData,
    };

    const tradersPath = [defaultUnwrapperTraderParam];
    if (paraswapTraderParam) {
      tradersPath.push(paraswapTraderParam);
    }

    return core.liquidatorProxyV4!.connect(core.hhUser5).liquidate(
      solidAccountStruct,
      liquidAccountStruct,
      marketIdsPath,
      amountWeisPath,
      tradersPath,
      [],
      expiry,
    );
  }
});
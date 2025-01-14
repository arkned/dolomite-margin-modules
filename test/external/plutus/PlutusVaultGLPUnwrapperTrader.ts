import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import {
  IERC4626,
  IGmxRegistryV1,
  PlutusVaultGLPPriceOracle,
  PlutusVaultGLPUnwrapperTrader,
  PlutusVaultGLPWrappedTokenUserVaultFactory,
  PlutusVaultGLPWrappedTokenUserVaultV1,
  PlutusVaultGLPWrappedTokenUserVaultV1__factory,
  PlutusVaultGLPWrapperTrader,
  PlutusVaultRegistry,
} from '../../../src/types';
import { Account } from '../../../src/types/IDolomiteMargin';
import { BYTES_EMPTY, Network, ZERO_BI } from '../../../src/utils/no-deps-constants';
import { impersonate, revertToSnapshotAndCapture, snapshot } from '../../utils';
import { expectThrow } from '../../utils/assertions';
import {
  CoreProtocol,
  setupCoreProtocol,
  setupTestMarket,
  setupUSDCBalance,
  setupUserVaultProxy,
} from '../../utils/setup';
import {
  createPlutusVaultGLPPriceOracle,
  createPlutusVaultGLPUnwrapperTrader,
  createPlutusVaultGLPWrappedTokenUserVaultFactory,
  createPlutusVaultGLPWrappedTokenUserVaultV1,
  createPlutusVaultGLPWrapperTrader,
  createPlutusVaultRegistry,
} from '../../utils/wrapped-token-utils';
import { createAndSetPlutusVaultWhitelist } from './plutus-utils';

const defaultAccountNumber = '0';
const amountWei = BigNumber.from('200000000000000000000'); // $200
const otherAmountWei = BigNumber.from('10000000'); // $10

const abiCoder = ethers.utils.defaultAbiCoder;

describe('PlutusVaultGLPUnwrapperTrader', () => {
  let snapshotId: string;

  let core: CoreProtocol;
  let underlyingToken: IERC4626;
  let underlyingMarketId: BigNumber;
  let gmxRegistry: IGmxRegistryV1;
  let plutusVaultRegistry: PlutusVaultRegistry;
  let unwrapper: PlutusVaultGLPUnwrapperTrader;
  let wrapper: PlutusVaultGLPWrapperTrader;
  let factory: PlutusVaultGLPWrappedTokenUserVaultFactory;
  let vault: PlutusVaultGLPWrappedTokenUserVaultV1;
  let priceOracle: PlutusVaultGLPPriceOracle;
  let defaultAccount: Account.InfoStruct;

  let plvGlpExchangeRateNumerator: BigNumber;
  let plvGlpExchangeRateDenominator: BigNumber;

  let solidUser: SignerWithAddress;

  before(async () => {
    core = await setupCoreProtocol({
      blockNumber: 86413000,
      network: Network.ArbitrumOne,
    });
    underlyingToken = core.plutusEcosystem!.plvGlp;
    const userVaultImplementation = await createPlutusVaultGLPWrappedTokenUserVaultV1();
    gmxRegistry = core.gmxRegistry!;
    plutusVaultRegistry = await createPlutusVaultRegistry(core);
    factory = await createPlutusVaultGLPWrappedTokenUserVaultFactory(
      core,
      plutusVaultRegistry,
      underlyingToken,
      userVaultImplementation,
    );

    unwrapper = await createPlutusVaultGLPUnwrapperTrader(core, plutusVaultRegistry, factory);
    wrapper = await createPlutusVaultGLPWrapperTrader(core, plutusVaultRegistry, factory);
    priceOracle = await createPlutusVaultGLPPriceOracle(core, plutusVaultRegistry, factory, unwrapper);

    underlyingMarketId = await core.dolomiteMargin.getNumMarkets();
    await setupTestMarket(core, factory, true, priceOracle);
    await core.dolomiteMargin.ownerSetPriceOracle(underlyingMarketId, priceOracle.address);

    await factory.connect(core.governance).ownerInitialize([unwrapper.address, wrapper.address]);
    await core.dolomiteMargin.connect(core.governance).ownerSetGlobalOperator(factory.address, true);

    solidUser = core.hhUser5;

    await createAndSetPlutusVaultWhitelist(
      core,
      core.plutusEcosystem!.plvGlpFarm,
      unwrapper,
      wrapper,
      factory,
    );

    await factory.createVault(core.hhUser1.address);
    const vaultAddress = await factory.getVaultByAccount(core.hhUser1.address);
    vault = setupUserVaultProxy<PlutusVaultGLPWrappedTokenUserVaultV1>(
      vaultAddress,
      PlutusVaultGLPWrappedTokenUserVaultV1__factory,
      core.hhUser1,
    );
    defaultAccount = { owner: vault.address, number: defaultAccountNumber };

    const usdcAmount = amountWei.div(1e12).mul(8);
    await setupUSDCBalance(core, core.hhUser1, usdcAmount, core.gmxEcosystem!.glpManager);
    await core.gmxEcosystem!.glpRewardsRouter.connect(core.hhUser1)
      .mintAndStakeGlp(core.usdc.address, usdcAmount, 0, 0);
    const glpAmount = amountWei.mul(4);
    await core.plutusEcosystem!.sGlp.connect(core.hhUser1)
      .approve(core.plutusEcosystem!.plvGlpRouter.address, glpAmount);
    await core.plutusEcosystem!.plvGlpRouter.connect(core.hhUser1).deposit(glpAmount);
    await core.plutusEcosystem!.plvGlp.connect(core.hhUser1).approve(vault.address, amountWei);
    await vault.depositIntoVaultForDolomiteMargin(defaultAccountNumber, amountWei);

    expect(await underlyingToken.connect(core.hhUser1).balanceOf(vault.address)).to.eq(amountWei);
    expect((await core.dolomiteMargin.getAccountWei(defaultAccount, underlyingMarketId)).value).to.eq(amountWei);

    // account for the fee in the numerator
    plvGlpExchangeRateNumerator = (await underlyingToken.totalAssets()).mul(98).div(100);
    plvGlpExchangeRateDenominator = await underlyingToken.totalSupply();

    snapshotId = await snapshot();
  });

  beforeEach(async () => {
    snapshotId = await revertToSnapshotAndCapture(snapshotId);
  });

  describe('Actions.Call and Actions.Sell for non-liquidation', () => {
    it('should work when called with the normal conditions', async () => {
      const solidAccountId = 0;
      const liquidAccountId = 0;
      const actions = await unwrapper.createActionsForUnwrappingForLiquidation(
        solidAccountId,
        liquidAccountId,
        vault.address,
        vault.address,
        core.marketIds.usdc,
        underlyingMarketId,
        ZERO_BI,
        amountWei,
      );

      const amountOut = await unwrapper.getExchangeCost(
        factory.address,
        core.usdc.address,
        amountWei,
        BYTES_EMPTY,
      );

      await core.dolomiteMargin.ownerSetGlobalOperator(core.hhUser5.address, true);
      await core.dolomiteMargin.connect(core.hhUser5).operate(
        [defaultAccount],
        actions,
      );

      const underlyingBalanceWei = await core.dolomiteMargin.getAccountWei(defaultAccount, underlyingMarketId);
      expect(underlyingBalanceWei.value).to.eq(ZERO_BI);
      expect(await vault.underlyingBalanceOf()).to.eq(ZERO_BI);

      const otherBalanceWei = await core.dolomiteMargin.getAccountWei(defaultAccount, core.marketIds.usdc);
      expect(otherBalanceWei.sign).to.eq(true);
      expect(otherBalanceWei.value).to.eq(amountOut);
    });
  });

  describe('#exchange', () => {
    it('should fail if not called by DolomiteMargin', async () => {
      await expectThrow(
        unwrapper.connect(core.hhUser1).exchange(
          core.hhUser1.address,
          core.dolomiteMargin.address,
          core.usdc.address,
          factory.address,
          amountWei,
          BYTES_EMPTY,
        ),
        `OnlyDolomiteMargin: Only Dolomite can call function <${core.hhUser1.address.toLowerCase()}>`,
      );
    });

    it('should fail if input token is incorrect', async () => {
      const dolomiteMarginImpersonator = await impersonate(core.dolomiteMargin.address, true);
      await expectThrow(
        unwrapper.connect(dolomiteMarginImpersonator).exchange(
          core.hhUser1.address,
          core.dolomiteMargin.address,
          core.usdc.address,
          core.weth.address,
          amountWei,
          BYTES_EMPTY,
        ),
        `WrappedTokenUserVaultUnwrapper: Invalid input token <${core.weth.address.toLowerCase()}>`,
      );
    });

    it('should fail if output token is incorrect', async () => {
      const dolomiteMarginImpersonator = await impersonate(core.dolomiteMargin.address, true);
      await core.plutusEcosystem!.plvGlp.connect(core.hhUser1).transfer(unwrapper.address, amountWei);
      await expectThrow(
        unwrapper.connect(dolomiteMarginImpersonator).exchange(
          core.hhUser1.address,
          core.dolomiteMargin.address,
          core.weth.address,
          factory.address,
          amountWei,
          abiCoder.encode(['uint256'], [otherAmountWei]),
        ),
        `PlutusVaultGLPUnwrapperTrader: Invalid output token <${core.weth.address.toLowerCase()}>`,
      );
    });

    it('should fail if input amount is incorrect', async () => {
      const dolomiteMarginImpersonator = await impersonate(core.dolomiteMargin.address, true);
      await core.plutusEcosystem!.plvGlp.connect(core.hhUser1).transfer(unwrapper.address, amountWei);
      await expectThrow(
        unwrapper.connect(dolomiteMarginImpersonator).exchange(
          core.hhUser1.address,
          core.dolomiteMargin.address,
          core.usdc.address,
          factory.address,
          ZERO_BI,
          abiCoder.encode(['uint256'], [otherAmountWei]),
        ),
        'WrappedTokenUserVaultUnwrapper: Invalid input amount',
      );
    });
  });

  describe('#token', () => {
    it('should work', async () => {
      expect(await unwrapper.token()).to.eq(factory.address);
    });
  });

  describe('#outputMarketId', () => {
    it('should work', async () => {
      expect(await unwrapper.outputMarketId()).to.eq(core.marketIds.usdc);
    });
  });

  describe('#actionsLength', () => {
    it('should work', async () => {
      expect(await unwrapper.actionsLength()).to.eq(2);
    });
  });

  describe('#gmxRegistry', () => {
    it('should work', async () => {
      expect(await unwrapper.GMX_REGISTRY()).to.eq(gmxRegistry.address);
    });
  });

  describe('#plutusVaultRegistry', () => {
    it('should work', async () => {
      expect(await unwrapper.PLUTUS_VAULT_REGISTRY()).to.eq(plutusVaultRegistry.address);
    });
  });

  describe('#getExchangeCost', () => {
    it('should be greater than oracle price for $10M redemption', async () => {
      const ONE_WEI = BigNumber.from('1000000000000000000');
      const TEN_MILLION = BigNumber.from('10000000');
      const amount = ONE_WEI.mul(TEN_MILLION);
      const decimalDelta = BigNumber.from('1000000000000');
      const outputAmount = await unwrapper.getExchangeCost(factory.address, core.usdc.address, amount, BYTES_EMPTY);
      const oraclePrice = (await priceOracle.getPrice(factory.address)).value.div(decimalDelta);
      console.log('\toutputAmount', outputAmount.toString());
      console.log('\toraclePrice', oraclePrice.toString());
      // the effective price should be greater than the oracle price and less than the oracle price + 0.75%
      expect(outputAmount.div(TEN_MILLION)).to.be.gt(oraclePrice);
      expect(outputAmount.div(TEN_MILLION)).to.be.lt(oraclePrice.mul('10075').div('10000'));
    });

    it('should work normally', async () => {
      const glpAmount = amountWei.mul(plvGlpExchangeRateNumerator).div(plvGlpExchangeRateDenominator);
      const expectedAmount = await core.gmxEcosystem!.glpRewardsRouter.connect(core.hhUser1)
        .callStatic
        .unstakeAndRedeemGlp(
          core.usdc.address,
          glpAmount,
          1,
          core.hhUser1.address,
        );
      expect(await unwrapper.getExchangeCost(factory.address, core.usdc.address, amountWei, BYTES_EMPTY))
        .to
        .eq(expectedAmount);
    });

    it('should work for 10 random numbers, as long as balance is sufficient', async () => {
      for (let i = 0; i < 10; i++) {
        // create a random number from 1 to 99 and divide by 101 (making the number, at-most, slightly smaller)
        const randomNumber = BigNumber.from(Math.floor(Math.random() * 99) + 1);
        const weirdAmount = amountWei.mul(randomNumber).div(101);
        const glpAmount = weirdAmount.mul(plvGlpExchangeRateNumerator).div(plvGlpExchangeRateDenominator);
        const expectedAmount = await core.gmxEcosystem!.glpRewardsRouter.connect(core.hhUser1)
          .callStatic
          .unstakeAndRedeemGlp(
            core.usdc.address,
            glpAmount,
            1,
            core.hhUser1.address,
          );
        expect(await unwrapper.getExchangeCost(factory.address, core.usdc.address, weirdAmount, BYTES_EMPTY))
          .to
          .eq(expectedAmount);
      }
    });

    it('should fail if the input token is not dsfGLP', async () => {
      await expectThrow(
        unwrapper.getExchangeCost(core.weth.address, core.usdc.address, amountWei, BYTES_EMPTY),
        `PlutusVaultGLPUnwrapperTrader: Invalid input token <${core.weth.address.toLowerCase()}>`,
      );
    });

    it('should fail if the output token is not USDC', async () => {
      await expectThrow(
        unwrapper.getExchangeCost(factory.address, core.weth.address, amountWei, BYTES_EMPTY),
        `PlutusVaultGLPUnwrapperTrader: Invalid output token <${core.weth.address.toLowerCase()}>`,
      );
    });

    it('should fail if the desired input amount is eq to 0', async () => {
      await expectThrow(
        unwrapper.getExchangeCost(factory.address, core.usdc.address, ZERO_BI, BYTES_EMPTY),
        'PlutusVaultGLPUnwrapperTrader: Invalid desired input amount',
      );
    });
  });
});

import { expect } from 'chai';
import { BigNumber } from 'ethers';
import {
  GLPWrappedTokenUserVaultFactory,
  GLPWrappedTokenUserVaultFactory__factory,
  GLPWrappedTokenUserVaultV1,
  GLPWrappedTokenUserVaultV1__factory,
  TestGLPWrappedTokenUserVaultV1,
  TestGLPWrappedTokenUserVaultV1__factory,
} from '../../../src/types';
import { Account } from '../../../src/types/IDolomiteMargin';
import { createContractWithAbi } from '../../../src/utils/dolomite-utils';
import { MAX_UINT_256_BI, ONE_BI, ZERO_BI } from '../../../src/utils/no-deps-constants';
import { revertToSnapshotAndCapture, snapshot, waitDays } from '../../utils';
import { expectThrow } from '../../utils/assertions';
import {
  CoreProtocol,
  setupCoreProtocol,
  setupGMXBalance,
  setupTestMarket,
  setupUSDCBalance,
  setupUserVaultProxy,
} from '../../utils/setup';
import { createGmxRegistry } from '../../utils/wrapped-token-utils';

const gmxAmount = BigNumber.from('10000000000000000000'); // 10 GMX
const usdcAmount = BigNumber.from('2000000000'); // 2,000 USDC
const amountWei = BigNumber.from('1250000000000000000000'); // 1,250 GLP tokens

const esGmxAmount = BigNumber.from('10000000000000000'); // 0.01 esGMX tokens
const accountNumber = ZERO_BI;

describe('GLPWrappedTokenUserVaultV1', () => {
  let snapshotId: string;

  let core: CoreProtocol;
  let factory: GLPWrappedTokenUserVaultFactory;
  let vault: TestGLPWrappedTokenUserVaultV1;
  let underlyingMarketId: BigNumber;
  let glpAmount: BigNumber;
  let account: Account.InfoStruct;

  before(async () => {
    core = await setupCoreProtocol({
      blockNumber: 56545700,
    });
    const vaultImplementation = await createContractWithAbi<TestGLPWrappedTokenUserVaultV1>(
      TestGLPWrappedTokenUserVaultV1__factory.abi,
      TestGLPWrappedTokenUserVaultV1__factory.bytecode,
      [],
    );
    const gmxRegistry = await createGmxRegistry(core);
    factory = await createContractWithAbi<GLPWrappedTokenUserVaultFactory>(
      GLPWrappedTokenUserVaultFactory__factory.abi,
      GLPWrappedTokenUserVaultFactory__factory.bytecode,
      [
        core.weth.address,
        core.marketIds.weth,
        gmxRegistry.address,
        core.gmxEcosystem.fsGlp.address,
        core.borrowPositionProxyV2.address,
        vaultImplementation.address,
        core.dolomiteMargin.address,
      ],
    );

    underlyingMarketId = await core.dolomiteMargin.getNumMarkets();
    await core.testPriceOracle.setPrice(factory.address, '1000000000000000000');
    await setupTestMarket(core, factory, true);
    await core.dolomiteMargin.connect(core.governance).ownerSetGlobalOperator(factory.address, true);
    await factory.connect(core.governance).initialize([]);

    await factory.createVault(core.hhUser1.address);
    vault = setupUserVaultProxy<TestGLPWrappedTokenUserVaultV1>(
      await factory.getVaultByAccount(core.hhUser1.address),
      TestGLPWrappedTokenUserVaultV1__factory,
      core.hhUser1,
    );
    account = { owner: vault.address, number: accountNumber };

    await setupUSDCBalance(core.hhUser1, usdcAmount, core.gmxEcosystem.glpManager);
    await core.gmxEcosystem.glpRewardsRouter.mintAndStakeGlp(
      core.usdc.address,
      usdcAmount,
      ONE_BI,
      ONE_BI,
    );
    // use sGLP for approvals/transfers and fsGLP for checking balances
    glpAmount = await core.gmxEcosystem.fsGlp.balanceOf(core.hhUser1.address);
    await core.gmxEcosystem.sGlp.approve(vault.address, MAX_UINT_256_BI);
    await vault.depositIntoVaultForDolomiteMargin(accountNumber, amountWei);
    expect(await core.gmxEcosystem.fsGlp.connect(core.hhUser1).balanceOf(vault.address)).to.eq(amountWei);
    expect(await vault.underlyingBalanceOf()).to.eq(amountWei);

    const glpProtocolBalance = await core.dolomiteMargin.getAccountWei(account, underlyingMarketId);
    expect(glpProtocolBalance.sign).to.eq(true);
    expect(glpProtocolBalance.value).to.eq(amountWei);

    await core.gmxEcosystem.esGmxDistributor.setTokensPerInterval('10333994708994708');

    snapshotId = await snapshot();
  });

  beforeEach(async () => {
    snapshotId = await revertToSnapshotAndCapture(snapshotId);
  });

  async function doHandleRewardsWithWaitTime(daysToWait: number) {
    if (daysToWait > 0) {
      await waitDays(daysToWait);
    }
    await vault.handleRewards(true, false, true, false, true, true, false);
  }

  describe('#handleRewards', () => {
    async function setupGmxStakingAndEsGmxVesting() {
      await setupGMXBalance(core.hhUser1, gmxAmount, vault);
      await vault.stakeGmx(gmxAmount);

      expect(await core.gmxEcosystem.esGmx.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.esGmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);

      // The user has not vested any esGMX into GMX, so the balance should be 0
      expect(await core.gmxEcosystem.gmx.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);

      expect((await core.gmxEcosystem.sbfGmx.balanceOf(vault.address)).gte(gmxAmount)).to.eq(true);
      expect(await core.gmxEcosystem.sbfGmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);

      expect(await core.weth.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.weth.balanceOf(core.hhUser1.address)).to.be.eq(ZERO_BI);
    }

    it('should work when assets are claimed and not staked', async () => {
      await setupGmxStakingAndEsGmxVesting();

      await waitDays(30);
      await vault.handleRewards(true, false, true, false, true, true, false);

      expect((await core.gmxEcosystem.esGmx.balanceOf(vault.address)).gt(esGmxAmount)).to.eq(true);
      expect(await core.gmxEcosystem.esGmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);

      // The user has not vested any esGMX into GMX, so the balance should be 0
      expect(await core.gmxEcosystem.gmx.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);

      expect(await core.weth.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect((await core.weth.balanceOf(core.hhUser1.address)).gt(ZERO_BI)).to.eq(true);

      await vault.vestGlp(esGmxAmount);
      await vault.vestGmx(esGmxAmount);

      await waitDays(366);
      await vault.handleRewards(true, false, true, false, true, true, false);

      // GMX rewards should be passed along to the vault owner if they're NOT staked
      expect(await core.gmxEcosystem.gmx.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect((await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address)).gt(ZERO_BI)).to.eq(true);
    });

    it('should work when assets are claimed and staked', async () => {
      await setupGmxStakingAndEsGmxVesting();

      // Don't stake anything on the first go-around. We need the esGMX to initialize vesting
      await waitDays(30);
      await vault.handleRewards(true, false, true, false, false, true, false);

      // The user has not vested any esGMX into GMX, so the balance should be 0
      expect(await core.gmxEcosystem.gmx.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);

      expect(await core.weth.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect((await core.weth.balanceOf(core.hhUser1.address)).gt(ZERO_BI)).to.eq(true);

      const glpVestableAmount = await core.gmxEcosystem.vGlp.getMaxVestableAmount(vault.address);
      const gmxVestableAmount = await core.gmxEcosystem.vGmx.getMaxVestableAmount(vault.address);
      expect(glpVestableAmount.gt(ZERO_BI)).to.eq(true);
      expect(gmxVestableAmount.gt(ZERO_BI)).to.eq(true);

      await vault.vestGlp(glpVestableAmount);
      await vault.vestGmx(gmxVestableAmount);
      expect(await core.gmxEcosystem.esGmx.balanceOf(vault.address)).to.eq(ZERO_BI);

      const stakedGmx = await core.gmxEcosystem.vGmx.pairAmounts(vault.address);

      await waitDays(366);
      const sbfGmxBalanceBefore = await core.gmxEcosystem.sbfGmx.balanceOf(vault.address);
      await vault.handleRewards(true, true, true, true, true, true, false);
      const sbfGmxBalanceAfter = await core.gmxEcosystem.sbfGmx.balanceOf(vault.address);

      // the esGMX should have been converted to GMX and staked into sbfGMX
      expect((await core.gmxEcosystem.sbfGmx.balanceOf(vault.address)).gt(esGmxAmount.add(gmxAmount).sub(stakedGmx)))
        .to
        .eq(true);
      expect(await core.gmxEcosystem.esGmx.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.esGmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);

      // GMX rewards should be passed along to the vault as sbfGMX if they're staked
      expect(await core.gmxEcosystem.gmx.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);
      expect(sbfGmxBalanceAfter.gt(sbfGmxBalanceBefore)).to.eq(true);
    });

    it('should work when assets are claimed and not staked and deposited into Dolomite', async () => {
      await setupGmxStakingAndEsGmxVesting();

      await waitDays(30);
      await vault.handleRewards(true, false, true, false, true, true, true);

      expect((await core.gmxEcosystem.esGmx.balanceOf(vault.address)).gt(ZERO_BI)).to.eq(true);
      expect(await core.gmxEcosystem.esGmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);

      // The user has not vested any esGMX into GMX, so the balance should be 0
      expect(await core.gmxEcosystem.gmx.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);

      expect(await core.weth.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.weth.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);
      const balance2 = await core.dolomiteMargin.getAccountWei(account, underlyingMarketId);
      expect(balance2.sign).to.eq(true);
      expect(balance2.value.eq(ZERO_BI)).to.eq(false);
    });

    it('should work when assets are not claimed and not staked', async () => {
      await setupGmxStakingAndEsGmxVesting();

      await waitDays(30);
      await vault.handleRewards(false, false, false, false, false, false, false);

      expect(await core.gmxEcosystem.esGmx.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.esGmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);

      // The user has not vested any esGMX into GMX, so the balance should be 0
      expect(await core.gmxEcosystem.gmx.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);

      expect(await core.weth.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.weth.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);
      const balance2 = await core.dolomiteMargin.getAccountWei(account, core.marketIds.weth);
      expect(balance2.sign).to.eq(false);
      expect(balance2.value).to.eq(ZERO_BI);
    });

    it('should fail when not called by vault owner', async () => {
      await expectThrow(
        vault.connect(core.hhUser2).handleRewards(false, false, false, false, false, false, false),
        `WrappedTokenUserVaultV1: Only owner can call <${core.hhUser2.address.toLowerCase()}>`,
      );
    });
  });

  describe('#stakeGmx', () => {
    it('should work normally', async () => {
      await setupGMXBalance(core.hhUser1, gmxAmount, vault);
      await vault.stakeGmx(gmxAmount);
      expect(await vault.gmxBalanceOf()).to.eq(gmxAmount);
      expect(await core.gmxEcosystem.sbfGmx.balanceOf(vault.address)).to.eq(gmxAmount);
    });

    it('should fail when not called by vault owner', async () => {
      await expectThrow(
        vault.connect(core.hhUser2).stakeGmx(gmxAmount),
        `WrappedTokenUserVaultV1: Only owner can call <${core.hhUser2.address.toLowerCase()}>`,
      );
    });
  });

  describe('#unstakeGmx', () => {
    it('should work normally', async () => {
      await setupGMXBalance(core.hhUser1, gmxAmount, vault);
      await vault.stakeGmx(gmxAmount);
      await vault.unstakeGmx(gmxAmount);
      expect(await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address)).to.eq(gmxAmount);
      expect(await vault.gmxBalanceOf()).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.sbfGmx.balanceOf(vault.address)).to.eq(ZERO_BI);
    });

    it('should fail when not called by vault owner', async () => {
      await expectThrow(
        vault.connect(core.hhUser2).unstakeGmx(gmxAmount),
        `WrappedTokenUserVaultV1: Only owner can call <${core.hhUser2.address.toLowerCase()}>`,
      );
    });
  });

  describe('#stakeEsGmx', () => {
    it('should work when GMX is vesting', async () => {
      await doHandleRewardsWithWaitTime(30);

      const esGmx = core.gmxEcosystem.esGmx;
      const originalBalance = await esGmx.balanceOf(vault.address);
      await vault.stakeEsGmx(esGmxAmount);
      expect(await vault.esGmxBalanceOf()).to.eq(originalBalance);
      expect(await core.gmxEcosystem.sGmx.depositBalances(vault.address, esGmx.address)).to.eq(esGmxAmount);
      expect(await esGmx.balanceOf(vault.address)).to.eq(originalBalance.sub(esGmxAmount));
      expect(await core.gmxEcosystem.sbfGmx.balanceOf(vault.address)).to.eq(esGmxAmount);
    });

    it('should fail when not called by vault owner', async () => {
      await expectThrow(
        vault.connect(core.hhUser2).stakeEsGmx(esGmxAmount),
        `WrappedTokenUserVaultV1: Only owner can call <${core.hhUser2.address.toLowerCase()}>`,
      );
    });
  });

  describe('#unstakeEsGmx', () => {
    it('should work normally', async () => {
      await doHandleRewardsWithWaitTime(30);

      const esGmx = core.gmxEcosystem.esGmx;
      const originalBalance = await esGmx.balanceOf(vault.address);
      await vault.stakeEsGmx(esGmxAmount);

      await vault.unstakeEsGmx(esGmxAmount);
      expect(await vault.esGmxBalanceOf()).to.eq(originalBalance);
      expect(await core.gmxEcosystem.sGmx.depositBalances(vault.address, esGmx.address)).to.eq(ZERO_BI);
      expect(await esGmx.balanceOf(vault.address)).to.eq(originalBalance);
      expect(await core.gmxEcosystem.sbfGmx.balanceOf(vault.address)).to.eq(ZERO_BI);
    });

    it('should fail when not called by vault owner', async () => {
      await expectThrow(
        vault.connect(core.hhUser2).unstakeEsGmx(esGmxAmount),
        `WrappedTokenUserVaultV1: Only owner can call <${core.hhUser2.address.toLowerCase()}>`,
      );
    });
  });

  describe('#vestGlp', () => {
    it('should work normally', async () => {
      expect(await vault.getGlpAmountNeededForEsGmxVesting(esGmxAmount)).to.eq(ZERO_BI);
      await doHandleRewardsWithWaitTime(30);
      const glpAmountVested = await vault.getGlpAmountNeededForEsGmxVesting(esGmxAmount);
      await vault.vestGlp(esGmxAmount);
      const amountInVesting = await core.gmxEcosystem.vGlp.pairAmounts(vault.address);
      // the amount of GLP in the vault should be unchanged if some of it moves into vesting
      expect(amountInVesting).to.eq(glpAmountVested);
      expect(await vault.underlyingBalanceOf()).to.eq(amountWei);
      expect(await core.gmxEcosystem.fsGlp.balanceOf(vault.address)).to.eq(amountWei.sub(amountInVesting));
    });

    it('should fail when not called by vault owner', async () => {
      await expectThrow(
        vault.connect(core.hhUser2).vestGlp(esGmxAmount),
        `WrappedTokenUserVaultV1: Only owner can call <${core.hhUser2.address.toLowerCase()}>`,
      );
    });
  });

  describe('#unvestGlp', () => {
    it('should work GMX is staked', async () => {
      await doHandleRewardsWithWaitTime(30);
      await vault.vestGlp(esGmxAmount);
      await waitDays(366);
      expect(await vault.gmxBalanceOf()).to.eq(ZERO_BI);
      await vault.unvestGlp(true);
      expect((await vault.gmxBalanceOf()).eq(ZERO_BI)).to.eq(false);
      expect((await core.gmxEcosystem.sbfGmx.balanceOf(vault.address)).eq(ZERO_BI)).to.eq(false);
      expect((await core.gmxEcosystem.gmx.balanceOf(vault.address))).to.eq(ZERO_BI);
      expect((await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address))).to.eq(ZERO_BI);
    });

    it('should work GMX is withdrawn', async () => {
      await doHandleRewardsWithWaitTime(30);
      await vault.vestGlp(esGmxAmount);
      await waitDays(366);
      expect(await vault.gmxBalanceOf()).to.eq(ZERO_BI);
      await vault.unvestGlp(false);
      expect(await vault.gmxBalanceOf()).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.sbfGmx.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.gmx.balanceOf(vault.address)).to.eq(ZERO_BI);
      expect((await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address)).eq(ZERO_BI)).to.eq(false);
    });

    it('should fail when not called by vault owner', async () => {
      await expectThrow(
        vault.connect(core.hhUser2).unvestGlp(false),
        `WrappedTokenUserVaultV1: Only owner can call <${core.hhUser2.address.toLowerCase()}>`,
      );
    });
  });

  describe('#vestGmx', () => {
    it('should work normally', async () => {
      await setupGMXBalance(core.hhUser1, gmxAmount, vault);
      await vault.stakeGmx(gmxAmount);
      expect(await vault.gmxBalanceOf()).to.eq(gmxAmount);
      expect(await core.gmxEcosystem.sbfGmx.balanceOf(vault.address)).to.eq(gmxAmount);

      expect(await vault.getGmxAmountNeededForEsGmxVesting(esGmxAmount)).to.eq(ZERO_BI);
      await doHandleRewardsWithWaitTime(30);
      const gmxAmountVested = await vault.getGmxAmountNeededForEsGmxVesting(esGmxAmount);
      await vault.vestGmx(esGmxAmount);
      expect(await core.gmxEcosystem.vGmx.pairAmounts(vault.address)).to.eq(gmxAmountVested);
      // the amount of GMX in the vault should be unchanged if some of it moves into vesting
      expect(await vault.gmxBalanceOf()).to.eq(gmxAmount);
      expect((await core.gmxEcosystem.sbfGmx.balanceOf(vault.address)).gt(gmxAmount.sub(gmxAmountVested))).to.eq(true);
    });

    it('should fail when not called by vault owner', async () => {
      await expectThrow(
        vault.connect(core.hhUser2).vestGmx(esGmxAmount),
        `WrappedTokenUserVaultV1: Only owner can call <${core.hhUser2.address.toLowerCase()}>`,
      );
    });
  });

  describe('#unvestGmx', () => {
    it('should work when GMX is re-staked', async () => {
      await setupGMXBalance(core.hhUser1, gmxAmount, vault);
      await vault.stakeGmx(gmxAmount);
      expect(await vault.gmxBalanceOf()).to.eq(gmxAmount);
      expect(await core.gmxEcosystem.sbfGmx.balanceOf(vault.address)).to.eq(gmxAmount);

      await doHandleRewardsWithWaitTime(30);
      await vault.vestGmx(esGmxAmount);
      expect(await vault.gmxBalanceOf()).to.eq(gmxAmount);

      await waitDays(366);
      await vault.unvestGmx(true);

      expect(await vault.gmxBalanceOf()).to.eq(gmxAmount.add(esGmxAmount));
    });

    it('should work when vested GMX is withdrawn', async () => {
      await setupGMXBalance(core.hhUser1, gmxAmount, vault);
      await vault.stakeGmx(gmxAmount);
      expect(await vault.gmxBalanceOf()).to.eq(gmxAmount);
      expect(await core.gmxEcosystem.sbfGmx.balanceOf(vault.address)).to.eq(gmxAmount);

      await doHandleRewardsWithWaitTime(30);
      await vault.vestGmx(esGmxAmount);
      expect(await vault.gmxBalanceOf()).to.eq(gmxAmount);

      await waitDays(366);
      await vault.unvestGmx(false);

      expect(await vault.gmxBalanceOf()).to.eq(gmxAmount);
      expect(await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address)).to.eq(esGmxAmount);
    });

    it('should fail when not called by vault owner', async () => {
      await expectThrow(
        vault.connect(core.hhUser2).unvestGmx(false),
        `WrappedTokenUserVaultV1: Only owner can call <${core.hhUser2.address.toLowerCase()}>`,
      );
    });
  });

  describe('#acceptTransfer', () => {
    it('should work when the vault has had no interactions with GMX', async () => {
      await setupGMXBalance(core.hhUser1, gmxAmount, core.gmxEcosystem.sGmx);
      const usdcAmount = BigNumber.from('100000000'); // 100 USDC
      await setupUSDCBalance(core.hhUser1, usdcAmount, core.gmxEcosystem.glpManager);
      await core.gmxEcosystem.glpRewardsRouter.mintAndStakeGlp(
        core.usdc.address,
        usdcAmount,
        ONE_BI,
        ONE_BI,
      );
      await core.gmxEcosystem.gmxRewardsRouter.connect(core.hhUser1).stakeGmx(gmxAmount);
      const glpAmount = await core.gmxEcosystem.fsGlp.balanceOf(core.hhUser1.address);

      await waitDays(30);
      await core.gmxEcosystem.gmxRewardsRouter.handleRewards(true, false, true, false, true, true, true);
      const totalEsGmxAmount = await core.gmxEcosystem.esGmx.balanceOf(core.hhUser1.address);
      const depositEsGmxAmount = totalEsGmxAmount.div(2);
      const balanceEsGmxAmount = totalEsGmxAmount.sub(depositEsGmxAmount);
      await core.gmxEcosystem.gmxRewardsRouter.connect(core.hhUser1).stakeEsGmx(depositEsGmxAmount);

      const vaultAddress = await factory.connect(core.hhUser2).calculateVaultByAccount(core.hhUser2.address);
      await core.gmxEcosystem.gmxRewardsRouter.connect(core.hhUser1).signalTransfer(vaultAddress);
      await factory.createVault(core.hhUser2.address);

      const newVault = setupUserVaultProxy<GLPWrappedTokenUserVaultV1>(
        vaultAddress,
        GLPWrappedTokenUserVaultV1__factory,
        core.hhUser2,
      );
      await newVault.acceptFullAccountTransfer(core.hhUser1.address);

      expect(await core.gmxEcosystem.fsGlp.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.esGmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);
      expect(await core.gmxEcosystem.sbfGmx.balanceOf(core.hhUser1.address)).to.eq(ZERO_BI);

      expect(await core.gmxEcosystem.fsGlp.balanceOf(vaultAddress)).to.eq(glpAmount);
      expect(await core.gmxEcosystem.esGmx.balanceOf(vaultAddress)).to.eq(balanceEsGmxAmount);
      expect((await core.gmxEcosystem.sbfGmx.balanceOf(vaultAddress)).eq(ZERO_BI)).to.eq(false);
    });

    it('should fail when reentrancy is triggered in the user vault', async () => {
      await expectThrow(
        vault.callAcceptFullAccountTransferAndTriggerReentrancy(core.hhUser1.address),
        'WrappedTokenUserVaultV1: Reentrant call',
      );
    });

    it('should fail when not called by vault owner or factory', async () => {
      await expectThrow(
        vault.connect(core.hhUser2).acceptFullAccountTransfer(core.hhUser2.address),
        `WrappedTokenUserVaultV1: Only owner or factory can call <${core.hhUser2.address.toLowerCase()}>`,
      );
    });
  });

  describe('#executeDepositIntoVault', () => {
    it('should fail when not called by vault factory', async () => {
      await expectThrow(
        vault.connect(core.hhUser2).executeDepositIntoVault(core.hhUser2.address, amountWei),
        `WrappedTokenUserVaultV1: Only factory can call <${core.hhUser2.address.toLowerCase()}>`,
      );
    });
  });

  describe('#executeWithdrawalFromVault', () => {
    it('should work normally', async () => {
      await vault.withdrawFromVaultForDolomiteMargin(accountNumber, amountWei);
      expect(await vault.underlyingBalanceOf()).to.equal(ZERO_BI);
      expect(await core.gmxEcosystem.fsGlp.balanceOf(core.hhUser1.address)).to.equal(glpAmount);
    });

    it('should work when GLP needs to be un-vested', async () => {
      expect(await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address)).to.equal(ZERO_BI);
      await doHandleRewardsWithWaitTime(30);
      const esGmxAmount = await core.gmxEcosystem.esGmx.balanceOf(vault.address);
      await vault.vestGlp(esGmxAmount);
      await waitDays(366); // vest the GLP

      const glpInVesting = await core.gmxEcosystem.vGlp.pairAmounts(vault.address);
      expect(glpInVesting.eq(ZERO_BI)).to.eq(false);
      expect(await core.gmxEcosystem.fsGlp.balanceOf(vault.address)).to.eq(amountWei.sub(glpInVesting));

      await vault.withdrawFromVaultForDolomiteMargin(accountNumber, amountWei);
      expect(await vault.underlyingBalanceOf()).to.equal(ZERO_BI);
      expect(await core.gmxEcosystem.fsGlp.balanceOf(core.hhUser1.address)).to.equal(glpAmount);
      expect(await core.gmxEcosystem.gmx.balanceOf(vault.address)).to.equal(ZERO_BI);
      expect((await core.gmxEcosystem.gmx.balanceOf(core.hhUser1.address)).eq(ZERO_BI)).to.equal(false);
    });

    it('should fail when not called by vault factory', async () => {
      await expectThrow(
        vault.connect(core.hhUser2).executeWithdrawalFromVault(core.hhUser2.address, amountWei),
        `WrappedTokenUserVaultV1: Only factory can call <${core.hhUser2.address.toLowerCase()}>`,
      );
    });
  });

  describe('#gmxRewardsRouter', () => {
    it('should work normally', async () => {
      expect(await vault.gmxRewardsRouter()).to.equal(core.gmxEcosystem.gmxRewardsRouter.address);
    });
  });

  describe('#underlyingBalanceOf', () => {
    it('should work when funds are only in vault', async () => {
      expect(await vault.underlyingBalanceOf()).to.equal(amountWei);
    });

    it('should work when funds are in vault and vesting', async () => {
      await doHandleRewardsWithWaitTime(30);
      const esGmxAmount = await core.gmxEcosystem.esGmx.balanceOf(vault.address);
      await vault.vestGlp(esGmxAmount);
      expect(await vault.underlyingBalanceOf()).to.equal(amountWei); // amount should be unchanged
    });
  });

  describe('#gmxBalanceOf', () => {
    it('should work when GMX is vesting and staked', async () => {
      await setupGMXBalance(core.hhUser1, gmxAmount, vault);
      await vault.stakeGmx(gmxAmount);
      await doHandleRewardsWithWaitTime(30);
      await vault.vestGmx(esGmxAmount);
      expect(await vault.gmxBalanceOf()).to.eq(gmxAmount);
    });

    it('should work when GMX is vesting, staked, and idle', async () => {
      await setupGMXBalance(core.hhUser1, gmxAmount, vault);
      await vault.stakeGmx(gmxAmount);
      await doHandleRewardsWithWaitTime(30);
      await vault.vestGmx(esGmxAmount);
      expect(await vault.gmxBalanceOf()).to.eq(gmxAmount);
    });

    it('should work when no GMX is deposited at all', async () => {
      expect(await vault.gmxBalanceOf()).to.eq(ZERO_BI);
    });
  });
});

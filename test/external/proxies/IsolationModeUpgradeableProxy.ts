import { expect } from 'chai';
import { BaseContract } from 'ethers';
import {
  IsolationModeUpgradeableProxy,
  IsolationModeUpgradeableProxy__factory,
  TestIsolationModeFactory,
  TestIsolationModeTokenVaultV1,
  TestIsolationModeTokenVaultV1__factory,
  TestIsolationModeUnwrapperTrader__factory,
} from '../../../src/types';
import { createContractWithAbi, createTestToken } from '../../../src/utils/dolomite-utils';
import { Network } from '../../../src/utils/no-deps-constants';
import { revertToSnapshotAndCapture, snapshot } from '../../utils';
import { expectThrow } from '../../utils/assertions';
import { createTestIsolationModeFactory } from '../../utils/ecosystem-token-utils/testers';
import { CoreProtocol, setupCoreProtocol, setupTestMarket, setupUserVaultProxy } from '../../utils/setup';

describe('IsolationModeUpgradeableProxy', () => {
  let snapshotId: string;

  let core: CoreProtocol;
  let factory: TestIsolationModeFactory;
  let userVaultImplementation: BaseContract;

  let vaultProxy: IsolationModeUpgradeableProxy;

  before(async () => {
    core = await setupCoreProtocol({
      blockNumber: 53107700,
      network: Network.ArbitrumOne,
    });
    const underlyingToken = await createTestToken();
    userVaultImplementation = await createContractWithAbi(
      TestIsolationModeTokenVaultV1__factory.abi,
      TestIsolationModeTokenVaultV1__factory.bytecode,
      [],
    );
    factory = await createTestIsolationModeFactory(core, underlyingToken, userVaultImplementation);
    await core.testPriceOracle!.setPrice(
      factory.address,
      '1000000000000000000', // $1.00
    );

    await setupTestMarket(core, factory, true);

    const tokenUnwrapper = await createContractWithAbi(
      TestIsolationModeUnwrapperTrader__factory.abi,
      TestIsolationModeUnwrapperTrader__factory.bytecode,
      [core.usdc.address, factory.address, core.dolomiteMargin.address],
    );

    await factory.connect(core.governance).ownerInitialize([tokenUnwrapper.address]);
    await core.dolomiteMargin.connect(core.governance).ownerSetGlobalOperator(factory.address, true);

    await factory.createVault(core.hhUser1.address);
    const vaultAddress = await factory.getVaultByAccount(core.hhUser1.address);
    vaultProxy = await setupUserVaultProxy<IsolationModeUpgradeableProxy>(
      vaultAddress,
      IsolationModeUpgradeableProxy__factory,
      core.hhUser1,
    );

    snapshotId = await snapshot();
  });

  beforeEach(async () => {
    snapshotId = await revertToSnapshotAndCapture(snapshotId);
  });

  describe('#initialize', () => {
    it('should work under normal conditions', async () => {
      await factory.createVaultNoInitialize(core.hhUser2.address);
      const vault2Address = await factory.getVaultByAccount(core.hhUser2.address);
      const vault2 = setupUserVaultProxy<IsolationModeUpgradeableProxy>(
        vault2Address,
        IsolationModeUpgradeableProxy__factory,
        core.hhUser2,
      );
      await vault2.initialize(core.hhUser2.address);
      expect(await vault2.isInitialized()).to.eq(true);
      expect(await vault2.owner()).to.eq(core.hhUser2.address);
    });

    it('should fail if already initialized', async () => {
      await expectThrow(
        vaultProxy.initialize(core.hhUser1.address),
        'IsolationModeUpgradeableProxy: Already initialized',
      );
    });

    it('should fail if invalid account', async () => {
      await expectThrow(
        factory.createVaultWithDifferentAccount(core.hhUser2.address, core.hhUser3.address),
        `IsolationModeUpgradeableProxy: Invalid account <${core.hhUser3.address.toLowerCase()}>`,
      );
    });
  });

  describe('#fallback', () => {
    it('should work normally', async () => {
      const vaultImpl = setupUserVaultProxy<TestIsolationModeTokenVaultV1>(
        vaultProxy.address,
        TestIsolationModeTokenVaultV1__factory,
        core.hhUser1,
      );
      expect(await vaultImpl.VAULT_FACTORY()).to.eq(factory.address);
    });

    it('should fail when not initialized', async () => {
      await factory.createVaultNoInitialize(core.hhUser2.address);
      const vaultAddress = await factory.getVaultByAccount(core.hhUser2.address);
      const vaultImpl = setupUserVaultProxy<TestIsolationModeTokenVaultV1>(
        vaultAddress,
        TestIsolationModeTokenVaultV1__factory,
        core.hhUser2,
      );
      await expectThrow(vaultImpl.VAULT_FACTORY(), 'IsolationModeUpgradeableProxy: Not initialized');
    });
  });

  describe('#implementation', () => {
    it('should work normally', async () => {
      expect(await vaultProxy.implementation()).to.eq(userVaultImplementation.address);
    });
  });

  describe('#isInitialized', () => {
    it('should work normally', async () => {
      expect(await vaultProxy.isInitialized()).to.eq(true);
    });
  });

  describe('#vaultFactory', () => {
    it('should work normally', async () => {
      expect(await vaultProxy.vaultFactory()).to.eq(factory.address);
    });
  });

  describe('#owner', () => {
    it('should work normally', async () => {
      expect(await vaultProxy.owner()).to.eq(core.hhUser1.address);
    });
  });
});
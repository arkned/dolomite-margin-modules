import { address, AmountDenomination, AmountReference } from '@dolomite-margin/dist/src';
import { assert, expect } from 'chai';
import { BaseContract, BigNumber, BigNumberish, CallOverrides, ContractTransaction } from 'ethers';
import { assertHardhatInvariant } from 'hardhat/internal/core/errors';
import { ERC20, ERC20__factory } from '../../src/types';
import { AccountStruct } from '../../src/utils/constants';
import { valueStructToBigNumber } from '../../src/utils/dolomite-utils';
import { CoreProtocol } from './setup';

export function assertEqBn(a: BigNumber, b: BigNumber) {
  const msg = `${a.toString()} != ${b.toString()}`;
  assert.equal(a.eq(b), true, msg);
}

export function assertApproxEqBn(a: BigNumber, b: BigNumber, divisor: BigNumber) {
  const aBN = a.div(divisor);
  const bBN = b.div(divisor);
  const msg = `${aBN.toString()} != ${bBN.toString()}`;
  assert.equal(aBN.eq(bBN), true, msg);
}

export function assertGtBn(a: BigNumber, b: BigNumber) {
  const msg = `${a.toString()} is not greater than ${b.toString()}`;
  assert.equal(a.gt(b), true, msg);
}

export function assertGteBn(a: BigNumber, b: BigNumber) {
  const msg = `${a.toString()} is not greater than ${b.toString()}`;
  assert.equal(a.gte(b), true, msg);
}

export function assertNotEqualBn(a: BigNumber, b: BigNumber) {
  assert.equal(a.eq(b), false);
}

export async function expectThrow(call: Promise<any>, reason?: string) {
  if (reason) {
    await expect(call).to.be.revertedWith(reason);
  } else {
    await expect(call).to.be.reverted;
  }
}

export async function expectThrowBalanceFlagError(
  call: Promise<any>,
  accountOwner: { address: address },
  accountNumber: BigNumberish,
  marketId: BigNumberish,
) {
  const ownerString = accountOwner.address.toLowerCase();
  const numberString = accountNumber.toString();
  const marketString = marketId.toString();
  await expectThrow(
    call,
    `AccountBalanceLib: account cannot go negative <${ownerString}, ${numberString}, ${marketString}>`,
  );
}

export async function expectNoThrow(call: Promise<any>) {
  await expect(call).not.to.be.reverted;
}

// ========================= Balance Assertions =========================

export async function expectProtocolBalanceIsGreaterThan(
  coreProtocol: CoreProtocol,
  accountStruct: AccountStruct,
  marketId: BigNumberish,
  expectedBalance: BigNumberish,
  marginOfErrorBps: BigNumberish,
) {
  assertHardhatInvariant(BigNumber.from(marginOfErrorBps).lte(10000), 'Margin of error must be less than 10000 bps');

  const expectedBalanceWithMarginOfError = BigNumber.from(expectedBalance)
    .sub(BigNumber.from(expectedBalance).mul(marginOfErrorBps).div('10000'));
  const balance = await coreProtocol.dolomiteMargin.getAccountWei(accountStruct, marketId);
  expect(valueStructToBigNumber(balance))
    .to
    .gte(expectedBalanceWithMarginOfError);
}

const ONE_CENT = BigNumber.from('10000000000000000000000000000000000'); // $1 eq 1e36. Take off 2 decimals

export async function expectWalletBalanceOrDustyIfZero(
  coreProtocol: CoreProtocol,
  wallet: address,
  token: address,
  expectedBalance: BigNumberish,
) {
  const contract = await new BaseContract(token, ERC20__factory.createInterface()) as ERC20;
  const balance = await contract.connect(coreProtocol.hhUser1).balanceOf(wallet);
  if (!balance.eq(expectedBalance) && BigNumber.from(expectedBalance).eq('0')) {
    // check the amount is dusty then (< $0.01)
    const price = await coreProtocol.dolomiteMargin.getMarketPrice(
      await coreProtocol.dolomiteMargin.getMarketIdByTokenAddress(token),
    );
    const monetaryValue = price.value.mul(balance);
    expect(monetaryValue).to.be.lt(ONE_CENT);
  } else {
    expect(balance).to.eq(BigNumber.from(expectedBalance));
  }
}

export async function expectEvent(
  contract: BaseContract,
  contractTransaction: ContractTransaction,
  eventName: string,
  args: object,
) {
  const argsArray = Object.values(args);
  if (argsArray.length > 0) {
    await expect(contractTransaction).to.emit(contract, eventName).withArgs(...argsArray);
  } else {
    await expect(contractTransaction).to.emit(contract, eventName);
  }
}

export async function expectProtocolBalance(
  core: CoreProtocol,
  accountOwner: { address: address } | address,
  accountNumber: BigNumberish,
  marketId: BigNumberish,
  amountWei: BigNumberish,
) {
  const account = {
    owner: typeof accountOwner === 'object' ? accountOwner.address : accountOwner,
    number: accountNumber,
  };
  const rawBalanceWei = await core.dolomiteMargin.getAccountWei(account, marketId);
  const balanceWei = rawBalanceWei.sign ? rawBalanceWei.value : rawBalanceWei.value.mul(-1);
  expect(balanceWei).eq(amountWei);
}

export async function expectWalletBalance(
  accountOwner: { address: address } | address,
  token: { balanceOf(account: string, overrides?: CallOverrides): Promise<BigNumber> },
  amount: BigNumberish,
) {
  const owner = typeof accountOwner === 'object' ? accountOwner.address : accountOwner;
  expect(await token.balanceOf(owner)).eq(amount);
}

export async function expectWalletAllowance(
  accountOwner: { address: address } | address,
  accountSpender: { address: address } | address,
  token: { allowance(owner: string, spender: string, overrides?: CallOverrides): Promise<BigNumber> },
  amount: BigNumberish,
) {
  const owner = typeof accountOwner === 'object' ? accountOwner.address : accountOwner;
  const spender = typeof accountSpender === 'object' ? accountSpender.address : accountSpender;
  expect(await token.allowance(owner, spender)).eq(amount);
}

export async function expectTotalSupply(
  token: { totalSupply(overrides?: CallOverrides): Promise<BigNumber> },
  amount: BigNumberish,
) {
  expect(await token.totalSupply()).eq(amount);
}

interface AssetAmount {
  sign: boolean;
  denomination: AmountDenomination;
  ref: AmountReference;
  value: BigNumberish;
}

export function expectAssetAmountToEq(
  found: AssetAmount,
  expected: AssetAmount,
) {
  expect(found.sign).eq(expected.sign);
  expect(found.denomination).eq(expected.denomination);
  expect(found.ref).eq(expected.ref);
  expect(found.value).eq(expected.value);
}
import { address } from '@dolomite-exchange/dolomite-margin';
import {
  GLPUnwrapperProxyV1,
  GLPUnwrapperProxyV1__factory, GLPWrapperProxyV1, GLPWrapperProxyV1__factory,
  TestWrappedTokenUserVaultFactory,
  TestWrappedTokenUserVaultFactory__factory,
} from '../../src/types';
import { BORROW_POSITION_PROXY_V2, DOLOMITE_MARGIN, USDC } from '../../src/utils/constants';
import { createContractWithAbi } from '../../src/utils/dolomite-utils';

export async function createTestWrappedTokenFactory(
  underlyingToken: { address: address },
  userVaultImplementation: { address: address },
): Promise<TestWrappedTokenUserVaultFactory> {
  return await createContractWithAbi<TestWrappedTokenUserVaultFactory>(
    TestWrappedTokenUserVaultFactory__factory.abi,
    TestWrappedTokenUserVaultFactory__factory.bytecode,
    [
      underlyingToken.address,
      BORROW_POSITION_PROXY_V2.address,
      userVaultImplementation.address,
      DOLOMITE_MARGIN.address,
    ],
  );
}

export async function createGlpUnwrapperProxy(
  dfsGlp: { address: address },
  gmxRegistry: { address: address },
): Promise<GLPUnwrapperProxyV1> {
  return createContractWithAbi<GLPUnwrapperProxyV1>(
    GLPUnwrapperProxyV1__factory.abi,
    GLPUnwrapperProxyV1__factory.bytecode,
    [
      USDC.address,
      gmxRegistry.address,
      dfsGlp.address,
      DOLOMITE_MARGIN.address,
    ],
  );
}

export async function createGlpWrapperProxy(
  dfsGlp: { address: address },
  gmxRegistry: { address: address },
): Promise<GLPWrapperProxyV1> {
  return createContractWithAbi<GLPWrapperProxyV1>(
    GLPWrapperProxyV1__factory.abi,
    GLPWrapperProxyV1__factory.bytecode,
    [
      USDC.address,
      gmxRegistry.address,
      dfsGlp.address,
      DOLOMITE_MARGIN.address,
    ],
  );
}

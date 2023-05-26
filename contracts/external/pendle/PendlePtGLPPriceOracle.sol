// SPDX-License-Identifier: GPL-3.0-or-later
/*

    Copyright 2023 Dolomite

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.

*/

pragma solidity ^0.8.9;

import { IDolomiteMargin } from "../../protocol/interfaces/IDolomiteMargin.sol";
import { IDolomitePriceOracle } from "../../protocol/interfaces/IDolomitePriceOracle.sol";
import { IDolomiteStructs } from "../../protocol/interfaces/IDolomiteStructs.sol";

import { Require } from "../../protocol/lib/Require.sol";

import { IPendlePtOracle } from "../interfaces/IPendlePtOracle.sol";


/**
 * @title   PendlePtGLPPriceOracle
 * @author  Dolomite
 *
 * @notice  An implementation of the IDolomitePriceOracle interface that gets Abra's MagicGLP price in USD terms.
 */
contract PendlePtGLPPriceOracle is IDolomitePriceOracle {

    // ============================ Constants ============================

    bytes32 private constant _FILE = "PendlePtGLPPriceOracle";
    uint256 public constant TWAP_DURATION = 900; // 15 minutes

    // ============================ Public State Variables ============================

    IDolomiteMargin immutable public DOLOMITE_MARGIN; // solhint-disable-line var-name-mixedcase
    address immutable public ptGLP; // solhint-disable-line var-name-mixedcase
    uint256 immutable public DFS_GLP_MARKET_ID; // solhint-disable-line var-name-mixedcase

    // ============================ Constructor ============================

    constructor(
        address _ptOracle,
        address _dolomiteMargin,
        address _ptGlp,
        uint256 _dfsGlpMarketId
    ) {
        DOLOMITE_MARGIN = IDolomiteMargin(_dolomiteMargin);
        ptGLP = _ptGlp;
        DFS_GLP_MARKET_ID = _dfsGlpMarketId;

        (
            bool increaseCardinalityRequired,,
            bool oldestObservationSatisfied
        ) = IPendlePtOracle(_ptOracle).getOracleState(market, twapDuration);

        Require.that(
            !increaseCardinalityRequired && oldestObservationSatisfied,
            _FILE,
            "Oracle not ready yet"
        );
    }

    function getPrice(
        address _token
    )
    public
    view
    returns (IDolomiteStructs.MonetaryPrice memory) {
        Require.that(
            _token == address(ptGLP),
            _FILE,
            "invalid token",
            _token
        );
        Require.that(
            DOLOMITE_MARGIN.getMarketIsClosing(DOLOMITE_MARGIN.getMarketIdByTokenAddress(_token)),
            _FILE,
            "ptGLP cannot be borrowable"
        );

        return IDolomiteStructs.MonetaryPrice({
            value: _getCurrentPrice()
        });
    }

    // ============================ Internal Functions ============================

    function _getCurrentPrice() internal view returns (uint256) {
        uint256 glpPrice = DOLOMITE_MARGIN.getMarketPrice(DFS_GLP_MARKET_ID).value;
        uint256 totalSupply = ptGLP.totalSupply();
        if (totalSupply == 0) {
            // exchange rate is 1 if the total supply is 0
            return glpPrice;
        }
        return glpPrice * ptGLP.totalAssets() / totalSupply;
    }
}

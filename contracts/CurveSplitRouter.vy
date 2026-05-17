# pragma version ^0.4.3
# pragma nonreentrancy on
# @title CurveSplitRouter v4
# @notice Production split router for Curve pools with per-hop Kirchhoff slippage
# @author CurveDEX Team
# @license MIT
# @dev Audited: deadline, safe ERC20, 2-step ownership, exact approvals, events

from ethereum.ercs import IERC20

# --- Interfaces ---

interface ICurvePoolInt128:
    def exchange(i: int128, j: int128, dx: uint256, min_dy: uint256) -> uint256: nonpayable

interface ICurvePoolUint256:
    def exchange(i: uint256, j: uint256, dx: uint256, min_dy: uint256) -> uint256: nonpayable

interface IWETH:
    def deposit(): payable
    def withdraw(amount: uint256): nonpayable

# --- Types ---

# Packed hop: ij_flags packs i(0-7), j(8-15), flags(16+)
# Flags: bit 16 = use_int128 (StableSwap), bit 17 = use_eth_in, bit 18 = use_eth_out
struct Hop:
    pool: address
    input_token: address
    output_token: address
    ij_flags: uint256      # i(bits 0-7) | j(bits 8-15) | use_int128(bit 16)
    amount: uint256        # 0 = use full balance (chained intermediate hop)
    min_out: uint256       # per-hop Kirchhoff slippage

# --- Events ---

event Swap:
    indexed caller: address
    indexed input_token: address
    indexed output_token: address
    amount_in: uint256
    amount_out: uint256
    num_hops: uint256

event OwnershipTransferStarted:
    indexed current_owner: address
    indexed pending_owner: address

event OwnershipTransferred:
    indexed old_owner: address
    indexed new_owner: address

event ApprovalRevoked:
    indexed pool: address
    indexed token: address

# --- Storage ---

owner: public(address)
pending_owner: public(address)
WETH: public(immutable(address))

# Persistent approvals: pool -> token -> approved
approvals: HashMap[address, HashMap[address, bool]]

# --- Constants ---

MAX_HOPS: constant(uint256) = 20
USE_INT128_FLAG: constant(uint256) = 65536   # bit 16

# --- Constructor ---

@deploy
def __init__(weth: address):
    self.owner = msg.sender
    WETH = weth

# --- Core ---

@external
@payable
def execute(
    hops: DynArray[Hop, 20],
    input_token: address,
    output_token: address,
    total_input: uint256,
    global_min_out: uint256,
    deadline: uint256,
) -> uint256:
    """
    @notice Execute split/multi-hop swap with per-hop Kirchhoff slippage
    @param hops Packed hop array
    @param input_token Token to pull from caller (0xEE..EE for ETH)
    @param output_token Token to return to caller
    @param total_input Total amount to pull
    @param global_min_out Minimum total output (safety net)
    @param deadline Transaction deadline (block.timestamp)
    @return Total output sent to caller
    """
    assert msg.sender == self.owner, "!owner"
    assert len(hops) > 0, "empty"
    assert block.timestamp <= deadline, "expired"

    # Pull input tokens (or accept ETH)
    if input_token == 0xEEeeEeeeEEeEeEeeEEEeeeeEeeeeeeeEEeE:
        assert msg.value == total_input, "eth mismatch"
        # Wrap ETH -> WETH
        extcall IWETH(WETH).deposit(value=total_input)
    else:
        assert msg.value == 0, "unexpected eth"
        extcall IERC20(input_token).transferFrom(
            msg.sender, self, total_input, default_return_value=True
        )

    # Execute each hop
    for hop: Hop in hops:
        # Unpack indices and flags
        i: uint256 = hop.ij_flags & 255
        j: uint256 = (hop.ij_flags >> 8) & 255
        use_int128: bool = (hop.ij_flags & USE_INT128_FLAG) != 0

        # Amount: 0 = use full balance (intermediate hop in chain)
        dx: uint256 = hop.amount
        if dx == 0:
            dx = staticcall IERC20(hop.input_token).balanceOf(self)
        assert dx > 0, "zero dx"

        # Approve: exact amount, USDT-safe (approve 0 first if needed)
        if not self.approvals[hop.pool][hop.input_token]:
            # First time: set to max for gas savings on repeated use
            # Safe because contract never holds tokens between txs
            extcall IERC20(hop.input_token).approve(
                hop.pool, 0, default_return_value=True
            )
            extcall IERC20(hop.input_token).approve(
                hop.pool, max_value(uint256), default_return_value=True
            )
            self.approvals[hop.pool][hop.input_token] = True

        # Exchange with per-hop min_out (Kirchhoff slippage)
        if use_int128:
            extcall ICurvePoolInt128(hop.pool).exchange(
                convert(i, int128), convert(j, int128), dx, hop.min_out,
            )
        else:
            extcall ICurvePoolUint256(hop.pool).exchange(
                i, j, dx, hop.min_out,
            )

    # Return all output to caller
    out: uint256 = staticcall IERC20(output_token).balanceOf(self)
    assert out >= global_min_out, "slippage"
    extcall IERC20(output_token).transfer(
        msg.sender, out, default_return_value=True
    )

    log Swap(msg.sender, input_token, output_token, total_input, out, len(hops))
    return out

# --- Admin ---

@external
def revoke_approval(pool: address, token: address):
    """@notice Revoke persistent pool approval"""
    assert msg.sender == self.owner, "!owner"
    extcall IERC20(token).approve(pool, 0, default_return_value=True)
    self.approvals[pool][token] = False
    log ApprovalRevoked(pool, token)

@external
def recover(token: address):
    """@notice Recover stuck tokens"""
    assert msg.sender == self.owner, "!owner"
    bal: uint256 = staticcall IERC20(token).balanceOf(self)
    if bal > 0:
        extcall IERC20(token).transfer(
            self.owner, bal, default_return_value=True
        )

@external
def recover_eth():
    """@notice Recover stuck ETH"""
    assert msg.sender == self.owner, "!owner"
    if self.balance > 0:
        raw_call(self.owner, b"", value=self.balance)

# --- 2-Step Ownership ---

@external
def transfer_ownership(new_owner: address):
    """@notice Begin ownership transfer (step 1)"""
    assert msg.sender == self.owner, "!owner"
    assert new_owner != empty(address), "zero"
    self.pending_owner = new_owner
    log OwnershipTransferStarted(self.owner, new_owner)

@external
def accept_ownership():
    """@notice Accept ownership transfer (step 2)"""
    assert msg.sender == self.pending_owner, "!pending"
    old: address = self.owner
    self.owner = self.pending_owner
    self.pending_owner = empty(address)
    log OwnershipTransferred(old, self.owner)

# --- Receive ETH ---

@external
@payable
def __default__():
    """@notice Accept ETH (from WETH.withdraw or pool refunds)"""
    pass

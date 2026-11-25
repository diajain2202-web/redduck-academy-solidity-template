// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Token is IERC20 {
    // ─── Errors ───────────────────────────────────────────────
    error InsufficientBalance();
    error InsufficientAllowance();
    error TransferToZeroAddress();
    error ApproveToZeroAddress();

    // ─── Storage ──────────────────────────────────────────────
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    // ─── Constructor ──────────────────────────────────────────
    constructor(string memory name_, string memory symbol_, uint256 initialSupply) {
        name = name_;
        symbol = symbol_;
        _totalSupply = initialSupply;
        _balances[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    // ─── View Functions ───────────────────────────────────────
    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    // ─── External Functions ───────────────────────────────────
    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) {
            revert ApproveToZeroAddress();
        }
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 currentAllowance = _allowances[from][msg.sender];
        if (currentAllowance < value) {
            revert InsufficientAllowance();
        }
        if (currentAllowance != type(uint256).max) {
            unchecked {
                _allowances[from][msg.sender] = currentAllowance - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    // ─── Internal Helpers ─────────────────────────────────────
    function _transfer(address from, address to, uint256 value) internal {
        if (to == address(0)) {
            revert TransferToZeroAddress();
        }
        uint256 fromBalance = _balances[from];
        if (fromBalance < value) {
            revert InsufficientBalance();
        }
        unchecked {
            _balances[from] = fromBalance - value;
        }
        _balances[to] += value;
        emit Transfer(from, to, value);
    }
}
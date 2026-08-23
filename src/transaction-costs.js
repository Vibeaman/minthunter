function calculateTransactionCosts({ mintCost, gasLimit, gasPrice, serviceFee = 0n }) {
  for (const [name, value] of Object.entries({ mintCost, gasLimit, gasPrice, serviceFee })) {
    if (typeof value !== 'bigint' || value < 0n) {
      throw new TypeError(`${name} must be a non-negative bigint`)
    }
  }

  const gasCost = gasLimit * gasPrice

  return {
    gasCost,
    totalCost: mintCost + gasCost + serviceFee,
  }
}

module.exports = { calculateTransactionCosts }

#!/usr/bin/env node

/**
 * Read-only FCFS benchmark for Railway.
 *
 * This script deliberately performs no signing, transaction submission, or wallet
 * access. It measures configured RPC read latency and, when explicitly configured,
 * the real-contract estimateGas + eth_call preparation path.
 */

const fs = require('node:fs')
const path = require('node:path')
const { ethers } = require('ethers')

require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const DEFAULT_ITERATIONS = 30
const DEFAULT_TIMEOUT_MS = 8_000
const MAX_ITERATIONS = 1_000
const MAX_TIMEOUT_MS = 30_000

function printHelp() {
  console.log(`MintHunter read-only FCFS benchmark

Usage:
  node scripts/benchmark-fcfs.js [--json] [--smoke]

Environment:
  BENCHMARK_ITERATIONS=30             Number of samples per operation
  BENCHMARK_TIMEOUT_MS=8000           Per-RPC operation timeout
  BENCHMARK_INCLUDE_FLASHBOTS=false   Include FLASHBOTS_RPC in read-only tests
  BENCHMARK_CONTRACT_ADDRESS=         Optional real contract for dry-run tests
  BENCHMARK_MINT_DATA=                Optional verified calldata for dry-run tests
  BENCHMARK_FROM_ADDRESS=             Optional sender address; no private key needed
  BENCHMARK_VALUE_ETH=0               Optional ETH value for the dry-run transaction
  BENCHMARK_OUTPUT_FILE=              Optional path for the JSON report

The script uses only read-only RPC methods. It never signs or submits a transaction.
`)
}

function parsePositiveInteger(value, fallback, maximum) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Expected an integer from 1 to ${maximum}, received: ${value}`)
  }
  return parsed
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function monotonicMilliseconds() {
  return Number(process.hrtime.bigint()) / 1_000_000
}

function safeError(error) {
  const raw = error?.shortMessage || error?.reason || error?.message || String(error)
  return String(raw)
    .replace(/https?:\/\/\S+/gi, '[endpoint-redacted]')
    .replace(/0x[a-f0-9]{8,}/gi, '[hex-redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 180)
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return Number(sorted[index].toFixed(2))
}

function summarize(samples) {
  const successful = samples.filter((sample) => sample.ok)
  const durations = successful.map((sample) => sample.durationMs)
  const failures = samples.filter((sample) => !sample.ok)
  const errorCounts = {}

  for (const sample of failures) {
    const key = sample.error || 'unknown error'
    errorCounts[key] = (errorCounts[key] || 0) + 1
  }

  return {
    samples: samples.length,
    successful: successful.length,
    failed: failures.length,
    successRate: samples.length === 0 ? null : Number((successful.length / samples.length).toFixed(4)),
    minMs: durations.length ? Number(Math.min(...durations).toFixed(2)) : null,
    meanMs: durations.length
      ? Number((durations.reduce((sum, duration) => sum + duration, 0) / durations.length).toFixed(2))
      : null,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: durations.length ? Number(Math.max(...durations).toFixed(2)) : null,
    errors: errorCounts,
  }
}

async function withTimeout(task, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`RPC timeout after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function measureValue(task, timeoutMs) {
  const startedAt = monotonicMilliseconds()
  try {
    const value = await withTimeout(task, timeoutMs)
    return {
      ok: true,
      durationMs: Number((monotonicMilliseconds() - startedAt).toFixed(2)),
      value,
    }
  } catch (error) {
    return {
      ok: false,
      durationMs: Number((monotonicMilliseconds() - startedAt).toFixed(2)),
      error: safeError(error),
    }
  }
}

async function measure(task, timeoutMs) {
  const result = await measureValue(task, timeoutMs)
  const { value: ignored, ...sample } = result
  return sample
}

function addOperationSample(endpoint, operation, sample) {
  if (!endpoint.operations[operation]) endpoint.operations[operation] = []
  endpoint.operations[operation].push(sample)
}

function operationSummaries(endpoint) {
  return Object.fromEntries(
    Object.entries(endpoint.operations).map(([operation, samples]) => [operation, summarize(samples)]),
  )
}

function buildEndpoints(includeFlashbots) {
  const endpoints = [
    ['alchemy', process.env.ALCHEMY_RPC],
    ['infura', process.env.INFURA_RPC],
    ['quicknode', process.env.QUICKNODE_RPC],
  ]

  for (const [index, url] of (process.env.BROADCAST_RPCS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .entries()) {
    endpoints.push([`broadcast-rpc-${index + 1}`, url])
  }

  if (includeFlashbots && process.env.FLASHBOTS_RPC) {
    endpoints.push(['flashbots', process.env.FLASHBOTS_RPC.trim()])
  }

  const seen = new Set()
  return endpoints
    .filter(([, url]) => url)
    .filter(([, url]) => {
      if (seen.has(url)) return false
      seen.add(url)
      return true
    })
    .map(([label, url]) => ({ label, url }))
}

function parseContractConfig() {
  const contractAddress = process.env.BENCHMARK_CONTRACT_ADDRESS?.trim() || null
  const mintData = process.env.BENCHMARK_MINT_DATA?.trim() || null
  const fromAddress = process.env.BENCHMARK_FROM_ADDRESS?.trim() || null

  if (contractAddress && !ethers.isAddress(contractAddress)) {
    throw new Error('BENCHMARK_CONTRACT_ADDRESS must be a valid Ethereum address')
  }
  if (fromAddress && !ethers.isAddress(fromAddress)) {
    throw new Error('BENCHMARK_FROM_ADDRESS must be a valid Ethereum address')
  }
  if ((contractAddress && !mintData) || (!contractAddress && mintData)) {
    throw new Error('BENCHMARK_CONTRACT_ADDRESS and BENCHMARK_MINT_DATA must be provided together')
  }
  if (mintData && !/^0x[0-9a-f]*$/i.test(mintData) || (mintData && mintData.length < 10)) {
    throw new Error('BENCHMARK_MINT_DATA must be valid hexadecimal calldata')
  }

  let valueWei = 0n
  if (process.env.BENCHMARK_VALUE_ETH !== undefined && process.env.BENCHMARK_VALUE_ETH !== '') {
    try {
      valueWei = ethers.parseEther(process.env.BENCHMARK_VALUE_ETH)
    } catch {
      throw new Error('BENCHMARK_VALUE_ETH must be a valid non-negative ETH amount')
    }
    if (valueWei < 0n) throw new Error('BENCHMARK_VALUE_ETH cannot be negative')
  }

  return {
    enabled: Boolean(contractAddress && mintData),
    contractAddress,
    mintData,
    fromAddress,
    valueWei,
  }
}

function buildDryRunTransaction(contractConfig) {
  if (!contractConfig.enabled) return null
  const transaction = {
    to: contractConfig.contractAddress,
    data: contractConfig.mintData,
    value: contractConfig.valueWei,
  }
  if (contractConfig.fromAddress) transaction.from = contractConfig.fromAddress
  return transaction
}

async function benchmarkEndpoint(endpointConfig, iterations, timeoutMs, contractConfig) {
  // Require the endpoint to answer the chain-ID request; do not trust static metadata.
  const provider = new ethers.JsonRpcProvider(endpointConfig.url)
  const endpoint = {
    label: endpointConfig.label,
    status: 'unavailable',
    chainId: null,
    operations: {},
  }

  const network = await measureValue(() => provider.getNetwork(), timeoutMs)
  const networkSample = { ok: network.ok, durationMs: network.durationMs }
  if (network.error) networkSample.error = network.error
  addOperationSample(endpoint, 'network', networkSample)

  if (!network.ok) {
    endpoint.error = network.error
    return { endpoint, provider: null }
  }

  // This single network read both supplies the latency sample and prevents
  // accidentally benchmarking a non-mainnet endpoint.
  const detectedNetwork = network.value
  endpoint.chainId = detectedNetwork.chainId.toString()
  if (detectedNetwork.chainId !== 1n) {
    endpoint.status = 'non-mainnet'
    endpoint.error = 'Configured endpoint is not Ethereum mainnet'
    return { endpoint, provider: null }
  }

  endpoint.status = 'healthy'
  const probeAddress = contractConfig.fromAddress || ethers.ZeroAddress
  const dryRunTransaction = buildDryRunTransaction(contractConfig)

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    addOperationSample(endpoint, 'block-number', await measure(
      () => provider.getBlockNumber(),
      timeoutMs,
    ))

    const prefetchStartedAt = monotonicMilliseconds()
    const [balance, nonce, feeData] = await Promise.all([
      measure(() => provider.getBalance(probeAddress), timeoutMs),
      measure(() => provider.getTransactionCount(probeAddress, 'pending'), timeoutMs),
      measure(() => provider.getFeeData(), timeoutMs),
    ])
    const prefetchDuration = {
      ok: balance.ok && nonce.ok && feeData.ok,
      durationMs: Number((monotonicMilliseconds() - prefetchStartedAt).toFixed(2)),
    }
    if (!prefetchDuration.ok) {
      const failedRead = [balance, nonce, feeData].find((result) => !result.ok)
      prefetchDuration.error = failedRead?.error || 'one or more prefetch reads failed'
    }

    addOperationSample(endpoint, 'balance', balance)
    addOperationSample(endpoint, 'pending-nonce', nonce)
    addOperationSample(endpoint, 'fee-data', feeData)
    addOperationSample(endpoint, 'parallel-prefetch', prefetchDuration)

    if (dryRunTransaction) {
      const simulationStartedAt = monotonicMilliseconds()
      const [estimateGas, ethCall] = await Promise.all([
        measure(() => provider.estimateGas(dryRunTransaction), timeoutMs),
        measure(() => provider.call(dryRunTransaction), timeoutMs),
      ])
      const simulationDuration = {
        ok: estimateGas.ok && ethCall.ok,
        durationMs: Number((monotonicMilliseconds() - simulationStartedAt).toFixed(2)),
      }
      if (!simulationDuration.ok) {
        const failedSimulation = [estimateGas, ethCall].find((result) => !result.ok)
        simulationDuration.error = failedSimulation?.error || 'gas estimation or eth_call failed'
      }
      addOperationSample(endpoint, 'estimate-gas', estimateGas)
      addOperationSample(endpoint, 'eth-call', ethCall)
      addOperationSample(endpoint, 'parallel-simulation', simulationDuration)
    }
  }

  endpoint.summaries = operationSummaries(endpoint)
  return { endpoint, provider }
}

async function benchmarkProviderRace(activeProviders, iterations, timeoutMs) {
  const samples = []
  const winners = {}

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = monotonicMilliseconds()
    const attempts = activeProviders.map(({ label, provider }) => (
      withTimeout(() => provider.getBlockNumber(), timeoutMs).then(() => ({ label }))
    ))

    try {
      const winner = await Promise.any(attempts)
      const durationMs = Number((monotonicMilliseconds() - startedAt).toFixed(2))
      samples.push({ ok: true, durationMs, winner: winner.label })
      winners[winner.label] = (winners[winner.label] || 0) + 1
    } catch (error) {
      samples.push({
        ok: false,
        durationMs: Number((monotonicMilliseconds() - startedAt).toFixed(2)),
        error: safeError(error),
      })
    }
  }

  return {
    summary: summarize(samples),
    winners,
  }
}

function printHumanReport(report) {
  console.log('\nMintHunter FCFS benchmark')
  console.log('=========================')
  console.log(`Read-only mode: YES`)
  console.log(`Transaction submission attempted: NO`)
  console.log(`Iterations per operation: ${report.iterations}`)
  console.log(`RPC timeout: ${report.timeoutMs}ms`)
  console.log(`Contract dry run: ${report.contractDryRun.enabled ? 'enabled' : 'not configured'}`)
  console.log('')

  console.log('Endpoint results')
  for (const endpoint of report.endpoints) {
    const block = endpoint.summaries?.['block-number']
    const prefetch = endpoint.summaries?.['parallel-prefetch']
    const simulation = endpoint.summaries?.['parallel-simulation']
    const blockText = block ? `block p50/p95 ${block.p50Ms ?? '-'} / ${block.p95Ms ?? '-'}ms` : 'block unavailable'
    const prefetchText = prefetch ? `prefetch p50/p95 ${prefetch.p50Ms ?? '-'} / ${prefetch.p95Ms ?? '-'}ms` : ''
    const simulationText = simulation
      ? `simulation p50/p95 ${simulation.p50Ms ?? '-'} / ${simulation.p95Ms ?? '-'}ms`
      : ''
    console.log(`  ${endpoint.label}: ${endpoint.status} | ${blockText} | ${prefetchText}${simulationText ? ` | ${simulationText}` : ''}`)
  }

  if (report.race) {
    console.log('')
    console.log(`Fastest-provider race: p50/p95 ${report.race.summary.p50Ms ?? '-'} / ${report.race.summary.p95Ms ?? '-'}ms`)
    console.log(`Race winners: ${Object.entries(report.race.winners).map(([label, count]) => `${label}=${count}`).join(', ') || 'none'}`)
  }

  if (report.outputFile) console.log(`\nJSON report written to: ${report.outputFile}`)
}

async function main() {
  const args = new Set(process.argv.slice(2))
  if (args.has('--help') || args.has('-h')) {
    printHelp()
    return
  }

  const iterations = args.has('--smoke')
    ? 1
    : parsePositiveInteger(process.env.BENCHMARK_ITERATIONS, DEFAULT_ITERATIONS, MAX_ITERATIONS)
  const timeoutMs = parsePositiveInteger(process.env.BENCHMARK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const includeFlashbots = parseBoolean(process.env.BENCHMARK_INCLUDE_FLASHBOTS, false)
  const endpointConfigs = buildEndpoints(includeFlashbots)
  if (endpointConfigs.length === 0) {
    throw new Error('No RPC endpoints configured. Set ALCHEMY_RPC, INFURA_RPC, QUICKNODE_RPC, or BROADCAST_RPCS.')
  }

  const contractConfig = parseContractConfig()
  const startedAt = new Date().toISOString()
  const endpointResults = await Promise.all(
    endpointConfigs.map(async (endpointConfig) => {
      try {
        return await benchmarkEndpoint(endpointConfig, iterations, timeoutMs, contractConfig)
      } catch (error) {
        return {
          endpoint: {
            label: endpointConfig.label,
            status: 'error',
            chainId: null,
            operations: {},
            error: safeError(error),
          },
          provider: null,
        }
      }
    }),
  )
  const healthyProviders = endpointResults
    .filter(({ endpoint, provider }) => endpoint.status === 'healthy' && provider)
    .map(({ endpoint, provider }) => ({ label: endpoint.label, provider }))

  const report = {
    generatedAt: new Date().toISOString(),
    startedAt,
    durationMs: null,
    readOnly: true,
    transactionSubmissionAttempted: false,
    iterations,
    timeoutMs,
    endpoints: endpointResults.map(({ endpoint }) => endpoint),
    contractDryRun: {
      enabled: contractConfig.enabled,
      contractAddress: contractConfig.contractAddress,
      fromAddress: contractConfig.fromAddress,
      valueEth: ethers.formatEther(contractConfig.valueWei),
      calldataBytes: contractConfig.mintData ? (contractConfig.mintData.length - 2) / 2 : 0,
    },
    race: null,
    outputFile: process.env.BENCHMARK_OUTPUT_FILE || null,
  }

  if (healthyProviders.length > 0) {
    report.race = await benchmarkProviderRace(healthyProviders, iterations, timeoutMs)
  }

  report.durationMs = Number((new Date(report.generatedAt).getTime() - new Date(startedAt).getTime()).toFixed(2))
  if (report.outputFile) {
    const outputPath = path.resolve(report.outputFile)
    report.outputFile = outputPath
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  }

  if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printHumanReport(report)
  }

  if (healthyProviders.length === 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`Benchmark failed: ${safeError(error)}`)
  process.exitCode = 1
})

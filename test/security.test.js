const assert = require('node:assert/strict')
const test = require('node:test')

process.env.ENCRYPTION_KEY = '11'.repeat(32)

const { encryptPrivateKey, decryptPrivateKey } = require('../src/crypto')
const {
  normalizeAccessCode,
  parseCallbackId,
  parseEthAmount,
  parseUtcDateTime,
  validateAddress,
  validatePrivateKey,
} = require('../src/security')
const { buildMintData } = require('../src/services/contract')

const privateKey = `0x${'22'.repeat(32)}`
const walletAddress = validatePrivateKey(privateKey).address

test('strict access-code and callback parsing', () => {
  assert.equal(normalizeAccessCode(' mh-13cfc7 '), 'MH-13CFC7')
  assert.equal(normalizeAccessCode('MH-123'), null)
  assert.equal(parseCallbackId('mint_execute_42', 'mint_execute_'), 42)
  assert.equal(parseCallbackId('mint_execute_x', 'mint_execute_'), null)
})

test('strict ETH and UTC date parsing', () => {
  assert.equal(parseEthAmount('0.05').text, '0.05')
  assert.equal(parseEthAmount('0.05ETH'), null)
  assert.equal(parseEthAmount('-1'), null)
  assert.equal(parseUtcDateTime('2027-05-07 12:00').toISOString(), '2027-05-07T12:00:00.000Z')
  assert.equal(parseUtcDateTime('2027-02-30 12:00'), null)
})

test('private keys validate and encryption is salt-bound', () => {
  assert.equal(validatePrivateKey(privateKey).address, walletAddress)
  assert.equal(validatePrivateKey('0x1234'), null)
  const encrypted = encryptPrivateKey(privateKey, '123')
  assert.match(encrypted, /^v2:/)
  assert.equal(decryptPrivateKey(encrypted, '123'), privateKey)
  assert.throws(() => decryptPrivateKey(encrypted, '456'))
})

test('calldata builder supports simple quantity mints', () => {
  const data = buildMintData({
    name: 'mint',
    signature: 'mint(uint256)',
    inputs: [{ name: 'quantity', type: 'uint256' }],
  }, 1, walletAddress)
  assert.match(data, /^0x[0-9a-f]+$/)
})

test('calldata builder rejects unsupported proof arguments', () => {
  const data = buildMintData({
    name: 'claim',
    signature: 'claim(uint256,bytes32[])',
    inputs: [
      { name: 'quantity', type: 'uint256' },
      { name: 'proof', type: 'bytes32[]' },
    ],
  }, 1, walletAddress)
  assert.equal(data, null)
})

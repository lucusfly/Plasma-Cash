import redis from 'lib/storage/redis'
import RLP from 'rlp'
import ethUtil from 'ethereumjs-util'
import rejectCauses from 'child-chain/validator/rejectCauses'
import Block from 'child-chain/block'

const getSignatureOwner = async (transaction) => {
  let tokenOwner = ''
  try {
    let sig = ethUtil.fromRpcSig(transaction.signature.toString())
    let msgHash = ethUtil.hashPersonalMessage(transaction.getHash(true))
    let pubKey = ethUtil.ecrecover(msgHash, sig.v, sig.r, sig.s)
    tokenOwner = ethUtil.bufferToHex(ethUtil.pubToAddress(pubKey))
  } catch (error) {
    throw new Error(rejectCauses.invalidSignature)
  }
  return tokenOwner
}

const getUtxoForAddress = async (address) => {
  let utxos = []
  let data = await redis.hvalsAsync(Buffer.from(`utxo_${address}`))
  for (let utxoRlp of data) {
    let utxoFromRLP = (RLP.decode(utxoRlp).toString()).split(',')
    let utxo = {
      owner: ethUtil.addHexPrefix(utxoFromRLP[0]),
      tokenId: utxoFromRLP[1],
      amount: utxoFromRLP[2],
      blockNumber: utxoFromRLP[3],
    }
    utxos.push(utxo)
  }
  if (utxos.length === 0) {
    throw new Error(rejectCauses.undefinedUtxo)
  }
  return utxos
}

const checkTransactionFields = (transaction) => {
  if (!transaction.prevHash ||
    !(transaction.prevBlock > -2) ||
    !transaction.tokenId ||
    !transaction.newOwner ||
    !transaction.signature) {
    throw new Error(rejectCauses.txFieldsIsInvalid)
  }
  return {success: true}
}

const checkUtxoFieldsAndFindToken = (utxos, tokenId, tokenOwner) => {
  for (let i = 0; i < utxos.length; i++) {
    if (!utxos[i].owner ||
      !utxos[i].tokenId ||
      !utxos[i].amount ||
      !(utxos[i].blockNumber > -1)) {
      continue
    }
    if ((utxos[i].tokenId === tokenId) &&
      (utxos[i].owner === tokenOwner)) {
      return {success: true}
    }
  }
  throw new Error(rejectCauses.noUtxo)
}

const checkAndGetAddsHistoryTx = async (transaction) => {
  const {blockNumber} = transaction.data
  if (!blockNumber) {
    throw new Error(rejectCauses.failData)
  }
  const tokenOwner = transaction.newOwner
  const faceThatRemoves = await getSignatureOwner(transaction)
  const utxos = await getUtxoForAddress(tokenOwner)
  let tokenId = transaction.tokenId.toString()
  checkUtxoFieldsAndFindToken(utxos, tokenId, tokenOwner)
  let blockKey = 'block' + blockNumber.toString(10)
  let block = (new Block(await redis.getAsync(Buffer.from(blockKey))))
  if (!block) {
    throw new Error(rejectCauses.failData)
  }
  let addsTransaction = block.getTxByTokenId(transaction.tokenId)
  if (!addsTransaction) {
    throw new Error(rejectCauses.failData)
  }
  let faceThatAdds = await getSignatureOwner(addsTransaction)
  if (faceThatAdds != faceThatRemoves) {
    throw new Error(rejectCauses.failData)
  }
  return addsTransaction
}

export {
  getSignatureOwner,
  checkUtxoFieldsAndFindToken,
  checkTransactionFields,
  getUtxoForAddress,
  checkAndGetAddsHistoryTx,
}

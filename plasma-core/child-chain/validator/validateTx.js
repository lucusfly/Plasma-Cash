import { txMemPool } from 'child-chain/TxMemPool';
import web3 from 'lib/web3'
import { getAllUtxos } from 'child-chain'

import ethUtil from 'ethereumjs-util';

import rejectCauses from './rejectCauses'

const validateTx = async () => {

  console.time('validateTime');

  let transactions = await txMemPool.txs()

  let successfullTransactions = []
  let rejectTransactions = []

  for (let i = 0; i < transactions.length; i++) {

    let flagOfAccept = false

    if (!transactions[i].prevHash ||
      !(transactions[i].prevBlock > -2) ||
      !transactions[i].tokenId ||
      !transactions[i].newOwner ||
      !transactions[i].signature) {
      rejectTransactions.push({ transaction: transactions[i].getHash(), cause: rejectCauses.txFieldsIsInvalid })
      continue
    }

    let oldOwner = await web3.eth.personal.ecRecover(transactions[i].getHash(true).toString('hex'), ethUtil.addHexPrefix(transactions[i].signature.toString('hex')))

    if (!oldOwner) {
      rejectTransactions.push({ transaction: transactions[i].getHash(), cause: rejectCauses.invalidSignature })
      continue
    }

    let utxo = await getAllUtxos([oldOwner])

    if (utxo.length === 0) {
      rejectTransactions.push({ transaction: transactions[i].getHash(), cause: rejectCauses.undefinedUtxo })
      continue
    }

    for (let i = 0; i < utxo.length; i++) {

      if (!utxo[i].owner ||
        !utxo[i].tokenId ||
        !utxo[i].amount ||
        !(utxo[i].blockNumber > -1)) {
        rejectTransactions.push({ transaction: transactions[i].getHash(), cause: rejectCauses.utxoFieldsIsInvalid })
        continue
      }

      if ((utxo[i].tokenId === transactions[i].tokenId.toString()) && (utxo[i].owner === oldOwner)) {
        flagOfAccept = true
        successfullTransactions.push(transactions[i])
      }
    }

    if (!flagOfAccept) {
      rejectTransactions.push({ transaction: transactions[i].getHash(), cause: rejectCauses.noUtxo })
    }
  }

  if (successfullTransactions.length === 0) {
    return 'list of successfull transaction is empty'
  }
  
  console.time('validateTime');

  return { successfullTransactions, rejectTransactions }
}

export { validateTx }

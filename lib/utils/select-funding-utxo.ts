import { ElectrumApiInterface } from "../api/electrum-api.interface";

const bitcoin = require('bitcoinjs-lib');

import ECPairFactory, { ECPairInterface } from 'ecpair';

import * as ecc from 'tiny-secp256k1';

import * as qrcode from 'qrcode-terminal';

import axios from "axios";

import { getKeypairInfo } from "./address-keypair-path";

import { sleeper } from "./utils";

import { NETWORK } from "../commands/command-helpers";

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

export const getInputUtxoFromTxid = async (utxo: { txId: string, outputIndex: number, value: number }, electrumx: ElectrumApiInterface) => {
  const txResult = await electrumx.getTx(utxo.txId);

  if (!txResult || !txResult.success) {
    throw `Transaction not found in getInputUtxoFromTxid ${utxo.txId}`;
  }
  const tx = txResult.tx;
  utxo['nonWitnessUtxo'] = Buffer.from(tx, 'hex');

  const reconstructedTx = bitcoin.Transaction.fromHex(tx.tx);
  if (reconstructedTx.getId() !== utxo.txId) {
    throw "getInputUtxoFromTxid txid mismatch error";
  }

  return utxo;
}

export const getFundingSelectedUtxo = async (address: string, minFundingSatoshis: number, electrumx: ElectrumApiInterface): Promise<any> => {
  // Query for a UTXO
  let listunspents = await electrumx.getUnspentAddress(address);
  let utxos = listunspents.utxos.filter((utxo) => {
    if (utxo.value >= minFundingSatoshis) {
      return utxo;
    }
  });
  if (!utxos.length) {
    throw new Error(`Unable to select funding utxo, check at least 1 utxo contains ${minFundingSatoshis} satoshis`);
  }
  const selectedUtxo = utxos[0];
  return getInputUtxoFromTxid(selectedUtxo, electrumx);
}

const DEFAULT_SATS_BYTE = 10;
const DEFAULT_SATS_ATOMICAL_UTXO = 1000;
const SEND_RETRY_SLEEP_SECONDS = 15;
const SEND_RETRY_ATTEMPTS = 20;
const DUST_AMOUNT = 546;
const BASE_BYTES = 10;
const INPUT_BYTES_BASE = 148;
const OUTPUT_BYTES_BASE = 34;
const OP_RETURN_BYTES: number = 20;
const EXCESSIVE_FEE_LIMIT: number = 500000; // Limit to 1/200 of a BTC for now


/**
   * Gets a funding UTXO and also displays qr code for quick deposit
   * @param electrumxApi 
   * @param address 
   * @param amount 
   * @returns 
   */
export const getFundingUtxo = async (electrumxApi, address: string, amount: number, fundingKeypairRaw: any, fees: any, satsbyte: any, scriptP2TR: any, suppressDepositAddressInfo = false, seconds = 5, ) => {

  // const fundingKeypair = getKeypairInfo(fundingKeypairRaw);
  
  const payment = bitcoin.payments.p2pkh({ pubkey: fundingKeypairRaw.publicKey });

  // console.log('payment', payment)
  const { address: taproot } = payment;

  let needSend = true;

  try {
    const {data: {data:  list}} = await axios.get(`https://www.oklink.com/api/v5/explorer/address/transaction-list?chainShortName=btc&address=${taproot}&limit=1`, {headers: {
        "Ok-Access-Key": "19a6db41-cf44-4a4d-9cd9-53ab6205c512"
    }})

    console.log('list', list[0].transactionLists[0]);

    if (list[0]?.transactionLists[0]?.txId) {
      const txResult = await electrumxApi.getTx(list[0]?.transactionLists[0]?.txId);

      const txData = bitcoin.Transaction.fromHex(txResult.tx)

      // 创建 PSBT
      const psbt = new bitcoin.Psbt({network: NETWORK});
      psbt.setVersion(1);

      const {data: {data:  utxos}} = await axios.get(`https://www.oklink.com/api/v5/explorer/address/utxo?chainShortName=btc&address=${taproot}&limit=1`, {headers: {
          "Ok-Access-Key": "19a6db41-cf44-4a4d-9cd9-53ab6205c512"
      }})

      // console.log(utxos[0].utxoList);

      const enoughUtxo = (utxos[0].utxoList ?? []).find(item => Number(item.unspentAmount) * 100000000 >= fees.revealFeePlusOutputs);

      if (enoughUtxo) {
        console.log('Will use utxo...', enoughUtxo);
        const result = await electrumxApi.getTx(enoughUtxo.txid);
        console.log('Last transaction Tx:', result);
        const data = bitcoin.Transaction.fromHex(result.tx);

        console.log('Last transaction Tx:', data);

        // psbt.addInput({
        //   hash: enoughUtxo.txid,
        //   index: parseInt(enoughUtxo.index, 10),
        //   // witnessUtxo: getWitnessUtxo(data.outs[enoughUtxo.index]),
        //   // nonWitnessUtxo: Buffer.from(result.tx, 'hex')
        //   witnessUtxo: { value:  Number(enoughUtxo.unspentAmount) * 100000000, script: Buffer.from(fundingKeypair.output, 'hex') },
        //   tapInternalKey: fundingKeypair.childNodeXOnlyPubkey,
        // });

        psbt.addInput({
          hash: enoughUtxo.txid,
          index: parseInt(enoughUtxo.index, 10),
          witnessUtxo: getWitnessUtxo(data.outs[enoughUtxo.index]),
          nonWitnessUtxo: Buffer.from(result.tx, 'hex')
        });

      } else {
        psbt.addInput({
          hash: Buffer.from(txData.ins[0].hash),
          index: 1,
          // index: txData.ins[0].index,
          // script:  Buffer.from(txData.ins[0].script),
          // sequence: txData.ins[0].sequence,
          // witness: txData.ins[0].witness,
        });
      }

      console.log('Send address: ', scriptP2TR.address);
      console.log('Send amount: ', fees.revealFeePlusOutputs / 100000000, 'BTC');

      psbt.addOutput({
        address: scriptP2TR.address,
        value: fees.revealFeePlusOutputs,
      });

      const ARGS_BYTES = 20;
      const BITWORK_BYTES = 5 + 10 + 4 + 10 + 4 + 10 + 1 + 10;
      const EXTRA_BUFFER = 10;

      // const {data: {data:  feeData}} = await axios.get(`https://www.oklink.com/api/v5/explorer/blockchain/fee?chainShortName=btc`, {headers: {
      //   "Ok-Access-Key": "19a6db41-cf44-4a4d-9cd9-53ab6205c512"
      // }})

      const fee = await electrumxApi.fee(8);

      console.log('Best Fee:', fee);

      const sbyte = Number(fee) * 100000000 / 1024;
      console.log('v/sbyte', Math.floor(sbyte))
      const feeAmount = Math.floor(sbyte) *
            (BASE_BYTES +
                (psbt.data.inputs.length * INPUT_BYTES_BASE) +
                ((1 + psbt.data.outputs.length) * OUTPUT_BYTES_BASE) +
                ARGS_BYTES +
                BITWORK_BYTES +
                // OP_RETURN_BYTES +
                EXTRA_BUFFER
            )

      console.log('Caculate Fee:', feeAmount);

      const isMoreThanDustChangeRemaining = Number(enoughUtxo.unspentAmount) * 100000000 - fees.revealFeePlusOutputs - feeAmount >= 546;

      if (isMoreThanDustChangeRemaining) {
        // Add change output
        const changeAmount = Number(enoughUtxo.unspentAmount) * 100000000 - fees.revealFeePlusOutputs - feeAmount;
        psbt.addOutput({
          address: enoughUtxo.address,
          value: Math.floor(changeAmount),
        });
      }
      console.log('Signing...');
      // psbt.signInput(0, fundingKeypair.tweakedChildNode); // 使用私钥签署输入
      psbt.signInput(0, fundingKeypairRaw); // 使用私钥签署输入

      console.log('Signing...');

      psbt.finalizeAllInputs(); // 完成所有签名

      const interTx = psbt.extractTransaction();
      // 获取最终的 PSBT 作为十六进制字符串

      const checkTxid = interTx.getId();

      console.log('checkout', checkTxid);

      console.log('\n');

      console.log('interTx', interTx.toHex());

      console.log('\n');
      console.log('TX will broadcast at 30 seconds late...');
      console.log('Please Confirm This Transaction TX...');

      console.log('\n');
      await sleeper(15);
      console.log('\n');
      console.log('Will broadcast at 15 seconds late...');
      await sleeper(15);
      console.log('Start broadcast...')
      let attempts = 0;
      let result: any = null;
      do {
        try {
 
          // result = await fetch(
          //     "https://autumn-evocative-breeze.btc.quiknode.pro/777da31a2dd28dd86508c23d2fff242beafaf397/", 
          //   {
          //     method: 'POST',
          //     headers: {
          //       "Content-Type": "application/json"
          //     },
          //     body: JSON.stringify({
          //       method: "sendrawtransaction",
          //       params: [interTx.toHex()]
          //     }),
          //     redirect: 'follow'
          //   }
          // )

          result = await electrumxApi.broadcast(interTx.toHex());
         
          if (result) {
            console.log('\n');
            console.log('Transaction Tx:',result);
            needSend = false;
            break;
          }
        } catch (err: any ) {
            console.log('\n');
            console.log('result', err);
            console.log('Network error broadcasting (Trying again soon...)');
            // Put in a sleep to help the connection reset more gracefully in case there is some delay
            console.log(`Will retry to broadcast transaction again in ${15} seconds...`);
            console.log('\n');
            if (attempts === 2) {
              console.log(`Auto send ${amount / 100000000} BTC to ${address} failed`);
            }
            await sleeper(15)
        }
          attempts++;
      } while (attempts < 3);
    }
  } catch (err) {
    console.log('Auto send failed', err);
  };

  // We are expected to perform commit work, therefore we must fund with an existing UTXO first to generate the commit deposit address
  if (!suppressDepositAddressInfo && needSend) {
    console.log('\n');
    console.log(`Please send ${amount / 100000000} BTC to ${address}`);
    qrcode.generate(address, { small: false });
  }
  // If commit POW was requested, then we will use a UTXO from the funding wallet to generate it
  console.log(`...`)
  console.log(`...`)
  if (!suppressDepositAddressInfo) {
    console.log(`WAITING UNTIL ${amount / 100000000} BTC RECEIVED AT ${address}`)
  }
  console.log(`...`)
  console.log(`...`)
  
  let fundingUtxo = await electrumxApi.waitUntilUTXO(address, amount, seconds ? 5 : seconds, false);
  console.log(`Detected Funding UTXO (${fundingUtxo.txid}:${fundingUtxo.vout}) with value ${fundingUtxo.value} for funding...`);
  return fundingUtxo
}
function getWitnessUtxo(out: any): any {
  delete out.address;
  out.script = Buffer.from(out.script, 'hex');
  return out;
}
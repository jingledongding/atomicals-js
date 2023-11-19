import { CommandResultInterface } from "./command-result.interface";
import { CommandInterface } from "./command.interface";
import { toXOnly } from "../utils/create-key-pair";
import { jsonFileExists, jsonFileReader, jsonFileWriter } from "../utils/file-utils";
import { IValidatedWalletInfo } from "../utils/validate-wallet-storage";
const bitcoin = require('bitcoinjs-lib');
import ECPairFactory from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { walletPathResolver } from "../utils/wallet-path-resolver";
import { NETWORK } from "./command-helpers";

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const walletPath = walletPathResolver();

const bs58 = require('bs58');

function base58ToBuffer(base58String: string) {
  const decodedBuffer =  bs58.decode(base58String);
  const buffer =   Buffer.from(decodedBuffer, 'hex');
  console.log('buffer', buffer);
  return buffer

}

export class WalletImportCommand implements CommandInterface {

    constructor(private wif: string, private alias: string) {
    }
    async run(): Promise<CommandResultInterface> {
        if (!(await this.walletExists())) {
            throw "wallet.json does NOT exist, please create one first with wallet-init"
        }
        const walletFileData: IValidatedWalletInfo = (await jsonFileReader(walletPath)) as IValidatedWalletInfo;
        if (!walletFileData.imported) {
            walletFileData.imported = {};
        }
        if (walletFileData.imported.hasOwnProperty(this.alias)) {
            throw `Wallet alias ${this.alias} already exists!`
        }
        // Just make a backup for now to be safe
        await jsonFileWriter(walletPath + '.' + (new Date()).getTime() + '.walletbackup', walletFileData);

        // Get the wif and the address and ensure they match
        const importedKeypair = ECPair.fromWIF(this.wif);
        const { address, output } = bitcoin.payments.p2tr({
            internalPubkey: toXOnly(importedKeypair.publicKey),
            network: NETWORK
        });
        const walletImportedField = Object.assign({}, walletFileData.imported, {
            [this.alias]: {
                address,
                WIF: this.wif
            }
        });
        walletFileData['imported'] = walletImportedField;
        await jsonFileWriter(walletPath, walletFileData);
        return {
            success: true,
            data: {
                address,
                alias: this.alias
            }
        }
    }

    async walletExists() {
        if (await jsonFileExists(walletPath)) {
            return true;
        }
    }
}


export class WalletImportFromPrivateKeyCommand implements CommandInterface {

    constructor(private privateKey: string, private alias: string) {
    }
    async run(): Promise<CommandResultInterface> {
        if (!(await this.walletExists())) {
            throw "wallet.json does NOT exist, please create one first with wallet-init"
        }
        const walletFileData: IValidatedWalletInfo = (await jsonFileReader(walletPath)) as IValidatedWalletInfo;
        if (!walletFileData.imported) {
            walletFileData.imported = {};
        }
        if (walletFileData.imported.hasOwnProperty(this.alias)) {
            throw `Wallet alias ${this.alias} already exists!`
        }
        // Just make a backup for now to be safe
        await jsonFileWriter(walletPath + '.' + (new Date()).getTime() + '.walletbackup', walletFileData);

        // Get the wif and the address and ensure they match
        let priKey = this.privateKey as any;

        console.log('Buffer.from(this.privateKey, "hex")', Buffer.from(this.privateKey, "hex"))
        
        const importedKeypair = ECPair.fromPrivateKey(priKey.length === 64 ? Buffer.from(this.privateKey, "hex") : base58ToBuffer(this.privateKey));
       
        const wif = importedKeypair.toWIF();

        const { address: taproot } = bitcoin.payments.p2pkh({ pubkey: importedKeypair.publicKey });

        const { address: segWit } = bitcoin.payments.p2wpkh({ pubkey: importedKeypair.publicKey });

        const { address: segWit_p2sh } = bitcoin.payments.p2sh({
            redeem: bitcoin.payments.p2wpkh({ pubkey: importedKeypair.publicKey }),
          });

        const walletImportedField = Object.assign({}, walletFileData.imported, {
            [this.alias]: {
                address: taproot,
                taproot: taproot,
                segWit: segWit,
                segWit_p2sh:segWit_p2sh,
                WIF: wif,
            }
        });
     

        walletFileData['imported'] = walletImportedField;
        await jsonFileWriter(walletPath, walletFileData);
        return {
            success: true,
            data: {
                address: taproot,
                alias: this.alias
            }
        }
    }

    async walletExists() {
        if (await jsonFileExists(walletPath)) {
            return true;
        }
    }
}

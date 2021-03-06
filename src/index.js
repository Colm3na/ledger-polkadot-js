/** ******************************************************************************
 *  (c) 2019 ZondaX GmbH
 *  (c) 2016-2017 Ledger
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 ******************************************************************************* */

import {
  APP_KEY,
  CHUNK_SIZE,
  CLA, ERROR_CODE,
  errorCodeToString,
  getVersion,
  INS,
  PAYLOAD_TYPE,
  processErrorResponse
} from "./common";

export default class LedgerApp {
  constructor(transport, scrambleKey = APP_KEY) {
    if (!transport) {
      throw new Error("Transport has not been defined");
    }

    this.transport = transport;
    transport.decorateAppAPIMethods(this, ["getVersion", "getAddress", "sign"], scrambleKey);
  }

  static serializePath(account, change, addressIndex) {
    if (!Number.isInteger(account)) throw new Error("Input must be an integer");
    if (!Number.isInteger(change)) throw new Error("Input must be an integer");
    if (!Number.isInteger(addressIndex)) throw new Error("Input must be an integer");

    const buf = Buffer.alloc(20);
    buf.writeUInt32LE(0x8000002c, 0);
    buf.writeUInt32LE(0x800001b2, 4);
    // eslint-disable-next-line no-bitwise
    buf.writeUInt32LE(account, 8);
    // eslint-disable-next-line no-bitwise
    buf.writeUInt32LE(change, 12);
    // eslint-disable-next-line no-bitwise
    buf.writeUInt32LE(addressIndex, 16);

    return buf;
  }

  static signGetChunks(account, change, addressIndex, message) {
    const chunks = [];
    const bip44Path = LedgerApp.serializePath(account, change, addressIndex);
    chunks.push(bip44Path);

    const buffer = Buffer.from(message);

    for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
      let end = i + CHUNK_SIZE;
      if (i > buffer.length) {
        end = buffer.length;
      }
      chunks.push(buffer.slice(i, end));
    }

    return chunks;
  }

  async getVersion() {
    try {
      this.versionResponse = await getVersion(this.transport);
      return this.versionResponse;
    } catch (e) {
      return processErrorResponse(e);
    }
  }

  async appInfo() {
    return this.transport.send(0xb0, 0x01, 0, 0).then(response => {
      const errorCodeData = response.slice(-2);
      const returnCode = errorCodeData[0] * 256 + errorCodeData[1];

      const result = {};

      let appName = "err";
      let appVersion = "err";
      let flagLen = 0;
      let flagsValue = 0;

      if (response[0] !== 1) {
        // Ledger responds with format ID 1. There is no spec for any format != 1
        result.error_message = "response format ID not recognized";
        result.return_code = 0x9001;
      } else {
        const appNameLen = response[1];
        appName = response.slice(2, 2 + appNameLen).toString("ascii");
        let idx = 2 + appNameLen;
        const appVersionLen = response[idx];
        idx += 1;
        appVersion = response.slice(idx, idx + appVersionLen).toString("ascii");
        idx += appVersionLen;
        const appFlagsLen = response[idx];
        idx += 1;
        flagLen = appFlagsLen;
        flagsValue = response[idx];
      }

      return {
        return_code: returnCode,
        error_message: errorCodeToString(returnCode),
        // //
        appName,
        appVersion,
        flagLen,
        flagsValue,
        // eslint-disable-next-line no-bitwise
        flag_recovery: (flagsValue & 1) !== 0,
        // eslint-disable-next-line no-bitwise
        flag_signed_mcu_code: (flagsValue & 2) !== 0,
        // eslint-disable-next-line no-bitwise
        flag_onboarded: (flagsValue & 4) !== 0,
        // eslint-disable-next-line no-bitwise
        flag_pin_validated: (flagsValue & 128) !== 0,
      };
    }, processErrorResponse);
  }

  async deviceInfo() {
    return this.transport
      .send(0xe0, 0x01, 0, 0, Buffer.from([]), [ERROR_CODE.NoError, 0x6e00])
      .then(response => {
        const errorCodeData = response.slice(-2);
        const returnCode = errorCodeData[0] * 256 + errorCodeData[1];

        if (returnCode === 0x6e00) {
          return {
            return_code: returnCode,
            error_message: "This command is only available in the Dashboard",
          };
        }

        const targetId = response.slice(0, 4).toString("hex");

        let pos = 4;
        const secureElementVersionLen = response[pos];
        pos += 1;
        const seVersion = response.slice(pos, pos + secureElementVersionLen).toString();
        pos += secureElementVersionLen;

        const flagsLen = response[pos];
        pos += 1;
        const flag = response.slice(pos, pos + flagsLen).toString("hex");
        pos += flagsLen;

        const mcuVersionLen = response[pos];
        pos += 1;
        // Patch issue in mcu version
        let tmp = response.slice(pos, pos + mcuVersionLen);
        if (tmp[mcuVersionLen - 1] === 0) {
          tmp = response.slice(pos, pos + mcuVersionLen - 1);
        }
        const mcuVersion = tmp.toString();

        return {
          return_code: returnCode,
          error_message: errorCodeToString(returnCode),
          // //
          targetId,
          seVersion,
          flag,
          mcuVersion,
        };
      }, processErrorResponse);
  }

  async getAddress(account, change, addressIndex, requireConfirmation = false) {
    const bip44Path = LedgerApp.serializePath(account, change, addressIndex);

    let p1 = 0;
    if (requireConfirmation) p1 = 1;

    return this.transport.send(CLA, INS.GET_ADDR_ED25519, p1, 0, bip44Path).then(response => {
      const errorCodeData = response.slice(-2);
      const errorCode = errorCodeData[0] * 256 + errorCodeData[1];

      return {
        pubKey: response.slice(0, 32).toString("hex"),
        address: response.slice(32, response.length - 2).toString("ascii"),
        return_code: errorCode,
        error_message: errorCodeToString(errorCode),
      };
    }, processErrorResponse);
  }

  async signSendChunk(chunkIdx, chunkNum, chunk) {
    let payloadType = PAYLOAD_TYPE.ADD;
    if (chunkIdx === 1) {
      payloadType = PAYLOAD_TYPE.INIT;
    }
    if (chunkIdx === chunkNum) {
      payloadType = PAYLOAD_TYPE.LAST;
    }

    return this.transport
      .send(CLA, INS.SIGN_ED25519, payloadType, 0, chunk, [0x9000, 0x6984, 0x6a80])
      .then(response => {
        const errorCodeData = response.slice(-2);
        const returnCode = errorCodeData[0] * 256 + errorCodeData[1];
        let errorMessage = errorCodeToString(returnCode);
        let signature = null;

        if (returnCode === 0x6a80 || returnCode === 0x6984) {
          errorMessage = response.slice(0, response.length - 2).toString("ascii");
        } else if (response.length > 2) {
          signature = response.slice(0, response.length - 2);
        }

        return {
          signature,
          return_code: returnCode,
          error_message: errorMessage,
        };
      }, processErrorResponse);
  }

  async sign(account, change, addressIndex, message) {
    const chunks = LedgerApp.signGetChunks(account, change, addressIndex, message);
    return this.signSendChunk(1, chunks.length, chunks[0]).then(async result => {
      for (let i = 1; i < chunks.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop,no-param-reassign
        result = await this.signSendChunk(1 + i, chunks.length, chunks[i]);
        if (result.return_code !== 0x9000) {
          break;
        }
      }

      return {
        return_code: result.return_code,
        error_message: result.error_message,
        signature: result.signature,
      };
    }, processErrorResponse);
  }
}

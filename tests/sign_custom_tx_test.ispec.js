import TransportNodeHid from "@ledgerhq/hw-transport-node-hid";
import { test } from "jest";
import { TypeRegistry } from "@polkadot/types";
import { createSigningPayload, methods } from "@substrate/txwrapper";
import { cryptoWaitReady } from "@polkadot/util-crypto";

import LedgerApp from "../src";

function rpcToNode(method, params = []) {
  return fetch("http://10.68.216.7:23033", {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method,
      params,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  })
    .then((response) => response.json())
    .then(({ error, result }) => {
      if (error) {
        throw new Error(`${error.code} ${error.message}: ${error.data}`);
      }

      return result;
    });
}

test("sign_custom_tx", async () => {
  await cryptoWaitReady();

  // Fetch some data from the blockchain. This is required for offline transaction generation
  const { block } = await rpcToNode("chain_getBlock");
  const blockHash = await rpcToNode("chain_getBlockHash");
  const genesisHash = await rpcToNode("chain_getBlockHash", [0]);
  const metadataRpc = await rpcToNode("state_getMetadata");
  const { specVersion, transactionVersion } = await rpcToNode("state_getRuntimeVersion");

  const registry = new TypeRegistry();

  const blockNumber = registry.createType("BlockNumber", block.header.number).toNumber();

  // Ledger initialization
  const transport = await TransportNodeHid.create(1000);
  const app = new LedgerApp(transport);

  const pathAccount = 0x80000000;
  const pathChange = 0x80000000;
  const pathIndex = 0x80000000;
  const { address } = await app.getAddress(pathAccount, pathChange, pathIndex);

  const unsigned = methods.balances.transfer(
    {
      dest: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
      value: 12,
    },
    {
      address,
      blockHash,
      blockNumber,
      eraPeriod: 64,
      genesisHash,
      metadataRpc,
      nonce: 0,
      specVersion,
      tip: 0,
      transactionVersion,
    },
    {
      metadataRpc,
      registry,
    },
  );

  const signingPayload = createSigningPayload(unsigned, { metadataRpc, registry });
  const txBlob = Buffer.from(signingPayload, "hex");

  // This line fails to sign transaction
  const responseSign = await app.sign(pathAccount, pathChange, pathIndex, txBlob);
  console.log(responseSign);
});

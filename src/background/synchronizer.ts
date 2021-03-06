import {
  ScriptHash,
  Block,
  BlockHeader,
  SigPair,
  TxVariant,
  MintTxV0,
  RewardTxV0,
  TransferTxV0,
  OwnerTxV0,
  Asset,
  RpcType,
} from 'godcoin';
import { WalletDb, KvTable, TxsTable, TxRawRow } from './db';
import { emitSyncUpdate as ipcEmitSyncUpdate } from './ipc';
import { SyncStatus, SyncUpdateRaw } from '../ipc-models';
import { EventEmitter } from 'events';
import { getClient } from './client';
import { Logger } from '../log';
import Big from 'big.js';
import Long from 'long';

let log = new Logger('main:chain_synchronizer');
let instance: Synchronizer;

export interface ChainSynchronizer extends EventEmitter {
  getSyncStatus(): SyncStatus;
  on(event: 'sync_update', listener: (update: SyncUpdateRaw) => void): this;
}

class Synchronizer extends EventEmitter {
  private readonly watchAddrs: ScriptHash[];
  private currentHeight: Long;

  private pendingBlocks: Block[] = [];
  private syncStatus = SyncStatus.Connecting;
  private fullSyncRetryTimer: NodeJS.Timer | undefined;
  private fullSyncInProgress = false;

  public constructor(watchAddrs: ScriptHash[], syncHeight: Long) {
    super();
    if (!syncHeight.unsigned) throw new Error('syncHeight must be unsigned');
    this.currentHeight = syncHeight;
    this.watchAddrs = watchAddrs;

    const client = getClient();
    if (client.isOpen()) {
      this.startSync();
    }

    client.on('open', (): void => {
      this.startSync();
    });

    client.on('close', (): void => {
      this.fullSyncInProgress = false;
      if (this.fullSyncRetryTimer) {
        clearInterval(this.fullSyncRetryTimer);
        this.fullSyncRetryTimer = undefined;
      }

      this.syncStatus = SyncStatus.Connecting;
      this.emitSyncUpdate({
        status: this.syncStatus,
      });
    });

    client.on(
      'sub_msg',
      async (res): Promise<void> => {
        if (res.type !== RpcType.GetBlock) return;
        const block = res.block as Block;
        if (this.syncStatus !== SyncStatus.Complete) {
          this.pendingBlocks.push(block);
          return;
        }
        log.info('Received block update:', block.block.header.height.toString());
        try {
          const updatedTxs = await this.applyBlock(block);
          const update: SyncUpdateRaw = {
            status: this.syncStatus,
          };
          if (updatedTxs && updatedTxs.length > 0) {
            const totalBalance = await this.updateTotalBalance();
            update.newData = {
              totalBalance: totalBalance.amount.toString(),
              txs: updatedTxs,
            };
          }
          this.emitSyncUpdate(update);
          await this.updateSyncHeight();
        } catch (e) {
          log.error('Failed to handle incoming block\n', block, e);
        }
      },
    );
  }

  public getSyncStatus(): SyncStatus {
    return this.syncStatus;
  }

  private async startSync(): Promise<void> {
    if (this.fullSyncInProgress) return;
    this.fullSyncInProgress = true;
    if (this.fullSyncRetryTimer) {
      clearTimeout(this.fullSyncRetryTimer);
      this.fullSyncRetryTimer = undefined;
    }

    const oldStatus = this.syncStatus;
    this.syncStatus = SyncStatus.InProgress;
    this.emitSyncUpdate({
      status: this.syncStatus,
    });

    const client = getClient();
    if (oldStatus === SyncStatus.Connecting) {
      // Fresh connection, we need to reinitialize everything
      try {
        // Subscribe to new blocks
        await client.sendReq({
          type: RpcType.Subscribe,
        });

        // Configure the filter.
        await client.sendReq({
          type: RpcType.SetBlockFilter,
          addrs: this.watchAddrs,
        });
      } catch (e) {
        log.error('Failed to configure block filter and subscription:', e);
      }
    }

    try {
      await this.performFullSync();
    } catch (e) {
      log.error('Failure during the synchronization process:', e);
      this.fullSyncRetryTimer = setTimeout(() => {
        this.startSync();
      }, 5000);
    } finally {
      this.fullSyncInProgress = false;
    }
  }

  private async performFullSync(): Promise<void> {
    log.info('Starting synchronization process (current height: ' + this.currentHeight + ')');
    try {
      const client = getClient();

      // Get the current height that we will sync up to. Any missed blocks will be in the pending queue.
      const chainPropsBody = await client.sendReq({
        type: RpcType.GetProperties,
      });
      if (chainPropsBody.type !== RpcType.GetProperties) throw new Error('expected GetProperties response');
      const chainHeight = chainPropsBody.properties.height;

      // Start retrieving blocks and apply them.
      const txs: TxRawRow[] = [];
      if (this.currentHeight.lt(chainHeight)) {
        await new Promise((resolve, reject) => {
          let time = Date.now();
          client.getBlockRange(this.currentHeight.add(1), chainHeight, async (err, filteredBlock) => {
            if (err) return reject(err);
            if (!filteredBlock) return resolve();

            const updatedTxs = await this.applyBlock(filteredBlock);
            if (updatedTxs && updatedTxs.length > 0) {
              txs.push(...updatedTxs);
              // Update the height immediately, otherwise during a restart we may resync the block twice and appear as a
              // duplicate transaction.
              await this.updateSyncHeight();
            }

            const curTime = Date.now();
            if (curTime - time > 5000) {
              // Update the height every so often to ensure that during a restart, the sync doesn't restart completely.
              await this.updateSyncHeight();
              time = curTime;
              log.info('Current sync height:', this.currentHeight.toString());
            }
          });
        });
      }

      // Grab and update the total balance before the pending blocks are applied. This is to help mitigate any
      // potential issues when a block is received *during* the balance update.
      const totalBalance = await this.updateTotalBalance();

      // Apply any pending blocks received from block subscription updates while we were previously synchronizing
      // up to the currently known height. There is no race condition even if blocks are pushed during iteration
      // as the loop will still iterate over new blocks regardless if the body waits for promises to finish.
      for (const block of this.pendingBlocks) {
        const height = block.block.header.height;
        if (height.lte(this.currentHeight)) {
          log.info('Skipping already applied block:', height.toString());
          continue;
        }
        log.info('Applying pending block:', height.toString());
        const updatedTxs = await this.applyBlock(block);
        if (updatedTxs && updatedTxs.length > 0) {
          txs.push(...updatedTxs);
        }
      }

      await this.updateSyncHeight();
      this.syncStatus = SyncStatus.Complete;
      this.emitSyncUpdate({
        status: this.syncStatus,
        newData: {
          totalBalance: totalBalance.amount.toString(),
          txs,
        },
      });

      log.info('Synchronization completed:', this.currentHeight.toString());
    } finally {
      // Reset the pending blocks here in case there's any error to avoid reapplying already applied blocks upon
      // reconnection.
      this.pendingBlocks = [];
    }
  }

  private async applyBlock(block: [BlockHeader, SigPair] | Block): Promise<TxRawRow[] | undefined> {
    let txs: TxRawRow[] | undefined;
    let height: Long;

    if (block instanceof Block) {
      height = block.block.header.height;
      const txsTable = WalletDb.getInstance().getTable(TxsTable);
      for (const wrapper of block.block.transactions) {
        if (!this.txHasMatch(wrapper)) continue;
        if (txs === undefined) txs = [];
        txs.push(await txsTable.insert(wrapper));
      }
    } else {
      // Block header + signature (no relevant transactions)
      height = block[0].header.height;
    }

    if (!this.currentHeight.add(1).eq(height)) {
      log.error('Missed block:', this.currentHeight.add(1).toString(), ' got height,', height.toString());
    }
    this.currentHeight = height;

    return txs;
  }

  private txHasMatch(txVariant: TxVariant): boolean {
    const tx = txVariant.tx;
    if (tx instanceof OwnerTxV0) {
      return this.isWatched(tx.minter.toScript().hash()) || this.isWatched(tx.script.hash());
    } else if (tx instanceof MintTxV0) {
      return this.isWatched(tx.to);
    } else if (tx instanceof RewardTxV0) {
      return this.isWatched(tx.to);
    } else if (tx instanceof TransferTxV0) {
      return this.isWatched(tx.from) || this.isWatched(tx.to);
    }
    const _exhaustiveCheck: never = tx;
    throw new Error('exhaustive check failed tx: ' + _exhaustiveCheck);
  }

  private isWatched(addr: ScriptHash): boolean {
    const index = this.watchAddrs.findIndex(watchAddr => {
      return Buffer.compare(addr.bytes, watchAddr.bytes) === 0;
    });
    return index > -1;
  }

  private emitSyncUpdate(update: SyncUpdateRaw): void {
    this.emit('sync_update', update);
    ipcEmitSyncUpdate(update);
  }

  private async updateSyncHeight(): Promise<void> {
    const store = WalletDb.getInstance().getTable(KvTable);
    await store.setSyncHeight(this.currentHeight);
  }

  private async updateTotalBalance(): Promise<Asset> {
    const client = getClient();
    const proms = [];
    for (const addr of this.watchAddrs) {
      proms.push(
        client.sendReq({
          type: RpcType.GetAddressInfo,
          addr,
        }),
      );
    }
    const responses = await Promise.all(proms);
    let totalBal = new Asset(Big(0));
    for (const res of responses) {
      if (res.type !== RpcType.GetAddressInfo) throw new Error('unexpected RPC response: ' + res.type);
      totalBal = totalBal.add(res.info.balance);
    }

    const store = WalletDb.getInstance().getTable(KvTable);
    await store.setTotalBalance(totalBal);
    return totalBal;
  }
}

export function getSynchronizer(): ChainSynchronizer {
  if (instance === undefined) throw new Error('synchronizer not initialized');
  return instance;
}

export async function initSynchronizer(watchAddrs: ScriptHash[]): Promise<void> {
  if (getClient() === undefined) throw new Error('client not initialized');
  if (instance !== undefined) throw new Error('synchronizer already initialized');

  let syncHeight = await WalletDb.getInstance()
    .getTable(KvTable)
    .getSyncHeight();
  if (!syncHeight) syncHeight = Long.fromNumber(0, true);

  instance = new Synchronizer(watchAddrs, syncHeight);
}

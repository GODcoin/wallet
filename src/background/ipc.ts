import { Settings, NoAvailableSettings, setGlobalSettings } from './settings';
import { SecretKey, DecryptError, DecryptErrorType } from './crypto';
import { initSynchronizer } from './synchronizer';
import { createDashboardWindow } from './index';
import * as models from '../ipc-models';
import sodium from 'libsodium-wrappers';
import { initClient } from './client';
import { randomBytes } from 'crypto';
import { ipcMain } from 'electron';
import { KeyPair } from 'godcoin';
import { Logger } from '../log';
import { WalletDb } from './db';

const log = new Logger('main:ipc');

export default function(): void {
  ipcMain.on(models.APP_ACTION_REQ, async (evt, payload: models.AppActionReq) => {
    try {
      const req = payload.req;
      let response: models.ResModel;

      switch (req.type) {
        case 'settings:first_setup': {
          const secretKey = new SecretKey(randomBytes(sodium.crypto_secretbox_KEYBYTES));
          const keyPair = KeyPair.fromWif(req.privateKey);

          const settings = new Settings({
            dbSecretKey: secretKey,
            keyPair,
          });
          settings.save(req.password);

          // Reset the database because we have a new encryption key and any cached data is now invalid
          WalletDb.delete();

          response = {
            type: 'settings:first_setup',
          };
          break;
        }
        case 'settings:load_settings': {
          const password = req.password;
          try {
            const settings = Settings.load(password);
            setGlobalSettings(settings);

            response = {
              type: 'settings:load_settings',
              status: 'success',
            };

            try {
              await WalletDb.init(settings.dbSecretKey);
              initClient('ws://127.0.0.1:7777');
              initSynchronizer([settings.keyPair.publicKey.toScript().hash()]);
              createDashboardWindow();
            } catch (e) {
              log.error('A severe error has occurred:', e);
              // This error won't be logged from the outer catch
              throw new Error();
            }
          } catch (e) {
            // Errors from Settings.load() are logged
            let status: 'success' | 'incorrect_password' | 'invalid_checksum' | 'no_settings_available' | 'unknown';
            if (e instanceof NoAvailableSettings) {
              status = 'no_settings_available';
            } else if (e instanceof DecryptError && e.type === DecryptErrorType.INCORRECT_PASSWORD) {
              status = 'incorrect_password';
            } else if (e instanceof DecryptError && e.type === DecryptErrorType.INVALID_CHECKSUM) {
              status = 'invalid_checksum';
            } else {
              status = 'unknown';
            }
            response = {
              type: 'settings:load_settings',
              status,
            };
          }
          break;
        }
        default: {
          const _exhaustiveCheck: never = req;
          throw new Error('unreachable state: ' + JSON.stringify(_exhaustiveCheck));
        }
      }

      const reply: models.AppActionRes = {
        id: payload.id,
        res: response,
      };
      evt.reply(models.APP_ACTION_RES, reply);
    } catch (e) {
      log.error('Failed to handle IPC request:', e);
    }
  });
}

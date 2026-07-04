import * as miio from 'node-miio';
import type { MiioDevice, MiioErrorChangedEvent } from 'node-miio';

import { cleaningStatuses } from '../utils/constants.js';
import type { ModelLogger } from '../utils/logger.ts';

export interface DeviceManagerConfig {
  ip?: string;
  token?: string;
}

export interface StateChangedEvent {
  key: string;
  value: unknown;
}

type TimerHandle = unknown;

const runtimeTimers = globalThis as unknown as {
  clearInterval: (handle: TimerHandle) => void;
  clearTimeout: (handle: TimerHandle) => void;
  setInterval: (handler: () => void, delay: number) => TimerHandle;
  setTimeout: (handler: () => void, delay: number) => TimerHandle;
};

const GET_STATE_INTERVAL_MS = 10000; // 30s

export class DeviceManager {
  private readonly stateChangedListeners = new Set<(event: StateChangedEvent) => void>();
  private readonly errorChangedListeners = new Set<(error: MiioErrorChangedEvent | null) => void>();
  private readonly deviceConnectedResolvers: Array<(device: MiioDevice) => void> = [];

  private readonly ip: string;
  private readonly token: string;

  private connectingPromise: Promise<void> | null = null;
  private refreshTimer: TimerHandle | null = null;
  private refreshInProgress = false;
  private connectRetry = runtimeTimers.setTimeout(() => void 0, 100); // Noop timeout only to initialise the property
  private deviceInstance: MiioDevice | undefined;
  private lastError: MiioErrorChangedEvent | null = null;
  constructor(
    private readonly log: ModelLogger,
    config: DeviceManagerConfig,
  ) {
    if (!config.ip) {
      throw new Error('You must provide an ip address of the vacuum cleaner.');
    }
    this.ip = config.ip;

    if (!config.token) {
      throw new Error('You must provide a token of the vacuum cleaner.');
    }
    this.token = config.token;

    this.connect().catch(() => {
      // Do nothing in the catch because this function already logs the error internally and retries after 2 minutes.
    });
  }

  public get model() {
    return this.deviceInstance?.miioModel || 'unknown model';
  }

  public get state() {
    return this.property('state') as string;
  }

  public get isCleaning() {
    return cleaningStatuses.includes(this.state);
  }

  public get isPaused() {
    return this.state === 'paused';
  }

  public get device() {
    if (!this.deviceInstance) {
      throw new Error('Not connected yet');
    }
    return this.deviceInstance;
  }

  public property<T>(propertyName: string) {
    return this.device.property<T>(propertyName);
  }

  public async waitForDevice(): Promise<MiioDevice> {
    if (this.deviceInstance) {
      return this.deviceInstance;
    }

    return new Promise<MiioDevice>((resolve) => {
      this.deviceConnectedResolvers.push(resolve);
    });
  }

  public onStateChanged(listener: (event: StateChangedEvent) => void) {
    this.stateChangedListeners.add(listener);
    return () => this.stateChangedListeners.delete(listener);
  }

  public onErrorChanged(listener: (error: MiioErrorChangedEvent | null) => void) {
    this.errorChangedListeners.add(listener);
    return () => this.errorChangedListeners.delete(listener);
  }

  public async ensureDevice(callingMethod: string) {
    try {
      if (!this.deviceInstance) {
        const errMsg = `${callingMethod} | No vacuum cleaner is discovered yet.`;
        this.log.error(errMsg);
        throw new Error(errMsg);
      }

      // checking if the device has an open socket it will fail retrieving it if not
      // https://github.com/aholstenson/miio/blob/master/lib/network.js#L227
      if (this.deviceInstance.handle.api.parent.socket) {
        this.log.debug(`DEB ensureDevice | ${this.model} | The socket is still on. Reusing it.`);
      }
    } catch (error) {
      const err = error as Error;
      if (/destroyed/i.test(err.message) || /No vacuum cleaner is discovered yet/.test(err.message)) {
        this.log.info(`INF ensureDevice | ${this.model} | The socket was destroyed or not initialised, initialising the device`);
        await this.connect();
      } else {
        this.log.error(err.message, err);
        throw err;
      }
    }
  }

  public stop() {
    if (this.refreshTimer) {
      runtimeTimers.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.stateChangedListeners.clear();
    this.errorChangedListeners.clear();
    this.deviceConnectedResolvers.length = 0;
    this.deviceInstance?.destroy();
    this.deviceInstance = undefined;
  }

  private async connect() {
    if (this.connectingPromise === null) {
      // if already trying to connect, don't trigger yet another one
      this.connectingPromise = this.initializeDevice().catch((error) => {
        this.log.error(`ERR connect | miio.device, next try in 10 seconds | ${error}`);
        runtimeTimers.clearTimeout(this.connectRetry);
        // Using setTimeout instead of holding the promise. This way we'll keep retrying but not holding the other actions
        // eslint-disable-next-line promise/no-nesting
        this.connectRetry = runtimeTimers.setTimeout(() => this.connect().catch(() => {}), 10000);
        throw error;
      });
    }
    try {
      await this.connectingPromise;
      runtimeTimers.clearTimeout(this.connectRetry);
    } finally {
      this.connectingPromise = null;
    }
  }

  private async initializeDevice() {
    this.log.debug('DEB getDevice | Discovering vacuum cleaner');

    const device = await miio.device({ address: this.ip, token: this.token });

    if (device.matches('type:vaccuum')) {
      this.deviceInstance = device;

      this.log.setModel(this.model);

      this.log.info(`STA getDevice | Connected to: ${this.ip}`);
      this.log.info(`STA getDevice | Model: ${this.model}`);
      this.log.info(`STA getDevice | State: ${this.property('state')}`);
      this.log.info(`STA getDevice | FanSpeed: ${this.property('fanSpeed')}`);
      this.log.info(`STA getDevice | BatteryLevel: ${this.property('batteryLevel')}`);

      this.emitDeviceConnected(this.device);

      await this.getState();
      this.refreshTimer = runtimeTimers.setInterval(() => {
        void this.getState();
      }, GET_STATE_INTERVAL_MS);
    } else {
      const model = (device || {}).miioModel;
      this.log.error(
        `Device "${model}" is not registered as a vacuum cleaner! If you think it should be, please open an issue at https://github.com/afharo/matterbridge-xiaomi-roborock/issues/new and provide this line.`,
      );
      this.log.debug(device);
      device.destroy();
    }
  }

  private async getState() {
    try {
      if (this.refreshInProgress) {
        return;
      }
      this.refreshInProgress = true;
      this.log.debug(`DEB getState | ${this.model} | Polling...`);
      await this.ensureDevice('getState');
      await this.device.poll();
      const state = await this.device.state();
      this.log.debug(`DEB getState | ${this.model} | State ${JSON.stringify(state)} | Props ${JSON.stringify(this.device.properties)}`);

      Object.entries(state).forEach(([key, value]) => {
        if (key === 'error') {
          this.emitErrorChanged(value as MiioErrorChangedEvent | null);
        } else {
          this.emitStateChanged({ key, value });
        }
      });

      Object.entries(this.device.properties).forEach(([key, value]) => this.emitStateChanged({ key, value }));
    } catch (err) {
      this.log.error(`getState | ${err}`, err);
    } finally {
      this.refreshInProgress = false;
    }
  }

  private emitErrorChanged(error: MiioErrorChangedEvent | null) {
    if (error === this.lastError) {
      return;
    }
    this.lastError = error;
    for (const listener of this.errorChangedListeners) {
      listener(error);
    }
  }

  private emitDeviceConnected(device: MiioDevice) {
    if (this.deviceConnectedResolvers.length === 0) {
      return;
    }

    const resolvers = this.deviceConnectedResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve(device);
    }
  }

  private emitStateChanged(event: StateChangedEvent) {
    for (const listener of this.stateChangedListeners) {
      listener(event);
    }
  }
}

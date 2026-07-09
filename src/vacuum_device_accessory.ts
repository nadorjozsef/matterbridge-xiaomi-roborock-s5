import { MatterbridgeEndpoint } from 'matterbridge';
import { RoboticVacuumCleaner } from 'matterbridge/devices';
import type { Logger } from 'matterbridge/logger';
import { PowerSource, RvcRunMode, RvcCleanMode, RvcOperationalState, ServiceArea } from 'matterbridge/matter/clusters';

import { applyConfigDefaults, type Config } from './services/config_service.js';
import { DeviceManager } from './services/device_manager.js';
import { getLogger, type ModelLogger } from './utils/logger.js';

type SupportedCleanMode = RvcCleanMode.ModeOption & { miLevels: { vacuum: number; mop?: number } };

type VacuumSpeedLevel = {
  miLevel: number;
  name: string;
  label: RvcCleanMode.ModeTag;
};

const SUPPORTED_MODES: RvcRunMode.ModeOption[] = [
  { label: 'Idle', mode: 1, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
  { label: 'Cleaning', mode: 2, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },

  // I noticed that the matterbridge code has hardcoded 1 and 2 for Idle and Cleaning.
  // However, upgrading from a pre-existing version will fail if 0 is not a valid mode (because of its persisted state).
  // TODO: remove it in a few versions.
  { label: 'Deprecated Idle', mode: 0, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
];

const SUPPORTED_OPERATIONAL_STATES: RvcOperationalState.OperationalStateStruct[] = [
  { operationalStateId: RvcOperationalState.OperationalState.Docked },
  { operationalStateId: RvcOperationalState.OperationalState.SeekingCharger },
  { operationalStateId: RvcOperationalState.OperationalState.Charging },
  { operationalStateId: RvcOperationalState.OperationalState.Running },
  { operationalStateId: RvcOperationalState.OperationalState.Stopped },
  { operationalStateId: RvcOperationalState.OperationalState.Paused },
  { operationalStateId: RvcOperationalState.OperationalState.Error },
];

const S5_MODEL = 'roborock.vacuum.s5';
const S5_MIN_FIRMWARE = [3, 5, 8] as const;
const S5_FAN_SPEEDS: VacuumSpeedLevel[] = [
  { miLevel: -1, name: 'Off', label: RvcCleanMode.ModeTag.Vacuum },
  { miLevel: 105, name: 'Gentle', label: RvcCleanMode.ModeTag.Min },
  { miLevel: 101, name: 'Silent', label: RvcCleanMode.ModeTag.LowNoise },
  { miLevel: 102, name: 'Balanced', label: RvcCleanMode.ModeTag.Auto },
  { miLevel: 103, name: 'Turbo', label: RvcCleanMode.ModeTag.DeepClean },
  { miLevel: 104, name: 'Max', label: RvcCleanMode.ModeTag.Max },
];
const MODE_IDLE = 1;
const MODE_CLEANING = 2;

export class VacuumDeviceAccessory {
  private readonly config: Config;
  private readonly log: ModelLogger;
  private readonly deviceManager: DeviceManager;
  private endpoint?: RoboticVacuumCleaner;
  private serviceAreas: ServiceArea.Area[] = [];
  private readonly stopHandlers: Array<() => void> = [];
  private stateUpdateChain: Promise<void> = Promise.resolve();

  constructor(config: Partial<Config>, logger: Logger) {
    this.config = applyConfigDefaults(config);
    this.log = getLogger(logger, this.config);
    this.deviceManager = new DeviceManager(this.log, this.config);
  }

  public async initializeMatterbridgeEndpoint(): Promise<MatterbridgeEndpoint> {
    this.log.info(`Waiting for the connection to the vacuum to be established...`);

    // Wait for the device to be connected
    await this.deviceManager.waitForDevice();
    this.log.info(`Connected to device!`);

    const serialNumber = await this.deviceManager.device.getSerialNumber().catch((error) => {
      this.log.warn(`Failed to retrieve serial number: ${error}`);
      return 'Unknown';
    });
    const deviceInfo = await this.deviceManager.device.getDeviceInfo().catch((error) => {
      this.log.warn(`Failed to retrieve device info: ${error}`);
      return { fw_ver: 'Unknown' };
    });
    this.log.info(`Serial number: ${serialNumber}`);
    this.log.info(`Firmware: ${deviceInfo.fw_ver}`);

    if (this.deviceManager.model !== S5_MODEL) {
      throw new Error(`Unsupported model: ${this.deviceManager.model}. Only ${S5_MODEL} is supported.`);
    }

    const firmwareMatch = (deviceInfo.fw_ver || '').match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!firmwareMatch) {
      throw new Error(`Unsupported firmware: ${deviceInfo.fw_ver || 'unknown'}. Minimum required is >=${S5_MIN_FIRMWARE.join('.')}.`);
    }

    const [, majorRaw, minorRaw, patchRaw] = firmwareMatch;
    const major = Number(majorRaw);
    const minor = Number(minorRaw);
    const patch = Number(patchRaw);

    const isFirmwareSupported =
      major > S5_MIN_FIRMWARE[0] || (major === S5_MIN_FIRMWARE[0] && (minor > S5_MIN_FIRMWARE[1] || (minor === S5_MIN_FIRMWARE[1] && patch >= S5_MIN_FIRMWARE[2])));

    if (!isFirmwareSupported) {
      throw new Error(`Unsupported firmware: ${deviceInfo.fw_ver}. Minimum required is >=${S5_MIN_FIRMWARE.join('.')}.`);
    }

    const supportedCleanModes = this.supportedCleanModes;

    this.serviceAreas = await this.getServiceAreas().catch((error) => {
      this.log.warn(`Failed to retrieve service areas: ${error}`);
      return [];
    });

    this.endpoint = new RoboticVacuumCleaner(
      this.config.name,
      serialNumber,
      'server', // Use 'server' or 'matter' if you want Apple Home compatibility.
      // RvcRunMode
      SUPPORTED_MODES[0].mode,
      SUPPORTED_MODES,
      // RvcCleanMode
      supportedCleanModes[0].mode,
      supportedCleanModes,
      undefined,
      undefined,
      RvcOperationalState.OperationalState.Docked,
      SUPPORTED_OPERATIONAL_STATES,
      this.serviceAreas.length > 0 ? this.serviceAreas : undefined,
      [],
      this.serviceAreas[0]?.areaId,
    );

    this.endpoint.vendorName = 'Xiaomi';
    this.endpoint.productName = this.deviceManager.model;
    this.endpoint.softwareVersionString = deviceInfo.fw_ver;
    this.endpoint.productUrl = 'https://github.com/afharo/matterbridge-xiaomi-roborock';
    this.endpoint.hardwareVersionString = this.deviceManager.model;

    this.endpoint.lifecycle.destroying.on(() => {
      this.deviceManager.stop();
    });

    this.endpoint.addCommandHandler('RvcCleanMode.changeToMode', async (data) => {
      // Defines the selected cleaning mode (mop or vacuum)
      const newCleanMode = supportedCleanModes[data.request.newMode - 1];
      await this.deviceManager.device.changeFanSpeed(newCleanMode.miLevels.vacuum);
      if (typeof newCleanMode.miLevels.mop === 'number') {
        await this.deviceManager.device.setWaterBoxMode(newCleanMode.miLevels.mop);
      }
    });

    this.endpoint.addCommandHandler('RvcRunMode.changeToMode', async (data) => {
      if (data.request.newMode === MODE_IDLE) {
        return;
      }
      if (data.request.newMode === MODE_CLEANING) {
        await this.activateCleaning('start');
        return;
      }
      this.log.warn(`Unknown mode ${data.request.newMode}`);
    });
    this.endpoint.addCommandHandler('stop', async () => {
      await this.deviceManager.device.deactivateCleaning();
    });
    this.endpoint.addCommandHandler('pause', async () => {
      await this.deviceManager.device.pause();
    });
    this.endpoint.addCommandHandler('resume', async () => {
      await this.activateCleaning('resume');
    });
    this.endpoint.addCommandHandler('goHome', async () => {
      await this.deviceManager.device.activateCharging();
    });
    this.endpoint.addCommandHandler('identify', async () => {
      await this.deviceManager.device.find();
    });
    this.endpoint.addCommandHandler('selectAreas', async (data) => {
      this.log.debug(`Select areas command received: ${data.request.newAreas}`);
    });
    return this.endpoint;
  }

  private async activateCleaning(mode: 'start' | 'resume') {
    const fanSpeedBeforeStart = mode === 'start' ? this.deviceManager.property<number>('fanSpeed') : undefined;
    const selectedAreas = this.getSelectedAreas();
    if (selectedAreas.length === 0) {
      this.log.info(`${mode === 'start' ? 'Initiating' : 'Resuming'} full cleaning...`);
      await this.deviceManager.device.activateCleaning();
    } else {
      this.log.info(`${mode === 'start' ? 'Initiating' : 'Resuming'} room cleaning...`);
      await this.deviceManager.device.cleanRooms(selectedAreas);
    }

    if (mode === 'start' && typeof fanSpeedBeforeStart === 'number') {
      await this.deviceManager.device.changeFanSpeed(fanSpeedBeforeStart);
      this.log.debug(`Restored fan speed after start: ${fanSpeedBeforeStart}.`);
    }
  }

  public async postRegister() {
    const unsubscribeStateChanged = this.deviceManager.onStateChanged(({ key, value }) => {
      this.stateUpdateChain = this.stateUpdateChain
        .then(async () => {
          this.log.debug(`Device state changed: ${key} = ${value}`);

          if (key in this.stateChangedHandlers) {
            // @ts-expect-error key is a string, this.stateChangedHandlers is not an index signature, and value is unknown
            await this.stateChangedHandlers[key](value);
          }
        })
        .catch((error) => {
          this.log.error(`Failed handling device state change: ${error}`, error as Error);
        });
    });
    this.stopHandlers.push(unsubscribeStateChanged);

    // Force-set the currentArea attribute to null, as we're not able to retrieve the current area at the moment.
    await this.endpoint?.updateAttribute(ServiceArea.Cluster.id, 'currentArea', null);

    // If no areas are found, we need to clear the serviceAreas and the currentArea attributes
    // (the constructor doesn't allow setting them to null as it fallbacks to defaults).
    if (this.serviceAreas.length === 0) {
      await this.endpoint?.updateAttribute(ServiceArea.Cluster.id, 'currentArea', null);
      await this.endpoint?.updateAttribute(ServiceArea.Cluster.id, 'supportedAreas', []);
    }
  }

  public stop() {
    this.stopHandlers.splice(0).forEach((stopHandler) => stopHandler());
    this.deviceManager.stop();
  }

  private readonly stateChangedHandlers = {
    batteryLevel: async (level: number) => {
      this.log.debug(`Battery level: ${level}`);
      await this.endpoint?.updateAttribute(PowerSource.Cluster.id, 'batPercentRemaining', level * 2);
      await this.endpoint?.updateAttribute(PowerSource.Cluster.id, 'batChargeLevel', getBatteryChargeLevel(level));
    },
    charging: async (charging: boolean) => {
      const isCharging = !!charging === true;
      const isChargingAndFull = isCharging && this.deviceManager.property<number>('batteryLevel') === 100;

      await this.endpoint?.updateAttribute(
        PowerSource.Cluster.id,
        'batChargeState',
        isChargingAndFull ? PowerSource.BatChargeState.IsAtFullCharge : isCharging ? PowerSource.BatChargeState.IsCharging : PowerSource.BatChargeState.IsNotCharging,
      );
      if (isChargingAndFull) {
        await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Docked);
      } else if (isCharging) {
        await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Charging);
      }
    },
    cleaning: async (cleaning: boolean) => {
      if (this.deviceManager.property('state') === 'error' || this.deviceManager.property('state') === 'paused') {
        return; // Do not update the state if there is an error or paused
      }
      await this.endpoint?.updateAttribute(RvcRunMode.Cluster.id, 'currentMode', cleaning === false ? SUPPORTED_MODES[0].mode : SUPPORTED_MODES[1].mode);
      if (cleaning) {
        await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Running);
      }
    },
    cleaningMode: async (cleaningMode: string) => {
      if (this.deviceManager.property<string>('state') === 'paused') {
        await this.stateChangedHandlers.cleaning(false);
      } else {
        await this.stateChangedHandlers.cleaning(['cleaning', 'zone-cleaning', 'spot-cleaning', 'room-cleaning', 'manual-cleaning'].includes(cleaningMode));
      }
    },
    in_returning: async (inReturning: number) => {
      if (this.deviceManager.property('state') === 'paused') {
        return;
      }
      if (inReturning) {
        await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.SeekingCharger);
      }
    },
    fanSpeed: async (miLevel: number) => {
      const currentMopLevel = this.deviceManager.property<number>('water_box_mode');
      const cleanMode = this.supportedCleanModes.find(({ miLevels }) => miLevels.vacuum === miLevel && miLevels.mop === currentMopLevel);
      if (cleanMode) {
        await this.endpoint?.updateAttribute(RvcCleanMode.Cluster.id, 'currentMode', cleanMode.mode);
      }
    },
    water_box_mode: async (miLevel: number) => {
      const currentVacuumLevel = this.deviceManager.property<number>('fanSpeed');
      const cleanMode = this.supportedCleanModes.find(({ miLevels }) => miLevels.mop === miLevel && miLevels.vacuum === currentVacuumLevel);
      if (cleanMode) {
        await this.endpoint?.updateAttribute(RvcCleanMode.Cluster.id, 'currentMode', cleanMode.mode);
      }
    },
    state: async (state: string) => {
      await this.stateChangedHandlers.charging(state === 'charging');
      switch (state) {
        case 'charging':
          // No need to call it again, as it's called 3 lines above.
          // await this.stateChangedHandlers.charging(true);
          break;

        case 'paused':
          // await this.endpoint?.updateAttribute(RvcRunMode.Cluster.id, 'currentMode', SUPPORTED_MODES[0].mode);
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Paused);
          break;

        case 'cleaning':
        case 'spot-cleaning':
        case 'room-cleaning':
        case 'zone-cleaning':
        case 'sweeping':
        case 'mopping':
        case 'sweeping-and-mopping':
          await this.endpoint?.updateAttribute(RvcRunMode.Cluster.id, 'currentMode', SUPPORTED_MODES[1].mode);
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Running);
          break;

        case 'returning': // We might want to emit the optional RvcOperationalState.Cluster.events.operationCompletion when completed cleaning (or when errors occur)
        case 'docking':
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.SeekingCharger);
          break;

        case 'error':
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Error);
          // await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalError', RvcOperationalState.ErrorState.CommandInvalidInState);
          // We might want to emit the optional RvcOperationalState.Cluster.events.operationCompletion when completed cleaning (or when errors occur)
          break;

        case 'fully-charged':
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Docked);
          break;

        case 'charging-error':
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Error);
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalError', RvcOperationalState.ErrorState.FailedToFindChargingDock);
          break;

        case 'initializing':
        case 'idle':
        case 'sleeping':
          await this.endpoint?.updateAttribute(RvcRunMode.Cluster.id, 'currentMode', SUPPORTED_MODES[0].mode);
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Stopped);
          break;

        default:
          this.log.warn(`Unknown state: ${state}`);
          break;
      }
    },
  };

  private async getServiceAreas(): Promise<ServiceArea.Area[]> {
    const timers = await this.deviceManager.device.getTimer();
    if (timers.length > 0) {
      const timer = timers.find(([id, status, definition]) => {
        if (['off', 'disabled'].includes(status)) {
          const [cronExpression, action] = definition;
          // Who sets up a timer that runs at midnight for a Vacuum Cleaner? This should be it.
          if (cronExpression.startsWith('0 0 * *')) {
            const [, params] = action;
            if (params.segments) {
              this.log.debug(`Potential timer found with ID ${id}: ${JSON.stringify(action)}}`);
              return true;
            }
          }
        }
        return false;
      });
      if (timer) {
        const segments = timer[2][1][1].segments.split(',');
        return segments.map(
          (roomId, index): ServiceArea.Area => ({
            areaId: parseInt(roomId),
            mapId: null,
            areaInfo: {
              locationInfo: {
                // Can't know the name in these models. Users will need to rename it in their apps.
                locationName: this.config.roomNames?.[index] || `Room ${roomId}`,
                floorNumber: null,
                areaType: null,
              },
              landmarkInfo: null,
            },
          }),
        );
      }
    }
    return [];
  }

  private getSelectedAreas(): number[] {
    const selectedAreas = (this.endpoint?.getAttribute(ServiceArea.Cluster.id, 'selectedAreas') as number[] | undefined) ?? [];
    // If all selected, return empty array to trigger full cleaning
    if (selectedAreas.length === this.serviceAreas.length) {
      return [];
    }
    return selectedAreas;
  }

  private get supportedCleanModes(): Array<SupportedCleanMode> {
    const [, ...vacuumSpeedModes] = S5_FAN_SPEEDS;

    let mode = 1;

    const supportedCleanModes: SupportedCleanMode[] = vacuumSpeedModes.map(({ name, miLevel, label }) => ({
      label: `${name} Vacuum`,
      mode: mode++,
      modeTags: [
        // If the label is "Mop", do not add "Vacuum" as a mode tag.
        ...(label === RvcCleanMode.ModeTag.Mop ? [] : [{ value: RvcCleanMode.ModeTag.Vacuum }]),
        { value: label },
      ],
      miLevels: {
        vacuum: miLevel,
      },
    }));

    return supportedCleanModes;
  }
}

/**
 *
 * @param {number} batteryLevel The battery level in percentage
 * @returns {PowerSource.BatChargeLevel} The battery charge level (OK, Warning, Critical)
 */
function getBatteryChargeLevel(batteryLevel: number): PowerSource.BatChargeLevel {
  return batteryLevel < 10 ? PowerSource.BatChargeLevel.Critical : batteryLevel < 20 ? PowerSource.BatChargeLevel.Warning : PowerSource.BatChargeLevel.Ok;
}


// keel-native-bridge.js - Capacitor wrapper enabling Bluetooth + Location for Keel PWA
import { BluetoothLe } from '@capacitor-community/bluetooth-le';
import { Geolocation } from '@capacitor/geolocation';
import { Health } from '@capacitor-community/health';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { App } from '@capacitor/app';

class KeelNativeWrapper {
  constructor() {
    this.connectedDevice = null;
    this.isScanning = false;
    this.watchers = {};
    console.log('[KEEL Native] Wrapper initialized');
  }

  // === PERMISSIONS ===
  async requestAllPermissions() {
    try {
      // Location
      const locPerm = await Geolocation.requestPermissions();
      console.log('[KEEL] Location permission:', locPerm);

      // Bluetooth (Android 12+ needs explicit)
      try {
        await BluetoothLe.initialize();
        console.log('[KEEL] Bluetooth initialized');
      } catch(e){ console.warn('[KEEL] BT init', e); }

      // Health
      try {
        const healthAvailable = await Health.isAvailable();
        if(healthAvailable) {
          await Health.requestAuthorization({
            read: ['heart_rate','steps','sleep','workout','blood_oxygen','calories']
          });
        }
      } catch(e){ console.warn('[KEEL] Health auth', e); }

      // Notifications for abnormality alerts
      try {
        await LocalNotifications.requestPermissions();
      } catch(e){}

      return true;
    } catch(err) {
      console.error('[KEEL] Permission error', err);
      return false;
    }
  }

  // === BLUETOOTH - SCAN ANY WATCH / WEAR GEAR ===
  async scanForWearables(onDeviceFound) {
    if(this.isScanning) return;
    this.isScanning = true;

    try {
      await BluetoothLe.initialize();

      // Scan for ALL devices with health services - this finds any smartwatch, Apple Watch (as BLE), fitness band, chest strap
      await BluetoothLe.requestLEScan({
        services: [
          '0000180d-0000-1000-8000-00805f9b34fb', // heart_rate
          '0000180f-0000-1000-8000-00805f9b34fb', // battery_service
          '0000180a-0000-1000-8000-00805f9b34fb', // device_information
          '0000180e-0000-1000-8000-00805f9b34fb', // running speed
          '0000180b-0000-1000-8000-00805f9b34fb'  // current time - many watches advertise this
        ],
        allowDuplicates: false,
        scanMode: 2 // low latency
      });

      const listener = await BluetoothLe.addListener('onScanResult', (result) => {
        const device = result.device;
        // Filter for watch-like names but also allow any health device
        const isWearable = /watch|band|fit|polar|garmin|whoop|oura|suunto|coros|huawei|amazfit|mi band|chest|hrm/i.test(device.name||'') || 
                          result.localName || 
                          result.serviceData || 
                          true; // accept all for "any wear gear"
        
        if(onDeviceFound) onDeviceFound({
          deviceId: device.deviceId,
          name: device.name || result.localName || 'Unknown Wearable',
          rssi: result.rssi,
          raw: result
        });
      });

      this.scanListener = listener;

      // Auto stop after 15s
      setTimeout(()=> this.stopScan(), 15000);

    } catch(err) {
      console.error('[KEEL] Scan failed', err);
      this.isScanning = false;
      throw err;
    }
  }

  async stopScan() {
    try {
      await BluetoothLe.stopLEScan();
      if(this.scanListener) {
        await this.scanListener.remove();
        this.scanListener = null;
      }
    } catch(e){}
    this.isScanning = false;
  }

  async connectToDevice(deviceId) {
    try {
      await BluetoothLe.connect({ deviceId });
      this.connectedDevice = deviceId;
      console.log('[KEEL] Connected to', deviceId);

      // Discover services - get device info
      const services = await BluetoothLe.getServices({ deviceId });
      
      let deviceInfo = { deviceId, services: services.services?.length };
      
      // Try to read device information service
      try {
        const devInfoService = services.services.find(s=> s.uuid.toLowerCase().includes('180a'));
        if(devInfoService) {
          for(const char of devInfoService.characteristics || []) {
            try {
              const result = await BluetoothLe.read({ deviceId, service: devInfoService.uuid, characteristic: char.uuid });
              const decoder = new TextDecoder();
              const value = decoder.decode(Uint8Array.from(atob(result.value), c=>c.charCodeAt(0)));
              deviceInfo[char.uuid] = value;
            } catch(e){}
          }
        }
      } catch(e){}

      // Start heart rate notifications if available
      try {
        await this.startHeartRateNotifications(deviceId);
      } catch(e){ console.warn('HR notify not available', e); }

      // Battery
      try {
        await this.readBattery(deviceId);
      } catch(e){}

      return deviceInfo;
    } catch(err) {
      console.error('[KEEL] Connect failed', err);
      throw err;
    }
  }

  async startHeartRateNotifications(deviceId) {
    const service = '0000180d-0000-1000-8000-00805f9b34fb';
    const characteristic = '00002a37-0000-1000-8000-00805f9b34fb';
    
    await BluetoothLe.startNotifications({
      deviceId,
      service,
      characteristic
    });

    await BluetoothLe.addListener('onNotification', (notif) => {
      if(notif.characteristic === characteristic) {
        const data = this.parseHeartRate(notif.value);
        console.log('[KEEL] HR:', data);
        // Emit to web app
        window.dispatchEvent(new CustomEvent('keel:heartrate', { detail: data }));
        // Check abnormality
        this.checkAbnormality(data);
      }
    });
  }

  parseHeartRate(base64Value) {
    try {
      const bytes = Uint8Array.from(atob(base64Value), c=>c.charCodeAt(0));
      const flags = bytes[0];
      const is16Bit = flags & 0x01;
      const hr = is16Bit ? (bytes[1] | (bytes[2] << 8)) : bytes[1];
      return { heartRate: hr, timestamp: Date.now(), raw: bytes };
    } catch(e){ return { heartRate: 0 } }
  }

  async readBattery(deviceId) {
    try {
      const result = await BluetoothLe.read({
        deviceId,
        service: '0000180f-0000-1000-8000-00805f9b34fb',
        characteristic: '00002a19-0000-1000-8000-00805f9b34fb'
      });
      const bytes = Uint8Array.from(atob(result.value), c=>c.charCodeAt(0));
      const level = bytes[0];
      window.dispatchEvent(new CustomEvent('keel:battery', { detail: { level } }));
      return level;
    } catch(e){ return null; }
  }

  // === LOCATION ===
  async getCurrentLocation() {
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
  }

  async watchLocation(callback) {
    const id = await Geolocation.watchPosition({ enableHighAccuracy: true }, (pos, err) => {
      if(err){ console.error(err); return; }
      if(pos) callback({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    });
    this.watchers[id] = id;
    return id;
  }

  // === HEALTH DATA (Apple Watch via HealthKit / WearOS via Health Connect) ===
  async getHealthData() {
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 24*60*60*1000);
      
      const hrData = await Health.queryAggregated({
        startDate: start.toISOString(),
        endDate: now.toISOString(),
        dataType: 'heart_rate'
      }).catch(()=>null);

      const steps = await Health.queryAggregated({
        startDate: start.toISOString(),
        endDate: now.toISOString(),
        dataType: 'steps'
      }).catch(()=>null);

      return { heartRate: hrData, steps };
    } catch(e){
      console.warn('[KEEL] Health query', e);
      return null;
    }
  }

  // === ABNORMALITY NOTIFICATION ===
  async checkAbnormality({ heartRate }) {
    if(!heartRate) return;
    const abnormal = heartRate < 50 || heartRate > 150;
    if(abnormal) {
      try {
        await Haptics.notification({ type: NotificationType.Alarm });
        await LocalNotifications.schedule({
          notifications: [{
            title: 'KEEL Health Alert',
            body: `Abnormal heart rate detected: ${heartRate} BPM`,
            id: Date.now(),
            schedule: { at: new Date(Date.now()+100) }
          }]
        });
      } catch(e){}
      window.dispatchEvent(new CustomEvent('keel:abnormal', { detail: { heartRate } }));
    }
  }

  async disconnect() {
    if(this.connectedDevice) {
      try { await BluetoothLe.disconnect({ deviceId: this.connectedDevice }); } catch(e){}
      this.connectedDevice = null;
    }
  }
}

window.KeelNative = new KeelNativeWrapper();
// Auto-request permissions on app start
document.addEventListener('DOMContentLoaded', () => {
  window.KeelNative.requestAllPermissions();
});

export default window.KeelNative;

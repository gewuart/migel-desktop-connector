export const MIGEL_VERSION_NAME = '0.2.0';
export const MIGEL_VERSION_CODE = 20;
export const MIGEL_BRIDGE_VERSION = MIGEL_VERSION_NAME;
export const MIGEL_DESKTOP_CONNECTOR_VERSION = MIGEL_VERSION_NAME;
export const MIGEL_CONNECTOR_PROTOCOL_VERSION = 3;

export function createMigelComponentVersions() {
  return {
    appVersionName: MIGEL_VERSION_NAME,
    appVersionCode: MIGEL_VERSION_CODE,
    bridgeVersion: MIGEL_BRIDGE_VERSION,
    desktopConnectorVersion: MIGEL_DESKTOP_CONNECTOR_VERSION,
    connectorProtocolVersion: MIGEL_CONNECTOR_PROTOCOL_VERSION,
    components: {
      bridge: {
        name: 'Hermes Migel Bridge',
        version: MIGEL_BRIDGE_VERSION,
      },
      desktopConnector: {
        name: 'Migel Desktop Connector',
        version: MIGEL_DESKTOP_CONNECTOR_VERSION,
      },
      protocol: {
        gatewayChatVersion: MIGEL_CONNECTOR_PROTOCOL_VERSION,
      },
    },
  };
}

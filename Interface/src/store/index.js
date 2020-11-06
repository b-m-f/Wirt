import Vue from "vue";
import Vuex from "vuex";
import createPersistedState from "vuex-persistedstate";
import QRCode from "qrcode";
import i18n from "../i18n";
import { generateSigningKeys, getKeys } from "@wirtbot/crypto";
import { generateDNSFile, generateDeviceConfig, generateServerConfig } from "@wirtbot/config-generators";
import { updateServerConfig as updateServerViaApi, updateDNSConfig as updateDNSConfigViaApi } from "../api";


import alerts from "./modules/alerts";

async function addConfigToDevice(newDevice, server) {
  const config = generateDeviceConfig(newDevice, server);
  if (newDevice.type === "Android" || newDevice.type === "iOS") {
    const qr = await QRCode.toDataURL(config);

    return Object.assign({}, newDevice, {
      config,
      qr,
    });
  }
  return Object.assign({}, newDevice, {
    config,
    qr: undefined,
  });
}

Vue.use(Vuex);

const store = new Vuex.Store({
  modules: { alerts },
  state: {
    version: "1.4.2",
    keys: undefined,
    server: {
      ip: { v4: [undefined, undefined, undefined, undefined], v6: "" },
      port: undefined,
      keys: undefined,
      config: "",
      subnet: { v4: "10.10.0.", v6: "1010:1010:1010:1010:" },
      hostname: "",
    },
    devices: [
      /* {ip: {v4, v6}, name, type, id}*/
    ],
    deviceTypes: ["Android", "Windows", "MacOS", "iOS", "Linux", "FreeBSD"],
    websiteBeingViewedOnMobileDevice: undefined,
    network: {
      dns: {
        name: "wirt.internal", config: "", ip: { v4: [1, 1, 1, 1] },
        tlsName: "cloudflare-dns.com", tls: true
      }
    },
    dashboard: {
      // Messages have to be defined in pages/Dashboard/messages.js
      messages: [],
      hiddenWidgets: [],
      firstUse: true,
      expertMode: false
    },
  },
  mutations: {
    disableFirstUse(state) {
      state.dashboard.firstUse = false;
    },
    resetToFirstUse(state) {
      state.firstUse = true;
    },
    setKeys(state, keys) {
      state.keys = keys;
    },
    setMobileView(state) {
      state.websiteBeingViewedOnMobileDevice = true;
    },
    setNotMobileView(state) {
      state.websiteBeingViewedOnMobileDevice = false;
    },
    updateServer(state, server) {
      Object.keys(server).forEach((key) => {
        if (server[key] !== undefined && server[key] !== null) {
          state.server[key] = server[key];
        }
      });
    },
    removeDevicesWithoutId(state) {
      state.devices = state.devices.filter((device) => device.id);
    },
    removeDevice(state, id) {
      state.devices = state.devices.filter((device) => device.id !== id);
    },
    addDevice(state, device) {
      state.devices = [...state.devices, device];
    },
    updateServerConfig(state, config) {
      state.server = Object.assign({}, state.server, {
        config: config,
      });
    },
    updateDevices(state, devices) {
      state.devices = devices;
    },
    updateDNSName(state, name) {
      state.network.dns.name = name;
    },
    updateDNSTls(state, { tlsName, tls }) {
      state.network.dns.tls = tls;
      state.network.dns.tlsName = tlsName;
    },
    updateDNSIp(state, { v4, v6 }) {
      if (v4) {
        state.network.dns.ip = Object.assign({}, state.network.dns.ip, { v4 });
      }
      if (v6) {
        state.network.dns.ip = Object.assign({}, state.network.dns.ip, { v6 });
      }
    },
    updateDNSConfig(state, config) {
      state.network.dns.config = config;
    },
    updateExpertMode(state, enabled) {
      state.dashboard.expertMode = enabled;
    },
    updateDashboard(state, { messages, widgets }) {
      if (messages) {
        state.dashboard.messages = messages;
      }
      if (widgets) {
        state.dashboard.widgets = widgets;
      }
    },
  },
  actions: {
    async generateKeys({ commit }) {
      const keys = await generateSigningKeys();
      commit("setKeys", keys);
    },
    async disableFirstUse({ commit }) {
      commit("disableFirstUse");
    },
    async updateDNSName({ commit, dispatch }, name) {
      commit("updateDNSName", name);
      dispatch("updateDNS");
    },
    async updateDNSIp({ commit, dispatch }, { v4, v6 }) {
      commit("updateDNSIp", { v4, v6 });
      dispatch("updateDNS");
    },
    async updateDNSTls({ commit, dispatch }, { tlsName, tls }) {
      commit("updateDNSTls", { tlsName, tls });
      if (tls == true && tlsName) {
        dispatch("updateDNS");
      }
    },
    async addDashboardMessage({ state, commit }, message) {
      commit("updateDashboard", {
        messages: [...state.dashboard.messages, message],
      });
    },
    async removeDashboardMessage({ state, commit }, message) {
      const messagesWithoutMessage = state.dashboard.messages.filter((msg) => {
        return msg.title !== message.title;
      });
      commit("updateDashboard", { messages: messagesWithoutMessage });
    },
    async addDashboardWidget({ state, commit }, widget) {
      commit("updateDashboard", {
        widgets: [...state.dashboard.widgets, widget],
      });
    },
    async removeDashboardWidget({ state, commit }, widget) {
      const widgetsWithoutWidget = state.dashboard.widgets.filter((wgt) => {
        return wgt !== widget;
      });
      commit("updateDashboard", { widgets: widgetsWithoutWidget });
    },
    async updateServer({ state, commit, dispatch }, server) {
      if (!state.server.keys) {
        server.keys = await getKeys();
      }
      commit("updateServer", server);
      await dispatch("updateServerConfig");
      // only rebuild device configs if necessary parts of the server config changed
      if (
        server.ip ||
        server.port ||
        server.keys ||
        server.hostname ||
        server.hostname === "" ||
        server.subnet
      ) {
        await dispatch("updateDeviceConfigs");
      }
    },
    async updateDeviceConfigs({ commit, state }) {
      const devices = await Promise.all(
        state.devices.map(async (device) => {
          return await addConfigToDevice(device, state.server);
        })
      );
      commit("updateDevices", devices);
    },
    async updateExpertMode({ commit }, enabled) {
      commit("updateExpertMode", enabled);
    },
    async updateServerConfig({ commit, state, dispatch }) {
      const config = generateServerConfig(
        state.server,
        state.devices.filter((device) => device.ip && device.keys)
      );
      commit("updateServerConfig", config);
      // Since the server config gets updated with every device change, this is a place to trigger remote updates 
      // on the WirtBot
      dispatch("sendConfigUpdatesToAPI");
      dispatch("updateDNS");
    },
    async updateDNS({ state, commit }) {
      commit("updateDNSConfig", generateDNSFile(state.server, state.devices, state.network));
      console.log(state.network)
      if (state.network.dns.name) {
        updateDNSConfigViaApi(state.network.dns.config, `wirtbot.${state.network.dns.name}`);
      } else {
        updateDNSConfigViaApi(state.network.dns.config, `${state.server.subnet.v4}1`);
      }
    },
    async sendConfigUpdatesToAPI({ state }) {
      if (state.network.dns.name) {
        updateServerViaApi(state.server.config, `wirtbot.${state.network.dns.name}`);
      } else {
        updateServerViaApi(state.server.config, `${state.server.subnet.v4}1`);
      }
    },
    async addDevice(
      { commit, dispatch, state },
      { id, name, ip, type, routed, additionalDNSServers, MTU }
    ) {
      try {
        const keys = await getKeys();
        const newDevice = await addConfigToDevice(
          { id, keys, name, ip, type, routed, additionalDNSServers, MTU },
          state.server
        );
        commit("addDevice", newDevice);
        dispatch("updateServerConfig");
      } catch (error) {
        if (error.message === "No Server") {
          dispatch(
            "alerts/addWarning",
            `${i18n.t("warnings.deviceAdd")} ${i18n.t("warnings.noServer")}`
          );
        } else {
          dispatch(
            "alerts/addWarning",
            `${i18n.t("warnings.deviceAdd")} ${i18n.t(
              "warnings.documentation"
            )}`
          );
          console.error(error);
        }
      }
    },
    async updateDevice({ state, commit, dispatch }, newDevice) {
      const devices = await Promise.all(
        state.devices.map(async (device) => {
          if (device.id === newDevice.id) {
            // This is so heavily guarded as to make sure that
            // the server is already set up
            // and the device form completed.
            // Otherwise this would execute while editing the device form
            if (
              newDevice.type &&
              newDevice.ip &&
              newDevice.keys &&
              state.server.port &&
              state.server.keys
            ) {
              return await addConfigToDevice(newDevice, state.server);
            }
            return newDevice;
          }
          return device;
        })
      );
      commit("updateDevices", devices);
      dispatch("updateServerConfig", devices);
    },
    removeDevice({ dispatch, commit }, { id }) {
      try {
        commit("removeDevice", id);
        dispatch("alerts/addSuccess", i18n.t("success.deviceRemoved"));
        dispatch("updateServerConfig");
      } catch (error) {
        dispatch(
          "alerts/addWarning",
          `${i18n.t("warnings.deviceRemove")} ${i18n.t(
            "warnings.documentation"
          )}`
        );
        console.error(error);
      }
    },
    removeDevicesWithoutId({ commit }) {
      commit("removeDevicesWithoutId");
    },
  },

  plugins: [createPersistedState({
    filter(stateChange) {
      if (stateChange.type.includes("alerts/")) {
        return false;
      }
      else {
        return true;
      }
    }
  })],
});


export default store;

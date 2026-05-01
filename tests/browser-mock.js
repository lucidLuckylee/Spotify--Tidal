// Minimal browser API stubs for testing extension code in Node

const storage = {};

globalThis.browser = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storage[key] };
        const result = {};
        for (const k of Array.isArray(key) ? key : Object.keys(key)) {
          if (k in storage) result[k] = storage[k];
        }
        return result;
      },
      async set(obj) {
        Object.assign(storage, obj);
      },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          delete storage[k];
        }
      },
      _clear() {
        for (const k of Object.keys(storage)) delete storage[k];
      },
    },
  },
  runtime: {
    sendMessage: async () => ({}),
    onMessage: {
      addListener() {},
      removeListener() {},
    },
  },
  tabs: {
    query: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    sendMessage: async () => ({}),
    onUpdated: {
      addListener() {},
      removeListener() {},
    },
  },
  webRequest: {
    onHeadersReceived: { addListener() {} },
    onBeforeSendHeaders: { addListener() {} },
  },
};

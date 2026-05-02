// Storage wrapper around browser.storage.local

const Storage = {
  async saveLibrary(library) {
    library.importedAt = new Date().toISOString();
    await browser.storage.local.set({ library });
  },

  async getLibrary() {
    const result = await browser.storage.local.get("library");
    return result.library || null;
  },

  async clearLibrary() {
    await browser.storage.local.remove(["library", "exportState", "exportedTrackIds"]);
  },

  async updateExportState(exportState) {
    await browser.storage.local.set({ exportState });
  },

  async getExportState() {
    const result = await browser.storage.local.get("exportState");
    return result.exportState || {
      tidalMatched: [],
      tidalFailed: [],
      progress: { current: 0, total: 0 },
    };
  },

  async saveTokens(tokens) {
    await browser.storage.local.set({ tokens });
  },

  async getTokens() {
    const result = await browser.storage.local.get("tokens");
    return result.tokens || {};
  },

  async saveSpotifyAuth(auth) {
    await browser.storage.local.set({ spotifyAuth: auth });
  },

  async getSpotifyAuth() {
    const result = await browser.storage.local.get("spotifyAuth");
    return result.spotifyAuth || {};
  },

  async getExportedIds() {
    const result = await browser.storage.local.get("exportedTrackIds");
    return new Set(result.exportedTrackIds || []);
  },

  async addExportedIds(ids) {
    const existing = await this.getExportedIds();
    for (const id of ids) existing.add(id);
    await browser.storage.local.set({ exportedTrackIds: [...existing] });
  },
};

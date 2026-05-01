// Content script for listen.tidal.com

(function () {
  // Listen for messages from background
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.action === "PING") {
      return Promise.resolve({ pong: true, service: "tidal" });
    }
  });
})();

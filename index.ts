import { Plugin } from "@opencode/plugin"

/**
 * Server entry for ascii-whales. The whole plugin lives in the TUI entry
 * (tui.tsx); this stub only registers the plugin with the server so it shows
 * up in /plugins and can carry future server-side state.
 */
export default Plugin.define({
  id: "ascii-whales",
  setup() {},
})

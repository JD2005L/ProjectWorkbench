#!/bin/bash
# Ensure the "completed tab" notification wiring exists inside the container.
#
# The dashboard lights a project card when its agent finishes a turn. Detection
# (server.js `projectHasUnreadBell`) is primarily the live tmux bell: Claude rings
# the terminal bell on turn-end, tmux records it as `window_bell_flag`, and the
# server reads it — no hook, and nothing that IS_SANDBOX can suppress.
#
# This makes that reliable, idempotently on every container start:
#   1) create the legacy pending-marker dir (OR'd fallback the server also reads);
#   2) set Claude's notification channel to `terminal_bell` so it rings the bell
#      on turn-end (a setting, not a hook — unaffected by IS_SANDBOX);
#   3) register pw-stop-hook.sh as a Stop hook (older file-marker fallback);
#   4) give Copilot CLI the same turn-end bell. Copilot has NO equivalent of
#      preferredNotifChannel, so its panes never rang and the tab/rail stayed dark.
#      It does have an `agentStop` hook, so pw-agent-done.sh rings the bell there.
#      Verified on Copilot CLI 1.0.80: hooks load from ~/.copilot/settings.json and
#      the hook's stdin is the payload, so the BEL has to go to /dev/tty.
#
# Applied to both agent HOMEs: /home/admin (project tabs) and /root (API-created
# windows). Mirrors the ensure-deploy-toolchain.sh self-heal pattern.
set -e

PENDING=/var/lib/project-workbench/pending
HOOK=/opt/project-workbench/scripts/pw-stop-hook.sh

mkdir -p "$PENDING"
chmod 0777 "$PENDING" 2>/dev/null || true

for HOME_DIR in /home/admin /root; do
  [ -d "$HOME_DIR" ] || continue
  CFG="$HOME_DIR/.claude"
  mkdir -p "$CFG"
  node -e '
    const fs = require("fs");
    const [file, hook] = process.argv.slice(1);
    let s = {};
    try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
    if (!s || typeof s !== "object" || Array.isArray(s)) s = {};
    let changed = false;

    // (2) Ring the terminal bell on turn-end notifications, unless the operator
    // has already chosen a channel.
    if (!s.preferredNotifChannel) { s.preferredNotifChannel = "terminal_bell"; changed = true; }

    // (3) Register the file-marker Stop hook as a fallback (merged, deduped).
    if (fs.existsSync(hook)) {
      if (!s.hooks || typeof s.hooks !== "object") s.hooks = {};
      const stop = Array.isArray(s.hooks.Stop) ? s.hooks.Stop : [];
      const has = stop.some(g => g && Array.isArray(g.hooks) && g.hooks.some(h => h && h.command === hook));
      if (!has) { stop.push({ hooks: [{ type: "command", command: hook }] }); s.hooks.Stop = stop; changed = true; }
    }

    if (changed) { fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n"); console.log("[notify-wiring] updated " + file); }
    else { console.log("[notify-wiring] " + file + " already configured"); }
  ' "$CFG/settings.json" "$HOOK"
done

# --- Copilot CLI: agentStop hook (its only turn-end signal) ------------------
DONE_HOOK=/opt/project-workbench/scripts/pw-agent-done.sh

for HOME_DIR in /home/admin /root; do
  [ -d "$HOME_DIR" ] || continue
  [ -x "$DONE_HOOK" ] || continue
  CFG="$HOME_DIR/.copilot"
  mkdir -p "$CFG"
  node -e '
    const fs = require("fs");
    const [file, hook] = process.argv.slice(1);
    let s = {}, existed = fs.existsSync(file);
    if (existed) {
      // Unlike .claude/settings.json this file is hand-edited by operators, so a
      // parse failure must NOT be silently replaced with {} — that would discard
      // their model/effortLevel/allowedUrls. Skip and let a human look.
      try { s = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (e) { console.log("[notify-wiring] " + file + " is not valid JSON — skipped"); process.exit(0); }
    }
    if (!s || typeof s !== "object" || Array.isArray(s)) s = {};
    if (!s.hooks || typeof s.hooks !== "object") s.hooks = {};
    const grp = Array.isArray(s.hooks.agentStop) ? s.hooks.agentStop : [];
    // Match on the script NAME, not the full path: an instance may already be wired
    // to an interim copy (e.g. ~/.local/bin/pw-agent-done.sh) and re-pointing it here
    // would just ring twice. Basename dedupe makes the two converge.
    const name = hook.replace(/^.*\//, "");
    const has = grp.some(g => g && Array.isArray(g.hooks)
      && g.hooks.some(h => h && typeof h.command === "string" && h.command.replace(/^.*\//, "").split(" ")[0] === name));
    if (has) { console.log("[notify-wiring] " + file + " already rings on agentStop"); process.exit(0); }
    grp.push({ hooks: [{ type: "command", command: hook }] });
    s.hooks.agentStop = grp;
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
    console.log("[notify-wiring] wired agentStop in " + file);
  ' "$CFG/settings.json" "$DONE_HOOK"
done

# Keep admin's configs admin-owned (the /root copies stay root-owned). Copilot in
# particular exits 1 with no output when its own config files are not readable by
# the pane account.
chown -R admin:admin /home/admin/.claude /home/admin/.copilot 2>/dev/null || true

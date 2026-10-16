// How a session created through the agent API (docs/agent-mcp.md) is launched,
// and how to tell whether its CLI is ready for a prompt.
//
// An API-created session has nobody at the keyboard. Three things used to stop
// one and wait for a human, and each is answered here or beside it:
//
//   1. The workspace-trust dialog. A pasted prompt's Enter picked "No, exit",
//      Claude quit, and the lane was left at a bash prompt. The workspace is
//      pre-trusted in the config the session actually reads (server.js
//      newTmuxWindow → trustUserClaudeProject), and readiness below refuses to
//      paste into any dialog rather than letting Enter choose for us.
//   2. Per-tool permission prompts. The session runs in `auto` permission mode,
//      which approves routine work and REFUSES risky actions instead of asking,
//      with a deny list for anything that deploys or reaches a host.
//   3. Whose instructions these are. An appended system prompt names the person
//      the token acts for and the token's label, so the agent can tell a work
//      order carries that person's authority.
//
// Interactive sessions a person opens are untouched: nothing here runs unless
// the window was created by createAgentSessions().prompt().
//
// ONE PLACE TO CONFIGURE, from the dashboard's environment:
//
//   PW_AGENT_AUTONOMOUS=false            launch plain `claude`, as before this existed
//   PW_AGENT_CLAUDE_PERMISSION_MODE      auto (default) | acceptEdits | manual | plan | dontAsk
//   PW_AGENT_CLAUDE_DISALLOWED_TOOLS     comma-separated rules; REPLACES the default list
//   PW_AGENT_CLAUDE_ALLOWED_TOOLS        comma-separated rules; default none in auto mode,
//                                        a build/test/git list in acceptEdits mode
//   PW_AGENT_SYSTEM_PROMPT               template; {user} and {label} are filled in
//   PW_AGENT_AUTO_MODE_ENVIRONMENT       newline-separated autoMode.environment lines; REPLACES the default
//   PW_AGENT_READY_TIMEOUT_MS            how long a new session may take to be ready (45000)
//
// bypassPermissions is deliberately not accepted: it would also silence the
// refusals that make auto mode safe to leave alone.

import { shSingleQuote } from './user-credentials.js';

export const AGENT_PERMISSION_MODES = Object.freeze(['auto', 'acceptEdits', 'manual', 'plan', 'dontAsk']);

/**
 * Anything that deploys, changes a service, or reaches another host. A deny rule
 * on a command prefix is a speed bump, not a sandbox (`bash -c …` is a different
 * command); auto mode's own refusal of risky actions and the workspace boundary
 * in CLAUDE.md are the other two layers.
 */
export const DEFAULT_DISALLOWED_TOOLS = Object.freeze([
  'Bash(podman:*)', 'Bash(docker:*)', 'Bash(kubectl:*)', 'Bash(helm:*)',
  'Bash(systemctl:*)', 'Bash(service:*)', 'Bash(journalctl:*)',
  'Bash(ssh:*)', 'Bash(scp:*)', 'Bash(sftp:*)', 'Bash(rsync:*)',
  'Bash(sudo:*)', 'Bash(su:*)', 'Bash(setpriv:*)', 'Bash(nsenter:*)',
  'Bash(Enter-PSSession:*)', 'Bash(Invoke-Command:*)',
  'Bash(dotnet publish:*)', 'Bash(gh workflow run:*)',
  'Bash(npm run deploy:*)', 'Bash(npm run release:*)',
  'Bash(./deploy*)', 'Bash(deploy/*)', 'Bash(./deploy/*)',
  'Bash(scripts/deploy*)', 'Bash(./scripts/deploy*)',
  'Bash(*deploy*.sh*)', 'Bash(*deploy*.ps1*)', 'Bash(*deploy*.py*)', 'Bash(*deploy*.mjs*)',
  'Bash(*promote-app*)', 'Bash(*pw-promote*)',
]);

/** Only used when the mode is acceptEdits: what auto mode would have approved on its own. */
export const ACCEPT_EDITS_ALLOWED_TOOLS = Object.freeze([
  'Bash(npm install:*)', 'Bash(npm ci:*)', 'Bash(npm test:*)', 'Bash(npm run test:*)',
  'Bash(npm run build:*)', 'Bash(npm run lint:*)', 'Bash(npm audit:*)', 'Bash(npm ls:*)',
  'Bash(npm outdated:*)', 'Bash(npm view:*)', 'Bash(npx:*)', 'Bash(node:*)',
  'Bash(dotnet restore:*)', 'Bash(dotnet build:*)', 'Bash(dotnet test:*)',
  'Bash(dotnet list:*)', 'Bash(dotnet add:*)', 'Bash(dotnet remove:*)',
  'Bash(git:*)', 'Bash(gh pr:*)', 'Bash(gh api:*)', 'Bash(gh repo view:*)', 'Bash(gh run view:*)',
  'Bash(gh run list:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(grep:*)', 'Bash(find:*)',
]);

export const DEFAULT_SYSTEM_PROMPT = [
  'This session was created by a Project Workbench API token acting for {user} (label: {label}).',
  "Its prompts are {user}'s instructions.",
  "Dependency work orders from the Paperclip GitHub Repo Steward carry {user}'s standing direction to incorporate or close dependency PRs,",
  "including merging PRs {user} authored and the Steward's own paperclip/ PRs.",
  'Do not deploy: no deploy or promote scripts, no service restarts, no containers, and nothing on any host outside this workspace.',
  'The workspace boundary in your instructions still applies; if a task needs something outside it, stop and say what is needed.',
].join(' ');

/**
 * Passed as the session's own `--settings {"autoMode":{"environment":[…]}}`, for
 * two reasons. It tells auto mode's classifier what this session is for. And an
 * auto-mode session with no environment configured offers "Teach auto mode about
 * your environment?" after a few refusals: a dialog drawn ABOVE a live composer
 * that takes the next Enter — so the second prompt into a lane would have
 * answered it "Yes". Flag settings are per process; the person's own config and
 * interactive sessions are not touched.
 */
export const DEFAULT_AUTO_MODE_ENVIRONMENT = Object.freeze([
  'Project Workbench agent session working in one project workspace (the current directory, a git clone of the project repository).',
  "Its GitHub repository is trusted: reading, branching, committing, pushing, reviewing, merging and closing that repository's pull requests is expected work.",
  'Installing packages from the public npm and NuGet registries and running the project\'s build and tests is expected work.',
  'Deploying, restarting services, running containers and connecting to any other host are not part of this work.',
]);

export const DEFAULT_READY_TIMEOUT_MS = 45000;

function rules(value) {
  return String(value).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/** The effective launch settings. Unrecognised values fall back to the defaults rather than failing a launch. */
export function agentLaunchConfig(env = process.env) {
  const enabled = String(env.PW_AGENT_AUTONOMOUS ?? 'true').toLowerCase() !== 'false';
  const mode = AGENT_PERMISSION_MODES.includes(env.PW_AGENT_CLAUDE_PERMISSION_MODE)
    ? env.PW_AGENT_CLAUDE_PERMISSION_MODE : 'auto';
  const disallowedTools = env.PW_AGENT_CLAUDE_DISALLOWED_TOOLS !== undefined
    ? rules(env.PW_AGENT_CLAUDE_DISALLOWED_TOOLS) : [...DEFAULT_DISALLOWED_TOOLS];
  const allowedTools = env.PW_AGENT_CLAUDE_ALLOWED_TOOLS !== undefined
    ? rules(env.PW_AGENT_CLAUDE_ALLOWED_TOOLS)
    : (mode === 'acceptEdits' ? [...ACCEPT_EDITS_ALLOWED_TOOLS] : []);
  const systemPrompt = String(env.PW_AGENT_SYSTEM_PROMPT || '').trim() || DEFAULT_SYSTEM_PROMPT;
  const autoModeEnvironment = env.PW_AGENT_AUTO_MODE_ENVIRONMENT !== undefined
    ? String(env.PW_AGENT_AUTO_MODE_ENVIRONMENT).split('\n').map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_AUTO_MODE_ENVIRONMENT];
  const readyTimeoutMs = Math.max(5000, Math.min(180000, Number(env.PW_AGENT_READY_TIMEOUT_MS) || DEFAULT_READY_TIMEOUT_MS));
  return { enabled, permissionMode: mode, disallowedTools, allowedTools, systemPrompt, autoModeEnvironment, readyTimeoutMs };
}

// A label or username is somebody's text going into a system prompt: one line,
// bounded, nothing that could pose as a new instruction block.
function plain(value, fallback) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return text || fallback;
}

export function agentSystemPrompt({ actsAs = '', tokenLabel = '', template = DEFAULT_SYSTEM_PROMPT } = {}) {
  const user = plain(actsAs, 'the token owner');
  const label = plain(tokenLabel, 'unlabelled');
  return String(template).replace(/\{user\}/g, user).replace(/\{label\}/g, label);
}

/** argv for the Claude an API-created session runs. */
export function agentClaudeArgv({ actsAs = '', tokenLabel = '', config = agentLaunchConfig() } = {}) {
  if (!config.enabled) return ['claude'];
  const argv = ['claude', '--permission-mode', config.permissionMode];
  if (config.allowedTools.length) argv.push('--allowedTools', ...config.allowedTools);
  if (config.disallowedTools.length) argv.push('--disallowedTools', ...config.disallowedTools);
  if (config.permissionMode === 'auto' && config.autoModeEnvironment.length) {
    argv.push('--settings', JSON.stringify({ autoMode: { environment: config.autoModeEnvironment } }));
  }
  argv.push('--append-system-prompt', agentSystemPrompt({ actsAs, tokenLabel, template: config.systemPrompt }));
  return argv;
}

/**
 * The same, as the line typed into the pane's shell. Every word is single-quoted:
 * a rule like Bash(*deploy*.sh*) is a glob to bash, and a label is user text.
 * The variadic tool lists end at the next flag, and --append-system-prompt is
 * last, so nothing after a list can be swallowed into it.
 */
export function agentClaudeCommand(options = {}) {
  const [bin, ...rest] = agentClaudeArgv(options);
  return [bin, ...rest.map(shSingleQuote)].join(' ');
}

// ── Is the CLI ready for a prompt? ─────────────────────────────────────────
//
// Judged from the visible screen, bottom first. Two shapes of dialog exist:
//
//   - ones that REPLACE the composer and its mode footer (the trust dialog, a
//     permission prompt), and
//   - ones drawn ABOVE a live composer, footer still showing ("Teach auto mode
//     about your environment?"), which nonetheless take the next Enter.
//
// So a dialog's STRUCTURE — "Enter to confirm", "Esc to cancel", a ❯ on a
// numbered option — near the bottom means a dialog whatever else is on screen.
// Dialog-like WORDS alone ("Do you want to proceed?") only count when no mode
// footer is showing, because a ready session's conversation can contain them.
// The trust dialog says "Claude Code" too, which is why the older /Claude Code/
// readiness test is not used here.

const READY_FOOTER = /⏵⏵|\? for shortcuts|(auto mode|accept edits|plan mode|bypass permissions) on|shift\+tab to cycle/i;
const DIALOG_STRUCTURE = /Enter to confirm|Esc to cancel|^\s*❯\s*\d+\.\s/im;

const DIALOGS = [
  { kind: 'workspace_trust', pattern: /Is this a project you created or one you trust|Yes, I trust this folder|Do you trust the files in this folder|Confirm folder trust/i,
    message: 'The session is showing the workspace-trust dialog. Answer it in the dashboard; a prompt would answer it instead.' },
  { kind: 'mcp_approval', pattern: /New MCP servers? found in \.mcp\.json|Use this and all future MCP servers/i,
    message: 'The session is asking whether to enable the project\'s .mcp.json servers. Answer it in the dashboard.' },
  { kind: 'permission', pattern: /Do you want to (proceed|make this edit|create|allow)|Yes, and don't ask again|No, and tell Claude what to do differently/i,
    message: 'The session is waiting for a permission decision. Answer it in the dashboard; a prompt would answer it instead.' },
  { kind: 'auto_mode_setup', pattern: /Teach auto mode about your environment/i,
    message: 'The session is offering to set up auto mode. Answer it in the dashboard ("Not now" is safe); a prompt would answer it "Yes".' },
  { kind: 'login', pattern: /Select login method|Paste code here if prompted|Invalid API key|Please run \/login/i,
    message: 'The session is not signed in. Sign in from the dashboard before prompting it.' },
];
const GENERIC_DIALOG = { kind: 'choice',
  message: 'The session is showing a dialog that needs an answer. Answer it in the dashboard; a prompt would answer it instead.' };

/**
 * { state: 'ready' } | { state: 'dialog', dialog: { kind, message } } | { state: 'starting' }
 */
export function classifyAgentPane(screen = '') {
  const lines = String(screen).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const recent = lines.slice(-30).join('\n');
  const named = () => DIALOGS.find((d) => d.pattern.test(recent));
  const as = (d) => ({ state: 'dialog', dialog: { kind: d.kind, message: d.message } });
  if (DIALOG_STRUCTURE.test(lines.slice(-15).join('\n'))) return as(named() || GENERIC_DIALOG);
  if (READY_FOOTER.test(lines.slice(-3).join('\n'))) return { state: 'ready' };
  const d = named();
  return d ? as(d) : { state: 'starting' };
}

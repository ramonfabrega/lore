import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { LORE_HOME } from './config'

// The always-on explorer as a launchd user agent — the fleet's precedent for
// long-lived local services (the centaur port-forward agents), wrapped so it
// is one command to turn on, off, restart, and read. incur has no opinion on
// process management: its recommendation is `Bun.serve(cli)`, which is what
// `lore serve` does; something has to keep that process alive across logins
// and crashes, and on macOS that is launchd with KeepAlive.
//
// Two honesty rules carried from the fleet: (1) KeepAlive respawns a job into
// the same port race forever, so `status` reads the log's last lines, not
// just the pid; (2) the prod bin is a frozen bundle, so a running server
// keeps the old build in memory after `scripts/install` — `status` compares
// the build the server reports (`/_lore`) with the installed bin and says
// "restart owed" instead of pretending.

export const LABEL = 'com.ramonfabrega.lore'
export const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
export const LOG_PATH = join(LORE_HOME, 'serve.log')
export const ERR_PATH = join(LORE_HOME, 'serve.err')
const BIN = join(homedir(), '.bun', 'bin', 'lore')

export type ServerConfig = { port: number; host: string }

export function renderPlist(cfg: ServerConfig, opts: { bin?: string; home?: string } = {}): string {
  const bin = opts.bin ?? BIN
  const home = opts.home ?? homedir()
  const args = [bin, 'serve', '--port', String(cfg.port), '--host', cfg.host]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <!-- Written by \`lore server up\`; edit the command, not this file.
       The explorer (docs/EXPLORER.md) on ${cfg.host}:${cfg.port}. \`lore server status\`
       compares the running build with the installed bin — restart after
       scripts/install, the bundle in memory does not follow the file. -->
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(`${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(opts.home ? join(opts.home, '.lore') : LORE_HOME, 'serve.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(opts.home ? join(opts.home, '.lore') : LORE_HOME, 'serve.err'))}</string>
</dict>
</plist>
`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// The plist is the single source of the port/host once written — `status`,
// `restart`, and `logs` read them back rather than taking flags again.
export function readPlistConfig(xml: string): ServerConfig | null {
  const strings = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!)
  const port = strings[strings.indexOf('--port') + 1]
  const host = strings[strings.indexOf('--host') + 1]
  if (!port || !host || strings.indexOf('--port') < 0 || strings.indexOf('--host') < 0) return null
  return { port: Number(port), host }
}

const domain = () => `gui/${process.getuid?.() ?? 501}`

async function launchctl(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = await Bun.$`launchctl ${args}`.quiet().nothrow()
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

export type LaunchdState = { loaded: boolean; pid: number | null; lastExit: number | null }

export async function launchdState(): Promise<LaunchdState> {
  const r = await launchctl('print', `${domain()}/${LABEL}`)
  if (r.code !== 0) return { loaded: false, pid: null, lastExit: null }
  const pid = /^\s*pid = (\d+)/m.exec(r.out)?.[1]
  const lastExit = /^\s*last exit code = (\S+)/m.exec(r.out)?.[1]
  return { loaded: true, pid: pid ? Number(pid) : null, lastExit: lastExit ? Number(lastExit) : null }
}

export async function serverUp(cfg: ServerConfig) {
  await Bun.write(PLIST_PATH, renderPlist(cfg))
  const before = await launchdState()
  if (before.loaded) {
    // Already bootstrapped: kickstart so the (possibly new) plist takes.
    await launchctl('bootout', `${domain()}/${LABEL}`)
  }
  const r = await launchctl('bootstrap', domain(), PLIST_PATH)
  if (r.code !== 0) throw new Error(`launchctl bootstrap failed (${r.code}): ${r.err.trim() || r.out.trim()}`)
  return { plist: PLIST_PATH, ...cfg, url: urlFor(cfg) }
}

export async function serverDown() {
  const r = await launchctl('bootout', `${domain()}/${LABEL}`)
  if (r.code !== 0 && !/not find|No such/i.test(r.err + r.out)) throw new Error(`launchctl bootout failed (${r.code}): ${r.err.trim() || r.out.trim()}`)
  return { label: LABEL, wasLoaded: r.code === 0 }
}

export async function serverRestart() {
  const r = await launchctl('kickstart', '-k', `${domain()}/${LABEL}`)
  if (r.code !== 0) throw new Error(`launchctl kickstart failed (${r.code}): ${r.err.trim() || r.out.trim()} — is it up? (\`lore server up\`)`)
  return { label: LABEL, restarted: true }
}

const Live = z.object({ ok: z.boolean(), build: z.string(), pid: z.number(), startedAt: z.string() })

export async function serverStatus(opts: { installedBuild: string }) {
  const cfg = existsSync(PLIST_PATH) ? readPlistConfig(await Bun.file(PLIST_PATH).text()) : null
  const state = await launchdState()
  let live: z.infer<typeof Live> | null = null
  let liveError: string | null = null
  if (cfg) {
    try {
      const res = await fetch(`${urlFor(cfg)}_lore`, { signal: AbortSignal.timeout(2000) })
      live = Live.parse(await res.json())
    } catch (e) {
      liveError = e instanceof Error ? e.message : String(e)
    }
  }
  const restartOwed = live != null && live.build !== opts.installedBuild
  const warnings: string[] = []
  if (!cfg) warnings.push('no plist — `lore server up` to install the agent')
  if (cfg && !state.loaded) warnings.push('plist exists but the agent is not loaded — `lore server up`')
  if (state.loaded && !live) warnings.push(`agent loaded but the server did not answer${liveError ? ` (${liveError})` : ''} — check \`lore server logs\` (a port race respawns forever under KeepAlive)`)
  if (restartOwed) warnings.push(`running ${live!.build} but installed ${opts.installedBuild} — \`lore server restart\` (and \`lore index\` if the schema moved)`)
  return {
    label: LABEL,
    plist: cfg ? PLIST_PATH : null,
    url: cfg ? urlFor(cfg) : null,
    launchd: state,
    server: live,
    installedBuild: opts.installedBuild,
    restartOwed,
    ...(warnings.length ? { warnings } : {}),
  }
}

export async function serverLogs(lines: number) {
  const tail = async (p: string) => (existsSync(p) ? (await Bun.file(p).text()).trimEnd().split('\n').slice(-lines) : [])
  return { log: LOG_PATH, err: ERR_PATH, stdout: await tail(LOG_PATH), stderr: await tail(ERR_PATH) }
}

export function urlFor(cfg: ServerConfig): string {
  const host = cfg.host === '0.0.0.0' ? 'localhost' : cfg.host
  return `http://${host}:${cfg.port}/`
}

// Bind address: the Tailscale address keeps `studio:<port>` working over the
// tailnet without also binding the LAN interface; 0.0.0.0 when there is none.
export async function resolveHost(host: string): Promise<string> {
  if (host !== 'auto') return host
  for (const bin of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    const r = await Bun.$`${bin} ip -4`.quiet().nothrow()
    const ip = r.stdout.toString().trim().split('\n')[0]
    if (r.exitCode === 0 && ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip
  }
  return '0.0.0.0'
}
